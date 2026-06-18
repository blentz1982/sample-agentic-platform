# CDK Stacks

This directory holds the **AWS CDK** equivalents of the Terraform stacks under [`infrastructure/`](../infrastructure/). The goal is to gradually offer a CDK-first deployment surface alongside the existing Terraform one — same agents, same shared core library, two infra languages.

The first stack lives here: **`CodingAgent`**, an autonomous coding agent that hosts Claude Code inside an Amazon Bedrock AgentCore runtime, fronted by an API-key-gated REST API.

## Why AgentCore for the coding agent

You can deploy any agent in the platform's existing EKS cluster (see [`k8s/`](../k8s/)) — that's the path to take when an agent is part of an interactive request/response flow with users.

The coding agent's call pattern is different:

- **One job, minutes-to-hours of work.** A single invocation clones a repo, runs Claude Code, edits files, and opens a PR. That can take 30 seconds or 30 minutes.
- **Per-call isolation matters.** Each task gets its own writable filesystem, its own ephemeral GitHub credentials, its own subprocess tree. We don't want one coding job's `git checkout` to step on another's.
- **No co-tenancy with HTTP traffic.** A long-running `claude` subprocess shouldn't sit on a Kubernetes pod that's also fielding fast user requests — it pins memory, eats CPU during builds, and forces ugly autoscaler thresholds.

AgentCore Runtime gives us exactly that: every invocation lands in its own short-lived Firecracker microVM with up to 8 hours of lifetime, full root inside that VM, and CloudWatch streaming for live observability. The microVM is created per session, used for the run, and discarded — no shared state, no resource fights with other workloads.

If a future agent has the *opposite* pattern (high QPS, sub-second responses, tight chat loop), put it in the EKS cluster instead. The platform supports both.

## Architecture

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
                  │  /aws/bedrock-agentcore/runtimes/<id>-DEFAULT│
                  └────────────────────┬─────────────────────────┘
                                       │
                                       ▼
                       ┌─────────────────────────────────┐
                       │  Amazon Bedrock                 │
                       │  (Claude Sonnet 4.5 inference   │
                       │   profile, cross-region)        │
                       └─────────────────────────────────┘
```

The HTTP call returns **`202 Accepted`** with a `task_id` as soon as AgentCore accepts the work — the actual `claude -p` run continues in the microVM behind the scenes. The 29s API Gateway integration timeout is therefore irrelevant for real coding work; the response comes back in milliseconds.

### Why a Lambda proxy

API Gateway's "AWS service integration" doesn't list `bedrock-agentcore` as a supported target service, so a small Lambda calls `InvokeAgentRuntime` over the SDK on behalf of the caller. The Lambda is a thin pass-through:

- Forward the caller's body verbatim as the `payload`
- Generate a 36-char session id (AgentCore requires ≥33)
- Drain the AgentCore response stream and return it to API Gateway

No business logic lives in the Lambda — all of that is in `server.py` inside the microVM.

## Stack contents

| Resource | Purpose |
|---|---|
| `agentcore.Runtime` | AgentCore runtime, pinned to `<ecr-repo>:latest`. 8h idle + max session lifetime. |
| `secretsmanager.Secret` | Empty placeholder for the GitHub PAT. Populate manually post-deploy. |
| `apigateway.RestApi` | REST API with `/invocations` (POST) and `/ping` (GET), both API-key gated. Stage `v1`. Throttle: 2 rps / 5 burst. |
| `lambda.Function` | Node 22 / ARM64 proxy that calls `InvokeAgentRuntime`. |
| `apigateway.ApiKey` + `UsagePlan` | Single key with usage plan for rate limiting. |
| 4× `logs.LogGroup` | AgentCore application logs, AgentCore usage logs, APIG access logs, Lambda logs. All 90-day retention. |
| 2× `iam.Role` | Runtime execution role (Bedrock + Secrets Manager + ECR pull) and Lambda execution role. |

cdk-nag (AWS Solutions ruleset) is wired into the synth and currently passes clean.

## Deploy order

The CDK stack **does not own the ECR repo** — it imports one created by [`deploy/build-container.sh`](../deploy/build-container.sh). The build script is the source of truth for image lifecycle (build, scan, push to `:latest`), and AgentCore validates the image at create time, so the image must exist before the stack is deployed. The order is:

1. **Build & push the agent image** (creates the ECR repo if it doesn't exist):

   ```bash
   ./deploy/build-container.sh coding-agent agent
   ```

   This authenticates Docker to ECR, creates `agentic-platform-coding-agent` if missing, and pushes a multi-arch (`amd64` + `arm64`) image to `:latest`.

2. **Install CDK deps** (one time):

   ```bash
   cd cdk
   npm install
   ```

3. **Bootstrap CDK in the target account/region** (one time per account+region):

   ```bash
   npx cdk bootstrap aws://<account-id>/<region>
   ```

4. **Deploy the stack — `repoUrl` is required.** The stack ships no default; you have to tell it which repo this deployment operates on. Synth fails fast with a clear error if it's missing.

   ```bash
   npx cdk deploy -c repoUrl=https://github.com/owner/repo.git
   ```

   The repo URL is threaded into the runtime as `AGENT_REPO_URL` and used by `server.py` to clone the repo on every invocation. The deploy also creates the API, an **empty** GitHub PAT secret in Secrets Manager, and prints the API URL, API key id, runtime ARN, and secret ARN as CFN outputs.

5. **Populate the GitHub PAT secret manually.** The stack deliberately does *not* hold the PAT in CDK context, environment, or CloudFormation parameters — those would land it in the synthesized template and the CFN events stream. Instead, the secret is created empty and you write the value with the AWS CLI *after* the stack is up:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id <GitHubTokenSecretArn-from-outputs> \
     --secret-string <your-PAT>
   ```

   The secret is `RemovalPolicy.RETAIN`, so a `cdk destroy` won't take it with the stack — destroy it manually if you want it gone. To rotate, run `put-secret-value` again with the new PAT; `server.py` resolves the secret freshly on each invocation, so rotation takes effect immediately with no redeploy.

   **Recommended scope for the PAT:** fine-grained, `contents: read+write`, and `pull_requests: read+write` if you want the agent to open PRs.

6. **Retrieve the API key value:**

   ```bash
   aws apigateway get-api-key \
     --api-key <ApiKeyId-from-outputs> \
     --include-value \
     --query value --output text
   ```

7. **Invoke:**

   ```bash
   curl -X POST <ApiUrl>invocations \
     -H "x-api-key: <KEY>" \
     -H 'Content-Type: application/json' \
     -d '{"task_description": "Open a PR that adds a hello-world line to README.md."}'
   ```

   Returns `202` with a `task_id` in milliseconds; the agent runs asynchronously inside the microVM and clones the deploy-time `repoUrl` automatically.

### Updating the image

The CDK stack pins `:latest`, so running `deploy/build-container.sh` again pushes a new image to the same tag — but **AgentCore caches the image at create time**. To roll the runtime to the new image, force an update:

```bash
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id <id-from-outputs> \
  --region <region> \
  --agent-runtime-artifact 'containerConfiguration={containerUri=<account>.dkr.ecr.<region>.amazonaws.com/agentic-platform-coding-agent:latest}' \
  --network-configuration 'networkMode=PUBLIC' \
  --role-arn $(aws iam get-role --role-name <runtime-exec-role> --query Role.Arn --output text) \
  --environment-variables CLAUDE_CODE_USE_BEDROCK=1,ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0,CODING_AGENT_MAX_BUDGET_USD=5,GITHUB_TOKEN_SECRET_ID=<secret-arn>,AGENT_REPO_URL=<repo>
```

(A future iteration of `deploy/build-container.sh` should bake this in.)

## Layout

```
cdk/
├── bin/
│   └── coding-agent.ts       CDK app entrypoint; registers cdk-nag
├── lib/
│   ├── constructs/
│   │   ├── agentcore-runtime.ts     Runtime + secret + log groups + Bedrock IAM
│   │   └── api-key-frontdoor.ts     APIG + Lambda proxy + key + usage plan
│   └── stacks/
│       └── coding-agent-stack.ts    Composes the two constructs
├── lambda/
│   └── invoke/
│       └── index.ts          Lambda handler (bundled by NodejsFunction/esbuild)
├── cdk.json
├── package.json
└── tsconfig.json
```

`lib/` describes infrastructure (compiled by `tsc` and evaluated by `cdk synth`). `lambda/` is application code that ships *to* AWS as a deployment artifact (bundled by esbuild via `NodejsFunction`).

## Configuration

| Stack prop / context | Default | Meaning |
|---|---|---|
| `repoUrl` / `-c repoUrl=…` | **required** | Git repo the agent clones on every invocation. Synth fails if this isn't set. Threaded in as `AGENT_REPO_URL`. |
| `agentName` | `coding-agent` | Used as a prefix for the ECR repo, secret, runtime, API, and key. Must match `^[a-z][a-z0-9-]{0,30}$`. |
| `anthropicModel` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock inference profile id. Threaded into the container as `ANTHROPIC_MODEL`. |
| `maxBudgetUsd` | `'5'` | Hard ceiling per invocation. Threaded in as `CODING_AGENT_MAX_BUDGET_USD`. |

## Relationship to the Terraform stacks

The Terraform stacks under [`infrastructure/`](../infrastructure/) build a multi-tenant *platform* — VPC, EKS, gateways, knowledge layer — that hosts many agents and many call patterns. This CDK stack is a *single agent* deployment, sized for the coding-agent's call shape: one runtime, one API in front of it, one set of credentials.

Both deployment paths use the same agent code in [`src/agentic_platform/agent/coding_agent/`](../src/agentic_platform/agent/coding_agent/). If you want to deploy more CDK-managed agents over time, add new stacks beside `coding-agent-stack.ts` and wire them up in `bin/coding-agent.ts`.
