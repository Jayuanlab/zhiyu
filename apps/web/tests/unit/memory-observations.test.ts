import { describe, expect, it, vi } from 'vitest';
import type { ObservationRecord } from '@/lib/memory/contracts';

const storage = vi.hoisted(() => ({ upsert: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/memory/adapters/postgres/observations', () => ({
  upsertObservation: storage.upsert, listObservationsForUser: storage.list,
}));

import { createObservation, hashObservation } from '@/lib/memory/ingestion/observations';
import { observationFromRow, observationToInsertRow, observationVersion, stableJson } from '@/lib/memory/records/observations';

function record(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return { id: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
    sourceType: 'manual', sourceId: 'fixture-source', observedAt: '2026-10-20T00:00:00.000Z',
    content: 'Original source content', contentHash: 'legacy-not-authoritative', trustLevel: 'raw',
    metadata: { nested: { b: 2, a: 1 }, tags: ['first', 'second'] }, createdAt: '2026-10-20T01:00:00.000Z', ...overrides };
}

describe('memory observation pure contracts', () => {
  it('keeps hashing stable for the same Date or ISO instant and changes with source/content', () => {
    const input = record();
    expect(hashObservation(input)).toBe(hashObservation({ ...input, observedAt: new Date(input.observedAt) }));
    expect(hashObservation(input)).toMatch(/^[a-f0-9]{64}$/);
    for (const changed of [{ content: 'Changed content' }, { sourceType: 'other' }, { sourceId: 'other' },
      { observedAt: '2026-10-20T00:00:01.000Z' }]) expect(hashObservation({ ...input, ...changed })).not.toBe(hashObservation(input));
  });

  it('derives versions from actual content/provenance rather than a stored hash or insertion timestamp', () => {
    const original = record(), version = observationVersion(original);
    expect(version).toMatchObject({ record: { kind: 'observation', id: original.id }, revision: expect.stringMatching(/^obsrv1:[a-f0-9]{64}$/) });
    expect(observationVersion(record({ contentHash: 'forged-same-hash', createdAt: '2026-10-21T00:00:00.000Z' }))).toEqual(version);
    for (const changed of [{ content: 'Changed content' }, { trustLevel: 'asserted' }, { userId: '33333333-3333-4333-8333-333333333333' },
      { sourceEventId: '44444444-4444-4444-8444-444444444444' }, { metadata: { changed: true } }]) {
      expect(observationVersion(record(changed)).revision).not.toBe(version.revision);
    }
  });

  it('treats metadata object key ordering as irrelevant but preserves array ordering and nested changes', () => {
    const original = record();
    expect(observationVersion(record({ metadata: { tags: ['first', 'second'], nested: { a: 1, b: 2 } } }))).toEqual(observationVersion(original));
    expect(observationVersion(record({ metadata: { tags: ['second', 'first'], nested: { a: 1, b: 2 } } }))).not.toEqual(observationVersion(original));
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('round trips actual row mapping without losing source metadata or trusted observation time', () => {
    const input = record({ sourceEventId: '44444444-4444-4444-8444-444444444444' });
    expect(observationToInsertRow(input)).toMatchObject({ id: input.id, sourceEventId: input.sourceEventId,
      observedAt: new Date(input.observedAt), metadata: input.metadata });
    const row = { ...input, sourceEventId: input.sourceEventId ?? null,
      observedAt: new Date(input.observedAt), createdAt: new Date(input.createdAt) };
    expect(observationFromRow(row)).toEqual(input);
    expect(() => observationFromRow({ ...row, observedAt: new Date('invalid') })).toThrow('Invalid stored observation timestamp');
  });

  it('retains the reserved correction-source barrier on compatibility ingestion', async () => {
    storage.upsert.mockClear();
    await expect(createObservation({ ...record(), sourceType: 'owner_memory_correction_intent' }))
      .rejects.toMatchObject({ code: 'reserved_correction_observation', status: 400 });
    expect(storage.upsert).not.toHaveBeenCalled();
  });
});
