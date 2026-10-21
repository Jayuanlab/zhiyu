import { describe, expect, it, vi } from 'vitest';
import {
  formatWorkingMemoryContinuityGuidance, loadWorkingMemoryContinuity, resolveWorkingMemoryContinuity,
  WORKING_MEMORY_CONTINUITY_EVENT_LIMIT, type WorkingMemoryContinuityInput, type WorkingMemoryContinuityReaders,
  type WorkingMemoryContinuityRun, type WorkingMemoryContinuityResult,
} from '@/lib/workshops/working-memory-continuity';
import { promotionEvents, promotionRunId, promotionUserId, promotionWorkId } from '../fixtures/working-memory-promotion';

const loopId = '77777777-7777-4777-a777-777777777777';
const currentRunId = '88888888-8888-4888-a888-888888888888';
const earlierRunId = '99999999-9999-4999-a999-999999999999';
const now = new Date('2026-10-13T01:00:00.000Z');
function input(loop = false): WorkingMemoryContinuityInput {
  return { userId: promotionUserId, workshopId: promotionWorkId, currentRunId,
    scope: loop ? { kind: 'loop', loopId } : { kind: 'parent_run', parentRunId: promotionRunId },
    policyIdentity: { version: 'memact-automem.v1', hash: 'c'.repeat(64) }, now };
}
function run(loop = false): WorkingMemoryContinuityRun {
  const events = promotionEvents();
  const state = events[1].metadata.state as any;
  state.openQuestions = ['Which experiment conditions apply?'];
  state.nextAction = { key: 'next:verify', text: 'Verify the original paper.', evidenceIds: ['read-1'] };
  if (loop) for (const event of events) { event.runId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; event.loopId = loopId; event.loopRunId = promotionRunId; }
  return { id: promotionRunId, userId: promotionUserId, workshopId: promotionWorkId, loopId: loop ? loopId : null,
    status: 'completed', createdAt: '2026-10-12T23:59:00.000Z', completedAt: '2026-10-13T00:01:00.000Z', events };
}
const resolve = (source = run(), request = input()) => resolveWorkingMemoryContinuity({ ...request, runs: [source] });
function readers(source = run()): WorkingMemoryContinuityReaders {
  return { ownsScope: vi.fn(async () => true), listPredecessors: vi.fn(async () => [{ ...source }]), loadEvents: vi.fn(async () => source.events) };
}
const carryId = (index: number) => `${String(index).padStart(8, '0')}-bbbb-4bbb-abbb-${String(index).padStart(12, '0')}`;
function carry(result: WorkingMemoryContinuityResult, index: number, loop = true): WorkingMemoryContinuityRun {
  const id = carryId(index), createdAt = new Date(now.getTime() - 50 * 60_000 + index * 60_000).toISOString();
  return { ...run(loop), id, status: loop ? 'success' : 'completed', createdAt,
    completedAt: new Date(Date.parse(createdAt) + 30_000).toISOString(),
    events: [{ ...run(loop).events[1], id: carryId(index + 100), runId: loop ? currentRunId : id,
      loopId: loop ? loopId : null, loopRunId: loop ? id : null, type: 'working_memory_continuity_loaded',
      createdAt, metadata: { receiptAuthority: 'runtime', ...structuredClone(result) } }] };
}
function resolveCarry(source: WorkingMemoryContinuityRun, ancestors: WorkingMemoryContinuityRun[], correction = false) {
  return resolveWorkingMemoryContinuity({ ...input(!!source.loopId),
    scope: source.loopId ? { kind: 'loop', loopId } : { kind: 'parent_run', parentRunId: source.id },
    correctionsPresent: correction, runs: [source], ancestorRuns: ancestors });
}

describe('scoped historical working-memory continuity', () => {
  it.each([false, true])('inherits a persisted parent/Loop checkpoint without changing current source truth: loop=%s', loop => {
    const source = run(loop), original = structuredClone(source), result = resolve(source, input(loop));
    expect(result).toMatchObject({ status: 'inherited', checkpoint: { sourceRunId: promotionRunId,
      authority: 'historical-model-authored-unverified', recoveryScope: 'historical-notes-only-no-transcript-replay',
      correctionPrecedence: 'current-owner-and-brain-first', version: 1,
      history: { openQuestions: ['Which experiment conditions apply?'] } } });
    expect(result.checkpoint?.history.facts).toHaveLength(1);
    expect(result.checkpoint?.history.facts[0]).not.toHaveProperty('evidenceIds');
    expect(result.checkpoint?.history.facts[0].sourceRefs[0]).toMatchObject({ toolCallId: 'read-1', sourceEventId: source.events[0].id });
    expect(result.checkpoint).not.toHaveProperty('evidenceCatalog');
    expect(result.checkpoint).not.toHaveProperty('pruneToolCallIds');
    expect(source).toEqual(original);
    expect(formatWorkingMemoryContinuityGuidance(result)).toContain('当前主人纠正');
  });
  it.each(['userId', 'workshopId', 'loopId'])('rejects cross-scope source %s', field => {
    const source = run(true); (source as any)[field] = earlierRunId;
    expect(resolve(source, input(true))).toMatchObject({ status: 'skipped', reason: 'source_scope_mismatch', checkpoint: null });
  });
  it('requires an explicit matching parent and excludes the current run', () => {
    expect(resolve(run(), { ...input(), scope: { kind: 'parent_run', parentRunId: earlierRunId } }).reason).toBe('source_scope_mismatch');
    expect(resolve(run(), { ...input(), currentRunId: promotionRunId }).reason).toBe('invalid_continuity_request');
  });
  it.each(['failed', 'interrupted', 'cancelled', 'running', 'needs_review'])('does not revive an older completed run after latest %s', status => {
    const latest = run(true); latest.status = status;
    const older = { ...run(true), id: earlierRunId, createdAt: '2026-10-12T22:00:00.000Z' };
    expect(resolveWorkingMemoryContinuity({ ...input(true), runs: [older, latest] })).toMatchObject({ status: 'skipped',
      reason: ['running', 'needs_review'].includes(status) ? 'source_run_not_terminal' : 'latest_run_unsuccessful' });
  });
  it('never falls back before a restore, including restore with stale non-empty state', () => {
    const source = run(); source.events.push({ ...source.events[1], id: earlierRunId, seq: 4, type: 'working_memory_restored',
      metadata: { ...source.events[1].metadata, version: 2 } });
    expect(resolve(source).reason).toBe('latest_checkpoint_cleared');
  });
  it.each([{ persistenceError: 'write failed' }, { persistence_error: 'write failed' }, { __truncated: true }, { expiresAt: '2000-01-01' }, { revoked: true }])('fails closed on unavailable latest audit %j', patch => {
    const source = run(); Object.assign(source.events[1].metadata, patch);
    expect(resolve(source).reason).toBe('checkpoint_unavailable');
  });
  it('requires the same fixed memory strategy and a fresh historical checkpoint', () => {
    expect(resolve(run(), { ...input(), policyIdentity: { version: 'v2', hash: 'd'.repeat(64) } }).reason).toBe('memory_policy_changed');
    expect(resolve(run(), { ...input(), now: new Date('2026-10-22T00:00:00Z') }).reason).toBe('checkpoint_expired');
    expect(resolve(run(), { ...input(), now: new Date('2026-10-12T23:00:00Z') }).reason).toBe('invalid_source_time');
  });
  it('rejects project changes and either direction of bound/unbound transition without changing strategy identity', () => {
    const source = run();
    source.events[1].metadata.applicabilityHash = 'a'.repeat(64);
    expect(resolve(source, { ...input(), applicabilityHash: 'a'.repeat(64) }).status).toBe('inherited');
    for (const applicabilityHash of ['b'.repeat(64), null, undefined]) {
      expect(resolve(source, { ...input(), applicabilityHash })).toMatchObject({ status: 'skipped', reason: 'memory_applicability_changed' });
    }
    expect(resolve(run(), { ...input(), applicabilityHash: 'a'.repeat(64) }).reason).toBe('memory_applicability_changed');
    expect(resolve(run(), { ...input(), applicabilityHash: null }).status).toBe('inherited');
  });
  it('requires complete event and evidence catalog coverage', () => {
    expect(resolve({ ...run(), eventsTruncated: true }).reason).toBe('source_history_truncated');
    const source = run(); source.events[1].metadata.catalogSummary = { truncated: true };
    expect(resolve(source).reason).toBe('source_catalog_incomplete');
    expect(resolve({ ...run(), events: Array.from({ length: WORKING_MEMORY_CONTINUITY_EVENT_LIMIT + 1 }, () => run().events[0]) }).reason).toBe('source_history_truncated');
  });
  it('cannot claim source-free observations as facts but may preserve explicitly unverified progress', () => {
    const source = run(); source.events[0].metadata.contentHash = 'd'.repeat(64);
    const result = resolve(source);
    expect(result.status).toBe('inherited');
    expect(result.checkpoint?.history.facts).toEqual([]);
    expect(result.checkpoint?.history.nextAction).toBeNull();
    expect(result.checkpoint?.history.openQuestions).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('omitted');
    (source.events[1].metadata.state as any).openQuestions = [];
    expect(resolve(source).reason).toBe('no_safe_historical_notes');
  });
  it.each([{ revoked: true }, { stale: true }, { status: 'unknown' }, { expiresAt: 'bad-date' }, { expiresAt: '2026-10-12T23:59:59Z' }])('drops claims with unavailable or expired sources %j', patch => {
    const source = run(); Object.assign(source.events[0].metadata, patch);
    expect(resolve(source).checkpoint?.history.facts).toEqual([]);
  });
  it('drops assertions whose exact source window or later source validity changed', () => {
    const source = run(); source.events[0].metadata.offset = 1;
    expect(resolve(source).checkpoint?.history.facts).toEqual([]);
    const invalidated = run(); invalidated.events.push({ ...invalidated.events[0], seq: 4, id: earlierRunId,
      metadata: { receiptAuthority: 'runtime', sourceEventId: invalidated.events[0].id, revoked: true } });
    expect(resolve(invalidated).checkpoint?.history.facts).toEqual([]);
  });
  it('suppresses historical assertions and action suggestions when the host reports a correction', () => {
    const source = run(); const state = source.events[1].metadata.state as any;
    state.hypotheses = [{ text: 'An older assumption.', evidenceIds: [] }];
    const result = resolve(source, { ...input(), correctionsPresent: true });
    expect(result.checkpoint?.history).toEqual({ facts: [], hypotheses: [], openQuestions: ['Which experiment conditions apply?'], nextAction: null });
    expect(result.warnings.join(' ')).toContain('suppressed');
    expect(result.checkpoint?.sourceRefs).toEqual([]);
  });
  it('does not silently truncate invalid questions, a large state or its provenance envelope', () => {
    const source = run(); (source.events[1].metadata.state as any).openQuestions.push(42);
    expect(resolve(source).reason).toBe('invalid_checkpoint_questions');
    const large = run(); (large.events[1].metadata.state as any).openQuestions = Array.from({ length: 7 }, () => 'x'.repeat(2_000));
    expect(resolve(large).reason).toBe('checkpoint_state_over_budget');
    const bounded = run(); (bounded.events[1].metadata.state as any).openQuestions = Array.from({ length: 4 }, (_, index) => `${index}${'x'.repeat(1_900)}`);
    expect(resolve(bounded).reason).toBe('continuity_context_over_budget');
  });
  it('rejects foreign events, duplicate IDs and ambiguous sequences', () => {
    const source = run(true); source.events[0].loopId = earlierRunId;
    expect(resolve(source, input(true)).reason).toBe('source_event_scope_mismatch');
    const duplicate = run(); duplicate.events[0].seq = 2;
    expect(resolve(duplicate).reason).toBe('ambiguous_source_events');
  });
  it('validates checkpoint schema, shape and temporal consistency', () => {
    const source = run(); source.events[1].metadata.mode = 'shadow';
    expect(resolve(source).reason).toBe('unsupported_checkpoint');
    const malformed = run(); (malformed.events[1].metadata.state as any).facts = null;
    expect(resolve(malformed).reason).toBe('invalid_checkpoint_state');
    const future = run(); future.events[1].createdAt = '2026-10-13T00:02:00Z';
    expect(resolve(future).reason).toBe('invalid_checkpoint_time');
  });
});

describe('read-only continuity loader', () => {
  it('checks scope ownership before any predecessor or event read', async () => {
    const source = readers(); source.ownsScope = vi.fn(async () => false);
    expect((await loadWorkingMemoryContinuity(input(), source)).reason).toBe('scope_not_owned');
    expect(source.listPredecessors).not.toHaveBeenCalled();
    expect(source.loadEvents).not.toHaveBeenCalled();
  });
  it('loads only the newest predecessor with a limit+1 completeness check', async () => {
    const source = readers(run(true)); source.listPredecessors = vi.fn(async () => [
      { ...run(true), id: earlierRunId, createdAt: '2026-10-12T22:00:00Z' }, run(true),
    ]);
    expect((await loadWorkingMemoryContinuity(input(true), source)).status).toBe('inherited');
    expect(source.loadEvents).toHaveBeenCalledExactlyOnceWith(input(true), promotionRunId, WORKING_MEMORY_CONTINUITY_EVENT_LIMIT + 1);
  });
  it('exposes failed loading without private exception contents', async () => {
    const source = readers(); source.loadEvents = vi.fn(async () => { throw Error('private credential'); });
    const result = await loadWorkingMemoryContinuity(input(), source);
    expect(result.reason).toBe('continuity_read_failed');
    expect(JSON.stringify(result)).not.toContain('private credential');
    expect(formatWorkingMemoryContinuityGuidance(result)).toContain('continuity_read_failed');
    expect(formatWorkingMemoryContinuityGuidance(result)).not.toContain('private credential');
  });
  it('rejects unowned rows rather than searching another run', async () => {
    const source = readers(); source.listPredecessors = vi.fn(async () => [{ ...run(), userId: earlierRunId }]);
    expect((await loadWorkingMemoryContinuity(input(), source)).reason).toBe('source_scope_mismatch');
    expect(source.loadEvents).not.toHaveBeenCalled();
  });
  it('skips invalid requests before touching a reader', async () => {
    const source = readers();
    expect((await loadWorkingMemoryContinuity({ ...input(), maxAgeMs: -1 }, source)).reason).toBe('invalid_continuity_request');
    expect(source.ownsScope).not.toHaveBeenCalled();
  });
  it('accepts real Loop success rows and treats blocked as unsuccessful without mapping Workshop aliases', async () => {
    const successful = { ...run(true), status: 'success', createdAt: new Date('2026-10-12T23:59:00Z'), completedAt: new Date('2026-10-13T00:01:00Z') };
    expect((await loadWorkingMemoryContinuity(input(true), readers(successful))).status).toBe('inherited');
    expect((await loadWorkingMemoryContinuity(input(true), readers({ ...successful, status: 'blocked' }))).reason).toBe('latest_run_unsuccessful');
    expect((await loadWorkingMemoryContinuity(input(), readers({ ...run(), status: 'success' }))).reason).toBe('source_run_not_terminal');
  });
  it('loads exact ancestors of a persisted inheritance receipt without broad history fallback', async () => {
    const original = run(true), saved = carry(resolve(original, input(true)), 1);
    const source = readers(saved);
    source.loadRun = vi.fn(async (_request, id) => id === original.id ? original : null);
    source.loadEvents = vi.fn(async (_request, id) => id === saved.id ? saved.events : original.events);
    const result = await loadWorkingMemoryContinuity({ ...input(true), verifySources: async sources => sources.map(item => ({
      sourceEventId: item.sourceEventId, toolCallId: item.toolCallId, status: 'current' as const,
    })) }, source);
    expect(result).toMatchObject({ status: 'inherited', reason: 'scoped_audited_inheritance_chain', checkpoint: {
      sourceRunId: original.id, chain: { depth: 1, viaRunIds: [saved.id] } } });
    expect(source.loadRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(input(true)), original.id);
    expect(source.loadEvents).toHaveBeenCalledTimes(2);
  });
});

describe('bounded model-visible continuity admission', () => {
  it('makes a skipped reason explicit without exposing any rejected historical body', () => {
    const result: WorkingMemoryContinuityResult = { schemaVersion: 'working-memory-continuity.v1', status: 'skipped',
      reason: 'latest_run_unsuccessful', warnings: ['Historical notes were not loaded.'], checkpoint: run(true) as never };
    const output = formatWorkingMemoryContinuityGuidance(result);
    expect(output).toContain('latest_run_unsuccessful');
    expect(output).toContain('不表示历史为空或首次运行');
    expect(output).toContain('"checkpoint":null');
    expect(output).not.toContain(promotionRunId);
    expect(output).not.toContain('Which experiment conditions apply?');
  });
  it('never truncates a typed checkpoint or exceeds the caller remaining budget', () => {
    const inherited = resolve();
    const skipped: WorkingMemoryContinuityResult = { schemaVersion: 'working-memory-continuity.v1', status: 'skipped',
      reason: 'latest_run_unsuccessful', warnings: [], checkpoint: null };
    for (const result of [inherited, skipped]) {
      const full = formatWorkingMemoryContinuityGuidance(result);
      expect(formatWorkingMemoryContinuityGuidance(result, { maxChars: full.length })).toBe(full);
      for (const maxChars of [0, 1, 50, full.length - 1])
        expect(formatWorkingMemoryContinuityGuidance(result, { maxChars })).toBe('');
    }
  });
});

describe('persisted historical inheritance chains', () => {
  it.each([false, true])('survives rounds without LOG while keeping root TTL and exact sources: loop=%s', loop => {
    const original = run(loop), root = resolve(original, input(loop));
    const second = carry(root, 1, loop), thirdInput = resolveCarry(second, [original]);
    expect(thirdInput).toMatchObject({ status: 'inherited', checkpoint: {
      sourceRunId: original.id, expiresAt: root.checkpoint?.expiresAt, chain: { depth: 1, rootHash: root.checkpoint?.chain.rootHash } } });
    const third = carry(thirdInput, 2, loop), fourthInput = resolveCarry(third, [original, second]);
    expect(fourthInput).toMatchObject({ status: 'inherited', checkpoint: {
      sourceRunId: original.id, expiresAt: root.checkpoint?.expiresAt, chain: { depth: 2, viaRunIds: [second.id, third.id] } } });
    expect(fourthInput.checkpoint?.history).toEqual(root.checkpoint?.history);
    expect(fourthInput.checkpoint?.sourceRefs).toEqual(root.checkpoint?.sourceRefs);
  });
  it('requires every persisted hop and rejects modified history, root hash or TTL', () => {
    const original = run(true), saved = carry(resolve(original, input(true)), 1);
    expect(resolveCarry(saved, []).reason).toBe('continuity_ancestor_unavailable');
    for (const field of ['text', 'hash', 'expiry']) {
      const modified = structuredClone(saved), checkpoint = modified.events[0].metadata.checkpoint as any;
      if (field === 'text') checkpoint.history.facts[0].text = 'Forged carried fact';
      if (field === 'hash') checkpoint.chain.rootHash = 'd'.repeat(64);
      if (field === 'expiry') checkpoint.expiresAt = '2026-10-23T00:00:00Z';
      expect(resolveCarry(modified, [original]).reason).toBe('continuity_chain_checkpoint_mismatch');
    }
  });
  it('does not refresh expired roots or revive restored/failed ancestors', () => {
    const original = run(true), saved = carry(resolve(original, input(true)), 1);
    expect(resolveWorkingMemoryContinuity({ ...input(true), now: new Date('2026-10-23T00:00:00Z'), runs: [saved], ancestorRuns: [original] }).reason).toBe('checkpoint_expired');
    expect(resolveCarry(saved, [{ ...original, status: 'blocked' }]).reason).toBe('latest_run_unsuccessful');
    const restored = structuredClone(original); restored.events[1].type = 'working_memory_restored';
    expect(resolveCarry(saved, [restored]).reason).toBe('latest_checkpoint_cleared');
    const restoredCurrent = structuredClone(saved); restoredCurrent.events.push({ ...saved.events[0], id: earlierRunId, seq: 99,
      type: 'working_memory_restored', metadata: { ...original.events[1].metadata, version: 2 } });
    expect(resolveCarry(restoredCurrent, [original]).reason).toBe('latest_checkpoint_cleared');
  });
  it('keeps a correction suppression through later rounds without reviving root assertions', () => {
    const original = run(true), saved = carry(resolve(original, input(true)), 1);
    const corrected = resolveCarry(saved, [original], true);
    expect(corrected.checkpoint?.history.facts).toEqual([]);
    expect(corrected.checkpoint?.chain.assertionsSuppressed).toBe(true);
    const afterCorrection = carry(corrected, 2);
    const later = resolveCarry(afterCorrection, [original, saved]);
    expect(later.status).toBe('inherited');
    expect(later.checkpoint?.history).toEqual({ facts: [], hypotheses: [], openQuestions: ['Which experiment conditions apply?'], nextAction: null });
    expect(later.checkpoint?.chain.assertionsSuppressed).toBe(true);
  });
  it('bounds chain depth instead of silently dropping ancestry', () => {
    const original = run(true), ancestors = [original];
    let result = resolve(original, input(true));
    for (let index = 1; index <= 8; index++) {
      const saved = carry(result, index);
      result = resolveCarry(saved, ancestors);
      expect(result.status).toBe('inherited');
      expect(result.checkpoint?.chain.depth).toBe(index);
      ancestors.push(saved);
    }
    expect(resolveCarry(carry(result, 9), ancestors).reason).toBe('invalid_continuity_chain');
  });
  it('rejects wrong scopes and incomplete ancestry events', () => {
    const original = run(true), saved = carry(resolve(original, input(true)), 1);
    expect(resolveCarry(saved, [{ ...original, loopId: earlierRunId }]).reason).toBe('continuity_chain_scope_mismatch');
    expect(resolveCarry(saved, [{ ...original, eventsTruncated: true }]).reason).toBe('source_history_truncated');
  });
});
