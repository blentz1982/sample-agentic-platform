"""FastAPI shim around the Claude Code CLI.

Exposes the AgentCore Runtime contract (POST /invocations + GET /ping on
:8080). Each invocation parses a JSON payload, optionally clones a repo,
and shells out to:

    claude -p --dangerously-skip-permissions --output-format json <prompt>

The CLI does all the work; this server's only job is to render the payload
into a prompt, resolve the GitHub PAT, kick off the subprocess as a
background task, and return ``202 Accepted`` immediately.

The microVM AgentCore gives us has an 8h max lifetime (configured in the
CDK stack), so the backgrounded subprocess can keep running long after the
HTTP response returns. Today we don't surface the result back to the
caller — coming next is a DynamoDB task table + ``GET /tasks/{id}`` to
poll for completion.

Bedrock is the model provider — ``CLAUDE_CODE_USE_BEDROCK=1`` plus
``ANTHROPIC_MODEL`` set to a Bedrock inference profile id. The runtime IAM
role must grant ``bedrock:InvokeModel`` on the chosen model.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import uuid
from typing import Any, Callable, Optional
from urllib.parse import urlparse, urlunparse

import boto3
import uvicorn
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get(
    "ANTHROPIC_MODEL",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
)
DEFAULT_CWD = os.environ.get("CODING_AGENT_CWD", "/workspace")
DEFAULT_TIMEOUT_S = int(os.environ.get("CODING_AGENT_TIMEOUT_S", "1800"))
GIT_USER_NAME = os.environ.get("GIT_USER_NAME", "super-cool-background-agent")
GIT_USER_EMAIL = os.environ.get(
    "GIT_USER_EMAIL", "super-cool-background-agent@users.noreply.github.com"
)
# Hard ceiling on what the agent can spend on a single invocation.
# Empty string disables the cap. The CLI flag is --max-budget-usd.
DEFAULT_MAX_BUDGET_USD = os.environ.get("CODING_AGENT_MAX_BUDGET_USD", "5")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")

# Name (or ARN) of the Secrets Manager secret holding the GitHub PAT.
# Optional — if unset, only GITHUB_TOKEN env is consulted.
GITHUB_TOKEN_SECRET_ID = os.environ.get("GITHUB_TOKEN_SECRET_ID", "")

# Git repo the agent operates on. Pinned at deploy time by the CDK stack
# (required, no default). When set, every invocation clones it before
# running claude. Per-invocation `repo_url` payload still wins so callers
# can target other repos opportunistically.
AGENT_REPO_URL = os.environ.get("AGENT_REPO_URL", "").strip()


app = FastAPI(title="Coding Agent")

_secrets_client = None


def _get_secrets_client():
    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client("secretsmanager")
    return _secrets_client


def _resolve_github_pat() -> str:
    """Resolve a GitHub PAT for cloning the target repo.

    Order: ``GITHUB_TOKEN`` env → Secrets Manager (``GITHUB_TOKEN_SECRET_ID``)
    → empty string. The empty fallback only works for public repos.
    """
    env_pat = os.environ.get("GITHUB_TOKEN", "").strip()
    if env_pat:
        return env_pat

    if not GITHUB_TOKEN_SECRET_ID:
        return ""

    try:
        resp = _get_secrets_client().get_secret_value(SecretId=GITHUB_TOKEN_SECRET_ID)
    except (BotoCoreError, ClientError) as exc:
        logger.warning("could not fetch GitHub PAT secret: %s", exc)
        return ""

    raw = (resp.get("SecretString") or "").strip()
    if not raw:
        return ""

    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return raw
        for key in ("token", "GITHUB_TOKEN", "github_token", "pat"):
            if data.get(key):
                return str(data[key]).strip()
        return ""
    return raw


def _inject_pat(repo_url: str, pat: str) -> str:
    """Embed the PAT into an https git URL for cloning."""
    if not pat:
        return repo_url
    parsed = urlparse(repo_url)
    if parsed.scheme not in {"http", "https"}:
        return repo_url
    netloc = f"x-access-token:{pat}@{parsed.hostname}"
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


async def _run_git(args: list[str], cwd: str | None, pat: str = "") -> tuple[int, str]:
    """Run a git subprocess and return (returncode, combined_stderr_then_stdout)."""
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=180)
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"git {args[0]} timed out after 180s") from exc
    text = ((stderr or b"").decode("utf-8", errors="replace")
            + (stdout or b"").decode("utf-8", errors="replace"))
    if pat:
        text = text.replace(pat, "<REDACTED>")
    return proc.returncode or 0, text


async def _clone_repo(repo_url: str, dest: str, pat: str) -> None:
    """Clone ``repo_url`` into ``dest`` and configure git identity.

    The remote is set to a PAT-bearing URL after clone so the agent can
    ``git push`` without ever seeing the token. ``git config`` is set
    locally so commits have an author.
    """
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)

    auth_url = _inject_pat(repo_url, pat)
    logger.info("cloning %s into %s", repo_url, dest)

    rc, msg = await _run_git(["clone", auth_url, dest], cwd=None, pat=pat)
    if rc != 0:
        raise RuntimeError(f"git clone failed: {msg.strip()}")

    # Persist the PAT-bearing remote URL so subsequent `git push` works
    # without the agent rewriting it.
    await _run_git(["remote", "set-url", "origin", auth_url], cwd=dest, pat=pat)
    await _run_git(["config", "user.name", GIT_USER_NAME], cwd=dest)
    await _run_git(["config", "user.email", GIT_USER_EMAIL], cwd=dest)


# Operational fields the caller passes alongside the Jira ticket — these
# are consumed by the server itself and shouldn't be shown to the model
# as part of the ticket context.
_OPERATIONAL_FIELDS = frozenset(
    {"task_description", "repo_url", "max_budget_usd", "cwd"}
)


def _build_prompt(payload: dict[str, Any]) -> str:
    """Wrap a Jira ticket payload into a Claude Code prompt.

    The caller is a Jira automation, so the payload is the ticket's JSON
    blob (summary, description, fields, comments, etc.) plus a few
    operational fields the server itself consumes. The model needs to
    know:

      * the repo is already cloned at the current working directory,
      * `GITHUB_TOKEN` and `GH_TOKEN` are populated for `git push` / `gh`,
      * the deliverable is a branch + PR, not a local diff.

    `task_description`, when present, is hoisted to the top as a quick
    summary so the model isn't forced to re-derive intent from the raw
    ticket fields.
    """
    ticket = {k: v for k, v in payload.items() if k not in _OPERATIONAL_FIELDS}
    summary = payload.get("task_description")

    parts: list[str] = [
        "You are an autonomous coding agent invoked by a Jira automation.",
        "",
        "## Environment",
        "- The target git repository is already cloned at the current "
        "working directory (`pwd`). Treat it as your workspace.",
        "- `GITHUB_TOKEN` and `GH_TOKEN` are set in the environment, and "
        "the `origin` remote is already authenticated for `git push`. "
        "Do **not** print, log, or echo these tokens.",
        "- `git config user.name` and `user.email` are pre-set; commits "
        "you make will be authored correctly with no extra setup.",
        "",
        "## Input",
        "Below is the JSON payload of a Jira ticket describing a feature "
        "request or bug. It is your single source of truth for what to "
        "build. Read every field — summary, description, acceptance "
        "criteria, comments, labels, components, attachments — before "
        "planning the change. If something is ambiguous, prefer the most "
        "literal reading of the ticket over guessing.",
        "",
        "## Goal",
        "Resolve the ticket end-to-end and deliver the fix as a pull "
        "request on the cloned repo:",
        "",
        "1. Explore the repo enough to locate the relevant code.",
        "2. Make the minimal correct change that satisfies the ticket. "
        "Run the project's tests/linters if they exist.",
        "3. Create a new branch (e.g. `fix/<ticket-key>-<slug>` or "
        "`feat/<ticket-key>-<slug>`), commit your work with a clear "
        "message that references the ticket key, and push it to "
        "`origin`.",
        "4. Open a pull request against the default branch using `gh pr "
        "create`. The PR title should reference the ticket key; the body "
        "should summarize the change, link back to the ticket, and call "
        "out anything a reviewer needs to know.",
        "",
        "Do not stop after writing the code locally — the work is only "
        "complete once the PR exists on GitHub.",
        "",
    ]

    if summary:
        parts.extend(["## Ticket summary (provided by caller)", str(summary), ""])

    parts.extend(
        [
            "## Jira ticket payload",
            "```json",
            json.dumps(ticket, indent=2, default=str),
            "```",
        ]
    )

    return "\n".join(parts)


def _summarize_stream_event(event: dict[str, Any]) -> str:
    """Render a Claude Code stream-json event as a single log-friendly line.

    Stream-json events come in a few flavors (system init, assistant
    message chunks, tool_use, tool_result, result envelope). We pick out
    the salient bits per type so each line in CloudWatch is grep-able.
    """
    etype = event.get("type", "?")
    if etype == "system":
        return f"system subtype={event.get('subtype')} model={event.get('model')}"
    if etype == "assistant":
        msg = event.get("message") or {}
        content = msg.get("content") or []
        parts: list[str] = []
        for block in content:
            btype = block.get("type")
            if btype == "text":
                text = (block.get("text") or "").strip()
                if text:
                    parts.append(f"text={text[:200]!r}")
            elif btype == "tool_use":
                name = block.get("name")
                inp = block.get("input") or {}
                # Most tools have a single salient field; collapse the rest.
                head = next(iter(inp.values()), "")
                if isinstance(head, str) and len(head) > 120:
                    head = head[:120] + "…"
                parts.append(f"tool_use={name} input={head!r}")
            else:
                parts.append(f"block={btype}")
        return "assistant " + " | ".join(parts) if parts else "assistant <empty>"
    if etype == "user":
        # tool_result lives inside user-typed events in stream-json.
        msg = event.get("message") or {}
        content = msg.get("content") or []
        for block in content:
            if block.get("type") == "tool_result":
                out = block.get("content")
                if isinstance(out, list):
                    out = " ".join(
                        (b.get("text") or "") for b in out if b.get("type") == "text"
                    )
                if isinstance(out, str):
                    out = out.strip()
                    if len(out) > 300:
                        out = out[:300] + "…"
                is_err = block.get("is_error")
                return f"tool_result is_error={bool(is_err)} out={out!r}"
        return f"user {json.dumps(event)[:200]}"
    if etype == "result":
        return (
            f"result is_error={event.get('is_error')} "
            f"cost_usd={event.get('total_cost_usd')} "
            f"num_turns={event.get('num_turns')} "
            f"session={event.get('session_id')}"
        )
    return f"{etype} {json.dumps(event)[:200]}"


async def _drain_stream(
    stream: asyncio.StreamReader,
    label: str,
    pat: str,
    on_json: Optional[Callable[[dict[str, Any]], None]] = None,
) -> str:
    """Read `stream` line-by-line, log each line, return the joined text.

    Each line is parsed as JSON when possible (claude `--output-format
    stream-json` emits one event per line). The PAT is scrubbed before
    anything reaches the log or the returned buffer.
    """
    buf: list[str] = []
    while True:
        line = await stream.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace")
        if pat:
            text = text.replace(pat, "<REDACTED>")
        buf.append(text)
        stripped = text.rstrip()
        if not stripped:
            continue
        if label == "stdout":
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError:
                logger.info("[claude.stdout] %s", stripped[:500])
                continue
            if on_json is not None:
                on_json(event)
            logger.info("[claude] %s", _summarize_stream_event(event))
        else:
            logger.warning("[claude.stderr] %s", stripped[:500])
    return "".join(buf)


async def _run_claude(
    prompt: str, cwd: str, max_budget_usd: str | None, pat: str = "",
    task_id: str | None = None,
) -> dict[str, Any]:
    """Shell out to ``claude -p`` and stream its JSON events to logs.

    --dangerously-skip-permissions is the autonomous-runs flag — required
    inside the disposable AgentCore microVM where the blast radius is one
    short-lived Linux VM. ``--max-budget-usd`` caps the dollar spend per
    invocation; pass an empty string to disable.

    `--output-format stream-json` emits one JSON event per line, so we
    read the pipe line-by-line and log a one-line summary of each event
    as it arrives — full Claude trace shows up in CloudWatch live, not
    only when the run finishes.
    """
    cmd = [
        CLAUDE_BIN,
        "-p",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        DEFAULT_MODEL,
    ]
    if max_budget_usd:
        cmd += ["--max-budget-usd", str(max_budget_usd)]
    cmd.append(prompt)

    logger.info(
        "[task=%s] exec: claude -p ... --model=%s --max-budget-usd=%s (cwd=%s)",
        task_id, DEFAULT_MODEL, max_budget_usd or "<unset>", cwd,
    )

    # Pass the PAT through as GITHUB_TOKEN so `gh` (which the agent will
    # use to open PRs) authenticates without an interactive login. The
    # parent server process inherits AWS creds from the runtime env.
    env = os.environ.copy()
    if pat:
        env["GITHUB_TOKEN"] = pat
        env["GH_TOKEN"] = pat

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    final_result: dict[str, Any] = {}

    def _capture_result(event: dict[str, Any]) -> None:
        if event.get("type") == "result":
            final_result.clear()
            final_result.update(event)

    try:
        stdout_text, stderr_text = await asyncio.wait_for(
            asyncio.gather(
                _drain_stream(proc.stdout, "stdout", pat, on_json=_capture_result),
                _drain_stream(proc.stderr, "stderr", pat),
            ),
            timeout=DEFAULT_TIMEOUT_S,
        )
        await proc.wait()
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise HTTPException(
            status_code=504,
            detail=f"claude CLI timed out after {DEFAULT_TIMEOUT_S}s",
        ) from exc

    if proc.returncode != 0:
        logger.error(
            "[task=%s] claude exited %s; final_result=%s",
            task_id, proc.returncode, json.dumps(final_result)[:500] if final_result else "<none>",
        )
        raise HTTPException(
            status_code=502,
            detail=(
                f"claude CLI exited {proc.returncode}: "
                f"{(stderr_text or stdout_text).strip()[:1000]}"
            ),
        )

    if final_result:
        return final_result
    # Fall back to wrapping the raw text so callers still get something.
    return {"result": stdout_text, "raw": True, "stderr": stderr_text}


class AcceptedResponse(BaseModel):
    task_id: str
    status: str = "accepted"
    cwd: str


# In-memory bookkeeping of the background tasks we've spawned. Holding
# references prevents asyncio from garbage-collecting the tasks mid-flight
# and silently dropping the work. Cleared via a done callback.
_running_tasks: set[asyncio.Task[Any]] = set()


@app.get("/ping")
@app.get("/health")
async def ping() -> dict[str, str]:
    return {"status": "healthy"}


async def _run_task(
    task_id: str,
    payload: dict[str, Any],
    cwd: str,
    max_budget_usd: str,
    pat: str,
) -> None:
    """Background worker — clones the repo, runs claude, logs the result.

    Today the result is only logged. Once we add a task table this is the
    place that writes the final state row.
    """
    try:
        repo_url = payload.get("repo_url") or AGENT_REPO_URL
        if repo_url:
            repo_dest = os.path.join(cwd, "repo")
            try:
                await _clone_repo(str(repo_url), repo_dest, pat)
            except RuntimeError as exc:
                logger.error("[task=%s] clone failed: %s", task_id, exc)
                return
            cwd = repo_dest

        prompt = _build_prompt(payload)
        raw = await _run_claude(
            prompt=prompt, cwd=cwd, max_budget_usd=max_budget_usd, pat=pat,
            task_id=task_id,
        )
    except HTTPException as exc:
        logger.error("[task=%s] claude exited non-zero: %s", task_id, exc.detail)
        return
    except Exception:  # noqa: BLE001
        logger.exception("[task=%s] unhandled exception in background task", task_id)
        return

    is_error = bool(raw.get("is_error"))
    cost_usd = raw.get("total_cost_usd")
    num_turns = raw.get("num_turns")
    logger.info(
        "[task=%s] done is_error=%s cost_usd=%s num_turns=%s session_id=%s",
        task_id, is_error, cost_usd, num_turns, raw.get("session_id"),
    )


@app.post(
    "/invocations",
    response_model=AcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
@app.post(
    "/invoke",
    response_model=AcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def invoke(payload: dict[str, Any]) -> AcceptedResponse:
    """Accept a coding task and start it in the background.

    Returns ``202 Accepted`` with a generated ``task_id`` as soon as the
    payload validates and the work is scheduled — does NOT wait for the
    agent to finish. The microVM's 8h lifetime keeps the background task
    alive long enough to complete real work.

    The body is an arbitrary JSON object. Recognized fields:
      * ``task_description`` (str, optional) — primary instruction.
      * ``repo_url`` (str, optional) — git URL to clone before running.
      * ``max_budget_usd`` (number/str, optional) — caps dollar spend on
        this invocation; passes through to ``claude --max-budget-usd``.
      * ``cwd`` (str, optional) — overrides ``/workspace``.

    Everything else is preserved as Jira-style context in the prompt.
    """
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")

    cwd = str(payload.get("cwd") or DEFAULT_CWD)
    max_budget_usd = payload.get("max_budget_usd")
    if max_budget_usd is None:
        max_budget_usd = DEFAULT_MAX_BUDGET_USD
    max_budget_usd = str(max_budget_usd) if max_budget_usd != "" else ""

    os.makedirs(cwd, exist_ok=True)

    # Resolve the PAT synchronously so the caller learns about misconfigured
    # credentials in the 202 response, not minutes later in CloudWatch.
    pat = _resolve_github_pat()

    task_id = str(uuid.uuid4())
    logger.info(
        "[task=%s] accepted (repo_url=%s, cwd=%s, max_budget_usd=%s)",
        task_id, payload.get("repo_url"), cwd, max_budget_usd or "<unset>",
    )

    task = asyncio.create_task(
        _run_task(task_id, payload, cwd, max_budget_usd, pat),
        name=f"coding-agent-task-{task_id}",
    )
    _running_tasks.add(task)
    task.add_done_callback(_running_tasks.discard)

    return AcceptedResponse(task_id=task_id, cwd=cwd)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)  # nosec B104
