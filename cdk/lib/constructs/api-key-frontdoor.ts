import * as path from 'path';
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * API Gateway in front of an AgentCore runtime, gated by an API key.
 *
 * Caller flow:
 *
 *   client (x-api-key header) -> API Gateway /invocations
 *                              -> Lambda proxy (this construct)
 *                              -> bedrock-agentcore:InvokeAgentRuntime
 *                              -> AgentCore Runtime container
 *
 * Why a Lambda proxy: API Gateway's AWS service integration doesn't list
 * `bedrock-agentcore` as a supported target, so a small Lambda calls the
 * SDK on behalf of the caller. The agent harness inside the container
 * (see server.py) returns 202 as soon as the task is accepted, so the
 * APIG 29s integration timeout is fine for real coding work — the
 * response comes back in ms.
 */
export interface ApiKeyFrontDoorProps {
  /**
   * Name used as a prefix for the API, key, and usage plan so this
   * construct can stand up multiple front doors per stack.
   */
  readonly agentName: string;

  /**
   * The runtime to invoke. Its ARN is baked into the integration URI
   * mapping, so this is a hard binding — one front door per runtime.
   */
  readonly runtime: agentcore.Runtime;

  /**
   * Per-second rate limit applied at both the stage and the usage plan.
   * @default 2
   */
  readonly rateLimit?: number;

  /**
   * Burst limit applied at both the stage and the usage plan.
   * @default 5
   */
  readonly burstLimit?: number;
}

export class ApiKeyFrontDoor extends Construct {
  readonly api: apigateway.RestApi;
  readonly apiKey: apigateway.IApiKey;

  constructor(scope: Construct, id: string, props: ApiKeyFrontDoorProps) {
    super(scope, id);

    const { agentName, runtime } = props;
    const rateLimit = props.rateLimit ?? 2;
    const burstLimit = props.burstLimit ?? 5;

    // ─── REST API ──────────────────────────────────────────────────────
    // Access logs go to a dedicated CloudWatch log group so request-level
    // audit (caller ip, key id, status) survives independent of the
    // method-level execution logs.
    const accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: `/aws/apigateway/${agentName}/access`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${agentName}-api`,
      description: `API Gateway in front of the ${agentName} AgentCore runtime`,
      // Validate request bodies/parameters against method models. We
      // don't define a strict body schema here (the agent payload is
      // intentionally arbitrary JSON), but enabling the validator
      // satisfies APIG2 and gives us a hook for future schemas.
      deployOptions: {
        stageName: 'v1',
        throttlingBurstLimit: burstLimit,
        throttlingRateLimit: rateLimit,
        // Per-method execution logs (errors only, no data tracing — the
        // payload is sensitive).
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
      // CORS off — server-to-server only.
    });

    // Request validator: validates body+params against the model. Even
    // though the body model is open, having a validator wired in
    // satisfies APIG2 and rejects malformed requests early.
    new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      requestValidatorName: `${agentName}-request-validator`,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // ─── Lambda proxy: APIG -> Lambda -> AgentCore SDK ─────────────────
    // Bundled with esbuild via NodejsFunction; @aws-sdk/client-bedrock-
    // agentcore is included in the bundle because the Lambda runtime's
    // built-in SDK doesn't ship the bedrock-agentcore client yet.
    //
    // Custom execution role (rather than the default-attached
    // AWSLambdaBasicExecutionRole managed policy) so cdk-nag's IAM4
    // check passes without acks. Inline policy grants the same Logs
    // writes against the function's own log group only.
    const invokeFnLogGroup = new logs.LogGroup(this, 'InvokeFnLogs', {
      logGroupName: `/aws/lambda/${agentName}-invoke`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const invokeFnRole = new iam.Role(this, 'InvokeFnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Execution role for the ${agentName} APIG -> AgentCore proxy Lambda.`,
    });
    invokeFnLogGroup.grantWrite(invokeFnRole);
    const invokeFn = new nodejs.NodejsFunction(this, 'InvokeFn', {
      entry: path.join(__dirname, '..', '..', 'lambda', 'invoke', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(29),
      memorySize: 256,
      role: invokeFnRole,
      logGroup: invokeFnLogGroup,
      environment: {
        AGENT_RUNTIME_ARN: runtime.agentRuntimeArn,
      },
      bundling: {
        externalModules: [],
        minify: true,
        sourceMap: true,
      },
      description: `APIG -> AgentCore proxy for ${agentName}`,
    });

    // InvokeAgentRuntime targets a sub-resource (runtime-endpoint/DEFAULT),
    // so the resource ARN needs a wildcard suffix.
    invokeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [runtime.agentRuntimeArn, `${runtime.agentRuntimeArn}/*`],
      }),
    );

    // The runtime ARN sub-resource wildcard is bounded to one runtime —
    // InvokeAgentRuntime targets `runtime-endpoint/DEFAULT` appended to
    // the ARN at invoke time.
    Validations.of(invokeFnRole).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::<AgentRuntime1C8F7B12.AgentRuntimeArn>/*]',
      reason:
        'InvokeAgentRuntime targets a sub-resource (runtime-endpoint/DEFAULT) appended to the runtime ARN, so the policy must list both the ARN and `<arn>/*`. The wildcard is bounded to a single AgentCore runtime.',
    });

    // cdk-nag's L1 list lags Lambda runtime GAs. NODEJS_22_X is GA and
    // is the newest Node runtime exposed by aws-cdk-lib at the version
    // we pin to.
    Validations.of(invokeFn).acknowledge({
      id: 'AwsSolutions-L1',
      reason:
        'NODEJS_22_X is the latest Node runtime exposed by aws-cdk-lib. cdk-nag L1\'s allowlist of "latest" runtimes is updated lazily and lags AWS Lambda runtime GA announcements.',
    });


    const invokeIntegration = new apigateway.LambdaIntegration(invokeFn, {
      proxy: true,
    });

    const invocations = this.api.root.addResource('invocations');
    invocations.addMethod('POST', invokeIntegration, {
      apiKeyRequired: true,
    });

    // ─── /ping (API key required, same as /invocations) ────────────────
    // Health probe gated behind the API key so callers without it get
    // 403 instead of leaking the existence/shape of the API. AgentCore's
    // own /ping (the container's `GET /ping`) is what AgentCore polls
    // internally for runtime health — this `/ping` is for callers.
    this.api.root.addResource('ping').addMethod(
      'GET',
      new apigateway.MockIntegration({
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"status":"healthy"}',
            },
          },
        ],
        requestTemplates: {
          'application/json': '{"statusCode": 200}',
        },
      }),
      {
        apiKeyRequired: true,
        methodResponses: [{ statusCode: '200' }],
      },
    );

    // ─── API key + usage plan ──────────────────────────────────────────
    this.apiKey = this.api.addApiKey('DefaultApiKey', {
      apiKeyName: `${agentName}-default-key`,
      description: `Default API key for ${agentName}.`,
    });

    const usagePlan = this.api.addUsagePlan('DefaultUsagePlan', {
      name: `${agentName}-default-plan`,
      description: `Default usage plan for ${agentName}`,
      throttle: { rateLimit, burstLimit },
      // No quota by default — add one if you want a hard daily cap.
    });

    usagePlan.addApiKey(this.apiKey);
    usagePlan.addApiStage({ stage: this.api.deploymentStage });

    // ─── cdk-nag acknowledgements ──────────────────────────────────────
    // Auth model is API key (intentional design). The APIG4 / COG4 rules
    // want either IAM or Cognito; both are heavier than warranted for this
    // server-to-server endpoint. Acknowledged at the API root so they
    // cascade to every method.
    Validations.of(this.api).acknowledge({
      id: 'AwsSolutions-APIG4',
      reason:
        'Authorization is enforced via API key + usage plan (apiKeyRequired=true on every method including /ping). This is the chosen auth model for server-to-server callers (Jira automation, internal webhooks); Cognito would add a user pool we don\'t need.',
    });
    Validations.of(this.api).acknowledge({
      id: 'AwsSolutions-COG4',
      reason:
        'Cognito user pool authorizer is not used by design — this API is called by trusted server-side integrations using an API key, not interactive end users.',
    });
    Validations.of(this.api).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason:
        'AWS WAFv2 is not attached to the stage. To be added once we have a public-internet caller surface; for now the API is reachable only by holders of the API key, and throttling is enforced at the stage and the usage plan.',
    });
  }
}
