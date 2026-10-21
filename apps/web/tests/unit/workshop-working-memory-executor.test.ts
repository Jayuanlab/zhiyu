vi.mock("@/lib/memory/sources/host-context", () => ({ admitHostSourceRows: vi.fn(async () => undefined) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOptions } from '@openzhiyu/ai/agent/types';
import type { AgentRuntimeRequest } from '@openzhiyu/ai/agent/runtime/types';
import type { HostWorkingMemoryAuditEvent, HostWorkingMemoryProjectionEvent, HostWorkingMemoryRejectedEvent, HostWorkingMemoryUsageEvent } from '@openzhiyu/ai/agent/runtime';
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
  prompt: '',
  continuity: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/ai/runtime/agent-factory', () => ({ createAgentRuntime: vi.fn(() => ({
  metadata: { engine: 'pi', adapter: fixture.adapter, version: 'local-fixture' },
  async *run(request: AgentRuntimeRequest) {
    fixture.options = request.options ?? null;
    fixture.prompt = request.operation === 'run' ? request.prompt : '';
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
vi.mock('@/lib/memory/retrieval/recall', () => ({ buildBrainContextFromMemoryRequest: vi.fn(async () => { throw Error('No fixture memory context'); }) }));
vi.mock('@/lib/memory/continuity/working-memory', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/memory/continuity/working-memory')>();
  return { ...actual, loadWorkingMemoryContinuity: vi.fn(async () => fixture.continuity ?? {
    schemaVersion: 'working-memory-continuity.v1', status: 'skipped', reason: 'no_scoped_predecessor', warnings: [], checkpoint: null,
  }) };
});
vi.mock('@/lib/workshops/mcp-tools', () => ({ createWorkshopMcpServer: vi.fn(() => ({})) }));
vi.mock('@/lib/workshops/pi-domain-tools', () => ({ createWorkshopPiTools: vi.fn(() => fixture.registeredToolNames.map(name => ({ name }))) }));
vi.mock('@/lib/memory/continuity/runtime-snapshot', () => ({ persistWorkRunRuntimeSnapshot: vi.fn(async () => undefined) }));
vi.mock('@/lib/workshops/service', () => ({
  appendWorkshopEvent: vi.fn(async (event: Record<string, unknown>) => {
    if (String(event.type).startsWith('working_memory_') || event.type === 'provider_transport_attempt') {
      fixture.order.push(`write:${event.type}`);
      if (fixture.writeGate) { fixture.writeGate.started(); await fixture.writeGate.promise; }
      if (fixture.failEventType === event.type) throw Error('event storage unavailable');
    }
    fixture.events.push(event);
    return { ...event, id: `fixture-event-${fixture.events.length}`, seq: fixture.events.length,
      createdAt: new Date('2026-10-18T00:00:00.000Z') };
  }),
  listWorkshopEvents: vi.fn(async () => []),
}));

import { executeWorkshopAgent } from '@/lib/workshops/executor';
import { persistWorkRunRuntimeSnapshot } from '@/lib/memory/continuity/runtime-snapshot';
import { sha256Hex } from '@/lib/ai/runtime/run-snapshot';
import { loadWorkingMemoryContinuity, resolveWorkingMemoryContinuity } from '@/lib/memory/continuity/working-memory';
import { buildBrainContextFromMemoryRequest } from '@/lib/memory/retrieval/recall';
import { buildBrainContextPack } from '@/lib/brain/context';
import { workMemoryApplicabilityHash } from '@/lib/brain/runtime-applicability';
import { promotionEvents, promotionRunId, promotionUserId, promotionWorkId } from '../fixtures/working-memory-promotion';

const contract = { version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1',
  requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }] };
const lease = { userId: '11111111-1111-4111-8111-111111111101', workshopId: '11111111-1111-4111-8111-111111111102', runId: '11111111-1111-4111-8111-111111111104', workerId: '11111111-1111-4111-8111-111111111102er', token: 1 };

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

async function executeContinuation(config: Record<string, unknown> = {}) {
  return executeWorkshopAgent({ userId: lease.userId, workshop: workshop(config), runId: lease.runId,
    sources: [], memories: [], directives: [], events: [], outbox: [], executionLease: lease,
    continuationContext: { sourceRunId: promotionRunId, resultHash: 'admitted-fixture', content: '' } });
}
function useRealContinuity(applicabilityHash?: string | null) {
  const events = promotionEvents();
  if (applicabilityHash !== undefined) events[1].metadata.applicabilityHash = applicabilityHash;
  const state = events[1].metadata.state as any;
  state.facts[0].text = 'HISTORICAL_FACT';
  state.hypotheses = [{ text: 'HISTORICAL_HYPOTHESIS', evidenceIds: [] }];
  state.nextAction = { text: 'HISTORICAL_ACTION', evidenceIds: [] };
  state.openQuestions = ['Verify the current source revision.'];
  vi.mocked(loadWorkingMemoryContinuity).mockImplementationOnce(async request => {
    const currentBinding = request.runtimeBinding ? { ...request.runtimeBinding, userId: promotionUserId,
      workshopId: promotionWorkId, runId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' } : undefined;
    if (currentBinding) Object.assign(events[1].metadata, { runtimeBinding: { ...currentBinding, runId: promotionRunId } });
    return resolveWorkingMemoryContinuity({ ...request, runtimeBinding: currentBinding,
    userId: promotionUserId, workshopId: promotionWorkId, currentRunId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    policyIdentity: { version: 'memact-automem.v1', hash: 'c'.repeat(64) }, now: new Date('2026-10-13T01:00:00Z'),
    runs: [{ id: promotionRunId, userId: promotionUserId, workshopId: promotionWorkId, loopId: null, status: 'completed',
      createdAt: '2026-10-12T23:59:00Z', completedAt: '2026-10-13T00:01:00Z', events }],
  }); });
}
function healthyBrain(routes: Array<{ route: string; status: string; error?: string }> = []) {
  return { ...buildBrainContextPack({ requester: { type: 'work', userId: lease.userId, id: lease.workshopId, workshopId: lease.workshopId },
    taskIntent: 'Study primary source evidence.', memories: [] }), contextLogId: 'fixture-brain-log',
    recallPlan: { mode: 'fallback_rules', routes: [], warnings: [] }, explanation: {}, routeResults: routes };
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
const usage: HostWorkingMemoryUsageEvent = {
  schemaVersion: 'host-working-memory.v1', status: 'provider_result_received', mode: 'apply', version: 1,
  invocation: 2, model: 'fixture-model', provider: 'fixture-provider', elapsedMs: 100,
  usageStatus: 'unknown', source: 'unknown', inputTokens: null, outputTokens: null,
  cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'apply');
  vi.stubEnv('WORKSHOP_MAX_TOOL_CALLS', '30');
  fixture.adapter = 'pi-agent-harness'; fixture.options = null;
  fixture.registeredToolNames = ['webReadPage', 'workshopReadMemory'];
  fixture.events = []; fixture.order = []; fixture.guardCount = 0; fixture.guardThrowsAt = 0;
  fixture.prompt = ''; fixture.continuity = null;
  fixture.failEventType = ''; fixture.writeGate = null; fixture.toolRequests = 0; fixture.dispatchedTools = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe('Workshop working memory executor wiring', () => {
  it.each([
    { bound: true, brainAvailable: true },
    { bound: true, brainAvailable: false },
    { bound: false, brainAvailable: true },
    { bound: false, brainAvailable: false },
  ])('scopes ambient event bodies in the actual prompt: %j', async ({ bound, brainAvailable }) => {
    if (brainAvailable) vi.mocked(buildBrainContextFromMemoryRequest).mockResolvedValueOnce(healthyBrain() as never);
    const ambient = { id: 'project-alpha-event', workshopId: lease.workshopId, runId: 'old-alpha-run', seq: 1,
      type: 'source_checked', title: 'Historical source', body: 'PROJECT_ALPHA_PRIVATE_AMBIENT_BODY', metadata: {},
      visibility: 'user', createdAt: new Date('2026-10-18') };
    await executeWorkshopAgent({ userId: lease.userId, workshop: workshop(bound
      ? { memoryApplicability: { schemaVersion: 'memory-applicability.v1', scenarioKeys: ['project:beta'] } } : {}),
      runId: lease.runId, sources: [], memories: [], directives: [
        { id: 'current-task', scope: 'once', status: 'active', content: 'CURRENT_EXACT_PRIMARY_DIRECTIVE', priority: 1 } as never,
        { id: 'owner-boundary', scope: 'persistent', status: 'active', content: 'PERSISTENT_OWNER_DIRECTIVE', priority: 1 } as never,
      ], primaryDirectiveId: 'current-task', events: [ambient as never], outbox: [], executionLease: lease });
    expect(fixture.prompt.includes(ambient.body)).toBe(!bound);
    expect(fixture.prompt.includes('ambient_event_applicability_unverified')).toBe(bound);
    expect(fixture.prompt).toContain('CURRENT_EXACT_PRIMARY_DIRECTIVE');
    expect(fixture.prompt).toContain('PERSISTENT_OWNER_DIRECTIVE');
    expect(ambient.body).toBe('PROJECT_ALPHA_PRIVATE_AMBIENT_BODY');
  });

  it('does not import another run without an explicit admitted task continuation', async () => {
    await execute();
    expect(loadWorkingMemoryContinuity).not.toHaveBeenCalled();
  });
  it('binds the actual continuation and host receipts to the saved project without changing the strategy hash', async () => {
    const config = (key: string) => ({ memoryApplicability: { schemaVersion: 'memory-applicability.v1', scenarioKeys: [`project:${key}`] } });
    const alphaHash = workMemoryApplicabilityHash(config('alpha'));
    vi.mocked(buildBrainContextFromMemoryRequest).mockResolvedValueOnce(healthyBrain() as never);
    useRealContinuity(alphaHash);
    await executeContinuation(config('alpha'));
    expect(fixture.prompt).toContain('HISTORICAL_FACT');
    expect(loadWorkingMemoryContinuity).toHaveBeenLastCalledWith(expect.objectContaining({ applicabilityHash: alphaHash }));
    expect(fixture.events.find(event => event.type === 'working_memory_continuity_loaded')?.metadata).toMatchObject({ applicabilityHash: alphaHash, status: 'inherited' });
    await fixture.options!.hostWorkingMemory!.onAudit({ ...audit, applicabilityHash: 'model-cannot-replace-host-hash' } as never);
    expect(fixture.events.find(event => event.type === 'working_memory_updated')?.metadata).toMatchObject({ applicabilityHash: alphaHash });
    vi.mocked(buildBrainContextFromMemoryRequest).mockResolvedValueOnce(healthyBrain() as never);
    useRealContinuity(alphaHash);
    await executeContinuation(config('beta'));
    expect(fixture.prompt).not.toContain('HISTORICAL_FACT');
    expect(fixture.prompt).not.toContain('Verify the current source revision.');
    expect(fixture.events.filter(event => event.type === 'working_memory_continuity_loaded').at(-1)?.metadata)
      .toMatchObject({ status: 'skipped', reason: 'memory_applicability_changed', applicabilityHash: workMemoryApplicabilityHash(config('beta')) });
  });

  it('prepares an exact parent checkpoint after persisting the scoped audit and includes the current task in Brain recall', async () => {
    const parentRunId = '11111111-1111-4111-8111-111111111111';
    fixture.continuity = { schemaVersion: 'working-memory-continuity.v1', status: 'inherited', reason: 'scoped_checkpoint', warnings: [],
      checkpoint: { sourceRunId: parentRunId, loopId: null, checkpointEventId: 'prior-checkpoint', version: 1,
        policyIdentity: { version: 'memact-automem.v1', hash: 'a'.repeat(64) }, createdAt: '2026-10-16T00:00:00.000Z',
        expiresAt: '2026-10-23T00:00:00.000Z', authority: 'historical-model-authored-unverified',
        recoveryScope: 'historical-notes-only-no-transcript-replay', correctionPrecedence: 'current-owner-and-brain-first',
        history: { facts: [], hypotheses: [], openQuestions: ['Check the newly published source before continuing.'], nextAction: null },
        sourceRefs: [], chain: { depth: 0, viaRunIds: [], rootHash: 'a'.repeat(64), assertionsSuppressed: false } } };
    await executeWorkshopAgent({ userId: lease.userId, workshop: workshop(), runId: lease.runId,
      sources: [], memories: [], directives: [{ id: 'current-task', content: 'Compare the current source revision.' } as never],
      primaryDirectiveId: 'current-task', events: [], outbox: [], executionLease: lease,
      continuationContext: { sourceRunId: parentRunId, resultHash: 'unused-by-loader-fixture', content: 'Exact admitted prior result.' } });
    expect(loadWorkingMemoryContinuity).toHaveBeenCalledWith(expect.objectContaining({ userId: lease.userId,
      workshopId: lease.workshopId, currentRunId: lease.runId, scope: { kind: 'parent_run', parentRunId } }));
    expect(buildBrainContextFromMemoryRequest).toHaveBeenCalledWith(expect.objectContaining({ taskIntent: expect.stringContaining('Compare the current source revision.') }));
    const receipt = fixture.events.find(event => event.type === 'working_memory_continuity_loaded');
    expect(receipt?.metadata).toMatchObject({ receiptAuthority: 'runtime', status: 'inherited' });
    expect(fixture.prompt).toContain(parentRunId);
    expect(fixture.prompt).toContain('Check the newly published source before continuing.');
    expect(fixture.options?.hostWorkingMemory).not.toHaveProperty('initialState');
  });

  it('does not dispatch a model request when the historical checkpoint audit fails', async () => {
    fixture.failEventType = 'working_memory_continuity_loaded';
    await expect(executeWorkshopAgent({ userId: lease.userId, workshop: workshop(), runId: lease.runId,
      sources: [], memories: [], directives: [], events: [], outbox: [], executionLease: lease,
      continuationContext: { sourceRunId: '11111111-1111-4111-8111-111111111111', resultHash: 'fixture', content: '' } }))
      .rejects.toThrow('event storage unavailable');
    expect(fixture.options).toBeNull();
  });
  it('makes skipped parent history explicit in the actual prompt, preserving the audit and no-write default', async () => {
    fixture.continuity = { schemaVersion: 'working-memory-continuity.v1', status: 'skipped', reason: 'latest_run_unsuccessful',
      warnings: ['Historical notes were not loaded.'], checkpoint: null };
    await executeContinuation();
    expect(fixture.prompt).toContain('latest_run_unsuccessful');
    expect(fixture.prompt).toContain('不表示历史为空或首次运行');
    expect(fixture.events.find(event => event.type === 'working_memory_continuity_loaded')?.metadata).toMatchObject({
      status: 'skipped', checkpoint: null, guidanceAdmission: { status: 'admitted' },
    });
    expect(fixture.events.filter(event => event.type === 'working_memory_updated')).toHaveLength(0);
  });
  it('does not resurrect historical assertions when current Brain recall fails, while retaining questions and an explicit warning', async () => {
    useRealContinuity();
    await executeContinuation();
    expect(loadWorkingMemoryContinuity).toHaveBeenCalledWith(expect.objectContaining({ correctionsPresent: true }));
    const receipt = fixture.events.find(event => event.type === 'working_memory_continuity_loaded');
    expect(receipt?.metadata).toMatchObject({ status: 'inherited', claimGuard: {
      suppressHistoricalClaims: true, reason: 'brain_state_unavailable',
    }, checkpoint: { history: { facts: [], hypotheses: [], nextAction: null, openQuestions: ['Verify the current source revision.'] } } });
    expect(fixture.prompt).toContain('Brain 最新记忆状态未能确认');
    expect(fixture.prompt).toContain('Verify the current source revision.');
    for (const claim of ['HISTORICAL_FACT', 'HISTORICAL_HYPOTHESIS', 'HISTORICAL_ACTION']) expect(fixture.prompt).not.toContain(claim);
  });
  it('preserves history when canonical Brain succeeds despite fallback planner and auxiliary RAG failure', async () => {
    vi.mocked(buildBrainContextFromMemoryRequest).mockResolvedValueOnce(healthyBrain([
      { route: 'knowledge_store', status: 'failed', error: 'auxiliary unavailable' },
      { route: 'memory_graph', status: 'degraded' }, { route: 'evidence_read', status: 'planned' },
    ]) as never);
    useRealContinuity();
    await executeContinuation();
    expect(loadWorkingMemoryContinuity).toHaveBeenCalledWith(expect.objectContaining({ correctionsPresent: false }));
    expect(fixture.events.find(event => event.type === 'working_memory_continuity_loaded')?.metadata).toMatchObject({
      claimGuard: { suppressHistoricalClaims: false, reason: null, warnings: [] },
    });
    expect(fixture.prompt).toContain('HISTORICAL_FACT');
    expect(fixture.prompt).not.toContain('Brain 最新记忆状态未能确认');
  });
  it('records a skipped checkpoint if adding history would exceed the remaining prompt allowance', async () => {
    vi.mocked(buildBrainContextFromMemoryRequest).mockResolvedValueOnce(healthyBrain() as never);
    useRealContinuity();
    await executeContinuation();
    const prior = fixture.events.find(event => event.type === 'working_memory_continuity_loaded')?.metadata as any;
    expect(prior.status).toBe('inherited');
    // Reuse the measured unchanged task input; remove only enough allowance to reject the optional history.
    const configured = fixture.events.find(event => event.type === 'agent_configured')?.metadata as any;
    const fullPromptChars = configured.contextBudget.promptChars;
    expect(fullPromptChars).toBeGreaterThan(fixture.prompt.length);
    const baselineChars = fixture.prompt.slice(0, fixture.prompt.indexOf('\n\n历史工作检查点')).length;
    const baselineWithSystemChars = fullPromptChars - (fixture.prompt.length - baselineChars);
    vi.stubEnv('CONTEXT_PROFILE_NORMAL_PROMPT_MAX_CHARS', String(baselineWithSystemChars + 50));
    fixture.events = []; fixture.prompt = '';
    vi.mocked(buildBrainContextFromMemoryRequest).mockResolvedValueOnce(healthyBrain() as never);
    useRealContinuity();
    await executeContinuation();
    expect(fixture.events.find(event => event.type === 'working_memory_continuity_loaded')?.metadata).toMatchObject({
      status: 'skipped', reason: 'continuity_prompt_budget', checkpoint: null,
    });
    expect(fixture.prompt).not.toContain('HISTORICAL_FACT');
    const skipped = fixture.events.find(event => event.type === 'working_memory_continuity_loaded')?.metadata as any;
    expect(skipped.guidanceAdmission).toMatchObject({ status: 'not_admitted', chars: 0 });
    expect(skipped.warnings).toContain('Continuity guidance was not added because the remaining input budget is insufficient.');
    const budget = fixture.events.find(event => event.type === 'agent_configured')?.metadata as any;
    expect(budget.contextBudget.promptChars).toBeLessThanOrEqual(baselineWithSystemChars + 50);
  });
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

  it('keeps off, legacy adapters and unregistered reads outside admission', async () => {
    const cases = [
      () => { vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'off'); return {}; },
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
      { type: 'working_memory_usage', invoke: () => policy.onUsage!(usage) },
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
    expect(fixture.events.find(event => event.type === 'working_memory_usage')).toMatchObject({
      metadata: { usageStatus: 'unknown', totalTokens: null, policyIdentity: { version: 'memact-automem.v1' } } });
  });

  it('propagates receipt storage failures and both execution guard failures without reporting a saved state', async () => {
    await execute();
    const policy = fixture.options!.hostWorkingMemory!;
    for (const call of [
      { type: 'working_memory_updated', invoke: () => policy.onAudit(audit) },
      { type: 'working_memory_projected', invoke: () => policy.onProjection!(projection) },
      { type: 'working_memory_rejected', invoke: () => policy.onRejected!(rejection) },
      { type: 'working_memory_usage', invoke: () => policy.onUsage!(usage) },
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

  it('awaits a Work-scoped physical audit bound to its real logical receipt and fails on storage or lease loss', async () => {
    await execute();
    const policy = fixture.options!.hostWorkingMemory!, transport = fixture.options!.hostProviderRecovery!;
    const prepared = { schemaVersion: 'host-provider-transport.v1' as const, phase: 'prepared' as const,
      logicalInvocation: 1, attempt: 1 as const, transportOrdinal: 1, bodyHash: 'a'.repeat(64),
      deadlineAt: '2026-10-18T00:02:00.000Z', sameBody: null, sameHeaders: null };
    await expect(transport.onTransportAttempt(prepared)).rejects.toThrow('admitted logical context');
    await policy.onProjection!(projection);
    const logicalSeq = fixture.events.length;
    fixture.order = []; fixture.guardCount = 0;
    let release!: () => void, started!: () => void, settled = false;
    const ready = new Promise<void>(resolve => { started = resolve; });
    fixture.writeGate = { promise: new Promise<void>(resolve => { release = resolve; }), started };
    const pending = Promise.resolve(transport.onTransportAttempt(prepared)).then(() => { settled = true; });
    await ready;
    expect(settled).toBe(false); expect(fixture.order).toEqual(['guard', 'write:provider_transport_attempt']);
    release(); await pending;
    expect(fixture.order).toEqual(['guard', 'write:provider_transport_attempt', 'guard']);
    expect(fixture.events.at(-1)).toMatchObject({ workshopId: lease.workshopId, runId: lease.runId,
      metadata: { ...prepared, receiptAuthority: 'runtime', currentRunId: lease.runId, scope: { kind: 'workshop' },
        logicalPrepared: { eventId: `fixture-event-${logicalSeq}`, seq: logicalSeq, createdAt: '2026-10-18T00:00:00.000Z',
          version: 1, policyIdentity: policy.policyIdentity } } });
    expect(fixture.events.at(-1)).not.toHaveProperty('loopId');
    fixture.writeGate = null; fixture.failEventType = 'provider_transport_attempt';
    await expect(transport.onTransportAttempt(prepared)).rejects.toThrow('event storage unavailable');
    fixture.failEventType = ''; fixture.order = []; fixture.guardCount = 0; fixture.guardThrowsAt = 1;
    await expect(transport.onTransportAttempt(prepared)).rejects.toThrow('lease_lost');
    expect(fixture.order).toEqual(['guard']);
  });
});
