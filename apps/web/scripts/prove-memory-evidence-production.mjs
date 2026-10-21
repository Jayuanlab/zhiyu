/** New owner-authorized provenance follow-up. Original phase artifacts stay immutable. */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as prior from './prove-memory-log-postfix.mjs';
export { repository, readJson, writeOnce, digest, fileHash, same, CHECKPOINT_CONTRACT, DELIVERY_POLICY,
  httpClient, httpSnapshot, snapshotLoop, expectedState, bootReceipts, assertFixtureSnapshot,
  assertProductionPreflight, collectEvents, ownRunEvent, childRunId, assertSources, assertBuild,
  buildSnapshot, recursiveArtifacts } from './prove-memory-log-postfix.mjs';
const { repository, readJson, writeOnce, digest, fileHash, same, httpClient, httpSnapshot,
  snapshotLoop, expectedState, bootReceipts, assertProductionPreflight, collectEvents,
  ownRunEvent, childRunId, assertSources, assertBuild, buildSnapshot } = prior;
export const PHASE = 'memory-evidence-production-20261018';
export const ROUNDS = ['EVID1', 'EVID2'];
export const BUDGET = Object.freeze({ ...prior.BUDGET });
export const AUDIT_FILES = [
  'apps/web/scripts/prove-memory-evidence-production.mjs',
  'apps/web/scripts/memory-evidence-production-preload.mjs',
  'apps/web/scripts/verify-memory-evidence-production.mjs',
  'apps/web/scripts/memory-evidence-production.test.mjs',
];
export const EVIDENCE_PROVENANCE_REQUIREMENT = [
  'Memory provenance task requirement (owner-authorized, this manual research Loop only):',
  'Before adopting the current recalled correction, use workshopGetMemoryEvidence with the current memory id actually present in Workshop context or a fresh scoped memory search.',
  'Inspect the returned authorized original owner observation, its provider, resolution and scope. Distinguish the owner exercise policy from facts in the external RFC source.',
  'A complete recalled memory body or workshopSearchMemory result is not the original observation. Do not invent ids or fetch another workshop. If the owner observation cannot be resolved, report the concrete blocker.',
  'Use the tool result in your reasoning and give a brief source-type and scope explanation in the final report. Then finish the original bounded task, fresh-source LOG and genuine next question within existing permissions and budgets.',
].join('\n');
export function goalWithProvenance(original) {
  if (typeof original !== 'string' || !original.includes('memory-continuity-acceptance')
    || original.includes(EVIDENCE_PROVENANCE_REQUIREMENT)) throw Error('Original scoped goal required, without duplicate amendment');
  return original + '\n\n' + EVIDENCE_PROVENANCE_REQUIREMENT;
}
export const anchorPath = root => resolve(root, '.tmp/memory-continuity/memory-evidence-production-20261018-phase.json');
export function assertAnchor(anchor, plan, directory) {
  if (anchor.schemaVersion !== 'memory-evidence-phase-anchor.v1' || anchor.phase !== PHASE
    || anchor.planHash !== digest(plan) || anchor.outputDirectory !== resolve(directory)
    || plan.schemaVersion !== 'memory-evidence-production-session.v1' || plan.phase !== PHASE
    || !same(plan.rounds, ROUNDS) || !same(plan.budget, BUDGET) || !same(anchor.budget, BUDGET)
    || !same(plan.cumulativeBudget, { priorDomainAttempts: 7, priorProviderRequests: 67,
      newMaximumDomainAttempts: 2, newMaximumProviderRequests: 36, totalMaximumDomainAttempts: 9,
      totalMaximumProviderRequests: 103, newExplicitOwnerAuthorization: true, oldBudgetReset: false })) throw Error('New explicit provenance phase anchor mismatch');
}
export function sourceHashes(root, parentHashes = {}) {
  const hashes = prior.sourceHashes(root, parentHashes);
  for (const file of AUDIT_FILES) hashes[file] = fileHash(resolve(root, file));
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
export function verifyPreserved(plan) {
  const oldPlan = readJson(resolve(plan.parent.directory, 'production-session.json'));
  if (fileHash(resolve(plan.parent.directory, 'production-session.json')) !== plan.parent.planHash) throw Error('Previous plan changed');
  prior.verifyPreserved(oldPlan);
  assertSources(repository, plan.builtSourceHashes);
  if (fileHash(plan.buildReceipt.filename) !== plan.buildReceipt.hash) throw Error('Reused production build receipt changed');
  for (const [file, hash] of Object.entries(plan.preservedArtifacts)) {
    if (fileHash(file) !== hash) throw Error('Original or configuration artifact changed');
  }
}
export function assertCumulativeBudget(plan, directory, { beforeNewIntent = false } = {}) {
  const old = prior.historicalCounts(readJson(resolve(plan.parent.directory, 'production-session.json')), plan.parent.directory);
  if (old.totalDomainAttempts !== 7 || old.totalProviderRequests !== 67) throw Error('Original counts changed');
  const domains = ROUNDS.filter(n => existsSync(resolve(directory, 'round-' + n + '-intent.json'))).length;
  const spool = resolve(directory, 'spool');
  const requests = existsSync(spool) ? readdirSync(spool).filter(n => /^EVID[12]-.*\.request\.json$/u.test(n)).length : 0;
  if (domains > 2 || requests > 36 || beforeNewIntent && (domains >= 2 || requests >= 36)) throw Error('New explicit phase budget exhausted');
  return { priorDomainAttempts: 7, priorProviderRequests: 67, newDomainAttempts: domains,
    newProviderRequests: requests, totalDomainAttempts: 7 + domains, totalProviderRequests: 67 + requests,
    oldBudgetReset: false, priorAuthDiagnosticsSeparate: 5 };
}
export async function activateProvenanceGoal({ directory, client, parent }) {
  const intentFile = resolve(directory, 'provenance-config-intent.json');
  if (existsSync(resolve(directory, 'provenance-config-activation.json'))) throw Error('Configuration already activated; read the existing receipt');
  let intent;
  if (existsSync(intentFile)) intent = readJson(intentFile);
  else {
    const before = await httpSnapshot(client, parent), old = snapshotLoop(before);
    const previous = readJson(resolve(parent.outputDirectory, 'round-FIX2.json'));
    if (!same(expectedState(before), expectedState(previous.after))) throw Error('Latest durable state differs from completed FIX2');
    prior.assertFixtureSnapshot(parent, before);
    intent = { schemaVersion: 'memory-provenance-config-intent.v1', observedAt: new Date().toISOString(), before,
      body: { command: 'updateWorkLoop', commandId: PHASE + ':provenance-goal:v1',
        expectedVersion: before.workshop.data.commandVersion, loopId: parent.identity.loopId,
        patch: { goal: goalWithProvenance(old.goal) },
        reason: 'Owner explicitly requests successful model-initiated original evidence expansion and strict production validation' } };
    writeOnce(intentFile, intent);
  }
  const response = await client(`/api/workshops/${parent.identity.workshopId}/commands`, {
    method: 'POST', actorId: parent.identity.userId, body: intent.body,
  });
  const after = await httpSnapshot(client, parent);
  const ledger = await client(`/api/workshops/${parent.identity.workshopId}/commands/${encodeURIComponent(intent.body.commandId)}`);
  assertGoalActivation({ intent, response, after, ledger, parent });
  const receipt = { schemaVersion: 'memory-provenance-config-activation.v1', observedAt: new Date().toISOString(),
    intentHash: digest(intent), response, after, ledger, newDomainTasks: 0, newModelRequests: 0,
    configurationCommands: 1, credentialValuesOrHashesRecorded: false };
  writeOnce(resolve(directory, 'provenance-config-activation.json'), receipt);
  return receipt;
}
export function assertGoalActivation({ intent, response, after, ledger, parent }) {
  const before = snapshotLoop(intent.before), current = snapshotLoop(after), command = ledger.data?.command;
  if (response.data?.ok !== true || command?.status !== 'succeeded' || command.commandId !== intent.body.commandId
    || command.workId !== parent.identity.workshopId || command.expectedVersion !== intent.body.expectedVersion
    || !same(Object.keys(intent.body.patch), ['goal']) || current.goal !== goalWithProvenance(before.goal)
    || after.workshop.data.commandVersion <= intent.body.expectedVersion || !same(expectedState(after), expectedState(intent.before))) throw Error('Versioned goal activation did not preserve identity and state');
  for (const key of ['id', 'userId', 'workshopId', 'name', 'status', 'triggerConfig', 'contextConfig', 'actionPolicy',
    'verificationConfig', 'approvalPolicy', 'retryPolicy', 'escalationPolicy']) if (!(current[key] === undefined && before[key] === undefined) && !same(current[key], before[key])) throw Error('Goal activation changed unrelated Loop field: ' + key);
  if (!same(after.workshop.data.workshop.modelConfig, intent.before.workshop.data.workshop.modelConfig)
    || !same(after.workshop.data.workshop.boundaryPolicy, intent.before.workshop.data.workshop.boundaryPolicy)
    || !same(after.revision.data, intent.before.revision.data)) throw Error('Goal activation changed model, boundary or current correction');
}
function readSpool(directory, round) {
  const spool = resolve(directory, 'spool');
  return readdirSync(spool).filter(name => name.startsWith(`${round}-`) && name.endsWith('.request.json')).sort().map(name => {
    const request = readJson(resolve(spool, name)), response = name.replace('.request.json', '.response.json');
    return { ...request, requestBodyFile: `spool/${name}`, ...(existsSync(resolve(spool, response))
      ? readJson(resolve(spool, response)) : { responseStatus: null, error: 'missing_response_receipt' }) };
  }).sort((a, b) => a.index - b.index);
}

export async function runProductionRound({ root = repository, directory, round, client, deployment }) {
  const plan = readJson(resolve(directory, 'production-session.json'));
  assertAnchor(readJson(anchorPath(root)), plan, directory); assertSources(root, plan.sourceHashes); assertBuild(root, plan.build); verifyPreserved(plan);
  assertCumulativeBudget(plan, directory, {beforeNewIntent:true});
  const index = ROUNDS.indexOf(round); if (index < 0) throw Error('Explicit EVID1/EVID2 required');
  if (existsSync(resolve(directory, `round-${round}-intent.json`))) throw Error('Round already attempted; cap cannot be reset');
  let prior;
  if (index === 0) prior = plan.initial;
  else {
    prior = readJson(resolve(directory, `round-${ROUNDS[index - 1]}.json`));
    const audits = readdirSync(directory).filter(name => /^memory-evidence-production-independent-review-.*\.json$/.test(name)).sort();
    const audit = audits.length ? readJson(resolve(directory, audits.at(-1))) : null;
    if (audit?.planHash !== digest(plan) || audit.auditorHash !== plan.auditorHash || audit.preflightPassed !== true || audit.roundAcceptance?.[ROUNDS[index - 1]]?.mechanismPassed !== true
      || audit.artifactHashes?.[resolve(directory, `round-${ROUNDS[index - 1]}.json`)] !== fileHash(resolve(directory, `round-${ROUNDS[index - 1]}.json`))) throw Error('Previous production round requires a strict independent audit before the next explicit run');
  }
  const before = await httpSnapshot(client, plan), binding = assertProductionPreflight(plan, before, deployment, bootReceipts(directory));
  const priorState = index === 0 ? expectedState(prior) : expectedState(prior.after);
  if (!same(expectedState(before), priorState)) throw Error('Durable Loop state changed after its audited predecessor');
  const commandId = `${PHASE}:${round}`;
  const startedAt = Date.now();
  const intent = { schemaVersion: 'memory-production-round-intent.v1', round, planHash: digest(plan), commandId,
    expectedRunId: childRunId(plan.identity.userId, plan.identity.workshopId, commandId),
    createdAt: new Date(startedAt).toISOString(), deadlineAt: new Date(startedAt + BUDGET.maxSeconds * 1000).toISOString(),
    body: { commandId, expectedVersion: before.workshop.data.commandVersion, mode: 'native_agent', wait: false, createOutboxDrafts: false }, before, binding, budget: BUDGET };
  writeOnce(resolve(directory, `round-${round}-intent.json`), intent);
  let accepted = null, after = null, run = null, failure = null, cancellation = null, events = [];
  try {
    accepted = await client(`/api/workshops/${plan.identity.workshopId}/loops/${plan.identity.loopId}/execute`, { method: 'POST', body: intent.body, actorId: plan.identity.userId });
    if (accepted.status !== 202 || !Object.values(accepted.data).includes(intent.expectedRunId) || accepted.data.accepted !== true) throw Error('Formal queue receipt does not bind expected run');
    while (Date.now() < Date.parse(intent.deadlineAt)) {
      run = await client(`/api/workshops/${plan.identity.workshopId}/runs/${intent.expectedRunId}`);
      const status = run.data.run?.status ?? run.data.status;
      if (['completed', 'success', 'failed', 'error', 'cancelled', 'blocked', 'needs_review', 'paused', 'interrupted'].includes(status)) break;
      await new Promise(done => setTimeout(done, 1500));
    }
    if (Date.now() >= Date.parse(intent.deadlineAt)) {
      const fresh = await client(`/api/workshops/${plan.identity.workshopId}`);
      cancellation = await client(`/api/workshops/${plan.identity.workshopId}/runs/${intent.expectedRunId}/cancel`, { method: 'POST', actorId: plan.identity.userId,
        body: { commandId: `${commandId}:deadline-cancel`, expectedVersion: fresh.data.commandVersion } });
      throw Error('Production round deadline reached; cancellation requested, actual terminal must be checked');
    }
  } catch (error) { failure = { name: error.name ?? 'Error', message: error.message, status: error.status ?? null }; }
  try { events = await collectEvents(client, plan, intent.expectedRunId); after = await httpSnapshot(client, plan); }
  catch (error) { failure ??= { name: error.name, message: error.message }; }
  const workerRunPath = resolve(directory, 'spool', `${round}-worker-run.json`);
  for (let i = 0; i < 10 && !existsSync(workerRunPath); i++) await new Promise(done => setTimeout(done, 500));
  const receipt = { schemaVersion: 'memory-production-round.v1', round, intent, before, after, accepted, run, failure, cancellation, events,
    usageEvents: events.filter(event => event.type === 'working_memory_usage' && event.metadata?.receiptAuthority === 'runtime'),
    providerRequests: readSpool(directory, round), budget: BUDGET, deployment, boots: bootReceipts(directory),
    workerRun: existsSync(workerRunPath) ? readJson(workerRunPath) : null, httpDetailTraceIsComplete: false,
    sourceHashes: sourceHashes(root, plan.sourceHashes), build: buildSnapshot(root, plan.build.directory, Object.keys(plan.build.hashes)), finishedAt: new Date().toISOString(),
    claims: { strictAccepted: false, taskKind: 'explicit memory mechanism acceptance in actual managed production', naturalTaskQualityImproved: false } };
  writeOnce(resolve(directory, `round-${round}.json`), receipt);
  return { round, recorded: true, strictAuditRequired: true, failure: failure?.message ?? null };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(value => {
    const index = value.indexOf('=');
    if (!value.startsWith('--') || index < 0) throw Error('Use explicit --name=value arguments');
    return [value.slice(2, index), value.slice(index + 1)];
  }));
  if (!['preflight', 'run'].includes(args.action) || !args.out
    || Object.keys(args).some(key => !['action', 'out', 'round'].includes(key))) throw Error('Explicit preflight/run and output directory required');
  const directory = resolve(args.out), plan = readJson(resolve(directory, 'production-session.json'));
  const deployment = readJson(plan.deploymentFile), client = httpClient(plan.origin);
  assertAnchor(readJson(anchorPath(repository)), plan, directory);
  assertSources(repository, plan.sourceHashes); assertBuild(repository, plan.build);
  verifyPreserved(plan); assertCumulativeBudget(plan, directory);
  if (args.action === 'preflight') {
    const snapshot = await httpSnapshot(client, plan), boots = bootReceipts(directory);
    assertProductionPreflight(plan, snapshot, deployment, boots);
    const value = { schemaVersion: 'memory-evidence-production-preflight.v1', observedAt: new Date().toISOString(),
      planHash: digest(plan), snapshot, deployment, boots, newModelRequests: 0, newDomainTasks: 0 };
    writeOnce(resolve(directory, 'production-preflight-' + value.observedAt.replace(/[:.]/g, '-') + '.json'), value);
    console.log(JSON.stringify({ passed: true, action: 'preflight', review: '93', newModelRequests: 0, newDomainTasks: 0 }));
  } else console.log(JSON.stringify(await runProductionRound({ directory, round: args.round, client, deployment })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
