/** Explicit HTTP-only production acceptance. This file never imports an executor or writes a business database. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { same as canonicalSame } from './lib/memory-continuity-verification.mjs';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PHASE = 'memory-production-20261018';
export const MANAGED_COMMAND = 'native managed web:start';
export const ROUNDS = ['P1', 'P2', 'P3'];
export const BUDGET = Object.freeze({ maximumRounds: 3, perRunDomainMaxAttempts: 1, maxRequests: 10, maxSeconds: 360, maxToolCalls: 12, automaticRetry: false, stopAfterFailure: true });
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const fileHash = path => digest(readFileSync(path));
export const same = canonicalSame;
export function writeOnce(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}
export function inside(root, path) {
  const delta = relative(resolve(root), resolve(path));
  if (!delta || delta.startsWith('..') || /^[A-Za-z]:/.test(delta)) throw Error('Artifact must stay inside its declared directory');
  return resolve(path);
}
export const anchorPath = root => resolve(root, '.tmp/memory-continuity/production-20261018-phase.json');
export function childRunId(owner, work, commandId) {
  const h = digest(JSON.stringify(['work-command-child.v1', owner.toLowerCase(), work.toLowerCase(), commandId, 'loop-run']));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function assertAnchor(anchor, plan, directory) {
  if (anchor.schemaVersion !== 'memory-production-phase-anchor.v1' || anchor.phase !== PHASE
    || anchor.outputDirectory !== resolve(directory) || anchor.planHash !== digest(plan)
    || !same(anchor.budget, BUDGET)) throw Error('Fixed production phase already bound to a different plan/directory or cap');
}
export function sourceHashes(root, parentHashes = {}) {
  const paths = new Set(Object.keys(parentHashes));
  const walk = path => {
    if (!existsSync(resolve(root, path))) return;
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) paths.add(next);
    }
  };
  for (const path of ['apps/web/lib/runtime', 'apps/web/lib/work-runtime', 'apps/web/lib/auth', 'apps/web/app/api/workshops', 'apps/web/app/api/identity', 'apps/web/app/api/runtime', 'apps/web/app/api/brain/memories']) walk(path);
  for (const path of [
    'apps/web/scripts/prove-memory-continuity-production.mjs', 'apps/web/scripts/memory-production-preload.mjs',
    'apps/web/scripts/start-managed-application.mjs', 'apps/web/scripts/managed-application.mjs', 'apps/web/scripts/start-runtime-worker.mjs',
    'apps/web/lib/ai/auxiliary-model-connection.ts', 'apps/web/lib/work-evolution/report-quality-evaluator.ts',
    'packages/ai/src/agent/runtime/opencode-go-endpoint.ts',
    'apps/web/app/(auth)/auth.ts', 'apps/web/scripts/auth-bind-policy.mjs', 'apps/web/next.config.js',
    'apps/web/package.json', 'packages/ai/package.json', 'pnpm-lock.yaml',
  ]) if (existsSync(resolve(root, path))) paths.add(path);
  return Object.fromEntries([...paths].sort().map(path => [path, fileHash(resolve(root, path))]));
}
export function assertSources(root, expected) {
  const changed = Object.entries(expected).filter(([path, hash]) => !existsSync(resolve(root, path)) || fileHash(resolve(root, path)) !== hash).map(([path]) => path);
  if (changed.length) throw Error(`Frozen production sources changed: ${changed.join(', ')}`);
}
export function buildSnapshot(root, buildDirectory = 'apps/web/.next', paths = ['BUILD_ID', 'required-server-files.json', 'build-manifest.json', 'routes-manifest.json']) {
  const dir = inside(resolve(root, 'apps/web'), resolve(root, buildDirectory));
  for (const path of paths) if (!existsSync(resolve(dir, path))) throw Error('A real completed Next production build is required before planning');
  return { directory: dir, buildId: readFileSync(resolve(dir, 'BUILD_ID'), 'utf8').trim(), hashes: Object.fromEntries(paths.map(path => [path, fileHash(resolve(dir, path))])) };
}
export function assertBuild(root, expected) { if (!same(buildSnapshot(root, expected.directory, Object.keys(expected.hashes)), expected)) throw Error('Production build drift'); }
function artifactMap(directory) {
  const result = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.json')) result[entry.name] = fileHash(resolve(directory, entry.name));
  return result;
}
export function verifyPreserved(plan) {
  if (plan.providerProfile && fileHash(plan.providerProfile.filename) !== plan.providerProfile.hash) throw Error('Fresh provider profile changed');
  if (plan.providerDiagnostic && fileHash(plan.providerDiagnostic.filename) !== plan.providerDiagnostic.hash) throw Error('Canonical provider diagnostic changed');
  if (plan.buildReceipt && fileHash(plan.buildReceipt.filename) !== plan.buildReceipt.hash) throw Error('Completed production build receipt changed');
  for (const preserved of plan.preserved) for (const [name, hash] of Object.entries(preserved.hashes)) {
    if (fileHash(inside(preserved.directory, resolve(preserved.directory, name))) !== hash) throw Error('An original immutable artifact changed');
  }
}
export function planProduction({ root = repository, parentDirectory, priorReview, outputDirectory, buildDirectory, buildReceiptFile, providerProfileFile, dryRun = false, networkMode = 'verified-direct-opencode', networkPreferredAddress }) {
  const directory = inside(resolve(root, '.tmp/memory-continuity'), outputDirectory);
  if (existsSync(anchorPath(root))) throw Error('Production phase already planned; a new directory cannot reset its cap');
  const parent = readJson(resolve(parentDirectory, 'resume-session.json'));
  networkPreferredAddress ??= networkMode === 'default' ? null : parent.networkPreferredAddress;
  const reviewFile = inside(parentDirectory, resolve(parentDirectory, priorReview));
  const review = readJson(reviewFile), latest = readJson(resolve(parentDirectory, 'round-R3.json'));
  if (review.mechanismPassed !== true || review.taskStabilityVerified !== true || review.consecutiveSuccessfulNewTasks !== 3
    || !['R1', 'R2', 'R3'].every(name => review.roundAcceptance?.[name]?.mechanismPassed === true) || latest.result?.result?.status !== 'success') throw Error('Production phase requires the preserved strict R1-R3 parent audit');
  if (!['default', 'verified-direct-opencode'].includes(networkMode) || (networkMode === 'default' && networkPreferredAddress !== null)) throw Error('Invalid explicit network mode');
  if (!buildDirectory || !providerProfileFile || !buildReceiptFile) throw Error('Explicit completed --build-directory/--build-receipt and safe --provider-profile required');
  const buildReceipt = readJson(resolve(buildReceiptFile));
  if (buildReceipt.schemaVersion !== 'memory-production-build.v1' || buildReceipt.passed !== true || buildReceipt.exitCode !== 0 || buildReceipt.sourceDrift?.length !== 0
    || resolve(root, buildReceipt.buildDirectory) !== resolve(root, buildDirectory)) throw Error('Production build receipt does not prove this completed immutable build');
  for (const [path, hash] of Object.entries(buildReceipt.sourceHashes ?? {})) if (fileHash(resolve(root, path)) !== hash) throw Error('Production build source freeze drift');
  const build = buildSnapshot(root, buildDirectory, [...new Set(['BUILD_ID', 'required-server-files.json', ...Object.keys(buildReceipt.manifestHashes)])]);
  if (build.buildId !== buildReceipt.buildId || Object.entries(buildReceipt.manifestHashes).some(([path, hash]) => build.hashes[path] !== hash)) throw Error('Built manifests do not match the successful build receipt');
  const providerProfile = readJson(resolve(providerProfileFile));
  if (providerProfile.schemaVersion !== 'memory-production-provider-profile.v1' || providerProfile.actualModel !== parent.provider.actualModel
    || !['anthropic-messages', 'openai-completions'].includes(providerProfile.protocol) || !/^[a-f0-9]{64}$/.test(providerProfile.actualEndpointHash)
    || providerProfile.sourceBinding?.status !== 'matched' || providerProfile.credentialValuesOrHashesRecorded !== false) throw Error('Fresh safe provider profile is not bound to the same model and actual resolver');
  for (const [path, hash] of Object.entries(providerProfile.sourceBinding.sourceHashes ?? {})) if (fileHash(resolve(root, path)) !== hash) throw Error('Fresh resolver profile runtime source drift');
  if (providerProfile.configuredWorkLoopMatchesParent !== true || providerProfile.modelConfigurationMatchesParent !== true
    || providerProfile.modelHttp?.fetchBlocked !== true || providerProfile.modelHttp.attemptedFetches !== 0) throw Error('Fresh provider profile must be a source-bound read-only resolver observation');
  const diagnosticFile = inside(dirname(resolve(providerProfileFile)), resolve(dirname(resolve(providerProfileFile)), providerProfile.migration?.supportedByDiagnostic ?? ''));
  const diagnostic = readJson(diagnosticFile);
  if (fileHash(diagnosticFile) !== providerProfile.migration?.diagnosticHash || diagnostic.complete !== true || diagnostic.httpStatus !== 200
    || diagnostic.actualProtocol !== providerProfile.protocol || diagnostic.model !== providerProfile.actualModel || !['stop', 'end_turn', 'stop_sequence'].includes(diagnostic.stopReason)) throw Error('Canonical provider migration lacks its preserved successful terminal diagnostic');
  const mainRequests = latest.providerRequests.filter(request => request.kind === 'working-memory-agent');
  const parentPayload = readJson(inside(parentDirectory, resolve(parentDirectory, mainRequests[0]?.requestBodyFile ?? ''))).payload;
  const allowedTools = [...new Set((parentPayload.tools ?? []).map(tool => tool.function?.name ?? tool.name))].sort();
  if (!same(allowedTools, ['webReadPage', 'workingMemory', 'workshopGetMemoryEvidence', 'workshopLogEvent', 'workshopReadMemory', 'workshopSearchMemory'].sort())) throw Error('Parent effective isolated fixture tool boundary is not the expected read/log-only set');
  if (!Number.isInteger(parent.preservedConfidence) || parent.preservedConfidence !== 25) throw Error('Parent canonical confidence receipt missing or changed');
  const plan = { schemaVersion: 'memory-production-session.v1', phase: PHASE, createdAt: new Date().toISOString(),
    authorization: { date: '2026-10-18', scope: 'User authorized fixing remaining dependencies and three real production tasks in the same Work and Loop', oldCapsRewritten: false },
    outputDirectory: directory, identity: Object.fromEntries(['userId', 'workshopId', 'loopId', 'goalHash', 'modelConfigHash', 'loopConfigurationHash'].map(key => [key, parent.initial[key]])),
    parent: { directory: resolve(parentDirectory), reviewFile: priorReview, reviewHash: fileHash(reviewFile), runId: latest.result.loopRunId, roundFile: 'round-R3.json' },
    preserved: [{ directory: resolve(parentDirectory), hashes: artifactMap(parentDirectory) }, { directory: resolve(root, parent.priorCampaign.directory), hashes: artifactMap(resolve(root, parent.priorCampaign.directory)) }],
    correction: parent.correction, canonical: { confidence: parent.preservedConfidence, status: 'active' },
    provider: { actualModel: providerProfile.actualModel, protocol: providerProfile.protocol, actualEndpointHash: providerProfile.actualEndpointHash, credentialValuesOrHashesRecorded: false },
    providerProfile: { filename: resolve(providerProfileFile), hash: fileHash(resolve(providerProfileFile)) },
    providerDiagnostic: { filename: diagnosticFile, hash: fileHash(diagnosticFile) }, allowedTools,
    providerMigration: { previous: parent.provider, currentProfileHash: fileHash(resolve(providerProfileFile)), authorization: 'Explicit October 18 provider protocol repair; same model, versioned endpoint/protocol change', previousPayloadsRewritten: false },
    budget: BUDGET, rounds: ROUNDS, trigger: 'manual', taskProtocol: 'Unchanged persisted goal and context; no old answer, label or tool result injected into any new task.',
    workerPolicy: { modules: ['loop-execution'], workshopIds: [parent.initial.workshopId], maxToolCalls: '12' },
    network: { mode: networkMode, preferredAddress: networkPreferredAddress },
    initial: latest.after, sourceHashes: sourceHashes(root, { ...parent.initial.sourceHashes, ...providerProfile.sourceBinding.sourceHashes, ...buildReceipt.sourceHashes }), build,
    buildReceipt: { filename: resolve(buildReceiptFile), hash: fileHash(resolve(buildReceiptFile)) },
    auditorHash: fileHash(resolve(root, 'apps/web/scripts/verify-memory-continuity-production.mjs')),
    claims: { previousFailuresPassed: false, productionPassed: false, realTaskBenefitCausallyProved: false },
  };
  verifyPreserved(plan); assertSources(root, plan.sourceHashes); assertBuild(root, plan.build);
  if (dryRun) return plan;
  writeOnce(resolve(directory, 'production-session.json'), plan);
  writeOnce(anchorPath(root), { schemaVersion: 'memory-production-phase-anchor.v1', phase: PHASE, outputDirectory: directory, planHash: digest(plan), budget: BUDGET });
  return plan;
}
export function httpClient(baseUrl, cookie) {
  const origin = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/') throw Error('Explicit loopback production origin required');
  const client = async (path, { method = 'GET', body, actorId } = {}) => {
    const headers = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: origin.origin, 'X-Work-Actor': actorId } : {}) };
    const response = await fetch(new URL(path, origin), { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw Object.assign(Error(`Production HTTP ${response.status}`), { status: response.status });
    return { status: response.status, observedAt: new Date().toISOString(), data };
  };
  client.origin = origin.origin;
  return client;
}
export async function httpSnapshot(client, plan) {
  const { workshopId: work, loopId: loop, userId } = plan.identity;
  const identity = await client('/api/identity');
  if (identity.data.actorId !== userId) throw Error('Real authenticated identity differs from parent owner');
  const [workshop, detail, runtime, revision, loops] = await Promise.all([
    client(`/api/workshops/${work}`), client(`/api/workshops/${work}/loops/${loop}/detail`), client('/api/runtime/status'), client(`/api/brain/memories/${plan.correction.memoryId}/revision`), client(`/api/workshops/${work}/loops`),
  ]);
  for (const response of [workshop, loops]) assertNoCredentialFields(response.data);
  return { identity, workshop, detail, runtime, revision, loops, origin: client.origin, observedAt: new Date().toISOString() };
}
export function assertNoCredentialFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:api_?key|access_?token|refresh_?token|authorization|cookie|password|auth_?secret)$/i.test(key) && typeof item === 'string' && item.length) throw Error('HTTP read contains a credential field; refusing to persist it');
    if (typeof item === 'object') assertNoCredentialFields(item);
  }
}
export function snapshotLoop(snapshot) { return snapshot?.detail?.data?.loop; }
export function expectedState(snapshot) {
  const loop = snapshotLoop(snapshot);
  return { stateJson: loop?.stateJson, currentPhase: loop?.currentPhase, nextAction: loop?.nextAction ?? null, blockedReason: loop?.blockedReason ?? null, lastObservation: loop?.lastObservation ?? null };
}
export function originalState(round) {
  const state = round.after.state;
  return { stateJson: state.stateJson, currentPhase: state.currentPhase, nextAction: state.nextAction ?? null, blockedReason: state.blockedReason ?? null, lastObservation: state.lastObservation ?? null };
}
export function bootReceipts(directory) {
  const spool = resolve(directory, 'spool');
  return existsSync(spool) ? readdirSync(spool).filter(name => /^boot-.*\.json$/.test(name)).map(name => ({ file: name, ...readJson(resolve(spool, name)) })) : [];
}
export function assertFixtureSnapshot(plan, snapshot) {
  const worker = snapshot.runtime?.data?.worker, loop = snapshotLoop(snapshot), workshop = snapshot.workshop?.data?.workshop;
  if (snapshot.identity?.data?.actorId !== plan.identity.userId || !['local_owner', 'authenticated'].includes(snapshot.identity.data.mode)) throw Error('Real HTTP authenticated owner identity is not bound');
  if (worker?.online !== true || worker.state !== 'online' || worker.configuredMode !== 'worker' || worker.instanceMode !== 'worker'
    || worker.heartbeatAgeMs > 10_000 || !Number.isFinite(worker.heartbeatAgeMs) || !Number.isFinite(Date.parse(worker.leaseUntil)) || !Number.isFinite(Date.parse(snapshot.observedAt))
    || Date.parse(worker.leaseUntil) <= Date.parse(snapshot.observedAt)) throw Error('Actual production worker heartbeat/lease is unavailable');
  if (!Array.isArray(snapshot.loops?.data?.loops) || snapshot.loops.data.loops.length !== 1 || snapshot.loops.data.loops[0].id !== plan.identity.loopId) throw Error('Work-only production filter requires this isolated Work to contain exactly the audited Loop');
  if (worker.modules?.length !== 1 || worker.modules[0].name !== 'loop-execution' || loop?.status !== 'active' || workshop?.status !== 'active' || loop?.triggerConfig?.type !== 'manual') throw Error('Production policy or active manual fixture boundary changed');
  if (digest(loop.goal) !== plan.identity.goalHash || digest(workshop.modelConfig) !== plan.identity.modelConfigHash
    || digest([loop.goal, loop.contextConfig, loop.actionPolicy, loop.approvalPolicy, loop.retryPolicy]) !== plan.identity.loopConfigurationHash) throw Error('Production fixture goal/model config drift');
  const actual = snapshot.revision?.data;
  if (actual?.memory?.id !== plan.correction.memoryId || actual.expectedVersion !== plan.correction.expectedVersion || digest(actual.memory.content) !== plan.correction.contentHash
    || actual.memory.confidence !== 25 || actual.memory.status !== 'active') throw Error('Canonical owner correction changed');
  return worker;
}
export function assertProductionPreflight(plan, snapshot, deployment, boots) {
  const worker = assertFixtureSnapshot(plan, snapshot);
  const web = boots.find(item => item.role === 'web' && item.pid === deployment.webPid);
  const boot = boots.find(item => item.role === 'worker' && item.pid === deployment.workerPid);
  const manager = boots.find(item => item.role === 'manager' && item.pid === deployment.managerPid);
  const healthy = worker?.online === true && worker.state === 'online' && worker.configuredMode === 'worker' && worker.instanceMode === 'worker'
    && worker.heartbeatAgeMs <= 10_000 && Date.parse(worker.leaseUntil) > Date.parse(snapshot.observedAt);
  if (deployment.schemaVersion !== 'memory-production-deployment.v1' || deployment.managedCommand !== MANAGED_COMMAND || deployment.listeningPid !== deployment.webPid
    || Number(new URL(snapshot.origin).port) !== deployment.port || !Number.isSafeInteger(deployment.workerPid) || !web || !boot || !manager || !healthy) throw Error('Actual managed production web/worker binding is incomplete');
  for (const receipt of [web, boot, manager]) if (receipt.nodeEnv !== 'production' || receipt.planHash !== digest(plan) || !same(receipt.build, plan.build)
    || !same(receipt.sourceHashes, plan.sourceHashes)) throw Error('Managed process did not load the frozen build/source plan');
  if (web.ppid !== manager.pid || boot.ppid !== manager.pid || [web, boot, manager].some(item => item.selectedBuildDirectory !== plan.build.directory)
    || !manager.argv?.some(value => value.endsWith('/scripts/start-managed-application.mjs') || value === './scripts/start-managed-application.mjs')
    || !manager.argv.includes('start') || manager.argv[manager.argv.indexOf('--port') + 1] !== String(deployment.port)) throw Error('Actual managed child processes selected a different Next distDir or launch contract');
  if (!same(boot.workerPolicy, plan.workerPolicy)) throw Error('Loaded worker scope/tool budget differs from frozen policy');
  return { workerInstanceId: worker.instanceId, workerPid: boot.pid, webPid: web.pid, workerBootId: boot.bootId, webBootId: web.bootId, buildId: plan.build.buildId };
}
export async function collectEvents(client, plan, runId) {
  const result = []; let after = 0;
  for (let page = 0; page < 20; page++) {
    const response = await client(`/api/workshops/${plan.identity.workshopId}/events?runId=${runId}&after=${after}&limit=2000`);
    const events = response.data.events;
    if (!Array.isArray(events) || events.some(event => event.seq <= after || !ownRunEvent(event, plan.identity, runId))) throw Error('Own-run event pagination mismatch');
    result.push(...events); if (events.length < 2000) return result;
    after = events.at(-1).seq;
  }
  throw Error('Event audit pagination cap reached; evidence incomplete');
}
export function ownRunEvent(event, identity, id) {
  if (event.workshopId !== identity.workshopId || event.runId != null && event.runId !== id || event.loopRunId != null && event.loopRunId !== id || event.loopId != null && event.loopId !== identity.loopId) return false;
  if (event.loopRunId === id) return event.loopId === identity.loopId;
  return event.runId === id && event.loopId == null && ['execution_claimed', 'execution_recovered', 'execution_effect_intent', 'execution_completed', 'execution_failed', 'execution_needs_review', 'execution_cancelled',
    'run_completed', 'run_failed', 'run_needs_review', 'run_cancelled', 'run_output_captured', 'run_plan_captured'].includes(event.type);
}
function readSpool(directory, round) {
  const spool = resolve(directory, 'spool');
  return readdirSync(spool).filter(name => name.startsWith(`${round}-`) && name.endsWith('.request.json')).sort().map(name => {
    const request = readJson(resolve(spool, name));
    const responseFile = name.replace('.request.json', '.response.json');
    return { ...request, requestBodyFile: `spool/${name}`, ...(existsSync(resolve(spool, responseFile)) ? readJson(resolve(spool, responseFile)) : { responseStatus: null, error: 'missing_response_receipt' }) };
  }).sort((a, b) => a.index - b.index);
}
export async function runProductionRound({ root = repository, directory, round, client, deployment }) {
  const plan = readJson(resolve(directory, 'production-session.json'));
  assertAnchor(readJson(anchorPath(root)), plan, directory); assertSources(root, plan.sourceHashes); assertBuild(root, plan.build); verifyPreserved(plan);
  const index = ROUNDS.indexOf(round); if (index < 0) throw Error('Explicit P1/P2/P3 required');
  if (existsSync(resolve(directory, `round-${round}-intent.json`))) throw Error('Round already attempted; cap cannot be reset');
  let prior;
  if (index === 0) prior = readJson(resolve(plan.parent.directory, plan.parent.roundFile));
  else {
    prior = readJson(resolve(directory, `round-${ROUNDS[index - 1]}.json`));
    const audits = readdirSync(directory).filter(name => /^production-independent-review-.*\.json$/.test(name)).sort();
    const audit = audits.length ? readJson(resolve(directory, audits.at(-1))) : null;
    if (audit?.planHash !== digest(plan) || audit.auditorHash !== plan.auditorHash || audit.preflightPassed !== true || audit.roundAcceptance?.[ROUNDS[index - 1]]?.mechanismPassed !== true
      || audit.artifactHashes?.[resolve(directory, `round-${ROUNDS[index - 1]}.json`)] !== fileHash(resolve(directory, `round-${ROUNDS[index - 1]}.json`))) throw Error('Previous production round requires a strict independent audit before the next explicit run');
  }
  const before = await httpSnapshot(client, plan), binding = assertProductionPreflight(plan, before, deployment, bootReceipts(directory));
  const priorState = index === 0 ? originalState(prior) : expectedState(prior.after);
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
  const args = Object.fromEntries(process.argv.slice(2).map(arg => { const split = arg.indexOf('='); if (!arg.startsWith('--') || split < 0) throw Error('Use --name=value'); return [arg.slice(2, split), arg.slice(split + 1)]; }));
  const allowed = ['action', 'out', 'parent', 'prior-review', 'origin', 'base-url', 'cookie-file', 'deployment-receipt', 'round', 'network', 'network-prefer', 'build-directory', 'build-receipt', 'provider-profile', 'dry-run'];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw Error('Unknown production runner argument');
  const directory = resolve(args.out ?? '');
  if (['plan', 'inspect'].includes(args.action)) {
    const plan = planProduction({ parentDirectory: resolve(args.parent), priorReview: args['prior-review'], outputDirectory: directory,
      buildDirectory: args['build-directory'] ? resolve(args['build-directory']) : undefined, buildReceiptFile: args['build-receipt'], providerProfileFile: args['provider-profile'], dryRun: args['dry-run'] === 'true' || args.action === 'inspect',
      networkMode: args.network ?? 'verified-direct-opencode', networkPreferredAddress: args.network === 'default' ? null : args['network-prefer'] });
    if (args.action === 'inspect') {
      const client = httpClient(args.origin ?? args['base-url'] ?? 'http://127.0.0.1:3515', args['cookie-file'] ? readFileSync(resolve(args['cookie-file']), 'utf8').trim() : undefined);
      const snapshot = await httpSnapshot(client, plan); assertFixtureSnapshot(plan, snapshot);
      writeOnce(resolve(directory, `production-schema-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), { schemaVersion: 'memory-production-schema-probe.v1', snapshot, build: plan.build, sourceHashes: plan.sourceHashes, bootstrapOnly: true, productionAccepted: false, modelCalls: 0, domainAttempts: 0 });
      console.log(JSON.stringify({ schemaVerified: true, bootstrapOnly: true, productionAccepted: false, modelCalls: 0, domainAttempts: 0 })); return;
    }
    console.log(JSON.stringify({ planned: args['dry-run'] !== 'true', dryRun: args['dry-run'] === 'true', rounds: plan.rounds, budget: plan.budget, sourceCount: Object.keys(plan.sourceHashes).length, buildId: plan.build.buildId, model: plan.provider.actualModel, protocol: plan.provider.protocol })); return;
  }
  if (!['preflight', 'run'].includes(args.action)) throw Error('Explicit --action=plan|preflight|run required');
  const plan = readJson(resolve(directory, 'production-session.json'));
  assertAnchor(readJson(anchorPath(repository)), plan, directory); assertSources(repository, plan.sourceHashes); assertBuild(repository, plan.build); verifyPreserved(plan);
  const cookie = args['cookie-file'] ? readFileSync(resolve(args['cookie-file']), 'utf8').trim() : undefined;
  const client = httpClient(args.origin ?? args['base-url'] ?? 'http://127.0.0.1:3515', cookie), deployment = readJson(resolve(args['deployment-receipt']));
  if (args.action === 'preflight') {
    const snapshot = await httpSnapshot(client, plan), binding = assertProductionPreflight(plan, snapshot, deployment, bootReceipts(directory));
    writeOnce(resolve(directory, `production-preflight-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), { schemaVersion: 'memory-production-preflight.v1', planHash: digest(plan), snapshot, binding, deployment, boots: bootReceipts(directory) });
    console.log(JSON.stringify({ preflightPassed: true, buildId: plan.build.buildId, plannedRounds: 3 })); return;
  }
  console.log(JSON.stringify(await runProductionRound({ directory, round: args.round, client, deployment })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
