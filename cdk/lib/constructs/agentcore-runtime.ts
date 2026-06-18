import { RemovalPolicy, Duration, Stack, Validations } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * Reusable infra for an AgentCore-hosted agent: ECR repo, GitHub PAT
 * secret, the runtime itself, and its log groups.
 *
 * Image lifecycle is owned by `deploy.sh` — this construct only references
 * the ECR repo's `:latest` tag. AgentCore validates the container at
 * create time, so the first deploy expects an image to already be present
 * (handled by `deploy.sh bootstrap`).
 */
export interface AgentCoreRuntimeProps {
  /**
   * Logical agent name. Used as a suffix for the ECR repo, secret, and
   * runtime so multiple agents can coexist in the same account. Must
   * match `^[a-z][a-z0-9-]{0,30}$`.
   */
  readonly agentName: string;

  /**
   * Bedrock inference profile id, exposed to the container as ANTHROPIC_MODEL.
   */
  readonly anthropicModel: string;

  /**
   * Hard ceiling on what the agent can spend per invocation, in USD.
   * Exposed to the container as CODING_AGENT_MAX_BUDGET_USD.
   */
  readonly maxBudgetUsd: string;

  /**
   * Git repo the agent clones on every invocation. Required — the stack
   * does not ship a default. Threaded into the container as
   * `AGENT_REPO_URL`. Provide via `cdk deploy -c repoUrl=https://...`
   * (or the `defaultRepoUrl` stack prop in code).
   */
  readonly repoUrl: string;

  /**
   * Extra environment variables merged on top of the defaults.
   */
  readonly extraEnvironment?: { [key: string]: string };
}

export class AgentCoreRuntime extends Construct {
  readonly repository: ecr.IRepository;
  readonly githubTokenSecret: secretsmanager.Secret;
  readonly runtime: agentcore.Runtime;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeProps) {
    super(scope, id);

    const { agentName, anthropicModel, maxBudgetUsd, repoUrl } = props;

    if (!/^[a-z][a-z0-9-]{0,30}$/.test(agentName)) {
      throw new Error(
        `agentName "${agentName}" must match ^[a-z][a-z0-9-]{0,30}$ — it ` +
          'is used directly in ECR repo, secret, and runtime names.',
      );
    }

    if (!repoUrl || !/^https?:\/\//.test(repoUrl)) {
      throw new Error(
        `repoUrl is required and must be an http(s) URL — got "${repoUrl ?? ''}". ` +
          'Pass it via `cdk deploy -c repoUrl=https://github.com/owner/repo.git`.',
      );
    }

    // AgentCore runtime names: a-zA-Z0-9_, must start with a letter,
    // max 48 chars. Hyphens aren't allowed.
    const runtimeName = agentName.replace(/-/g, '_');

    // ─── ECR repository (imported, not created here) ───────────────────
    // The repo and its `:latest` image are owned by `deploy/build-
    // container.sh` — that script creates the repo on first run, and
    // every subsequent run pushes a new image to the same `:latest`
    // tag. CDK only references it. This avoids two problems:
    //   1. AgentCore validates the image at create time, so CDK can't
    //      stand the runtime up before an image exists in the repo.
    //   2. Image lifecycle (push cadence, scan, retention) belongs to
    //      the deploy script, not infra deploys.
    this.repository = ecr.Repository.fromRepositoryName(
      this,
      'Repository',
      `agentic-platform-${agentName}`,
    );

    // ─── GitHub PAT secret ─────────────────────────────────────────────
    // Created empty. Populate with `aws secretsmanager put-secret-value`
    // out of band so the PAT never lands in git or CFN parameters. The
    // runtime resolves it at request time via GITHUB_TOKEN_SECRET_ID
    // (server.py:_resolve_github_pat).
    this.githubTokenSecret = new secretsmanager.Secret(this, 'GitHubTokenSecret', {
      secretName: `${agentName}/github-token`,
      description:
        `GitHub PAT for the ${agentName} runtime. Populate with ` +
        '`aws secretsmanager put-secret-value`. Recommended scopes: ' +
        'contents:read+write, pull_requests:read+write.',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ─── Log groups ────────────────────────────────────────────────────
    const applicationLogGroup = new logs.LogGroup(this, 'ApplicationLogs', {
      logGroupName: `/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/${agentName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const usageLogGroup = new logs.LogGroup(this, 'UsageLogs', {
      logGroupName: `/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/${agentName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ─── Runtime ───────────────────────────────────────────────────────
    const artifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(
      this.repository,
      'latest',
    );

    this.runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName,
      description: `${agentName} — Claude Code on Bedrock`,
      agentRuntimeArtifact: artifact,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
      environmentVariables: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: anthropicModel,
        CODING_AGENT_MAX_BUDGET_USD: maxBudgetUsd,
        GITHUB_TOKEN_SECRET_ID: this.githubTokenSecret.secretArn,
        AGENT_REPO_URL: repoUrl,
        ...(props.extraEnvironment ?? {}),
      },
      lifecycleConfiguration: {
        // 8h is the AgentCore maximum — long-running clone/build/test
        // work can hold a session for the whole job. Critical for the
        // 202-on-accept pattern: the microVM has to outlive the HTTP
        // response so the backgrounded subprocess can finish.
        idleRuntimeSessionTimeout: Duration.hours(8),
        maxLifetime: Duration.hours(8),
      },
      loggingConfigs: [
        {
          logType: agentcore.LogType.APPLICATION_LOGS,
          destination: agentcore.LoggingDestination.cloudWatchLogs(applicationLogGroup),
        },
        {
          logType: agentcore.LogType.USAGE_LOGS,
          destination: agentcore.LoggingDestination.cloudWatchLogs(usageLogGroup),
        },
      ],
    });

    // The L2 grants ECR pull + Logs write + AgentCore workload-identity
    // on the runtime's execution role. Bedrock invocation rights are
    // NOT included (verified empirically — `claude -p` failed with
    // AccessDeniedException on InvokeModelWithResponseStream until
    // we added these). Grant the inference profile and the regional
    // foundation models it routes to.
    this.githubTokenSecret.grantRead(this.runtime);

    const stackForBedrock = Stack.of(this);
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeBedrockInferenceProfile',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          // The cross-region inference profile itself.
          `arn:aws:bedrock:${stackForBedrock.region}:${stackForBedrock.account}:inference-profile/${anthropicModel}`,
          // The 3 US foundation-model ARNs the `us.*` profile routes to.
          // Inference profile invocations check both the profile arn and
          // the underlying foundation model arns.
          `arn:aws:bedrock:us-east-1::foundation-model/${anthropicModel.replace(/^us\./, '')}`,
          `arn:aws:bedrock:us-east-2::foundation-model/${anthropicModel.replace(/^us\./, '')}`,
          `arn:aws:bedrock:us-west-2::foundation-model/${anthropicModel.replace(/^us\./, '')}`,
        ],
      }),
    );

    // ─── cdk-nag acknowledgements ──────────────────────────────────────
    // Validations.of(node).acknowledge cascades to descendants — so
    // acknowledging on `this` (the construct subtree) covers the secret
    // and the runtime's auto-generated execution role policies in one shot.
    Validations.of(this.githubTokenSecret).acknowledge({
      id: 'AwsSolutions-SMG4',
      reason:
        'GitHub PATs are managed by humans on github.com — automatic rotation by AWS Secrets Manager is not applicable. Rotate manually via `aws secretsmanager put-secret-value` when a new PAT is issued.',
    });

    // The runtime's execution role inherits a set of wildcards from the
    // L2 Runtime construct: CloudWatch Logs (vended log groups + their
    // streams), Bedrock InvokeModel across foundation models, and
    // AgentCore workload-identity-directory entries scoped by runtime
    // name. These mirror the IAM template AWS publishes for AgentCore
    // runtimes (see the reference Terraform module). cdk-nag v3
    // acknowledges by exact finding id — including the resolved
    // region/account — so we build the ids from the stack env.
    const stack = Stack.of(this);
    const region = stack.region;
    const account = stack.account;
    const reason =
      'Wildcards are generated by the L2 `agentcore.Runtime` construct for ' +
      'CloudWatch Logs vended log groups, AgentCore workload-identity entries ' +
      'scoped to this runtime, and Bedrock InvokeModel (cross-region ' +
      'inference profiles require account-wide patterns). Each wildcard ' +
      'sits inside a resource pattern that the service contract requires.';
    const runtimeFindings = [
      `AwsSolutions-IAM5[Resource::arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*]`,
      `AwsSolutions-IAM5[Resource::arn:aws:logs:${region}:${account}:log-group:*]`,
      `AwsSolutions-IAM5[Resource::arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*]`,
      `AwsSolutions-IAM5[Resource::arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/*]`,
      'AwsSolutions-IAM5[Resource::*]',
    ];
    for (const id of runtimeFindings) {
      Validations.of(this.runtime).acknowledge({ id, reason });
    }
  }
}
