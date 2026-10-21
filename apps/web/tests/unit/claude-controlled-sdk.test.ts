import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import type { AgentConfig, AgentOptions } from '@openzhiyu/ai/agent/types';
const fixture = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), transportClose: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: fixture.query }));
vi.mock('@/lib/ai/extensions/agent/claude/guarded-transport', async original => {
  const actual = await original<typeof import('@/lib/ai/extensions/agent/claude/guarded-transport')>();
  return { ...actual, createControlledClaudeTransport: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1', token: 'synthetic-run-token', rejected: false, close: fixture.transportClose })) };
});
import { controlledClaudeQuery } from '@/lib/ai/extensions/agent/claude/controlled-sdk';
import { createControlledClaudeTransport } from '@/lib/ai/extensions/agent/claude/guarded-transport';
const config: AgentConfig = { provider: 'claude', model: 'synthetic', apiKey: 'real-provider-secret', baseUrl: 'https://synthetic.invalid' };
const options = (): AgentOptions => ({ onBeforeProviderRequest: vi.fn(async () => undefined), runtimeTools: [], onRuntimeSelected: vi.fn() });
async function collect(input: Parameters<typeof controlledClaudeQuery>[0]) { const result = []; for await (const message of controlledClaudeQuery(input)) result.push(message); return result; }
beforeEach(() => {
  vi.clearAllMocks(); fixture.query.mockImplementation(() => Object.assign((async function* () { yield { type: 'result', subtype: 'success', is_error: false }; })(), { close: fixture.close }));
});
afterEach(() => vi.unstubAllEnvs());
describe('controlled Claude SDK isolation options', () => {
  it('uses the shared official Go endpoint for the observed Qwen model without changing custom proxies', async () => {
    await collect({ config: { ...config, model: 'qwen3.7-plus', baseUrl: 'https://opencode.ai/zen/go/v1' }, prompt: 'synthetic', options: options() });
    expect(vi.mocked(createControlledClaudeTransport).mock.calls.at(-1)?.[0].upstream).toBe('https://opencode.ai/inference/go/anthropic');
    await collect({ config: { ...config, model: 'qwen3.7-plus', baseUrl: 'https://custom.invalid/zen/go/v1' }, prompt: 'synthetic', options: options() });
    expect(vi.mocked(createControlledClaudeTransport).mock.calls.at(-1)?.[0].upstream).toBe('https://custom.invalid/zen/go/v1');
  });
  it('requires an actual host guard, explicit host tool list and supported protocol', async () => {
    for (const input of [ { config, options: {} }, { config, options: { onBeforeProviderRequest: async () => undefined } },
      { config: { ...config, providerConfig: { protocol: 'bedrock' } }, options: options() }, { config: { ...config, apiKey: undefined }, options: options() } ]) {
      await expect(collect({ ...input, prompt: 'synthetic' })).rejects.toMatchObject({ code: 'memory_source_runtime_unsupported' });
    }
    expect(fixture.query).not.toHaveBeenCalled();
  });
  it('cannot register a filesystem or shell builtin as a host tool', async () => {
    for (const name of ['Read', 'Bash', 'Task', 'Skill']) {
      await expect(collect({ config, prompt: 'synthetic', options: { ...options(), runtimeTools: [{ name, label: name, description: name,
        parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] } })).rejects.toMatchObject({ code: 'memory_source_tool_unsupported' });
    }
    expect(fixture.query).not.toHaveBeenCalled();
  });
  it('isolates settings, tools, environment and old sessions while binding the real adapter', async () => {
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1'); vi.stubEnv('HTTPS_PROXY', 'https://untrusted-proxy.invalid');
    const selected = vi.fn();
    await collect({ config, prompt: 'synthetic', options: { ...options(), sessionId: 'old-session', cwd: 'C:/synthetic-private-workspace',
      customMcpServers: { forbidden: { command: 'synthetic' } }, onRuntimeSelected: selected } });
    const sdk = fixture.query.mock.calls[0]![0].options;
    expect(sdk).toMatchObject({ tools: [], settingSources: [], agents: {}, plugins: [], persistSession: false, strictMcpConfig: true, permissionMode: 'dontAsk', mcpServers: {} });
    expect(sdk.resume).toBeUndefined(); expect(sdk.sessionId).toBeUndefined(); expect(sdk.cwd).not.toContain('synthetic-private-workspace');
    expect(sdk.env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK'); expect(sdk.env).not.toHaveProperty('HTTPS_PROXY');
    expect(sdk.env.ANTHROPIC_API_KEY).toBe('synthetic-run-token'); expect(JSON.stringify(sdk)).not.toContain('real-provider-secret');
    expect(selected).toHaveBeenCalledWith({ engine: 'claude', adapter: 'claude-sdk-controlled-http', version: '1.0.0' });
    expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.transportClose).toHaveBeenCalledOnce();
  });
  it('keeps the plan phase tool-free and closes transport on SDK failure', async () => {
    fixture.query.mockImplementation(() => Object.assign((async function* () { throw Error('synthetic failure'); yield; })(), { close: fixture.close }));
    await expect(collect({ config, prompt: 'synthetic', plan: true, options: { ...options(), runtimeTools: [{ name: 'managedRead', label: 'Managed read',
      description: 'synthetic', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] } })).rejects.toThrow('synthetic failure');
    expect(fixture.query.mock.calls[0]![0].options.allowedTools).toEqual([]);
    expect(fixture.transportClose).toHaveBeenCalledOnce(); expect(fixture.close).toHaveBeenCalledOnce();
  });
});
