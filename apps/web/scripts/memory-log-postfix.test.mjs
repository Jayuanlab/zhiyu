import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROUNDS,BUDGET,CUMULATIVE_BUDGET,DELIVERY_POLICY,CHECKPOINT_CONTRACT,PHASE,digest,fileHash,historicalCounts,withinFinalBudget,assertAnchor,exactNextGeneratedChange,AUDIT_FILES,AUDIT_LAUNCHER,auditOnlySourceDelta} from './prove-memory-log-postfix.mjs';
import {exactTransportPreparation,createAuditedFetch,preparedReceipt,canonicalPreparedTime,forwardForPrepared} from './memory-log-postfix-preload.mjs';
import {completedLogProductionTask,freshLogSourceCheckpoint,auditDelivery,auditPhysicalLogical,honestRawUsage,honestSdkUsage,initialNoCheckpoint,expectedInitialSkip,hasAutonomousOwnerProof,exactFIX1Parent} from './verify-memory-log-postfix.mjs';
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
  event('working_memory_usage',{receiptAuthority:'runtime',usageStatus:'reported',source:'sdk_result',inputTokens:10,outputTokens:3,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:13});
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
test('postfix uses exactly two remaining tasks preserving LOG1 and original 54 request cap',()=>{
 const n={priorDomainAttempts:5,priorProviderRequests:46,originalLogPhasePriorDomainAttempts:1,originalLogPhasePriorProviderRequests:17,newDomainAttempts:2,newProviderRequests:36,totalDomainAttempts:7,totalProviderRequests:82};
 assert.equal(withinFinalBudget(n),true);assert.equal(withinFinalBudget(n,{beforeNewIntent:true}),false);
 for(const change of[{priorProviderRequests:29},{priorDomainAttempts:4},{newProviderRequests:37,totalProviderRequests:83},{newDomainAttempts:3,totalDomainAttempts:8},{totalProviderRequests:29},{newProviderRequests:NaN},{originalLogPhasePriorProviderRequests:0}])assert.equal(withinFinalBudget({...n,...change}),false);
 assert.deepEqual(ROUNDS,['FIX1','FIX2']);assert.equal(BUDGET.maxRequests,18);assert.equal(BUDGET.maxSeconds,420);assert.equal(BUDGET.maxToolCalls,14);assert.equal(CUMULATIVE_BUDGET.maximumDomainAttempts,7);assert.equal(CUMULATIVE_BUDGET.newPhaseMaximumProviderRequests,36);assert.equal(CUMULATIVE_BUDGET.maximumOriginalLogPhaseProviderRequests,53);
});
test('real LOG1 parent consumes exactly 17 physical requests and stays failed with immutable old tooling',()=>{
 const dir=resolve('../../../.tmp/memory-continuity/20261018-log-production'),parent=JSON.parse(readFileSync(new URL('../../../.tmp/memory-continuity/20261018-log-production/production-session.json',import.meta.url),'utf8')),round=JSON.parse(readFileSync(new URL('../../../.tmp/memory-continuity/20261018-log-production/round-LOG1.json',import.meta.url),'utf8'));
 assert.equal(round.run.data.run.status,'failed');assert.equal(round.workerRun.status,'failed');assert.equal(round.providerRequests.length,17);
 for(const path of ['apps/web/scripts/prove-memory-log-production.mjs','apps/web/scripts/memory-log-production-preload.mjs','apps/web/scripts/verify-memory-log-production.mjs','apps/web/scripts/memory-log-production.test.mjs'])assert.equal(fileHash(new URL('../../../'+path,import.meta.url)),parent.sourceHashes[path]);
 const counts=historicalCounts({},resolve('../../../.tmp/memory-continuity/20261018-log-postfix'));
 assert.equal(counts.priorProviderRequests,46);assert.equal(counts.originalLogPhasePriorProviderRequests,17);assert.equal(counts.priorDomainAttempts,5);assert.equal(counts.newDomainAttempts,0);assert.equal(withinFinalBudget(counts,{beforeNewIntent:true}),true);
});
test('new phase anchor rejects a reused old schema and altered aggregate caps',()=>{
 const directory=resolve('offline-recovery'),plan={schemaVersion:'memory-log-postfix-session.v1',phase:PHASE},anchor={schemaVersion:'memory-production-phase-anchor.v1',phase:PHASE,outputDirectory:directory,planHash:digest(plan),budget:BUDGET,cumulativeBudget:CUMULATIVE_BUDGET};
 assert.doesNotThrow(()=>assertAnchor(anchor,plan,directory));assert.throws(()=>assertAnchor({...anchor,cumulativeBudget:{...CUMULATIVE_BUDGET,priorProviderRequests:0}},plan,directory));
 const old={...plan,schemaVersion:'memory-production-repair-session.v1'};assert.throws(()=>assertAnchor({...anchor,planHash:digest(old)},old,directory));
});
test('only predeclared exact compiler routes import is accepted as generated',()=>{
 const before='/// <reference types="next" />\r\nimport "./.tmp/next-review-95/types/routes.d.ts";\r\n',after=before.replace('next-review-95','next-review-94'),path='apps/web/next-env.d.ts',item={path,beforeHash:digest(before),afterHash:digest(after),writer:'Next production type generation',declaredBeforeBuild:true},receipt={buildDirectory:'apps/web/.tmp/next-review-94',sourceDrift:[],sourceHashes:{[path]:item.afterHash},generatedSourceChanges:[item]};
 assert.equal(exactNextGeneratedChange(receipt,after),true);
 for(const changed of[{...item,path:'apps/web/lib/loops/native-executor.ts'},{...item,declaredBeforeBuild:false},{...item,writer:'manual'},{...item,beforeHash:digest('different earlier content')}])assert.equal(exactNextGeneratedChange({...receipt,generatedSourceChanges:[changed]},after),false);
 assert.equal(exactNextGeneratedChange(receipt,after+'// another edit\n'),false);assert.equal(exactNextGeneratedChange({...receipt,sourceDrift:['other.ts']},after),false);assert.equal(exactNextGeneratedChange({...receipt,generatedSourceChanges:[]},after),true);
 assert.equal(exactNextGeneratedChange({...receipt,generatedSourceChanges:[],sourceHashes:{[path]:'wrong'}},after),false);
});
function generatedConfiguration(){
 const beforeNextText='import "./.tmp/next-review-95/types/routes.d.ts";\n',after=beforeNextText.replace('review-95','review-94');
 const before={compilerOptions:{strict:true},include:['next-env.d.ts','**/*.ts']},beforeTsconfigText=JSON.stringify(before,null,2)+'\n',addedPaths=['.tmp/next-review-94/types/**/*.ts','.tmp/next-review-94/dev/types/**/*.ts'];
 const currentTsconfigText=JSON.stringify({...before,include:[...before.include,...addedPaths]},null,2)+'\n';
 const route={path:'apps/web/next-env.d.ts',writer:'Next production type generation',declaredBeforeBuild:true,beforeHash:digest(beforeNextText),afterHash:digest(after)};
 const config={path:'apps/web/tsconfig.json',writer:route.writer,declaredBeforeBuild:true,beforeHash:digest(beforeTsconfigText),afterHash:digest(currentTsconfigText),addedIncludePaths:addedPaths,onlyTheseJsonChanges:true};
 const declaration={schemaVersion:'memory-log-postfix-build-declaration.v1',review:'94',declaredAt:at(0),sourceHashes:{[route.path]:route.beforeHash,[config.path]:config.beforeHash},beforeNextText,beforeTsconfigText,configAddedIncludePaths:addedPaths,onlyTheseConfigJsonChangesAllowed:true};
 return{after,options:{declaration,currentTsconfigText},receipt:{startedAt:at(0),buildDirectory:'apps/web/.tmp/next-review-94',sourceDrift:[],sourceHashes:{[route.path]:route.afterHash,[config.path]:config.afterHash},generatedSourceChanges:[route,config]}};
}
test('two compiler changes reconstruct exact predeclared source and only two appended JSON include paths',()=>{
 const f=generatedConfiguration();assert.equal(exactNextGeneratedChange(f.receipt,f.after,f.options),true);
 assert.equal(exactNextGeneratedChange(f.receipt,f.after),false);
 for(const mutate of[
  f=>{f.options.declaration.declaredAt=at(1);},f=>{f.options.declaration.beforeTsconfigText+=' ';},
  f=>{f.options.declaration.beforeNextText+=' ';},f=>{f.receipt.generatedSourceChanges[1].onlyTheseJsonChanges=false;},
  f=>{f.options.currentTsconfigText=JSON.stringify({compilerOptions:{strict:false},include:['next-env.d.ts','**/*.ts',...f.options.declaration.configAddedIncludePaths]});f.receipt.generatedSourceChanges[1].afterHash=digest(f.options.currentTsconfigText);f.receipt.sourceHashes['apps/web/tsconfig.json']=digest(f.options.currentTsconfigText);},
  f=>{f.receipt.generatedSourceChanges.push({...f.receipt.generatedSourceChanges[0]});},
  f=>{f.options.declaration.configAddedIncludePaths.reverse();},
 ]){const copy=structuredClone(f);mutate(copy);assert.equal(exactNextGeneratedChange(copy.receipt,copy.after,copy.options),false);}
});
test('FIX1 starts after failed LOG1 and explicitly skips it without resurrecting any old checkpoint',()=>{
 const previous={run:{data:{run:{status:'failed'}}},workerRun:{status:'failed'},events:[{type:'working_memory_updated',seq:1,metadata:{receiptAuthority:'runtime',status:'ready_for_projection',state:{openQuestions:['actual failed-run note']}}}]};
 const result={schemaVersion:'working-memory-continuity.v1',status:'skipped',reason:'latest_run_unsuccessful',warnings:[],checkpoint:null};
 const e={metadata:{...result,receiptAuthority:'runtime',currentRunId:runId,scope:{kind:'loop',loopId:identity.loopId},guidanceAdmission:{status:'admitted'}}};
 const payload={messages:[{role:'user',content:'历史工作检查点未接续（宿主状态）：\n'+JSON.stringify(result)}]};
 assert.equal(expectedInitialSkip(previous),'latest_run_unsuccessful');assert.equal(initialNoCheckpoint(e,[payload],runId,identity.loopId,previous),true);
 for(const changed of[{status:'inherited'},{reason:'no_audited_checkpoint'},{checkpoint:{sourceRunId:'old-P1'}}])assert.equal(initialNoCheckpoint({...e,metadata:{...e.metadata,...changed}},[payload],runId,identity.loopId,previous),false);
 assert.equal(initialNoCheckpoint(e,[{messages:[{role:'user',content:'no visible skip receipt'}]}],runId,identity.loopId,previous),false);
 assert.equal(initialNoCheckpoint(e,[],runId,identity.loopId,previous),false);
});
test('one actual successful V round supplies typed proof without forcing duplicate tool use',()=>{
 const proof={round:'FIX2',actualCompletedTask:true,mode:'autonomous-model-tool-use'};assert.equal(hasAutonomousOwnerProof([proof]),true);assert.equal(hasAutonomousOwnerProof([{...proof,round:'FIX1'}]),true);
 assert.equal(hasAutonomousOwnerProof([{...proof,round:'P1'}]),false);assert.equal(hasAutonomousOwnerProof([{...proof,actualCompletedTask:false}]),false);assert.equal(hasAutonomousOwnerProof([{...proof,mode:'manual-injection'}]),false);
});
function freshFIX1(){
 const binding={sourceEventId:'source',contentHash:'a'.repeat(64),evidenceId:'ev',offset:0,contentLength:20,totalChars:30,sourceVersion:'sha256:source'};
 const catalog={toolCallId:'read',toolName:'webReadPage',referenceEligible:true,sourceIdentityStatus:'reported',contentHash:'b'.repeat(64),sourceIdentity:binding};
 const metadata={receiptAuthority:'runtime',mode:'apply',operation:'update',phase:'LOG',status:'ready_for_projection',version:1,policyIdentity:{hash:'policy'},evidenceCatalog:[catalog],state:{openQuestions:['current progress question'],facts:[{text:'source observation',evidenceIds:['read']}],hypotheses:[],nextAction:{text:'read next source',evidenceIds:['read']}}};
 const events=[{id:'source',type:'source_checked',seq:1,workshopId:'work',loopId:'loop',loopRunId:'FIX1-run',metadata:{receiptAuthority:'runtime',ok:true,toolName:'webReadPage',toolUseId:'read',...binding}},{id:'FIX1-log',type:'working_memory_updated',seq:2,createdAt:at(10),metadata},{id:'prepared',type:'working_memory_projected',seq:3,metadata:{receiptAuthority:'runtime',status:'provider_request_prepared',version:1,policyIdentity:metadata.policyIdentity,evidenceCatalog:[structuredClone(catalog)]}}];
 const previous={before:{workshopId:'work',loopId:'loop'},result:{loopRunId:'FIX1-run'},events,providerRequests:[{kind:'working-memory-agent',hostPrepared:{eventId:'prepared',seq:3,version:1},responseStatus:200,error:null}]},expiresAt=new Date(base+10+7*86400000).toISOString();
 const checkpoint={sourceRunId:'FIX1-run',checkpointEventId:'FIX1-log',version:1,policyIdentity:metadata.policyIdentity,createdAt:at(10),expiresAt,history:{openQuestions:['current progress question']},chain:{depth:0,viaRunIds:[],assertionsSuppressed:true,rootHash:canonicalHash({workshopId:'work',sourceRunId:'FIX1-run',checkpointEventId:'FIX1-log',metadata,expiresAt})}};
 return{previous,checkpoint};
}
test('FIX1 fresh exact source-bound LOG and FIX2 original seven-day expiry both bind actual events',()=>{
 const f=freshFIX1();assert.equal(freshSourceCheckpoint(f.previous),true);assert.equal(exactFIX1Parent(f.checkpoint,f.previous),true);
});
test('phase14 terminal validator reads the actual trace budget rather than the frozen old phase12 predicate',()=>{
 const old=JSON.parse(readFileSync(new URL('../../../.tmp/memory-continuity/20261018-production-loop/audit-final/round-V1.json',import.meta.url),'utf8'));
 const plan=JSON.parse(readFileSync(new URL('../../../.tmp/memory-continuity/20261018-production-loop/audit-final/production-session.json',import.meta.url),'utf8'));
 assert.equal(completedLogProductionTask(old,plan),false);
 const fixture=structuredClone(old),trace=fixture.workerRun.verificationResult.executionTrace;
 trace.maxToolCalls=14;trace.events.find(e=>e.type==='budget_configured').metadata.maxToolCalls=14;
 fixture.workerRun.verificationHash=digest(fixture.workerRun.verificationResult);
 assert.equal(completedLogProductionTask(fixture,plan),true);
 for(const count of[15,NaN,-1]){const x=structuredClone(fixture);x.workerRun.verificationResult.executionTrace.toolCallCount=count;x.workerRun.verificationHash=digest(x.workerRun.verificationResult);assert.equal(completedLogProductionTask(x,plan),false);}
 const missing=structuredClone(fixture);missing.events=missing.events.filter(e=>e.type!=='agent_runtime_terminal');assert.equal(completedLogProductionTask(missing,plan),false);
});
test('fresh source proof accepts explicitly unverified hypotheses or next action without promoting them to facts',()=>{
 for(const target of['hypotheses','nextAction']){
  const f=freshFIX1(),m=f.previous.events[1].metadata;
  m.state.facts=[];m.state.hypotheses=[];m.state.nextAction={text:'next step',evidenceIds:[]};
  if(target==='hypotheses')m.state.hypotheses=[{text:'unverified source hypothesis',evidenceIds:['read']}];else m.state.nextAction.evidenceIds=['read'];
  assert.equal(freshLogSourceCheckpoint(f.previous),true);assert.equal(freshSourceCheckpoint(f.previous),false);
  if(target==='hypotheses')m.state.hypotheses[0].evidenceIds=['fabricated'];else m.state.nextAction.evidenceIds=['fabricated'];
  assert.equal(freshLogSourceCheckpoint(f.previous),false);
 }
});
for(const[name,mutate]of[
 ['old P1 fallback',f=>{f.checkpoint.sourceRunId='P1';}],
 ['failed U1 ancestry',f=>{f.checkpoint.sourceRunId='U1';}],
 ['old source',f=>{f.previous.events[0].loopRunId='U1';}],
 ['snapshot mismatch',f=>{f.previous.events[0].metadata.offset=1;}],
 ['no post-LOG dispatch',f=>{f.previous.providerRequests=[];}],
 ['restore after LOG',f=>{f.previous.events.push({type:'working_memory_restored',seq:4,metadata:{receiptAuthority:'runtime'}});}],
])test('fresh ancestry rejects '+name,()=>{const f=freshFIX1();mutate(f);assert.equal(freshSourceCheckpoint(f.previous)&&exactFIX1Parent(f.checkpoint,f.previous),false);});
test('FIX2 cannot renew TTL even with a recomputed forged root hash',()=>{
 const f=freshFIX1();f.checkpoint.expiresAt=new Date(base+10+6*86400000).toISOString();f.checkpoint.chain.rootHash=canonicalHash({workshopId:'work',sourceRunId:'FIX1-run',checkpointEventId:'FIX1-log',metadata:f.previous.events[1].metadata,expiresAt:f.checkpoint.expiresAt});assert.equal(exactFIX1Parent(f.checkpoint,f.previous),false);
});
function fetchFixture({count=0,changeTransport,rawDate=false}={}){
 const f=fixture(),prepared=f.requests[0].hostPrepared,tr=transport(f,'prepared');changeTransport?.(tr);
 const raw=f.events.find(e=>e.type==='working_memory_projected');if(rawDate)raw.createdAt=new Date(raw.createdAt);
 const plan={identity,provider:{actualModel:'qwen3.7-plus',actualEndpointHash:digest('https://opencode.ai/inference/go/anthropic/v1/messages')}};
 const intent={round:'FIX1',planHash:digest(plan),expectedRunId:runId,createdAt:at(0),deadlineAt:at(420000),budget:BUDGET};let transmissions=0;const requests=[],responses=[];
 const audited=createAuditedFetch({originalFetch:async()=>{transmissions++;return new Response('data: ok\n\n',{status:200});},plan,leaseReader:async()=>lease,intentReader:()=>intent,readPrepared:async()=>rawDate?preparedReceipt(raw):prepared,readTransport:async()=>tr,recordRequest:(_r,_i,v)=>requests.push(v),recordResponse:(_r,_i,v)=>responses.push(v),countRequests:()=>count,boot:{bootId:'boot',pid:12},network:{metadata:{mode:'default'},apply:(_url,init)=>init},now:()=>base+100});
 return{audited,payload:f.requests[0].payload,requests,responses,transmissions:()=>transmissions};
}
test('actual pre-dispatch wrapper requires persisted physical receipt and records separate raw hash',async()=>{
 const f=fetchFixture();await f.audited('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(f.payload)});
 assert.equal(f.transmissions(),1);assert.equal(f.requests.length,1);assert.equal(f.responses[0].responseStatus,200);assert.equal(f.requests[0].wireBodyHash,digest(JSON.stringify(f.payload)));assert.equal(f.requests[0].transportPrepared.attempt,1);assert.equal(f.requests[0].requestHeadersRecorded,false);
});
test('actual database Date preparation passes through the production readPrepared mapping',async()=>{
 const f=fetchFixture({rawDate:true});await f.audited('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(f.payload)});assert.equal(f.transmissions(),1);assert.equal(typeof f.requests[0].hostPrepared.createdAt,'string');
});
test('actual failed U1 Date shape is rejected raw and accepted only after the read boundary',()=>{
 const r=JSON.parse(readFileSync(new URL('../../../.tmp/memory-continuity/20261018-production-loop/recovery-final/round-U1.json',import.meta.url),'utf8'));
 const wm=r.events.find(e=>e.type==='working_memory_projected'&&e.metadata?.status==='provider_request_prepared'),tr=r.events.find(e=>e.type==='provider_transport_attempt'&&e.metadata?.phase==='prepared'),claim=r.events.find(e=>e.type==='execution_claimed');
 const actualLease={runId:r.intent.expectedRunId,workshopId:wm.workshopId,loopId:wm.loopId,userId:r.before.identity.data.actorId,workerId:claim.metadata.workerId,token:claim.metadata.fencingToken};
 const raw={...wm,createdAt:new Date(wm.createdAt)},oldShape={eventId:wm.id,seq:wm.seq,createdAt:raw.createdAt,version:wm.metadata.version,policyIdentity:wm.metadata.policyIdentity,loopRunId:wm.loopRunId};
 assert.equal(exactTransportPreparation(tr,oldShape,actualLease,tr.metadata.bodyHash),false);
 assert.equal(exactTransportPreparation(tr,preparedReceipt(raw),actualLease,tr.metadata.bodyHash),true);
 for(const offset of[-1,1])assert.equal(exactTransportPreparation(tr,preparedReceipt({...raw,createdAt:new Date(raw.createdAt.getTime()+offset)}),actualLease,tr.metadata.bodyHash),false);
 assert.equal(r.providerRequests.filter(q=>q.kind==='working-memory-agent').length,0);assert.equal(r.providerRequests.length,2);
});
test('canonical time accepts only valid primitive ISO or real Date internal slots',()=>{
 const iso=at(10);assert.equal(canonicalPreparedTime(iso),iso);assert.equal(canonicalPreparedTime(new Date(iso)),iso);
 for(const bad of[null,undefined,'',0,NaN,{},new Date(NaN),new String(iso),'2026-10-18','2026-10-18T08:00:00Z','2026-02-31T08:00:00.000Z',Object.create(Date.prototype),new Proxy(new Date(iso),{})])assert.equal(canonicalPreparedTime(bad),null);
});
test('untrusted timestamp objects never invoke valueOf, toJSON, or toString',()=>{
 let calls=0;const evil={valueOf(){calls++;return base;},toString(){calls++;return at(10);},toJSON(){calls++;return at(10);}};
 assert.equal(canonicalPreparedTime(evil),null);assert.throws(()=>preparedReceipt({createdAt:evil}),/timestamp/);assert.equal(calls,0);
 const real=new Date(at(10));real.toJSON=()=>{calls++;throw Error('not called');};real.valueOf=()=>{calls++;throw Error('not called');};real.getTime=()=>{calls++;throw Error('not called');};assert.equal(canonicalPreparedTime(real),at(10));assert.equal(calls,0);
});
test('audit-only source delta cannot alter business runtime or original U tools',()=>{
 const before={'apps/web/lib/loops/native-executor.ts':'a'.repeat(64),'apps/web/scripts/memory-recovery-preload.mjs':'b'.repeat(64)},after={...before,...Object.fromEntries([...AUDIT_FILES,AUDIT_LAUNCHER].map(p=>[p,'c'.repeat(64)]))};
 assert.equal(auditOnlySourceDelta(before,after).length,5);
 assert.throws(()=>auditOnlySourceDelta(before,{...after,'apps/web/lib/loops/native-executor.ts':'d'.repeat(64)}));
 assert.throws(()=>auditOnlySourceDelta(before,{...after,'apps/web/scripts/memory-recovery-preload.mjs':'d'.repeat(64)}));
 assert.throws(()=>auditOnlySourceDelta(before,{...after,'apps/web/lib/ai/other.ts':'d'.repeat(64)}));
 const missing={...after};delete missing[AUDIT_FILES[0]];assert.throws(()=>auditOnlySourceDelta(before,missing));
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
test('the eighteenth physical request is allowed but nineteenth is stopped before fetch',async()=>{
 const f=fetchFixture({count:17}),invoke=()=>f.audited('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(f.payload)});await invoke();await assert.rejects(invoke,/budget exhausted/);assert.equal(f.transmissions(),1);
});
test('honest unknown SDK usage does not fabricate tokens or turn a complete mechanism into a billing failure',()=>{
 const f=fixture(),metadata=f.events.at(-1).metadata;
 Object.assign(metadata,{usageStatus:'unknown',source:'unknown',inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,totalTokens:null});
 assert.equal(honestSdkUsage(metadata),true);const audited=auditPhysicalLogical(f);assert.equal(audited.passed,true);assert.equal(audited.mainUsageComplete,false);assert.equal(audited.reportedSdkUsageReceipts,0);
 metadata.totalTokens=0;assert.equal(honestSdkUsage(metadata),false);assert.equal(auditPhysicalLogical(f).passed,false);
});
test('ordinary unrelated owner fetch remains unmodified by opt-in audit',async()=>{
 let sent=0;const f=createAuditedFetch({originalFetch:async()=>{sent++;return new Response('ordinary');},plan:{identity},leaseReader:async()=>({...lease,userId:'other'}),intentReader:()=>{throw Error('must not read');}});await f('https://example.test',{method:'POST',body:'ordinary'});assert.equal(sent,1);
});
test('new tools do not import executors or database mutation modules',()=>{
 for(const file of['prove-memory-log-postfix.mjs','memory-log-postfix-preload.mjs','verify-memory-log-postfix.mjs']){const text=readFileSync(new URL(file,import.meta.url),'utf8');assert.doesNotMatch(text,/import\s*\([^)]*(?:executor|execution-lease|db\/)/);}
});

function delivered({correction=false,compaction=false}={}){
 const f=freshFIX1(),newRunId='FIX1-run',events=f.previous.events,policyIdentity=events[1].metadata.policyIdentity;
 events[1].runId=newRunId;const requests=[];
 const common={receiptAuthority:'runtime',currentRunId:newRunId,scope:{kind:'loop',loopId:'loop'},policyIdentity,budget:structuredClone(DELIVERY_POLICY)};
 const push=(type,metadata)=>{const seq=events.at(-1).seq+1,e={id:'delivery-'+seq,seq,type,createdAt:at(seq*10),workshopId:'work',loopId:'loop',runId:newRunId,loopRunId:newRunId,metadata:{...common,...metadata}};events.push(e);return e;};
 let remaining=16384;
 const forward=(phase,maxTokens)=>{remaining-=maxTokens;const e=push('working_memory_delivery_forward',{phase,forward:1,maxForwards:phase==='context_compaction'?1:4,maxTokens,requestedMaxTokens:maxTokens,remainingOutputTokens:remaining,localContextWindow:32000,sdkEstimatedInputTokens:1000,capSource:'sdk_context_estimate'});requests.push({kind:'working-memory-agent',transportPrepared:{attempt:1},deliveryForward:{eventId:e.id}});return e;};
 if(compaction)forward('context_compaction',2048);
 if(correction){push('working_memory_delivery_checked',{schemaVersion:'working-memory-delivery.v1',stage:'candidate',attempt:0,contract:CHECKPOINT_CONTRACT,correctionsPresent:true,ok:false,status:'needs_correction',code:'no_audited_checkpoint',checkpoint:null});forward('report_correction',2048);}
 const log=events[1],createdAt=log.createdAt,expiresAt=new Date(Date.parse(createdAt)+7*86400000).toISOString();
 const checkpoint={eventId:log.id,version:1,sourceEventIds:['source'],toolCallIds:['read'],createdAt,expiresAt,rootHash:canonicalHash({workshopId:'work',sourceRunId:newRunId,checkpointEventId:log.id,metadata:log.metadata,expiresAt}),hasOpenQuestions:true,hasNextAction:true,authority:'model-authored-unverified'};
 const checked={schemaVersion:'working-memory-delivery.v1',attempt:correction?1:0,contract:CHECKPOINT_CONTRACT,correctionsPresent:true,ok:true,status:'satisfied',code:'current_source_checkpoint_delivered',checkpoint};
 push('working_memory_delivery_checked',{...checked,stage:'candidate'});push('agent_runtime_terminal',{});push('working_memory_delivery_checked',{...checked,checkpoint:structuredClone(checkpoint),stage:'runtime_commit'});push('loop_run_completed',{});push('run_completed',{});
 return{events,requests,runId:newRunId,identity:{userId:'owner',workshopId:'work',loopId:'loop'}};
}
test('actual candidate plus independent post-runtime recheck bind exact new LOG body sources and seven-day root',()=>{
 const f=delivered();assert.equal(auditDelivery(f).passed,true,JSON.stringify(auditDelivery(f).checks));
 const withForward=delivered({correction:true,compaction:true}),audit=auditDelivery(withForward);assert.equal(audit.passed,true,JSON.stringify(audit.checks));assert.equal(audit.reservedOutputTokensConsumed,4096);assert.equal(audit.correctionForwards,1);assert.equal(audit.compactionForwards,1);
});
for(const[name,mutate]of[
 ['missing post-runtime recheck',f=>{f.events=f.events.filter(e=>e.metadata?.stage!=='runtime_commit');}],
 ['commit before native terminal',f=>{const c=f.events.find(e=>e.metadata?.stage==='runtime_commit');c.seq=f.events.find(e=>e.type==='agent_runtime_terminal').seq-1;}],
 ['ordinary event log impersonates LOG',f=>{f.events[1].type='workshop_log';}],
 ['read operation impersonates LOG',f=>{f.events[1].metadata.operation='read';}],
 ['candidate old checkpoint ID',f=>{f.events.find(e=>e.metadata?.stage==='candidate').metadata.checkpoint.eventId='old';}],
 ['commit wrong source event',f=>{f.events.find(e=>e.metadata?.stage==='runtime_commit').metadata.checkpoint.sourceEventIds=['old-source'];}],
 ['commit wrong notebook version',f=>{f.events.find(e=>e.metadata?.stage==='runtime_commit').metadata.checkpoint.version=2;}],
 ['forged accepted notebook content',f=>{f.events[1].metadata.state.facts[0].text='changed';}],
 ['renewed original TTL',f=>{f.events.find(e=>e.metadata?.stage==='runtime_commit').metadata.checkpoint.expiresAt=at(8*86400000);}],
 ['unknown extra correction episode',f=>{f.events.find(e=>e.metadata?.stage==='candidate').metadata.attempt=2;}],
 ['larger shared output budget',f=>{f.events.find(e=>e.metadata?.stage==='candidate').metadata.budget.reservedOutputTokens=32768;}],
 ['wrong current run scope',f=>{f.events.find(e=>e.metadata?.stage==='runtime_commit').metadata.currentRunId='old';}],
])test('delivery audit rejects '+name,()=>{const f=delivered();mutate(f);assert.equal(auditDelivery(f).passed,false);});
test('compaction and correction reservations cannot silently raise grant or send an unaudited forward',()=>{
 for(const change of[
  e=>{e.metadata.maxTokens=2049;},e=>{e.metadata.forward=2;},e=>{e.metadata.remainingOutputTokens=16384;},e=>{e.metadata.phase='source_recovery';},
 ]){const f=delivered({compaction:true});change(f.events.find(e=>e.type==='working_memory_delivery_forward'));assert.equal(auditDelivery(f).passed,false);}
 const f=delivered({compaction:true});f.requests=[];assert.equal(auditDelivery(f).passed,false);
});
test('tool-free SDK compaction must be tied to the exact forward between consecutive WM preparations',async()=>{
 const f=fixture(),prepared=f.requests[0].hostPrepared,wm=f.events.find(e=>e.id===prepared.eventId),tr=transport(f,'prepared'),payload={model:'qwen3.7-plus',stream:true,system:'summarization',messages:[{role:'user',content:'summarize the actual conversation'}]};
 f.events.filter(e=>e.seq>=wm.seq).forEach(e=>{e.seq++;});prepared.seq++;tr.metadata.logicalPrepared.seq++;
 const forward={id:'forward',seq:wm.seq-1,type:'working_memory_delivery_forward',workshopId:'work',loopId:'loop',runId,loopRunId:runId,metadata:{receiptAuthority:'runtime',currentRunId:runId,scope:{kind:'loop',loopId:'loop'},policyIdentity:prepared.policyIdentity,budget:DELIVERY_POLICY,phase:'context_compaction'}};
 f.events.push(forward);const proof=forwardForPrepared(f.events,prepared,lease,'loop');assert.deepEqual(proof,{eventId:'forward',seq:forward.seq,phase:'context_compaction'});
 const plan={identity,provider:{actualModel:payload.model,actualEndpointHash:digest('https://opencode.ai/inference/go/anthropic/v1/messages')}},intent={round:'FIX1',planHash:digest(plan),expectedRunId:runId,createdAt:at(0),deadlineAt:at(420000),budget:BUDGET};tr.metadata.bodyHash=digest(JSON.stringify(payload));
 let sent=0;const captured=[];const create=readForward=>createAuditedFetch({originalFetch:async()=>{sent++;return new Response('ok');},plan,leaseReader:async()=>lease,intentReader:()=>intent,readPrepared:async()=>prepared,readTransport:async()=>tr,readForward,recordRequest:(_r,_i,q)=>captured.push(q),recordResponse:()=>{},countRequests:()=>0,boot:{bootId:'boot',pid:12},network:{metadata:{mode:'default'},apply:(_u,i)=>i},now:()=>base+100});
 await create(async()=>proof)('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(payload)});
 assert.equal(sent,1);assert.equal(captured[0].kind,'working-memory-agent');assert.equal(captured[0].requestPurpose,'context_compaction');
 await assert.rejects(()=>create(async()=>null)('https://opencode.ai/inference/go/anthropic/v1/messages',{method:'POST',body:JSON.stringify(payload)}),/compaction admission/);assert.equal(sent,1);
 const stale={...forward,id:'stale',seq:0};assert.equal(forwardForPrepared([wm,stale],prepared,lease,'loop'),null);
 assert.equal(forwardForPrepared([wm,{...forward,loopRunId:'other'}],prepared,lease,'loop'),null);
});
