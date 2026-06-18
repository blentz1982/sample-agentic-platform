# Coding Agent

An autonomous coding agent that hosts **Claude Code** inside an **Amazon Bedrock AgentCore** runtime. The server is intentionally thin: it's a FastAPI shim that takes a JSON payload, optionally clones a target repo, and shells out to the `claude` CLI with `-p --dangerously-skip-permissions`. Claude Code does all the work; this service just routes HTTP to a subprocess.

The pattern follows the AWS blog [*It's safe to close your laptop now: Hosting coding agents on Amazon Bedrock AgentCore*](https://aws.amazon.com/blogs/machine-learning/) — every invocation lands in its own Firecracker microVM with a real shell, filesystem, and persistent workspace, and the model calls go to Bedrock so prompts/tokens never leave AWS.

> **Heads up — deployment is now CDK, not Terraform.** Older revisions of this README pointed at `infrastructure/stacks/agentcore-runtime/coding_agent.tfvars`. That path is gone. The current deployment surface is the CDK app under [`/cdk`](../../../../cdk/), and the rest of this document walks through it end to end.

---

## Contents

- [Architecture at a glance](#architecture-at-a-glance)
- [What the CDK stack creates](#what-the-cdk-stack-creates)
- [End-to-end deployment](#end-to-end-deployment)
- [Environment variables](#environment-variables)
- [Invocation contract](#invocation-contract)
- [Operating the deployed agent](#operating-the-deployed-agent)
- [Tearing it all down](#tearing-it-all-down)
- [Local testing (no AWS)](#local-testing-no-aws)
- [Troubleshooting](#troubleshooting)

---

## Architecture at a glance

```
┌────────────┐    POST /invocations         ┌─────────────────┐
│  Caller    │  (x-api-key header)          │   API Gateway   │
│  (curl,    │ ───────────────────────────▶ │  REST, /v1      │
│   webhook, │                              │  api-key auth   │
│   CI, …)   │                              └────────┬────────┘
└────────────┘                                       │ proxy
                                                     ▼
                              ┌──────────────────────────────────┐
                              │  Lambda (Node 22, ARM64)         │
                              │  InvokeAgentRuntimeCommand       │
                              └────────────────┬─────────────────┘
                                               │
                                               ▼
                  ┌──────────────────────────────────────────────┐
                  │  AgentCore Runtime (Firecracker microVM,     │
                  │  per-session, 8h max)                        │
                  │                                              │
                  │  FastAPI shim (server.py)                    │
                  │   1. resolve GitHub PAT (Secrets Manager)    │
                  │   2. git clone $AGENT_REPO_URL               │
                  │   3. background task runs:                   │
                  │       claude -p --output-format stream-json  │
                  │   4. return 202 + task_id immediately        │
                  │                                              │
                  │  Stream events log line-by-line to           │
                  │  /aws/vendedlogs/bedrock-agentcore/...       │
                  └────────────────────┬─────────────────────────┘
                                       │
                                       ▼
                       ┌─────────────────────────────────┐
                       │  Amazon Bedrock                 │
                       │  (Claude Sonnet 4.5 inference   │
                       │   profile, cross-region)        │
                       └─────────────────────────────────┘
```

The HTTP call returns **`202 Accepted`** with a `task_id` as soon as AgentCore accepts the work — the actual `claude -p` run continues in the microVM behind the scenes. The 29 s API Gateway integration timeout is therefore irrelevant for real coding work; the response comes back in milliseconds.

### Why a Lambda proxy

API Gateway's "AWS service integration" doesn't list `bedrock-agentcore` as a supported target service, so a small Lambda calls `InvokeAgentRuntime` over the SDK on behalf of the caller. The Lambda is a thin pass-through:

- Forward the caller's body verbatim as the `payload`
- Generate a 36-char session id (AgentCore requires ≥33)
- Drain the AgentCore response stream and return it to API Gateway

No business logic lives in the Lambda — all of that is in `server.py` inside the microVM.

---

## What the CDK stack creates

The stack is composed of two CDK constructs (`AgentCoreRuntime` and `ApiKeyFrontDoor`) and ships these resources:

| Resource | Purpose | Removal policy |
|---|---|---|
| `AWS::ECR::Repository` (`agentic-platform-coding-agent`) | Holds the agent image. | **RETAIN** — `cdk destroy` won't take it. |
| `AWS::SecretsManager::Secret` (`coding-agent/github-token`) | Empty placeholder for the GitHub PAT. | **RETAIN** — populate post-deploy, delete manually. |
| `AWS::BedrockAgentCore::Runtime` (`coding_agent-…`) | The microVM runtime, pinned to `<ecr-repo>:latest`. 8 h idle + max session lifetime. | DESTROY |
| `AWS::ApiGateway::RestApi` + 2 methods (`POST /invocations`, `GET /ping`) on stage `v1`. | API key gated. Throttle: 2 rps / 5 burst. | DESTROY |
| `AWS::ApiGateway::ApiKey` + `UsagePlan` | Single key with usage plan for rate limiting. | DESTROY |
| `AWS::Lambda::Function` (`coding-agent-invoke`, Node 22, ARM64) | Proxy that calls `InvokeAgentRuntime`. | DESTROY |
| 4 × `AWS::Logs::LogGroup` | Application logs, usage logs, APIG access logs, Lambda logs. 90-day retention. | DESTROY |
| 2 × `AWS::IAM::Role` | Runtime execution role (Bedrock + Secrets Manager + ECR pull) and Lambda execution role. | DESTROY |

cdk-nag (AWS Solutions ruleset) is wired into the synth and currently passes clean.

> **Why the ECR repo & PAT secret are RETAIN.** Both contain state that's expensive to lose: the ECR repo holds your built images (and AgentCore can't be created without an image present), and the PAT is a secret you typed in by hand. Keeping them out of the destroy path means a `cdk destroy` won't surprise you.

---

## End-to-end deployment

Follow the steps in order. The first three are one-time setup; steps 4–8 are what you re-run on every deploy.

### 1. Prerequisites (one-time, per machine)

- **AWS CLI v2**, with credentials that can create AgentCore runtimes, ECR repos, IAM roles, Lambda functions, API Gateway resources, and Secrets Manager secrets.
- **Docker** (or `docker buildx`), with the `linux/amd64` and `linux/arm64` builders available. AgentCore runs on ARM64; the build script produces a multi-arch image so the same `:latest` tag works for both local Mac/AS development and the runtime.
- **Node.js 20+ and npm** for the CDK app.
- **A GitHub Personal Access Token (PAT)** if your target repo is private (or if you want the agent to open PRs from it). Recommended scope: fine-grained, `contents: read+write`, `pull_requests: read+write`.

### 2. Pick your AWS region

The current deployment lives in **`us-east-1`**. If you want a different region, export it before running anything:

```bash
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
# (the build script and CDK both honor these)
```

The chosen Bedrock inference profile must be available in your region — `us.anthropic.claude-sonnet-4-5-…` is a US cross-region profile and routes to `us-east-1`, `us-east-2`, and `us-west-2`. If you deploy outside those, change `anthropicModel` (see [Environment variables](#environment-variables)).

### 3. CDK bootstrap (one-time per account+region)

```bash
cd cdk
npm install
npx cdk bootstrap aws://<account-id>/<region>
```

You only need to do this once for any given account+region pair. If a previous CDK app has already bootstrapped it, skip this.

### 4. Build & push the agent image

The CDK stack **does not own image lifecycle** — it imports the ECR repo and references `:latest`. AgentCore validates the image at create time, so the image must exist before `cdk deploy` runs.

From the repo root:

```bash
./deploy/build-container.sh coding-agent agent
```

What that script does:

1. Authenticates Docker to ECR.
2. Creates the ECR repository `agentic-platform-coding-agent` if it doesn't exist.
3. Builds a multi-arch image (`linux/amd64`, `linux/arm64`) from `src/agentic_platform/agent/coding_agent/Dockerfile`.
4. Pushes it to `agentic-platform-coding-agent:latest`.

Re-run this any time you change `server.py`, `requirements.txt`, or the `Dockerfile` — see [Updating the image](#updating-the-image) for the rolling-restart command.

### 5. Deploy the CDK stack

`repoUrl` is the only required context value:

```bash
cd cdk
npx cdk deploy \
  -c repoUrl=https://github.com/<owner>/<repo>.git
```

Optional context overrides (all have sensible defaults — see [Environment variables](#environment-variables)):

```bash
npx cdk deploy \
  -c repoUrl=https://github.com/owner/repo.git \
  -c stackName=CodingAgentDev \
  -c anthropicModel=us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  -c maxBudgetUsd=5
```

Synth fails fast if `repoUrl` is missing — by design, no default repo URL is shipped, so a misconfigured deploy can't accidentally stand a runtime up against the wrong repository.

When the deploy finishes, CloudFormation prints these outputs (also visible at any time via `aws cloudformation describe-stacks --stack-name CodingAgent --query "Stacks[0].Outputs"`):

```
ApiUrl                — https://<id>.execute-api.<region>.amazonaws.com/v1/
ApiKeyId              — <opaque key id, e.g. 8c3xlrw10l>
EcrRepositoryUri      — <account>.dkr.ecr.<region>.amazonaws.com/agentic-platform-coding-agent
EcrRepositoryName     — agentic-platform-coding-agent
GitHubTokenSecretArn  — arn:aws:secretsmanager:<region>:<account>:secret:coding-agent/github-token-XXXXXX
AgentRuntimeArn       — arn:aws:bedrock-agentcore:<region>:<account>:runtime/coding_agent-XXXXXXXXXX
AgentRuntimeId        — coding_agent-XXXXXXXXXX
```

Hold onto `GitHubTokenSecretArn` and `ApiKeyId` for the next two steps.

### 6. Populate the GitHub PAT secret

The CDK stack creates the secret **empty on purpose**. Storing the PAT in CDK context, environment, or CloudFormation parameters would leak it into the synthesized template and the CFN events stream. Instead, write the value out of band, *after* the stack is up:

```bash
aws secretsmanager put-secret-value \
  --secret-id <GitHubTokenSecretArn-from-outputs> \
  --secret-string <your-PAT> \
  --region <region>
```

The secret can be either:

- **A bare string** — the PAT itself, no quoting. Easiest.
- **A JSON envelope** — `{"token":"<pat>"}`, `{"GITHUB_TOKEN":"<pat>"}`, `{"github_token":"<pat>"}`, or `{"pat":"<pat>"}`. Useful if you reuse the secret for other systems that expect structured data. `server.py:_resolve_github_pat` reads any of those keys.

`server.py` resolves the secret **freshly on each invocation**, so rotation takes effect immediately:

```bash
# Rotate by writing a new value — no redeploy required.
aws secretsmanager put-secret-value \
  --secret-id <GitHubTokenSecretArn-from-outputs> \
  --secret-string <new-PAT> \
  --region <region>
```

The secret has `RemovalPolicy.RETAIN`, so a `cdk destroy` won't take it with the stack. See [Tearing it all down](#tearing-it-all-down) for the manual deletion step.

### 7. Retrieve the API key value

API Gateway returns the API key id (an opaque short string) in the stack outputs, **not** the value. Fetch the value separately:

```bash
aws apigateway get-api-key \
  --api-key <ApiKeyId-from-outputs> \
  --include-value \
  --query value --output text \
  --region <region>
```

Save that string somewhere safe — you'll send it as `x-api-key` on every request.

### 8. Verify the deploy

```bash
# /ping is a MockIntegration in API Gateway — it won't touch the runtime,
# but proves your API key works end-to-end.
curl -s https://<id>.execute-api.<region>.amazonaws.com/v1/ping \
  -H "x-api-key: <KEY>"
# => {"status":"healthy"}

# Trivial coding task — agent clones the deploy-time repoUrl and creates
# a single file. Returns 202 with a task_id immediately.
curl -s -X POST https://<id>.execute-api.<region>.amazonaws.com/v1/invocations \
  -H "x-api-key: <KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"task_description": "Open a PR that adds a hello-world line to README.md."}'
# => {"task_id":"<uuid>","status":"accepted","cwd":"/workspace"}
```

The actual work runs in the microVM. Tail the runtime logs to watch:

```bash
aws logs tail \
  /aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/coding-agent \
  --follow --region <region>
```

---

## Environment variables

These are all set by the CDK stack on the AgentCore runtime — the table is here so you know what's threaded in, what's parameterizable, and what to override locally.

### Set by the CDK stack (passed into the runtime)

| Variable | Source | Default | What it does |
|---|---|---|---|
| `AGENT_REPO_URL` | `-c repoUrl=…` (required) | — | Git repo cloned at the start of every invocation. Per-request `repo_url` payload still wins. |
| `ANTHROPIC_MODEL` | `-c anthropicModel=…` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock inference profile id. Threaded into the container. |
| `CLAUDE_CODE_USE_BEDROCK` | hard-coded in CDK | `1` | Tells the Claude Code CLI to use Bedrock instead of api.anthropic.com. |
| `CODING_AGENT_MAX_BUDGET_USD` | `-c maxBudgetUsd=…` | `5` | Hard ceiling per invocation. Passes through to `claude --max-budget-usd`. |
| `GITHUB_TOKEN_SECRET_ID` | CDK | the runtime-created secret ARN | Where `_resolve_github_pat()` looks for the PAT at request time. |

### Read by `server.py` at runtime

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_MODEL` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Model id passed to `claude --model`. |
| `CODING_AGENT_CWD` | `/workspace` | Default working directory. Per-request `cwd` payload still wins. |
| `CODING_AGENT_TIMEOUT_S` | `1800` | Hard timeout on the `claude` subprocess (seconds). |
| `CODING_AGENT_MAX_BUDGET_USD` | `5` | Default for `--max-budget-usd`. Empty string disables the cap. |
| `GITHUB_TOKEN` | (empty) | Used directly when present. **Do not use in production** — visible in `docker inspect`. Local-dev only. |
| `GITHUB_TOKEN_SECRET_ID` | (empty) | Secrets Manager secret name/ARN. Resolved fresh each invocation. |
| `AGENT_REPO_URL` | (empty) | Default repo to clone. Per-request `repo_url` payload still wins. |
| `GIT_USER_NAME` | `super-cool-background-agent` | `git config user.name` for commits the agent makes. |
| `GIT_USER_EMAIL` | `…@users.noreply.github.com` | `git config user.email` for commits the agent makes. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI binary (override only if you've put it somewhere unusual). |

### CDK context flags

| Flag | Required | Default | Notes |
|---|---|---|---|
| `repoUrl` | **yes** | — | The URL `AGENT_REPO_URL` is set to. Synth fails if missing. |
| `stackName` | no | `CodingAgent` | Lets you stand up dev/staging/prod copies side by side. |
| `anthropicModel` | no | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Sets `ANTHROPIC_MODEL` and the Bedrock IAM allowlist. |
| `maxBudgetUsd` | no | `'5'` | Default `--max-budget-usd`. |
| `agentName` | no (prop only) | `coding-agent` | Prefix for ECR repo, secret, runtime, API. Must match `^[a-z][a-z0-9-]{0,30}$`. |

---

## Invocation contract

### Request

`POST /invocations` with `Content-Type: application/json`. The body is **any JSON object**. Four top-level keys are recognized; everything else is preserved as Jira-style context and rendered into the prompt for the agent to read:

| Field | Type | Description |
|-------|------|-------------|
| `task_description` | string (optional) | Primary instruction. If omitted, the agent treats the entire payload as the task. |
| `repo_url` | string (optional) | HTTPS git URL. Overrides the deploy-time `AGENT_REPO_URL`. |
| `max_budget_usd` | number or string (optional) | Caps the dollar spend per invocation. Pass `""` to disable. |
| `cwd` | string (optional) | Override the working directory. Defaults to `/workspace` (or `/workspace/repo` when a repo is cloned). |

#### Minimal example

```bash
curl -s -X POST https://<id>.execute-api.<region>.amazonaws.com/v1/invocations \
  -H "x-api-key: <KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"task_description": "Create answer.txt containing the string 42."}'
```

#### Jira-shaped example

The agent doesn't require a specific schema — pass the Jira webhook payload directly and let the model interpret it:

```json
{
  "repo_url": "https://github.com/acme/widgets.git",
  "task_description": "Implement the change described in the Jira ticket below. Open a PR when done.",
  "issue": {
    "key": "PLAT-1421",
    "fields": {
      "summary": "Race in delete_task: filter inverted",
      "description": "The filter in delete_task uses t['id'] == task_id (keeps matching) instead of t['id'] != task_id...",
      "priority": {"name": "High"},
      "labels": ["bug", "backend"]
    }
  },
  "reporter": "evandro@acme.com",
  "max_budget_usd": 2.5
}
```

### Response

```json
{
  "task_id": "f4f1a4ed-2b71-4c7e-b3c5-3d8e3b6f0c61",
  "status": "accepted",
  "cwd": "/workspace"
}
```

The HTTP response returns immediately. The agent runs in the background inside the microVM — see [Operating the deployed agent](#operating-the-deployed-agent) for how to follow along.

---

## Operating the deployed agent

### Tail the live agent log

The application log group is `/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/coding-agent`. Each line is a one-line summary of a Claude Code stream-json event (tool call, tool result, model text, final result envelope):

```bash
aws logs tail \
  /aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/coding-agent \
  --follow --region <region>
```

Other useful log groups:

```bash
# AgentCore service-side usage (one record per invocation, with model token counts)
/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/coding-agent

# API Gateway access log (caller IP, key id, status — cleaner than method-level execution logs)
/aws/apigateway/coding-agent/access

# Lambda proxy log (visible if InvokeAgentRuntime itself fails)
/aws/lambda/coding-agent-invoke
```

### Updating the image

`build-container.sh` pushes a new image to the same `:latest` tag, but **AgentCore caches the image at create time** — you have to roll the runtime to pick up the new bits:

```bash
# 1. Build & push
./deploy/build-container.sh coding-agent agent

# 2. Roll the runtime
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id <AgentRuntimeId-from-outputs> \
  --region <region> \
  --agent-runtime-artifact 'containerConfiguration={containerUri=<account>.dkr.ecr.<region>.amazonaws.com/agentic-platform-coding-agent:latest}' \
  --network-configuration 'networkMode=PUBLIC' \
  --role-arn $(aws iam get-role --role-name <runtime-execution-role-name> --query Role.Arn --output text --region <region>) \
  --environment-variables \
      CLAUDE_CODE_USE_BEDROCK=1,\
ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0,\
CODING_AGENT_MAX_BUDGET_USD=5,\
GITHUB_TOKEN_SECRET_ID=<GitHubTokenSecretArn-from-outputs>,\
AGENT_REPO_URL=<repoUrl-you-deployed-with>
```

The runtime execution role name is visible in the stack resources:

```bash
aws cloudformation describe-stack-resource \
  --stack-name CodingAgent \
  --logical-resource-id AgentRuntimeExecutionRoleF933D1A2 \
  --query "StackResourceDetail.PhysicalResourceId" --output text \
  --region <region>
```

### Rotating the GitHub PAT

Just put a new value in the existing secret — no CDK redeploy, no runtime restart. `server.py` resolves the PAT freshly on each invocation:

```bash
aws secretsmanager put-secret-value \
  --secret-id <GitHubTokenSecretArn-from-outputs> \
  --secret-string <new-PAT> \
  --region <region>
```

### Retrieving the API key value again

Stack outputs only carry the key **id**, not the value. Re-fetch the value any time:

```bash
aws apigateway get-api-key \
  --api-key <ApiKeyId-from-outputs> \
  --include-value \
  --query value --output text \
  --region <region>
```

### Pointing the agent at a new repo

`AGENT_REPO_URL` is a CDK context value — change it via `cdk deploy -c repoUrl=…` and CloudFormation will roll the runtime with the new env var. Or override per-request by passing `repo_url` in the payload.

---

## Tearing it all down

The CDK stack owns most resources but **not** the ECR repo and **not** the GitHub PAT secret (both are `RemovalPolicy.RETAIN` on purpose, see [What the CDK stack creates](#what-the-cdk-stack-creates)). A clean teardown is three commands:

```bash
# 1. Destroy the stack — this leaves the ECR repo and the secret behind.
cd cdk
npx cdk destroy CodingAgent \
  --force \
  -c repoUrl=https://github.com/<owner>/<repo>.git
# (repoUrl is required by synth even on destroy — pass any valid URL)

# 2. Force-delete the ECR repo (and every image inside it).
aws ecr delete-repository \
  --repository-name agentic-platform-coding-agent \
  --force --region <region>

# 3. Delete the GitHub PAT secret with no recovery window.
aws secretsmanager delete-secret \
  --secret-id <GitHubTokenSecretArn-from-outputs> \
  --force-delete-without-recovery --region <region>
```

You can confirm everything is gone with:

```bash
aws cloudformation describe-stacks --stack-name CodingAgent --region <region>           # should return ValidationError
aws ecr describe-repositories --repository-names agentic-platform-coding-agent --region <region>  # should return RepositoryNotFoundException
```

---

## Local testing (no AWS)

You can exercise the container locally without AgentCore. The container needs Bedrock access for the model calls, so export your local AWS creds:

### 1. Build the image

From the `sample-agentic-platform` repo root:

```bash
docker build \
  -f src/agentic_platform/agent/coding_agent/Dockerfile \
  -t coding-agent:local \
  .
```

### 2. Run with AWS credentials

```bash
eval "$(aws configure export-credentials --format env)"

docker run --rm -p 8080:8080 \
  -e AWS_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  -e ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0" \
  -e CLAUDE_CODE_USE_BEDROCK=1 \
  -e GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  --name coding-agent-test \
  coding-agent:local
```

### 3. Send a request

```bash
# Health check
curl -s http://localhost:8080/ping
# => {"status":"healthy"}

# Trivial task
curl -s -X POST http://localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"task_description": "Create answer.txt containing 42 in the current directory."}'

# Jira-shaped task against a real repo
curl -s -X POST http://localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{
  "repo_url": "https://github.com/octocat/Hello-World.git",
  "task_description": "Add a CONTRIBUTING.md with a one-paragraph welcome message.",
  "issue": {"key": "DEMO-1", "summary": "Add CONTRIBUTING"}
}
JSON
```

The local response is the same `{task_id, status, cwd}` envelope; the actual `claude` run continues in the container after the HTTP response returns.

---

## Troubleshooting

### `cdk deploy` fails: `repoUrl is required`

You forgot `-c repoUrl=…`. The stack has no default by design.

### `cdk deploy` fails: `image with reference … not found`

You didn't run `./deploy/build-container.sh coding-agent agent` first, or it pushed to a different region than CDK is targeting. Confirm:

```bash
aws ecr describe-repositories --repository-names agentic-platform-coding-agent --region <region>
aws ecr list-images          --repository-name  agentic-platform-coding-agent --region <region>
```

### Invocations return `403 Forbidden`

Missing or wrong `x-api-key` header. Re-fetch the value (see [Retrieving the API key value again](#retrieving-the-api-key-value-again)) and retry.

### Invocations return `202` but nothing happens

Tail the application log group (`/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/coding-agent`). Common causes:

- **`git clone failed`** — the GitHub PAT is missing or doesn't have access to the repo. Re-write the secret (see [Rotating the GitHub PAT](#rotating-the-github-pat)).
- **`AccessDeniedException` on `InvokeModel…`** — Bedrock IAM mismatch (e.g. you set `anthropicModel` to a profile your account doesn't have access to). Confirm with `aws bedrock list-foundation-models --region <region>`.
- **`claude CLI exited 1`** — the agent itself errored. The CloudWatch line includes the CLI's stderr.

### `cdk destroy` finishes but resources are still there

Expected — the ECR repo and PAT secret are RETAIN. See [Tearing it all down](#tearing-it-all-down) for the manual cleanup commands.

### I want a second copy alongside the first

```bash
npx cdk deploy -c stackName=CodingAgentDev -c repoUrl=https://github.com/.../foo.git
```

Both stacks coexist; resources are namespaced by `agentName` (default `coding-agent`). If you want fully separate ECR repos and secrets, also pass a different `agentName` via the stack prop in `cdk/bin/coding-agent.ts`.

---

## File layout

```
src/agentic_platform/agent/coding_agent/
├── Dockerfile           # Python 3.12 + Node 24 + Claude Code CLI
├── README.md            # this file (operator docs)
├── AGENTS.md            # contributor / AI-assistant guide
├── __init__.py
├── requirements.txt     # FastAPI, uvicorn, boto3, pydantic
└── server.py            # FastAPI shim around `claude -p`

cdk/
├── bin/coding-agent.ts                       # CDK app entrypoint
├── lib/constructs/agentcore-runtime.ts       # ECR repo (imported) + secret + runtime + IAM
├── lib/constructs/api-key-frontdoor.ts       # API Gateway + Lambda proxy + key + usage plan
├── lib/stacks/coding-agent-stack.ts          # Composes the two constructs
└── lambda/invoke/index.ts                    # InvokeAgentRuntime proxy handler
```

`cdk/README.md` covers the stack-internals view; this file is the agent-author / operator view.
