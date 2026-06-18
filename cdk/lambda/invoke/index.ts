/**
 * APIG -> Lambda -> AgentCore proxy.
 *
 * APIG doesn't support `bedrock-agentcore` as a direct AWS service
 * integration, so this Lambda calls `InvokeAgentRuntime` over the SDK
 * with the caller's request body as the payload. The container itself
 * returns 202-on-accept and runs the work in the background, so this
 * call returns in milliseconds.
 */
import { randomUUID } from 'crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN;
if (!RUNTIME_ARN) {
  throw new Error('AGENT_RUNTIME_ARN env var is required');
}

const client = new BedrockAgentCoreClient({});

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  // AgentCore requires runtimeSessionId >= 33 chars; UUID v4 is 36.
  const sessionId = randomUUID();

  // REST APIs always send a string body (or undefined). Pass it through
  // verbatim so the agent's server.py sees the exact JSON the caller
  // sent. If empty, send `{}` so AgentCore doesn't reject the call.
  const rawBody = event.body && event.body.length > 0 ? event.body : '{}';

  try {
    const result = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        runtimeSessionId: sessionId,
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(rawBody),
      }),
    );

    // Drain the AgentCore response body and pass it through. The agent
    // returns 202 + {task_id, ...} in the body; we forward both.
    let bodyText = '';
    if (result.response) {
      const reader = result.response as unknown as AsyncIterable<Uint8Array>;
      const decoder = new TextDecoder();
      for await (const chunk of reader) {
        bodyText += decoder.decode(chunk, { stream: true });
      }
      bodyText += decoder.decode();
    }

    return {
      statusCode: result.statusCode ?? 200,
      headers: {
        'content-type': result.contentType ?? 'application/json',
        'x-agentcore-session-id': sessionId,
      },
      body: bodyText,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'UnknownError';
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('InvokeAgentRuntime failed', { name, message, sessionId });
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: name, message }),
    };
  }
}
