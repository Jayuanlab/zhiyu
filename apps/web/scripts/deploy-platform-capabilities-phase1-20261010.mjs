import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parse} from 'dotenv';
import postgres from 'postgres';
import {productionBuildEnvironment,productionBuildGuardSource} from './restart-platform-evidence-production.mjs';
import {captureReleaseSources} from '../../../scripts/release-source-snapshot.mjs';

// This release has no migration or business-state mutation. Stop only its known supervisor.
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(web,'../..');
const contextFix=process.argv.includes('--context-fix');
const agentFirst=process.argv.includes('--agent-first');
const observationFix=process.argv.includes('--observation-fix');
assert(!(contextFix&&agentFirst),'select_one_release');
const review=agentFirst?'83':contextFix?'78':'77', previousReview=agentFirst?'80':contextFix?'77':'76', mode=process.argv[2];
const flowEnvironment=agentFirst?{PLATFORM_REASONING_MODE:'agent',BRAIN_RECALL_PLANNER:'llm',PLATFORM_RECALL_PREFETCH:'off',PLATFORM_CAPABILITY_ROUTING:'off',BRAIN_JEV_ROUTING:'off',BRAIN_JEV_MODE:'off',BRAIN_JEV_TARGETED_RETRY:'false'}:
 {PLATFORM_REASONING_MODE:'optimized',BRAIN_RECALL_PLANNER:'rules',PLATFORM_RECALL_PREFETCH:'rules',PLATFORM_CAPABILITY_ROUTING:'rules'};
const certificateName=observationFix?'ops-certified-ready-observation.json':'ops-certified-ready.json';
const folder=path.join(root,`.runtime/deployments/platform-capabilities/20261010-review${review}`);
const oldFolder=agentFirst?path.join(root,'.runtime/deployments/platform-capabilities/20261010-review80'):contextFix?path.join(root,'.runtime/deployments/platform-capabilities/20261010-review77'):
 'C:/Users/96012/.codex/eval-sandboxes/workshop-chat-control-production-20261009';
assert(['build','certify-ops','switch','observe','rollback'].includes(mode),'explicit_release_phase_required');
assert(!observationFix||(contextFix&&['certify-ops','observe'].includes(mode)),'observation_fix_is_certify_or_read_only_observe');
const executeFile=promisify(execFile);
const controllerPath='apps/web/scripts/deploy-platform-capabilities-phase1-20261010.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const save=async(name,value)=>fs.writeFile(path.join(folder,name),JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});
const load=async name=>JSON.parse(await fs.readFile(path.join(folder,name),'utf8'));
const envFiles=['.env.production','.env.production.local','.env','.env.local'];
const effective={},envHashes={};
for(const name of envFiles){const file=path.join(web,name);if(existsSync(file)){const bytes=await fs.readFile(file);envHashes[name]=hash(bytes);Object.assign(effective,parse(bytes));}}
Object.assign(effective,process.env);
assert.equal(effective.ZHIYU_RUNTIME_MODE,'worker');
assert(!effective.ZHIYU_TEST_MODE && !effective.ZHIYU_TEST_DATABASE_URL,'test_environment_forbidden');
assert.match(effective.ZHIYU_RUNTIME_OWNER_ID??'',/^[a-f0-9-]{36}$/i);
const dbUrl=effective.POSTGRES_URL;
assert(['localhost','127.0.0.1','[::1]'].includes(new URL(dbUrl).hostname),'local_database_required');
const secretValues=Object.entries(effective).filter(([key])=>/(?:api_?key|token|credential|secret|password|private_?key|encryption_?key|(?:POSTGRES|DATABASE).*URL)/i.test(key)).map(([,value])=>value).filter(value=>value&&value.length>=4).sort((a,b)=>b.length-a.length);
const redact=input=>{let text=String(input);for(const value of secretValues)text=text.split(value).join('[REDACTED]');return text.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi,'[REDACTED_POSTGRES_URL]').replace(/Bearer\s+[^\s'"<>]+/gi,'Bearer [REDACTED]').replace(/\bsk-[a-zA-Z0-9_-]{8,}/g,'[REDACTED_KEY]');};
const exclusions=new Set(['apps/web/scripts/run-platform-capability-matched-eval.mts','apps/web/scripts/lib/platform-capability-matched-eval.mts','apps/web/scripts/fixtures/platform-capability-matched-v1.json']);
function sources(){const value=captureReleaseSources(root);value.files=value.files.filter(row=>!exclusions.has(row.path));value.sourceHash=hash(JSON.stringify(value.files));value.exclusions=[...exclusions];return value;}
async function packageArtifacts(){const rows=[];async function walk(dir){for(const entry of(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await walk(file);else if(entry.isFile())rows.push({path:path.relative(root,file),sha256:hash(await fs.readFile(file))});}}for(const entry of(await fs.readdir(path.join(root,'packages'),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(!entry.isDirectory()||entry.isSymbolicLink())continue;for(const name of ['dist','build']){const dir=path.join(root,'packages',entry.name,name);if(existsSync(dir))await walk(dir);}}return {files:rows,artifactHash:hash(JSON.stringify(rows))};}
async function observeDb(){const sql=postgres(dbUrl,{max:1,connect_timeout:5,onnotice:()=>{},connection:{statement_timeout:10000}});try{return await sql.begin('isolation level repeatable read read only',async tx=>{
 const busy=await tx`SELECT r.id,r.workshop_id,r.status FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id WHERE w.user_id=${effective.ZHIYU_RUNTIME_OWNER_ID}::uuid AND r.status IN ('queued','running','cancel_requested')`;
 const active=await tx`SELECT count(*)::int AS count, count(*) FILTER(WHERE l.lease_until>now())::int AS live FROM workshop_execution_leases l JOIN workshops w ON w.id=l.workshop_id WHERE w.user_id=${effective.ZHIYU_RUNTIME_OWNER_ID}::uuid AND l.phase='running'`;
 const loops=await tx`SELECT id,workshop_id,status FROM loops WHERE user_id=${effective.ZHIYU_RUNTIME_OWNER_ID}::uuid ORDER BY id`;
 const leases=await tx`SELECT i.id,i.phase,i.desired_status,l.lease_until,l.lease_until>clock_timestamp() AS fresh FROM runtime_owner_leases l JOIN runtime_instances i ON i.id=l.instance_id AND i.owner_id=l.owner_id WHERE l.owner_id=${effective.ZHIYU_RUNTIME_OWNER_ID}::uuid`;
 const migration=await tx`SELECT created_at,hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
 const journal=JSON.parse(await fs.readFile(path.join(web,'lib/db/migrations/meta/_journal.json'),'utf8'));
 return JSON.parse(JSON.stringify({busy,activeExecutionLeases:active[0].live,runningExecutionLeases:active[0].count,loops:loops.map(row=>({id:row.id,workshop_id:row.workshop_id,status:row.status})),leases,pendingMigrations:journal.entries.filter(entry=>entry.when>Number(migration[0].created_at)).map(entry=>entry.tag)}));
});}finally{await sql.end({timeout:3});}}
async function httpSnapshot(buildReview){const get=async p=>{const response=await fetch('http://127.0.0.1:3515'+p,{signal:AbortSignal.timeout(15000),cache:'no-store'});assert.equal(response.status,200,p);return response;};
 const identity=await(await get('/api/identity')).json();assert.equal(identity.actorId,effective.ZHIYU_RUNTIME_OWNER_ID);
 const runtime=await(await get('/api/runtime/status')).json();
 const buildId=(await fs.readFile(path.join(web,`.tmp/next-review-${buildReview}/BUILD_ID`),'utf8')).trim();
 const asset=Buffer.from(await(await get(`/_next/static/${buildId}/_buildManifest.js`)).arrayBuffer());
 const expected=await fs.readFile(path.join(web,`.tmp/next-review-${buildReview}/static/${buildId}/_buildManifest.js`));assert(asset.equals(expected),'served_asset_mismatch');
 const pages=[];for(const p of ['/','/workshop']){await get(p);pages.push({path:p,status:200});}
 const worker=runtime.worker;return {at:new Date().toISOString(),review:buildReview,buildId,assetSha256:hash(asset),identityOwnerMatches:true,pages,worker:{instanceId:worker?.instanceId,online:worker?.online,phase:worker?.phase,heartbeatAgeMs:worker?.heartbeatAgeMs,modules:worker?.modules?.map(m=>({name:m.name,phase:m.phase,lastError:redact(m.lastError??''),lastSuccessAt:m.lastSuccessAt}))}};
}
function sourceDifferences(before,after){
 const a=new Map(before.files.map(row=>[row.path,row.sha256])),b=new Map(after.files.map(row=>[row.path,row.sha256]));
 return [...new Set([...a.keys(),...b.keys()])].sort().filter(name=>a.get(name)!==b.get(name))
   .map(name=>({path:name,beforeSha256:a.get(name)??null,afterSha256:b.get(name)??null}));
}
async function releaseChecks(){
 const before=await load('before.json'),exit=await load('build-exit.json');
 assert.equal(exit.code,0,'next_build_failed');
 const guard=path.join(folder,'build-guard.jsonl');
 assert(!existsSync(guard)||(await fs.stat(guard)).size===0,'build_guard_rejected_io');
 assert.deepEqual(envHashes,before.envHashes,'environment_changed_since_build');
 assert.equal((await packageArtifacts()).artifactHash,before.packages.artifactHash,'package_artifacts_changed_since_build');
 const buildId=(await fs.readFile(path.join(web,`.tmp/next-review-${review}/BUILD_ID`),'utf8')).trim();
 assert.match(buildId,/^[a-zA-Z0-9_-]+$/,'invalid_build_id');
 return {before,buildId};
}
async function fileDigest(name){
 const file=path.join(folder,name);return existsSync(file)?hash(await fs.readFile(file)):null;
}
async function certifyOperations(){
 const {before,buildId}=await releaseChecks(),original=await load('source-before.json'),afterBuild=await load('source-after-build.json');
 assert.equal(original.revision,afterBuild.revision,'revision_changed_during_build');
 const generated=sourceDifferences(original,afterBuild);
 assert(generated.every(row=>row.path==='apps/web/tsconfig.json'),'runtime_source_changed_during_build');
 const current=sources(),changes=sourceDifferences(original,current);
 assert.equal(current.revision,original.revision,'revision_changed_since_build');
 assert(changes.every(row=>row.path===controllerPath&&row.beforeSha256&&row.afterSha256),'only_ops_controller_change_allowed');
 const originalReady=existsSync(path.join(folder,'build-ready.json'))?await load('build-ready.json'):null;
 if(originalReady){assert.equal(originalReady.review,review);assert.equal(originalReady.buildId,buildId);assert.equal(originalReady.sourceHash,afterBuild.sourceHash);}
 const certificate={at:new Date().toISOString(),review,buildId,sourceHash:current.sourceHash,
   compiledSourceBeforeHash:original.sourceHash,sourceAfterBuildHash:afterBuild.sourceHash,
   generatedBuildDifferences:generated,operationsDifferences:changes,envHashes:before.envHashes,
   packageArtifactHash:before.packages.artifactHash,originalSourceBeforeSha256:await fileDigest('source-before.json'),
   originalSourceAfterBuildSha256:await fileDigest('source-after-build.json'),originalReadySha256:await fileDigest('build-ready.json'),
   ...(observationFix?{priorOperationsCertificateSha256:await fileDigest('ops-certified-ready.json')}:{}),
   note:'Only the standalone operations controller changed. Current tsconfig matches the original source hash. Original build evidence is retained.'};
 const target=path.join(folder,certificateName);
 if(existsSync(target)){const old=await load(certificateName);assert.equal(old.sourceHash,certificate.sourceHash,'do_not_overwrite_ops_certificate');assert.equal(old.buildId,buildId);return old;}
 await fs.writeFile(target,JSON.stringify(certificate,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
 return certificate;
}
async function certifiedRelease(){
 const {before,buildId}=await releaseChecks(),ready=await load(certificateName);
 assert.equal(ready.review,review);assert.equal(ready.buildId,buildId,'build_id_changed_since_certification');
 assert.equal(sources().sourceHash,ready.sourceHash,'sources_changed_since_certification');
 assert.equal(await fileDigest('source-before.json'),ready.originalSourceBeforeSha256,'original_source_record_changed');
 assert.equal(await fileDigest('source-after-build.json'),ready.originalSourceAfterBuildSha256,'original_build_record_changed');
 assert.equal(await fileDigest('build-ready.json'),ready.originalReadySha256,'original_ready_record_changed');
 if(observationFix)assert.equal(await fileDigest('ops-certified-ready.json'),ready.priorOperationsCertificateSha256,'original_ops_certificate_changed');
 return {before,ready};
}
async function launcherState(targetFolder){return JSON.parse(await fs.readFile(path.join(targetFolder,'launcher-state.json'),'utf8'));}
async function runtimeEvents(targetFolder){
 // Only retain host event fields. Never print raw service logs or environment.
 const filename=path.join(targetFolder,'managed-stdout.log');if(!existsSync(filename))return [];
 const handle=await fs.open(filename,'r');let text;
 try{const {size}=await handle.stat(),limit=1048576;
   // Keep startup identity and recent lifecycle events, bounded to two MiB.
   // Reading the whole small log avoids duplicates from overlapping windows.
   const windows=size<=2*limit?[[0,size]]:[[0,limit],[size-limit,limit]],parts=[];
   for(const [start,length] of windows){const buffer=Buffer.alloc(length),{bytesRead}=await handle.read(buffer,0,length,start);
     let part=buffer.subarray(0,bytesRead).toString('utf8');
     if(start>0){const newline=part.indexOf('\n');part=newline<0?'':part.slice(newline+1);}
     if(start+length<size){const newline=part.lastIndexOf('\n');part=newline<0?'':part.slice(0,newline+1);}
     parts.push(part);
   }
   text=parts.join('\n');
 }finally{await handle.close();}
 const events=[];
 for(const line of text.split(/\r?\n/)){if(!line.startsWith('{'))continue;let row;try{row=JSON.parse(line);}catch{continue;}
   if(!['runtime_state','runtime_stop','application_stopped','application_worker_ready','application_web_started'].includes(row.event))continue;
   events.push({event:row.event,instanceId:row.instanceId,phase:row.phase,at:row.at,
     ...(typeof row.settled==='boolean'?{settled:row.settled}:{}),
     ...(Array.isArray(row.unsettled)?{unsettled:row.unsettled.map(value=>typeof value==='string'?redact(value):'invalid_module')} : {}),
     ...(Number.isInteger(row.code)?{code:row.code}:{}),...(Number.isInteger(row.pid)?{pid:row.pid}:{})});
 }
 return events;
}
async function processEvidence(state,events=[]){
 assert.equal(process.platform,'win32','windows_process_evidence_required');
 const command='$rows=@(Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name} }); $ports=@(Get-NetTCPConnection -LocalPort 3515 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.OwningProcess;port=$_.LocalPort} }); @{processes=$rows;listeners=$ports} | ConvertTo-Json -Compress -Depth 5';
 const output=await executeFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,maxBuffer:4194304});
 const inventory=JSON.parse(output.stdout.trim());
 assert(Array.isArray(inventory.processes)&&Array.isArray(inventory.listeners),'invalid_process_inventory');
 const roots=[state.supervisorPid,state.managedPid,...events.filter(row=>['application_worker_ready','application_web_started'].includes(row.event)).map(row=>row.pid)]
   .filter(value=>Number.isInteger(value)&&value>0),owned=new Set(roots);
 for(let changed=true;changed;){changed=false;for(const row of inventory.processes){if(owned.has(row.parent)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}}
 return {at:new Date().toISOString(),rootPids:[...new Set(roots)],liveTree:inventory.processes.filter(row=>owned.has(row.pid)),listeners:inventory.listeners};
}
async function healthyProof(value,targetFolder,before){
 const worker=value.worker,expectedNames=before.http.worker.modules.map(row=>row.name),names=worker.modules?.map(row=>row.name);
 assert.equal(worker.online,true,'worker_not_online');assert.equal(worker.phase,'running','worker_not_running');
 assert.match(worker.instanceId??'',/^[a-f0-9-]{36}$/i,'invalid_worker_instance');
 assert.notEqual(worker.instanceId,before.http.worker.instanceId,'old_worker_instance_reused');
 assert(Number.isFinite(worker.heartbeatAgeMs)&&worker.heartbeatAgeMs>=0&&worker.heartbeatAgeMs<=15000,'worker_heartbeat_not_fresh');
 assert(Array.isArray(names)&&names.length>=10&&new Set(names).size===names.length,'worker_module_inventory_invalid');
 assert(names.includes('chat-result-delivery')&&expectedNames.every(name=>names.includes(name)),'required_worker_module_missing');
 assert(worker.modules.every(row=>!row.lastError&&row.phase!=='error'&&row.lastSuccessAt!==null&&row.lastSuccessAt!==undefined),'worker_module_not_healthy');
 const state=await launcherState(targetFolder);assert.equal(state.status,'running','new_launcher_not_running');
 const events=await runtimeEvents(targetFolder),latestRuntime=events.filter(row=>row.event==='runtime_state').at(-1);
 assert.equal(latestRuntime?.instanceId,worker.instanceId,'launcher_worker_instance_mismatch');assert.equal(latestRuntime.phase,'running');
 const processes=await processEvidence(state,events),workerReady=events.filter(row=>row.event==='application_worker_ready').at(-1),
   webReady=events.filter(row=>row.event==='application_web_started').at(-1);
 assert(processes.liveTree.some(row=>row.pid===state.managedPid),'new_manager_process_missing');
 assert(workerReady&&processes.liveTree.some(row=>row.pid===workerReady.pid),'new_worker_process_missing');
 assert(webReady&&processes.listeners.length>0&&processes.listeners.every(row=>row.pid===webReady.pid),'new_web_listener_mismatch');
 const database=await observeDb();assert.equal(database.leases.length,1,'owner_lease_not_unique');
 const lease=database.leases[0];assert.equal(lease.id,worker.instanceId,'http_db_worker_mismatch');
 assert.equal(lease.fresh,true,'worker_lease_not_fresh');assert.equal(lease.phase,'running','db_worker_not_running');
 return {http:value,database,launcherState:state,launcherRuntimeState:latestRuntime,workerReady,webReady,processes};
}
async function quiescentProof(targetFolder,state,expectedInstance){
 const events=await runtimeEvents(targetFolder),latestRuntime=events.filter(row=>row.event==='runtime_state').at(-1),
   instanceId=expectedInstance??latestRuntime?.instanceId,stop=events.filter(row=>row.event==='runtime_stop'&&row.instanceId===instanceId).at(-1),
   applicationStop=events.filter(row=>row.event==='application_stopped').at(-1),processes=await processEvidence(state,events),database=await observeDb();
 assert.equal(processes.liveTree.length,0,'known_process_tree_still_alive');
 assert.equal(processes.listeners.length,0,'port_3515_still_listening');
 assert(!database.leases.some(row=>row.fresh),'owner_lease_still_fresh');
 assert.equal(database.busy.length,0,'unsettled_workshop_runs');assert.equal(database.runningExecutionLeases,0,'unsettled_execution_lease');
 assert(applicationStop&&Number.isInteger(applicationStop.code),'application_stop_not_observed');
 if(instanceId){
   assert.equal(latestRuntime?.instanceId,instanceId,'stopped_worker_instance_changed');
   assert(stop&&stop.settled===true&&Array.isArray(stop.unsettled)&&stop.unsettled.length===0&&stop.phase==='stopped','worker_stop_not_settled');
   assert(events.indexOf(applicationStop)>events.indexOf(stop),'application_stop_precedes_worker_stop');
   assert(database.leases.every(row=>row.id!==instanceId||row.phase==='stopped'),'db_worker_stop_not_confirmed');
 }else{
   // A startup failure before any worker state/ready may recover only when the
   // prior released owner lease remains stopped and all process/DB checks pass.
   assert(!expectedInstance&&!events.some(row=>row.event==='application_worker_ready'),'worker_start_status_unknown');
   assert(database.leases.every(row=>row.phase==='stopped'),'unobserved_worker_state');
 }
 return {at:new Date().toISOString(),state,instanceId:instanceId??null,workerStatus:instanceId?'settled':'never_ready_observed',
   runtimeStop:stop??null,applicationStop,processes,database,scope:'Process and lease quiescence; no rollback of business effects.'};
}
async function stopKnown(targetFolder,expectedInstance){
 const settings=JSON.parse(await fs.readFile(path.join(targetFolder,'launch-settings.json'),'utf8'));assert.equal(settings.port,3515);assert.equal(path.resolve(settings.web),web);
 let state=await launcherState(targetFolder);
 assert(['running','starting','stop_requested','stopped','failed'].includes(state.status),'known_launcher_state_unconfirmed');
 if(['running','starting'].includes(state.status)&&!existsSync(path.join(targetFolder,'stop.request')))
   await fs.writeFile(path.join(targetFolder,'stop.request'),new Date().toISOString()+'\n',{encoding:'utf8',flag:'wx'});
 let lastReason='graceful_stop_not_confirmed';
 for(let i=0;i<180;i++){
   state=await launcherState(targetFolder);
   assert(state.status!=='stop_unconfirmed','graceful_stop_unconfirmed');
   if(['stopped','failed'].includes(state.status)){
     try{return await quiescentProof(targetFolder,state,expectedInstance);}catch(error){lastReason=redact(error.message);}
   }
   await sleep(1000);
 }
 throw Error('stop_safety_unconfirmed:'+lastReason);
}
async function startIn(targetFolder,targetReview,before){
 assert(!existsSync(path.join(targetFolder,'launcher-state.json')),'do_not_reuse_launcher');await fs.mkdir(targetFolder,{recursive:true});
 await fs.copyFile(path.join(oldFolder,'hidden-managed-launcher.mjs'),path.join(targetFolder,'hidden-managed-launcher.mjs'));
 const buildId=(await fs.readFile(path.join(web,`.tmp/next-review-${targetReview}/BUILD_ID`),'utf8')).trim();
 await fs.writeFile(path.join(targetFolder,'launch-settings.json'),JSON.stringify({review:targetReview,port:3515,buildId,web,flowEnvironment})+'\n',{encoding:'utf8',mode:0o600});
 const child=spawn(process.execPath,[path.join(targetFolder,'hidden-managed-launcher.mjs')],{cwd:web,env:{...effective,NODE_ENV:'production',ZHIYU_REVIEW_BUILD:targetReview,...flowEnvironment},detached:true,windowsHide:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
 let lastReason='health_not_observed';
 for(let i=0;i<90;i++){
   try{const proof=await healthyProof(await httpSnapshot(targetReview),targetFolder,before);
     await fs.writeFile(path.join(targetFolder,'health-proof.json'),JSON.stringify(proof,null,2)+'\n',{encoding:'utf8',mode:0o600});
     return proof;
   }catch(error){lastReason=redact(error.message);}
   if(existsSync(path.join(targetFolder,'launcher-state.json'))&&['failed','stopped'].includes((await launcherState(targetFolder)).status))break;
   await sleep(1000);
 }
 throw Error('production_health_unconfirmed:'+lastReason);
}
await fs.mkdir(folder,{recursive:true});
try{
 if(mode==='build'){
  assert(!existsSync(path.join(web,`.tmp/next-review-${review}`)),'fresh_build_directory_required');
  assert(!existsSync(path.join(folder,'source-before.json')),'fresh_release_record_required');
  const oldSettings=JSON.parse(await fs.readFile(path.join(oldFolder,'launch-settings.json'),'utf8'));assert.equal(oldSettings.review,previousReview);
  const before={http:await httpSnapshot(previousReview),database:await observeDb(),oldSettings,envHashes,packages:await packageArtifacts()};assert.equal(before.database.pendingMigrations.length,0,'migration_not_in_release_scope');await save('before.json',before);await save('source-before.json',sources());
  const guard=path.join(folder,'build-guard.cjs'),guardLog=path.join(folder,'build-guard.jsonl');await fs.writeFile(guard,productionBuildGuardSource(),'utf8');
  const buildEnv={...productionBuildEnvironment(effective,review,guard,guardLog),...flowEnvironment};
  const tsconfigPath=path.join(web,'tsconfig.json'),tsconfigBefore=await fs.readFile(tsconfigPath);
  if(agentFirst){
   // Reuse only the webpack cache of the guarded previous build. Next
   // still recompiles current source, checks types and produces a fresh build.
   const candidateFolder=path.join(root,'.runtime/deployments/platform-capabilities/20261010-review80');
   const candidate=JSON.parse(await fs.readFile(path.join(candidateFolder,'build-ready.json'),'utf8'));
   const candidateExit=JSON.parse(await fs.readFile(path.join(candidateFolder,'build-exit.json'),'utf8'));
   const candidateBefore=JSON.parse(await fs.readFile(path.join(candidateFolder,'before.json'),'utf8'));
   assert.equal(candidate.review,'80');assert.equal(candidateExit.code,0);
   assert.equal(candidateBefore.packages.artifactHash,before.packages.artifactHash,'cache_package_artifacts_changed');
   const cacheSource=path.join(web,'.tmp/next-review-80/cache/webpack'),cacheTarget=path.join(web,`.tmp/next-review-${review}/cache/webpack`);
   if(existsSync(cacheSource)){
    await fs.cp(cacheSource,cacheTarget,{recursive:true,errorOnExist:true,force:false});
    await save('build-cache-reuse.json',{sourceReview:'80',sourceBuildId:candidate.buildId,scope:'Webpack compiler cache only; all current compilation and release checks still required.'});
   }
  }
  console.log(JSON.stringify({phase:'build_started',review,folder,previousReview:before.http.review,previousWorkerOnline:before.http.worker.online}));
  const log=await fs.open(path.join(folder,'build.log'),'wx');
  const child=spawn(process.execPath,['../../node_modules/next/dist/bin/next','build','--webpack'],{cwd:web,env:buildEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
  const write=(chunk,isError)=>{let buffer=(isError?err:out)+chunk,end;while((end=buffer.indexOf('\n'))>=0){log.write(redact(buffer.slice(0,end+1)));buffer=buffer.slice(end+1);}if(isError)err=buffer;else out=buffer;};child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',c=>write(c,false));child.stderr.on('data',c=>write(c,true));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(out||err)await log.write(redact(out+err));await log.close();await save('build-exit.json',{at:new Date().toISOString(),code});assert.equal(code,0,'next_build_failed');
  if(agentFirst){
   const generatedBytes=await fs.readFile(tsconfigPath);
   if(!generatedBytes.equals(tsconfigBefore)){
    const originalConfig=JSON.parse(tsconfigBefore.toString('utf8')),generatedConfig=JSON.parse(generatedBytes.toString('utf8'));
    const allowedIncludes=[`.tmp/next-review-${review}/types/**/*.ts`,`.tmp/next-review-${review}/dev/types/**/*.ts`];
    assert(Array.isArray(originalConfig.include)&&Array.isArray(generatedConfig.include),'generated_tsconfig_include_required');
    const actualNew=generatedConfig.include.filter(value=>!originalConfig.include.includes(value));
    assert(actualNew.every(value=>allowedIncludes.includes(value)),'unexpected_generated_type_directory');
    assert.deepEqual({...generatedConfig,include:generatedConfig.include.filter(value=>!actualNew.includes(value))},originalConfig,'unexpected_generated_tsconfig_change');
    assert(sourceDifferences(await load('source-before.json'),sources()).every(row=>row.path==='apps/web/tsconfig.json'),'runtime_source_changed_during_build');
    await save('tsconfig-generated.json',{beforeSha256:hash(tsconfigBefore),generatedSha256:hash(generatedBytes),generatedConfig,actualNew,restoration:'Exact original bytes after successful compilation.'});
    await fs.writeFile(tsconfigPath,tsconfigBefore);
   }
  }
  const after=sources(),beforeSource=await load('source-before.json');await save('source-after-build.json',after);assert.equal(after.sourceHash,beforeSource.sourceHash,'release_sources_changed_during_build');assert.equal((await packageArtifacts()).artifactHash,before.packages.artifactHash,'package_artifacts_changed_during_build');
  const buildId=(await fs.readFile(path.join(web,`.tmp/next-review-${review}/BUILD_ID`),'utf8')).trim();await save('build-ready.json',{at:new Date().toISOString(),review,buildId,sourceHash:after.sourceHash});console.log(JSON.stringify({phase:'build_ready',review,buildId}));
 }else if(mode==='certify-ops'){
  const certificate=await certifyOperations();console.log(JSON.stringify({phase:'operations_certified',review,buildId:certificate.buildId,sourceHash:certificate.sourceHash,operationsDifferences:certificate.operationsDifferences,generatedBuildDifferences:certificate.generatedBuildDifferences}));
 }else if(mode==='switch'){
  const {before,ready}=await certifiedRelease();
  const db=await observeDb();assert.equal(db.busy.length,0,'unsettled_workshop_runs');assert.equal(db.runningExecutionLeases,0,'unsettled_execution_lease');assert.equal(db.pendingMigrations.length,0);await save('before-stop.json',{at:new Date().toISOString(),database:db});
  const stopped=await stopKnown(oldFolder,before.http.worker.instanceId);await save('old-launcher-stopped.json',stopped);await save('old-worker-settled.json',stopped);console.log(JSON.stringify({phase:'old_stopped',review:previousReview,workerSettled:stopped.runtimeStop?.settled}));
  await certifiedRelease();const started=await startIn(folder,review,before);assert.equal(started.http.buildId,ready.buildId);await save('after-start.json',started);console.log(JSON.stringify({phase:'new_started',...started.http}));
 }else if(mode==='observe'){
  const {before,ready}=await certifiedRelease(),observed=await healthyProof(await httpSnapshot(review),folder,before);
  assert.equal(observed.http.buildId,ready.buildId);assert.deepEqual(observed.database.loops,before.database.loops,'loop_state_changed');await save(observationFix?'verified-observation.json':'verified.json',{...observed,envHashes});console.log(JSON.stringify(observed.http));
 }else{
  const {before}=await certifiedRelease();const stopped=await stopKnown(folder);await save('new-launcher-stopped.json',stopped);
  const target=path.join(folder,`rollback-review${previousReview}-`+Date.now()),started=await startIn(target,previousReview,before);
  assert.equal(started.http.buildId,before.http.buildId,'rollback_web_build_changed');
  await save('rollback.json',{...started,launcherFolder:target,flowEnvironment,scope:'Previous compiled Web build; worker uses the current certified business source and recorded flow settings. No full source or business-state rollback.'});
  console.log(JSON.stringify({phase:'web_rolled_back',scope:'Web build only; current certified worker source',...started.http}));
 }
}catch(error){console.error(JSON.stringify({ok:false,phase:mode,reason:redact(error.message),folder}));process.exitCode=1;}
