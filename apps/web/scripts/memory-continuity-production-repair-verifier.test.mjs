import test from 'node:test';
import assert from 'node:assert/strict';
import { CUMULATIVE_BUDGET, withinCumulativeBudget, pilotFailurePreserved, pilotAuxiliaryFailure, executionEventBound, actualToolHistory, verifyParentPilot } from './verify-memory-continuity-production-repair.mjs';

test('original P1 observation failure never becomes an accepted strict round', () => {
  const round = { round: 'P1', events: [], after: null, failure: { message: 'Own-run event pagination mismatch' } };
  const review = { passed: false, mechanismPassed: false, roundAcceptance: { P1: { attempted: true, mechanismPassed: false }, P2: { attempted: false }, P3: { attempted: false } } };
  assert.equal(pilotFailurePreserved(round, review), true);
  assert.equal(pilotFailurePreserved({ ...round, failure: null }, review), false);
  assert.equal(pilotFailurePreserved(round, { ...review, passed: true }), false);
  const resurrected = structuredClone(review); resurrected.roundAcceptance.P2.attempted = true;
  assert.equal(pilotFailurePreserved(round, resurrected), false);
});
test('pilot qualification preserves the actual ten-request quality-budget failure', () => {
  const events = [{ type: 'report_quality_review', metadata: { evaluatorMode: 'rule_based', semanticReviewStatus: 'not_completed', degraded: true, error: 'Production acceptance budget exhausted before transmission' } }];
  const requests = Array.from({ length: 10 }, (_, index) => ({ kind: index ? 'working-memory-agent' : 'recall-planner', responseStatus: 200, error: null }));
  assert.equal(pilotAuxiliaryFailure(events, requests), true);
  assert.equal(pilotAuxiliaryFailure(events, [...requests, { kind: 'auxiliary-model', responseStatus: 200, error: null }]), false);
  const wrong = structuredClone(events); wrong[0].metadata.evaluatorMode = 'llm';
  assert.equal(pilotAuxiliaryFailure(wrong, requests), false);
});
test('global cap charges failed original pilot plus all new physical requests', () => {
  const counts = { priorDomains: 1, priorRequests: 10, newDomains: 3, newRequests: 48, spooledRequests: 48 };
  assert.equal(withinCumulativeBudget(CUMULATIVE_BUDGET, counts), true);
  for (const change of [{ priorDomains: 0 }, { priorRequests: 0 }, { newDomains: 4 }, { newRequests: 49, spooledRequests: 49 }, { spooledRequests: 47 }, { newRequests: -1 }, { newDomains: 1.5 }])
    assert.equal(withinCumulativeBudget(CUMULATIVE_BUDGET, { ...counts, ...change }), false);
  assert.equal(withinCumulativeBudget({ ...CUMULATIVE_BUDGET, maximumProviderRequests: 64 }, counts), false);
});
test('Brain context-log observation has its exact independent Work lease envelope', () => {
  const expected = { runId: 'run', userId: 'owner', workerId: 'worker', fencingToken: 9 };
  const event = { type: 'brain_record_written', runId: 'run', loopId: null, loopRunId: null, metadata: { recordType: 'context_log', recordId: '00000000-0000-4000-8000-000000000001', actorId: 'owner', execution: { token: 9, workerId: 'worker' } } };
  assert.equal(executionEventBound(event, expected), true);
  for (const mutate of [e => { e.metadata.recordType = 'observation'; }, e => { e.metadata.recordId = 'malformed'; }, e => { e.metadata.actorId = 'other'; }, e => { e.metadata.execution.token = 8; }, e => { e.metadata.execution.workerId = 'other'; }, e => { e.loopId = 'other'; }, e => { e.runId = 'other'; }]) {
    const wrong = structuredClone(event); mutate(wrong); assert.equal(executionEventBound(wrong, expected), false);
  }
});
test('no-Loop Brain shape never licenses a missing native terminal run identity', () => {
  const expected = { runId: 'run', userId: 'owner', workerId: 'worker', fencingToken: 9 };
  assert.equal(executionEventBound({ type: 'agent_runtime_terminal', runId: 'run', metadata: { actorId: 'owner', execution: { token: 9, workerId: 'worker' } } }, expected), false);
});
test('real Messages owner tool call and result remain parseable without injecting text', () => {
  const history = actualToolHistory({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'workshopGetMemoryEvidence', input: { memoryId: 'current' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: '{"status":"read"}' }] }] }] });
  assert.equal(history.calls.get('call').arguments.memoryId, 'current');
  assert.equal(history.results[0].toolCallId, 'call');
});
test('missing private parent artifacts fail closed without any observation repair', () => {
  const result = verifyParentPilot({ directory: '/nonexistent-memory-proof-fixture', supplementFile: '/missing-supplement.json', failedReviewFile: '/missing-review.json' });
  assert.equal(result.passed, false); assert.equal(result.errorClass, 'ENOENT');
});
