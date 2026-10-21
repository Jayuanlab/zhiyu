import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  withExecutionFence, withExecutionFenceTransaction, type ExecutionLease,
} from '@/lib/work-runtime/execution-fence';
import { ExecutionLeaseError } from '@/lib/work-runtime/execution-errors';
import { withExecutionWriteContext } from '@/lib/work-runtime/execution-write-context';

const legacy = vi.hoisted(() => ({
  context: undefined as any,
  transactions: vi.fn(), dependencies: vi.fn(), classifyError: vi.fn(),
}));
vi.mock('@/lib/workshops/event-write', () => ({
  withWorkshopEventTransaction: async (work: any) => legacy.transactions(() => work(legacy.context.db, legacy.context.append)),
}));
vi.mock('@/lib/memory/revision/dependencies', () => ({ assertMemoryDependenciesCurrentInTransaction: legacy.dependencies }));
vi.mock('@/lib/memory/revision/transaction', () => ({ rethrowBrainMemoryWriteError: legacy.classifyError }));
vi.mock('@/lib/work-runtime/run-completion', () => ({ finalizeWorkshopRun: vi.fn() }));
vi.mock('@/lib/work-runtime/loop-control-state', () => ({ updateLinkedLoopControlState: vi.fn() }));
vi.mock('@/lib/work-runtime/runtime-snapshot', () => ({ readWorkRunRuntimeSnapshotSummary: vi.fn() }));

import {
  ExecutionLeaseError as LegacyExecutionLeaseError, withExecutionWrite, withExecutionTransaction,
  withExecutionBusinessWrite, withExecutionBusinessTransaction,
} from '@/lib/work-runtime/execution-lease';

const lease: ExecutionLease = {
  userId: '11111111-1111-4111-a111-111111111111',
  workshopId: '22222222-2222-4222-a222-222222222222',
  runId: '33333333-3333-4333-a333-333333333333', workerId: 'worker-a', token: 7,
};
const loopId = '44444444-4444-4444-a444-444444444444';
const dialect = new PgDialect();

function database() {
  const state = {
    target: { status: 'active' } as Record<string, unknown> | null,
    lease: { token: lease.token, run_id: lease.runId, worker_id: lease.workerId, phase: 'running',
      lease_until: new Date('2099-01-01T00:00:00Z'), expired: false } as Record<string, unknown> | null,
    run: { status: 'running' } as Record<string, unknown> | null,
    validAtEnd: true, linked: true, events: [] as string[], committed: [] as string[],
    statements: [] as Array<{ sql: string; params: unknown[] }>,
  };
  const execute = vi.fn(async (statement: any) => {
    const query = dialect.sqlToQuery(statement);
    state.statements.push(query);
    if (query.sql.includes('FROM workshops ')) return state.target ? [state.target] : [];
    if (query.sql.includes('FROM workshop_execution_leases ')) return state.lease ? [state.lease] : [];
    if (query.sql.includes('FROM workshop_runs ')) return state.run ? [state.run] : [];
    if (query.sql.includes(' AS valid')) return [{ valid: state.validAtEnd }];
    if (query.sql.includes('FROM workshop_loop_executions ')) return state.linked ? [{ loop_id: loopId }] : [];
    throw new Error(`Unexpected fixture SQL: ${query.sql}`);
  });
  const context = { db: { execute }, append: vi.fn(async () => undefined) };
  const transactionCalls = vi.fn();
  async function transaction<T>(work: (value: typeof context) => Promise<T>): Promise<T> {
    transactionCalls();
    state.events = [...state.committed];
    try {
      const result = await work(context);
      state.committed = [...state.events];
      return result;
    } finally { state.events = [...state.committed]; }
  }
  return { state, context, transaction, transactionCalls, execute };
}

beforeEach(() => {
  vi.clearAllMocks();
  legacy.dependencies.mockResolvedValue(undefined);
  legacy.classifyError.mockImplementation((error: unknown) => { throw error; });
});

describe('execution fence primitive', () => {
  it('locks ownership, token and run before work, then checks database time before commit', async () => {
    const fixture = database();
    const result = await withExecutionFenceTransaction(lease, fixture.context, async context => {
      expect(context).toBe(fixture.context);
      expect(fixture.state.statements).toHaveLength(3);
      return { saved: true };
    });
    expect(result).toEqual({ saved: true });
    expect(fixture.state.statements.map(query => query.sql)).toEqual([
      expect.stringContaining('FROM workshops'), expect.stringContaining('FROM workshop_execution_leases'),
      expect.stringContaining('FROM workshop_runs'), expect.stringContaining('clock_timestamp()'),
    ]);
    expect(fixture.state.statements.slice(0, 3).every(query => query.sql.includes('FOR UPDATE'))).toBe(true);
    expect(fixture.state.statements[0].params).toEqual([lease.workshopId, lease.userId]);
    expect(fixture.state.statements[2].params).toEqual([lease.runId, lease.workshopId]);
    expect(legacy.dependencies).not.toHaveBeenCalled();
  });

  it('rejects an unowned target and retains the existing error class identity', async () => {
    const fixture = database(), write = vi.fn(); fixture.state.target = null;
    const error = await withExecutionFenceTransaction(lease, fixture.context, write).catch(error => error);
    expect(error).toBeInstanceOf(ExecutionLeaseError);
    expect(error).toBeInstanceOf(LegacyExecutionLeaseError);
    expect(error).toMatchObject({ code: 'not_found', status: 404 });
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['userId', 'workshopId', 'runId'] as const)('rejects invalid %s before invoking work', async key => {
    const fixture = database(), write = vi.fn();
    await expect(withExecutionFenceTransaction({ ...lease, [key]: 'invalid' }, fixture.context, write))
      .rejects.toMatchObject({ code: 'invalid_lease' });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing lease', change: (f: ReturnType<typeof database>) => { f.state.lease = null; } },
    { name: 'stale token', change: (f: ReturnType<typeof database>) => { f.state.lease!.token = 8; } },
    { name: 'different worker', change: (f: ReturnType<typeof database>) => { f.state.lease!.worker_id = 'worker-b'; } },
    { name: 'different run', change: (f: ReturnType<typeof database>) => { f.state.lease!.run_id = loopId; } },
    { name: 'inactive lease', change: (f: ReturnType<typeof database>) => { f.state.lease!.phase = 'idle'; } },
    { name: 'expired lease', change: (f: ReturnType<typeof database>) => { f.state.lease!.expired = true; } },
    { name: 'finished run', change: (f: ReturnType<typeof database>) => { f.state.run!.status = 'completed'; } },
  ])('rejects $name before write', async ({ change }) => {
    const fixture = database(), write = vi.fn(); change(fixture);
    await expect(withExecutionFenceTransaction(lease, fixture.context, write)).rejects.toMatchObject({ code: 'lease_lost' });
    expect(write).not.toHaveBeenCalled();
  });

  it('does not treat a paused target as cancellation of an already held valid lease', async () => {
    const fixture = database(); fixture.state.target!.status = 'paused';
    await expect(withExecutionFenceTransaction(lease, fixture.context, async () => 'saved')).resolves.toBe('saved');
  });

  it('propagates post-write expiration so the host transaction rolls back records and events', async () => {
    const fixture = database();
    await expect(withExecutionFence(lease, async () => {
      fixture.state.events.push('observation', 'audit'); fixture.state.validAtEnd = false;
    }, { currentContext: () => undefined, transaction: fixture.transaction })).rejects.toMatchObject({ code: 'lease_lost' });
    expect(fixture.state.committed).toEqual([]);
    expect(fixture.state.events).toEqual([]);
    expect(fixture.transactionCalls).toHaveBeenCalledTimes(1);
  });

  it('preserves the exact callback failure and leaves commit to the host', async () => {
    const fixture = database(), failure = new Error('audit storage unavailable');
    await expect(withExecutionFence(lease, async () => {
      fixture.state.events.push('observation'); throw failure;
    }, { currentContext: () => undefined, transaction: fixture.transaction })).rejects.toBe(failure);
    expect(fixture.state.committed).toEqual([]);
    expect(fixture.state.statements).toHaveLength(3);
  });

  it('reuses the supplied active context without starting another transaction', async () => {
    const fixture = database();
    await withExecutionFence(lease, async context => expect(context).toBe(fixture.context), {
      currentContext: () => fixture.context, transaction: fixture.transaction,
    });
    expect(fixture.transactionCalls).not.toHaveBeenCalled();
    expect(fixture.state.statements).toHaveLength(4);
  });
});

describe('existing execution lease entry points', () => {
  function setup() {
    const fixture = database(); legacy.context = fixture.context;
    legacy.transactions.mockImplementation((work: () => Promise<unknown>) => fixture.transaction(work));
    return fixture;
  }

  it('keeps the existing write and transaction entry points fenced', async () => {
    const fixture = setup();
    await expect(withExecutionWrite(lease, async () => 'saved')).resolves.toBe('saved');
    expect(legacy.transactions).toHaveBeenCalledTimes(1);
    fixture.state.validAtEnd = false;
    await expect(withExecutionTransaction(lease, fixture.context as any, async () => 'late')).rejects.toMatchObject({ code: 'lease_lost' });
    expect(legacy.transactions).toHaveBeenCalledTimes(1);
  });

  it('keeps the actual async transaction identity and closed-scope protection', async () => {
    const fixture = setup(); let late!: Promise<unknown>, release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    await withExecutionWriteContext(lease, fixture.context as any, async () => {
      await withExecutionWrite(lease, async context => expect(context).toBe(fixture.context));
      await expect(withExecutionWrite({ ...lease, token: 8 }, async () => undefined)).rejects.toMatchObject({ code: 'invalid_lease' });
      late = wait.then(() => withExecutionWrite(lease, async () => 'escaped'));
    });
    release();
    await expect(late).rejects.toMatchObject({ code: 'invalid_lease' });
    expect(legacy.transactions).not.toHaveBeenCalled();
  });

  it.each(['write', 'transaction'] as const)('retains the dependency gate for business %s', async mode => {
    const fixture = setup(), write = vi.fn(async () => 'changed'), stale = new Error('source revision stale');
    legacy.dependencies.mockRejectedValue(stale);
    const result = mode === 'write' ? withExecutionBusinessWrite(lease, write)
      : withExecutionBusinessTransaction(lease, fixture.context as any, write);
    await expect(result).rejects.toBe(stale);
    expect(write).not.toHaveBeenCalled();
    expect(legacy.dependencies).toHaveBeenCalledWith(fixture.context.db, { userId: lease.userId, entityKind: 'loop', entityId: loopId });
    expect(legacy.classifyError).toHaveBeenCalledWith(stale);
  });

  it('allows raw observation fences independently of stale business dependencies', async () => {
    setup(); legacy.dependencies.mockRejectedValue(new Error('stale interpretation'));
    await expect(withExecutionWrite(lease, async () => 'raw observation')).resolves.toBe('raw observation');
    expect(legacy.dependencies).not.toHaveBeenCalled();
  });

  it('still verifies the expiry after a successful business dependency check', async () => {
    const fixture = setup();
    await expect(withExecutionBusinessWrite(lease, async () => {
      fixture.state.events.push('business record'); fixture.state.validAtEnd = false;
    })).rejects.toMatchObject({ code: 'lease_lost' });
    expect(legacy.dependencies).toHaveBeenCalledTimes(1);
    expect(fixture.state.committed).toEqual([]);
  });
});
