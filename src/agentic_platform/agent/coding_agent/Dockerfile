# Coding agent — Claude Code running on Bedrock, hosted on Bedrock AgentCore.
#
# Stage 1: Builder with Python deps (uv).
# checkov:skip=CKV_DOCKER_2: AgentCore handles health checks via /ping.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_SYSTEM_PYTHON=1 UV_COMPILE_BYTECODE=1
WORKDIR /app

COPY src/agentic_platform/agent/coding_agent/requirements.txt .
RUN uv pip install -r requirements.txt

# Stage 2: Runtime — add Node.js 24 + Claude Code CLI on top of the builder.
FROM builder AS server

# Node.js 24 LTS (required by Claude Code CLI), git for repo work, gh for
# the agent to open PRs (uses GITHUB_TOKEN env at call time — no separate
# auth step required).
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg git && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    install -dm 0755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
    chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN npm install -g @anthropic-ai/claude-code@2.1.142

# Non-root user — Claude Code CLI refuses bypassPermissions as root.
RUN groupadd appgroup && useradd -m -g appgroup appuser && \
    mkdir -p /workspace && chown -R appuser:appgroup /workspace /app

WORKDIR /app

COPY --chown=appuser:appgroup src/agentic_platform/core/ agentic_platform/core/
COPY --chown=appuser:appgroup src/agentic_platform/agent/coding_agent/ agentic_platform/agent/coding_agent/

ENV PYTHONPATH=/app:$PYTHONPATH \
    PYTHONUNBUFFERED=1 \
    CLAUDE_CODE_USE_BEDROCK=1 \
    # Default the GitHub PAT to empty so the env-var lookup in server.py
    # always has something to read. Override at runtime (-e GITHUB_TOKEN=...)
    # for local dev, or set GITHUB_TOKEN_SECRET_ID to pull from
    # Secrets Manager at request time.
    GITHUB_TOKEN="" \
    GITHUB_TOKEN_SECRET_ID=""

USER appuser
WORKDIR /workspace

EXPOSE 8080

CMD ["uvicorn", "agentic_platform.agent.coding_agent.server:app", "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/app"]
