import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@openzhiyu/ai/agent/types';
import type { AgentRuntime, AgentRuntimeRequest } from '@openzhiyu/ai/agent/runtime/types';
import type { Workshop } from '@/lib/db/schema';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';

const fixture = vi.hoisted(() => ({
  runtime: null as AgentRuntime | null,
  messages: [] as AgentMessage[],
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/ai/runtime/agent-factory', () => ({ createAgentRuntime: vi.fn(() => ({
  get metadata() { return fixture.runtime!.metadata; },
  async *run(request: AgentRuntimeRequest) {
    for await (const message of fixture.runtime!.run(request)) {
      fixture.messages.push(message);
      yield message;
    }
  },
})) }));
vi.mock('@/lib/workshops/workspace', () => ({
  prepareWorkspace: vi.fn(async () => ({ runDir: 'D:/zhiyu/.tmp/host-error-propagation-fixture' })),
  workspacePrompt: vi.fn(() => 'Local fixture workspace.'),
}));
vi.mock('@/lib/db/insight-queries', () => ({ getUserInsightSettings: vi.fn(async () => ({})) }));
vi.mock('@/lib/db/user-queries', () => ({ getUserTypeForService: vi.fn(async () => 'internal') }));
vi.mock('@/lib/ai/user-llm-api-settings', () => ({ getUserLlmProviderConfig: vi.fn(async () => ({
  apiKey: 'local-fixture', baseUrl: 'http://localhost/fixture', model: 'qwen3.7-plus',
})) }));
vi.mock('@/lib/brain/service', () => ({ buildBrainContextFromMemoryRequest: vi.fn(async () => { throw Error('No fixture memory context'); }) }));
vi.mock('@/lib/workshops/mcp-tools', () => ({ createWorkshopMcpServer: vi.fn(() => ({})) }));
vi.mock('@/lib/workshops/pi-domain-tools', () => ({ createWorkshopPiTools: vi.fn(() => []) }));
vi.mock('@/lib/work-runtime/runtime-snapshot', () => ({ persistWorkRunRuntimeSnapshot: vi.fn(async () => undefined) }));
vi.mock('@/lib/workshops/service', () => ({
  appendWorkshopEvent: vi.fn(async (event: Record<string, unknown>) => {
    fixture.events.push(event);
    return { ...event, id: `fixture-event-${fixture.events.length}` };
  }),
  listWorkshopEvents: vi.fn(async () => []),
}));

import { executeWorkshopAgent } from '@/lib/workshops/executor';
import { createWorkshopRuntimeFinalOutput } from '@/lib/workshops/runtime-final-output';

function workshop(): Workshop {
  return {
    id: 'fixture-work', userId: 'fixture-owner', name: 'Fixture Work', mission: 'Produce a source-backed report.',
    status: 'active', autonomyLevel: 'auto', boundaryPolicy: {},
    modelConfig: { agentRuntimeEngine: 'pi', allowedTools: ['webReadPage'], researchEvidenceContract: {
      version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1',
      requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }],
    } },
    createdAt: new Date('2026-10-09'), updatedAt: new Date('2026-10-09'),
  } as Workshop;
}

beforeEach(() => {
  fixture.runtime = null;
  fixture.messages = [];
  fixture.events = [];
  vi.clearAllMocks();
});

describe('actual SDK host failure through Workshop final response consumption', () => {
  it('preserves the original 31st-request hard budget reason in every failure surface', async () => {
    const faux = createFauxCore({});
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'local read receipt' }], details: {} }));
    const tool: AgentTool = { name: 'webReadPage', label: 'read', description: 'local read', parameters: Type.Object({}), execute };
    const streamFn = vi.fn<StreamFn>(async (...args) => faux.streamSimple(...args));
    fixture.runtime = createPiAgentRuntime({ adapter: 'harness', model: { ...faux.getModel(), maxTokens: 100 },
      streamFn, tools: [tool], streamOptions: { timeoutMs: 120_000 } });
    faux.setResponses(Array.from({ length: 31 }, () => fauxAssistantMessage(fauxToolCall('webReadPage', {}), { stopReason: 'toolUse' })));

    const result = await executeWorkshopAgent({ userId: 'fixture-owner', workshop: workshop(), runId: 'fixture-run',
      sources: [], memories: [], directives: [], events: [], outbox: [] });
    const reason = 'Research tool budget exhausted: 31/30';
    const terminal = fixture.messages.find(message => message.type === 'runtime_terminal')?.runtimeTerminal;
    const collector = createWorkshopRuntimeFinalOutput(fixture.runtime.metadata);
    fixture.messages.forEach(message => collector.observe(message));

    expect(terminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed', error: reason });
    expect.soft(fixture.messages.filter(message => message.type === 'error').map(message => message.message)).toEqual([reason]);
    expect.soft(collector.finish()).toMatchObject({ ok: false, error: reason, text: '' });
    expect.soft(result).toMatchObject({ status: 'error', error: reason, output: reason, structured: null });
    expect.soft(fixture.events.find(event => event.type === 'agent_final_output_rejected')).toMatchObject({ metadata: { error: reason } });
    expect(execute).toHaveBeenCalledTimes(30);
    expect(streamFn).toHaveBeenCalledTimes(31);
    expect(fixture.events.filter(event => event.type === 'research_tool_admitted')).toHaveLength(30);
    expect(fixture.events.filter(event => event.type === 'agent_final_output')).toHaveLength(0);
    expect(fixture.messages.filter(message => message.answerPhase === 'candidate_final')).toHaveLength(0);
    expect(fixture.messages.at(-1)?.type).toBe('done');
  });

  it.each(['lease_lost', 'Recorded source dependency is stale'])('preserves the original host fence error %s', async reason => {
    const faux = createFauxCore({});
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not execute' }], details: {} }));
    const runtime = createPiAgentRuntime({ adapter: 'harness', model: faux.getModel(),
      streamFn: async (...args) => faux.streamSimple(...args),
      tools: [{ name: 'webReadPage', label: 'read', description: 'local read', parameters: Type.Object({}), execute }] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall('webReadPage', {}), { stopReason: 'toolUse' })]);
    const messages: AgentMessage[] = [];
    for await (const message of runtime.run({ operation: 'run', prompt: 'local read', options: {
      onBeforeToolUse: async () => { throw Error(reason); },
    } })) messages.push(message);
    const collector = createWorkshopRuntimeFinalOutput(runtime.metadata);
    messages.forEach(message => collector.observe(message));

    expect(messages.filter(message => message.type === 'error').map(message => message.message)).toEqual([reason]);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed', error: reason });
    expect(collector.finish()).toMatchObject({ ok: false, error: reason, text: '' });
    expect(execute).not.toHaveBeenCalled();
    expect(messages.filter(message => message.answerPhase === 'candidate_final')).toHaveLength(0);
  });

  it('keeps a real user cancellation aborted without inventing a host failure', async () => {
    const faux = createFauxCore({});
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not execute' }], details: {} }));
    const runtime = createPiAgentRuntime({ adapter: 'harness', model: faux.getModel(),
      streamFn: async (...args) => faux.streamSimple(...args),
      tools: [{ name: 'webReadPage', label: 'read', description: 'local read', parameters: Type.Object({}), execute }] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall('webReadPage', {}), { stopReason: 'toolUse' })]);
    const abortController = new AbortController();
    const messages: AgentMessage[] = [];
    for await (const message of runtime.run({ operation: 'run', prompt: 'local read', options: {
      abortController, onBeforeToolUse: async () => { abortController.abort(); },
    } })) messages.push(message);

    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'aborted', cleanupStatus: 'completed' });
    expect(execute).not.toHaveBeenCalled();
    expect(messages.filter(message => message.answerPhase === 'candidate_final')).toHaveLength(0);
    expect(messages.at(-1)?.type).toBe('done');
  });
});
