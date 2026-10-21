vi.mock("@/lib/memory/sources/host-context", () => ({ admitHostSourceRows: vi.fn(async () => undefined) }));
import {prepareBusinessCheckpoint} from '@/lib/loops/business-checkpoint';
import {isContinuityRuntimeBinding, type ContinuityRuntimeBinding} from '@/lib/memory/continuity/runtime-binding';
import {workMemoryApplicabilityHash} from '@/lib/brain/runtime-applicability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentOptions } from '@openzhiyu/ai/agent/types';
import type { AgentRuntimeRequest } from '@openzhiyu/ai/agent/runtime/types';
import type { HostWorkingMemoryAuditEvent, HostWorkingMemoryProjectionEvent } from '@openzhiyu/ai/agent/runtime';
import type { WorkingMemorySnapshot } from '@openzhiyu/ai/agent/runtime/host-working-memory';
import type { WorkingMemoryDeliveryResult } from '@/lib/workshops/working-memory-delivery-contract';
import type { Loop, LoopState, Workshop } from '@/lib/db/schema';
import type { BrainContextPack } from '@/lib/memory/context/pack';
import type { FinalizeContextPackInput } from '@/lib/memory/context/finalize';

const fixture = vi.hoisted(() => ({
  workshop: null as Workshop | null,
  businessCheckpointReceipt: null as Record<string,unknown>|null,
  request: null as AgentRuntimeRequest | null,
  events: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  snapshots: [] as Array<Record<string, unknown>>,
  adapter: 'pi-agent-harness',
  engine: 'pi',
  messages: null as AgentMessage[] | null,
  beforeTerminal: null as (() => void) | null,
  toolNames: ['webReadPage', 'webSearch'],
  appendFailureType: '',
  guardFailure: '',
  hasLease: true,
  loseLeaseAfterTerminalWrite: false,
  runBody: null as ((options: AgentOptions) => Promise<void>) | null,
  continuity: null as Record<string, unknown> | null,
  brainContext: null as Record<string, unknown> | null,
  persistedLoopState: null as LoopState | null,
  runtimeLoop: null as Loop | null,
  deliveryResults: [] as WorkingMemoryDeliveryResult[],
  deliveryReadRows: [] as Array<Array<Record<string, unknown>>>,
  deliveryCheckIndex: 0,
  deliveryReadIndex: 0,
  afterDeliveryRead: null as (() => void) | null,
  afterAppend: null as ((event: Record<string, unknown>) => void) | null,
  dispatchPack: null as BrainContextPack | null,
  dispatchCurrent: true,
}));

vi.mock('@/lib/db/client', () => ({ db: { execute: vi.fn(async () => fixture.snapshots.map(value => ({ snapshot_json: value.snapshot }))) },
  withDatabaseTransaction: async <T>(work: () => Promise<T>) => work() }));
vi.mock('@/lib/memory/revision/dependency-check', () => ({ assertMemoryDependenciesCurrentInTransaction: vi.fn(async () => undefined) }));
vi.mock('@/lib/memory/context/finalize', () => ({ finalizeContextPack: vi.fn(async (input: FinalizeContextPackInput) => {
  fixture.order.push('memory-finalize');
  return { ...input.pack, contextLogId: 'dispatch-audit', items: fixture.dispatchCurrent ? input.pack.items : [] };
}) }));
vi.mock('@/lib/work-runtime/loop-execution', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/work-runtime/loop-execution')>(),
  executeAcceptedWorkLoop: vi.fn(async (_command, execute) => execute(new AbortController())),
  withLinkedLoopWrite: vi.fn(async (_loopId, work) => work({ db: { execute: async () => [] }, append: async () => ({}) })),
}));
vi.mock('@/lib/loops/service', () => ({
  getLoop: vi.fn(async () => fixture.runtimeLoop), getLoopState: vi.fn(async () => fixture.persistedLoopState),
  createLoopRun: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111104', loopId: '11111111-1111-4111-8111-111111111103', status: 'running', inputSnapshot: {}, startedAt: new Date() })),
  completeLoopRun: vi.fn(async () => undefined), createLoopApprovalRequest: vi.fn(async () => undefined), createLoop: vi.fn(),
  upsertLoopState: vi.fn(async (_id, value) => { fixture.persistedLoopState = { ...fixture.persistedLoopState, ...value } as LoopState; }),
}));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: vi.fn(() => fixture.hasLease ? ({
  userId: '11111111-1111-4111-8111-111111111101', workshopId: '11111111-1111-4111-8111-111111111102', runId: '11111111-1111-4111-8111-111111111104', workerId: '11111111-1111-4111-8111-111111111102er', token: 'fixture-token',
}) : undefined) }));
vi.mock('@/lib/work-runtime/execution-guard', () => ({ createExecutionGuard: vi.fn(() => async () => {
  fixture.order.push('guard');
  if (fixture.guardFailure) throw new Error(fixture.guardFailure);
}) }));
vi.mock('@/lib/workshops/service', () => ({
  getWorkshopEvent: vi.fn(async()=>fixture.businessCheckpointReceipt),
  getWorkshop: vi.fn(async () => fixture.workshop),
  listWorkshopSources: vi.fn(async () => []),
  listWorkshopMemories: vi.fn(async () => []),
  listActiveDirectives: vi.fn(async () => []),
  listWorkshopEvents: vi.fn(async (_workshopId: string, options?: Record<string, unknown>) => {
    if (!options?.loopRunId) return [];
    fixture.order.push('read:delivery-events');
    const index = fixture.deliveryReadIndex++;
    fixture.afterDeliveryRead?.();
    return fixture.deliveryReadRows[Math.min(index, fixture.deliveryReadRows.length - 1)] ?? [];
  }),
  appendWorkshopEvent: vi.fn(async (event: Record<string, unknown>) => {
    fixture.order.push(`append:${String(event.type)}`);
    if (event.type === fixture.appendFailureType) throw new Error('fixture audit storage unavailable');
    fixture.events.push(event);
    fixture.afterAppend?.(event);
    if (event.type === 'agent_runtime_terminal' && fixture.loseLeaseAfterTerminalWrite) fixture.guardFailure = 'lease_lost';
    return { ...event, id: `fixture-event-${fixture.events.length}`, seq: fixture.events.length,
      createdAt: new Date('2026-10-18T00:00:00.000Z') };
  }),
}));
vi.mock('@/lib/ai/runtime/agent-factory', () => ({ createAgentRuntime: vi.fn(() => ({
  metadata: { engine: fixture.engine, adapter: fixture.adapter, version: 'fixture' },
  async *run(request: AgentRuntimeRequest) {
    fixture.request = request;
    let approvedText: string | null = null;
    const validation = request.options?.hostFinalValidation;
    if (validation) {
      const validate = validation.validate;
      validation.validate = async candidate => {
        const checked = await validate(candidate);
        approvedText = checked.ok ? candidate.text : null;
        return checked;
      };
    }
    if (fixture.runBody) await fixture.runBody(request.options!);
    for (const message of fixture.messages ?? [
      { type: 'text', content: 'Source-backed fixture result.' },
      ...(approvedText !== null && fixture.engine === 'pi' && fixture.adapter === 'pi-agent-harness'
        ? [{ type: 'result', answerPhase: 'candidate_final', content: approvedText }] : []),
      { type: 'runtime_terminal', runtimeTerminal: { schemaVersion: 'agent-runtime-terminal.v1',
        status: 'completed', cleanupStatus: 'completed', completionScope: 'runtime', operationId: 'fixture-operation' } },
      { type: 'done' },
    ] as AgentMessage[]) {
      if (message.type === 'runtime_terminal') fixture.beforeTerminal?.();
      yield message;
    }
  },
})) }));
vi.mock('@/lib/workshops/pi-domain-tools', () => ({ createWorkshopPiTools: vi.fn(() => fixture.toolNames.map(name => ({ name }))) }));
vi.mock('@/lib/workshops/mcp-tools', () => ({ createWorkshopMcpServer: vi.fn(() => ({})) }));
vi.mock('@/lib/workshops/workspace', () => ({
  prepareWorkspace: vi.fn(async () => ({ runDir: 'D:/zhiyu/.tmp/loop-working-memory-fixture' })),
  workspacePrompt: vi.fn(() => 'Local fixture workspace.'),
}));
vi.mock('@/lib/workshops/run-prompt-skills', () => ({ loadWorkshopRunSkills: vi.fn(() => []) }));
vi.mock('@/lib/db/insight-queries', () => ({ getUserInsightSettings: vi.fn(async () => ({})) }));
vi.mock('@/lib/db/user-queries', () => ({ getUserTypeForService: vi.fn(async () => 'internal') }));
vi.mock('@/lib/ai/user-llm-api-settings', () => ({ getUserLlmProviderConfig: vi.fn(async () => ({
  apiKey: 'local-fixture', baseUrl: 'http://localhost/fixture', model: 'qwen3.7-plus',
})) }));
vi.mock('@/lib/memory/retrieval/recall', () => ({ buildBrainContextFromMemoryRequest: vi.fn(async (request: FinalizeContextPackInput) => {
  if (fixture.dispatchPack) {
    const { registerContextForDispatch } = await import('@/lib/memory/context/dispatch');
    registerContextForDispatch({ ...request, pack: fixture.dispatchPack });
    return { ...fixture.dispatchPack, recallPlan: { interfaceVersion: 'brain-recall-plan.v1', mode: 'rules', statuses: ['active'],
      searchTerms: [], includeCandidates: false, maxItems: 1, memoryLimit: 1, routes: [], rationale: [], warnings: [] }, explanation: {}, routeResults: [] };
  }
  if (fixture.brainContext) return fixture.brainContext;
  throw new Error('No fixture memory context');
}) }));
vi.mock('@/lib/memory/continuity/working-memory', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/memory/continuity/working-memory')>();
  return { ...actual, loadWorkingMemoryContinuity: vi.fn(async () => fixture.continuity ?? {
    schemaVersion: 'working-memory-continuity.v1', status: 'skipped', reason: 'no_scoped_predecessor', warnings: [], checkpoint: null,
  }) };
});
vi.mock('@/lib/memory/continuity/runtime-snapshot', () => ({ persistWorkRunRuntimeSnapshot: vi.fn(async (_db: unknown, value: Record<string, unknown>) => {
  fixture.snapshots.push(value);
}) }));
// This suite checks the native wiring; source/hash/UUID proof is covered by the
// real pure delivery-contract suite, rather than duplicated with fake sources.
vi.mock('@/lib/workshops/working-memory-delivery-contract', () => ({
  checkWorkingMemoryDelivery: vi.fn(() => {
    fixture.order.push('check:delivery');
    const index = fixture.deliveryCheckIndex++;
    return fixture.deliveryResults[Math.min(index, fixture.deliveryResults.length - 1)] ?? {
      schemaVersion: 'working-memory-delivery.v1', ok: false, status: 'needs_correction',
      code: 'no_audited_checkpoint', checkpoint: null, feedback: 'A genuine LOG is still required.',
    };
  }),
}));

import { executeNativeLoopAgent } from '@/lib/loops/native-executor';
import { runNativeLoopOnce } from '@/lib/loops/runtime';
import { classifyLoopAction, decideLoopActionApproval } from '@/lib/loops/approval';
import { createLoopToolPermissionHandler } from '@/lib/loops/tool-gate';
import { loadWorkingMemoryContinuity } from '@/lib/memory/continuity/working-memory';
import { createWorkshopPiTools } from '@/lib/workshops/pi-domain-tools';
import { createWorkshopMcpServer } from '@/lib/workshops/mcp-tools';
import { checkWorkingMemoryDelivery } from '@/lib/workshops/working-memory-delivery-contract';
import { listWorkshopEvents } from '@/lib/workshops/service';
import { parseLoopSpec } from '@/lib/loops/spec';

function workshop(): Workshop {
  return {
    id: '11111111-1111-4111-8111-111111111102', userId: '11111111-1111-4111-8111-111111111101', name: 'Fixture research', mission: 'Read primary sources.',
    status: 'active', autonomyLevel: 'draft', boundaryPolicy: { externalMessages: 'blocked' },
    modelConfig: { agentRuntimeEngine: 'pi', allowedTools: ['webReadPage', 'webSearch'], researchEvidenceContract: {
      version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1', taskKeywords: ['research'],
      requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }],
    } },
    createdAt: new Date('2026-10-10'), updatedAt: new Date('2026-10-10'),
  } as Workshop;
}

function loop(patch: Partial<Loop> = {}): Loop {
  return {
    id: '11111111-1111-4111-8111-111111111103', userId: '11111111-1111-4111-8111-111111111101', workshopId: '11111111-1111-4111-8111-111111111102', name: 'Fixture research Loop',
    description: null, goal: 'research the fixture paper', status: 'active', triggerConfig: { type: 'manual' },
    contextConfig: {}, actionPolicy: { allowed: ['webReadPage', 'webSearch'], denied: [], requiresApproval: [] },
    verificationConfig: {}, approvalPolicy: { defaultMode: 'deny', externalWrites: 'deny' }, retryPolicy: {}, escalationPolicy: {},
    createdAt: new Date('2026-10-10'), updatedAt: new Date('2026-10-10'), ...patch,
  } as Loop;
}

function audit(operation: 'update' | 'restore' = 'update'): HostWorkingMemoryAuditEvent {
  return {
    schemaVersion: 'host-working-memory.v1', status: 'ready_for_projection', operation, mode: 'apply',
    commandId: 'fixture-edit', previousVersion: 0, version: 1, editCount: 1,
    pruneToolCallIds: operation === 'update' ? ['read-1'] : [],
    actionPruneToolCallIds: operation === 'update' ? ['read-1'] : [],
    restoredToolCallIds: operation === 'restore' ? ['read-1'] : [],
    state: { facts: [{ text: 'An observed paper claim.', evidenceIds: ['read-1'] }],
      hypotheses: [], openQuestions: ['Does this generalize?'], nextAction: { text: 'Check the next section.', evidenceIds: ['read-1'] } },
  };
}

function projection(): HostWorkingMemoryProjectionEvent {
  return { schemaVersion: 'host-working-memory.v1', status: 'provider_request_prepared', mode: 'apply', version: 1,
    pruneToolCallIds: ['read-1'], originalMessageCount: 8, projectedMessageCount: 7, originalChars: 8000, projectedChars: 4000 };
}

async function execute(inputLoop = loop(), previousState: LoopState | null = null) {
  return executeNativeLoopAgent({ userId: '11111111-1111-4111-8111-111111111101', loop: inputLoop, previousState, runId: '11111111-1111-4111-8111-111111111104' });
}

function inheritedHistory() {
  return { schemaVersion: 'working-memory-continuity.v1', status: 'inherited', reason: 'scoped_checkpoint', warnings: [],
    checkpoint: { sourceRunId: '11111111-1111-4111-8111-111111111106', loopId: '11111111-1111-4111-8111-111111111103', checkpointEventId: 'prior-log', version: 1,
      policyIdentity: { version: 'memact-automem.v1', hash: 'a'.repeat(64) }, createdAt: '2026-10-16T00:00:00.000Z',
      expiresAt: '2026-10-23T00:00:00.000Z', authority: 'historical-model-authored-unverified',
      recoveryScope: 'historical-notes-only-no-transcript-replay', correctionPrecedence: 'current-owner-and-brain-first',
      history: { facts: [], hypotheses: [], openQuestions: ['Check the next source revision.'], nextAction: null }, sourceRefs: [],
      chain: { depth: 0, viaRunIds: [], rootHash: 'a'.repeat(64), assertionsSuppressed: false } } };
}

function healthyBrainWithAuxiliaryFailure(route: string) {
  return { contextLogId: 'fixture-brain-context', items: [], omitted: [], denied: [], warnings: [],
    selection: { selectedCount: 0, omittedCount: 0, deniedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: [] },
    recallPlan: { provider: route === 'planner' ? 'fallback_rules' : 'rules', ...(route === 'planner' ? { fallbackReason: 'fixture planner timeout' } : {}) },
    explanation: {}, routeResults: route === 'planner' ? [] : [{ route, purpose: 'auxiliary', status: 'failed', count: 0, error: 'Fixture auxiliary source unavailable' }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'apply');
  fixture.workshop = workshop();
  fixture.businessCheckpointReceipt=null;
  fixture.request = null;
  fixture.events = [];
  fixture.order = [];
  fixture.snapshots = [];
  fixture.adapter = 'pi-agent-harness';
  fixture.engine = 'pi';
  fixture.messages = null;
  fixture.beforeTerminal = null;
  fixture.toolNames = ['webReadPage', 'webSearch'];
  fixture.appendFailureType = '';
  fixture.guardFailure = '';
  fixture.hasLease = true;
  fixture.loseLeaseAfterTerminalWrite = false;
  fixture.runBody = null;
  fixture.continuity = null;
  fixture.brainContext = null;
  fixture.dispatchPack = null; fixture.dispatchCurrent = true;
  fixture.persistedLoopState = null;
  fixture.runtimeLoop = null;
  fixture.deliveryResults = [];
  fixture.deliveryReadRows = [];
  fixture.deliveryCheckIndex = 0;
  fixture.deliveryReadIndex = 0;
  fixture.afterDeliveryRead = null;
  fixture.afterAppend = null;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('native research Loop working-memory admission and host receipts', () => {
  it('keeps initial Loop recall in the dispatch scope and rechecks the execution fence before memory admission', async () => {
    fixture.dispatchPack = { interfaceVersion: 'brain-context.v1', items: [{ id: 'memory-a', revisionVersion: 'bmrv1:fixture',
      ownerType: 'work', ownerId: '11111111-1111-4111-8111-111111111102', memoryType: 'fact', subject: 'fixture', content: 'SELECTED_BODY',
      evidenceRefs: [], score: 1, reasons: [] }], denied: [], omitted: [], warnings: [],
      selection: { selectedCount: 1, deniedCount: 0, omittedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} } };
    let sent = false;
    fixture.runBody = async options => {
      fixture.order = [];
      fixture.dispatchCurrent = false;
      await options.onBeforeProviderRequest?.();
      sent = true;
    };
    const result = await execute();
    expect(result.status).toBe('error');
    expect(sent).toBe(false);
    expect(fixture.order.slice(0, 2)).toEqual(['guard', 'memory-finalize']);
    expect(fixture.request?.options?.onBeforeProviderRequest).toBeTypeOf('function');
  });

  it.each([
    ['Pi', createWorkshopPiTools],
    ['MCP', createWorkshopMcpServer],
  ] as const)('passes the current research contract and exact execution scope to the %s tool factory', async (_name, factory) => {
    const instructions = 'Read the current primary source snapshot and preserve its actual window identity.';
    const inputLoop = loop({ goal: 'research the current fixture source revision', contextConfig: { instructions } });
    const currentModelConfig = fixture.workshop!.modelConfig;
    expect(await execute(inputLoop)).toMatchObject({ status: 'success' });
    expect(factory).toHaveBeenCalledOnce();
    const received = vi.mocked(factory).mock.calls[0]?.[0];
    expect(received).toMatchObject({ workshopId: '11111111-1111-4111-8111-111111111102', runId: '11111111-1111-4111-8111-111111111104', loopId: '11111111-1111-4111-8111-111111111103', loopRunId: '11111111-1111-4111-8111-111111111104' });
    expect(received?.researchEvidenceContext?.modelConfig).toBe(currentModelConfig);
    expect(received?.researchEvidenceContext?.taskText).toBe(`${inputLoop.goal}\n${instructions}`);
  });

  it('prepares and audits the exact same-Loop checkpoint independently from this run notebook', async () => {
    fixture.continuity = inheritedHistory();
    expect(await execute()).toMatchObject({ status: 'success' });
    expect(loadWorkingMemoryContinuity).toHaveBeenCalledWith(expect.objectContaining({ userId: '11111111-1111-4111-8111-111111111101',
      workshopId: '11111111-1111-4111-8111-111111111102', currentRunId: '11111111-1111-4111-8111-111111111104', scope: { kind: 'loop', loopId: '11111111-1111-4111-8111-111111111103' } }));
    expect(fixture.request?.operation === 'run' && fixture.request.prompt).toContain('11111111-1111-4111-8111-111111111106');
    const receipt = fixture.events.find(event => event.type === 'working_memory_continuity_loaded');
    expect(receipt).toMatchObject({ loopId: '11111111-1111-4111-8111-111111111103', loopRunId: '11111111-1111-4111-8111-111111111104', metadata: { status: 'inherited', receiptAuthority: 'runtime' } });
    expect(fixture.snapshots[0]?.snapshot).toMatchObject({ extra: { workingMemoryContinuity: { status: 'inherited' } } });
    expect(fixture.request?.options?.hostWorkingMemory).not.toHaveProperty('initialState');
  });

  it('shows the latest failed-history skip in the actual model prompt without reviving rejected notes', async () => {
    fixture.continuity = { schemaVersion: 'working-memory-continuity.v1', status: 'skipped', reason: 'latest_run_unsuccessful',
      warnings: ['Historical notes were not loaded.'], checkpoint: null };
    await execute();
    const prompt = fixture.request?.operation === 'run' ? fixture.request.prompt : '';
    expect(prompt).toContain('latest_run_unsuccessful');
    expect(prompt).toContain('不表示历史为空或首次运行');
    expect(prompt).toContain('"checkpoint":null');
    const receipt = fixture.events.find(event => event.type === 'working_memory_continuity_loaded');
    expect(receipt?.metadata).toMatchObject({ status: 'skipped', reason: 'latest_run_unsuccessful', checkpoint: null,
      guidanceAdmission: { status: 'admitted' } });
  });

  it('does not add even a skipped receipt beyond a full durable-state window', async () => {
    await execute();
    const baseline = fixture.events.find(event => event.type === 'working_memory_continuity_loaded')?.metadata as any;
    vi.stubEnv('LOOP_CONTEXT_MAX_CHARS', String(baseline.contextBudget.durableStateChars + 30));
    fixture.events = [];
    fixture.continuity = inheritedHistory();
    await execute();
    const receipt = fixture.events.find(event => event.type === 'working_memory_continuity_loaded')?.metadata as any;
    expect(receipt).toMatchObject({ status: 'skipped', reason: 'continuity_state_budget', checkpoint: null,
      guidanceAdmission: { status: 'not_admitted', chars: 0 } });
    expect(receipt.contextBudget.durableStateChars + receipt.contextBudget.historyChars
      + receipt.contextBudget.guidanceSeparatorChars).toBeLessThanOrEqual(receipt.contextBudget.maxChars);
    expect(receipt.warnings).toContain('Continuity guidance was not added because the remaining input budget is insufficient.');
    expect(fixture.request?.operation === 'run' && fixture.request.prompt).not.toContain('11111111-1111-4111-8111-111111111106');
  });

  it('suppresses historical assertions and exposes the warning when current Brain state cannot be checked', async () => {
    fixture.continuity = inheritedHistory();
    expect(await execute()).toMatchObject({ status: 'success' });
    expect(loadWorkingMemoryContinuity).toHaveBeenCalledWith(expect.objectContaining({ correctionsPresent: true }));
    const receipt = fixture.events.find(event => event.type === 'working_memory_continuity_loaded');
    expect(receipt?.metadata).toMatchObject({ claimGuard: { suppressHistoricalClaims: true, reason: 'brain_state_unavailable' },
      warnings: expect.arrayContaining([expect.stringContaining('Brain 最新记忆状态未能确认')]) });
    expect(fixture.request?.operation === 'run' && fixture.request.prompt).toContain('Brain 最新记忆状态未能确认');
  });

  it.each(['knowledge_store', 'memory_graph', 'evidence_read', 'planner'])('retains historical assertions when canonical Brain is healthy despite %s degradation', async route => {
    fixture.brainContext = healthyBrainWithAuxiliaryFailure(route);
    fixture.continuity = inheritedHistory();
    expect(await execute()).toMatchObject({ status: 'success' });
    expect(loadWorkingMemoryContinuity).toHaveBeenCalledWith(expect.objectContaining({ correctionsPresent: false }));
    const receipt = fixture.events.find(event => event.type === 'working_memory_continuity_loaded');
    expect(receipt?.metadata).toMatchObject({ claimGuard: { suppressHistoricalClaims: false, reason: null } });
    expect(fixture.request?.operation === 'run' && fixture.request.prompt).not.toContain('Brain 最新记忆状态未能确认');
  });

  it('does not begin a model request if the inherited-history audit cannot be saved', async () => {
    fixture.appendFailureType = 'working_memory_continuity_loaded';
    expect(await execute()).toMatchObject({ status: 'error', error: expect.stringContaining('fixture audit storage unavailable') });
    expect(fixture.request).toBeNull();
    expect(fixture.events.some(event => event.type === 'working_memory_continuity_loaded')).toBe(false);
  });
  it('grants only the enabled intrinsic tool in the current run and records the effective runtime policy', async () => {
    const inputLoop = loop();
    const actionBefore = structuredClone(inputLoop.actionPolicy);
    const configBefore = structuredClone(fixture.workshop!.modelConfig);
    fixture.runBody = async options => {
      expect(options.hostWorkingMemory).toMatchObject({ mode: 'apply', readonlyToolNames: ['webReadPage', 'webSearch'], maxEdits: 4, maxSummaryChars: 6000 });
      expect(await options.onPermissionRequest!({ toolName: 'workingMemory', toolInput: { operation: 'read' }, toolUseID: 'wm-1' }))
        .toMatchObject({ behavior: 'allow' });
      expect(await options.onPermissionRequest!({ toolName: 'unknownPublisher', toolInput: {}, toolUseID: 'external-1' }))
        .toMatchObject({ behavior: 'deny' });
    };
    expect(await execute(inputLoop)).toMatchObject({ status: 'success' });
    expect(fixture.request!.options!.allowedTools).toEqual(['webReadPage', 'webSearch', 'workingMemory']);
    expect(inputLoop.actionPolicy).toEqual(actionBefore);
    expect(fixture.workshop!.modelConfig).toEqual(configBefore);
    const configured = fixture.events.find(event => event.type === 'agent_trace' &&
      (event.metadata as Record<string, unknown>)?.runtimeRunSnapshot);
    expect(configured?.metadata).toMatchObject({ workingMemoryPolicy: { enabled: true, mode: 'apply' }, runtimeRunSnapshot: {
      allowedToolCount: 3, extra: { workingMemoryPolicy: { enabled: true }, piTools: { domain: ['webReadPage', 'webSearch'], intrinsic: ['workingMemory'] } },
    } });
    expect(fixture.snapshots).toHaveLength(1);
  });

  it.each([
    ['Loop denied', { allowed: ['webReadPage', 'workingMemory'], denied: ['mcp__host__workingMemory'] }, {}],
    ['Loop approval', { allowed: ['webReadPage', 'workingMemory'], requiresApproval: ['workingMemory'] }, {}],
    ['Work disallowed', { allowed: ['webReadPage', 'workingMemory'] }, { disallowedTools: ['workingMemory'] }],
    ['Work approval', { allowed: ['webReadPage', 'workingMemory'] }, { requiresApprovalTools: ['workingMemory'] }],
  ])('keeps %s ahead of the local allow grant', async (_label, actionPolicy, configPatch) => {
    fixture.workshop!.modelConfig = { ...fixture.workshop!.modelConfig, ...configPatch };
    await execute(loop({ actionPolicy }));
    expect(fixture.request!.options!.hostWorkingMemory).toBeUndefined();
    expect(fixture.request!.options!.allowedTools).not.toContain('workingMemory');
    const configured = fixture.events.find(event => (event.metadata as Record<string, unknown>)?.workingMemoryPolicy);
    expect(configured?.metadata).toMatchObject({ workingMemoryPolicy: { enabled: false, mode: 'off' } });
  });

  it('admits ordinary Work notes but keeps unsupported adapters and explicit off disabled', async () => {
    await execute(loop({ goal: 'Summarize current account state' }));
    expect(fixture.request!.options!.hostWorkingMemory).toMatchObject({mode:'apply'});
    fixture.adapter = 'pi-agent-core';
    await execute();
    expect(fixture.request!.options!.hostWorkingMemory).toBeUndefined();
    fixture.adapter = 'pi-agent-harness';
    vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'off');
    await execute();
    expect(fixture.request!.options!.hostWorkingMemory).toBeUndefined();
  });

  it('excludes denied or approval reads from the removable set without registering missing tools', async () => {
    fixture.workshop!.modelConfig = { ...fixture.workshop!.modelConfig, allowedTools: ['webReadPage'] };
    fixture.toolNames = ['webReadPage'];
    await execute(loop({ actionPolicy: { allowed: ['webReadPage'], requiresApproval: ['webSearch'] } }));
    expect(fixture.request!.options!.hostWorkingMemory!.readonlyToolNames).toEqual(['webReadPage']);
    expect(fixture.request!.options!.allowedTools).not.toContain('webSearch');
    await execute(loop({ actionPolicy: { allowed: ['webReadPage'], denied: ['webReadPage'] } }));
    expect(fixture.request!.options!.hostWorkingMemory).toBeUndefined();
  });

  it('writes update, restore and provider-preparation receipts under the same run with a fence on both sides', async () => {
    fixture.runBody = async options => {
      fixture.order = [];
      await options.hostWorkingMemory!.onAudit(audit());
      await options.hostWorkingMemory!.onAudit(audit('restore'));
      await options.hostWorkingMemory!.onProjection!(projection());
      await options.hostWorkingMemory!.onRejected!({ schemaVersion: 'host-working-memory.v1', mode: 'apply', version: 1,
        operation: 'update', commandId: 'rejected-edit', code: 'unsafe_prune', detail: 'The selected read is protected.' });
      expect(fixture.order).toEqual([
        'guard', 'append:working_memory_updated', 'guard',
        'guard', 'append:working_memory_restored', 'guard',
        'guard', 'append:working_memory_projected', 'guard',
        'guard', 'append:working_memory_rejected', 'guard',
      ]);
    };
    expect(await execute()).toMatchObject({ status: 'success' });
    const memoryEvents = fixture.events.filter(event => String(event.type).startsWith('working_memory_')
      && (event.metadata as Record<string, unknown>)?.schemaVersion === 'host-working-memory.v1');
    expect(memoryEvents).toHaveLength(4);
    for (const event of memoryEvents) expect(event).toMatchObject({ workshopId: '11111111-1111-4111-8111-111111111102', runId: '11111111-1111-4111-8111-111111111104',
      loopId: '11111111-1111-4111-8111-111111111103', loopRunId: '11111111-1111-4111-8111-111111111104', metadata: { receiptAuthority: 'runtime',
        recoveryScope: 'same_run_original_transcript', semanticStatus: 'not_independently_verified' } });
    expect(memoryEvents[0].metadata).toMatchObject(audit());
    expect(memoryEvents[2].metadata).toMatchObject(projection());
  });

  it.each(['working_memory_updated', 'working_memory_projected', 'working_memory_rejected'])('does not swallow %s audit failure', async type => {
    fixture.appendFailureType = type;
    fixture.runBody = async options => {
      if (type === 'working_memory_updated') await options.hostWorkingMemory!.onAudit(audit());
      else if (type === 'working_memory_projected') await options.hostWorkingMemory!.onProjection!(projection());
      else await options.hostWorkingMemory!.onRejected!({ schemaVersion: 'host-working-memory.v1', mode: 'apply',
        version: 0, code: 'invalid_command', detail: 'Malformed command.' });
    };
    expect(await execute()).toMatchObject({ status: 'error', error: 'fixture audit storage unavailable' });
    expect(fixture.events.filter(event => event.type === type)).toEqual([]);
  });

  it('binds each physical transport audit to the persisted logical projection and current Loop lease', async () => {
    fixture.runBody = async options => {
      const transport = options.hostProviderRecovery!;
      await expect(transport.onTransportAttempt({ schemaVersion: 'host-provider-transport.v1', phase: 'prepared',
        logicalInvocation: 1, attempt: 1, transportOrdinal: 1, bodyHash: 'a'.repeat(64),
        deadlineAt: '2026-10-18T00:02:00.000Z', sameBody: null, sameHeaders: null })).rejects.toThrow('admitted logical context');
      await options.hostWorkingMemory!.onProjection!(projection());
      const projected = fixture.events.findLast(event => event.type === 'working_memory_projected')!;
      const projectedSeq = fixture.events.indexOf(projected) + 1;
      fixture.order = [];
      for (const attempt of [1, 2] as const) await transport.onTransportAttempt({ schemaVersion: 'host-provider-transport.v1', phase: 'prepared',
        logicalInvocation: 1, attempt, transportOrdinal: attempt, bodyHash: 'a'.repeat(64),
        deadlineAt: '2026-10-18T00:02:00.000Z', sameBody: attempt === 1 ? null : true, sameHeaders: attempt === 1 ? null : true });
      expect(fixture.order).toEqual(['guard', 'append:provider_transport_attempt', 'guard', 'guard', 'append:provider_transport_attempt', 'guard']);
      const receipts = fixture.events.filter(event => event.type === 'provider_transport_attempt');
      expect(receipts).toHaveLength(2);
      for (const receipt of receipts) expect(receipt).toMatchObject({ workshopId: '11111111-1111-4111-8111-111111111102', runId: '11111111-1111-4111-8111-111111111104',
        loopId: '11111111-1111-4111-8111-111111111103', loopRunId: '11111111-1111-4111-8111-111111111104', metadata: { receiptAuthority: 'runtime', currentRunId: '11111111-1111-4111-8111-111111111104',
          scope: { kind: 'loop', loopId: '11111111-1111-4111-8111-111111111103' }, bodyHash: 'a'.repeat(64), logicalPrepared: {
            eventId: `fixture-event-${projectedSeq}`, seq: projectedSeq, version: 1, createdAt: '2026-10-18T00:00:00.000Z',
            policyIdentity: options.hostWorkingMemory!.policyIdentity } } });
      expect(fixture.events.filter(event => event.type === 'working_memory_projected')).toHaveLength(1);
    };
    expect(await execute()).toMatchObject({ status: 'success' });
  });

  it.each(['audit', 'lease'])('fails closed before physical transmission when its %s admission fails', async failure => {
    fixture.runBody = async options => {
      await options.hostWorkingMemory!.onProjection!(projection());
      if (failure === 'audit') fixture.appendFailureType = 'provider_transport_attempt';
      else fixture.guardFailure = 'lease_lost';
      await options.hostProviderRecovery!.onTransportAttempt({ schemaVersion: 'host-provider-transport.v1', phase: 'prepared',
        logicalInvocation: 1, attempt: 1, transportOrdinal: 1, bodyHash: 'a'.repeat(64),
        deadlineAt: '2026-10-18T00:02:00.000Z', sameBody: null, sameHeaders: null });
    };
    expect(await execute()).toMatchObject({ status: 'error', error: failure === 'audit' ? 'fixture audit storage unavailable' : 'lease_lost' });
    expect(fixture.events.filter(event => event.type === 'provider_transport_attempt')).toEqual([]);
  });

  it('rejects a lost execution fence before saving a memory state', async () => {
    fixture.runBody = async options => {
      fixture.guardFailure = 'lease_lost';
      await options.hostWorkingMemory!.onAudit(audit());
    };
    expect(await execute()).toMatchObject({ status: 'error', error: 'lease_lost' });
    expect(fixture.events.filter(event => String(event.type).startsWith('working_memory_')
      && (event.metadata as Record<string, unknown>)?.schemaVersion === 'host-working-memory.v1')).toEqual([]);
  });

  it('uses the existing tool budget at dispatch before another intrinsic call can execute', async () => {
    vi.stubEnv('LOOP_MAX_TOOL_CALLS', '2');
    const dispatched: number[] = [];
    fixture.runBody = async options => {
      for (let index = 0; index < 3; index += 1) {
        await options.onBeforeToolUse!({ toolUseId: `wm-${index}`, toolName: 'workingMemory', input: { operation: 'read' } });
        dispatched.push(index);
      }
    };
    expect(await execute()).toMatchObject({ status: 'error', error: 'Loop execution budget exceeded: 3 tool calls used, max 2',
      result: { executionTrace: { maxToolCalls: 2, budgetExceeded: true } } });
    expect(dispatched).toEqual([0, 1]);
  });
});

describe('native Loop opt-in working-memory delivery admission', () => {
  const requiredContract = { required: true, requireFreshSource: true };
  const requiredLoop = () => loop({ verificationConfig: { workingMemoryCheckpoint: requiredContract } });
  const approved = (): WorkingMemoryDeliveryResult => ({ schemaVersion: 'working-memory-delivery.v1',
    ok: true, status: 'satisfied', code: 'current_source_checkpoint_delivered', checkpoint: {
      eventId: 'fixture-current-log', version: 1, sourceEventIds: ['fixture-current-source'], toolCallIds: ['read-1'],
      createdAt: '2026-10-18T00:00:00.000Z', expiresAt: '2026-10-25T00:00:00.000Z',
      rootHash: 'a'.repeat(64), hasOpenQuestions: true, hasNextAction: true, authority: 'model-authored-unverified',
    } });
  const rejected = (code = 'no_audited_checkpoint'): WorkingMemoryDeliveryResult => ({
    schemaVersion: 'working-memory-delivery.v1', ok: false, status: 'needs_correction', code,
    checkpoint: null, feedback: 'A genuine source-bound LOG is still required.',
  });
  function hostSnapshot(options: AgentOptions): WorkingMemorySnapshot {
    return { schemaVersion: 'host-working-memory.v1', authority: 'model-authored-unverified', mode: 'apply',
      version: 1, editCount: 1, maxEdits: 4, maxSummaryChars: 6000, state: audit().state!,
      pruneToolCallIds: [], directory: [], evidenceCatalog: [], projectionCandidates: [],
      catalogSummary: { evidenceCount: 0, referenceEligibleCount: 0, projectionCandidateCount: 0,
        blockedCount: 0, blockedReasons: [], truncated: false }, directoryTruncated: false, retainedReadCautions: [],
      policyIdentity: options.hostWorkingMemory!.policyIdentity, phase: 'LOG', readCount: 1, logCount: 1,
      planCount: 0, stateScope: 'complete', indexedNotes: [] };
  }
  const completedOrThrown = async (inputLoop: Loop) => {
    try { return await execute(inputLoop); }
    catch (error) { return { status: 'error', error: error instanceof Error ? error.message : String(error) }; }
  };
  const forward = { phase: 'report_correction' as const, forward: 1, maxForwards: 4, maxTokens: 2048,
    remainingOutputTokens: 14336, requestedMaxTokens: 2048, localContextWindow: 32000,
    sdkEstimatedInputTokens: 2000, capSource: 'sdk_context_estimate' as const };

  function previousStateWithSpec(verification: Record<string, unknown>): LoopState {
    const spec = parseLoopSpec({ goal: 'Previously stored research task goal', trigger: { type: 'manual' },
      verification: { requiredFields: ['legacyField'], ...verification }, metadata: { legacyMarker: 'preserved' } });
    return { loopId: '11111111-1111-4111-8111-111111111103', currentPhase: 'idle', stateJson: { loopSpec: spec },
      memorySummary: null, openQuestions: [], lastObservation: null, nextAction: null, blockedReason: null,
      updatedAt: new Date('2026-10-17T00:00:00.000Z') } as LoopState;
  }
  function actualPromptSpec() {
    const prompt = fixture.request?.operation === 'run' ? fixture.request.prompt : '';
    const match = prompt.match(/Loop spec:\s*(\{[\s\S]*?\})\s*Current durable state:/);
    expect(match, 'Actual runtime prompt must contain a complete structured Loop spec').not.toBeNull();
    return JSON.parse(match![1]);
  }

  it('projects the current row checkpoint contract into the actual spec despite a valid older durable spec', async () => {
    const previous = previousStateWithSpec({}), before = structuredClone(previous);
    await execute(requiredLoop(), previous);
    const actual = actualPromptSpec();
    expect(actual.verification.workingMemoryCheckpoint).toEqual(requiredContract);
    expect(actual.verification.requiredFields).toEqual([]);
    expect(actual.goal).toBe('research the fixture paper');
    expect(actual.metadata).not.toHaveProperty('legacyMarker');
    expect(fixture.request?.options?.hostFinalValidation).toBeDefined();
    expect(previous).toEqual(before);
  });

  it('cannot resurrect a withdrawn current checkpoint contract from a valid older durable spec', async () => {
    const previous = previousStateWithSpec({ workingMemoryCheckpoint: requiredContract }), before = structuredClone(previous);
    expect((await execute(loop(), previous)).status).toBe('success');
    const actual = actualPromptSpec();
    expect(actual.verification).not.toHaveProperty('workingMemoryCheckpoint');
    expect(actual.verification.requiredFields).toEqual([]);
    expect(actual.goal).toBe('research the fixture paper');
    expect(actual.metadata).not.toHaveProperty('legacyMarker');
    expect(fixture.request?.options?.hostFinalValidation).toBeUndefined();
    expect(previous).toEqual(before);
  });

  it('rejects invalid current raw checkpoint configuration before an older valid spec can mask it', async () => {
    const previous = previousStateWithSpec({});
    await expect(execute(loop({ verificationConfig: { workingMemoryCheckpoint: { required: false } } }), previous)).rejects.toThrow();
    expect(fixture.request).toBeNull();
  });

  it('cannot accept a completed runtime whose actual candidate has no required LOG', async () => {
    fixture.runBody = async options => {
      expect(options.hostFinalValidation).toBeDefined();
      const result = await options.hostFinalValidation!.validate({ text: 'A final report without a LOG.',
        attempt: 0, signal: new AbortController().signal, workingMemory: hostSnapshot(options) });
      expect(result).toMatchObject({ ok: false, feedback: expect.stringContaining('LOG') });
      // An incorrectly permissive runtime is deliberately still going to emit
      // completed; the native acceptance boundary must independently refuse it.
    };
    expect((await execute(requiredLoop())).status).toBe('error');
    expect(checkWorkingMemoryDelivery).toHaveBeenCalledOnce();
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'working_memory_delivery_checked',
      metadata: expect.objectContaining({ stage: 'candidate', ok: false, receiptAuthority: 'runtime' }) }));
    expect(fixture.events).not.toContainEqual(expect.objectContaining({ type: 'agent_trace',
      title: 'Native loop completed' }));
  });

  it('cannot accept completed output when the runtime never invokes the required candidate callback', async () => {
    const result = await execute(requiredLoop());
    expect(result.status).toBe('error');
    expect(checkWorkingMemoryDelivery).not.toHaveBeenCalled();
    expect(fixture.events.some(event => event.type === 'agent_runtime_terminal')).toBe(true);
  });

  it.each([undefined, null, false, {}, { required: false }, { required: true, extra: true }])(
    'rejects a present malformed contract before any runtime dispatch: %j', async contract => {
      const result = await completedOrThrown(loop({ verificationConfig: { workingMemoryCheckpoint: contract } as Loop['verificationConfig'] }));
      expect(result.status).toBe('error');
      expect(fixture.request).toBeNull();
      expect(checkWorkingMemoryDelivery).not.toHaveBeenCalled();
    });

  it.each(['off', 'shadow', 'rollback', 'claude', 'noLease', 'denied'] as const)(
    'cannot silently disable required delivery when %s prevents admission', async condition => {
      if (condition === 'off' || condition === 'shadow') vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', condition);
      if (condition === 'rollback') fixture.adapter = 'pi-agent-core';
      if (condition === 'claude') { fixture.engine = 'claude'; fixture.adapter = 'claude-agent-sdk'; }
      if (condition === 'noLease') fixture.hasLease = false;
      const inputLoop = requiredLoop();
      if (condition === 'denied') inputLoop.actionPolicy = { allowed: ['webReadPage', 'workingMemory'], denied: ['workingMemory'] };
      expect((await completedOrThrown(inputLoop)).status).toBe('error');
      expect(fixture.request).toBeNull();
      expect(checkWorkingMemoryDelivery).not.toHaveBeenCalled();
    });

  it('preserves the unconfigured Loop contract without adding a mandatory delivery gate', async () => {
    expect((await execute()).status).toBe('success');
    expect(fixture.request?.options?.hostFinalValidation).toBeUndefined();
    expect(checkWorkingMemoryDelivery).not.toHaveBeenCalled();
    expect(fixture.events.some(event => event.type === 'working_memory_delivery_checked')).toBe(false);
  });

  it('checks the actual candidate snapshot and fresh same-run durable rows again after the runtime commits', async () => {
    fixture.deliveryResults = [approved(), approved()];
    fixture.deliveryReadRows = [[{ id: 'candidate-read', createdAt: new Date('2026-10-18T00:00:00.000Z') }],
      [{ id: 'commit-read', createdAt: new Date('2026-10-18T00:00:01.000Z') }]];
    let snapshot: WorkingMemorySnapshot;
    fixture.runBody = async options => {
      snapshot = hostSnapshot(options);
      expect(await options.hostFinalValidation!.validate({ text: 'Source-backed fixture result.',
        attempt: 0, signal: new AbortController().signal, workingMemory: snapshot })).toEqual({ ok: true });
    };
    expect((await execute(requiredLoop())).status).toBe('success');
    expect(checkWorkingMemoryDelivery).toHaveBeenCalledTimes(2);
    const [candidate, committed] = vi.mocked(checkWorkingMemoryDelivery).mock.calls.map(call => call[0]);
    for (const input of [candidate, committed]) {
      expect(input).toMatchObject({ contract: requiredContract, scope: { userId: '11111111-1111-4111-8111-111111111101', workshopId: '11111111-1111-4111-8111-111111111102',
        runId: '11111111-1111-4111-8111-111111111104', loopId: '11111111-1111-4111-8111-111111111103' }, attempt: 0, snapshot: snapshot!, correctionsPresent: true });
      expect(input.scope.policyIdentity).toEqual(fixture.request?.options?.hostWorkingMemory?.policyIdentity);
    }
    expect(candidate.durableEvents).toEqual([{ id: 'candidate-read', createdAt: '2026-10-18T00:00:00.000Z' }]);
    expect(committed.durableEvents).toEqual([{ id: 'commit-read', createdAt: '2026-10-18T00:00:01.000Z' }]);
    expect(listWorkshopEvents).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111102', expect.objectContaining({ loopRunId: '11111111-1111-4111-8111-111111111104', order: 'asc', limit: 501 }));
    const receipts = fixture.events.filter(event => event.type === 'working_memory_delivery_checked');
    expect(receipts.map(event => (event.metadata as Record<string, unknown>).stage)).toEqual(['candidate', 'runtime_commit']);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ workshopId: '11111111-1111-4111-8111-111111111102', runId: '11111111-1111-4111-8111-111111111104', loopId: '11111111-1111-4111-8111-111111111103', loopRunId: '11111111-1111-4111-8111-111111111104',
        metadata: { receiptAuthority: 'runtime', currentRunId: '11111111-1111-4111-8111-111111111104', scope: { kind: 'loop', loopId: '11111111-1111-4111-8111-111111111103' }, ok: true } });
      const at = fixture.order.indexOf(`append:${String(receipt.type)}`);
      expect(fixture.order.slice(at - 1, at + 2)).toEqual(['guard', 'append:working_memory_delivery_checked', 'guard']);
    }
    const terminalAt = fixture.events.findIndex(event => event.type === 'agent_runtime_terminal');
    expect(fixture.events.indexOf(receipts[1])).toBeGreaterThan(terminalAt);
  });

  it('persists the approved candidate rather than concatenated invalid and repaired reports', async () => {
    fixture.deliveryResults = [approved(), approved()];
    const final = '```json\n{"summary":"Accepted report","reportMarkdown":"Complete accepted article.","researchProcess":{"status":"evidence_insufficient"},"projectAssessment":{},"checkpoint":{"nextQuestions":["Pending check"]},"warnings":[]}\n```';
    fixture.runBody = async options => { await options.hostFinalValidation!.validate({text:final,attempt:0,
      signal:new AbortController().signal,workingMemory:hostSnapshot(options)}); };
    fixture.messages = [{type:'text',content:'```json\n{"summary":"Rejected draft"}\n```'},
      {type:'text',content:final},{type:'result',answerPhase:'candidate_final',content:final},
      {type:'runtime_terminal',runtimeTerminal:{schemaVersion:'agent-runtime-terminal.v1',status:'completed',cleanupStatus:'completed',completionScope:'runtime'}},{type:'done'}];
    const result = await execute(requiredLoop()); expect(result.status).toBe('success');
    expect((result.result as {structuredReport:Record<string,unknown>}).structuredReport).toMatchObject({
      reportMarkdown:'Complete accepted article.',checkpoint:{nextQuestions:['Pending check']},warnings:[]});
    expect(fixture.events.filter(e=>e.type==='business_final_candidate_selected')).toHaveLength(1);
    expect(fixture.events.find(e=>e.type==='business_final_candidate_selected')?.metadata).toMatchObject({
      source:'pi_harness_validated_final_candidate',reportHash:expect.stringMatching(/^[a-f0-9]{64}$/),
      selectedFields:['reportMarkdown','researchProcess','projectAssessment','checkpoint','warnings']});
  });

  it('cannot substitute text deltas when a permissive runtime omits the approved result', async () => {
    fixture.deliveryResults = [approved(), approved()];
    fixture.runBody = async options => { await options.hostFinalValidation!.validate({text:'Approved text.',attempt:0,
      signal:new AbortController().signal,workingMemory:hostSnapshot(options)}); };
    fixture.messages = [{type:'text',content:'Approved text.'},
      {type:'runtime_terminal',runtimeTerminal:{schemaVersion:'agent-runtime-terminal.v1',status:'completed',cleanupStatus:'completed',completionScope:'runtime'}},{type:'done'}];
    const result = await execute(requiredLoop()); expect(result.status).toBe('error');
    expect((result.result as {executionTrace:{events:unknown[]}}).executionTrace.events).toContainEqual(expect.objectContaining({
      type:'error',metadata:expect.objectContaining({rawMessage:expect.stringContaining('without its approved final candidate')})}));
    expect(checkWorkingMemoryDelivery).toHaveBeenCalledOnce();
    expect(fixture.events.some(e=>e.type==='business_final_candidate_selected')).toBe(false);
  });

  it('fails delivery when the approved candidate selection receipt cannot persist', async () => {
    fixture.deliveryResults = [approved(), approved()]; fixture.appendFailureType = 'business_final_candidate_selected';
    fixture.runBody = async options => { await options.hostFinalValidation!.validate({text:'Approved text.',attempt:0,
      signal:new AbortController().signal,workingMemory:hostSnapshot(options)}); };
    expect(await execute(requiredLoop())).toMatchObject({status:'error',error:expect.stringContaining('storage unavailable')});
    expect(checkWorkingMemoryDelivery).toHaveBeenCalledOnce();
  });

  it('rejects a formerly accepted candidate when a fresh commit read no longer proves delivery', async () => {
    fixture.deliveryResults = [approved(), rejected('checkpoint_unavailable')];
    fixture.deliveryReadRows = [[{ id: 'first', createdAt: new Date() }], [{ id: 'changed', createdAt: new Date() }]];
    fixture.runBody = async options => {
      expect(await options.hostFinalValidation!.validate({ text: 'Candidate accepted before commit.', attempt: 0,
        signal: new AbortController().signal, workingMemory: hostSnapshot(options) })).toEqual({ ok: true });
    };
    expect((await execute(requiredLoop())).status).toBe('error');
    expect(checkWorkingMemoryDelivery).toHaveBeenCalledTimes(2);
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'working_memory_delivery_checked',
      metadata: expect.objectContaining({ stage: 'runtime_commit', ok: false, code: 'checkpoint_unavailable' }) }));
  });

  it('never substitutes report text for a missing host snapshot and exposes incomplete durable reads', async () => {
    fixture.deliveryResults = [rejected('checkpoint_snapshot_mismatch')];
    fixture.deliveryReadRows = [Array.from({ length: 501 }, (_, index) => ({ id: `row-${index}`, createdAt: new Date() }))];
    fixture.runBody = async options => {
      const result = await options.hostFinalValidation!.validate({ text: '{"workingMemory":"pretend saved"}',
        attempt: 0, signal: new AbortController().signal });
      expect(result.ok).toBe(false);
    };
    expect((await execute(requiredLoop())).status).toBe('error');
    expect(checkWorkingMemoryDelivery).toHaveBeenCalledWith(expect.objectContaining({ snapshot: undefined, eventsTruncated: true,
      durableEvents: expect.any(Array) }));
    expect(vi.mocked(checkWorkingMemoryDelivery).mock.calls[0][0].durableEvents).toHaveLength(500);
  });

  it('configures one bounded correction with a nonrenewed output and time allowance, auditing before a forward', async () => {
    fixture.deliveryResults = [approved(), approved()];
    fixture.runBody = async options => {
      const gate = options.hostFinalValidation!;
      expect(gate).toMatchObject({ maxCorrections: 1, maxExtraForwards: 4 });
      expect(gate.timeoutMs).toBeGreaterThan(0);
      expect(gate.timeoutMs).toBeLessThanOrEqual(420000);
      expect(await gate.reserveOutputTokens!()).toBe(16384);
      expect(gate.sourceRecovery).toBeUndefined();
      expect(gate.boundedCompaction).toEqual({ maxForwards: 1, totalOutputTokens: 2048, perForwardOutputTokens: 2048 });
      fixture.order = [];
      await gate.onForward!(forward);
      expect(fixture.order).toEqual(['guard', 'append:working_memory_delivery_forward', 'guard']);
      expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'working_memory_delivery_forward',
        workshopId: '11111111-1111-4111-8111-111111111102', runId: '11111111-1111-4111-8111-111111111104', loopId: '11111111-1111-4111-8111-111111111103', loopRunId: '11111111-1111-4111-8111-111111111104',
        metadata: expect.objectContaining({ ...forward, receiptAuthority: 'runtime' }) }));
      await gate.validate({ text: 'Source-backed fixture result.', attempt: 1,
        signal: new AbortController().signal, workingMemory: hostSnapshot(options) });
    };
    expect((await execute(requiredLoop())).status).toBe('success');
    expect(vi.mocked(checkWorkingMemoryDelivery).mock.calls.map(call => call[0].attempt)).toEqual([1, 1]);
  });

  it.each(['candidate', 'runtime_commit', 'forward'] as const)('fails closed when the %s delivery receipt cannot persist', async stage => {
    fixture.deliveryResults = [approved(), approved()];
    if (stage === 'candidate') fixture.appendFailureType = 'working_memory_delivery_checked';
    if (stage === 'runtime_commit') fixture.beforeTerminal = () => { fixture.appendFailureType = 'working_memory_delivery_checked'; };
    if (stage === 'forward') fixture.appendFailureType = 'working_memory_delivery_forward';
    fixture.runBody = async options => {
      if (stage === 'forward') await options.hostFinalValidation!.onForward!(forward);
      else await options.hostFinalValidation!.validate({ text: 'Source-backed fixture result.', attempt: 0,
        signal: new AbortController().signal, workingMemory: hostSnapshot(options) });
    };
    const result = await execute(requiredLoop());
    expect(result).toMatchObject({ status: 'error', error: 'fixture audit storage unavailable' });
  });

  it('cannot approve a candidate when its durable event read exhausts the original deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T00:00:00.000Z'));
    fixture.deliveryResults = [approved(), approved()];
    fixture.afterDeliveryRead = () => vi.setSystemTime(Date.now() + 420001);
    fixture.runBody = async options => {
      await options.hostFinalValidation!.validate({ text: 'Provider output before a slow durable read.', attempt: 0,
        signal: new AbortController().signal, workingMemory: hostSnapshot(options) });
    };
    const result = await execute(requiredLoop());
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('whole-runtime deadline exhausted') });
    expect(checkWorkingMemoryDelivery).not.toHaveBeenCalled();
    expect(fixture.events.some(event => event.type === 'working_memory_delivery_checked')).toBe(false);
    expect((result.result as { executionTrace: { events: Array<{ title?: string }> } }).executionTrace.events)
      .not.toContainEqual(expect.objectContaining({ title: 'Native loop completed' }));
  });

  it('cannot complete when the runtime-commit audit exhausts the original deadline after being written', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T00:00:00.000Z'));
    fixture.deliveryResults = [approved(), approved()];
    fixture.afterAppend = event => {
      if (event.type === 'working_memory_delivery_checked'
        && (event.metadata as Record<string, unknown>)?.stage === 'runtime_commit') {
        vi.setSystemTime(Date.now() + 420001);
      }
    };
    fixture.runBody = async options => {
      expect(await options.hostFinalValidation!.validate({ text: 'Provider output before a slow commit audit.', attempt: 0,
        signal: new AbortController().signal, workingMemory: hostSnapshot(options) })).toEqual({ ok: true });
    };
    const result = await execute(requiredLoop());
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('whole-runtime deadline exhausted') });
    expect(checkWorkingMemoryDelivery).toHaveBeenCalledTimes(2);
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'working_memory_delivery_checked',
      metadata: expect.objectContaining({ stage: 'runtime_commit', ok: true }) }));
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'agent_runtime_terminal',
      metadata: expect.objectContaining({ runtimeTerminal: expect.objectContaining({ status: 'completed' }) }) }));
    expect((result.result as { executionTrace: { events: Array<{ title?: string }> } }).executionTrace.events)
      .not.toContainEqual(expect.objectContaining({ title: 'Native loop completed' }));
  });
});

describe('working-memory Loop permission classification', () => {
  it('classifies exact names as internal writes and keeps similarly named publishers conservative', () => {
    for (const name of ['workingMemory', 'mcp__host__workingMemory']) expect(classifyLoopAction(name)).toBe('write_internal');
    for (const name of ['workingMemoryPublish', 'workingMemoryAndSend']) expect(classifyLoopAction(name)).toBe('write_external');
  });

  it.each([
    { denied: ['workingMemory'], requiresApproval: [], expected: 'deny' },
    { denied: [], requiresApproval: ['mcp__host__workingMemory'], expected: 'require_approval' },
  ])('retains the explicit $expected conflict ahead of allowed', async ({ denied, requiresApproval, expected }) => {
    const actionPolicy = { allowed: ['workingMemory'], denied, requiresApproval };
    expect(decideLoopActionApproval({ actionName: 'workingMemory', actionPolicy,
      approvalPolicy: { defaultMode: 'allow', externalWrites: 'deny' } })).toMatchObject({ capability: 'write_internal', decision: expected });
    const handler = createLoopToolPermissionHandler({ actionPolicy, approvalPolicy: { defaultMode: 'allow', externalWrites: 'deny' } });
    expect(await handler({ toolName: 'workingMemory', toolInput: { operation: 'update' }, toolUseID: 'wm-conflict' }))
      .toMatchObject({ behavior: 'deny' });
  });
});

describe('native Loop actual Harness terminal admission', () => {
  const text: AgentMessage = { type: 'text', content: 'A provider draft is not completion.' };
  const terminal = (patch: Partial<NonNullable<AgentMessage['runtimeTerminal']>> = {}): AgentMessage => ({
    type: 'runtime_terminal', runtimeTerminal: { schemaVersion: 'agent-runtime-terminal.v1', status: 'completed',
      cleanupStatus: 'completed', completionScope: 'runtime', operationId: 'fixture-operation', ...patch },
  });

  it('persists the actual scoped terminal under the lease before accepting completion', async () => {
    const actual = terminal();
    fixture.messages = [text, actual, { type: 'done' }];
    const result = await execute();
    expect(result.status).toBe('success');
    const receipt = fixture.events.find(event => event.type === 'agent_runtime_terminal');
    expect(receipt).toMatchObject({ workshopId: '11111111-1111-4111-8111-111111111102', runId: '11111111-1111-4111-8111-111111111104', loopId: '11111111-1111-4111-8111-111111111103', loopRunId: '11111111-1111-4111-8111-111111111104',
      metadata: { receiptAuthority: 'runtime', currentRunId: '11111111-1111-4111-8111-111111111104', scope: { kind: 'loop', loopId: '11111111-1111-4111-8111-111111111103' },
        runtime: { engine: 'pi', adapter: 'pi-agent-harness' }, ordinal: 1, runtimeTerminal: actual.runtimeTerminal } });
    const trace = (result.result as { executionTrace: Record<string, unknown> }).executionTrace;
    expect(trace.runtimeTerminal).toEqual(actual.runtimeTerminal);
    expect(trace.runtimeTerminalCount).toBe(1);
    expect(trace.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'agent_runtime_terminal',
      metadata: expect.objectContaining({ runtimeTerminal: actual.runtimeTerminal }) })]));
    const at = fixture.order.indexOf('append:agent_runtime_terminal');
    expect(fixture.order.slice(at - 1, at + 2)).toEqual(['guard', 'append:agent_runtime_terminal', 'guard']);
  });

  it.each([
    ['output-only EOF', [text]],
    ['done without terminal', [text, { type: 'done' }]],
    ['failed terminal', [text, terminal({ status: 'failed', error: 'provider stopped' }), { type: 'done' }]],
    ['aborted terminal', [text, terminal({ status: 'aborted' }), { type: 'done' }]],
    ['failed cleanup', [text, terminal({ cleanupStatus: 'failed' }), { type: 'done' }]],
    ['duplicate terminal', [text, terminal(), terminal(), { type: 'done' }]],
    ['missing terminal body', [text, { type: 'runtime_terminal' }, { type: 'done' }]],
    ['answer-delivery scope', [text, terminal({ completionScope: 'answer_delivery' }), { type: 'done' }]],
    ['data after terminal', [text, terminal(), { type: 'text', content: 'late output' }, { type: 'done' }]],
    ['empty completed answer', [terminal(), { type: 'done' }]],
  ] as Array<[string, AgentMessage[]]>)('rejects %s instead of treating a draft as success', async (_name, messages) => {
    fixture.messages = messages;
    const result = await execute();
    expect(result.status).toBe('error');
    expect((result.result as { executionTrace: { events: Array<{ type: string; title?: string }> } }).executionTrace.events)
      .not.toContainEqual(expect.objectContaining({ type: 'completed', title: 'Native loop completed' }));
  });

  it('does not swallow terminal audit storage failure', async () => {
    fixture.appendFailureType = 'agent_runtime_terminal';
    const result = await execute();
    expect(result).toMatchObject({ status: 'error', error: 'fixture audit storage unavailable' });
    expect(fixture.events.some(event => event.type === 'agent_runtime_terminal')).toBe(false);
  });

  it('cannot persist or accept a terminal after the execution fence is lost', async () => {
    fixture.beforeTerminal = () => { fixture.guardFailure = 'lease_lost'; };
    const result = await execute();
    expect(result).toMatchObject({ status: 'error', error: 'lease_lost' });
    expect(fixture.events.some(event => event.type === 'agent_runtime_terminal')).toBe(false);
  });

  it('does not accept a written terminal when the post-write lease check fails', async () => {
    fixture.loseLeaseAfterTerminalWrite = true;
    const result = await execute();
    expect(result).toMatchObject({ status: 'error', error: 'lease_lost' });
    expect(fixture.events.filter(event => event.type === 'agent_runtime_terminal')).toHaveLength(1);
  });

  it('keeps local terminal admission without inventing a workshop receipt for a standalone Loop', async () => {
    fixture.hasLease = false;
    const result = await execute(loop({ workshopId: null }));
    expect(result.status).toBe('success');
    expect((result.result as { executionTrace: Record<string, unknown> }).executionTrace)
      .toMatchObject({ runtimeTerminalCount: 1, runtimeTerminal: { status: 'completed' } });
    expect(fixture.events.some(event => event.type === 'agent_runtime_terminal')).toBe(false);
  });

  it.each([['pi', 'pi-agent-core'], ['claude', 'claude-agent-sdk']])('preserves the explicit %s/%s output contract', async (engine, adapter) => {
    fixture.engine = engine; fixture.adapter = adapter;
    fixture.messages = [text, { type: 'done' }];
    expect((await execute()).status).toBe('success');
    expect(fixture.events.some(event => event.type === 'agent_runtime_terminal')).toBe(false);
  });
});

async function savedRuntimeBindingForPreviousRun(): Promise<ContinuityRuntimeBinding> {
  await execute(loop());
  const snapshot = fixture.snapshots.at(-1)?.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || !('extra' in snapshot)
    || !snapshot.extra || typeof snapshot.extra !== 'object' || !('continuityBinding' in snapshot.extra)
    || !isContinuityRuntimeBinding(snapshot.extra.continuityBinding)) throw Error('Actual host snapshot binding required');
  return { ...snapshot.extra.continuityBinding, runId: '11111111-1111-4111-8111-111111111105' };
}

describe('ordinary business memory and progress admission',()=>{
 it('enables the notebook and ordinary business validation without adding a LOG acceptance requirement',async()=>{
  fixture.workshop={...workshop(),modelConfig:{role:'agent_frontier_researcher',researchReportStyle:'freeform_project_value',allowedTools:['webReadPage','webSearch']}} as Workshop;
  await execute(loop({verificationConfig:{type:'structured_check',requiredFields:['researchProcess']}}));
  const options=fixture.request!.options!;
  expect(options.hostWorkingMemory).toMatchObject({mode:'apply'});
  expect(options.hostFinalValidation).toMatchObject({maxCorrections:2,maxExtraForwards:4});
  const checkpoint={nextQuestions:['Which source should be checked next?'],facts:['Do not promote this claim']};
  const progress=options.hostFinalValidation!.progressFromValidatedReport!('```json\n'+JSON.stringify({checkpoint})+'\n```');
  expect(progress).toMatchObject({openQuestions:checkpoint.nextQuestions,checkpointHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(JSON.stringify(progress)).not.toContain('Do not promote this claim');
  expect(options.hostFinalValidation!.progressFromValidatedReport!('```json\n'+JSON.stringify({checkpoint:{facts:['No questions']}})+'\n```')).toBeNull();
  expect(options.hostProviderRecovery?.policy).toMatchObject({version:'official-go-qwen-report.v1',sharedTimeoutMs:300000,maxRecoveries:1});
  expect(JSON.stringify(fixture.request)).not.toContain('Required delivery: save a real current-run');
  const result=await options.hostFinalValidation!.validate({text:'<structured-output>'+JSON.stringify({researchProcess:{status:'degraded',question:'Current source?',sourceEvidence:[],externalEvidence:[],gaps:['Source unavailable'],nextStep:'Read source'},projectAssessment:{materialChange:false,notificationIntent:'quiet'}})+'</structured-output>',attempt:0,signal:new AbortController().signal});
  expect(result).toEqual({ok:true});
 });
 it('delivers a checkpoint only after matching the exact owned host receipt',async()=>{
  const runtimeBinding = await savedRuntimeBindingForPreviousRun();
  const prepared=prepareBusinessCheckpoint({userId:'11111111-1111-4111-8111-111111111101',workshopId:'11111111-1111-4111-8111-111111111102',loopId:'11111111-1111-4111-8111-111111111103',runId:'11111111-1111-4111-8111-111111111105',verificationPassed:false,
   runtimeBinding,
   report:{checkpoint:{nextQuestions:['Read the newly identified source next round'],facts:['Never treat this old claim as current fact']}}});
  if(prepared.status!=='saved')throw Error('fixture unavailable');
  const state={...prepared.state,receiptEventId:'checkpoint-receipt'};
  fixture.businessCheckpointReceipt={id:'checkpoint-receipt',type:'loop_business_checkpoint_saved',workshopId:'11111111-1111-4111-8111-111111111102',loopId:'11111111-1111-4111-8111-111111111103',loopRunId:'11111111-1111-4111-8111-111111111105',runId:'11111111-1111-4111-8111-111111111105',metadata:{receiptAuthority:'runtime',...prepared}};
  const previous={loopId:'11111111-1111-4111-8111-111111111103',currentPhase:'blocked',stateJson:{businessCheckpoint:state,continuityBinding:runtimeBinding},memorySummary:prepared.memorySummary,openQuestions:prepared.openQuestions,nextAction:null,updatedAt:new Date(),lastObservation:null,blockedReason:null} as LoopState;
  await execute(loop(),previous);
  expect(JSON.stringify(fixture.request)).toContain('Read the newly identified source next round');
  expect(JSON.stringify(fixture.request)).not.toContain('Never treat this old claim as current fact');
  expect(fixture.events).toContainEqual(expect.objectContaining({type:'business_checkpoint_loaded',metadata:expect.objectContaining({status:'inherited',sourceRunId:'11111111-1111-4111-8111-111111111105'})}));
  fixture.businessCheckpointReceipt={...fixture.businessCheckpointReceipt,runId:'11111111-1111-4111-8111-111111111107'};
  await execute(loop(),previous);
  expect(JSON.stringify(fixture.request)).not.toContain('Read the newly identified source next round');
 });
 it('rejects old project questions in the actual Loop prompt when the trusted Work binding changes',async()=>{
  const config=(key:string)=>({memoryApplicability:{schemaVersion:'memory-applicability.v1',scenarioKeys:[`project:${key}`]}});
  const alphaHash=workMemoryApplicabilityHash(config('alpha'));
  fixture.workshop={...workshop(),modelConfig:{...workshop().modelConfig,...config('alpha')}} as Workshop;
  const runtimeBinding = await savedRuntimeBindingForPreviousRun();
  const prepared=prepareBusinessCheckpoint({userId:'11111111-1111-4111-8111-111111111101',workshopId:'11111111-1111-4111-8111-111111111102',loopId:'11111111-1111-4111-8111-111111111103',runId:'11111111-1111-4111-8111-111111111105',verificationPassed:false,
   applicabilityHash:alphaHash,runtimeBinding,report:{checkpoint:{nextQuestions:['ALPHA_ONLY_NEXT_QUESTION']}}});
  if(prepared.status!=='saved')throw Error('fixture unavailable');
  fixture.businessCheckpointReceipt={id:'checkpoint-receipt',type:'loop_business_checkpoint_saved',workshopId:'11111111-1111-4111-8111-111111111102',loopId:'11111111-1111-4111-8111-111111111103',loopRunId:'11111111-1111-4111-8111-111111111105',runId:'11111111-1111-4111-8111-111111111105',metadata:{receiptAuthority:'runtime',...prepared}};
  const previous={loopId:'11111111-1111-4111-8111-111111111103',currentPhase:'blocked',stateJson:{businessCheckpoint:{...prepared.state,receiptEventId:'checkpoint-receipt'},continuityBinding:runtimeBinding},
   memorySummary:prepared.memorySummary,openQuestions:prepared.openQuestions,nextAction:null,updatedAt:new Date(),lastObservation:null,blockedReason:null} as LoopState;
  fixture.workshop={...workshop(),modelConfig:{...workshop().modelConfig,...config('alpha')}} as Workshop;
  await execute(loop(),previous);
  expect(JSON.stringify(fixture.request)).toContain('ALPHA_ONLY_NEXT_QUESTION');
  expect(loadWorkingMemoryContinuity).toHaveBeenLastCalledWith(expect.objectContaining({applicabilityHash:alphaHash}));
  fixture.workshop={...workshop(),modelConfig:{...workshop().modelConfig,...config('beta')}} as Workshop;
  await execute(loop(),previous);
  expect(JSON.stringify(fixture.request)).not.toContain('ALPHA_ONLY_NEXT_QUESTION');
  expect(fixture.events.filter(event=>event.type==='business_checkpoint_loaded').at(-1)?.metadata).toMatchObject({status:'skipped',applicabilityHash:workMemoryApplicabilityHash(config('beta'))});
 });
 it('does not treat a matching configuration hash as verification of bare historical narrative',async()=>{
  const runtimeBinding = await savedRuntimeBindingForPreviousRun();
  const previous = { loopId: '11111111-1111-4111-8111-111111111103', currentPhase: 'blocked',
   memorySummary: 'UNVERIFIED_MATCHING_SUMMARY', openQuestions: ['UNVERIFIED_BARE_QUESTION'],
   lastObservation: 'UNVERIFIED_MATCHING_OBSERVATION', nextAction: 'UNVERIFIED_MATCHING_ACTION', blockedReason: null,
   updatedAt: new Date(), stateJson: { continuityBinding: runtimeBinding, memoryApplicabilityHash: null,
    modelFact: 'UNVERIFIED_MATCHING_FACT', loopSpec: parseLoopSpec({ goal: 'UNVERIFIED_MATCHING_GOAL',
     trigger: { type: 'manual' }, context: { instructions: 'UNVERIFIED_MATCHING_INSTRUCTIONS', sources: [] } }) } } as LoopState;
  const before = structuredClone(previous);
  await execute(loop(), previous);
  expect(JSON.stringify(fixture.request)).not.toMatch(/UNVERIFIED_MATCHING|UNVERIFIED_BARE/);
  expect(previous).toEqual(before);
 });
 it('does not record a prepared historical notebook as loaded if the actual adapter differs',async()=>{
  fixture.continuity = inheritedHistory();
  fixture.adapter = 'pi-agent-core';
  const result = await execute(loop());
  expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('memory_continuity_runtime_changed') });
  expect(fixture.request).toBeNull();
  expect(fixture.events.some(event => event.type === 'working_memory_continuity_loaded')).toBe(false);
 });
 it.each(['alpha','unbound'])('withholds all old durable narrative without a business checkpoint after %s becomes another bound context',async prior=>{
  const config=(key:string)=>({memoryApplicability:{schemaVersion:'memory-applicability.v1',scenarioKeys:[`project:${key}`]}});
  const previous={loopId:'11111111-1111-4111-8111-111111111103',currentPhase:'blocked',memorySummary:'OLD_STATE_SUMMARY',openQuestions:['OLD_STATE_QUESTION'],
   lastObservation:'OLD_STATE_OBSERVATION',nextAction:'OLD_STATE_NEXT_ACTION',blockedReason:'OLD_STATE_BLOCKED_REASON',updatedAt:new Date(),
   stateJson:{oldFact:'OLD_STATE_FACT',loopSpec:parseLoopSpec({goal:'OLD_LOOP_SPEC_GOAL',trigger:{type:'manual'},context:{instructions:'OLD_LOOP_SPEC_INSTRUCTIONS',
    sources:[{type:'url',uri:'https://example.test/OLD_LOOP_SPEC_SOURCE'}]}}),...(prior==='alpha'?{memoryApplicabilityHash:workMemoryApplicabilityHash(config('alpha'))}:{})}} as LoopState;
  const original=structuredClone(previous);
  fixture.workshop={...workshop(),modelConfig:{...workshop().modelConfig,...config('beta')}} as Workshop;
  await execute(loop({contextConfig:{instructions:'CURRENT_LOOP_ROW_INSTRUCTIONS',sources:[]}}),previous);
  const request=JSON.stringify(fixture.request);
  for(const value of ['OLD_STATE_SUMMARY','OLD_STATE_QUESTION','OLD_STATE_OBSERVATION','OLD_STATE_NEXT_ACTION','OLD_STATE_BLOCKED_REASON','OLD_STATE_FACT',
   'OLD_LOOP_SPEC_GOAL','OLD_LOOP_SPEC_INSTRUCTIONS','OLD_LOOP_SPEC_SOURCE'])expect(request).not.toContain(value);
  expect(request).toContain('CURRENT_LOOP_ROW_INSTRUCTIONS');
  expect(previous).toEqual(original);
  expect(fixture.events).toContainEqual(expect.objectContaining({type:'loop_memory_applicability_changed',metadata:expect.objectContaining({historicalStatePreserved:true,loadedHistoricalAssertions:false})}));
 });
 it.each(['absent','omitted'])('does not relabel Alpha history as Beta after a first Beta run with an %s checkpoint',async checkpointMode=>{
  const config=(key:string)=>({memoryApplicability:{schemaVersion:'memory-applicability.v1',scenarioKeys:[`project:${key}`]}});
  const oldState={loopId:'11111111-1111-4111-8111-111111111103',currentPhase:'blocked',memorySummary:'ALPHA_PERSISTED_SUMMARY',openQuestions:['ALPHA_PERSISTED_QUESTION'],
   lastObservation:'ALPHA_PERSISTED_OBSERVATION',nextAction:'ALPHA_PERSISTED_NEXT_ACTION',blockedReason:'ALPHA_PERSISTED_BLOCKED_REASON',updatedAt:new Date(),
   stateJson:{oldFact:'ALPHA_PERSISTED_FACT',memoryApplicabilityHash:workMemoryApplicabilityHash(config('alpha'))}} as LoopState;
  fixture.persistedLoopState=structuredClone(oldState);
  fixture.runtimeLoop=loop({retryPolicy:{maxAttempts:1}});
  fixture.workshop={...workshop(),modelConfig:{...workshop().modelConfig,...config('beta')}} as Workshop;
  const executeCurrent=async({loop:current,previousState,loopRun}:any)=>{
   const result=await executeNativeLoopAgent({userId:'11111111-1111-4111-8111-111111111101',loop:current,previousState,runId:loopRun.id});
   if(checkpointMode==='omitted'){
    const data=result.result as Record<string,unknown>;
    result.result={...data,structuredReport:{...(data.structuredReport as Record<string,unknown>),checkpoint:{notes:'x'.repeat(9000)}}};
   }
   return result;
  };
  await runNativeLoopOnce({userId:'11111111-1111-4111-8111-111111111101',loopId:'11111111-1111-4111-8111-111111111103',triggeredBy:'manual',execute:executeCurrent});
  expect(fixture.persistedLoopState?.stateJson).toMatchObject({memoryApplicabilityHash:workMemoryApplicabilityHash(config('beta'))});
  await runNativeLoopOnce({userId:'11111111-1111-4111-8111-111111111101',loopId:'11111111-1111-4111-8111-111111111103',triggeredBy:'manual',execute:executeCurrent});
  const secondRequest=JSON.stringify(fixture.request);
  for(const value of ['ALPHA_PERSISTED_SUMMARY','ALPHA_PERSISTED_QUESTION','ALPHA_PERSISTED_OBSERVATION','ALPHA_PERSISTED_NEXT_ACTION','ALPHA_PERSISTED_BLOCKED_REASON','ALPHA_PERSISTED_FACT'])expect(secondRequest).not.toContain(value);
  expect(JSON.stringify(fixture.persistedLoopState)).not.toContain('ALPHA_PERSISTED');
  expect(oldState.stateJson.oldFact).toBe('ALPHA_PERSISTED_FACT');
 });
});
