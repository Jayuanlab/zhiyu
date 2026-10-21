import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const fixture = vi.hoisted(() => ({ rows: [] as any[], overflow: false, failed: false,
  queries: [] as Array<{ sql: string; params: unknown[]; limit: number }>, logs: [] as Array<Record<string, any>> }));
vi.mock('@/lib/db/client', () => {
  const store = {
    select(columns?: unknown) {
      let table = '', where: unknown;
      const chain = { from(value: unknown) { table = getTableName(value as never); return chain; },
        where(value: unknown) { where = value; return chain; }, orderBy() { return chain; },
        async limit(limit: number) {
          const query = new PgDialect().sqlToQuery(where as never); fixture.queries.push({ ...query, limit });
          if (!columns && table === 'brain_memories' && query.params.includes('owner_statement')) {
            if (fixture.failed) throw Error('private SQL failure');
            return fixture.overflow ? Array.from({ length: 31 }, () => fixture.rows[0]) : fixture.rows;
          }
          return [];
        } };
      return chain;
    },
    insert() { return { values(value: Record<string, any>) { fixture.logs.push(value); return { returning: async () => [{ ...value, id: 'context-log' }] }; } }; },
  };
  return { db: store };
});
vi.mock('@/lib/memory/revision/transaction', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/memory/revision/transaction')>(),
  withMemoryRecordWrite: async (_owner: string, _kind: string, write: (store: unknown) => Promise<{ result: unknown }>) => {
    const { db } = await import('@/lib/db/client'); return (await write(db)).result;
  },
}));
import { buildBrainContextPackFromStore, brainMemoryToInsertRow, brainMemoryFromRow } from '@/lib/brain/repository';
import { getBrainMemoryRevisionVersion } from '@/lib/brain/memory-revision-version';
import { brainContextPackToWorkshopMemoryContextPack } from '@/lib/brain/workshop-memory';
import { formatWorkshopMemoryContextPack } from '@/lib/workshops/memory-context';
import type { BrainMemory } from '@/lib/brain/types';

const owner = '11111111-1111-4111-a111-111111111111', work = '22222222-2222-4222-a222-222222222222';
const id = '33333333-3333-4333-a333-333333333333', other = '44444444-4444-4444-a444-444444444444';
const now = new Date('2026-10-16T10:00:00Z');
const requester = { type: 'work' as const, userId: owner, id: work, workshopId: work };
function correction(patch: Partial<BrainMemory> = {}): BrainMemory {
  return { id, userId: owner, scope: { type: 'work', workId: work }, ownerType: 'work', ownerId: work,
    memoryType: 'insight', subject: 'Current research source conditions', content: 'Owner correction: inspect current source conditions and limitations first.',
    confidence: 25, status: 'active', evidenceRefs: ['owner-observation'], supersedes: ['old-memory'],
    createdAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:00:00Z',
    metadata: { revision: { operation: 'correct', authority: 'owner_statement', reviewStatus: 'applied',
      createdAt: '2026-10-16T09:00:00Z', independentlyVerifiesBusinessFact: false } }, ...patch };
}
const request = (): Parameters<typeof buildBrainContextPackFromStore>[0] => ({ requester, now, taskIntent: 'Research current source conditions and limitations',
  statuses: ['active', 'verified'], memoryTypes: ['fact'], canonicalKinds: ['fact'],
  minConfidence: 60, searchTerms: ['restrictive planner term'], maxItems: 10, reserveCurrentOwnerCorrections: true });
async function read(overrides: Record<string, unknown> = {}) {
  return buildBrainContextPackFromStore({ ...request(), ...overrides });
}
beforeEach(() => { fixture.rows = [brainMemoryToInsertRow(correction())]; fixture.overflow = false; fixture.failed = false; fixture.queries = []; fixture.logs = []; });

describe('bounded current owner correction control feedback', () => {
  it('recalls an applied low-confidence owner correction despite advisory confidence/type/canonical/search filters without altering its version', async () => {
    const original = structuredClone(fixture.rows);
    const storedVersion = getBrainMemoryRevisionVersion(brainMemoryFromRow(structuredClone(fixture.rows[0])));
    const pack = await read();
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0]).toMatchObject({ id, content: correction().content, confidence: 25, status: 'active',
      revisionVersion: storedVersion });
    expect(pack.items[0].reasons).toContain('relevant_recent_revision');
    expect(pack.items[0].reasons).toContain('reserved_relevant_revision');
    expect(pack.items[0].warnings).toContain('owner_statement_control_feedback_not_verified_fact');
    const modelContext = brainContextPackToWorkshopMemoryContextPack({ taskIntent: request().taskIntent, pack });
    expect(modelContext.taskRelevantMemories[0]).toMatchObject({ id, confidence: 25, status: 'active', revisionVersion: storedVersion });
    expect(modelContext.taskRelevantMemories[0].score).toBeGreaterThan(25);
    expect(modelContext.taskRelevantMemories[0].reasons).toContain('warning:owner_statement_control_feedback_not_verified_fact');
    expect(formatWorkshopMemoryContextPack(modelContext)).toContain('confidence=25%');
    expect(fixture.rows[0]).toMatchObject({ content: original[0].content, confidence: original[0].confidence,
      status: original[0].status, metadata: { revision: original[0].metadata.revision } });
    expect(fixture.rows[0]).toMatchObject({ confidence: 25, status: 'active' });
    expect(fixture.logs[0].metadata).toMatchObject({ ownerCorrectionReserve: { enabled: true, fetchedCount: 1,
      relatedMemoryIds: [id], selectedMemoryIds: [id], limit: 30, scope: 'own_work_recent_applied_owner_corrections' }, combinedCandidateCount: 1 });
    const query = fixture.queries.find(query => query.params.includes('owner_statement'))!;
    expect(query.limit).toBe(31);
    expect(query.params).toContain(owner); expect(query.params).toContain(work);
    expect(query.params).toContain('correct'); expect(query.params).toContain('applied');
    expect(query.params).not.toContain(60); expect(query.params).not.toContain('restrictive planner term');
    expect(query.params).not.toContain('fact'); expect(query.params).not.toContain('candidate');
    expect(query.sql).toContain('"owner_id" ='); expect(query.sql).toContain('"scope_type" =');
  });
  it('does not retrieve special candidates when the trusted caller disables the normal-risk reserve', async () => {
    expect((await read({ reserveCurrentOwnerCorrections: false })).items).toEqual([]);
    expect(fixture.queries.some(query => query.params.includes('owner_statement'))).toBe(false);
    expect(fixture.logs[0].metadata.ownerCorrectionReserve.enabled).toBe(false);
  });
  it.each([
    { status: 'candidate' }, { status: 'weakened' }, { userId: other }, { ownerId: other },
    { expiresAt: '2026-10-16T09:59:59Z' },
    { scope: { type: 'work', workId: other } },
    { metadata: { revision: { operation: 'correct', authority: 'external_fact', reviewStatus: 'applied', createdAt: '2026-10-16T09:00:00Z' } } },
    { metadata: { revision: { operation: 'correct', authority: 'owner_statement', reviewStatus: 'pending_verification', createdAt: '2026-10-16T09:00:00Z' } } },
    { metadata: { revision: { operation: 'correct', authority: 'owner_statement', reviewStatus: 'applied', createdAt: '2026-10-01T09:00:00Z' } } },
  ])('preserves status, ownership, scope, authority and review boundaries: %j', patch => {
    fixture.rows = [brainMemoryToInsertRow(correction(patch as Partial<BrainMemory>))];
    return expect(read()).resolves.toMatchObject({ items: [] });
  });
  it('does not turn an unrelated recent owner correction into task evidence', async () => {
    fixture.rows = [brainMemoryToInsertRow(correction({ subject: 'Unrelated vacation', content: 'Prefer mountain cabins.' }))];
    expect((await read()).items).toEqual([]);
  });
  it('keeps hard source/privacy filters active after bypassing planner suggestions', async () => {
    const value = correction(); value.metadata = { ...value.metadata, facets: { privacyClass: 'private' } };
    fixture.rows = [brainMemoryToInsertRow(value)];
    expect((await read({ sourceFilters: { excludePrivacyClasses: ['private'] } })).items).toEqual([]);
  });
  it('uses the existing maximum of two reserved recent revisions', async () => {
    fixture.rows = Array.from({ length: 3 }, (_, index) => brainMemoryToInsertRow(correction({
      id: `0000000${index}-aaaa-4aaa-aaaa-00000000000${index}`, subject: `Current source conditions ${index}`,
      content: `Current source correction ${index}: inspect the current source conditions and limitations.`,
      evidenceRefs: [`owner-observation-${index}`],
    })));
    const pack = await read();
    expect(pack.items).toHaveLength(2);
    expect(pack.items.filter(item => item.reasons.includes('reserved_relevant_revision'))).toHaveLength(2);
    expect(fixture.logs[0].metadata.ownerCorrectionReserve).toMatchObject({ relatedCountBeforeLimit: 3, maxReservedCorrections: 2 });
  });
  it('fails closed with safe codes on incomplete overflow or query failure', async () => {
    fixture.overflow = true;
    await expect(read()).rejects.toThrow('brain_owner_correction_reserve_too_many');
    expect(fixture.logs).toEqual([]);
    fixture.overflow = false; fixture.failed = true;
    await expect(read()).rejects.toThrow('brain_owner_correction_reserve_unavailable');
  });
});
