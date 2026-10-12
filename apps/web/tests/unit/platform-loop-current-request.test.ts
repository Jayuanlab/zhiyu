import { describe, expect, it } from 'vitest';
import { getNativePiProviderCapabilityBlock } from '@/lib/ai/native-pi-provider-capabilities';

const actualComparisonRequest = {
  prompt: 'Observe the current synthetic Loop executor without actions.',
  provider: 'pi',
  sessionId: 'LOOP-CURRENT-fixture',
  chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-0000000002bd',
  clientRequestId: 'loop-current-fixture',
  userMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000321',
  assistantMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000385',
  allowedTools: ['time', 'platformRecall'],
  loopIdForGuard: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000191',
  modelConfig: { model: 'synthetic-provider-lock', thinkingLevel: 'disabled' },
  permissionMode: 'default',
  skillsConfig: { enabled: false, userDirEnabled: false, appDirEnabled: false },
  mcpConfig: { enabled: false, userDirEnabled: false, appDirEnabled: false },
};

describe('formal native Pi comparison request capability boundary', () => {
  it('accepts the complete comparison shape with default permission mode', () => {
    expect(getNativePiProviderCapabilityBlock(actualComparisonRequest)).toBeNull();
  });

  it('rejects the historical dontAsk request before runtime execution', () => {
    expect(getNativePiProviderCapabilityBlock({ ...actualComparisonRequest, permissionMode: 'dontAsk' }))
      .toMatchObject({ status: 400, unsupportedCapabilities: ['permission_mode'] });
  });

  it('retains rejection of requested unsupported tools with the accepted mode', () => {
    expect(getNativePiProviderCapabilityBlock({ ...actualComparisonRequest, allowedTools: ['time', 'platformRecall', 'Bash'] }))
      .toMatchObject({ status: 400, unsupportedCapabilities: ['tools:Bash'] });
  });

  it('retains MCP capability rejection with the accepted mode', () => {
    expect(getNativePiProviderCapabilityBlock({ ...actualComparisonRequest, mcpConfig: { enabled: true } }))
      .toMatchObject({ status: 400, unsupportedCapabilities: ['mcp'] });
  });
});
