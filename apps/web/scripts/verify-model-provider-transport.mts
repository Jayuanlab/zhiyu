/** Actual installed Pi serializers, AI SDK bridge, Harness and optional Web API. */
import assert from 'node:assert/strict';
import { generateText, streamText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';
import {
  createPiAgentRuntime,
  createPiRuntimeOptionsFromModelConfig,
  createPiLanguageModel,
} from '@openzhiyu/ai/agent/runtime';
import { createGuardedPiTool } from '../lib/ai/runtime/pi-tool-adapter.ts';
import { startModelProviderFixture } from './model-provider-fixture.mjs';

const fixture = await startModelProviderFixture();
const checks: string[] = [];
const protocols = [
  ['openai-completions', 'openai_compatible', '/chat/completions'],
  ['openai-responses', 'openai_responses', '/responses'],
  ['anthropic-messages', 'anthropic_compatible', '/messages'],
] as const;
try {
  for (const [protocol, storedProtocol, path] of protocols) {
    const config = {
      protocol,
      apiKey: 'local-fixture-key',
      baseUrl:
        protocol === 'anthropic-messages'
          ? fixture.baseUrl.replace(/\/v1$/, '')
          : fixture.baseUrl,
      model: 'text',
    };
    const model = createPiLanguageModel(config);
    const result = await generateText({
      model,
      prompt: 'Read configuration.',
      maxRetries: 0,
    });
    assert.equal(result.text, 'fixture-ok');
    assert.equal(result.finishReason, 'stop');
    const observed = fixture.observed.at(-1)!;
    assert.equal(observed.path, `/v1${path}`);
    assert.equal(
      protocol === 'anthropic-messages'
        ? observed.apiKey
        : observed.authorization,
      protocol === 'anthropic-messages'
        ? config.apiKey
        : `Bearer ${config.apiKey}`,
    );
    const streamed = streamText({
      model,
      prompt: 'Stream configuration.',
      maxRetries: 0,
    });
    let text = '';
    for await (const chunk of streamed.textStream) text += chunk;
    assert.equal(text, 'fixture-ok');
    assert.equal(await streamed.finishReason, 'stop');
    checks.push(`${protocol}:generate_and_stream_use_exact_endpoint_key_model`);
    let executions = 0;
    const runtime = createPiAgentRuntime({
      adapter: 'harness',
      ...createPiRuntimeOptionsFromModelConfig({ ...config, model: 'tool' }),
      tools: [
        {
          name: 'readConfigProbe',
          description: 'Read a local fixture.',
          parameters: Type.Object({}),
          execute: async () => {
            executions++;
            return {
              content: [{ type: 'text', text: 'probe-result' }],
              details: {},
            };
          },
        },
      ],
    });
    const messages = [];
    for await (const message of runtime.run({
      operation: 'run',
      prompt: 'Use the readConfigProbe tool exactly once.',
    }))
      messages.push(message);
    assert.equal(runtime.metadata.adapter, 'pi-agent-harness');
    assert.equal(executions, 1);
    assert.ok(
      messages.some(
        (message) =>
          message.type === 'result' && message.content === 'fixture-ok',
      ),
    );
    checks.push(`${protocol}:real_harness_tool_roundtrip`);
    let bridgeExecutions = 0;
    const bridge = await generateText({
      model: createPiLanguageModel({ ...config, model: 'tool' }),
      prompt: 'Read the fixture.',
      maxRetries: 0,
      stopWhen: stepCountIs(2),
      tools: {
        readConfigProbe: tool({
          description: 'Read fixture.',
          inputSchema: z.object({}),
          execute: async () => {
            bridgeExecutions++;
            return 'probe-result';
          },
        }),
      },
    });
    assert.equal(bridgeExecutions, 1);
    assert.equal(bridge.text, 'fixture-ok');
    checks.push(`${protocol}:ai_sdk_tool_roundtrip_uses_pi_serializer`);
    const deniedRuntime = createPiAgentRuntime({
      adapter: 'harness',
      ...createPiRuntimeOptionsFromModelConfig({ ...config, model: 'tool' }),
      tools: [
        createGuardedPiTool({
          name: 'readConfigProbe',
          description: 'Forbidden fixture.',
          parameters: Type.Object({}),
          policy: {
            allowedTools: ['readConfigProbe'],
            deniedTools: ['readConfigProbe'],
          },
          execute: async () => {
            executions++;
            return 'probe-result';
          },
        }),
      ],
    });
    const deniedMessages = [];
    for await (const message of deniedRuntime.run({
      operation: 'run',
      prompt: 'Try the forbidden tool.',
    }))
      deniedMessages.push(message);
    assert.equal(executions, 1);
    assert.ok(deniedMessages.some((message) => message.type === 'result'));
    checks.push(`${protocol}:denied_over_allowed_prevents_execution`);
    for (const mode of [
      'truncated',
      'missing-terminal',
      'bad-json',
      'reject',
    ]) {
      await assert.rejects(
        generateText({
          model: createPiLanguageModel({ ...config, model: mode }),
          prompt: 'Do not accept incomplete data.',
          maxRetries: 0,
        }),
      );
      checks.push(`${protocol}:${mode}_fails_explicitly`);
    }
    await assert.rejects(
      generateText({
        model: createPiLanguageModel({ ...config, model: 'delay' }),
        prompt: 'cancel',
        abortSignal: AbortSignal.timeout(250),
        maxRetries: 0,
      }),
    );
    checks.push(`${protocol}:abort_propagates`);
    if (process.env.MODEL_TEST_APP_URL) {
      const app = process.env.MODEL_TEST_APP_URL;
      const current = await (
        await fetch(`${app}/api/preferences/models`)
      ).json();
      for (const mode of ['text', 'truncated', 'bad-json']) {
        const response = await fetch(`${app}/api/preferences/models/test`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: new URL(app).origin,
          },
          body: JSON.stringify({
            revision: current.revision,
            connectionId: 'transport_fixture',
            draft: {
              id: 'transport_fixture',
              name: 'Transport fixture',
              protocol: storedProtocol,
              baseUrl: fixture.baseUrl,
              model: mode,
              enabled: true,
            },
            apiKey: config.apiKey,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.passed, mode === 'text');
        assert.equal(body.persisted, false);
        assert.ok(!JSON.stringify(body).includes(config.apiKey));
      }
      checks.push(
        `${protocol}:web_test_uses_same_serializer_and_rejects_false_success`,
      );
    }
  }
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await fixture.close();
}
