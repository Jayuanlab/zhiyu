import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { BrainRetirementIdentity } from '@/lib/brain/retirement-signals';

const fixture = vi.hoisted(() => ({
  retired: [] as BrainRetirementIdentity[], queryFails: false,
  selects: [] as Array<{ columns: string[] | null; table: string; where: unknown; limit: number }>,
  logs: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/db/client', () => {
  const store = {
    select(columns?: Record<string, unknown>) {
      const record = { columns: columns ? Object.keys(columns) : null, table: '', where: null as unknown, limit: 0 };
      const chain = {
        from(table: unknown) { record.table = getTableName(table as never); return chain; },
        where(where: unknown) { record.where = where; return chain; },
        orderBy() { return chain; },
        async limit(limit: number) {
          record.limit = limit; fixture.selects.push(record);
          if (columns) {
            if (fixture.queryFails) throw Error('private database detail');
            return fixture.retired;
          }
          return [];
        },
      };
      return chain;
    },
    insert() { return { values(value: Record<string, unknown>) {
      fixture.logs.push(value); return { returning: async () => [{ id: 'context-log', ...value }] };
    } }; },
  };
  return { db: store };
});
vi.mock('@/lib/memory/revision/transaction', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/memory/revision/transaction')>();
  return { ...actual, withMemoryRecordWrite: async (_owner: string, _type: string, write: (store: unknown) => Promise<{ result: unknown }>) => {
    const { db } = await import('@/lib/db/client'); return (await write(db)).result;
  } };
});

import { BRAIN_RETIREMENT_SIGNAL_LIMIT, BRAIN_RETIREMENT_SIGNAL_WINDOW_MS, readBrainRetirementSignals } from '@/lib/brain/retirement-signals';
import { buildBrainContextPackFromStore } from '@/lib/brain/repository';
import { brainContextPackToWorkshopMemoryContextPack } from '@/lib/brain/workshop-memory';
import { resolveWorkingMemoryClaimGuard } from '@/lib/workshops/memory-context';
import { resolveWorkingMemoryContinuity } from '@/lib/workshops/working-memory-continuity';

const owner = '11111111-1111-4111-a111-111111111111';
const work = '22222222-2222-4222-a222-222222222222';
const memory = '33333333-3333-4333-a333-333333333333';
const other = '44444444-4444-4444-a444-444444444444';
const now = new Date('2026-10-16T00:00:00.000Z');
const requester = { type: 'work' as const, userId: owner, id: work, workshopId: work };
function retired(patch: Partial<BrainRetirementIdentity> = {}): BrainRetirementIdentity {
  return { id: memory, userId: owner, scopeType: 'workshop', scopeId: work, ownerType: 'work', ownerId: work,
    memoryType: 'fact', status: 'deleted', updatedAt: '2026-10-15T00:00:00.000Z', expiresAt: null, ...patch };
}
beforeEach(() => { fixture.retired = []; fixture.queryFails = false; fixture.selects = []; fixture.logs = []; });

describe('identity-only own-work retirement signals', () => {
  it('uses bounded SQL ownership, scope, status and time constraints without selecting retired content', async () => {
    fixture.retired = [retired()];
    const signal = await readBrainRetirementSignals({ requester, now });
    expect(signal).toMatchObject({ scope: 'own_work_recent_retirements', status: 'complete', workId: work,
      retired: [{ id: memory, reason: 'deleted' }], limit: 200 });
    const query = fixture.selects[0];
    expect(query.limit).toBe(201);
    expect(query.columns).toEqual(['id', 'userId', 'scopeType', 'scopeId', 'ownerType', 'ownerId', 'memoryType', 'status', 'updatedAt', 'expiresAt']);
    const sql = new PgDialect().sqlToQuery(query.where as never);
    expect(sql.sql).toContain('"user_id" =');
    expect(sql.sql).toContain('"owner_id" =');
    expect(sql.sql).toContain('"scope_id" =');
    expect(sql.sql).toContain('"scope_type" in');
    expect(sql.sql).toContain('"status" in');
    expect(sql.sql).toContain('"updated_at" >=');
    expect(sql.sql).toContain('"updated_at" <=');
    expect(sql.params).toEqual([owner, 'work', work, work, 'work', 'workshop', 'deleted', 'superseded',
      new Date(now.getTime() - BRAIN_RETIREMENT_SIGNAL_WINDOW_MS).toISOString(), now.toISOString()]);
  });
  it.each([{ userId: other }, { ownerId: other }, { scopeId: other }, { scopeType: 'global' }, { status: 'active' }])('never exposes another scope or an active record %j', patch => {
    return expect(readBrainRetirementSignals({ requester, now }, async () => [retired(patch)]))
      .resolves.toMatchObject({ retired: [] });
  });
  it('checks read authorization and does not use an expired retired identity', async () => {
    expect(await readBrainRetirementSignals({ requester, now }, async () => [retired({ expiresAt: '2026-10-14T00:00:00Z' })]))
      .toMatchObject({ retired: [] });
    const loopRequester = { ...requester, type: 'loop' as const, id: other, workId: work };
    expect(await readBrainRetirementSignals({ requester: loopRequester, now }, async () => [retired({ scopeType: 'work', status: 'superseded' })]))
      .toMatchObject({ retired: [{ id: memory, reason: 'superseded' }] });
  });
  it('does not scan global/chat/tool memories or expand a Work to other granted scopes', async () => {
    const query = vi.fn(async () => [retired()]);
    expect(await readBrainRetirementSignals({ requester: { type: 'chat', userId: owner, id: other }, now }, query))
      .toMatchObject({ status: 'not_applicable', retired: [] });
    expect(query).not.toHaveBeenCalled();
    await readBrainRetirementSignals({ requester, now, grants: [{ id: 'grant', userId: owner, subjectType: 'work', subjectId: work,
      scope: { type: 'global' }, permissions: ['reference'] }] }, query);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workId: work, userId: owner, limit: 201 }));
  });
  it('fails closed with distinct safe failure codes for unavailable, excessive or invalid retirement coverage', async () => {
    await expect(readBrainRetirementSignals({ requester, now }, async () => { throw Error('secret SQL'); }))
      .rejects.toMatchObject({ code: 'brain_retirement_signal_unavailable', message: 'brain_retirement_signal_unavailable' });
    await expect(readBrainRetirementSignals({ requester, now }, async () => Array.from({ length: 201 }, () => retired())))
      .rejects.toMatchObject({ code: 'brain_retirement_signal_too_many' });
    await expect(readBrainRetirementSignals({ requester, now }, async () => [retired({ updatedAt: 'bad date' })]))
      .rejects.toMatchObject({ code: 'brain_retirement_signal_invalid' });
  });
  it('keeps the queried time window at least as large as the maximum actual continuity TTL', () => {
    const request = { userId: owner, workshopId: work, currentRunId: other, scope: { kind: 'parent_run' as const, parentRunId: memory },
      policyIdentity: { version: 'v1', hash: 'a'.repeat(64) }, now, runs: [] };
    expect(resolveWorkingMemoryContinuity({ ...request, maxAgeMs: BRAIN_RETIREMENT_SIGNAL_WINDOW_MS }).reason).toBe('no_scoped_predecessor');
    expect(resolveWorkingMemoryContinuity({ ...request, maxAgeMs: BRAIN_RETIREMENT_SIGNAL_WINDOW_MS + 1 }).reason).toBe('invalid_continuity_request');
    expect(BRAIN_RETIREMENT_SIGNAL_LIMIT).toBe(200);
  });
});

describe('actual repository context path', () => {
  it('keeps active retrieval allowlists unchanged while deriving correction IDs from a real retired identity query', async () => {
    fixture.retired = [retired()];
    const pack = await buildBrainContextPackFromStore({ requester, now, taskIntent: 'Current experiment', statuses: ['active', 'verified'] });
    expect(pack.items).toEqual([]);
    expect(pack.omitted).toEqual([{ id: memory, reason: 'deleted' }]);
    expect(pack.selection.omittedCount).toBe(1);
    const context = brainContextPackToWorkshopMemoryContextPack({ taskIntent: 'Current experiment', pack });
    expect(context.correctionMemoryIds).toEqual([memory]);
    expect(resolveWorkingMemoryClaimGuard(context, { backend: 'brain' })).toMatchObject({ suppressHistoricalClaims: true, reason: 'brain_correction_detected' });
    const main = fixture.selects.filter(query => query.table === 'brain_memories' && query.columns === null);
    expect(main.length).toBeGreaterThan(0);
    for (const query of main) {
      const params = new PgDialect().sqlToQuery(query.where as never).params;
      expect(params).toContain('active'); expect(params).toContain('verified'); expect(params).not.toContain('deleted');
    }
    const metadata = fixture.logs[0].metadata as Record<string, unknown>;
    expect(metadata.retirementSignal).toMatchObject({ status: 'complete', scope: 'own_work_recent_retirements', workId: work });
    expect(JSON.stringify(pack)).not.toContain('content');
  });
  it('propagates retirement lookup failure rather than publishing a complete-looking canonical pack', async () => {
    fixture.queryFails = true;
    await expect(buildBrainContextPackFromStore({ requester, now, taskIntent: 'Current experiment' }))
      .rejects.toMatchObject({ code: 'brain_retirement_signal_unavailable' });
    expect(fixture.logs).toHaveLength(0);
    fixture.queryFails = false; fixture.retired = Array.from({ length: 201 }, () => retired());
    await expect(buildBrainContextPackFromStore({ requester, now, taskIntent: 'Current experiment' }))
      .rejects.toMatchObject({ code: 'brain_retirement_signal_too_many' });
    expect(fixture.logs).toHaveLength(0);
  });
});
