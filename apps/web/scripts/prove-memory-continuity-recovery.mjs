/** Explicit HTTP-only production acceptance. This file never imports an executor or writes a business database. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { same as canonicalSame } from './lib/memory-continuity-verification.mjs';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PHASE = 'memory-production-recovery-20261018';
export const MANAGED_COMMAND = 'native managed web:start';
export const ROUNDS = ['U1', 'U2'];
export const BUDGET = Object.freeze({ maximumRounds: 2, perRunDomainMaxAttempts: 1, maxRequests: 16, maxSeconds: 360, maxToolCalls: 12, automaticRetry: false, stopAfterFailure: true });
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
export const anchorPath = root => resolve(root, '.tmp/memory-continuity/production-recovery-20261018-phase.json');
export function childRunId(owner, work, commandId) {
  const h = digest(JSON.stringify(['work-command-child.v1', owner.toLowerCase(), work.toLowerCase(), commandId, 'loop-run']));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function assertAnchor(anchor, plan, directory) {
  if (anchor.schemaVersion !== 'memory-production-phase-anchor.v1' || anchor.phase !== PHASE
    || anchor.outputDirectory !== resolve(directory) || anchor.planHash !== digest(plan)
    || !same(anchor.budget, BUDGET)) throw Error('Fixed production phase already bound to a different plan/directory or cap');
  if (plan.schemaVersion !== 'memory-recovery-session.v1' || plan.phase !== PHASE || !same(anchor.cumulativeBudget, CUMULATIVE_BUDGET)) throw Error('Final recovery anchor must bind the new version and aggregate caps');
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
    'apps/web/scripts/prove-memory-continuity-recovery.mjs', 'apps/web/scripts/memory-recovery-preload.mjs',
    'apps/web/scripts/verify-memory-continuity-recovery.mjs', 'apps/web/scripts/memory-continuity-recovery.test.mjs',
    'apps/web/scripts/verify-memory-continuity-production-repair.mjs', 'apps/web/scripts/verify-memory-continuity-resume.mjs',
    'apps/web/scripts/verify-memory-continuity-followup.mjs', 'apps/web/scripts/lib/memory-continuity-verification.mjs',
    'apps/web/scripts/start-managed-application.mjs', 'apps/web/scripts/managed-application.mjs', 'apps/web/scripts/start-runtime-worker.mjs',
    'apps/web/lib/ai/auxiliary-model-connection.ts', 'apps/web/lib/work-evolution/report-quality-evaluator.ts',
    'packages/ai/src/agent/runtime/opencode-go-endpoint.ts', 'packages/ai/src/agent/runtime/provider-stream-recovery.ts',
    'apps/web/app/(auth)/auth.ts', 'apps/web/scripts/auth-bind-policy.mjs', 'apps/web/next.config.js', 'apps/web/next-env.d.ts',
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
  if(plan.sourceBaseline)verifySourceBaseline(plan.sourceBaseline);
  for (const evidence of plan.externalParentEvidence ?? []) if (fileHash(evidence.filename) !== evidence.hash) throw Error('Original pilot supplemental evidence changed');
  if (plan.providerProfile && fileHash(plan.providerProfile.filename) !== plan.providerProfile.hash) throw Error('Fresh provider profile changed');
  if (plan.providerDiagnostic && fileHash(plan.providerDiagnostic.filename) !== plan.providerDiagnostic.hash) throw Error('Canonical provider diagnostic changed');
  if (plan.buildReceipt && fileHash(plan.buildReceipt.filename) !== plan.buildReceipt.hash) throw Error('Completed production build receipt changed');
  for (const preserved of plan.preserved) for (const [name, hash] of Object.entries(preserved.hashes)) {
    if (fileHash(inside(preserved.directory, resolve(preserved.directory, name))) !== hash) throw Error('An original immutable artifact changed');
  }
}
/** The single declared compiler edit is independently reconstructed, not a drift exemption. */
export function exactNextGeneratedChange(receipt,currentText){
  const changes=receipt?.generatedSourceChanges,afterImport='import "./.tmp/next-review-96/types/routes.d.ts";',beforeImport='import "./.tmp/next-review-98/types/routes.d.ts";';
  if(!Array.isArray(changes)||changes.length!==1||typeof currentText!=='string'||currentText.split(afterImport).length!==2)return false;
  const item=changes[0];return item.path==='apps/web/next-env.d.ts'&&item.writer==='Next production type generation'&&item.declaredBeforeBuild===true
    && item.afterHash===digest(currentText)&&item.beforeHash===digest(currentText.replace(afterImport,beforeImport))&&receipt.sourceHashes?.[item.path]===item.afterHash
    && Array.isArray(receipt.sourceDrift)&&receipt.sourceDrift.length===0;
}
export const CUMULATIVE_BUDGET = Object.freeze({maximumDomainAttempts:4,maximumProviderRequests:58,plannedMaximumProviderRequests:53,priorDomainAttempts:2,priorProviderRequests:21,newPhaseMaximumDomainAttempts:2,newPhaseMaximumProviderRequests:32,automaticDomainRetry:false});
export function recursiveArtifacts(directory, excluded) {
  const result={}; const visit=current=>{for(const item of readdirSync(current,{withFileTypes:true})){const path=resolve(current,item.name);if(excluded&&path===resolve(excluded))continue;if(item.isDirectory())visit(path);else if(item.isFile())result[relative(directory,path).replaceAll('\\','/')]=fileHash(path);}};visit(directory);return result;
}
export function historicalCounts(plan,directory){
  const pilot=resolve(repository,'.tmp/memory-continuity/20261018-production-loop'),failed=resolve(pilot,'corrected16');
  if(['P2','P3'].some(n=>existsSync(resolve(pilot,'round-'+n+'-intent.json')))||['Q2','Q3'].some(n=>existsSync(resolve(failed,'round-'+n+'-intent.json'))))throw Error('Stopped previous rounds acquired another attempt');
  const physical=(dir,regex)=>readdirSync(resolve(dir,'spool')).filter(n=>regex.test(n)).length;
  const prior=physical(pilot,/^P1-.*\.request\.json$/)+physical(failed,/^Q1-.*\.request\.json$/);
  const current=existsSync(resolve(directory,'spool'))?physical(directory,/^U[12]-.*\.request\.json$/):0;
  const domains=ROUNDS.filter(n=>existsSync(resolve(directory,'round-'+n+'-intent.json'))).length;
  return {priorDomainAttempts:2,priorProviderRequests:prior,newDomainAttempts:domains,newProviderRequests:current,totalDomainAttempts:2+domains,totalProviderRequests:prior+current};
}
export function assertCumulativeBudget(plan,directory,{beforeNewIntent=false}={}){
  if(!same(plan.cumulativeBudget,CUMULATIVE_BUDGET)||!same(plan.budget,BUDGET)||!same(plan.rounds,ROUNDS))throw Error('Final recovery caps changed');
  const n=historicalCounts(plan,directory);if(!withinFinalBudget(n,{beforeNewIntent}))throw Error('Final cumulative physical/domain cap exhausted');return n;
}
export function withinFinalBudget(n,{beforeNewIntent=false}={}){
  return ['priorDomainAttempts','priorProviderRequests','newDomainAttempts','newProviderRequests','totalDomainAttempts','totalProviderRequests'].every(k=>Number.isSafeInteger(n?.[k])&&n[k]>=0)
    && n.priorDomainAttempts===2 && n.priorProviderRequests===21 && n.newDomainAttempts<=2 && n.newProviderRequests<=32
    && n.totalDomainAttempts===2+n.newDomainAttempts && n.totalProviderRequests===21+n.newProviderRequests
    && n.totalDomainAttempts<=4 && n.totalProviderRequests<=53 && n.totalProviderRequests<=58 && (!beforeNewIntent||n.newDomainAttempts<2);
}
export function verifySourceBaseline(baseline){
  const manifest=readJson(baseline.manifestFile);if(fileHash(baseline.manifestFile)!==baseline.manifestHash||manifest.schemaVersion!=='memory-recovery-source-parent.v1'||manifest.businessRunsBeforeChange!==2||manifest.actualRequestsBeforeChange!==21)throw Error('Versioned runtime baseline mismatch');
  for(const [path,hash]of Object.entries(manifest.sourceHashes))if(fileHash(resolve(baseline.directory,path))!==hash)throw Error('Original runtime source snapshot changed');return manifest;
}
export async function planProduction({root=repository,parentDirectory,outputDirectory,buildDirectory,buildReceiptFile,providerProfileFile,dryRun=false,networkMode='default'}){
  const pilotDir=resolve(root,'.tmp/memory-continuity/20261018-production-loop'),failedDir=resolve(pilotDir,'corrected16'),directory=resolve(outputDirectory);
  if(resolve(parentDirectory)!==failedDir||directory!==resolve(pilotDir,'recovery-final'))throw Error('Final recovery has one fixed failed parent and output directory');
  if(existsSync(anchorPath(root)))throw Error('Final phase already planned');
  const original=readJson(resolve(failedDir,'production-session.json')),failed=readJson(resolve(failedDir,'round-Q1.json'));
  if(failed.run?.data?.run?.status!=='failed'||failed.workerRun?.status!=='failed'||failed.workerRun?.verificationResult?.executionTrace?.runtimeTerminal?.status!=='failed'||!failed.after||snapshotLoop(failed.after)?.stateJson?.lastLoopRunId!==failed.intent.expectedRunId)throw Error('Latest failed Q1 is not preserved and bound');
  if(networkMode!=='default'||original.network.mode!=='default')throw Error('Final recovery preserves ordinary production network');
  if(!buildDirectory||!buildReceiptFile||!providerProfileFile)throw Error('New actual build receipt and fresh source-bound provider profile required');
  if(resolve(buildDirectory)!==resolve(root,'apps/web/.tmp/next-review-96'))throw Error('Final recovery requires the explicitly selected new review96 build');
  const baseline={directory:resolve(root,'.tmp/memory-production-20261018/runtime-before-recovery'),manifestFile:resolve(root,'.tmp/memory-production-20261018/runtime-before-recovery/manifest.json')};baseline.manifestHash=fileHash(baseline.manifestFile);const manifest=verifySourceBaseline(baseline);
  const buildReceipt=readJson(resolve(buildReceiptFile));if(buildReceipt.passed!==true||buildReceipt.exitCode!==0||buildReceipt.sourceDrift?.length||resolve(root,buildReceipt.buildDirectory)!==resolve(buildDirectory))throw Error('Actual new production build receipt missing');
  if(!exactNextGeneratedChange(buildReceipt,readFileSync(resolve(root,'apps/web/next-env.d.ts'),'utf8')))throw Error('Only the predeclared exact review98-to-review96 Next type import may be generated');
  const build=buildSnapshot(root,buildDirectory,[...new Set(['BUILD_ID','required-server-files.json',...Object.keys(buildReceipt.manifestHashes)])]);
  if(build.buildId!==buildReceipt.buildId||build.buildId===original.build.buildId)throw Error('New recovery build identity required');
  for(const[path,hash]of Object.entries(buildReceipt.sourceHashes))if(fileHash(resolve(root,path))!==hash)throw Error('Recovery build source drift');
  for(const[path,hash]of Object.entries(buildReceipt.manifestHashes))if(build.hashes[path]!==hash)throw Error('Recovery built manifest drift');
  const profile=readJson(resolve(providerProfileFile));if(profile.schemaVersion!=='memory-production-provider-profile.v1'||profile.sourceBinding?.status!=='matched'||profile.actualModel!==original.provider.actualModel||profile.protocol!==original.provider.protocol||profile.actualEndpointHash!==original.provider.actualEndpointHash||profile.credentialValuesOrHashesRecorded!==false||profile.modelHttp?.attemptedFetches!==0)throw Error('Fresh current provider profile invalid');
  for(const[path,hash]of Object.entries(profile.sourceBinding.sourceHashes))if(fileHash(resolve(root,path))!==hash)throw Error('Fresh recovery resolver profile stale');
  const hashes=sourceHashes(root,{...original.sourceHashes,'apps/web/scripts/memory-continuity-recovery.test.mjs':'new','packages/ai/src/agent/runtime/provider-stream-recovery.ts':'new'});
  const sourceDelta=[...new Set([...Object.keys(manifest.sourceHashes),...Object.keys(hashes)])].filter(path=>manifest.sourceHashes[path]!==hashes[path]).map(path=>({path,beforeHash:manifest.sourceHashes[path]??null,afterHash:hashes[path]??null}));
  const plan={schemaVersion:'memory-recovery-session.v1',phase:PHASE,createdAt:new Date().toISOString(),outputDirectory:directory,identity:original.identity,
    authorization:{date:'2026-10-18',scope:'Final two bounded production memory tasks after preserved failed Q1, with explicit one opaque transport recovery',previousFailuresPassed:false},
    parent:{directory:failedDir,roundFile:'round-Q1.json',roundHash:fileHash(resolve(failedDir,'round-Q1.json')),runId:failed.intent.expectedRunId,originalPlanHash:fileHash(resolve(failedDir,'production-session.json'))},
    preserved:[{directory:pilotDir,hashes:recursiveArtifacts(pilotDir,directory)}],sourceBaseline:baseline,sourceDelta,
    correction:original.correction,canonical:original.canonical,provider:original.provider,providerProfile:{filename:resolve(providerProfileFile),hash:fileHash(resolve(providerProfileFile))},providerDiagnostic:original.providerDiagnostic,providerMigration:original.providerMigration,
    allowedTools:original.allowedTools,workerPolicy:original.workerPolicy,network:original.network,build,buildReceipt:{filename:resolve(buildReceiptFile),hash:fileHash(resolve(buildReceiptFile))},
    initial:failed.after,sourceHashes:hashes,auditorHash:fileHash(resolve(root,'apps/web/scripts/verify-memory-continuity-recovery.mjs')),budget:BUDGET,cumulativeBudget:CUMULATIVE_BUDGET,rounds:ROUNDS,
    recoveryPolicy:{version:'official-go-qwen-opaque.v1',maxRecoveries:1,sharedTimeoutMs:120000,maxBufferedBytes:4194304,maxFrames:20000},
    instrumentationVersion:{version:4,newBusinessRuntimeAndBuild:true,priorSourcesPreserved:true,physicalAttemptsSeparateFromLogicalSdkCalls:true,declaredGeneratedNextTypeImport:buildReceipt.generatedSourceChanges},
    taskProtocol:original.taskProtocol,claims:{previousFailuresPassed:false,failedQ1Resurrected:false,threeNewRounds:false,productionPassed:false}};
  verifyPreserved(plan);assertSources(root,hashes);assertBuild(root,build);assertCumulativeBudget(plan,directory);if(dryRun)return plan;
  writeOnce(resolve(directory,'production-session.json'),plan);writeOnce(anchorPath(root),{schemaVersion:'memory-production-phase-anchor.v1',phase:PHASE,outputDirectory:directory,planHash:digest(plan),budget:BUDGET,cumulativeBudget:CUMULATIVE_BUDGET});return plan;
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
    const claims = Array.isArray(events) ? [...result, ...events].filter(event => event.type === 'execution_claimed' && event.runId === runId && event.workshopId === plan.identity.workshopId) : [];
    const expected = claims.length === 1 ? { workerId: claims[0].metadata?.workerId, token: claims[0].metadata?.fencingToken } : null;
    if (!Array.isArray(events) || events.some(event => event.seq <= after || !ownRunEvent(event, plan.identity, runId, expected))) throw Error('Own-run event pagination mismatch');
    result.push(...events); if (events.length < 2000) return result;
    after = events.at(-1).seq;
  }
  throw Error('Event audit pagination cap reached; evidence incomplete');
}
export function ownRunEvent(event, identity, id, expectedExecution) {
  if (event.workshopId !== identity.workshopId || event.runId != null && event.runId !== id || event.loopRunId != null && event.loopRunId !== id || event.loopId != null && event.loopId !== identity.loopId) return false;
  if (event.loopRunId === id) return event.loopId === identity.loopId;
  if (event.type === 'brain_record_written') return event.runId === id && event.loopId == null && event.loopRunId == null
    && event.metadata?.actorId === identity.userId && event.metadata.recordType === 'context_log' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(event.metadata.recordId ?? '')
    && Number.isSafeInteger(expectedExecution?.token) && expectedExecution.token > 0 && event.metadata.execution?.token === expectedExecution.token
    && event.metadata.execution?.workerId === expectedExecution.workerId && same(Object.keys(event.metadata.execution).sort(), ['token','workerId']);
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
  assertCumulativeBudget(plan, directory, {beforeNewIntent:true});
  const index = ROUNDS.indexOf(round); if (index < 0) throw Error('Explicit U1/U2 required');
  if (existsSync(resolve(directory, `round-${round}-intent.json`))) throw Error('Round already attempted; cap cannot be reset');
  let prior;
  if (index === 0) prior = plan.initial;
  else {
    prior = readJson(resolve(directory, `round-${ROUNDS[index - 1]}.json`));
    const audits = readdirSync(directory).filter(name => /^memory-recovery-independent-review-.*\.json$/.test(name)).sort();
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
  const args = Object.fromEntries(process.argv.slice(2).map(arg => { const split = arg.indexOf('='); if (!arg.startsWith('--') || split < 0) throw Error('Use --name=value'); return [arg.slice(2, split), arg.slice(split + 1)]; }));
  const allowed = ['action', 'out', 'parent', 'prior-review', 'parent-supplement', 'origin', 'cookie-file', 'deployment-receipt', 'round', 'network', 'dry-run', 'build-directory', 'build-receipt', 'provider-profile'];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw Error('Unknown production runner argument');
  const directory = resolve(args.out ?? '');
  if (['plan', 'inspect'].includes(args.action)) {
    const plan = await planProduction({ parentDirectory: resolve(args.parent), priorReview: args['prior-review'], parentSupplement: args['parent-supplement'], outputDirectory: directory,
      buildDirectory:args['build-directory'],buildReceiptFile:args['build-receipt'],providerProfileFile:args['provider-profile'],dryRun: args['dry-run'] === 'true' || args.action === 'inspect', networkMode: args.network ?? 'default' });
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
  assertCumulativeBudget(plan,directory);
  const cookie = args['cookie-file'] ? readFileSync(resolve(args['cookie-file']), 'utf8').trim() : undefined;
  const client = httpClient(args.origin ?? args['base-url'] ?? 'http://127.0.0.1:3515', cookie), deployment = readJson(resolve(args['deployment-receipt']));
  if (args.action === 'preflight') {
    const snapshot = await httpSnapshot(client, plan), binding = assertProductionPreflight(plan, snapshot, deployment, bootReceipts(directory));
    writeOnce(resolve(directory, `production-preflight-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), { schemaVersion: 'memory-production-preflight.v1', planHash: digest(plan), snapshot, binding, deployment, boots: bootReceipts(directory) });
    console.log(JSON.stringify({ preflightPassed: true, buildId: plan.build.buildId, plannedRounds: 2 })); return;
  }
  console.log(JSON.stringify(await runProductionRound({ directory, round: args.round, client, deployment })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
