import { describe, expect, it } from 'vitest';
import { buildBrainContextPack } from '@/lib/brain/context';
import { brainContextPackToWorkshopMemoryContextPack } from '@/lib/brain/workshop-memory';
import { hasWorkshopMemoryCorrections, resolveWorkingMemoryClaimGuard } from '@/lib/workshops/memory-context';
import type { BrainMemory } from '@/lib/brain/types';

const base: BrainMemory = { id: 'current', userId: 'owner', scope: { type: 'work', workId: 'work' }, ownerType: 'work', ownerId: 'work',
  memoryType: 'preference', subject: 'Report format', content: 'Prefer a concise report.', status: 'verified', confidence: 80,
  evidenceRefs: ['source'], createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' };
function selected(memories: BrainMemory[]) {
  return brainContextPackToWorkshopMemoryContextPack({ taskIntent: 'report format', pack: buildBrainContextPack({
    requester: { type: 'work', userId: 'owner', id: 'work', workshopId: 'work' }, taskIntent: 'report format', memories,
    now: new Date('2026-10-16T01:00:00.000Z'),
  }) });
}
describe('current Brain revisions versus historical notebook claims', () => {
  it('does not clear history just because an ordinary preference was recalled', () => {
    const context = selected([base]);
    expect(context.taskRelevantMemories).toHaveLength(1);
    expect(context.taskRelevantMemories[0].reasons).toContain('brain_context');
    expect(hasWorkshopMemoryCorrections(context)).toBe(false);
  });
  it('carries an exact replacement identity into the runtime context and suppresses old claims', () => {
    const context = selected([{ ...base, supersedes: ['previous'], content: 'Use the corrected report format.' }]);
    expect(context.taskRelevantMemories[0].supersedes).toEqual(['previous']);
    expect(hasWorkshopMemoryCorrections(context)).toBe(true);
  });
  it('suppresses history when an owned source has been retired even without an active replacement', () => {
    const context = selected([{ ...base, status: 'deleted' }]);
    expect(context.taskRelevantMemories).toHaveLength(0);
    expect(context.correctionMemoryIds).toEqual(['current']);
    expect(hasWorkshopMemoryCorrections(context)).toBe(true);
  });
  it('does not use a denied other-work retirement to alter this task state', () => {
    const context = selected([{ ...base, ownerId: 'other', scope: { type: 'work', workId: 'other' }, status: 'deleted' }]);
    expect(hasWorkshopMemoryCorrections(context)).toBe(false);
  });
  it.each([undefined, null, { backend: 'legacy' }, { backend: 'unavailable' }])('suppresses historical assertions when canonical Brain state is unknown: %j', recall => {
    expect(resolveWorkingMemoryClaimGuard(selected([base]), recall)).toMatchObject({
      suppressHistoricalClaims: true, reason: 'brain_state_unavailable', warnings: [expect.stringContaining('Brain')],
    });
  });
  it.each(['failed', 'degraded', 'skipped', 'planned'])('fails closed on an explicitly incomplete primary brain_memory route: %s', status => {
    expect(resolveWorkingMemoryClaimGuard(selected([base]), { backend: 'brain', routeResults: [{ route: 'brain_memory', status }] }))
      .toMatchObject({ suppressHistoricalClaims: true, reason: 'brain_state_unavailable' });
  });
  it('preserves ordinary notes when canonical recall succeeds despite auxiliary route failures or planner fallback', () => {
    const context = selected([base]);
    expect(resolveWorkingMemoryClaimGuard(context, { backend: 'brain', routeResults: [] }))
      .toEqual({ suppressHistoricalClaims: false, reason: null, warnings: [] });
    expect(resolveWorkingMemoryClaimGuard(context, { backend: 'brain', routeResults: [
      { route: 'knowledge_store', status: 'failed', error: 'RAG unavailable' },
      { route: 'memory_graph', status: 'degraded' }, { route: 'evidence_read', status: 'planned' },
    ] })).toEqual({ suppressHistoricalClaims: false, reason: null, warnings: [] });
    expect(resolveWorkingMemoryClaimGuard(context, { backend: 'brain', routeResults: [{ route: 'brain_memory', status: 'executed' }] }))
      .toEqual({ suppressHistoricalClaims: false, reason: null, warnings: [] });
  });
  it('distinguishes actual corrections from unavailable Brain state', () => {
    const context = selected([{ ...base, supersedes: ['previous'] }]);
    expect(resolveWorkingMemoryClaimGuard(context, { backend: 'brain' }))
      .toEqual({ suppressHistoricalClaims: true, reason: 'brain_correction_detected', warnings: [] });
  });
});
