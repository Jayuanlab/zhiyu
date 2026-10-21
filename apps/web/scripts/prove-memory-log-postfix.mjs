/** Explicit HTTP-only production acceptance. This file never imports an executor or writes a business database. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { same as canonicalSame } from './lib/memory-continuity-verification.mjs';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PHASE = 'memory-log-postfix-20261018';
export const MANAGED_COMMAND = 'native managed web:start';
export const ROUNDS = ['FIX1', 'FIX2'];
export const AUDIT_FILES = ['apps/web/scripts/prove-memory-log-postfix.mjs','apps/web/scripts/memory-log-postfix-preload.mjs','apps/web/scripts/verify-memory-log-postfix.mjs','apps/web/scripts/memory-log-postfix.test.mjs'];
export const AUDIT_LAUNCHER = '.tmp/memory-log-postfix-20261018/launch.mjs';
export const BUDGET = Object.freeze({ maximumRounds: 2, perRunDomainMaxAttempts: 1, maxRequests: 18, maxSeconds: 420, maxToolCalls: 14, automaticRetry: false, stopAfterFailure: true });
export const CHECKPOINT_CONTRACT = Object.freeze({ required: true, requireFreshSource: true });
export const DELIVERY_POLICY = Object.freeze({ maxCorrections: 1, maxExtraForwards: 4, reservedOutputTokens: 16384, wholeTimeoutMs: 420000,
  boundedCompaction: { maxForwards: 1, totalOutputTokens: 2048, perForwardOutputTokens: 2048 } });
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
export const anchorPath = root => resolve(root, '.tmp/memory-continuity/memory-log-postfix-20261018-phase.json');
export function childRunId(owner, work, commandId) {
  const h = digest(JSON.stringify(['work-command-child.v1', owner.toLowerCase(), work.toLowerCase(), commandId, 'loop-run']));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function assertAnchor(anchor, plan, directory) {
  if (anchor.schemaVersion !== 'memory-production-phase-anchor.v1' || anchor.phase !== PHASE
    || anchor.outputDirectory !== resolve(directory) || anchor.planHash !== digest(plan)
    || !same(anchor.budget, BUDGET)) throw Error('Fixed production phase already bound to a different plan/directory or cap');
  if (plan.schemaVersion !== 'memory-log-postfix-session.v1' || plan.phase !== PHASE || !same(anchor.cumulativeBudget, CUMULATIVE_BUDGET)) throw Error('Final recovery anchor must bind the new version and aggregate caps');
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
  for (const path of ['apps/web/lib/runtime', 'apps/web/lib/work-runtime', 'apps/web/lib/auth', 'apps/web/lib/loops', 'apps/web/lib/workshops', 'packages/ai/src/agent/runtime', 'apps/web/app/api/workshops', 'apps/web/app/api/identity', 'apps/web/app/api/runtime', 'apps/web/app/api/brain/memories']) walk(path);
  for (const path of [
    'apps/web/scripts/prove-memory-log-postfix.mjs', 'apps/web/scripts/memory-log-postfix-preload.mjs',
    'apps/web/scripts/verify-memory-log-postfix.mjs', 'apps/web/scripts/memory-log-postfix.test.mjs',
    'apps/web/scripts/verify-memory-continuity-production-repair.mjs', 'apps/web/scripts/verify-memory-continuity-resume.mjs',
    'apps/web/scripts/verify-memory-continuity-followup.mjs', 'apps/web/scripts/lib/memory-continuity-verification.mjs',
    'apps/web/scripts/start-managed-application.mjs', 'apps/web/scripts/managed-application.mjs', 'apps/web/scripts/start-runtime-worker.mjs',
    'apps/web/lib/ai/auxiliary-model-connection.ts', 'apps/web/lib/work-evolution/report-quality-evaluator.ts',
    'packages/ai/src/agent/runtime/opencode-go-endpoint.ts', 'packages/ai/src/agent/runtime/provider-stream-recovery.ts',
    'apps/web/app/(auth)/auth.ts', 'apps/web/scripts/auth-bind-policy.mjs', 'apps/web/next.config.js', 'apps/web/next-env.d.ts',
    'apps/web/package.json', 'apps/web/tsconfig.json', 'packages/ai/package.json', 'pnpm-lock.yaml',
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
  for (const snapshot of plan.historicalSourceSnapshots ?? []) {
    if (fileHash(snapshot.manifestFile) !== snapshot.manifestHash) throw Error('Historical source manifest changed');
    const manifest = readJson(snapshot.manifestFile);
    for (const [path, hash] of Object.entries(manifest.sourceHashes ?? {})) if (fileHash(inside(snapshot.directory, resolve(snapshot.directory, path))) !== hash) throw Error('Historical runtime source bytes changed');
  }
  if (plan.baselineSnapshot && fileHash(plan.baselineSnapshot.filename) !== plan.baselineSnapshot.hash) throw Error('Actual production baseline snapshot changed');
  if (plan.parent?.reviewFilename && fileHash(plan.parent.reviewFilename) !== plan.parent.reviewHash) throw Error('Original failed V1 audit changed');
  if (plan.buildSourceHashes) assertSources(repository, plan.buildSourceHashes);
  if(plan.sourceBaseline)verifySourceBaseline(plan.sourceBaseline);
  if(plan.auditorBeforeDateFix)verifyPriorAuditor(plan.auditorBeforeDateFix);
  if(plan.businessSourceHashes)assertSources(repository,plan.businessSourceHashes);
  for (const evidence of plan.externalParentEvidence ?? []) if (fileHash(evidence.filename) !== evidence.hash) throw Error('Original pilot supplemental evidence changed');
  if (plan.providerProfile && fileHash(plan.providerProfile.filename) !== plan.providerProfile.hash) throw Error('Fresh provider profile changed');
  if (plan.providerDiagnostic && fileHash(plan.providerDiagnostic.filename) !== plan.providerDiagnostic.hash) throw Error('Canonical provider diagnostic changed');
  if (plan.buildReceipt && fileHash(plan.buildReceipt.filename) !== plan.buildReceipt.hash) throw Error('Completed production build receipt changed');
  if (plan.buildDeclaration && fileHash(plan.buildDeclaration.filename) !== plan.buildDeclaration.hash) throw Error('Predeclared production compiler changes changed');
  for (const preserved of plan.preserved) for (const [name, hash] of Object.entries(preserved.hashes)) {
    if (fileHash(inside(preserved.directory, resolve(preserved.directory, name))) !== hash) throw Error('An original immutable artifact changed');
  }
}
/** The single declared compiler edit is independently reconstructed, not a drift exemption. */
export function exactNextGeneratedChange(receipt,currentText,{declaration,currentTsconfigText}={}){
  const changes=receipt?.generatedSourceChanges;
  if(!Array.isArray(changes)||typeof currentText!=='string'||!Array.isArray(receipt.sourceDrift)||receipt.sourceDrift.length)return false;
  if(changes.length===0)return receipt.sourceHashes?.['apps/web/next-env.d.ts']===digest(currentText);
  const matches=[...currentText.matchAll(/import "\.\/\.tmp\/next-review-(\d{2})\/types\/routes\.d\.ts";/g)];
  if(![1,2].includes(changes.length)||matches.length!==1)return false;
  const item=changes.find(c=>c.path==='apps/web/next-env.d.ts'),afterImport=matches[0][0],afterReview=matches[0][1];
  if(!item)return false;
  const reconstructed=Array.from({length:100},(_,n)=>String(n).padStart(2,'0')).filter(review=>review!==afterReview
    &&digest(currentText.replace(afterImport,afterImport.replace('next-review-'+afterReview,'next-review-'+review)))===item.beforeHash);
  const routeValid=item.path==='apps/web/next-env.d.ts'&&item.writer==='Next production type generation'&&item.declaredBeforeBuild===true
    &&item.afterHash===digest(currentText)&&receipt.sourceHashes?.[item.path]===item.afterHash&&reconstructed.length===1
    &&String(receipt.buildDirectory??'').replaceAll('\\','/').endsWith('/next-review-'+afterReview);
  if(!routeValid||changes.length===1)return routeValid;
  const config=changes.find(c=>c.path==='apps/web/tsconfig.json');
  if(!config||config.writer!=='Next production type generation'||config.declaredBeforeBuild!==true||config.onlyTheseJsonChanges!==true
    ||typeof currentTsconfigText!=='string'||declaration?.schemaVersion!=='memory-log-postfix-build-declaration.v1'
    ||declaration.onlyTheseConfigJsonChangesAllowed!==true||declaration.review!==afterReview
    ||typeof declaration.beforeNextText!=='string'||typeof declaration.beforeTsconfigText!=='string'
    ||digest(declaration.beforeNextText)!==item.beforeHash||declaration.sourceHashes?.[item.path]!==item.beforeHash
    ||digest(declaration.beforeTsconfigText)!==config.beforeHash||declaration.sourceHashes?.[config.path]!==config.beforeHash
    ||digest(currentTsconfigText)!==config.afterHash||receipt.sourceHashes?.[config.path]!==config.afterHash
    ||!Number.isFinite(Date.parse(declaration.declaredAt))||Date.parse(declaration.declaredAt)>Date.parse(receipt.startedAt))return false;
  const additions=['.tmp/next-review-'+afterReview+'/types/**/*.ts','.tmp/next-review-'+afterReview+'/dev/types/**/*.ts'];
  if(!same(config.addedIncludePaths,additions)||!same(declaration.configAddedIncludePaths,additions))return false;
  try{const before=JSON.parse(declaration.beforeTsconfigText),after=JSON.parse(currentTsconfigText);
    return Array.isArray(before.include)&&additions.every(p=>!before.include.includes(p))&&same(after,{...before,include:[...before.include,...additions]});
  }catch{return false;}
}
export function buildCompilerEvidence(root,receiptFile){
  const filename=resolve(dirname(receiptFile),'build-declaration.json');
  const receipt=readJson(receiptFile),declaration=existsSync(filename)?readJson(filename):undefined;
  if((receipt.generatedSourceChanges?.length??0)>1&&(!declaration||!same(receipt.buildDeclaration,{filename,hash:fileHash(filename)})))throw Error('Actual pre-build declaration file is not bound by the build receipt');
  return {filename,declaration,currentTsconfigText:readFileSync(resolve(root,'apps/web/tsconfig.json'),'utf8')};
}
export const CUMULATIVE_BUDGET = Object.freeze({maximumDomainAttempts:7,maximumProviderRequests:82,priorDomainAttempts:5,priorProviderRequests:46,newPhaseMaximumDomainAttempts:2,newPhaseMaximumProviderRequests:36,originalLogPhaseMaximumDomainAttempts:3,originalLogPhaseMaximumProviderRequests:54,originalLogPhasePriorDomainAttempts:1,originalLogPhasePriorProviderRequests:17,maximumOriginalLogPhaseProviderRequests:53,automaticDomainRetry:false,remainingOriginalAuthorization:true});
export function recursiveArtifacts(directory, excluded) {
  const result={}; const visit=current=>{for(const item of readdirSync(current,{withFileTypes:true})){const path=resolve(current,item.name);if(excluded&&path===resolve(excluded))continue;if(item.isDirectory())visit(path);else if(item.isFile())result[relative(directory,path).replaceAll('\\','/')]=fileHash(path);}};visit(directory);return result;
}
export function historicalCounts(plan,directory){
  const pilot=resolve(repository,'.tmp/memory-continuity/20261018-production-loop'),failed=resolve(pilot,'corrected16'),priorAudit=resolve(pilot,'recovery-final'),v=resolve(pilot,'audit-final');
  const originalLog=resolve(repository,'.tmp/memory-continuity/20261018-log-production');
  if(['P2','P3'].some(n=>existsSync(resolve(pilot,'round-'+n+'-intent.json')))||['Q2','Q3'].some(n=>existsSync(resolve(failed,'round-'+n+'-intent.json')))||existsSync(resolve(priorAudit,'round-U2-intent.json'))||existsSync(resolve(v,'round-V2-intent.json'))||['LOG2','LOG3'].some(n=>existsSync(resolve(originalLog,'round-'+n+'-intent.json'))))throw Error('Stopped previous rounds acquired another attempt');
  const physical=(dir,regex)=>readdirSync(resolve(dir,'spool')).filter(n=>regex.test(n)).length;
  const originalLogRequests=physical(originalLog,/^LOG1-.*\.request\.json$/);
  const prior=physical(pilot,/^P1-.*\.request\.json$/)+physical(failed,/^Q1-.*\.request\.json$/)+physical(priorAudit,/^U1-.*\.request\.json$/)+physical(v,/^V1-.*\.request\.json$/)+originalLogRequests;
  const current=existsSync(resolve(directory,'spool'))?physical(directory,/^FIX[12]-.*\.request\.json$/):0;
  const domains=ROUNDS.filter(n=>existsSync(resolve(directory,'round-'+n+'-intent.json'))).length;
  return {priorDomainAttempts:5,priorProviderRequests:prior,originalLogPhasePriorDomainAttempts:1,originalLogPhasePriorProviderRequests:originalLogRequests,newDomainAttempts:domains,newProviderRequests:current,totalDomainAttempts:5+domains,totalProviderRequests:prior+current};
}
export function assertCumulativeBudget(plan,directory,{beforeNewIntent=false}={}){
  if(!same(plan.cumulativeBudget,CUMULATIVE_BUDGET)||!same(plan.budget,BUDGET)||!same(plan.rounds,ROUNDS))throw Error('Final recovery caps changed');
  const n=historicalCounts(plan,directory);if(!withinFinalBudget(n,{beforeNewIntent}))throw Error('Final cumulative physical/domain cap exhausted');return n;
}
export function withinFinalBudget(n,{beforeNewIntent=false}={}){
  return ['priorDomainAttempts','priorProviderRequests','newDomainAttempts','newProviderRequests','totalDomainAttempts','totalProviderRequests'].every(k=>Number.isSafeInteger(n?.[k])&&n[k]>=0)
    && n.priorDomainAttempts===5 && n.priorProviderRequests===46 && n.originalLogPhasePriorDomainAttempts===1 && n.originalLogPhasePriorProviderRequests===17 && n.newDomainAttempts<=2 && n.newProviderRequests<=36
    && n.totalDomainAttempts===5+n.newDomainAttempts && n.totalProviderRequests===46+n.newProviderRequests
    && 17+n.newProviderRequests<=53 && n.totalDomainAttempts<=7 && n.totalProviderRequests<=82 && (!beforeNewIntent||n.newDomainAttempts<2);
}
export function auditOnlySourceDelta(previous,current){
  for(const[path,hash]of Object.entries(previous))if(current[path]!==hash)throw Error('Business or old audit source changed');
  const added=Object.keys(current).filter(path=>!(path in previous));
  if(!same(added.sort(),[...AUDIT_FILES,AUDIT_LAUNCHER].sort()))throw Error('Only new audit tools and declared new launcher may enter the source delta');
  return added.map(path=>({path,beforeHash:null,afterHash:current[path]}));
}
export function verifyPriorAuditor(snapshot){
  const manifest=readJson(snapshot.manifestFile);if(fileHash(snapshot.manifestFile)!==snapshot.manifestHash||manifest.schemaVersion!=='memory-auditor-before-date-fix.v1'||manifest.businessRuntimeChanged!==false||manifest.files.length!==4)throw Error('Original U audit snapshot mismatch');
  for(const f of manifest.files)if(fileHash(resolve(snapshot.directory,f.filename))!==f.hash||fileHash(resolve(repository,f.source))!==f.hash)throw Error('Original U audit bytes changed');return manifest;
}
export function verifySourceBaseline(baseline){
  const manifest=readJson(baseline.manifestFile);if(fileHash(baseline.manifestFile)!==baseline.manifestHash||manifest.schemaVersion!=='memory-recovery-source-parent.v1'||manifest.businessRunsBeforeChange!==2||manifest.actualRequestsBeforeChange!==21)throw Error('Versioned runtime baseline mismatch');
  for(const [path,hash]of Object.entries(manifest.sourceHashes))if(fileHash(resolve(baseline.directory,path))!==hash)throw Error('Original runtime source snapshot changed');return manifest;
}
export function assertCheckpointBaseline(parent, previous, snapshot) {
  const loop = snapshotLoop(snapshot), work = snapshot.workshop?.data?.workshop;
  if (snapshot.identity?.data?.actorId !== parent.identity.userId || loop?.id !== parent.identity.loopId || work?.id !== parent.identity.workshopId
    || digest(loop.goal) !== parent.identity.goalHash || digest(work.modelConfig) !== parent.identity.modelConfigHash
    || digest([loop.goal, loop.contextConfig, loop.actionPolicy, loop.approvalPolicy, loop.retryPolicy]) !== parent.identity.loopConfigurationHash)
    throw Error('New LOG phase changed the original owner/work/goal/model/tool boundary');
  if (!same(loop.verificationConfig?.workingMemoryCheckpoint, CHECKPOINT_CONTRACT)) throw Error('Explicit persisted fresh-LOG checkpoint contract is required');
  if(digest(loop.verificationConfig)!==parent.identity.loopVerificationHash||!same(expectedState(previous.after),expectedState(snapshot)))throw Error('Latest failed LOG1 state or complete verification config changed');
}

export async function planProduction({root=repository,parentDirectory,outputDirectory,buildDirectory,buildReceiptFile,providerProfileFile,launcherFile,
  baselineSnapshotFile,priorReviewFile,dryRun=false,networkMode='default'}) {
  const pilotDir=resolve(root,'.tmp/memory-continuity/20261018-production-loop'),parentDir=resolve(root,'.tmp/memory-continuity/20261018-log-production'),directory=resolve(outputDirectory);
  if(resolve(parentDirectory)!==parentDir||directory!==resolve(root,'.tmp/memory-continuity/20261018-log-postfix'))throw Error('Remaining LOG authorization has one fixed failed LOG1 parent and output directory');
  if(existsSync(anchorPath(root)))throw Error('LOG postfix phase already planned; remaining cap cannot be reset');
  const original=readJson(resolve(parentDir,'production-session.json')),prior=readJson(resolve(parentDir,'round-LOG1.json'));
  for(const path of ['apps/web/scripts/prove-memory-log-production.mjs','apps/web/scripts/memory-log-production-preload.mjs','apps/web/scripts/verify-memory-log-production.mjs','apps/web/scripts/memory-log-production.test.mjs'])if(fileHash(resolve(root,path))!==original.sourceHashes[path])throw Error('Original frozen LOG tooling changed');
  const reviewFile=resolve(priorReviewFile??'');
  if(dirname(reviewFile)!==parentDir)throw Error('Explicit immutable failed LOG1 independent review is required');
  const priorReview=readJson(reviewFile);
  if(original.phase!=='memory-log-production-20261018'||prior.run?.data?.run?.status!=='failed'||prior.workerRun?.status!=='failed'||!prior.after
    ||priorReview.passed!==false||priorReview.roundAcceptance?.LOG1?.completeRealTask!==false||priorReview.roundAcceptance?.LOG1?.mechanismPassed!==false
    ||!same(original.budget,{...BUDGET,maximumRounds:3})||prior.providerRequests?.length!==17||['LOG2','LOG3'].some(n=>existsSync(resolve(parentDir,'round-'+n+'-intent.json'))))
    throw Error('Original failed LOG1 and its exhausted attempt must remain failed; no stopped round may resume');
  if(networkMode!=='default'||original.network.mode!=='default')throw Error('Use the ordinary production network');
  if(!baselineSnapshotFile||!buildDirectory||!buildReceiptFile||!providerProfileFile)throw Error('Actual new baseline snapshot, selected build, build receipt and provider profile are required');
  const baselineFile=resolve(baselineSnapshotFile),baseline=readJson(baselineFile),snapshot=baseline.snapshot;
  if(baseline.schemaVersion!=='memory-log-postfix-baseline.v1'||baseline.modelCalls!==0||baseline.domainAttempts!==0||!snapshot)throw Error('Read-only new production baseline receipt is required');
  assertCheckpointBaseline(original,prior,snapshot);
  const build=buildSnapshot(root,buildDirectory),buildFile=resolve(buildReceiptFile),buildReceipt=readJson(buildFile),compiler=buildCompilerEvidence(root,buildFile);
  if(buildReceipt.passed!==true||buildReceipt.exitCode!==0||buildReceipt.buildId!==build.buildId
    ||resolve(root,buildReceipt.buildDirectory)!==build.directory||!exactNextGeneratedChange(buildReceipt,readFileSync(resolve(root,'apps/web/next-env.d.ts'),'utf8'),compiler))
    throw Error('A real new completed and source-bound production build is required');
  assertSources(root,buildReceipt.sourceHashes);
  if(resolve(root,launcherFile??AUDIT_LAUNCHER)!==resolve(root,AUDIT_LAUNCHER))throw Error('Exact new LOG launcher required');
  const profileFile=resolve(providerProfileFile),profile=readJson(profileFile);
  if(profile.sourceBinding?.status!=='matched'||profile.modelHttp?.fetchBlocked!==true||profile.modelHttp.attemptedFetches!==0
    ||profile.credentialValuesOrHashesRecorded!==false||profile.actualModel!==original.provider.actualModel
    ||profile.protocol!==original.provider.protocol||profile.actualEndpointHash!==original.provider.actualEndpointHash)
    throw Error('Source-bound unchanged actual provider profile is required');
  assertSources(root,profile.sourceBinding.sourceHashes);
  const hashes=sourceHashes(root,{...original.sourceHashes,[AUDIT_LAUNCHER]:fileHash(resolve(root,AUDIT_LAUNCHER))});
  const pilot=readJson(resolve(pilotDir,'production-session.json'));
  const preservedDirectories=[parentDir,pilotDir,...(pilot.preserved??[]).map(p=>p.directory)];
  const historicalSourceSnapshots=['runtime-at-v1','runtime-before-recovery'].map(name=>{
    const dir=resolve(root,'.tmp/memory-production-20261018',name),manifestFile=resolve(dir,'manifest.json');
    return {directory:dir,manifestFile,manifestHash:fileHash(manifestFile)};
  });
  const logSnapshotDir=resolve(root,'.tmp/memory-log-production-20261018/runtime-at-log1'),logSnapshotFile=resolve(logSnapshotDir,'manifest.json'),logSnapshot=readJson(logSnapshotFile);
  if(logSnapshot.schemaVersion!=='memory-log-runtime-at-log1.v1'||logSnapshot.previousDomainAttempts!==5||logSnapshot.previousProductionRequests!==46||logSnapshot.originalLogPhaseDomainAttempts!==1||logSnapshot.originalLogPhaseRequests!==17||logSnapshot.productionStopped!==true
    ||logSnapshot.parentPlanHash!==fileHash(resolve(parentDir,'production-session.json'))||logSnapshot.parentRoundHash!==fileHash(resolve(parentDir,'round-LOG1.json'))||logSnapshot.parentReviewHash!==fileHash(reviewFile))throw Error('Actual frozen LOG1 runtime and failed ledger snapshot required');
  historicalSourceSnapshots.push({directory:logSnapshotDir,manifestFile:logSnapshotFile,manifestHash:fileHash(logSnapshotFile)});
  const sourceDelta=Object.keys(hashes).filter(path=>hashes[path]!==original.sourceHashes[path]).map(path=>({path,beforeHash:original.sourceHashes[path]??null,afterHash:hashes[path]}));
  const loop=snapshotLoop(snapshot),identity={...original.identity,loopVerificationHash:digest(loop.verificationConfig)};
  const plan={schemaVersion:'memory-log-postfix-session.v1',phase:PHASE,createdAt:new Date().toISOString(),outputDirectory:directory,
    authorization:{date:'2026-10-18',scope:'Versioned postfix using only the two remaining tasks of the original three-task LOG authorization',
      newPhaseDomainAttempts:2,newPhasePhysicalRequests:36,originalLogAttemptsConsumed:1,originalLogPhysicalRequestsConsumed:17,originalLogMaximumRequests:54,previousFailuresPassed:false,oldCapsRewritten:false,automaticDomainRetry:false},
    parent:{directory:parentDir,roundFile:'round-LOG1.json',roundHash:fileHash(resolve(parentDir,'round-LOG1.json')),runId:prior.intent.expectedRunId,
      originalPlanHash:fileHash(resolve(parentDir,'production-session.json')),reviewFilename:reviewFile,reviewHash:fileHash(reviewFile),
      businessCompleted:false,strictAccepted:false,freshCheckpointSaved:true,checkpointEligible:false},
    preserved:[...new Set(preservedDirectories)].map(dir=>({directory:dir,hashes:recursiveArtifacts(dir)})),historicalSourceSnapshots,
    externalParentEvidence:[{filename:resolve(root,'.tmp/memory-continuity/memory-log-production-20261018-phase.json'),hash:fileHash(resolve(root,'.tmp/memory-continuity/memory-log-production-20261018-phase.json'))}],
    baselineSnapshot:{filename:baselineFile,hash:fileHash(baselineFile)},sourceDelta,buildSourceHashes:buildReceipt.sourceHashes,
    correction:original.correction,canonical:original.canonical,provider:original.provider,
    providerProfile:{filename:profileFile,hash:fileHash(profileFile)},providerDiagnostic:original.providerDiagnostic,
    providerMigration:original.providerMigration,allowedTools:original.allowedTools,
    workerPolicy:{...original.workerPolicy,maxToolCalls:'14'},network:original.network,build,
    buildReceipt:{filename:buildFile,hash:fileHash(buildFile)},
    ...(compiler.declaration?{buildDeclaration:{filename:compiler.filename,hash:fileHash(compiler.filename)}}:{}),initial:snapshot,identity,sourceHashes:hashes,
    auditorHash:fileHash(resolve(root,'apps/web/scripts/verify-memory-log-postfix.mjs')),
    budget:BUDGET,cumulativeBudget:CUMULATIVE_BUDGET,rounds:ROUNDS,recoveryPolicy:original.recoveryPolicy,
    checkpointContract:CHECKPOINT_CONTRACT,checkpointDeliveryPolicy:DELIVERY_POLICY,
    instrumentationVersion:{version:7,remainingOriginalAuthorization:true,originalLogAttemptPreserved:true,newCheckpointContract:false,priorSourcesPreserved:true,
      newRuntimeAndBuild:true,physicalAttemptsSeparateFromLogicalSdkCalls:true,declaredGeneratedNextTypeImport:buildReceipt.generatedSourceChanges},
    taskProtocol:{original:original.taskProtocol,goalAndContextUnchanged:true,eachRoundRequiresFreshSourceBoundAcceptedLog:true,renewalIsNewSourceCheckpointNotTtlExtension:true},
    claims:{previousFailuresPassed:false,stoppedOldRoundsResumed:false,productionPassed:false}};
  assertFixtureSnapshot(plan,snapshot);verifyPreserved(plan);assertSources(root,hashes);assertBuild(root,build);assertCumulativeBudget(plan,directory);
  if(dryRun)return plan;
  writeOnce(resolve(directory,'production-session.json'),plan);
  writeOnce(anchorPath(root),{schemaVersion:'memory-production-phase-anchor.v1',phase:PHASE,outputDirectory:directory,planHash:digest(plan),budget:BUDGET,cumulativeBudget:CUMULATIVE_BUDGET});
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
  if (digest(loop.verificationConfig) !== plan.identity.loopVerificationHash
    || !same(loop.verificationConfig?.workingMemoryCheckpoint,CHECKPOINT_CONTRACT)
    || !same(plan.checkpointContract,CHECKPOINT_CONTRACT)||!same(plan.checkpointDeliveryPolicy,DELIVERY_POLICY))throw Error('Persisted opt-in checkpoint contract or bounded host final-validation policy drift');
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
  const index = ROUNDS.indexOf(round); if (index < 0) throw Error('Explicit FIX1/FIX2 required');
  if (existsSync(resolve(directory, `round-${round}-intent.json`))) throw Error('Round already attempted; cap cannot be reset');
  let prior;
  if (index === 0) prior = plan.initial;
  else {
    prior = readJson(resolve(directory, `round-${ROUNDS[index - 1]}.json`));
    const audits = readdirSync(directory).filter(name => /^memory-log-postfix-independent-review-.*\.json$/.test(name)).sort();
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
  const allowed = ['action', 'out', 'parent', 'prior-review', 'baseline-snapshot', 'origin', 'cookie-file', 'deployment-receipt', 'round', 'network', 'dry-run', 'build-directory', 'build-receipt', 'provider-profile', 'launcher'];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw Error('Unknown production runner argument');
  const directory = resolve(args.out ?? '');
  if(args.action==='inspect'){
    if(directory!==resolve(repository,'.tmp/memory-continuity/20261018-log-postfix'))throw Error('One fixed LOG output directory required');
    const parentDirectory=resolve(args.parent),original=readJson(resolve(parentDirectory,'production-session.json'));
    if(parentDirectory!==resolve(repository,'.tmp/memory-continuity/20261018-log-production'))throw Error('Original failed LOG1 parent required');
    const previous=readJson(resolve(parentDirectory,'round-LOG1.json'));
    const client=httpClient(args.origin??'http://127.0.0.1:3515',args['cookie-file']?readFileSync(resolve(args['cookie-file']),'utf8').trim():undefined);
    const snapshot=await httpSnapshot(client,original);assertCheckpointBaseline(original,previous,snapshot);
    const probePlan={...original,identity:{...original.identity,loopVerificationHash:digest(snapshotLoop(snapshot).verificationConfig)},checkpointContract:CHECKPOINT_CONTRACT,checkpointDeliveryPolicy:DELIVERY_POLICY};
    assertFixtureSnapshot(probePlan,snapshot);
    if(!args['build-directory']||!args['build-receipt'])throw Error('Explicit actual build directory and receipt required');
    const build=buildSnapshot(repository,args['build-directory']),receiptFile=resolve(args['build-receipt']),receipt=readJson(receiptFile);
    if(receipt.passed!==true||receipt.exitCode!==0||receipt.buildId!==build.buildId||resolve(repository,receipt.buildDirectory)!==build.directory
      ||!exactNextGeneratedChange(receipt,readFileSync(resolve(repository,'apps/web/next-env.d.ts'),'utf8'),buildCompilerEvidence(repository,receiptFile)))throw Error('Selected completed current build is required');
    assertSources(repository,receipt.sourceHashes);
    const filename=resolve(directory,'production-baseline-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
    writeOnce(filename,{schemaVersion:'memory-log-postfix-baseline.v1',snapshot,build,sourceHashes:sourceHashes(repository,original.sourceHashes),
      bootstrapOnly:true,modelCalls:0,domainAttempts:0,priorLOG1StrictPassed:false});
    console.log(JSON.stringify({schemaVerified:true,baselineReceipt:filename,buildId:build.buildId,modelCalls:0,domainAttempts:0}));return;
  }
  if (args.action === 'plan') {
    const plan = await planProduction({ parentDirectory: resolve(args.parent), priorReviewFile: args['prior-review'], baselineSnapshotFile:args['baseline-snapshot'], outputDirectory: directory,
      buildDirectory:args['build-directory'],buildReceiptFile:args['build-receipt'],providerProfileFile:args['provider-profile'],launcherFile:args.launcher,dryRun: args['dry-run'] === 'true', networkMode: args.network ?? 'default' });
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
