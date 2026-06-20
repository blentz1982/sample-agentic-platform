import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AgentCoreRuntime } from '../constructs/agentcore-runtime';
import { ApiKeyFrontDoor } from '../constructs/api-key-frontdoor';

/**
 * Stand-up-once infrastructure for the coding agent.
 *
 * Composes:
 *   - AgentCoreRuntime    (ECR repo + GitHub PAT secret + Runtime + logs)
 *   - ApiKeyFrontDoor     (API Gateway + key + InvokeAgentRuntime integration)
 *
 * Application changes (image rebuild + redeploy) are handled by
 * `src/agentic_platform/agent/coding_agent/deploy.sh`. CDK should only
 * run when infrastructure changes.
 *
 * First-deploy sequencing: AgentCore validates that the referenced
 * container URI is pullable at create time, so deploy.sh must push an
 * initial `:latest` image to ECR before `cdk deploy` runs (the `bootstrap`
 * flow in deploy.sh).
 */
export interface CodingAgentStackProps extends StackProps {
  /**
   * Logical agent name. @default 'coding-agent'
   */
  readonly agentName?: string;

  /**
   * Bedrock inference profile id.
   * @default 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
   */
  readonly anthropicModel?: string;

  /**
   * Hard ceiling on per-invocation USD spend.
   * @default '5'
   */
  readonly maxBudgetUsd?: string;

  /**
   * Git repo the agent clones on every invocation. **Required** — the
   * stack intentionally has no default so each deployment is explicitly
   * scoped to the repo it operates on. Overridable from the CLI:
   * `cdk deploy -c repoUrl=https://github.com/owner/repo.git`.
   */
  readonly repoUrl?: string;

  /**
   * Pin the runtime to an image digest (`sha256:...`) instead of the
   * floating `:latest` tag, so a new image push actually rolls the
   * runtime on `cdk deploy`. Overridable from the CLI:
   * `cdk deploy -c imageDigest=sha256:...`.
   */
  readonly imageDigest?: string;
}

export class CodingAgentStack extends Stack {
  readonly agentRuntime: AgentCoreRuntime;
  readonly frontDoor: ApiKeyFrontDoor;

  constructor(scope: Construct, id: string, props: CodingAgentStackProps = {}) {
    super(scope, id, props);

    const agentName = props.agentName ?? 'coding-agent';

    // Repo URL must be supplied either via the prop or via the CLI
    // context flag (`cdk deploy -c repoUrl=https://...`). Synth fails
    // fast if it's missing so a misconfigured deploy can't accidentally
    // stand a runtime up against the wrong repo.
    const repoCtx = this.node.tryGetContext('repoUrl');
    const repoUrl = (typeof repoCtx === 'string' && repoCtx) || props.repoUrl;
    if (!repoUrl) {
      throw new Error(
        'repoUrl is required. Pass `-c repoUrl=https://github.com/owner/repo.git` to `cdk deploy`/`cdk synth`, ' +
          'or set the `repoUrl` prop when instantiating CodingAgentStack.',
      );
    }

    // Optional digest pin (see CodingAgentStackProps.imageDigest). When
    // present, the runtime references the image by `@sha256:...` so each
    // push rolls the runtime on deploy instead of being a no-op.
    const digestCtx = this.node.tryGetContext('imageDigest');
    const imageDigest =
      (typeof digestCtx === 'string' && digestCtx) || props.imageDigest;

    this.agentRuntime = new AgentCoreRuntime(this, 'AgentRuntime', {
      agentName,
      anthropicModel:
        props.anthropicModel ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      maxBudgetUsd: props.maxBudgetUsd ?? '5',
      repoUrl,
      imageDigest,
    });

    this.frontDoor = new ApiKeyFrontDoor(this, 'FrontDoor', {
      agentName,
      runtime: this.agentRuntime.runtime,
    });

    new CfnOutput(this, 'EcrRepositoryUri', {
      value: this.agentRuntime.repository.repositoryUri,
      description: 'Push the agent image here from deploy.sh',
    });

    new CfnOutput(this, 'EcrRepositoryName', {
      value: this.agentRuntime.repository.repositoryName,
      description: 'ECR repo name (used by deploy.sh)',
    });

    new CfnOutput(this, 'GitHubTokenSecretArn', {
      value: this.agentRuntime.githubTokenSecret.secretArn,
      description:
        'Populate with `aws secretsmanager put-secret-value --secret-id <arn> --secret-string <PAT>`',
    });

    new CfnOutput(this, 'AgentRuntimeArn', {
      value: this.agentRuntime.runtime.agentRuntimeArn,
      description: 'ARN of the AgentCore runtime (used by deploy.sh to roll new images)',
    });

    new CfnOutput(this, 'AgentRuntimeId', {
      value: this.agentRuntime.runtime.agentRuntimeId,
      description: 'AgentCore runtime id (used by deploy.sh to roll new images)',
    });

    new CfnOutput(this, 'ApiUrl', {
      value: this.frontDoor.api.url,
      description: 'Base URL for the coding agent API. Append `invocations` to invoke.',
    });

    new CfnOutput(this, 'ApiKeyId', {
      value: this.frontDoor.apiKey.keyId,
      description:
        'API key id. Retrieve the value with `aws apigateway get-api-key --api-key <id> --include-value`.',
    });
  }
}
