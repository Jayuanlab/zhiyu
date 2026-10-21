import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceSourceReader } from '@/lib/memory/evidence/ports';

const sql = vi.hoisted(() => ({ queries: [] as Array<{ table: unknown; condition: unknown }> }));
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  or: (...conditions: unknown[]) => ({ op: 'or', conditions }),
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  inArray: (left: unknown, values: unknown) => ({ op: 'inArray', left, values }),
}));
vi.mock('@/lib/db/client', () => ({ db: { select: () => ({ from: (table: unknown) => ({
  where: async (condition: unknown) => { sql.queries.push({ table, condition }); return []; },
}) }) } }));
vi.mock('@/lib/db/schema', () => ({
  brainObservations: { id: 'observation.id', userId: 'observation.userId' },
  interactionEvents: { id: 'interaction.id', userId: 'interaction.userId' },
  rawMessages: { id: 'raw.id', messageId: 'raw.messageId', userId: 'raw.userId' },
  workshopEvents: { id: 'event.id', workshopId: 'event.workshopId' },
  workshops: { id: 'work.id', userId: 'work.userId' },
}));

import { createEvidenceReader, resolveEvidenceRefs } from '@/lib/memory/evidence/reader';
import { groupResolvedEvidenceRoots } from '@/lib/memory/evidence/lineage';
import { observationIdFromEvidenceRef } from '@/lib/memory/evidence/references';
import { postgresEvidenceSources } from '@/lib/memory/adapters/postgres/evidence-sources';
import { resolveBrainEvidenceRefs } from '@/lib/brain/evidence-reader';
import { groupResolvedEvidenceRoots as legacyGrouping } from '@/lib/brain/evidence-lineage';

const owner = 'owner-fixture';
const observationId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const workId = '33333333-3333-4333-8333-333333333333';
function sourcePort(): EvidenceSourceReader {
  return { readObservations: vi.fn(async () => []), readInteractionEvents: vi.fn(async () => []),
    readRawMessages: vi.fn(async () => []), readWorkshopEvents: vi.fn(async () => []) };
}
beforeEach(() => { sql.queries = []; });

describe('memory evidence capability', () => {
  it('is the actual implementation behind both legacy compatibility exports', () => {
    expect(resolveBrainEvidenceRefs).toBe(resolveEvidenceRefs);
    expect(legacyGrouping).toBe(groupResolvedEvidenceRoots);
  });

  it('resolves typed observations and groups only explicitly associated, already read event roots', async () => {
    const port = sourcePort();
    vi.mocked(port.readObservations).mockResolvedValue([{ id: observationId, sourceType: 'interaction_event', sourceId: 'source',
      sourceEventId: eventId, content: 'Observed source statement', observedAt: new Date('2026-10-20T00:00:00Z'), contentHash: 'hash' }]);
    vi.mocked(port.readInteractionEvents).mockResolvedValue([{ id: eventId, contentPreview: 'Original event body' }]);
    const evidence = await createEvidenceReader(port)({ userId: owner, evidenceRefs: [`brain-observation:${observationId}`, eventId],
      ownerHintsByRef: new Map([[eventId, [{ ownerType: 'chat', ownerId: owner }]]]) });
    expect(port.readObservations).toHaveBeenCalledWith({ userId: owner, ids: [observationId] });
    expect(evidence[0]).toMatchObject({ id: `brain-observation:${observationId}`, status: 'resolved', content: 'Observed source statement' });
    expect(groupResolvedEvidenceRoots(evidence)).toMatchObject({ resolvedRootGroups: 1, overlappingResolvedRefs: 1 });
  });

  it('does not infer a source for a bare UUID or treat malformed references as paths', async () => {
    const port = sourcePort();
    const refs = [observationId, 'brain-observation:../../private', 'D:/private/source.txt'];
    const evidence = await createEvidenceReader(port)({ userId: owner, evidenceRefs: refs });
    expect(evidence.map(item => item.status)).toEqual(['unresolved', 'unresolved', 'unresolved']);
    for (const reader of Object.values(port)) expect(reader).not.toHaveBeenCalled();
    expect(observationIdFromEvidenceRef(`brain-observation:${observationId}`)).toBe(observationId);
    expect(observationIdFromEvidenceRef(observationId)).toBeNull();
  });

  it('retains raw alias ambiguity and does not expose either body through the ambiguous ref', async () => {
    const port = sourcePort();
    vi.mocked(port.readRawMessages).mockResolvedValue([{ id: 42, messageId: 'message-42', content: 'first' },
      { id: 43, messageId: '42', content: 'second' }]);
    const evidence = await createEvidenceReader(port)({ userId: owner, evidenceRefs: ['raw-message:42', 'legacy-raw-message:message-42'] });
    expect(evidence[0]).toMatchObject({ status: 'unresolved', content: null, metadata: { reason: 'ambiguous_reference' } });
    expect(evidence[0].resolvedIdentity).toBeUndefined();
    expect(evidence[1]).toMatchObject({ status: 'resolved', content: 'first' });
  });

  it('deduplicates and retains the established 100-reference read bound', async () => {
    const port = sourcePort();
    const refs = Array.from({ length: 101 }, (_, index) => `raw-message:${index + 1}`);
    const evidence = await createEvidenceReader(port)({ userId: owner, evidenceRefs: [refs[0], ...refs] });
    expect(evidence).toHaveLength(100);
    expect(evidence.at(-1)?.id).toBe('raw-message:100');
    expect(port.readRawMessages).toHaveBeenCalledExactlyOnceWith({ userId: owner,
      numericIds: Array.from({ length: 100 }, (_, index) => index + 1),
      messageIds: Array.from({ length: 100 }, (_, index) => String(index + 1)) });
  });

  it('keeps invalid Work owner hints unresolved without broadening to another source', async () => {
    const port = sourcePort();
    const evidence = await createEvidenceReader(port)({ userId: owner, evidenceRefs: [eventId],
      ownerHintsByRef: new Map([[eventId, [{ ownerType: 'work', ownerId: 'invalid-work' }]]]) });
    expect(evidence[0]).toMatchObject({ status: 'unresolved', content: null });
    for (const reader of Object.values(port)) expect(reader).not.toHaveBeenCalled();
  });

  it('propagates unavailable storage instead of returning a false unresolved success', async () => {
    const port = sourcePort();
    vi.mocked(port.readObservations).mockRejectedValue(Error('source storage unavailable'));
    await expect(createEvidenceReader(port)({ userId: owner, evidenceRefs: [`brain-observation:${observationId}`] }))
      .rejects.toThrow('source storage unavailable');
  });

  it('keeps all exact source queries owner-scoped in the actual PostgreSQL adapter', async () => {
    await postgresEvidenceSources.readObservations({ userId: owner, ids: [observationId] });
    await postgresEvidenceSources.readInteractionEvents({ userId: owner, ids: [eventId] });
    await postgresEvidenceSources.readRawMessages({ userId: owner, numericIds: [42], messageIds: ['42'] });
    await postgresEvidenceSources.readWorkshopEvents({ userId: owner, workshopId: workId, ids: [eventId] });
    expect(sql.queries[0].condition).toMatchObject({ op: 'and', conditions: expect.arrayContaining([
      { op: 'eq', left: 'observation.userId', right: owner }, { op: 'inArray', left: 'observation.id', values: [observationId] },
    ]) });
    expect(sql.queries[1].condition).toMatchObject({ op: 'and', conditions: expect.arrayContaining([
      { op: 'eq', left: 'interaction.userId', right: owner },
    ]) });
    expect(sql.queries[2].condition).toMatchObject({ op: 'and', conditions: expect.arrayContaining([
      { op: 'eq', left: 'raw.userId', right: owner },
    ]) });
    expect(sql.queries[3].condition).toEqual({ op: 'eq', left: 'work.userId', right: owner });
    expect(sql.queries[4].condition).toMatchObject({ op: 'and', conditions: expect.arrayContaining([
      { op: 'eq', left: 'event.workshopId', right: workId }, { op: 'inArray', left: 'event.id', values: [eventId] },
      expect.objectContaining({ op: 'inArray', left: 'event.workshopId' }),
    ]) });
  });
});
