import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROUNDS,BUDGET,CUMULATIVE_BUDGET,PHASE,digest,withinFinalBudget,assertAnchor,exactNextGeneratedChange} from './prove-memory-continuity-recovery.mjs';
import {exactTransportPreparation,createAuditedFetch} from './memory-recovery-preload.mjs';
import {auditPhysicalLogical,honestRawUsage,failedLatestContinuity,hasAutonomousOwnerProof,exactU1Parent} from './verify-memory-continuity-recovery.mjs';
import {canonicalHash} from './lib/memory-continuity-verification.mjs';
import {freshSourceCheckpoint} from './verify-memory-continuity-resume.mjs';

const base=Date.parse('2026-10-18T08:00:00Z'),at=n=>new Date(base+n).toISOString();
const identity={userId:'owner',workshopId:'work',loopId:'loop'},runId='run';
const lease={...identity,runId,workerId:'worker',token:4};
const unknown=()=>({status:'unknown',inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,billing:'unknown'});
const partial=()=>({...unknown(),status:'partial',inputTokens:10,outputTokens:3});
function fixture({recovery=false,calls=1}={}){
 let seq=0,ordinal=0;const events=[],requests=[];
 const event=(type,metadata)=>{const e={id:'event-'+(seq+1),seq:++seq,type,createdAt:at(seq*10),workshopId:identity.workshopId,loopId:identity.loopId,runId,loopRunId:runId,metadata};events.push(e);return e;};
 event('execution_claimed',{workerId:lease.workerId,fencingToken:lease.token});
 for(let logical=1;logical<=calls;logical++){
  const policyIdentity={mode:'enabled',schemaVersion:1},wm=event('working_memory_projected',{receiptAuthority:'runtime',status:'provider_request_prepared',version:logical,policyIdentity});
  const hostPrepared={eventId:wm.id,seq:wm.seq,createdAt:wm.createdAt,version:logical,policyIdentity,loopRunId:runId};
  const payload={model:'qwen3.7-plus',stream:true,messages:[{role:'user',content:'ordinary evidence task'}],tools:[{name:'workingMemory'}]},wireBodyHash=digest(JSON.stringify(payload)),deadlineAt=at(120000+seq*10);
  for(let attempt=1;attempt<=(recovery&&logical===1?2:1);attempt++){
   const receipt={schemaVersion:'host-provider-transport.v1',logicalInvocation:logical,attempt,transportOrdinal:++ordinal,bodyHash:wireBodyHash,receiptAuthority:'runtime',currentRunId:runId,scope:{kind:'loop',loopId:identity.loopId},actorId:identity.userId,execution:{runId,workerId:lease.workerId,token:lease.token},logicalPrepared:{eventId:hostPrepared.eventId,seq:hostPrepared.seq,createdAt:hostPrepared.createdAt,version:hostPrepared.version,policyIdentity}};
   const prepared=event('provider_transport_attempt',{...receipt,phase:'prepared',deadlineAt,sameBody:attempt===1?null:true,sameHeaders:attempt===1?null:true});
   requests.push({index:requests.length+1,kind:'working-memory-agent',payload:structuredClone(payload),payloadHash:digest(payload),wireBodyHash,hostPrepared:structuredClone(hostPrepared),transportPrepared:{eventId:prepared.id,seq:prepared.seq,createdAt:prepared.createdAt,logicalInvocation:logical,attempt,transportOrdinal:ordinal,bodyHash:wireBodyHash,deadlineAt},dispatchedAt:at(seq*10+1),responseStatus:200,error:null});
   const retry=recovery&&logical===1&&attempt===1;
   event('provider_transport_attempt',{...receipt,phase:'finished',httpStatus:200,physicalFetchStarted:true,responseBytes:200,responseBodyHash:digest('physical response '+ordinal),frameCount:retry?1:6,classification:retry?'opaque_empty_error':'complete_sse',usage:retry?unknown():partial()});
   event('provider_transport_attempt',{...receipt,phase:'recovery_decision',decision:retry?'retry_once':'not_recovered',reason:retry?'exact_opaque_error':'not_eligible'});
  }
  event('working_memory_usage',{receiptAuthority:'runtime',usageStatus:'reported',source:'sdk_result',totalTokens:13});
 }
 return{events,requests,runId,identity};
}
const transport=(f,phase,attempt=1)=>f.events.find(e=>e.type==='provider_transport_attempt'&&e.metadata.phase===phase&&e.metadata.attempt===attempt);

test('one ordinary logical call has one physical request, preparation, and SDK usage',()=>{
 const r=auditPhysicalLogical(fixture());assert.equal(r.passed,true,JSON.stringify(r.checks));assert.equal(r.physicalMainRequests,1);assert.equal(r.logicalMainCalls,1);assert.equal(r.recoveries,0);
});
test('one opaque stream recovery retains one logical projection and one SDK usage',()=>{
 const r=auditPhysicalLogical(fixture({recovery:true,calls:2}));assert.equal(r.passed,true,JSON.stringify(r.checks));assert.equal(r.physicalMainRequests,3);assert.equal(r.logicalMainCalls,2);assert.equal(r.reportedSdkUsageReceipts,2);assert.equal(r.recoveries,1);assert.deepEqual(r.failedPhysicalUsage,[{classification:'opaque_empty_error',usage:unknown()}]);
});
test('raw explicit zero observation is partial, synthesized absent usage remains unknown',()=>{
 assert.equal(honestRawUsage(unknown()),true);assert.equal(honestRawUsage({...unknown(),status:'partial',inputTokens:0}),true);
 assert.equal(honestRawUsage({...unknown(),inputTokens:0}),false);assert.equal(honestRawUsage({...unknown(),status:'partial'}),false);assert.equal(honestRawUsage({...partial(),billing:'reported'}),false);
});
for(const[name,mutate]of[
 ['changed retry body',f=>{f.requests[1].wireBodyHash=digest('changed');}],
 ['changed retry payload',f=>{f.requests[1].payload.messages[0].content='changed';f.requests[1].payloadHash=digest(f.requests[1].payload);}],
 ['headers not exact',f=>{transport(f,'prepared',2).metadata.sameHeaders=false;}],
 ['different logical preparation timestamp',f=>{transport(f,'prepared').metadata.logicalPrepared.createdAt=at(1);}],
 ['wrong Loop scope',f=>{transport(f,'prepared').metadata.scope.loopId='other';}],
 ['wrong execution token',f=>{transport(f,'prepared').metadata.execution.token=99;}],
 ['wrong owner authority',f=>{transport(f,'prepared').metadata.actorId='other';}],
 ['foreign prepared timestamp',f=>{f.requests[0].dispatchedAt=at(0);}],
 ['explicit provider error retried',f=>{transport(f,'finished').metadata.classification='explicit_error';}],
 ['new retry deadline',f=>{transport(f,'prepared',2).metadata.deadlineAt=at(180000);}],
 ['recovery decision body mismatch',f=>{transport(f,'recovery_decision').metadata.bodyHash=digest('other');}],
 ['decision invocation mismatch',f=>{transport(f,'recovery_decision').metadata.logicalInvocation=4;}],
 ['missing physical receipt',f=>{f.events=f.events.filter(e=>e!==transport(f,'finished'));}],
 ['duplicate SDK usage',f=>{f.events.push(structuredClone(f.events.at(-1)));}],
 ['SDK zero default counted reported',f=>{f.events.at(-1).metadata.totalTokens=0;}],
 ['failed raw usage fabricated as zero known',f=>{transport(f,'finished').metadata.usage={...unknown(),inputTokens:0};}],
 ['late finished transport',f=>{transport(f,'finished',2).createdAt=at(180000);}],
 ['truncated final response',f=>{transport(f,'finished',2).metadata.classification='length';}],
 ['wrong transport ordinal',f=>{transport(f,'prepared',2).metadata.transportOrdinal=7;}],
 ['extra logical projection',f=>{f.events.push({...f.events.find(e=>e.type==='working_memory_projected'),id:'extra',seq:99});}],
 ['unrecognized physical receipt hidden from matching',f=>{f.events.push({type:'provider_transport_attempt',metadata:{schemaVersion:'unknown'}});}],
])test('rejects '+name,()=>{const f=fixture({recovery:true});mutate(f);assert.equal(auditPhysicalLogical(f).passed,false);});
test('missing transport preparation returns failed evidence without throwing',()=>{
 const f=fixture();f.events=f.events.filter(e=>e!==transport(f,'prepared'));assert.equal(auditPhysicalLogical(f).passed,false);
 assert.equal(exactTransportPreparation(undefined,null,lease,'hash'),false);
});
test('a second logical invocation cannot use another recovery',()=>{
 const a=fixture({recovery:true}),b=fixture({recovery:true});const first=a.events.at(-1).seq;
 for(const e of b.events.filter(e=>e.type!=='execution_claimed')){e.seq+=first;e.id='b-'+e.id;if(e.type==='provider_transport_attempt'){e.metadata.logicalInvocation=2;e.metadata.transportOrdinal+=2;e.metadata.logicalPrepared.eventId='b-'+e.metadata.logicalPrepared.eventId;e.metadata.logicalPrepared.seq+=first;}}
 for(const r of b.requests){r.hostPrepared.eventId='b-'+r.hostPrepared.eventId;r.hostPrepared.seq+=first;r.transportPrepared.eventId='b-'+r.transportPrepared.eventId;r.transportPrepared.seq+=first;r.transportPrepared.logicalInvocation=2;r.transportPrepared.transportOrdinal+=2;}
 a.events.push(...b.events.filter(e=>e.type!=='execution_claimed'));a.requests.push(...b.requests);assert.equal(auditPhysicalLogical(a).passed,false);
});
test('final campaign cannot reset the prior 21 requests or add a third domain task',()=>{
 const n={priorDomainAttempts:2,priorProviderRequests:21,newDomainAttempts:2,newProviderRequests:32,totalDomainAttempts:4,totalProviderRequests:53};
 assert.equal(withinFinalBudget(n),true);assert.equal(withinFinalBudget(n,{beforeNewIntent:true}),false);
 for(const change of[{priorProviderRequests:20},{newProviderRequests:33,totalProviderRequests:54},{newDomainAttempts:3,totalDomainAttempts:5},{totalProviderRequests:21},{newProviderRequests:NaN}])assert.equal(withinFinalBudget({...n,...change}),false);
 assert.deepEqual(ROUNDS,['U1','U2']);assert.equal(BUDGET.maxRequests,16);assert.equal(CUMULATIVE_BUDGET.maximumProviderRequests,58);assert.equal(CUMULATIVE_BUDGET.plannedMaximumProviderRequests,53);
});
test('new phase anchor rejects a reused old schema and altered aggregate caps',()=>{
 const directory=resolve('offline-recovery'),plan={schemaVersion:'memory-recovery-session.v1',phase:PHASE},anchor={schemaVersion:'memory-production-phase-anchor.v1',phase:PHASE,outputDirectory:directory,planHash:digest(plan),budget:BUDGET,cumulativeBudget:CUMULATIVE_BUDGET};
 assert.doesNotThrow(()=>assertAnchor(anchor,plan,directory));assert.throws(()=>assertAnchor({...anchor,cumulativeBudget:{...CUMULATIVE_BUDGET,priorProviderRequests:0}},plan,directory));
 const old={...plan,schemaVersion:'memory-production-repair-session.v1'};assert.throws(()=>assertAnchor({...anchor,planHash:digest(old)},old,directory));
});
test('only predeclared exact compiler routes import is accepted as generated',()=>{
 const before='/// <reference types="next" />\r\nimport "./.tmp/next-review-98/types/routes.d.ts";\r\n',after=before.replace('next-review-98','next-review-96'),path='apps/web/next-env.d.ts',item={path,beforeHash:digest(before),afterHash:digest(after),writer:'Next production type generation',declaredBeforeBuild:true},receipt={sourceDrift:[],sourceHashes:{[path]:item.afterHash},generatedSourceChanges:[item]};
 assert.equal(exactNextGeneratedChange(receipt,after),true);
 for(const changed of[{...item,path:'apps/web/lib/loops/native-executor.ts'},{...item,declaredBeforeBuild:false},{...item,writer:'manual'},{...item,beforeHash:digest('different earlier content')}])assert.equal(exactNextGeneratedChange({...receipt,generatedSourceChanges:[changed]},after),false);
 assert.equal(exactNextGeneratedChange(receipt,after+'// another edit\n'),false);assert.equal(exactNextGeneratedChange({...receipt,sourceDrift:['other.ts']},after),false);assert.equal(exactNextGeneratedChange({...receipt,generatedSourceChanges:[]},after),false);
});
test('U1 must skip the latest failed run and cannot resurrect a prior checkpoint',()=>{
 const e={metadata:{receiptAuthority:'runtime',status:'skipped',reason:'latest_run_unsuccessful',checkpoint:null,currentRunId:runId,scope:{kind:'loop',loopId:identity.loopId}}},payload={messages:[{role:'user',content:'ordinary task'}]};
 assert.equal(failedLatestContinuity(e,[payload],runId,identity.loopId),true);
 for(const changed of[{status:'inherited'},{reason:'no_eligible_checkpoint'},{checkpoint:{sourceRunId:'old-P1'}}])assert.equal(failedLatestContinuity({...e,metadata:{...e.metadata,...changed}},[payload],runId,identity.loopId),false);
 assert.equal(failedLatestContinuity(e,[],runId,identity.loopId),false);
});
test('one actual successful U round supplies typed proof without forcing duplicate tool use',()=>{
 const proof={round:'U2',actualCompletedTask:true,mode:'autonomous-model-tool-use'};assert.equal(hasAutonomousOwnerProof([proof]),true);assert.equal(hasAutonomousOwnerProof([{...proof,round:'U1'}]),true);
 assert.equal(hasAutonomousOwnerProof([{...proof,round:'P1'}]),false);assert.equal(hasAutonomousOwnerProof([{...proof,actualCompletedTask:false}]),false);assert.equal(hasAutonomousOwnerProof([{...proof,mode:'manual-injection'}]),false);
});
function freshU1(){
 const binding={sourceEventId:'source',contentHash:'a'.repeat(64),evidenceId:'ev',offset:0,contentLength:20,totalChars:30,sourceVersion:'sha256:source'};
 const catalog={toolCallId:'read',toolName:'webReadPage',referenceEligible:true,sourceIdentityStatus:'reported',contentHash:'b'.repeat(64),sourceIdentity:binding};
 const metadata={receiptAuthority:'runtime',mode:'apply',status:'ready_for_projection',version:1,policyIdentity:{hash:'policy'},evidenceCatalog:[catalog],state:{openQuestions:['current progress question'],facts:[{evidenceIds:['read']}]}};
 const events=[{id:'source',type:'source_checked',seq:1,workshopId:'work',loopId:'loop',loopRunId:'U1-run',metadata:{receiptAuthority:'runtime',ok:true,toolName:'webReadPage',toolUseId:'read',...binding}},{id:'U1-log',type:'working_memory_updated',seq:2,createdAt:at(10),metadata},{id:'prepared',type:'working_memory_projected',seq:3,metadata:{receiptAuthority:'runtime',status:'provider_request_prepared',version:1,policyIdentity:metadata.policyIdentity,evidenceCatalog:[structuredClone(catalog)]}}];
 const previous={before:{workshopId:'work',loopId:'loop'},result:{loopRunId:'U1-run'},events,providerRequests:[{kind:'working-memory-agent',hostPrepared:{eventId:'prepared',seq:3,version:1},responseStatus:200,error:null}]},expiresAt=new Date(base+10+7*86400000).toISOString();
 const checkpoint={sourceRunId:'U1-run',checkpointEventId:'U1-log',version:1,policyIdentity:metadata.policyIdentity,createdAt:at(10),expiresAt,history:{openQuestions:['current progress question']},chain:{depth:0,viaRunIds:[],assertionsSuppressed:true,rootHash:canonicalHash({workshopId:'work',sourceRunId:'U1-run',checkpointEventId:'U1-log',metadata,expiresAt})}};
 return{previous,checkpoint};
}
test('U1 fresh exact source-bound LOG and U2 original seven-day expiry both bind actual events',()=>{
 const f=freshU1();assert.equal(freshSourceCheckpoint(f.previous),true);assert.equal(exactU1Parent(f.checkpoint,f.previous),true);
});
for(const[name,mutate]of[
 ['old P1 fallback',f=>{f.checkpoint.sourceRunId='P1';}],
 ['failed Q1 ancestry',f=>{f.checkpoint.sourceRunId='Q1';}],
 ['old source',f=>{f.previous.events[0].loopRunId='Q1';}],
 ['snapshot mismatch',f=>{f.previous.events[0].metadata.offset=1;}],
 ['no post-LOG dispatch',f=>{f.previous.providerRequests=[];}],
 ['restore after LOG',f=>{f.previous.events.push({type:'working_memory_restored',seq:4,metadata:{receiptAuthority:'runtime'}});}],
])test('fresh ancestry rejects '+name,()=>{const f=freshU1();mutate(f);assert.equal(freshSourceCheckpoint(f.previous)&&exactU1Parent(f.checkpoint,f.previous),false);});
test('U2 cannot renew TTL even with a recomputed forged root hash',()=>{
 const f=freshU1();f.checkpoint.expiresAt=new Date(base+10+6*86400000).toISOString();f.checkpoint.chain.rootHash=canonicalHash({workshopId:'work',sourceRunId:'U1-run',checkpointEventId:'U1-log',metadata:f.previous.events[1].metadata,expiresAt:f.checkpoint.expiresAt});assert.equal(exactU1Parent(f.checkpoint,f.previous),false);
});
function fetchFixture({count=0,changeTransport}={}){
 const f=fixture(),prepared=f.requests[0].hostPrepared,tr=transport(f,'prepared');changeTransport?.(tr);
 const plan={identity,provider:{actualModel:'qwen3.7-plus',actualEndpointHash:digest('https://opencode.ai/inference/go/anthropic/v1/messages')}};
 const intent={round:'U1',planHash:digest(plan),expectedRunId:runId,createdAt:at(0),deadlineAt:at(360000),budget:BUDGET};let transmissions=0;const requests=[],responses=[];
 const audited=createAuditedFetch({originalFetch:async()=>{transmissions++;return new Response('data: ok\n\n',{status:200});},plan,leaseReader:async()=>lease,intentReader:()=>intent,readPrepared:async()=>prepared,readTransport:async()=>tr,recordRequest:(_r,_i,v)=>requests.push(v),recordResponse:(_r,_i,v)=>responses.push(v),countRequests:()=>count,boot:{bootId:'boot',pid:12},network:{metadata:{mode:'default'},apply:(_url,init)=>init},now:()=>base+100});
 return{audited,payload:f.requests[0].payload,requests,responses,transmissions:()=>transmissions};
}
test('actual pre-dispatch wrapper requires persisted physical receipt and records separate raw hash',async()=>{
 const f=fetchFixture();await f.audited('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(f.payload)});
 assert.equal(f.transmissions(),1);assert.equal(f.requests.length,1);assert.equal(f.responses[0].responseStatus,200);assert.equal(f.requests[0].wireBodyHash,digest(JSON.stringify(f.payload)));assert.equal(f.requests[0].transportPrepared.attempt,1);assert.equal(f.requests[0].requestHeadersRecorded,false);
});
test('a real Request object preserves its raw UTF-8 body hash through the audit wrapper',async()=>{
 const f=fetchFixture(),body=JSON.stringify(f.payload),request=new Request('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body});await f.audited(request);assert.equal(f.transmissions(),1);assert.equal(f.requests[0].wireBodyHash,digest(body));
});
test('a byte init.body override cannot hide a different actual wire payload behind Request body',async()=>{
 const f=fetchFixture(),request=new Request('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(f.payload)}),different=structuredClone(f.payload);different.messages[0].content='changed actual bytes';
 await assert.rejects(()=>f.audited(request,{body:new TextEncoder().encode(JSON.stringify(different))}),/physical transport preparation/);assert.equal(f.transmissions(),0);assert.equal(f.requests.length,0);
});
test('actual recovery helper Request plus matching Uint8Array override is admitted unchanged',async()=>{
 const f=fetchFixture(),body=JSON.stringify(f.payload),bytes=new TextEncoder().encode(body),request=new Request('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body});await f.audited(request,{body:bytes});assert.equal(f.transmissions(),1);assert.equal(f.requests[0].wireBodyHash,digest(Buffer.from(bytes)));assert.equal(f.requests[0].payloadHash,digest(f.payload));
});
test('wrapper rejects foreign physical authority before any HTTP transmission',async()=>{
 const f=fetchFixture({changeTransport:e=>{e.metadata.execution.workerId='other';}});await assert.rejects(()=>f.audited('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(f.payload)}),/physical transport preparation/);assert.equal(f.transmissions(),0);assert.equal(f.requests.length,0);
});
test('the sixteenth physical request is allowed but seventeenth is stopped before fetch',async()=>{
 const f=fetchFixture({count:15}),invoke=()=>f.audited('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(f.payload)});await invoke();await assert.rejects(invoke,/budget exhausted/);assert.equal(f.transmissions(),1);
});
test('ordinary unrelated owner fetch remains unmodified by opt-in audit',async()=>{
 let sent=0;const f=createAuditedFetch({originalFetch:async()=>{sent++;return new Response('ordinary');},plan:{identity},leaseReader:async()=>({...lease,userId:'other'}),intentReader:()=>{throw Error('must not read');}});await f('https://example.test',{method:'POST',body:'ordinary'});assert.equal(sent,1);
});
test('new tools do not import executors or database mutation modules',()=>{
 for(const file of['prove-memory-continuity-recovery.mjs','memory-recovery-preload.mjs','verify-memory-continuity-recovery.mjs']){const text=readFileSync(new URL(file,import.meta.url),'utf8');assert.doesNotMatch(text,/import\s*\([^)]*(?:executor|execution-lease|db\/)/);}
});
