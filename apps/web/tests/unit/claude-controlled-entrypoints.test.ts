import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentOptions } from '@openzhiyu/ai/agent/types';
const fixture = vi.hoisted(() => ({ query: vi.fn(), syncSkills: vi.fn() }));
vi.mock('@/lib/ai/extensions/agent/claude/controlled-sdk', () => ({ controlledClaudeQuery: fixture.query }));
vi.mock('@/lib/ai/skills/loader', () => ({ clearSkillsFromClaude: vi.fn(), syncSkillsToClaude: fixture.syncSkills }));
vi.mock('@/lib/ai/mcp', () => ({ loadMcpServers: vi.fn(), createBusinessToolsMcpServer: vi.fn() }));
vi.mock('@/lib/ai', () => ({ estimateTokens: (value: string) => value.length }));
vi.mock('@/lib/utils/logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }), LOG_FILE_PATH: 'synthetic-log' }));
import { createClaudeAgent } from '@/lib/ai/extensions/agent/claude';
const options = (): AgentOptions => ({ onBeforeProviderRequest: async () => undefined, runtimeTools: [] });
async function collect(generator: AsyncGenerator<AgentMessage>) { const messages = []; for await (const message of generator) messages.push(message); return messages; }
beforeEach(() => { vi.clearAllMocks(); fixture.query.mockImplementation(async function* () {
  yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"type":"plan","goal":"Read managed sources","steps":[{"id":"read","description":"Read the approved managed source"}]}' }] } };
  yield { type: 'result', subtype: 'success', is_error: false };
}); });
describe('actual Claude public entrypoints use controlled SDK before legacy preparation', () => {
  it('runs the controlled branch without synchronizing skills or creating legacy source files', async () => {
    const agent = createClaudeAgent({ provider: 'claude' });
    const output = await collect(agent.run('synthetic current request', options()));
    expect(fixture.query).toHaveBeenCalledOnce(); expect(fixture.query.mock.calls[0]![0].prompt).toBe('synthetic current request');
    expect(output.at(-2)).toMatchObject({ type: 'runtime_terminal', runtimeTerminal: { status: 'completed', cleanupStatus: 'completed' } });
    expect(fixture.syncSkills).not.toHaveBeenCalled();
  });
  it('generates a real structured plan through the controlled provider path', async () => {
    const agent = createClaudeAgent({ provider: 'claude' }); const output = await collect(agent.plan('synthetic current request', options()));
    expect(fixture.query.mock.calls[0]![0].plan).toBe(true); expect(output).toContainEqual(expect.objectContaining({ type: 'plan', plan: expect.objectContaining({ goal: 'Read managed sources' }) }));
    expect(fixture.syncSkills).not.toHaveBeenCalled();
  });
  it('executes only a host-supplied plan and never substitutes local cached plan text', async () => {
    const agent = createClaudeAgent({ provider: 'claude' });
    await expect(collect(agent.execute({ ...options(), planId: 'old-cache', originalPrompt: 'synthetic' }))).rejects.toMatchObject({ code: 'memory_plan_source_required' });
    const plan = { id: 'approved', goal: 'Approved controlled request', steps: [{ id: 'read', description: 'Read the approved managed source', status: 'pending' as const }], createdAt: new Date('2026-10-20T00:00:00Z') };
    await collect(agent.execute({ ...options(), planId: plan.id, plan, originalPrompt: 'source-checked prompt' }));
    expect(fixture.query.mock.calls[0]![0].prompt).toContain('Approved controlled request');
    expect(fixture.query.mock.calls[0]![0].prompt).toContain('source-checked prompt'); expect(fixture.syncSkills).not.toHaveBeenCalled();
  });
});
