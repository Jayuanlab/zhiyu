import { describe, expect, it } from 'vitest';
import type { WorkingMemorySnapshot } from '@openzhiyu/ai/agent/runtime/host-working-memory';
import { checkWorkingMemoryDelivery } from '@/lib/workshops/working-memory-delivery-contract';
import { inspectWorkingMemoryCheckpoint, inspectWorkingMemoryCheckpointProof, resolveWorkingMemoryContinuity } from '@/lib/workshops/working-memory-continuity';
import { promotionEvents, promotionRunId, promotionUserId, promotionWorkId } from '../fixtures/working-memory-promotion';

const now = new Date('2026-10-13T00:01:00.000Z');
const futureRunId = '99999999-9999-4999-a999-999999999999';
const loopId = '77777777-7777-4777-a777-777777777777';
const policyIdentity = { version: 'memact-automem.v1', hash: 'c'.repeat(64) };
function fixture(loop = false) {
  const events = promotionEvents();
  if (loop) for (const event of events) {
    event.runId = futureRunId; event.loopId = loopId; event.loopRunId = promotionRunId;
  }
  Object.assign(events[1].metadata, { operation: 'update', phase: 'LOG', commandId: 'save-1',
    previousVersion: 0, logCount: 1, catalogSummary: { truncated: false } });
  const state = { facts: [{ text: 'Observed one source window; interpretation remains unverified.', evidenceIds: ['read-1'] }],
    hypotheses: [], openQuestions: ['Does the remaining source window change the interpretation?'],
    nextAction: { text: 'Check the remaining original source before making a claim.', evidenceIds: ['read-1'] } };
  events[1].metadata.state = state;
  const catalog = events[1].metadata.evidenceCatalog as WorkingMemorySnapshot['evidenceCatalog'];
  const snapshot: WorkingMemorySnapshot = { schemaVersion: 'host-working-memory.v1', authority: 'model-authored-unverified',
    mode: 'apply', version: 1, editCount: 1, maxEdits: 4, maxSummaryChars: 6000, state: structuredClone(state),
    pruneToolCallIds: [], directory: catalog, evidenceCatalog: catalog, projectionCandidates: [],
    catalogSummary: { evidenceCount: 1, referenceEligibleCount: 1, projectionCandidateCount: 0, blockedCount: 1,
      blockedReasons: [], truncated: false }, directoryTruncated: false, retainedReadCautions: [], policyIdentity,
    phase: 'LOG', readCount: 0, logCount: 1, planCount: 0, stateScope: 'complete', indexedNotes: [] };
  return { contract: { required: true, requireFreshSource: true }, scope: {
    userId: promotionUserId, workshopId: promotionWorkId, runId: promotionRunId,
    loopId: loop ? loopId : null, startedAt: '2026-10-12T23:59:00.000Z', policyIdentity,
  }, snapshot, durableEvents: events, now, attempt: 0 };
}
function repeatedSourceFixture() {
  const input = fixture(true);
  const catalog = input.durableEvents[1].metadata.evidenceCatalog as WorkingMemorySnapshot['evidenceCatalog'];
  // Four notes reference one legitimate, richly described source. The stored
  // notebook is small; the historical representation repeats this provenance.
  catalog[0].sourceIdentity.url = `https://example.test/source?locator=${'a'.repeat(1_600)}`;
  input.snapshot.state.facts.push({ text: 'A second bounded observation of the same source.', evidenceIds: ['read-1'] });
  input.snapshot.state.hypotheses = [{ text: 'A working interpretation that still needs checking.', evidenceIds: ['read-1'] }];
  input.durableEvents[1].metadata.state = structuredClone(input.snapshot.state);
  return input;
}

describe('opt-in current-run working-memory delivery', () => {
  it('leaves ordinary tasks alone and never treats task text or a prior checkpoint as opt-in', () => {
    expect(checkWorkingMemoryDelivery({ ...fixture(), contract: undefined, snapshot: null, durableEvents: [] }))
      .toMatchObject({ ok: true, status: 'not_required', checkpoint: null });
  });
  it.each([false, true])('requires a genuine current-scope LOG and exact host snapshot: loop=%s', loop => {
    const input = fixture(loop), before = structuredClone(input);
    const result = checkWorkingMemoryDelivery(input);
    expect(result).toMatchObject({ ok: true, status: 'satisfied', checkpoint: {
      eventId: input.durableEvents[1].id, version: 1, sourceEventIds: [input.durableEvents[0].id], toolCallIds: ['read-1'],
    } });
    expect(input).toEqual(before);
  });
  it('has at most one correction opportunity and feedback grants no tools or invented IDs', () => {
    const input = { ...fixture(), durableEvents: [] };
    const first = checkWorkingMemoryDelivery(input);
    expect(first).toMatchObject({ ok: false, status: 'needs_correction', code: 'no_audited_checkpoint' });
    expect(first.feedback).toContain('operation=update');
    expect(first.feedback).toContain('evidenceCatalog.toolCallId');
    expect(first.feedback).not.toContain('"read-1"');
    expect(checkWorkingMemoryDelivery({ ...input, attempt: 1 })).toMatchObject({ ok: false, status: 'failed' });
  });
  it('does not mistake LOG followed by a read (snapshot phase PLAN) for an unsaved checkpoint', () => {
    const input = fixture(); input.snapshot.phase = 'PLAN'; input.snapshot.readCount = 1; input.snapshot.planCount = 1;
    expect(checkWorkingMemoryDelivery(input).status).toBe('satisfied');
  });
  it.each(['version', 'state', 'policy', 'query'])('rejects a host snapshot mismatch: %s', changed => {
    const input = fixture();
    if (changed === 'version') input.snapshot.version = 2;
    if (changed === 'state') input.snapshot.state.openQuestions = ['A different notebook.'];
    if (changed === 'policy') input.snapshot.policyIdentity = { ...policyIdentity, hash: 'd'.repeat(64) };
    if (changed === 'query') input.snapshot.stateScope = 'query';
    expect(checkWorkingMemoryDelivery(input)).toMatchObject({ ok: false, status: 'needs_correction', code: 'checkpoint_snapshot_mismatch' });
  });
  it.each(['read', 'PLAN', 'shadow', 'restore', 'text'])('counts neither %s nor a previous LOG count as delivery', kind => {
    const input = fixture();
    if (kind === 'read') input.durableEvents = input.durableEvents.filter(event => event.type !== 'working_memory_updated');
    if (kind === 'PLAN') input.durableEvents[1].metadata.phase = 'PLAN';
    if (kind === 'shadow') input.durableEvents[1].metadata.mode = 'shadow';
    if (kind === 'restore') input.durableEvents.push({ ...input.durableEvents[1], seq: 4, id: futureRunId,
      type: 'working_memory_restored', metadata: { ...input.durableEvents[1].metadata, operation: 'restore', version: 2 } });
    if (kind === 'text') input.durableEvents[1].type = 'insight_logged';
    expect(checkWorkingMemoryDelivery(input).ok).toBe(false);
  });
  it('requires source-bound notes plus actionable or unresolved progress, not an empty accepted update', () => {
    const input = fixture();
    const state = { facts: [], hypotheses: [], openQuestions: ['A source-free question.'], nextAction: { text: '', evidenceIds: [] } };
    input.snapshot.state = state; input.durableEvents[1].metadata.state = structuredClone(state);
    expect(checkWorkingMemoryDelivery(input)).toMatchObject({ ok: false, code: 'checkpoint_has_no_bound_source' });
    const noProgress = fixture(); noProgress.snapshot.state.openQuestions = []; noProgress.snapshot.state.nextAction = { text: '', evidenceIds: [] };
    noProgress.durableEvents[1].metadata.state = structuredClone(noProgress.snapshot.state);
    expect(checkWorkingMemoryDelivery(noProgress)).toMatchObject({ ok: false, code: 'checkpoint_has_no_progress' });
  });
  it('accepts honestly uncertain source-bound hypotheses without demanding a fact or a pruned result', () => {
    const input = fixture(); input.snapshot.state.facts = [];
    input.snapshot.state.hypotheses = [{ text: 'This source may support the working interpretation; it remains unverified.', evidenceIds: ['read-1'] }];
    input.snapshot.state.nextAction = { text: '', evidenceIds: [] };
    input.durableEvents[1].metadata.state = structuredClone(input.snapshot.state);
    expect(checkWorkingMemoryDelivery(input)).toMatchObject({ ok: true, status: 'satisfied', checkpoint: {
      sourceEventIds: [input.durableEvents[0].id], hasOpenQuestions: true, hasNextAction: false,
    } });
    expect(input.snapshot.pruneToolCallIds).toEqual([]);
  });
  it.each(['sourceId', 'hash', 'window', 'version', 'revoked', 'foreign', 'catalog'])('rejects invalid durable source binding: %s', kind => {
    const input = fixture();
    if (kind === 'sourceId') input.durableEvents[0].id = futureRunId;
    if (kind === 'hash') input.durableEvents[0].metadata.contentHash = 'd'.repeat(64);
    if (kind === 'window') input.durableEvents[0].metadata.offset = 1;
    if (kind === 'version') input.durableEvents[0].metadata.sourceVersion = 'changed';
    if (kind === 'revoked') input.durableEvents.push({ ...input.durableEvents[0], id: futureRunId, seq: 4,
      metadata: { receiptAuthority: 'runtime', sourceEventId: input.durableEvents[0].id, revoked: true } });
    if (kind === 'foreign') input.durableEvents[0].runId = futureRunId;
    if (kind === 'catalog') input.durableEvents[1].metadata.catalogSummary = { truncated: true };
    expect(checkWorkingMemoryDelivery(input).ok).toBe(false);
  });
  it('fails closed on truncated event reads or an unavailable host snapshot', () => {
    expect(checkWorkingMemoryDelivery({ ...fixture(), eventsTruncated: true }).ok).toBe(false);
    expect(checkWorkingMemoryDelivery({ ...fixture(), snapshot: null }).ok).toBe(false);
  });
  it('makes fresh-source opt-in explicit while ordinary progress checkpoints remain possible', () => {
    const input = fixture();
    input.snapshot.state = { facts: [], hypotheses: [], openQuestions: ['The authorized source is not available yet.'],
      nextAction: { text: '', evidenceIds: [] } };
    input.durableEvents[1].metadata.state = structuredClone(input.snapshot.state);
    expect(checkWorkingMemoryDelivery({ ...input, contract: { required: true } }))
      .toMatchObject({ ok: true, checkpoint: { sourceEventIds: [], hasOpenQuestions: true } });
    expect(checkWorkingMemoryDelivery(input)).toMatchObject({ ok: false, code: 'checkpoint_has_no_bound_source' });
  });
  it.each(['time', 'tool', 'evidence', 'range', 'identity', 'expired', 'authority'])('cannot substitute a source receipt with mismatched %s', kind => {
    const input = fixture();
    if (kind === 'time') input.durableEvents[0].createdAt = '2026-10-12T23:58:59.999Z';
    if (kind === 'tool') input.durableEvents[0].metadata.toolName = 'otherRead';
    if (kind === 'evidence') input.durableEvents[0].metadata.evidenceId = 'other-page';
    if (kind === 'range') input.durableEvents[0].metadata.contentLength = 999;
    if (kind === 'identity') input.durableEvents[0].metadata.toolUseId = 'other-call';
    if (kind === 'expired') input.durableEvents[0].metadata.expiresAt = now.toISOString();
    if (kind === 'authority') input.durableEvents[0].metadata.receiptAuthority = 'model';
    expect(checkWorkingMemoryDelivery(input).ok).toBe(false);
  });
  it('never mixes Loop events, duplicate event identities or duplicate sequence numbers', () => {
    const foreign = fixture(true); foreign.durableEvents[0].loopId = futureRunId;
    expect(checkWorkingMemoryDelivery(foreign)).toMatchObject({ ok: false, code: 'source_event_scope_mismatch' });
    const duplicate = fixture(); duplicate.durableEvents[0].id = duplicate.durableEvents[1].id;
    expect(checkWorkingMemoryDelivery(duplicate)).toMatchObject({ ok: false, code: 'ambiguous_source_events' });
    const sequence = fixture(); sequence.durableEvents[0].seq = sequence.durableEvents[1].seq;
    expect(checkWorkingMemoryDelivery(sequence)).toMatchObject({ ok: false, code: 'ambiguous_source_events' });
  });
  it('does not turn an idle inherited checkpoint into a fresh current-run delivery', () => {
    const input = fixture(); input.durableEvents[1].type = 'working_memory_continuity_loaded';
    input.durableEvents[1].metadata.status = 'inherited';
    expect(checkWorkingMemoryDelivery(input)).toMatchObject({ ok: false, code: 'no_current_run_checkpoint' });
  });
  it('retains the actual root timestamp and original TTL, including a new LOG becoming a genuine new root', () => {
    const input = fixture(), result = checkWorkingMemoryDelivery(input);
    expect(result.checkpoint?.createdAt).toBe(input.durableEvents[1].createdAt);
    expect(result.checkpoint?.expiresAt).toBe('2026-10-20T00:00:00.000Z');
    const later = { ...input, now: new Date('2026-10-14T00:01:00.000Z') };
    expect(checkWorkingMemoryDelivery(later).checkpoint?.expiresAt).toBe(result.checkpoint?.expiresAt);
    expect(checkWorkingMemoryDelivery({ ...input, now: new Date('2026-10-21T00:00:00.000Z') }))
      .toMatchObject({ ok: false, code: 'checkpoint_expired' });
  });
  it('requires genuine unresolved progress when host corrections suppress historical action suggestions', () => {
    const input = fixture(); input.snapshot.state.openQuestions = [];
    input.durableEvents[1].metadata.state = structuredClone(input.snapshot.state);
    expect(checkWorkingMemoryDelivery(input).ok).toBe(true);
    const rejected = checkWorkingMemoryDelivery({ ...input, correctionsPresent: true });
    expect(rejected).toMatchObject({ ok: false, code: 'checkpoint_has_no_progress_under_correction' });
    expect(rejected.feedback).toContain('never invent a question');
    expect(checkWorkingMemoryDelivery({ ...fixture(), correctionsPresent: true }))
      .toMatchObject({ ok: true, checkpoint: { hasOpenQuestions: true } });
  });
  it('separates compact durable source proof from the actual correction-suppressed transfer budget', () => {
    const input = repeatedSourceFixture(), before = structuredClone(input);
    const request = { ...input.scope, events: input.durableEvents, now };
    expect(JSON.stringify(input.snapshot.state).length).toBeLessThan(1_500);
    expect(inspectWorkingMemoryCheckpoint(request)).toMatchObject({ status: 'ineligible', reason: 'continuity_context_over_budget' });
    const proof = inspectWorkingMemoryCheckpointProof(request);
    expect(proof).toMatchObject({ status: 'eligible', checkpoint: {
      eventId: input.durableEvents[1].id, sourceEventIds: [input.durableEvents[0].id], toolCallIds: ['read-1'],
      hasOpenQuestions: true, hasNextAction: true,
    } });
    expect(proof.checkpoint).not.toHaveProperty('history');
    expect(proof.checkpoint).not.toHaveProperty('sourceRefs');
    expect(JSON.stringify(proof)).not.toContain('https://example.test/source');
    const transferred = inspectWorkingMemoryCheckpoint({ ...request, correctionsPresent: true });
    expect(transferred.status).toBe('eligible');
    expect(transferred.checkpoint?.chain.rootHash).toBe(proof.checkpoint?.rootHash);
    expect(transferred.checkpoint?.expiresAt).toBe(proof.checkpoint?.expiresAt);
    expect(checkWorkingMemoryDelivery({ ...input, correctionsPresent: true }))
      .toMatchObject({ ok: true, checkpoint: proof.checkpoint });
    expect(input).toEqual(before);
  });
  it('still rejects an actually oversized transfer and tells the model to reduce the notebook instead of resubmitting it', () => {
    const input = repeatedSourceFixture();
    const rejected = checkWorkingMemoryDelivery(input);
    expect(rejected).toMatchObject({ ok: false, code: 'continuity_context_over_budget' });
    expect(rejected.feedback).toContain('Reduce the notebook');
    expect(rejected.feedback).toContain('Do not resubmit the same LOG');
    input.snapshot.state.openQuestions = Array.from({ length: 4 }, (_, index) => `${index}${'q'.repeat(1_850)}`);
    input.snapshot.maxSummaryChars = 12_000;
    input.durableEvents[1].metadata.state = structuredClone(input.snapshot.state);
    expect(inspectWorkingMemoryCheckpointProof({ ...input.scope, events: input.durableEvents, now }).status).toBe('eligible');
    expect(checkWorkingMemoryDelivery({ ...input, correctionsPresent: true }))
      .toMatchObject({ ok: false, code: 'continuity_context_over_budget' });
  });
  it.each(['hash', 'window', 'version'])('never lets correction suppression bypass the compact proof source %s check', field => {
    const input = repeatedSourceFixture();
    if (field === 'hash') input.durableEvents[0].metadata.contentHash = 'd'.repeat(64);
    if (field === 'window') input.durableEvents[0].metadata.offset = 1;
    if (field === 'version') input.durableEvents[0].metadata.sourceVersion = 'changed';
    expect(checkWorkingMemoryDelivery({ ...input, correctionsPresent: true }))
      .toMatchObject({ ok: false, code: 'checkpoint_has_no_bound_source' });
  });
  it('does not require hypothetical completion and shares exact checkpoint proof with real historical inheritance', () => {
    const input = fixture(true);
    const inspected = inspectWorkingMemoryCheckpoint({ ...input.scope, events: input.durableEvents, now });
    expect(inspected.status).toBe('eligible');
    const inherited = resolveWorkingMemoryContinuity({ userId: input.scope.userId, workshopId: input.scope.workshopId,
      currentRunId: futureRunId, scope: { kind: 'loop', loopId }, policyIdentity, now,
      runs: [{ id: promotionRunId, userId: promotionUserId, workshopId: promotionWorkId, loopId, status: 'success',
        createdAt: input.scope.startedAt, completedAt: now, events: input.durableEvents }] });
    expect(inspected.checkpoint).toEqual(inherited.checkpoint);
    const corrected = resolveWorkingMemoryContinuity({ userId: promotionUserId, workshopId: promotionWorkId,
      currentRunId: futureRunId, scope: { kind: 'loop', loopId }, policyIdentity, now, correctionsPresent: true,
      runs: [{ id: promotionRunId, userId: promotionUserId, workshopId: promotionWorkId, loopId, status: 'success',
        createdAt: input.scope.startedAt, completedAt: now, events: input.durableEvents }] });
    expect(corrected.checkpoint?.history.facts).toEqual([]);
    expect(corrected.checkpoint?.history.openQuestions).toHaveLength(1);
  });
});
