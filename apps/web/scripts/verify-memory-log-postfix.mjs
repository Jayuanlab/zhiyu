/** Independent offline FIX1/FIX2 audit: physical attempts remain separate from SDK calls. */
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {repository,readJson,writeOnce,digest,fileHash,same,ROUNDS,BUDGET,CHECKPOINT_CONTRACT,DELIVERY_POLICY,assertAnchor,anchorPath,assertSources,assertBuild,verifyPreserved,assertCumulativeBudget,assertCheckpointBaseline,exactNextGeneratedChange,buildCompilerEvidence,expectedState,assertProductionPreflight,childRunId,ownRunEvent,snapshotLoop} from './prove-memory-log-postfix.mjs';
import {actualToolHistory,executionEventBound,eventsBeforeDeadline,healthyAuxiliaries,sameActualProductionProvider} from './verify-memory-continuity-production-repair.mjs';
import {exactTransportPreparation,forwardForPrepared} from './memory-log-postfix-preload.mjs';
import {canonicalHash,inputTextParts,embeddedObjects,continuityFromPayload,continuityAuditResult} from './lib/memory-continuity-verification.mjs';
import {currentCorrectionQualifiers,completedEvidenceResultOrder} from './verify-memory-continuity-resume.mjs';
import {exactFreshRetryCheckpoint,exactEvidenceCallBinding,verifiedEvidenceExpansion} from './verify-memory-continuity-followup.mjs';
const id=r=>r?.intent?.expectedRunId;
const adapted=(r,p)=>({events:r.events,providerRequests:r.providerRequests,before:p.identity,result:{loopRunId:id(r)}});
function completedLogProductionExecution(round, plan) {
  const id = round?.intent?.expectedRunId ?? round?.result?.loopRunId, loop = snapshotLoop(round?.after), durable = loop?.stateJson;
  const summary = loop?.runs?.find(item => item.id === id), persisted = round?.run?.data?.run;
  const completed = round?.events?.filter(event => event.type === 'loop_run_completed' && event.loopRunId === id) ?? [];
  const observed = round?.events?.filter(event => event.type === 'agent_runtime_terminal' && event.metadata?.receiptAuthority === 'runtime') ?? [];
  const receipt = observed.length === 1 ? observed[0] : null, terminal = receipt?.metadata?.runtimeTerminal;
  const full = round?.workerRun, trace = full?.verificationResult?.executionTrace, budget = trace?.events?.filter(event => event.type === 'budget_configured') ?? [];
  const finalTrace = round?.events?.filter(event => event.metadata?.runtimeTrace && ['completed', 'error', 'budget_exceeded'].includes(event.metadata.traceType)) ?? [];
  const workComplete = round?.events?.filter(event => event.type === 'run_completed' && event.runId === id) ?? [];
  const claimed = round?.events?.filter(event => event.type === 'execution_claimed' && event.runId === id) ?? [];
  return round?.cancellation === null && persisted?.id === id && persisted.status === 'completed' && !persisted.error
    && round.httpDetailTraceIsComplete === false && full?.schemaVersion === 'memory-production-worker-run.v1' && full.runId === id && full.loopId === plan.identity.loopId && full.status === 'success'
    && full.verificationHash === digest(full.verificationResult) && full.authority?.kind === 'read_only_existing_owner_services_from_observed_server_lease'
    && full.authority.userId === plan.identity.userId && full.authority.workshopId === plan.identity.workshopId && full.authority.runId === id && full.authority.workerId === round.intent.binding.workerInstanceId
    && full.bootId === round.intent.binding.workerBootId && full.pid === round.intent.binding.workerPid && full.planHash === digest(plan) && same(full.sourceHashes, plan.sourceHashes)
    && full.outputSummary?.trim() === persisted.outputSummary?.trim()
    && typeof persisted.outputSummary === 'string' && persisted.outputSummary.trim().length > 0 && !round.run.data.truncatedFields?.includes('run.outputSummary')
    && summary?.status === 'success' && summary.verificationPassed === true && summary.checkerAction === 'complete' && !summary.denied && !summary.requiresApproval && !summary.actionGuardBlocked
    && completed.length === 1 && completed[0].metadata.status === 'success' && completed[0].body === persisted.outputSummary
    && workComplete.length === 1 && workComplete[0].body === persisted.outputSummary && claimed.length === 1
    && claimed[0].metadata.workerId === round.intent.binding.workerInstanceId && claimed[0].metadata.fencingToken === receipt?.metadata.execution?.token
    && workComplete[0].metadata.execution?.workerId === round.intent.binding.workerInstanceId
    && durable?.lastLoopRunId === id && durable.lastJobStatus === 'success' && durable.lastVerificationPassed === true && durable.lastCheckerPassed === true
    && durable.lastOutcomeAction === 'complete' && durable.lastAttemptsUsed === 1 && loop.currentPhase === 'idle' && loop.blockedReason === null
    && budget.length === 1 && budget[0].status === 'completed' && budget[0].metadata?.maxToolCalls === BUDGET.maxToolCalls && trace.maxToolCalls === BUDGET.maxToolCalls && trace.budgetExceeded === false
    && Number.isSafeInteger(trace.toolCallCount) && trace.toolCallCount >= 0 && trace.toolCallCount <= BUDGET.maxToolCalls && !trace.events.some(event => ['error', 'budget_exceeded'].includes(event.type))
    && finalTrace.length === 1 && finalTrace[0].metadata.traceType === 'completed' && finalTrace[0].metadata.traceStatus === 'completed'
    && receipt?.metadata.ordinal === 1 && receipt.metadata.currentRunId === id && receipt.runId === id && receipt.loopRunId === id
    && receipt.workshopId === plan.identity.workshopId && receipt.loopId === plan.identity.loopId
    && same(receipt.metadata.scope, { kind: 'loop', loopId: plan.identity.loopId })
    && receipt.metadata.runtime?.engine === 'pi' && receipt.metadata.runtime.adapter === 'pi-agent-harness' && typeof receipt.metadata.runtime.version === 'string'
    && terminal?.schemaVersion === 'agent-runtime-terminal.v1' && terminal.status === 'completed' && terminal.cleanupStatus === 'completed'
    && terminal.completionScope === 'runtime' && !terminal.error && (terminal.runtimeStatus === undefined || terminal.runtimeStatus === 'completed')
    && trace.runtimeTerminalCount === 1 && same(trace.runtimeTerminal, terminal)
    && trace.events.filter(event => event.type === 'agent_runtime_terminal').length === 1
    && trace.events.some(event => event.type === 'agent_runtime_terminal' && event.status === 'completed' && same(event.metadata?.runtimeTerminal, terminal))
    && Number.isSafeInteger(receipt.seq) && receipt.seq < completed[0].seq && Date.parse(receipt.createdAt) <= Date.parse(completed[0].createdAt)
    && Date.parse(persisted.completedAt) >= Date.parse(completed[0].createdAt)
    && receipt.metadata.execution?.workerId === round.intent.binding.workerInstanceId && completed[0].metadata.execution?.workerId === round.intent.binding.workerInstanceId;
}
export function completedLogProductionTask(round, plan) {
  return round?.failure === null && completedLogProductionExecution(round, plan);
}
export const hasAutonomousOwnerProof=proofs=>proofs.some(p=>ROUNDS.includes(p.round)&&p.actualCompletedTask===true&&p.mode==='autonomous-model-tool-use');
export const exactFIX1Parent=(checkpoint,previous)=>!!previous&&exactFreshRetryCheckpoint(checkpoint,previous)&&Date.parse(checkpoint.expiresAt)-Date.parse(checkpoint.createdAt)===7*86400000;
export const exactPreviousCheckpoint=exactFIX1Parent;
export function freshLogSourceCheckpoint(round) {
  const events = round?.events ?? [], last = events.filter(event => ["working_memory_updated", "working_memory_restored"].includes(event.type)
    && event.metadata?.receiptAuthority === "runtime").sort((a, b) => a.seq - b.seq).at(-1);
  if (last?.type !== "working_memory_updated" || last.metadata.operation !== "update" || last.metadata.phase !== "LOG" || last.metadata.mode !== "apply" || last.metadata.status !== "ready_for_projection"
    || !last.metadata.state?.openQuestions?.length) return false;
  return [...(last.metadata.state.facts ?? []), ...(last.metadata.state.hypotheses ?? []), last.metadata.state.nextAction].filter(Boolean).some(note => Array.isArray(note.evidenceIds) && note.evidenceIds.length > 0 && note.evidenceIds.every(toolCallId => {
    const matches = last.metadata.evidenceCatalog?.filter(item => item.toolCallId === toolCallId) ?? [], entry = matches[0], binding = entry?.sourceIdentity;
    const source = events.find(event => event.id === (binding?.sourceEventId ?? binding?.evidenceEventId)), raw = source?.metadata;
    const prepared = events.find(event => event.type === "working_memory_projected" && event.metadata?.receiptAuthority === "runtime"
      && event.metadata.status === "provider_request_prepared" && event.metadata.version === last.metadata.version && event.seq > last.seq
      && same(event.metadata.policyIdentity, last.metadata.policyIdentity) && event.metadata.evidenceCatalog?.some(item => item.toolCallId === toolCallId
        && item.referenceEligible === true && item.sourceIdentityStatus === "reported" && item.contentHash === entry.contentHash && same(item.sourceIdentity, binding)));
    return matches.length === 1 && entry.toolName === "webReadPage" && entry.referenceEligible === true && entry.sourceIdentityStatus === "reported"
      && /^[a-f0-9]{64}$/.test(entry.contentHash) && /^[a-f0-9]{64}$/.test(binding?.contentHash)
      && source?.type === "source_checked" && raw?.receiptAuthority === "runtime" && raw.ok === true && raw.toolName === "webReadPage"
      && source.workshopId === round.before.workshopId && source.loopId === round.before.loopId && source.loopRunId === round.result.loopRunId
      && source.seq < last.seq && (raw.toolUseId ?? raw.toolCallId) === toolCallId && raw.contentHash === binding.contentHash && raw.evidenceId === binding.evidenceId
      && ["offset", "contentLength", "totalChars", "sourceVersion"].every(key => binding[key] === raw[key])
      && Number.isSafeInteger(binding.offset) && binding.offset >= 0 && Number.isSafeInteger(binding.contentLength) && binding.contentLength > 0
      && Number.isSafeInteger(binding.totalChars) && binding.offset + binding.contentLength <= binding.totalChars
      && !!prepared && round.providerRequests.some(request => request.kind === "working-memory-agent" && request.hostPrepared?.eventId === prepared.id
        && request.hostPrepared.seq === prepared.seq && request.hostPrepared.version === last.metadata.version && request.responseStatus === 200 && request.error === null);
  }));
}
const keys=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];
export function honestRawUsage(u){return u?.billing==='unknown'&&keys.every(k=>u[k]===null||Number.isSafeInteger(u[k])&&u[k]>=0)&&(u.status==='unknown'?keys.every(k=>u[k]===null):u.status==='partial'&&keys.some(k=>u[k]!==null));}
export function honestSdkUsage(u){
 const fields=[...keys,'totalTokens'],numeric=v=>Number.isSafeInteger(v)&&v>=0;
 return !!u&&fields.every(k=>u[k]===null||numeric(u[k]))&&(u.usageStatus==='unknown'
   ?u.source==='unknown'&&fields.every(k=>u[k]===null)
   :u.source==='sdk_result'&&(u.usageStatus==='reported'?fields.every(k=>numeric(u[k]))&&u.totalTokens>0
     :u.usageStatus==='partial'&&fields.some(k=>numeric(u[k]))));
}
export function auditDelivery({events,requests,runId,identity}){
 const checks=[],check=(name,passed)=>checks.push({name,passed:passed===true});
 const logs=events.filter(e=>['working_memory_updated','working_memory_restored'].includes(e.type)&&e.metadata?.receiptAuthority==='runtime').sort((a,b)=>a.seq-b.seq),log=logs.at(-1),m=log?.metadata;
 const checked=events.filter(e=>e.type==='working_memory_delivery_checked'),candidate=checked.filter(e=>e.metadata?.stage==='candidate'),commits=checked.filter(e=>e.metadata?.stage==='runtime_commit'),last=candidate.at(-1),commit=commits[0];
 const terminal=events.filter(e=>e.type==='agent_runtime_terminal'&&e.metadata?.receiptAuthority==='runtime');
 const scoped=e=>e?.workshopId===identity.workshopId&&e.loopId===identity.loopId&&e.runId===runId&&e.loopRunId===runId&&e.metadata.receiptAuthority==='runtime'&&e.metadata.currentRunId===runId&&same(e.metadata.scope,{kind:'loop',loopId:identity.loopId})&&same(e.metadata.policyIdentity,m?.policyIdentity)&&same(e.metadata.budget,DELIVERY_POLICY);
 check('new model-authored LOG is the final notebook mutation',log?.type==='working_memory_updated'&&m.operation==='update'&&m.phase==='LOG'&&m.mode==='apply'&&m.status==='ready_for_projection'&&m.state?.openQuestions?.length>0);
 check('one or two bounded candidate checks and one fresh post-terminal commit',candidate.length>=1&&candidate.length<=2&&commits.length===1&&checked.every(scoped)&&candidate.every((e,i)=>e.metadata.attempt===i&&same(e.metadata.contract,CHECKPOINT_CONTRACT)&&e.metadata.schemaVersion==='working-memory-delivery.v1'&&e.metadata.correctionsPresent===true)&&last?.metadata.ok===true&&last.metadata.status==='satisfied'&&last.metadata.code==='current_source_checkpoint_delivered'&&candidate.slice(0,-1).every(e=>e.metadata.ok===false&&e.metadata.status==='needs_correction'&&e.metadata.checkpoint===null)&&commit?.metadata.attempt===last?.metadata.attempt&&commit?.metadata.schemaVersion==='working-memory-delivery.v1'&&same(commit?.metadata.contract,CHECKPOINT_CONTRACT)&&commit?.metadata.correctionsPresent===true&&commit?.metadata.ok===true&&commit.metadata.status==='satisfied'&&commit.metadata.code==='current_source_checkpoint_delivered');
 const catalog=m?.evidenceCatalog??[],refs=[];
 const notes=[...(m?.state?.facts??[]).map(n=>({n,required:true})),...(m?.state?.hypotheses??[]).map(n=>({n,required:false})),{n:m?.state?.nextAction,required:false}];
 for(const {n,required}of notes){if(!n||typeof n.text!=='string'||!n.text.trim()||n.text.length>2000||!Array.isArray(n.evidenceIds)||n.evidenceIds.length>64||new Set(n.evidenceIds).size!==n.evidenceIds.length||required&&!n.evidenceIds.length)continue;
  const entries=n.evidenceIds.map(t=>catalog.filter(e=>e.toolCallId===t));
  if(entries.every(a=>a.length===1&&a[0].referenceEligible===true&&a[0].sourceIdentityStatus==='reported'&&events.some(s=>s.id===a[0].sourceIdentity?.sourceEventId&&s.type==='source_checked'&&s.seq<log.seq&&s.metadata?.ok===true)))refs.push(...entries.map(a=>({toolCallId:a[0].toolCallId,sourceEventId:a[0].sourceIdentity.sourceEventId})));
 }
 const createdAt=log?.createdAt,expiresAt=Number.isFinite(Date.parse(createdAt))?new Date(Date.parse(createdAt)+7*86400000).toISOString():null;
 const expected=log?{eventId:log.id,version:m.version,sourceEventIds:[...new Set(refs.map(r=>r.sourceEventId))],toolCallIds:[...new Set(refs.map(r=>r.toolCallId))],createdAt,expiresAt,rootHash:canonicalHash({workshopId:identity.workshopId,sourceRunId:runId,checkpointEventId:log.id,metadata:m,expiresAt}),hasOpenQuestions:true,hasNextAction:!!(m.state?.nextAction?.text?.trim()),authority:'model-authored-unverified'}:null;
 check('candidate and commit bind exact fresh source IDs version body hash and original TTL',!!expected&&expected.sourceEventIds.length>0&&same(last?.metadata.checkpoint,expected)&&same(commit?.metadata.checkpoint,expected));
 check('accepted LOG precedes candidate then unique runtime terminal then fresh commit',!!log&&!!last&&!!commit&&terminal.length===1&&log.seq<last.seq&&last.seq<terminal[0].seq&&terminal[0].seq<commit.seq&&events.filter(e=>['loop_run_completed','run_completed'].includes(e.type)).every(e=>e.seq>commit.seq));
 const forwards=events.filter(e=>e.type==='working_memory_delivery_forward');let remaining=DELIVERY_POLICY.reservedOutputTokens,corrections=0,compactions=0,compactionTokens=0;
 for(const e of forwards){const v=e.metadata,isCompaction=v.phase==='context_compaction',max=isCompaction?1:4;remaining-=v.maxTokens;
  if(isCompaction){compactions++;compactionTokens+=v.maxTokens;}else corrections++;
  check('each bounded forward is runtime-authorized charged and reaches exactly one logical input',scoped(e)&&['context_compaction','report_correction'].includes(v.phase)&&v.forward===(isCompaction?compactions:corrections)&&v.maxForwards===max&&Number.isSafeInteger(v.maxTokens)&&v.maxTokens>0&&v.maxTokens<=v.requestedMaxTokens&&Number.isSafeInteger(v.sdkEstimatedInputTokens)&&v.sdkEstimatedInputTokens>=0&&v.capSource==='sdk_context_estimate'&&remaining>=0&&v.remainingOutputTokens===remaining&&(!isCompaction||v.maxTokens<=2048)&&(!last||e.seq<last.seq)&&(!isCompaction?candidate.some(c=>c.seq<e.seq&&c.metadata.status==='needs_correction'):true)&&requests.filter(r=>r.kind==='working-memory-agent'&&r.transportPrepared?.attempt===1&&r.deliveryForward?.eventId===e.id).length===1);
 }
 check('correction and compaction share the finite output grant and forward caps',corrections<=4&&compactions<=1&&compactionTokens<=2048&&remaining>=0);
 return {passed:checks.every(c=>c.passed),checks,checkpoint:expected,correctionForwards:corrections,compactionForwards:compactions,reservedOutputTokensConsumed:16384-remaining};
}
export function auditPhysicalLogical({events,requests,runId,identity}){
 const checks=[],check=(name,passed)=>checks.push({name,passed:passed===true}),main=requests.filter(r=>r.kind==='working-memory-agent');
 const transport=events.filter(e=>e.type==='provider_transport_attempt'&&e.metadata?.receiptAuthority==='runtime'&&e.metadata.schemaVersion==='host-provider-transport.v1');
 const claims=events.filter(e=>e.type==='execution_claimed'&&e.runId===runId),lease={runId,workshopId:identity.workshopId,loopId:identity.loopId,userId:identity.userId,workerId:claims[0]?.metadata.workerId,token:claims[0]?.metadata.fencingToken};
 const prepared=transport.filter(e=>e.metadata.phase==='prepared'),finished=transport.filter(e=>e.metadata.phase==='finished'),decisions=transport.filter(e=>e.metadata.phase==='recovery_decision');
 check('exact scope and complete physical receipts',claims.length===1&&main.length>0&&events.filter(e=>e.type==='provider_transport_attempt').length===transport.length&&prepared.length===main.length&&finished.length===main.length&&decisions.length===main.length&&transport.every(e=>e.runId===runId&&e.loopRunId===runId&&e.workshopId===identity.workshopId&&e.loopId===identity.loopId&&e.metadata.currentRunId===runId&&e.metadata.actorId===lease.userId&&e.metadata.execution?.runId===runId&&e.metadata.execution.workerId===lease.workerId&&e.metadata.execution.token===lease.token&&same(e.metadata.scope,{kind:'loop',loopId:identity.loopId})));
 const groups=new Map();
 for(const r of main){
  const p=prepared.filter(e=>e.id===r.transportPrepared?.eventId),e=p[0],m=e?.metadata;
  const f=finished.filter(x=>x.metadata.transportOrdinal===m?.transportOrdinal&&x.metadata.logicalInvocation===m?.logicalInvocation&&x.metadata.attempt===m?.attempt),last=f[0];
  const d=decisions.filter(x=>x.metadata.transportOrdinal===m?.transportOrdinal&&x.metadata.logicalInvocation===m?.logicalInvocation&&x.metadata.attempt===m?.attempt),decision=d[0];
  check('actual physical body and preparation binding',p.length===1&&exactTransportPreparation(e,r.hostPrepared,lease,r.wireBodyHash)&&r.transportPrepared.seq===e.seq&&r.transportPrepared.logicalInvocation===m.logicalInvocation&&r.transportPrepared.attempt===m.attempt&&r.transportPrepared.transportOrdinal===m.transportOrdinal&&r.payloadHash===digest(r.payload)&&Date.parse(e.createdAt)<=Date.parse(r.dispatchedAt));
  check('bounded finished transport and honest raw usage',!!e&&!!m&&f.length===1&&d.length===1&&last.seq>e.seq&&decision.seq>last.seq&&last.metadata.bodyHash===m.bodyHash&&decision.metadata.bodyHash===m.bodyHash&&last.metadata.physicalFetchStarted===true&&last.metadata.httpStatus===200&&r.responseStatus===200&&r.error===null&&Number.isSafeInteger(last.metadata.responseBytes)&&last.metadata.responseBytes>0&&last.metadata.responseBytes<=4194304&&Number.isSafeInteger(last.metadata.frameCount)&&last.metadata.frameCount>0&&last.metadata.frameCount<=20000&&/^[a-f0-9]{64}$/.test(last.metadata.responseBodyHash??'')&&honestRawUsage(last.metadata.usage)&&Date.parse(last.createdAt)<=Date.parse(m.deadlineAt)&&Date.parse(m.deadlineAt)-Date.parse(e.createdAt)<=120000&&Date.parse(m.deadlineAt)>Date.parse(e.createdAt));
  if(m){const a=groups.get(m.logicalInvocation)??[];a.push({request:r,prepared:e,finished:last,decision});groups.set(m.logicalInvocation,a);}
 }
 let recoveries=0;const logical=[];
 for(const [logicalInvocation,a]of [...groups].sort((a,b)=>a[0]-b[0])){
  a.sort((a,b)=>a.prepared.metadata.attempt-b.prepared.metadata.attempt);const first=a[0],second=a[1],last=a.at(-1);
  check('one logical call has one initial attempt and at most one exact recovery',a.length>=1&&a.length<=2&&first.prepared.metadata.attempt===1&&a.every(x=>same(x.request.hostPrepared,first.request.hostPrepared)&&x.request.wireBodyHash===first.request.wireBodyHash&&same(x.request.payload,first.request.payload)));
  if(second){recoveries++;check('only audited opaque error authorizes exact retry',first.finished?.metadata.classification==='opaque_empty_error'&&first.decision?.metadata.decision==='retry_once'&&first.decision.metadata.reason==='exact_opaque_error'&&second.prepared.metadata.attempt===2&&second.prepared.seq>first.decision.seq&&second.prepared.metadata.sameBody===true&&second.prepared.metadata.sameHeaders===true&&second.prepared.metadata.deadlineAt===first.prepared.metadata.deadlineAt);}
  check('final physical response is complete before SDK admission',last.finished?.metadata.classification==='complete_sse'&&last.decision?.metadata.decision==='not_recovered'&&last.decision.metadata.reason==='not_eligible');
  logical.push({logicalInvocation,request:first.request,hostPrepared:first.request.hostPrepared,lastFinishedSeq:last.finished?.seq,physicalAttempts:a.length});
 }
 check('single run recovery and sequential transport identity',recoveries<=1&&prepared.every((e,i)=>e.metadata.transportOrdinal===i+1)&&logical.every((g,i)=>g.logicalInvocation===i+1));
 const wm=events.filter(e=>e.type==='working_memory_projected'&&e.metadata?.receiptAuthority==='runtime'&&e.metadata.status==='provider_request_prepared'),usage=events.filter(e=>e.type==='working_memory_usage'&&e.metadata?.receiptAuthority==='runtime');
 check('one actual WM preparation and truthful SDK usage per logical call',wm.length===logical.length&&usage.length===logical.length&&new Set(logical.map(g=>g.hostPrepared.eventId)).size===logical.length&&logical.every((g,i)=>{const next=logical[i+1],u=usage.filter(e=>e.seq>g.lastFinishedSeq&&(!next||e.seq<next.hostPrepared.seq));return wm.some(e=>e.id===g.hostPrepared.eventId&&e.seq===g.hostPrepared.seq)&&u.length===1&&honestSdkUsage(u[0].metadata);}));
 return{passed:checks.every(c=>c.passed),checks,logical,physicalMainRequests:main.length,logicalMainCalls:logical.length,recoveries,reportedSdkUsageReceipts:usage.filter(e=>e.metadata.usageStatus==='reported').length,mainUsageComplete:usage.length===logical.length&&usage.every(e=>e.metadata.usageStatus==='reported'&&honestSdkUsage(e.metadata)),failedPhysicalUsage:finished.filter(e=>e.metadata.classification!=='complete_sse').map(e=>({classification:e.metadata.classification,usage:e.metadata.usage}))};
}
export function failedLatestContinuity(e,payloads,runId,loopId){return e?.metadata.receiptAuthority==='runtime'&&e.metadata.status==='skipped'&&e.metadata.reason==='latest_run_unsuccessful'&&e.metadata.checkpoint===null&&e.metadata.currentRunId===runId&&same(e.metadata.scope,{kind:'loop',loopId})&&payloads.length>0&&payloads.every(p=>continuityFromPayload(p).length===0);}
export function expectedInitialSkip(previous){
 return previous?.run?.data?.run?.status==='failed'&&previous?.workerRun?.status==='failed'?'latest_run_unsuccessful':null;
}
export function initialNoCheckpoint(e,payloads,runId,loopId,previous){
 const expected=expectedInitialSkip(previous),m=e?.metadata;
 return !!expected&&m?.receiptAuthority==='runtime'&&m.status==='skipped'&&m.reason===expected&&m.checkpoint===null
   &&m.currentRunId===runId&&same(m.scope,{kind:'loop',loopId})&&m.guidanceAdmission?.status==='admitted'&&payloads.length>0
   &&payloads.every(p=>{const skips=inputTextParts(p).flatMap(t=>embeddedObjects(t,'历史工作检查点未接续（宿主状态）：'));
     return continuityFromPayload(p).length===0&&skips.length===1&&same(skips[0],continuityAuditResult(m));});
}
const objects=(v,d=0)=>{if(d>5||v==null)return[];if(typeof v==='string'){try{return objects(JSON.parse(v),d+1);}catch{return[];}}if(Array.isArray(v))return v.flatMap(x=>objects(x,d+1));return typeof v==='object'?[v,...objects(v.text,d+1),...objects(v.content,d+1),...objects(v.data,d+1)]:[];};
export function auditLogProduction({root=repository,directory}){
 const plan=readJson(resolve(directory,'production-session.json')),checks=[],artifactHashes={},roundAcceptance={},usage=[],evidenceProof=[];
 const check=(name,passed)=>checks.push({name,passed:passed===true}),attempt=(name,fn)=>{try{fn();check(name,true);}catch{check(name,false);}},record=file=>{artifactHashes[resolve(file)]=fileHash(file);return readJson(file);};record(resolve(directory,'production-session.json'));
 check('independent final auditor exactly frozen',plan.auditorHash===fileHash(resolve(root,'apps/web/scripts/verify-memory-log-postfix.mjs')));
 attempt('new source baseline build and cumulative caps are explicit',()=>{assertAnchor(readJson(anchorPath(root)),plan,directory);assertSources(root,plan.sourceHashes);assertBuild(root,plan.build);verifyPreserved(plan);assertCumulativeBudget(plan,directory);});
 const priorPlan=record(resolve(plan.parent.directory,'production-session.json'));
 attempt('new runtime and opt-in contract preserve original goal provider and historical sources',()=>{if(fileHash(resolve(plan.parent.directory,'production-session.json'))!==plan.parent.originalPlanHash||!same(plan.provider,priorPlan.provider)||!same(plan.recoveryPolicy,priorPlan.recoveryPolicy)||!same(plan.allowedTools,priorPlan.allowedTools)||!same(plan.checkpointContract,CHECKPOINT_CONTRACT)||!same(plan.checkpointDeliveryPolicy,DELIVERY_POLICY))throw Error('Original source/runtime boundary or new bounded contract mismatch');const expected=Object.keys(plan.sourceHashes).filter(path=>plan.sourceHashes[path]!==priorPlan.sourceHashes[path]).map(path=>({path,beforeHash:priorPlan.sourceHashes[path]??null,afterHash:plan.sourceHashes[path]}));if(!same(expected,plan.sourceDelta))throw Error('Explicit source delta is incomplete');});
 const buildReceipt=record(plan.buildReceipt.filename);check('only exact predeclared Next type generation changed during production build',exactNextGeneratedChange(buildReceipt,readFileSync(resolve(root,'apps/web/next-env.d.ts'),'utf8'),buildCompilerEvidence(root,plan.buildReceipt.filename))&&same(plan.instrumentationVersion.declaredGeneratedNextTypeImport,buildReceipt.generatedSourceChanges)&&(!buildReceipt.buildDeclaration||same(plan.buildDeclaration,buildReceipt.buildDeclaration)));
 const previous=record(resolve(plan.parent.directory,plan.parent.roundFile)),priorReview=record(plan.parent.reviewFilename);
 check('failed LOG1 remains failed with its saved but ineligible checkpoint and original strict verdict',fileHash(resolve(plan.parent.directory,plan.parent.roundFile))===plan.parent.roundHash&&previous.run?.data?.run?.status==='failed'&&previous.workerRun?.status==='failed'&&previous.events.some(e=>e.type==='working_memory_updated')&&priorReview.passed===false&&priorReview.roundAcceptance?.LOG1?.completeRealTask===false&&priorReview.roundAcceptance?.LOG1?.mechanismPassed===false&&plan.parent.strictAccepted===false&&plan.parent.businessCompleted===false&&plan.parent.checkpointEligible===false);
 attempt('actual post-configuration baseline retains latest durable feedback',()=>assertCheckpointBaseline(priorPlan,previous,plan.initial));
 const baseline=record(plan.baselineSnapshot.filename);check('immutable actual read-only baseline binds the opt-in verification version',same(baseline.snapshot,plan.initial)&&baseline.modelCalls===0&&baseline.domainAttempts===0&&digest(snapshotLoop(plan.initial).verificationConfig)===plan.identity.loopVerificationHash);
 const old=readJson(resolve(root,'.tmp/memory-continuity/20261018-resume-loop/resume-session.json')),correction=readJson(resolve(root,old.priorCampaign.directory,'correction.json')),corrected={...correction,expectedVersion:plan.correction.expectedVersion},originalMemory=correction.result.oldMemory.id;
 const preflights=readdirSync(directory).filter(n=>/^production-preflight-.*\.json$/.test(n));check('new formal production build and worker preflight exists',preflights.length>0);for(const n of preflights){const p=record(resolve(directory,n));attempt('new production preflight binds final plan',()=>{if(p.planHash!==digest(plan))throw Error();assertProductionPreflight(plan,p.snapshot,p.deployment,p.boots);});}
 const profile=record(plan.providerProfile.filename);
 check('fresh current provider resolution is source-bound without model dispatch',profile.sourceBinding?.status==='matched'&&profile.configuredWorkLoopMatchesParent===true&&profile.modelConfigurationMatchesParent===true&&profile.modelHttp?.fetchBlocked===true&&profile.modelHttp.attemptedFetches===0&&profile.credentialValuesOrHashesRecorded===false&&profile.actualModel===plan.provider.actualModel&&profile.protocol===plan.provider.protocol&&profile.actualEndpointHash===plan.provider.actualEndpointHash&&Object.entries(profile.sourceBinding.sourceHashes??{}).length>0&&Object.entries(profile.sourceBinding.sourceHashes).every(([path,hash])=>plan.sourceHashes[path]===hash));
 const preflightPassed=checks.every(c=>c.passed),rounds=ROUNDS.map(n=>existsSync(resolve(directory,'round-'+n+'.json'))?record(resolve(directory,'round-'+n+'.json')):null);
 for(let i=0;i<ROUNDS.length;i++){
  const name=ROUNDS[i],r=rounds[i],start=checks.length;if(!r){roundAcceptance[name]={attempted:existsSync(resolve(directory,'round-'+name+'-intent.json')),mechanismPassed:false,completeRealTask:false,missing:true};continue;}
  const intent=record(resolve(directory,'round-'+name+'-intent.json')),runId=id(r),events=r.events,requests=r.providerRequests;
  check(name+': one formal queue command and frozen version',same(intent,r.intent)&&intent.planHash===digest(plan)&&intent.commandId===plan.phase+':'+name&&runId===childRunId(plan.identity.userId,plan.identity.workshopId,intent.commandId)&&r.accepted?.status===202&&r.accepted.data.accepted===true&&Object.values(r.accepted.data).includes(runId)&&same(intent.body,{commandId:intent.commandId,expectedVersion:r.before?.workshop?.data?.commandVersion,mode:'native_agent',wait:false,createOutboxDrafts:false})&&same(r.sourceHashes,plan.sourceHashes)&&same(r.build,plan.build));
  check(name+': explicit read-only preflight preceded dispatch',preflights.some(file=>Date.parse(readJson(resolve(directory,file)).snapshot.observedAt)<=Date.parse(intent.createdAt)));
  attempt(name+': actual new managed production worker before and after',()=>{assertProductionPreflight(plan,r.before,r.deployment,r.boots);assertProductionPreflight(plan,r.after,r.deployment,r.boots);});
  check(name+': exact durable predecessor state',!!(i===0?plan.initial:rounds[i-1])&&same(expectedState(r.before),i===0?expectedState(plan.initial):expectedState(rounds[i-1]?.after))&&(i===0||completedLogProductionTask(rounds[i-1],plan)));
  check(name+': complete business output and runtime cleanup',completedLogProductionTask(r,plan));
  check(name+': physical and time caps',same(r.budget,plan.budget)&&same(intent.budget,plan.budget)&&requests.length>0&&requests.length<=BUDGET.maxRequests&&Date.parse(r.run?.data?.run?.completedAt)<=Date.parse(intent.deadlineAt)&&Date.parse(intent.deadlineAt)-Date.parse(intent.createdAt)===BUDGET.maxSeconds*1000&&eventsBeforeDeadline(events,intent.deadlineAt)&&Date.parse(r.finishedAt)<=Date.parse(intent.deadlineAt)+30000&&Date.parse(intent.createdAt)<Date.parse(r.finishedAt));
  const claims=events.filter(e=>e.type==='execution_claimed'&&e.runId===runId),execution={runId,workerId:intent.binding.workerInstanceId,userId:plan.identity.userId,fencingToken:claims[0]?.metadata.fencingToken};
  check(name+': full monotone own-run audit and execution lease',claims.length===1&&events.length>0&&new Set(events.map(e=>e.seq)).size===events.length&&events.every((e,k)=>ownRunEvent(e,plan.identity,runId,{workerId:execution.workerId,token:execution.fencingToken})&&!e.metadata?.__truncated&&Number.isSafeInteger(e.seq)&&(!k||e.seq>events[k-1].seq)&&executionEventBound(e,execution)));
  const workerFile=resolve(directory,'spool',name+'-worker-run.json');check(name+': raw full persisted worker trace retained',existsSync(workerFile)&&same(record(workerFile),r.workerRun));
  for(const q of requests){const body=record(resolve(directory,q.requestBodyFile)),response=record(resolve(directory,q.requestBodyFile.replace('.request.json','.response.json')));check(name+': exact physical spool and host dispatch authority',same({...body,requestBodyFile:q.requestBodyFile,...response},q)&&q.authority?.kind==='server_owned_async_local_storage'&&q.authority.userId===plan.identity.userId&&q.authority.workshopId===plan.identity.workshopId&&q.authority.runId===runId&&q.authority.workerId===intent.binding.workerInstanceId&&q.planHash===digest(plan)&&q.pid===intent.binding.workerPid&&q.bootId===intent.binding.workerBootId&&q.payloadHash===digest(q.payload)&&q.credentialValuesOrHashesRecorded===false&&q.requestHeadersRecorded===false&&Date.parse(q.dispatchedAt)>=Date.parse(intent.createdAt)&&Date.parse(q.dispatchedAt)<Date.parse(intent.deadlineAt));const net=q.network;check(name+': ordinary production network and TLS boundaries retained',net?.mode==='default'&&net.preflightModelRequests===0&&net.processEnvironmentChanged===false&&net.globalDispatcherChanged===false&&net.certificateValidation===true&&net.originalHostnameAndSniPreserved===true);}
  const physical=auditPhysicalLogical({events,requests,runId,identity:plan.identity});check(name+': independent physical versus logical audit',physical.passed);
  const allMain=physical.logical.map(g=>g.request),main=allMain.filter(q=>q.requestPurpose==='agent'),compaction=allMain.filter(q=>q.requestPurpose==='context_compaction'),payloads=main.map(q=>q.payload),contexts=payloads.map(p=>inputTextParts(p).flatMap(t=>embeddedObjects(t,'Workshop context:')).filter(c=>c.workshop?.id===plan.identity.workshopId));
  check(name+': same actual model endpoint and protocol',main.length>0&&allMain.every(q=>sameActualProductionProvider(q.payload,q,plan.provider)));
  check(name+': tool-free compaction is separately admitted without hiding a logical request',allMain.length===main.length+compaction.length&&compaction.length<=1&&allMain.every(q=>{const actual=forwardForPrepared(events,q.hostPrepared,{...plan.identity,runId},plan.identity.loopId);return same(q.deliveryForward,actual)&&(q.requestPurpose==='agent'?(q.payload.tools??[]).some(t=>(t.function?.name??t.name)==='workingMemory'):q.payload.stream===true&&(q.payload.tools?.length??0)===0&&actual?.phase==='context_compaction');}));
  check(name+': read/log-only registered and actually requested tool boundaries',payloads.length>0&&payloads.every(p=>same((p.tools??[]).map(t=>t.function?.name??t.name).sort(),plan.allowedTools))&&events.filter(e=>e.type==='tool_call'&&e.metadata?.runtimeTrace===true).every(e=>plan.allowedTools.includes(e.metadata.toolName?.split('__').at(-1)))&&!events.some(e=>['outbox_sent','outbox_draft_created','trade_order_placed'].includes(e.type)));
  check(name+': complete current correction true confidence status owner warning',contexts.length>0&&contexts.every(g=>g.length===1&&currentCorrectionQualifiers(g[0],corrected,originalMemory,r.before.revision.data.memory)));
  const specs=payloads.map(p=>inputTextParts(p).flatMap(t=>embeddedObjects(t,'Loop spec:')));
  check(name+': actual main inputs contain the persisted opt-in fresh LOG contract',specs.length>0&&specs.every(g=>g.length===1&&same(g[0].verification?.workingMemoryCheckpoint,CHECKPOINT_CONTRACT)));
  const durable=expectedState(r.before).stateJson,stateInputs=payloads.map(p=>inputTextParts(p).flatMap(t=>embeddedObjects(t,'Current durable state:')));
  check(name+': exact latest durable feedback reached actual model',payloads.length>0&&stateInputs.every(g=>g.length===1&&['lastLoopRunId','lastJobStatus','lastAttemptsUsed','lastCheckerPassed','lastOutcomeAction','lastVerificationPassed'].every(k=>g[0].stateJson?.[k]===durable?.[k])));
  check(name+': both auxiliary LLM calls completed',healthyAuxiliaries(contexts.flat(),events,requests.filter(q=>q.kind!=='working-memory-agent')));
  const c=events.filter(e=>e.type==='working_memory_continuity_loaded'&&e.metadata?.receiptAuthority==='runtime'),receipt=c[0];
  if(i===0)check('FIX1: latest failed LOG1 is explicitly skipped without reviving older history',c.length===1&&initialNoCheckpoint(receipt,payloads,runId,plan.identity.loopId,previous));
  else {check(name+': inherits exact preceding fresh root hash and its original TTL',!!rounds[i-1]&&c.length===1&&receipt.metadata.status==='inherited'&&exactPreviousCheckpoint(receipt.metadata.checkpoint,adapted(rounds[i-1],plan))&&payloads.every(p=>{const v=continuityFromPayload(p);return v.length===1&&same(v[0],continuityAuditResult(receipt.metadata));}));const cp=receipt?.metadata.checkpoint;check(name+': current Brain correction suppresses inherited claims/actions',receipt?.metadata.claimGuard?.suppressHistoricalClaims===true&&cp?.chain?.assertionsSuppressed===true&&cp.history?.facts?.length===0&&cp.history.hypotheses?.length===0&&cp.history.nextAction===null&&cp.history.openQuestions?.length>0&&cp.sourceRefs?.length===0);}
  check(name+': saves a genuinely new source-bound accepted LOG checkpoint',freshLogSourceCheckpoint(adapted(r,plan)));
  const delivery=auditDelivery({events,requests,runId,identity:plan.identity});check(name+': candidate and post-runtime delivery independently bind the actual source LOG and finite forwards',delivery.passed);
  const output=r.run?.data?.run?.outputSummary??'',includes=correction.evaluationAssertions?.outputIncludes??[],excludes=correction.evaluationAssertions?.outputExcludes??[];check(name+': actual output follows original owner assertions',includes.length>0&&excludes.length>0&&includes.every(t=>output.includes(t))&&excludes.every(t=>!output.includes(t)));
  for(const q of main){const h=actualToolHistory(q.payload),prepared=events.find(e=>e.id===q.hostPrepared.eventId);for(const result of h.results){const calls=events.filter(e=>exactEvidenceCallBinding(h.calls.get(result.toolCallId),e,plan.correction.memoryId));if(calls.some(call=>events.some(e=>completedEvidenceResultOrder(call,e,prepared,result.toolCallId)))&&objects(result.content).some(o=>verifiedEvidenceExpansion(o,corrected,originalMemory)))evidenceProof.push({round:name,actualCompletedTask:completedLogProductionTask(r,plan),mode:'autonomous-model-tool-use'});}}
  usage.push({round:name,physicalProviderRequests:requests.length,physicalMainRequests:physical.physicalMainRequests,logicalMainCalls:physical.logicalMainCalls,agentLogicalCalls:main.length,compactionLogicalCalls:compaction.length,reportedSdkUsageReceipts:physical.reportedSdkUsageReceipts,mainUsageComplete:physical.mainUsageComplete,failedPhysicalUsage:physical.failedPhysicalUsage,recoveries:physical.recoveries,delivery,auxiliaryUsageStatus:'unknown',monetaryCostUsd:null});
  roundAcceptance[name]={attempted:true,mechanismPassed:preflightPassed&&checks.slice(start).every(c=>c.passed),completeRealTask:completedLogProductionTask(r,plan),failedChecks:checks.slice(start).filter(c=>!c.passed).map(c=>c.name)};
 }
 check('at least one successful LOG task autonomously expanded typed owner evidence',hasAutonomousOwnerProof(evidenceProof));
 const all=rounds.every(Boolean),passed=all&&checks.every(c=>c.passed),mainUsageComplete=usage.length===ROUNDS.length&&usage.every(u=>u.mainUsageComplete);
 return{schemaVersion:'memory-log-postfix-independent-review.v1',planHash:digest(plan),reviewedAt:new Date().toISOString(),status:passed?'two_task_production_log_postfix_verified_cost_unknown':all?'failed':'incomplete_evidence',passed,mechanismPassed:passed,mainUsageComplete,measurementStatus:mainUsageComplete?'main_sdk_usage_reported_cost_unknown':'usage_incomplete_cost_unknown',preflightPassed,roundAcceptance,usage,evidenceProof,checks,artifactHashes,cumulativeBudget:assertCumulativeBudget(plan,directory),auditorHash:plan.auditorHash,claims:{oldFailuresPassed:false,twoRemainingTasksOnly:true,originalLogPhaseRequestCapReset:false,universalStabilityProved:false,monetaryCostMeasured:false}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const a=process.argv.slice(2).find(v=>v.startsWith('--out='));if(!a)throw Error('--out required');const directory=resolve(a.slice(6)),r=auditLogProduction({directory});writeOnce(resolve(directory,'memory-log-postfix-independent-review-'+r.reviewedAt.replace(/[:.]/g,'-')+'.json'),r);console.log(JSON.stringify({status:r.status,passed:r.passed,roundAcceptance:r.roundAcceptance,failedChecks:r.checks.filter(c=>!c.passed).map(c=>c.name)}));if(!r.passed)process.exitCode=2;}catch(e){console.error(e.message);process.exitCode=1;}}
