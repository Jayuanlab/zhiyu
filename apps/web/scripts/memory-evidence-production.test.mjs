import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { goalWithProvenance, EVIDENCE_PROVENANCE_REQUIREMENT, assertGoalActivation,
  BUDGET, PHASE, ROUNDS, digest, expectedState, sourceHashes, AUDIT_FILES } from './prove-memory-evidence-production.mjs';
import { hasAutonomousOwnerProof } from './verify-memory-evidence-production.mjs';
import { createAuditedFetch } from './memory-evidence-production-preload.mjs';
import { auditLogProduction } from './verify-memory-log-postfix.mjs';
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const directory = '../../.tmp/memory-continuity/20261018-log-postfix';
const parent = json(directory + '/production-session.json');
const previous = json(directory + '/round-FIX2.json');
const originalGoal = previous.after.detail.data.loop.goal;

test('original failure is reproducible and exactly one strict criterion remains', () => {
  const result = auditLogProduction({ directory });
  assert.equal(result.passed, false);
  assert.deepEqual(result.checks.filter(c => !c.passed).map(c => c.name),
    ['at least one successful LOG task autonomously expanded typed owner evidence']);
  for (const round of ['FIX1', 'FIX2']) assert.equal(result.roundAcceptance[round].mechanismPassed, true);
});
test('new local task amendment retains original goal and contains no identity or answer', () => {
  const goal = goalWithProvenance(originalGoal);
  assert.equal(goal, originalGoal + '\n\n' + EVIDENCE_PROVENANCE_REQUIREMENT);
  assert.match(goal, /workshopGetMemoryEvidence/u);
  assert.doesNotMatch(EVIDENCE_PROVENANCE_REQUIREMENT, /[a-f0-9]{8}-[a-f0-9-]{27,}|CHECK_CURRENT_VERSION|bmrv1:/iu);
  assert.match(EVIDENCE_PROVENANCE_REQUIREMENT, /cannot be resolved, report the concrete blocker/u);
});
for (const goal of ['', 'unrelated financial task', goalWithProvenance(originalGoal)]) {
  test('amendment refuses empty foreign or duplicate goals: ' + goal.length, () => {
    assert.throws(() => goalWithProvenance(goal));
  });
}
function activationFixture() {
  const before = structuredClone(previous.after), after = structuredClone(before);
  const version = before.workshop.data.commandVersion;
  after.detail.data.loop.goal = goalWithProvenance(before.detail.data.loop.goal);
  after.workshop.data.commandVersion = version + 1;
  const commandId = PHASE + ':provenance-goal:v1';
  return { parent, intent: { before, body: { commandId, expectedVersion: version,
    patch: { goal: after.detail.data.loop.goal } } }, response: { data: { ok: true } }, after,
    ledger: { data: { command: { status: 'succeeded', commandId,
      workId: parent.identity.workshopId, expectedVersion: version } } } };
}
test('versioned goal-only command preserves original durable feedback and all boundaries', () => {
  const fixture = activationFixture();
  assert.doesNotThrow(() => assertGoalActivation(fixture));
  assert.deepEqual(expectedState(fixture.after), expectedState(fixture.intent.before));
});
for (const [name, mutate] of [
  ['wrong owner work', f => { f.ledger.data.command.workId = 'another-work'; }],
  ['stale expected version', f => { f.ledger.data.command.expectedVersion -= 1; }],
  ['no durable version advance', f => { f.after.workshop.data.commandVersion -= 1; }],
  ['silent command failure', f => { f.response.data.ok = false; }],
  ['second changed field', f => { f.intent.body.patch.status = 'paused'; }],
  ['wider permissions', f => { f.after.detail.data.loop.actionPolicy.allowed.push('Shell'); }],
  ['scheduled trigger', f => { f.after.detail.data.loop.triggerConfig = { type: 'cron' }; }],
  ['modified checker', f => { f.after.detail.data.loop.verificationConfig.requiredFields = []; }],
  ['changed predecessor', f => { f.after.detail.data.loop.stateJson.lastLoopRunId = 'other'; }],
  ['modified correction', f => { f.after.revision.data.memory.confidence = 100; }],
  ['changed model', f => { f.after.workshop.data.workshop.modelConfig.model = 'other'; }],
  ['changed boundary', f => { f.after.workshop.data.workshop.boundaryPolicy.deniedPrecedence = false; }],
]) test('configuration readback rejects ' + name, () => {
  const f = activationFixture(); mutate(f); assert.throws(() => assertGoalActivation(f));
});
test('proof requires new successful model tool use, never host probes or old failed rounds', () => {
  const proof = { round: 'EVID1', actualCompletedTask: true, mode: 'autonomous-model-tool-use', evidenceVerified: true };
  assert.equal(hasAutonomousOwnerProof([proof]), true);
  for (const diff of [{ round: 'LOG1' }, { round: 'FIX1' }, { actualCompletedTask: false },
    { mode: 'host-probe' }, { evidenceVerified: false }]) assert.equal(hasAutonomousOwnerProof([{ ...proof, ...diff }]), false);
});
function fetchFixture({ count = 0, invalidToken = false } = {}) {
  const q = previous.providerRequests.find(q => q.kind === 'working-memory-agent');
  const event = previous.events.find(e => e.id === q.transportPrepared.eventId);
  const claim = previous.events.find(e => e.type === 'execution_claimed');
  const lease = { ...parent.identity, runId: previous.intent.expectedRunId,
    workerId: previous.intent.binding.workerInstanceId, token: claim.metadata.fencingToken + Number(invalidToken) };
  const now = Date.parse(q.dispatchedAt);
  const intent = { round: 'EVID1', expectedRunId: lease.runId, planHash: digest(parent), budget: BUDGET,
    createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 420000).toISOString() };
  let fetches = 0;
  const records = [];
  const fetch = createAuditedFetch({ originalFetch: async () => { fetches++; return new Response('{}'); },
    plan: parent, leaseReader: async () => lease, intentReader: () => intent,
    readPrepared: async () => q.hostPrepared, readTransport: async () => event,
    readForward: async () => q.deliveryForward,
    recordRequest: (_round, _index, record) => records.push(record), recordResponse: () => {},
    countRequests: () => count, now: () => now, boot: { pid: q.pid, bootId: q.bootId },
    network: { metadata: q.network, apply: (_url, init) => init },
  });
  return { fetch, request: new Request('https://provider.invalid/messages', {
    method: 'POST', body: JSON.stringify(q.payload), headers: { 'Content-Type': 'application/json' } }),
    url: null, records, fetches: () => fetches };
}
// Use the actual provider URL only as a test argument reconstructed from its
// already audited endpoint shape; no originalFetch here ever makes a network call.
// The production wrapper must reject a wrong endpoint rather than silently pass.
test('new opt-in wrapper rejects wrong endpoint without dispatch', async () => {
  const f = fetchFixture(); await assert.rejects(f.fetch(f.request), /provider drift/u);
  assert.equal(f.fetches(), 0);
});
test('physical cap rejects nineteenth request before dispatch', async () => {
  const f = fetchFixture({ count: 18 }); await assert.rejects(f.fetch(f.request), /budget exhausted/u);
  assert.equal(f.fetches(), 0);
});
test('new phase preserves finite per-round caps and separately named attempts', () => {
  assert.deepEqual(ROUNDS, ['EVID1', 'EVID2']);
  assert.equal(BUDGET.maxRequests, 18); assert.equal(BUDGET.maxSeconds, 420);
  assert.equal(BUDGET.maxToolCalls, 14); assert.equal(BUDGET.automaticRetry, false);
});
test('new audit sources are frozen in addition to existing compiled source', () => {
  const hashes = sourceHashes('../..', parent.sourceHashes);
  for (const path of AUDIT_FILES) assert.match(hashes[path], /^[a-f0-9]{64}$/u);
});
