import { describe, expect, it } from 'vitest';
import { auditMemoryEvidence } from '../../scripts/lib/memory-evidence-audit.mjs';
import { createHash } from 'node:crypto';

const work = '3153b95e-df02-4d31-9949-04f19e4eb8d4';
const run = 'ac8466bc-213d-8042-a70c-0e7241117ae1';
const events = (output: unknown, extra = {}) => [
  { type: 'tool_use', id: 'call', name: 'platformRecall' },
  { type: 'tool_result', toolUseId: 'call', output: JSON.stringify(output), ...extra },
  { type: 'text', content: 'intermediate unsupported conclusion' },
  { type: 'result', content: `Work ${work}; run ${run}` },
];
describe('offline memory evidence audit', () => {
  it('audits the streamed answer when result.content is only a success marker', () => {
    const result = auditMemoryEvidence([
      { type: 'tool_use', id: 'runtime', name: 'platformRecall' },
      { type: 'tool_result', toolUseId: 'runtime', output: JSON.stringify({
        status: 'no_active_linked_execution_observed', provider: 'workshop_execution_leases',
        loopId: work, observedAt: '2026-09-24T00:00:00Z', linkedExecution: null,
      }) },
      { type: 'text', content: '当前执行器' },
      { type: 'text', content: '仍处于阻塞状态。' },
      { type: 'result', content: 'success' },
      { type: 'done' },
    ]);
    expect(result.finalAnswer).toBe('当前执行器仍处于阻塞状态。');
    expect(result.audit.answerSource).toBe('streamed_text');
    expect(result.audit.runtimeObservations).toMatchObject([{ status: 'no_active_linked_execution_observed', loopId: work }]);
    expect(result.audit.claimRisks).toMatchObject([{ code: 'possible_live_runtime_claim_from_persisted_state' }]);
    expect(result.audit.skippedResults).toBe(0);
  });
  it('captures a direct timeline page as a scoped observation', () => {
    const result = auditMemoryEvidence(events({ status: 'read', loopId: work, afterRunId: run,
      runs: [], coverage: { hasMore: false, nextCursorRunId: null }, observedAt: '2026-09-24T00:00:00Z' }));
    expect(result.audit.timelineWindows).toMatchObject([{ loopId: work, afterRunId: run, returnedCount: 0 }]);
    expect(result.audit.skippedResults).toBe(0);
  });
  it('flags an absent lease claim when no linked execution allowed lease inspection', () => {
    const observations = [
      { type: 'tool_use', id: 'runtime', name: 'platformRecall' },
      { type: 'tool_result', toolUseId: 'runtime', output: JSON.stringify({
        status: 'no_active_linked_execution_observed', provider: 'workshop_execution_leases', loopId: work,
      }) },
    ];
    expect(auditMemoryEvidence([...observations, { type: 'result',
      content: '未观察到活动的执行器租约或心跳。' }]).audit.claimRisks).toMatchObject([
      { code: 'lease_heartbeat_absence_claim_without_evaluation' },
    ]);
    expect(auditMemoryEvidence([...observations, { type: 'result',
      content: '未观察到活跃租约并不证明进程已经停止。' }]).audit.claimRisks).toMatchObject([
      { code: 'lease_heartbeat_absence_claim_without_evaluation' },
    ]);
    expect(auditMemoryEvidence([...observations, { type: 'result',
      content: '不能将此情况表述为“未观察到活跃租约”，因为租约未被评估。' }]).audit.claimRisks).toEqual([]);
    expect(auditMemoryEvidence([...observations, { type: 'result',
      content: '未观察到活动关联映射，因此租约和心跳没有被评估。' }]).audit.claimRisks).toEqual([]);
    expect(auditMemoryEvidence([...observations, { type: 'result',
      content: '由于租约和心跳未被评估，没有租约或心跳的观测值。' }]).audit.claimRisks).toEqual([]);
  });
  it('keeps a failed runtime source distinct from a confirmed empty observation', () => {
    const result = auditMemoryEvidence(events({ status: 'source_unavailable',
      provider: 'workshop_execution_leases', warning: 'Runtime source failed' }));
    expect(result.audit.runtimeObservations).toMatchObject([{ status: 'source_unavailable', observedAt: null }]);
    expect(result.audit.timelineWindows).toEqual([]);
    expect(result.audit.skippedResults).toBe(0);
  });
  it('flags probable live-state prose when only persisted state was observed', () => {
    const make = (answer: string) => [
      { type: 'tool_use', id: 'call', name: 'platformRecall' },
      { type: 'tool_result', toolUseId: 'call', output: JSON.stringify({ ok: true,
        claimBoundary: { currentExecutor: { status: 'not_observed' } } }) },
      { type: 'result', content: answer },
    ];
    expect(auditMemoryEvidence(make('执行器很可能仍处于阻塞状态')).audit.claimRisks).toMatchObject([
      { code: 'possible_live_runtime_claim_from_persisted_state' },
    ]);
    expect(auditMemoryEvidence(make('最后持久化状态为 error，实时态无法验证')).audit.claimRisks).toEqual([]);
    expect(auditMemoryEvidence(make('不能证明此刻执行器仍在阻塞')).audit.claimRisks).toEqual([]);
    expect(auditMemoryEvidence(make('loopStates 能否证明此刻执行器仍在阻塞？不能。')).audit.claimRisks).toEqual([]);
    expect(auditMemoryEvidence(make('当前执行器已停止。')).audit.claimRisks).toMatchObject([
      { code: 'possible_live_runtime_claim_from_persisted_state' },
    ]);
    expect(auditMemoryEvidence(make('回答瞬间极可能未运行。')).audit.claimRisks).toMatchObject([
      { code: 'possible_live_runtime_claim_from_persisted_state' },
    ]);
    expect(auditMemoryEvidence(make('当前执行器很可能不在运行。')).audit.claimRisks).toMatchObject([
      { code: 'possible_live_runtime_claim_from_persisted_state' },
    ]);
    expect(auditMemoryEvidence(make('当前没有活动租约，不能证明执行器已停止。')).audit.claimRisks).toEqual([]);
  });
  it('keeps a scoped empty successor window distinct from missing timeline evidence', () => {
    const result = auditMemoryEvidence(events({ data: { timeline: { status: 'read', loopId: work, afterRunId: run,
      runs: [], coverage: { hasMore: false, nextCursorRunId: null }, observedAt: '2026-09-23T00:00:00Z' } } }));
    expect(result.audit.timelineWindows).toMatchObject([{ loopId: work, afterRunId: run, returnedCount: 0, hasMore: false }]);
    expect(result.audit.status).toBe('requires_claim_review');
    expect(result.audit.answerSource).toBe('final_result');
  });
  it('keeps final output separate and exposes record field roles without grading semantics', () => {
    const result = auditMemoryEvidence(events({ data: { brain: { snapshots: [{ scope: { workshopId: work }, content: { runId: run } }] } } }));
    expect(result.finalAnswer).not.toContain('intermediate');
    expect(result.audit.status).toBe('requires_claim_review');
    expect(result.audit.identifiers[1].occurrences[0].path).toBe('data.brain.snapshots[0].content.runId');
    expect(result.audit.identifiers[0].occurrences[0].path).toBe('data.brain.snapshots[0].scope.workshopId');
  });
  it('never treats echoed query IDs or free prose as observed record fields', () => {
    const result = auditMemoryEvidence(events({ question: run, data: { records: { requestedIds: [run], records: [{ fields: { note: `run ${run}` } }] } } }));
    expect(result.audit.identifiers.every(row => row.status === 'not_verified_by_this_audit')).toBe(true);
  });
  it('ignores failed tool evidence and does not promote missing final answers', () => {
    const result = auditMemoryEvidence(events({ data: { brain: { snapshots: [{ id: run }] } } }, { isError: true }));
    expect(result.audit.inspectedRecords).toBe(0);
    expect(auditMemoryEvidence([{ type: 'text', content: run }]).audit.status).toBe('missing_final_answer');
  });
  it('does not mistake discovery read arguments for original record fields', () => {
    const result = auditMemoryEvidence(events({ data: { brain: { snapshots: [{ representation: 'raw_record_excerpt', id: run, read: { snapshotId: run } }] } } }));
    expect(result.audit.inspectedRecords).toBe(0);
    expect(result.audit.identifiers.every(row => row.status === 'not_verified_by_this_audit')).toBe(true);
  });
  it('reads only complete exact snapshot windows and tolerates malformed output', () => {
    const base = [{ type: 'tool_use', id: 'call', name: 'brainListSnapshots' }];
    const output = { status: 'read', offset: 0, nextOffset: null, content: JSON.stringify({ content: { runId: run } }) };
    const make = (value: unknown) => [...base, { type: 'tool_result', toolUseId: 'call', output: JSON.stringify(value) }, { type: 'result', content: run }];
    expect(auditMemoryEvidence(make(output)).audit.inspectedRecords).toBe(1);
    expect(auditMemoryEvidence(make({ ...output, nextOffset: 8000 })).audit.inspectedRecords).toBe(0);
    expect(auditMemoryEvidence([...base, { type: 'tool_result', output: '{' }]).audit.skippedResults).toBe(1);
  });
  it('accepts only a contiguous, version-consistent exact platform record before auditing its fields', () => {
    const record = JSON.stringify({ source: 'loopRuns', id: run, fields: { runId: run } });
    const eventsFor = (pages: object[]) => [
      ...pages.flatMap((page, i) => [{ type: 'tool_use', id: `call-${i}`, name: 'platformRecall' },
        { type: 'tool_result', toolUseId: `call-${i}`, output: JSON.stringify(page) }]),
      { type: 'result', content: run },
    ];
    const first = { status: 'read', source: 'loopRuns', id: run, offset: 0, nextOffset: 20,
      contentHash: createHash('sha256').update(record).digest('hex'), totalCharacters: record.length, content: record.slice(0, 20) };
    const last = { ...first, offset: 20, nextOffset: null, content: record.slice(20) };
    const complete = auditMemoryEvidence(eventsFor([first, last]));
    expect(complete.audit.assembledRecords).toBe(1);
    expect(complete.audit.identifiers[0].status).toBe('observed_in_record_fields');
    expect(auditMemoryEvidence(eventsFor([first])).audit.assembledRecords).toBe(0);
    expect(auditMemoryEvidence(eventsFor([first, { ...last, contentHash: 'b'.repeat(64) }])).audit.assembledRecords).toBe(0);
  });
});
