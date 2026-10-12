import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOptions } from '@openzhiyu/ai/agent/types';
import type { AgentRuntimeRequest } from '@openzhiyu/ai/agent/runtime/types';
import type { HostWorkingMemoryAuditEvent, HostWorkingMemoryProjectionEvent } from '@openzhiyu/ai/agent/runtime';
import type { Loop, Workshop } from '@/lib/db/schema';

const fixture = vi.hoisted(() => ({
  workshop: null as Workshop | null,
  request: null as AgentRuntimeRequest | null,
  events: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  snapshots: [] as Array<Record<string, unknown>>,
  adapter: 'pi-agent-harness',
  toolNames: ['webReadPage', 'webSearch'],
  appendFailureType: '',
  guardFailure: '',
  runBody: null as ((options: AgentOptions) => Promise<void>) | null,
}));

vi.mock('@/lib/db/client', () => ({ db: {} }));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: vi.fn(() => ({
  userId: 'fixture-owner', workshopId: 'fixture-work', runId: 'fixture-run', workerId: 'fixture-worker', token: 'fixture-token',
})) }));
vi.mock('@/lib/work-runtime/execution-guard', () => ({ createExecutionGuard: vi.fn(() => async () => {
  fixture.order.push('guard');
  if (fixture.guardFailure) throw new Error(fixture.guardFailure);
}) }));
vi.mock('@/lib/workshops/service', () => ({
  getWorkshop: vi.fn(async () => fixture.workshop),
  listWorkshopSources: vi.fn(async () => []),
  listWorkshopMemories: vi.fn(async () => []),
  listActiveDirectives: vi.fn(async () => []),
  listWorkshopEvents: vi.fn(async () => []),
  appendWorkshopEvent: vi.fn(async (event: Record<string, unknown>) => {
    fixture.order.push(`append:${String(event.type)}`);
    if (event.type === fixture.appendFailureType) throw new Error('fixture audit storage unavailable');
    fixture.events.push(event);
    return { ...event, id: `fixture-event-${fixture.events.length}` };
  }),
}));
vi.mock('@/lib/ai/runtime/agent-factory', () => ({ createAgentRuntime: vi.fn(() => ({
  metadata: { engine: 'pi', adapter: fixture.adapter, version: 'fixture' },
  async *run(request: AgentRuntimeRequest) {
    fixture.request = request;
    if (fixture.runBody) await fixture.runBody(request.options!);
    yield { type: 'text', content: 'Source-backed fixture result.' };
    yield { type: 'done' };
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
vi.mock('@/lib/brain/service', () => ({ buildBrainContextFromMemoryRequest: vi.fn(async () => { throw new Error('No fixture memory context'); }) }));
vi.mock('@/lib/work-runtime/runtime-snapshot', () => ({ persistWorkRunRuntimeSnapshot: vi.fn(async (_db: unknown, value: Record<string, unknown>) => {
  fixture.snapshots.push(value);
}) }));

import { executeNativeLoopAgent } from '@/lib/loops/native-executor';
import { classifyLoopAction, decideLoopActionApproval } from '@/lib/loops/approval';
import { createLoopToolPermissionHandler } from '@/lib/loops/tool-gate';

function workshop(): Workshop {
  return {
    id: 'fixture-work', userId: 'fixture-owner', name: 'Fixture research', mission: 'Read primary sources.',
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
    id: 'fixture-loop', userId: 'fixture-owner', workshopId: 'fixture-work', name: 'Fixture research Loop',
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

async function execute(inputLoop = loop()) {
  return executeNativeLoopAgent({ userId: 'fixture-owner', loop: inputLoop, previousState: null, runId: 'fixture-run' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'apply');
  fixture.workshop = workshop();
  fixture.request = null;
  fixture.events = [];
  fixture.order = [];
  fixture.snapshots = [];
  fixture.adapter = 'pi-agent-harness';
  fixture.toolNames = ['webReadPage', 'webSearch'];
  fixture.appendFailureType = '';
  fixture.guardFailure = '';
  fixture.runBody = null;
});
afterEach(() => vi.unstubAllEnvs());

describe('native research Loop working-memory admission and host receipts', () => {
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

  it('keeps inactive research contracts, unsupported adapters and explicit off disabled', async () => {
    await execute(loop({ goal: 'Summarize current account state' }));
    expect(fixture.request!.options!.hostWorkingMemory).toBeUndefined();
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
    const memoryEvents = fixture.events.filter(event => String(event.type).startsWith('working_memory_'));
    expect(memoryEvents).toHaveLength(4);
    for (const event of memoryEvents) expect(event).toMatchObject({ workshopId: 'fixture-work', runId: 'fixture-run',
      loopId: 'fixture-loop', loopRunId: 'fixture-run', metadata: { receiptAuthority: 'runtime',
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

  it('rejects a lost execution fence before saving a memory state', async () => {
    fixture.runBody = async options => {
      fixture.guardFailure = 'lease_lost';
      await options.hostWorkingMemory!.onAudit(audit());
    };
    expect(await execute()).toMatchObject({ status: 'error', error: 'lease_lost' });
    expect(fixture.events.filter(event => String(event.type).startsWith('working_memory_'))).toEqual([]);
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
