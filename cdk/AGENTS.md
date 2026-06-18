# CDK Guide for AI Agents

Context for AI agents working under `cdk/`. Keep changes scoped — this directory is the CDK-first equivalent of the Terraform stacks under [`infrastructure/`](../infrastructure/), and the two are not mirrors. They share *agent code* (under `src/`) but each owns its own deploy surface.

For the human-facing overview, read [`README.md`](README.md) first.

## Critical rules

```bash
# After ANY change in cdk/
cd cdk
npx tsc --noEmit                      # type check
npx cdk synth --quiet \
  -c repoUrl=https://github.com/owner/repo.git   # cdk-nag must show "success"

# After EVERY commit (run from repo root)
gitleaks detect .
```

The `repoUrl` context flag is **required** for synth — the `CodingAgentStack` throws if it's missing. Use any plausible https URL when synthesizing locally; it doesn't have to exist.

## Stack invariants

These are not optional. Don't change them without asking:

- **`repoUrl` is required at deploy time.** No default. The stack pins one repo per deployment so a misconfigured deploy can't accidentally point at the wrong codebase. Code path: [`coding-agent-stack.ts`](lib/stacks/coding-agent-stack.ts) reads `tryGetContext('repoUrl')` and throws if unset; [`agentcore-runtime.ts`](lib/constructs/agentcore-runtime.ts) re-validates the value is `http(s)://…`.
- **The GitHub PAT secret is created empty.** Never wire the PAT into CDK context, env vars at synth time, or stack props — those leak into the synthesized template and the CFN events stream. The operator runs `aws secretsmanager put-secret-value` after `cdk deploy` lands. The secret has `RemovalPolicy.RETAIN` so `cdk destroy` won't take it.
- **The ECR repo is *imported*, not created.** [`deploy/build-container.sh`](../deploy/build-container.sh) creates the repo on first run and owns its lifecycle. CDK references it by name. This means the agent image must already be in ECR before `cdk deploy` runs (AgentCore validates the image at create time).
- **cdk-nag must pass with `success`.** Three fixes that landed earlier (APIG access logs, request validator, per-method exec logs) plus a handful of acknowledgements with explicit `reason:` text. If you trip a new finding, fix the underlying issue first; only acknowledge with a real justification.
- **`/invocations` AND `/ping` both require the API key.** APIG4 has a documented ack saying so — don't open `/ping` to make health probes "easier."
- **APIG → Lambda → AgentCore.** APIG's AWS service integration doesn't list `bedrock-agentcore`. We tried; it returned `AWS Service of type bedrock-agentcore not supported`. Do not re-attempt direct integration.

## Layout

```
cdk/
├── bin/
│   └── coding-agent.ts       # CDK app entrypoint; wires up cdk-nag plugin
├── lib/
│   ├── constructs/
│   │   ├── agentcore-runtime.ts     # Runtime + secret + log groups + Bedrock IAM
│   │   └── api-key-frontdoor.ts     # APIG + Lambda proxy + key + usage plan
│   └── stacks/
│       └── coding-agent-stack.ts    # Composes the two constructs
├── lambda/
│   └── invoke/
│       └── index.ts          # Lambda handler — InvokeAgentRuntime SDK call
├── cdk.json
├── package.json
└── tsconfig.json
```

`lib/` describes infrastructure (compiled by `tsc`, evaluated by `cdk synth`). `lambda/` is application code that ships *to* AWS as a deployment artifact (bundled by esbuild via `NodejsFunction`). They live in sibling top-level dirs because mixing them risks the CDK synth pulling in 5MB of SDK code unnecessarily.

## Where to make changes

| Change | Primary location | Also update |
|---|---|---|
| Lambda proxy logic | [`lambda/invoke/index.ts`](lambda/invoke/index.ts) | `cdk-nag` acks if you touch the IAM role |
| Adding APIG routes / methods | [`lib/constructs/api-key-frontdoor.ts`](lib/constructs/api-key-frontdoor.ts) | README architecture diagram |
| Runtime env vars (e.g. new secret, new flag) | [`lib/constructs/agentcore-runtime.ts`](lib/constructs/agentcore-runtime.ts) | Mirror the env var consumer in [`server.py`](../src/agentic_platform/agent/coding_agent/server.py) |
| Adding a new stack-level prop | [`lib/stacks/coding-agent-stack.ts`](lib/stacks/coding-agent-stack.ts) | README "Configuration" table |
| Bedrock model / region update | `agentcore-runtime.ts` (env var + `InvokeBedrockInferenceProfile` policy resources) | Both must change together — the policy lists explicit foundation-model ARNs the inference profile routes to |
| Container code | [`src/agentic_platform/agent/coding_agent/`](../src/agentic_platform/agent/coding_agent/) | Rebuild via `./deploy/build-container.sh coding-agent agent`; bump runtime (see "Updating the image" in README) |

## Workflow: deploying for the first time

1. **Build & push the agent image.** This creates the ECR repo if it's missing.

   ```bash
   ./deploy/build-container.sh coding-agent agent
   ```

2. **Install CDK deps** (one time per worktree):

   ```bash
   cd cdk
   npm install
   ```

3. **Bootstrap CDK** (one time per AWS account + region):

   ```bash
   npx cdk bootstrap aws://<account-id>/<region>
   ```

4. **Deploy with `repoUrl` context.** Synth will throw if you skip it.

   ```bash
   npx cdk deploy -c repoUrl=https://github.com/owner/repo.git
   ```

5. **Populate the GitHub PAT secret manually:**

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id <GitHubTokenSecretArn-from-outputs> \
     --secret-string <PAT>
   ```

6. **Smoke test** with the API key from outputs:

   ```bash
   API_KEY=$(aws apigateway get-api-key --api-key <ApiKeyId> --include-value --query value --output text)
   curl -X POST <ApiUrl>invocations \
     -H "x-api-key: $API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"task_description": "Open a PR adding a hello-world line to README.md"}'
   ```

   Returns `202` with a `task_id` in milliseconds. Watch the agent run live in CloudWatch:

   ```bash
   aws logs tail /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT --follow
   ```

## Common mistakes

- **Synthesizing without `-c repoUrl=…`** — synth fails with a thrown error. Pass any plausible https URL for local synth.
- **Putting the PAT in CDK context** — the value lands in the synth template. Always `put-secret-value` after deploy.
- **Deploying before pushing the image** — AgentCore rejects the runtime create with `The specified image identifier does not exist in the repository`. Build first.
- **Pushing a new image and expecting it to roll automatically** — the `:latest` tag is mutable, but AgentCore caches the digest at create time. After `build-container.sh`, run the `update-agent-runtime` command from the README to force a roll.
- **Acknowledging cdk-nag findings without a real reason** — every existing ack has documented justification (bounded wildcard, externally-managed secret, intentional design choice). Don't add one to make a synth pass; fix the underlying issue.
- **Adding a Bedrock model in the env var without updating IAM** — `InvokeBedrockInferenceProfile` policy lists *explicit* foundation-model ARNs. Inference profiles route to multiple regional FM ARNs; both the profile AND the FM ARNs need a grant.
- **Forgetting `--no-rollback` after a failed deploy** — if a previous deploy left the stack in `UPDATE_FAILED`, the CDK CLI requires `--no-rollback` (or interactive TTY confirmation) to keep going.

## How this differs from the Terraform path

The Terraform stacks under [`infrastructure/`](../infrastructure/) build a multi-tenant *platform* — VPC, EKS, gateways, knowledge layer — that hosts many agents at once. The CDK stack here is a *single-purpose* deployment for the coding agent: one runtime, one API in front of it, one set of credentials. Both paths use the same agent code under [`src/agentic_platform/agent/coding_agent/`](../src/agentic_platform/agent/coding_agent/).

Don't try to merge the two languages. Adding a new agent in CDK = a new stack file beside `coding-agent-stack.ts` and a new entry in `bin/coding-agent.ts`. Adding a new agent in Terraform = a new workspace under `infrastructure/stacks/agentcore-runtime/`.

## Related docs

- [`README.md`](README.md) — human-facing overview, architecture diagram, deploy walkthrough
- [`../src/agentic_platform/agent/coding_agent/README.md`](../src/agentic_platform/agent/coding_agent/README.md) — agent runtime contract, prompt building, PAT resolution
- [`../infrastructure/AGENTS.md`](../infrastructure/AGENTS.md) — the Terraform-equivalent guide
