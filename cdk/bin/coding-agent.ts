#!/usr/bin/env node
import 'source-map-support/register';
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CodingAgentStack } from '../lib/stacks/coding-agent-stack';

const app = new App();

// cdk-nag — AWS Solutions ruleset. Registered as a synth-time validation
// plugin (cdk-nag v3+ uses Validations.of(app).addPlugins, not Aspects).
// Findings surface as `[Error at <path>]` and fail the build; warnings
// show as `[Warning at <path>]`.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));

// One stack per environment. The default name ("CodingAgent") is overridable
// via context (`cdk deploy -c stackName=CodingAgentDev`) so the same code can
// stand up dev/staging/prod copies side-by-side.
const stackName = app.node.tryGetContext('stackName') ?? 'CodingAgent';

new CodingAgentStack(app, stackName, {
  description:
    'Coding agent — Bedrock AgentCore Runtime fronted by API Gateway (API key auth). ' +
    'Stands up ECR repo, secrets, runtime, and the API. Application image is ' +
    'built and pushed by deploy.sh, not CDK.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
