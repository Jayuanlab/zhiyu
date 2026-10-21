import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DrizzleDB } from '@/lib/db/types';
import type { ExactUsePolicy } from '@/lib/memory/context/exact-use-admission';

const state = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>[]>(), receipts: [] as unknown[], auditFails: false,
  lease: undefined as undefined | { userId: string; workshopId: string; runId: string; workerId: string; token: number } }));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: () => state.lease }));
vi.mock('@/lib/memory/adapters/postgres/context-logs', () => ({ lockContextOwnerForShare: vi.fn(), insertContextLogInTransaction: async (_store: unknown, value: unknown) => {
  if (state.auditFails) throw Error('PRIVATE_SQL_AUDIT_ERROR'); state.receipts.push(value); return { id: `receipt-${state.receipts.length}` };
} }));
vi.mock('@/lib/memory/adapters/postgres/memory-records', () => ({ readContextMemoriesForShare: async () => [], readContextGrantsForShare: async () => [] }));
vi.mock('@/lib/memory/adapters/postgres/exact-published-sources', () => ({ readExactWorkBindingForShare: async () => ({ sourceFilters: undefined }), readExactPublishedRowsForShare: async () => [] }));
vi.mock('@/lib/memory/context/finalize', () => ({ finalizeContextPack: vi.fn() }));
vi.mock('@/lib/memory/revision/transaction', async () => ({ withMemoryRecordWrite: async (_id: string, _kind: string, run: (db: DrizzleDB) => Promise<{ result: unknown }>) => (await run(store())).result }));
vi.mock('@/lib/db/client', () => ({ withDatabaseTransaction: async (run: () => Promise<unknown>) => {
  const before = state.receipts.length; try { return await run(); } catch (error) { state.receipts.length = before; throw error; }
} }));

const dialect = new PgDialect();
function store(): DrizzleDB {
  return { select: () => ({ from: (table: Parameters<typeof getTableName>[0]) => {
    const tableName = getTableName(table);
    let rows = structuredClone(state.rows.get(tableName) ?? []), predicate: SQL | undefined;
    const chain = { where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
      predicate = condition;
      const query = dialect.sqlToQuery(condition), params = query.params;
      rows = rows.filter(row => (!query.sql.includes(`"${tableName}"."id" =`) || params.includes(row.id))
        && (!query.sql.includes(`"${tableName}"."user_id" =`) || params.includes(row.userId))
        && (!query.sql.includes(`"${tableName}"."workshop_id" =`) || params.includes(row.workshopId))
        && (!query.sql.includes(`"${tableName}"."enabled" =`) || row.enabled === true)); return chain;
    }, orderBy: () => chain, limit: () => chain, for: async () => rows,
    getSQL: () => sql`select id from ${table}${predicate ? sql` where ${predicate}` : sql``}` };
    return chain;
  } }) } as DrizzleDB;
}
import { readSourceRecordForShare } from '@/lib/memory/adapters/postgres/source-records';
import { admitMemorySourceUse } from '@/lib/memory/sources/registration';
import { sourceRevision, matchesSourceProjection } from '@/lib/memory/sources/records';
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent } from '@/lib/memory/context/dispatch';
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const work = '33333333-3333-4333-8333-333333333333', event = '44444444-4444-4444-8444-444444444444';
const policy = (): ExactUsePolicy => ({ requester: { type: 'work', userId: owner, id: work }, purpose: 'fixture', sourceCapability: 'wechatListRecordedMessages' });
beforeEach(() => {
  state.rows = new Map([['workshops', [{ id: work, userId: owner, modelConfig: { allowedTools: ['wechatListRecordedMessages'] }, boundaryPolicy: {} }]],
    ['interaction_events', [{ id: event, userId: owner, content: 'PRIVATE_RAW_SOURCE', processedStatus: 'new', metadata: {} }]],
    ['workshop_events', [{ id: event, workshopId: work, body: 'PRIVATE_WORK_EVENT' }]]]);
  state.receipts = []; state.auditFails = false;
  state.lease = { userId: owner, workshopId: work, runId: other, workerId: 'synthetic', token: 1 };
});
describe('typed stored source authority and dispatch', () => {
  it('publishes file configuration only as a descriptor and refuses cached file body as a generic source proof', async () => {
    state.rows.set('workshop_sources', [{ id: event, workshopId: work, type: 'file', name: 'Old file source', uri: 'file:///PRIVATE_HOST_PATH',
      content: 'REVOKED_CACHED_FILE_BODY', enabled: true, config: {} }]);
    const current = await readSourceRecordForShare(store(), { source: 'workshopSources', id: event, requester: policy().requester });
    expect(current?.projectionRow).toMatchObject({ content: null, uri: `source:${event}` });
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
      await expect(admitMemorySourceUse({ userId: owner, source: 'workshopSources', policy: policy(), records: [{ id: event, projection: current!.row }] })).rejects.toMatchObject({ code: 'memory_exact_use_unavailable' });
      await admitMemorySourceUse({ userId: owner, source: 'workshopSources', policy: policy(), records: [{ id: event, projection: current!.projectionRow }] });
      await assertMemoryDispatchCurrent(); expect(JSON.stringify(state.receipts)).not.toContain('REVOKED_CACHED_FILE_BODY');
    });
  });
  it('hashes actual values and authority, with stable Unicode and date normalization', () => {
    const a = { id: event, body: '\u6d4b\u8bd5\ud83d\ude80', at: new Date('2026-10-20T00:00:00Z') };
    expect(sourceRevision('workshopEvents', a, { owner })).toBe(sourceRevision('workshopEvents', { at: a.at.toISOString(), body: a.body, id: event }, { owner }));
    expect(sourceRevision('workshopEvents', a, { owner })).not.toBe(sourceRevision('workshopEvents', a, { owner: other }));
    expect(matchesSourceProjection(a, { body: a.body })).toBe(true); expect(matchesSourceProjection(a, { body: 'forged' })).toBe(false);
  });
  it('uses real stored owner and capability checks; generic Work recall cannot escalate', async () => {
    await expect(readSourceRecordForShare(store(), { source: 'interactionEvents', id: event, requester: policy().requester })).rejects.toMatchObject({ code: 'memory_source_unavailable' });
    expect((await readSourceRecordForShare(store(), { ...policy(), source: 'interactionEvents', id: event }))?.row.content).toBe('PRIVATE_RAW_SOURCE');
    state.rows.get('interaction_events')![0]!.userId = other;
    expect(await readSourceRecordForShare(store(), { ...policy(), source: 'interactionEvents', id: event })).toBeNull();
  });
  it.each(['config', 'denied', 'lease', 'scenario'])('fails closed on actual %s mismatch', async kind => {
    if (kind === 'config') state.rows.get('workshops')![0]!.modelConfig = { allowedTools: [] };
    if (kind === 'denied') state.rows.get('workshops')![0]!.modelConfig = { allowedTools: ['wechatListRecordedMessages'], deniedTools: ['wechatListRecordedMessages'] };
    if (kind === 'lease') state.lease!.userId = other;
    await expect(readSourceRecordForShare(store(), { ...policy(), source: 'interactionEvents', id: event,
      ...(kind === 'scenario' ? { sourceFilters: { scenarioKeys: ['project:alpha'] } } : {}) })).rejects.toMatchObject({ code: 'memory_source_unavailable' });
  });
  it.each(['mcp__workshop-tools__wechatListRecordedMessages', 'WECHATLISTRECORDEDMESSAGES', 'mcp__workshop-tools__WeChatListRecordedMessages'])('uses the real Work tool leaf identity for explicit allow %s', async name => {
    state.rows.get('workshops')![0]!.modelConfig = { allowedTools: [name] };
    expect((await readSourceRecordForShare(store(), { ...policy(), source: 'interactionEvents', id: event }))?.row.content).toBe('PRIVATE_RAW_SOURCE');
  });
  it.each(['deniedTools', 'disallowedTools', 'hardDeniedActions'])('normalizes prefixed and case-folded %s before allow', async field => {
    const storedWork = state.rows.get('workshops')![0]!;
    const denied = ['mcp__workshop-tools__WECHATLISTRECORDEDMESSAGES'];
    storedWork.modelConfig = { allowedTools: ['wechatListRecordedMessages'], ...(field !== 'hardDeniedActions' ? { [field]: denied } : {}) };
    storedWork.boundaryPolicy = field === 'hardDeniedActions' ? { hardDeniedActions: denied } : {};
    await expect(readSourceRecordForShare(store(), { ...policy(), source: 'interactionEvents', id: event })).rejects.toMatchObject({ code: 'memory_source_unavailable' });
  });
  it.each(['unknownTool', 'mcp__workshop-tools__unknownTool', 'mcp__workshop-tools__wechatListRecordedMessagesExtra'])('does not turn unknown allow %s into a source capability', async name => {
    state.rows.get('workshops')![0]!.modelConfig = { allowedTools: [name] };
    await expect(readSourceRecordForShare(store(), { ...policy(), source: 'interactionEvents', id: event })).rejects.toMatchObject({ code: 'memory_source_unavailable' });
  });
  it.each(['edit', 'revoke', 'audit'])('admits an unseen raw row and blocks the next Pi request after %s, atomically', async kind => {
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
      const projection = structuredClone(state.rows.get('interaction_events')![0]!);
      await admitMemorySourceUse({ userId: owner, source: 'interactionEvents', policy: policy(), records: [{ id: event, projection }] });
      await assertMemoryDispatchCurrent(); expect(JSON.stringify(state.receipts)).not.toContain('PRIVATE_RAW_SOURCE');
      const before = state.receipts.length;
      if (kind === 'edit') state.rows.get('interaction_events')![0]!.content = 'REVISED';
      if (kind === 'revoke') state.rows.get('workshops')![0]!.modelConfig = { allowedTools: [] };
      if (kind === 'audit') state.auditFails = true;
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: 'memory_dispatch_context_unavailable' });
      expect(state.receipts).toHaveLength(before);
    });
  });
  it('does not let forged prose, unsupported runtimes, or scoped old events reach the model', async () => {
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
      await expect(admitMemorySourceUse({ userId: owner, source: 'interactionEvents', policy: policy(), records: [{ id: event, projection: { content: 'FORGED' } }] })).rejects.toMatchObject({ code: 'memory_exact_use_unavailable' });
    });
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: 'claude', adapter: 'claude-agent-sdk' });
      await expect(admitMemorySourceUse({ userId: owner, source: 'interactionEvents', policy: policy(), records: [{ id: event, projection: { content: 'PRIVATE_RAW_SOURCE' } }] })).rejects.toMatchObject({ code: 'memory_dispatch_context_unavailable' });
    });
    await expect(readSourceRecordForShare(store(), { source: 'workshopEvents', id: event, requester: policy().requester, sourceFilters: { scenarioKeys: ['project:alpha'] } })).rejects.toMatchObject({ code: 'memory_source_unavailable' });
  });
  it('rechecks an unchanged Work legacy row after its TTL elapses', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-20T12:00:00Z');
    state.rows.set('workshop_memories', [{ id: event, workshopId: work, content: 'TEMPORARY_LEGACY_BODY', tags: ['memory_status:confirmed'], expiresAt: new Date('2026-10-20T12:00:01Z') }]);
    try {
      await withMemoryDispatchContext(async () => {
        bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
        const legacy = await readSourceRecordForShare(store(), { source: 'workshopMemories', id: event, requester: policy().requester });
        expect(legacy?.projectionRow.status).toBe('confirmed');
        await admitMemorySourceUse({ userId: owner, source: 'workshopMemories', policy: policy(), records: [{ id: event, projection: legacy!.projectionRow }] });
        await assertMemoryDispatchCurrent(); vi.setSystemTime('2026-10-20T12:00:02Z');
        await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: 'memory_dispatch_context_unavailable' });
      });
    } finally { vi.useRealTimers(); }
  });
});
