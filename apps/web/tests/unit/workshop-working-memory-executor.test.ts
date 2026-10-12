import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOptions } from '@openzhiyu/ai/agent/types';
import type { AgentRuntimeRequest } from '@openzhiyu/ai/agent/runtime/types';
import type { HostWorkingMemoryAuditEvent, HostWorkingMemoryProjectionEvent, HostWorkingMemoryRejectedEvent } from '@openzhiyu/ai/agent/runtime';
import type { Workshop } from '@/lib/db/schema';

const fixture = vi.hoisted(() => ({
  adapter: 'pi-agent-harness',
  options: null as AgentOptions | null,
  registeredToolNames: ['webReadPage', 'workshopReadMemory'],
  events: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  guardCount: 0,
  guardThrowsAt: 0,
  failEventType: '',
  writeGate: null as { promise: Promise<void>; started: () => void } | null,
  toolRequests: 0,
  dispatchedTools: 0,
}));

vi.mock('@/lib/ai/runtime/agent-factory', () => ({ createAgentRuntime: vi.fn(() => ({
  metadata: { engine: 'pi', adapter: fixture.adapter, version: 'local-fixture' },
  async *run(request: AgentRuntimeRequest) {
    fixture.options = request.options ?? null;
    for (let index = 0; index < fixture.toolRequests; index += 1) {
      await request.options?.onBeforeToolUse?.({ toolUseId: `memory-${index}`, toolName: 'workingMemory', input: { operation: 'read' } });
      fixture.dispatchedTools += 1;
    }
    yield { type: 'result', content: '{"summary":"Local fixture result"}', answerPhase: 'candidate_final' };
    yield { type: 'runtime_terminal', runtimeTerminal: { schemaVersion: 'agent-runtime-terminal.v1',
      status: 'completed', cleanupStatus: 'completed', completionScope: 'runtime' } };
    yield { type: 'done' };
  },
})) }));
vi.mock('@/lib/work-runtime/execution-guard', () => ({ createExecutionGuard: vi.fn(() => async () => {
  fixture.order.push('guard');
  fixture.guardCount += 1;
  if (fixture.guardThrowsAt === fixture.guardCount) throw Error('lease_lost');
}) }));
vi.mock('@/lib/db/client', () => ({ db: {} }));
vi.mock('@/lib/workshops/workspace', () => ({
  prepareWorkspace: vi.fn(async () => ({ runDir: 'D:/zhiyu/.tmp/working-memory-executor-fixture' })),
  workspacePrompt: vi.fn(() => 'Local fixture workspace.'),
}));
vi.mock('@/lib/db/insight-queries', () => ({ getUserInsightSettings: vi.fn(async () => ({})) }));
vi.mock('@/lib/db/user-queries', () => ({ getUserTypeForService: vi.fn(async () => 'internal') }));
vi.mock('@/lib/ai/user-llm-api-settings', () => ({ getUserLlmProviderConfig: vi.fn(async () => ({
  apiKey: 'local-fixture', baseUrl: 'http://localhost/fixture', model: 'qwen3.7-plus',
})) }));
vi.mock('@/lib/brain/service', () => ({ buildBrainContextFromMemoryRequest: vi.fn(async () => { throw Error('No fixture memory context'); }) }));
vi.mock('@/lib/workshops/mcp-tools', () => ({ createWorkshopMcpServer: vi.fn(() => ({})) }));
vi.mock('@/lib/workshops/pi-domain-tools', () => ({ createWorkshopPiTools: vi.fn(() => fixture.registeredToolNames.map(name => ({ name }))) }));
vi.mock('@/lib/work-runtime/runtime-snapshot', () => ({ persistWorkRunRuntimeSnapshot: vi.fn(async () => undefined) }));
vi.mock('@/lib/workshops/service', () => ({
  appendWorkshopEvent: vi.fn(async (event: Record<string, unknown>) => {
    if (String(event.type).startsWith('working_memory_')) {
      fixture.order.push(`write:${event.type}`);
      if (fixture.writeGate) { fixture.writeGate.started(); await fixture.writeGate.promise; }
      if (fixture.failEventType === event.type) throw Error('event storage unavailable');
    }
    fixture.events.push(event);
    return { ...event, id: `fixture-event-${fixture.events.length}` };
  }),
  listWorkshopEvents: vi.fn(async () => []),
}));

import { executeWorkshopAgent } from '@/lib/workshops/executor';
import { persistWorkRunRuntimeSnapshot } from '@/lib/work-runtime/runtime-snapshot';
import { sha256Hex } from '@/lib/ai/runtime/run-snapshot';

const contract = { version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1',
  requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }] };
const lease = { userId: 'fixture-owner', workshopId: 'fixture-work', runId: 'fixture-run', workerId: 'fixture-worker', token: 1 };

function workshop(config: Record<string, unknown> = {}, boundaryPolicy: Record<string, unknown> = {}): Workshop {
  return { id: lease.workshopId, userId: lease.userId, name: 'Fixture Work', mission: 'Study current primary source evidence.',
    status: 'active', autonomyLevel: 'auto', boundaryPolicy,
    modelConfig: { agentRuntimeEngine: 'pi', allowedTools: ['webReadPage', 'workingMemory'], researchEvidenceContract: contract, ...config },
    createdAt: new Date('2026-10-09'), updatedAt: new Date('2026-10-09') } as Workshop;
}

async function execute(config: Record<string, unknown> = {}, boundaryPolicy: Record<string, unknown> = {}) {
  return executeWorkshopAgent({ userId: lease.userId, workshop: workshop(config, boundaryPolicy), runId: lease.runId,
    sources: [], memories: [], directives: [], events: [], outbox: [], executionLease: lease });
}

const audit: HostWorkingMemoryAuditEvent = {
  schemaVersion: 'host-working-memory.v1', status: 'ready_for_projection', operation: 'update', mode: 'apply',
  commandId: 'edit-1', previousVersion: 0, version: 1, editCount: 1,
  pruneToolCallIds: ['read-1'], actionPruneToolCallIds: ['read-1'], restoredToolCallIds: [],
  state: { facts: [{ text: 'A source-referenced note, still unverified.', evidenceIds: ['read-1'] }],
    hypotheses: [], openQuestions: [], nextAction: { text: 'Compare sources.', evidenceIds: ['read-1'] } },
};
const projection: HostWorkingMemoryProjectionEvent = {
  schemaVersion: 'host-working-memory.v1', status: 'provider_request_prepared', mode: 'apply', version: 1,
  pruneToolCallIds: ['read-1'], originalMessageCount: 6, projectedMessageCount: 4, originalChars: 5000, projectedChars: 1000,
};
const rejection: HostWorkingMemoryRejectedEvent = {
  schemaVersion: 'host-working-memory.v1', operation: 'update', mode: 'apply', version: 0,
  commandId: 'edit-1', code: 'unknown_evidence', detail: 'Evidence ID is not host-owned.',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'apply');
  vi.stubEnv('WORKSHOP_MAX_TOOL_CALLS', '30');
  fixture.adapter = 'pi-agent-harness'; fixture.options = null;
  fixture.registeredToolNames = ['webReadPage', 'workshopReadMemory'];
  fixture.events = []; fixture.order = []; fixture.guardCount = 0; fixture.guardThrowsAt = 0;
  fixture.failEventType = ''; fixture.writeGate = null; fixture.toolRequests = 0; fixture.dispatchedTools = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe('Workshop working memory executor wiring', () => {
  it('admits the intrinsic tool only for the loaded Harness research contract and records it in the runtime identity', async () => {
    await execute();
    expect(fixture.options?.hostWorkingMemory).toMatchObject({ mode: 'apply', readonlyToolNames: ['webReadPage'], maxEdits: 4, maxSummaryChars: 6000 });
    expect(fixture.options?.allowedTools).toEqual(['webReadPage', 'workshopReadMemory', 'workingMemory']);
    const configured = fixture.events.find(event => event.type === 'agent_configured');
    const snapshot = (configured?.metadata as { runtimeRunSnapshot: { allowedToolsHash: string; allowedToolCount: number; extra: unknown } }).runtimeRunSnapshot;
    expect(snapshot.allowedToolCount).toBe(3);
    expect(snapshot.allowedToolsHash).toBe(sha256Hex(['webReadPage', 'workingMemory', 'workshopReadMemory'].sort()));
    expect(snapshot.extra).toMatchObject({ runtimeIntrinsicTools: ['workingMemory'],
      workingMemoryPolicy: { enabled: true, mode: 'apply', semanticStatus: 'not_independently_verified' } });
    expect(persistWorkRunRuntimeSnapshot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ snapshot }));
  });

  it('keeps off, unrelated contract runs, legacy adapters and unregistered reads outside admission', async () => {
    const cases = [
      () => { vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'off'); return {}; },
      () => ({ researchEvidenceContract: { ...contract, taskKeywords: ['unrelated'] } }),
      () => { fixture.adapter = 'pi-agent-core'; return {}; },
      () => { fixture.registeredToolNames = ['workshopReadMemory']; return {}; },
    ];
    for (const setup of cases) {
      fixture.adapter = 'pi-agent-harness'; fixture.registeredToolNames = ['webReadPage', 'workshopReadMemory'];
      vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'apply');
      await execute(setup());
      expect(fixture.options?.hostWorkingMemory).toBeUndefined();
      expect(fixture.options?.allowedTools).not.toContain('workingMemory');
    }
  });

  it('gives owner denials and approval requirements priority over an explicit allow declaration', async () => {
    for (const config of [
      { disallowedTools: ['mcp__host__workingMemory'] },
      { requiresApprovalTools: ['workingMemory'] },
      { requiresApprovalTools: ['webReadPage'] },
    ]) {
      await execute(config);
      expect(fixture.options?.hostWorkingMemory).toBeUndefined();
      expect(fixture.options?.allowedTools).not.toContain('workingMemory');
    }
    await execute({}, { hardDeniedActions: ['workingMemory'], deniedPrecedence: true });
    expect(fixture.options?.hostWorkingMemory).toBeUndefined();
    expect(fixture.options?.allowedTools).not.toContain('workingMemory');
  });

  it('awaits update, projection, rejection and restore writes with the execution guard before and after each receipt', async () => {
    await execute();
    const policy = fixture.options!.hostWorkingMemory!;
    const calls = [
      { type: 'working_memory_updated', invoke: () => policy.onAudit(audit) },
      { type: 'working_memory_projected', invoke: () => policy.onProjection!(projection) },
      { type: 'working_memory_rejected', invoke: () => policy.onRejected!(rejection) },
      { type: 'working_memory_restored', invoke: () => policy.onAudit({ ...audit, operation: 'restore', version: 2,
        previousVersion: 1, pruneToolCallIds: [], actionPruneToolCallIds: [], restoredToolCallIds: ['read-1'] }) },
    ];
    for (const call of calls) {
      fixture.order = []; fixture.guardCount = 0;
      let release!: () => void, started!: () => void, settled = false;
      const ready = new Promise<void>(resolve => { started = resolve; });
      fixture.writeGate = { promise: new Promise<void>(resolve => { release = resolve; }), started };
      const pending = Promise.resolve(call.invoke()).then(() => { settled = true; });
      await ready;
      expect(settled).toBe(false);
      expect(fixture.order).toEqual(['guard', `write:${call.type}`]);
      release(); await pending;
      expect(fixture.order).toEqual(['guard', `write:${call.type}`, 'guard']);
      const event = fixture.events.findLast(entry => entry.type === call.type);
      expect(event).toMatchObject({ workshopId: lease.workshopId, runId: lease.runId, metadata: { receiptAuthority: 'runtime' } });
    }
    expect(fixture.events.find(event => event.type === 'working_memory_updated')).toMatchObject({
      metadata: { status: 'ready_for_projection', semanticStatus: 'not_independently_verified', recoveryScope: 'same_run_original_transcript' } });
    expect(fixture.events.find(event => event.type === 'working_memory_projected')).toMatchObject({ metadata: projection });
    expect(fixture.events.find(event => event.type === 'working_memory_rejected')).toMatchObject({
      metadata: { code: 'unknown_evidence', reason: 'unknown_evidence', mode: 'apply' } });
  });

  it('propagates receipt storage failures and both execution guard failures without reporting a saved state', async () => {
    await execute();
    const policy = fixture.options!.hostWorkingMemory!;
    for (const call of [
      { type: 'working_memory_updated', invoke: () => policy.onAudit(audit) },
      { type: 'working_memory_projected', invoke: () => policy.onProjection!(projection) },
      { type: 'working_memory_rejected', invoke: () => policy.onRejected!(rejection) },
    ]) {
      fixture.order = []; fixture.guardCount = 0; fixture.failEventType = call.type;
      const before = fixture.events.length;
      await expect(call.invoke()).rejects.toThrow('event storage unavailable');
      expect(fixture.events).toHaveLength(before);
      expect(fixture.order).toEqual(['guard', `write:${call.type}`]);
      fixture.failEventType = '';
      fixture.order = []; fixture.guardCount = 0; fixture.guardThrowsAt = 1;
      await expect(call.invoke()).rejects.toThrow('lease_lost');
      expect(fixture.order).toEqual(['guard']);
      fixture.order = []; fixture.guardCount = 0; fixture.guardThrowsAt = 2;
      await expect(call.invoke()).rejects.toThrow('lease_lost');
      expect(fixture.order).toEqual(['guard', `write:${call.type}`, 'guard']);
      fixture.guardThrowsAt = 0;
    }
  });

  it('charges working memory calls to the existing research tool budget before dispatch', async () => {
    vi.stubEnv('WORKSHOP_MAX_TOOL_CALLS', '2');
    fixture.toolRequests = 3;
    const result = await execute();
    expect(result).toMatchObject({ status: 'error', error: 'Research tool budget exhausted: 3/2', structured: null });
    expect(fixture.dispatchedTools).toBe(2);
    expect(fixture.events.filter(event => event.type === 'research_tool_admitted')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ toolName: 'workingMemory', toolCallCount: 1, maxToolCalls: 2 }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ toolName: 'workingMemory', toolCallCount: 2, maxToolCalls: 2 }) }),
    ]);
    expect(fixture.events.some(event => event.type === 'agent_final_output')).toBe(false);
  });
});
