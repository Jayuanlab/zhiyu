import { queryBrainRetirementIdentities } from "../adapters/postgres/retirement-signals";
import type { BrainRetirementIdentity, BrainRetirementQuery } from "../records/retirement-signals";
export { queryBrainRetirementIdentities } from "../adapters/postgres/retirement-signals";
export type { BrainRetirementIdentity, BrainRetirementQuery } from "../records/retirement-signals";
import { canReadMemory } from '../revision/policy';
import type { BrainAccessGrant, BrainMemory, BrainRequester } from '../kernel/memory-types';

export const BRAIN_RETIREMENT_SIGNAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const BRAIN_RETIREMENT_SIGNAL_LIMIT = 200;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;


export type BrainRetirementSignal = {
  schemaVersion: 'brain-retirement-signal.v1'; scope: 'own_work_recent_retirements'; status: 'complete' | 'not_applicable';
  workId: string | null; checkedAt: string; windowStartedAt: string; limit: number;
  retired: Array<{ id: string; reason: 'deleted' | 'superseded' }>;
};
export class BrainRetirementSignalError extends Error {
  constructor(readonly code: 'brain_retirement_signal_unavailable' | 'brain_retirement_signal_too_many' | 'brain_retirement_signal_invalid') {
    super(code); this.name = 'BrainRetirementSignalError';
  }
}



/** A bounded own-work invalidation signal; it never adds retired content to selected memory. */
export async function readBrainRetirementSignals(input: { requester: BrainRequester; grants?: BrainAccessGrant[]; now?: Date },
  query: (input: BrainRetirementQuery) => Promise<BrainRetirementIdentity[]> = queryBrainRetirementIdentities): Promise<BrainRetirementSignal> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new BrainRetirementSignalError('brain_retirement_signal_invalid');
  const workId = input.requester.type === 'work' ? input.requester.id : input.requester.type === 'loop' ? input.requester.workId : undefined;
  const base = { schemaVersion: 'brain-retirement-signal.v1' as const, scope: 'own_work_recent_retirements' as const,
    workId: workId ?? null, checkedAt: now.toISOString(), windowStartedAt: new Date(now.getTime() - BRAIN_RETIREMENT_SIGNAL_WINDOW_MS).toISOString(),
    limit: BRAIN_RETIREMENT_SIGNAL_LIMIT, retired: [] as BrainRetirementSignal['retired'] };
  if (input.requester.type !== 'work' && input.requester.type !== 'loop') return { ...base, status: 'not_applicable' };
  if (!workId || !UUID.test(workId) || !UUID.test(input.requester.userId)
    || input.requester.workshopId && input.requester.workshopId !== workId) throw new BrainRetirementSignalError('brain_retirement_signal_invalid');
  let rows: BrainRetirementIdentity[];
  try {
    rows = await query({ userId: input.requester.userId, workId, updatedAfter: new Date(base.windowStartedAt), now,
      limit: BRAIN_RETIREMENT_SIGNAL_LIMIT + 1 });
  } catch {
    throw new BrainRetirementSignalError('brain_retirement_signal_unavailable');
  }
  if (rows.length > BRAIN_RETIREMENT_SIGNAL_LIMIT) throw new BrainRetirementSignalError('brain_retirement_signal_too_many');
  for (const row of rows) {
    if (row.userId !== input.requester.userId || row.ownerType !== 'work' || row.ownerId !== workId
      || row.scopeId !== workId || !['work', 'workshop'].includes(row.scopeType) || !['deleted', 'superseded'].includes(row.status)) continue;
    const updatedAt = new Date(row.updatedAt).getTime();
    if (!UUID.test(row.id) || !Number.isFinite(updatedAt) || updatedAt < Date.parse(base.windowStartedAt) || updatedAt > now.getTime()
      || row.expiresAt && !Number.isFinite(new Date(row.expiresAt).getTime())) throw new BrainRetirementSignalError('brain_retirement_signal_invalid');
    const identity: BrainMemory = { id: row.id, userId: row.userId,
      scope: row.scopeType === 'work' ? { type: 'work', workId } : { type: 'workshop', workshopId: workId },
      ownerType: 'work', ownerId: workId, memoryType: row.memoryType, status: row.status as 'deleted' | 'superseded',
      subject: '', content: '', confidence: 0, evidenceRefs: [], createdAt: new Date(updatedAt).toISOString(), updatedAt: new Date(updatedAt).toISOString(),
      ...(row.expiresAt ? { expiresAt: new Date(row.expiresAt).toISOString() } : {}) };
    if (canReadMemory({ memory: identity, requester: input.requester, grants: input.grants, now }).allowed)
      base.retired.push({ id: row.id, reason: row.status as 'deleted' | 'superseded' });
  }
  return { ...base, status: 'complete', retired: [...new Map(base.retired.map(row => [row.id, row])).values()] };
}
