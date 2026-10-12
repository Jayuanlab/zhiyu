import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiRuntimeOptionsFromModelConfig, type PiModelProtocol } from '@openzhiyu/ai/agent/runtime/pi-model-config';
import { createPiStreamDiagnostics, observePiStreamFn } from '@openzhiyu/ai/agent/runtime/pi-stream-diagnostics';
import type { StreamFn } from '@earendil-works/pi-agent-core';

afterEach(() => vi.restoreAllMocks());

describe('actual Pi SDK generated request parameters without network', () => {
  it.each(['anthropic-messages', 'openai-responses', 'openai-completions'] as PiModelProtocol[])(
    'observes %s parameters after the inner cap while transport failure remains failure', async (protocol) => {
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network is forbidden in this SDK fixture'));
      const blockedTransport = vi.fn<typeof fetch>(async () => { throw new Error('Local transport fixture stopped before network'); });
      const configured = createPiRuntimeOptionsFromModelConfig({ protocol, model: 'offline-fixture',
        apiKey: 'offline-fixture-key', baseUrl: 'https://offline.invalid' });
      const controller = new AbortController(), recorder = createPiStreamDiagnostics(controller.signal);
      const capped: StreamFn = (model, context, options) => configured.streamFn({ ...model, maxTokens: 2200 }, context,
        { ...options, maxTokens: 2200, maxRetries: 0, fetch: blockedTransport });
      const output = observePiStreamFn(capped, controller.signal, recorder)(configured.model, {
        messages: [{ role: 'user', content: 'private SDK fixture', timestamp: 1 }], systemPrompt: 'private system fixture',
      });
      for await (const _event of output) { /* Actual SDK builds parameters; local transport rejects. */ }
      const result = await output.result(), invocation = recorder.snapshot()?.invocations[0];
      expect(network).not.toHaveBeenCalled();
      expect(blockedTransport).toHaveBeenCalledOnce();
      expect(invocation?.contextReceipt?.configuredMaxOutputTokens).toEqual({ value: null, source: 'unknown' });
      const fields = invocation?.sdkRequestParameters?.callbacks[0]?.tokenParameters;
      expect(fields).toHaveLength(1); expect(fields?.[0]?.value).toBe(2200);
      expect(protocol === 'anthropic-messages' ? ['max_tokens'] : protocol === 'openai-responses'
        ? ['max_output_tokens'] : ['max_tokens', 'max_completion_tokens']).toContain(fields?.[0]?.field);
      expect(invocation?.sdkRequestParameters).toMatchObject({ schemaVersion: 'pi-sdk-request-parameters.v1',
        source: 'sdk_request_parameters', state: 'observed', totalCallbacks: 1, omittedCallbacks: 0 });
      expect(result.stopReason).toBe('error'); expect(invocation?.stages.at(-1)?.outcome).toBe('failed');
      expect(JSON.stringify(invocation?.sdkRequestParameters)).not.toMatch(/private|offline|key|headers|messages|https:/);
    },
  );
});
