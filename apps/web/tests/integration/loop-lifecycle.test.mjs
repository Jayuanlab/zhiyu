import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {spawn} from 'node:child_process';
vi.mock('server-only',()=>({}));
const native=vi.hoisted(()=>vi.fn());
const capturedLoop=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/harness-evolution/capture-service',()=>({captureCompletedLoopRunEvidence:capturedLoop,prepareRunHarnessCaptureContext:async()=>null}));
const httpOwner=vi.hoisted(()=>({id:''}));
vi.mock('@/app/(auth)/auth',()=>({auth:async()=>({user:{id:httpOwner.id}})}));
vi.mock('@/lib/loops/native-executor',()=>({executeNativeLoopAgent:native}));
vi.mock('@/lib/ai/user-llm-api-settings',()=>({getUserLlmProviderConfig:async()=>null}));
import {runLoop,runNativeLoopOnce,findLoopForScheduledJob,getOrCreateLoopForScheduledJob,runScheduledJobLoop} from '@/lib/loops/runtime';
import {resolveLoopApprovalCommand,resumeLoopApprovalCommand,replayLoopApprovalCommand} from '@/lib/loops/approval-command';
import {buildLoopApprovalReplayConfirmationToken} from '@/lib/loops/approval-replay';
import {PATCH as patchApproval} from '@/app/(chat)/api/loops/approvals/[id]/route';
import {assertLegacyJobExecutionAllowed} from '@/lib/cron/legacy-job-guard';
import {getJob,getDueJobs,recoverStuckJobs,cleanupStuckJobs,startJobExecution,completeJobExecution} from '@/lib/cron/service';
import {executeJob,registerCustomHandler,customJobHandlers} from '@/lib/cron/executor';
import {reviewLegacyExecution} from '@/lib/work-runtime/legacy-execution-review';
import {POST as postLegacyReview} from '@/app/(chat)/api/loops/[id]/legacy-executions/[executionId]/review/route';
import {runWorkshopLoopOnce,executeWorkshopLoopCommand} from '@/lib/workshops/loop-runtime';
import {closePostgresDb} from '@/lib/db/adapters/postgres';
import {resolveExecutionLease,withExecutionContext} from '@/lib/work-runtime/execution-context';
import {completeLoopRun,upsertLoopState,createLoopRun,updateLoop,createLoopApprovalRequest} from '@/lib/loops/service';
import {previewStandaloneLoopMigration,migrateStandaloneLoopToWork} from '@/lib/work-runtime/loop-migration';
import {markExecutionEffect,finishWorkshopExecution,claimWorkshopExecution,renewExecutionLease} from '@/lib/work-runtime/execution-lease';
import {enqueueWorkLoop,runWorkLoop} from '@/lib/work-runtime/commands';
import {cancelWorkRun} from '@/lib/work-runtime/cancel-run';
import {consumeOwnedLoopRuns} from '@/lib/work-runtime/loop-consumer';
import {POST as postLoopExecution} from '@/app/api/workshops/[id]/loops/[loopId]/execute/route';
import {NextRequest} from 'next/server';
import {dispatchScheduledWorkLoop} from '@/lib/work-runtime/loop-schedule';
import {runDueNativeLoops,listDueNativeLoops} from '@/lib/loops/native-scheduler';
import {getEffectiveNextLoopRun} from '@/lib/loops/schedule';
import {getWorkRunReview,resolveWorkRun} from '@/lib/work-runtime/run-resolution';
import {GET as getRunReview,POST as postRunReview} from '@/app/api/workshops/[id]/runs/[runId]/review/route';
import {GET as getRunReviews} from '@/app/api/workshops/[id]/runs/review/route';
import {POST as postGenericLoopExecution} from '@/app/(chat)/api/loops/[id]/execute/route';
import {GET as getLoopMigration,POST as postLoopMigration} from '@/app/(chat)/api/loops/[id]/migration/route';
let client;
beforeAll(()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('External transport forbidden in isolated Loop tests');}));
  process.env.REPORT_QUALITY_EVALUATOR_ENABLED='false';
  const url=new URL(process.env.ZHIYU_TEST_DATABASE_URL??'');
  if(!['localhost','127.0.0.1'].includes(url.hostname)||!/^\/zhiyu_test_[a-f0-9]{32}$/.test(url.pathname))throw Error('Random isolated PostgreSQL required');
  client=postgres(url.toString(),{max:2});
});
afterAll(async()=>{vi.unstubAllGlobals();await closePostgresDb();await client?.end();});
async function fixture(){
  const userId=randomUUID(),workId=randomUUID(),loopId=randomUUID(),commandId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},${`${userId}@example.invalid`})`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'loop owner','test')`;
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,verification_config) VALUES (${loopId},${userId},${workId},'recovery loop','observe','{"modelChecker":{"enabled":false}}'::jsonb)`;
  return {userId,workId,loopId,commandId,triggeredBy:'manual',modelChecker:null};
}
const suggestedResult=()=>({status:'success',error:undefined,output:'fixture observation',duration:1,result:{structuredReport:{summary:'fixture',suggestedActions:[{type:'send_message',label:'draft only',requiresConfirmation:true,params:{recipientName:'isolated-recipient',message:'fixture draft'}}]}}});
it('the generic trigger rejects unleased Work and standalone callers without creating a Run',async()=>{
  const owned=await fixture(),legacy=await standalone();
  for(const f of [owned,legacy]){
    await expect(runLoop(f.loopId,{userId:f.userId,triggeredBy:'api'})).rejects.toMatchObject({code:'invalid_lease'});
    expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(0);
  }
});
it('the generic trigger reuses an accepted leased Run and never rewrites its request or later observations',async()=>{
  const f=await fixture(),accepted=await enqueueWorkLoop(queueInput(f));
  const claim=await claimWorkshopExecution({userId:f.userId,workshopId:f.workId,runId:accepted.runId,workerId:'generic-trigger',leaseMs:60000});
  const [original]=await client`SELECT request_json FROM workshop_loop_executions WHERE run_id=${accepted.runId}`;
  await withExecutionContext(claim.lease,async()=>{
    expect((await runLoop(f.loopId,{userId:f.userId,triggeredBy:'api',inputSnapshot:{untrusted:'replacement'}})).loopRunId).toBe(accepted.runId);
    await upsertLoopState(f.loopId,{lastObservation:'new observation after trigger'});
    await runLoop(f.loopId,{userId:f.userId,triggeredBy:'manual'});
    await expect(runLoop(f.loopId,{userId:randomUUID(),triggeredBy:'api'})).rejects.toMatchObject({code:'invalid_lease'});
    await expect(runLoop(f.loopId,{userId:f.userId,triggeredBy:'api',executionId:randomUUID()})).rejects.toMatchObject({code:'invalid_lease'});
    await completeLoopRun(accepted.runId,{status:'success',outputSummary:'completed result'});
    await expect(runLoop(f.loopId,{userId:f.userId,triggeredBy:'api'})).rejects.toMatchObject({code:'result_conflict'});
  });
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(1);
  expect((await client`SELECT request_json FROM workshop_loop_executions WHERE run_id=${accepted.runId}`)[0]).toEqual(original);
  expect((await client`SELECT last_observation FROM loop_states WHERE loop_id=${f.loopId}`)[0].last_observation).toBe('new observation after trigger');
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${accepted.runId} AND type='loop_trigger_started'`)[0].n).toBe(1);
  await cancelWorkRun({userId:f.userId,workId:f.workId,runId:accepted.runId,commandId:randomUUID()});
  await expect(withExecutionContext(claim.lease,()=>runLoop(f.loopId,{userId:f.userId,triggeredBy:'api'}))).rejects.toBeTruthy();
});
it('a generic trigger event failure rolls back the Run transition and Loop observation together',async()=>{
  const f=await fixture(),accepted=await enqueueWorkLoop(queueInput(f));
  const claim=await claimWorkshopExecution({userId:f.userId,workshopId:f.workId,runId:accepted.runId,workerId:'trigger-rollback',leaseMs:60000});
  const before=await client`SELECT current_phase,state_json,last_observation FROM loop_states WHERE loop_id=${f.loopId}`;
  await client`CREATE FUNCTION reject_generic_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='loop_trigger_started' THEN RAISE EXCEPTION 'generic trigger fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_generic_trigger BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_generic_trigger()`;
  try{
    const failure=await withExecutionContext(claim.lease,()=>runLoop(f.loopId,{userId:f.userId,triggeredBy:'api'})).catch(error=>error);
    expect(String(failure?.cause?.message??failure?.message)).toContain('generic trigger fault');
  }finally{await client`DROP TRIGGER reject_generic_trigger ON workshop_events`;await client`DROP FUNCTION reject_generic_trigger()`;}
  expect((await client`SELECT status FROM loop_runs WHERE id=${accepted.runId}`)[0].status).toBe('queued');
  expect(await client`SELECT current_phase,state_json,last_observation FROM loop_states WHERE loop_id=${f.loopId}`).toEqual(before);
  await withExecutionContext(claim.lease,()=>runLoop(f.loopId,{userId:f.userId,triggeredBy:'api'}));
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${accepted.runId} AND type='loop_trigger_started'`)[0].n).toBe(1);
});
async function standalone(){
  const f=await fixture();
  await client`UPDATE loops SET workshop_id=NULL WHERE id=${f.loopId}`;
  await upsertLoopState(f.loopId,{memorySummary:'preserved observation',stateJson:{nextRunAt:'2030-01-01T00:00:00Z'}});
  return f;
}
async function approvalFixture(legacy=false,actionName='recordLoopAudit'){
  const f=await (legacy?standalone():fixture()),runId=randomUUID();
  await client`INSERT INTO loop_runs(id,loop_id,status) VALUES (${runId},${f.loopId},'blocked')`;
  const approval=await createLoopApprovalRequest({userId:f.userId,loopId:f.loopId,loopRunId:runId,actionName,capability:actionName==='recordLoopAudit'?'write_internal':'write_external',toolInput:{body:'isolated draft'},actionPayload:{toolUseID:'fixture-tool',sourceFact:'keep'}});
  await upsertLoopState(f.loopId,{currentPhase:'blocked',blockedReason:'unrelated runtime failure',lastObservation:'original observation',stateJson:{marker:'keep'}});
  return {...f,runId,approvalRequestId:approval.id};
}
it.each([false,true])('approval resolve, consume and pure replay are atomic, idempotent and do not create executions (legacy=%s)',async legacy=>{
  const f=await approvalFixture(legacy),target={userId:f.userId,approvalRequestId:f.approvalRequestId};
  const [a,b]=await Promise.all([resolveLoopApprovalCommand({...target,status:'approved'}),resolveLoopApprovalCommand({...target,status:'approved'})]);
  expect(a).toEqual(b);
  await expect(resolveLoopApprovalCommand({...target,status:'rejected'})).rejects.toMatchObject({code:'payload_conflict'});
  const [c,d]=await Promise.all([resumeLoopApprovalCommand(target),resumeLoopApprovalCommand(target)]);expect(c).toEqual(d);
  const [e,g]=await Promise.all([replayLoopApprovalCommand(target),replayLoopApprovalCommand(target)]);expect(e).toEqual(g);
  expect(e.loopRunId).toBe(f.runId);expect(e.replayResult.status).toBe('success');
  const [state]=await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`;
  expect(state).toMatchObject({current_phase:'blocked',blocked_reason:'unrelated runtime failure',last_observation:'original observation'});
  expect(state.state_json.marker).toBe('keep');expect(state.state_json.consumedApprovalContinuations).toHaveLength(1);expect(state.state_json.approvalReplayHistory).toHaveLength(1);
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(1);
  const [approval]=await client`SELECT action_payload FROM loop_approval_requests WHERE id=${f.approvalRequestId}`;
  expect(approval.action_payload.controlEvents).toHaveLength(3);
  expect(Object.keys(approval.action_payload.controlReceipts)).toHaveLength(3);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE loop_id=${f.loopId} AND type IN ('approval_resolve','approval_resume','approval_replay')`)[0].n).toBe(legacy?0:3);
});
it('approval event failure rolls back request and state; exact retry can finish',async()=>{
  const f=await approvalFixture(),input={userId:f.userId,approvalRequestId:f.approvalRequestId,status:'approved'};
  const before=await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`;
  await client`CREATE FUNCTION reject_approval_control() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='approval_resolve' THEN RAISE EXCEPTION 'approval event fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_approval_control BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_approval_control()`;
  try{await expect(resolveLoopApprovalCommand(input)).rejects.toBeTruthy();}
  finally{await client`DROP TRIGGER reject_approval_control ON workshop_events`;await client`DROP FUNCTION reject_approval_control()`;}
  expect((await client`SELECT status FROM loop_approval_requests WHERE id=${f.approvalRequestId}`)[0].status).toBe('pending');
  expect(await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`).toEqual(before);
  expect((await resolveLoopApprovalCommand(input)).approvalRequest.status).toBe('approved');
});
it('invalid early replay and missing confirmation cannot poison a later valid draft command',async()=>{
  const f=await approvalFixture(false,'draftExternalReply'),target={userId:f.userId,approvalRequestId:f.approvalRequestId};
  await expect(resumeLoopApprovalCommand(target)).rejects.toMatchObject({code:'invalid_command'});
  await resolveLoopApprovalCommand({...target,status:'approved'});
  await expect(replayLoopApprovalCommand(target)).rejects.toMatchObject({code:'invalid_command'});
  const consumed=await resumeLoopApprovalCommand(target);
  await expect(replayLoopApprovalCommand(target)).rejects.toMatchObject({code:'invalid_command'});
  const replay=await replayLoopApprovalCommand({...target,confirmationToken:buildLoopApprovalReplayConfirmationToken(consumed.continuation)});
  expect(replay.replayResult.adapterResult).toMatchObject({sent:false,requiresFinalSendAdapter:true});
  await expect(replayLoopApprovalCommand({...target,adapters:[{execute:()=>{throw Error('must not run');}}]})).rejects.toMatchObject({code:'invalid_command'});
});
it('approval HTTP rejects a forged payload or actor, scopes owner, and replays the accepted decision',async()=>{
  const f=await approvalFixture(),target={params:Promise.resolve({id:f.approvalRequestId})};httpOwner.id=f.userId;
  const request=body=>new NextRequest(`http://127.0.0.1/api/loops/approvals/${f.approvalRequestId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  expect((await patchApproval(request({status:'approved',actionPayload:{continuation:{actionName:'forged'}}}),target)).status).toBe(400);
  const wrong=request({status:'approved'});wrong.headers.set('X-Work-Actor',randomUUID());expect((await patchApproval(wrong,target)).status).toBe(409);
  httpOwner.id=(await fixture()).userId;expect((await patchApproval(request({status:'approved'}),target)).status).toBe(404);
  httpOwner.id=f.userId;
  const first=await patchApproval(request({status:'approved'}),target);expect(first.status).toBe(200);
  expect(await (await patchApproval(request({status:'approved'}),target)).json()).toEqual(await first.json());
});
it('legacy approval receipt failure rolls back consumption and allows exact retry',async()=>{
  const f=await approvalFixture(true),target={userId:f.userId,approvalRequestId:f.approvalRequestId};
  await resolveLoopApprovalCommand({...target,status:'approved'});
  const before=await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`;
  await client`CREATE FUNCTION reject_legacy_approval_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action_payload->'controlReceipts'->'resume' IS NOT NULL THEN RAISE EXCEPTION 'receipt fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_legacy_approval_receipt BEFORE UPDATE ON loop_approval_requests FOR EACH ROW EXECUTE FUNCTION reject_legacy_approval_receipt()`;
  try{await expect(resumeLoopApprovalCommand(target)).rejects.toBeTruthy();}
  finally{await client`DROP TRIGGER reject_legacy_approval_receipt ON loop_approval_requests`;await client`DROP FUNCTION reject_legacy_approval_receipt()`;}
  expect(await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`).toEqual(before);
  expect((await client`SELECT action_payload->'continuation'->>'status' AS status FROM loop_approval_requests WHERE id=${f.approvalRequestId}`)[0].status).toBe('ready');
  expect((await resumeLoopApprovalCommand(target)).continuation.status).toBe('consumed');
});
it('standalone native execution is rejected before any executor or state mutation',async()=>{
  const f=await standalone(),execute=vi.fn();
  const before=await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`;
  for(const executor of [undefined,execute]){
    await expect(runNativeLoopOnce({...f,execute:executor})).rejects.toMatchObject({code:'loop_migration_required'});
  }
  expect(execute).not.toHaveBeenCalled();
  expect(await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`).toEqual(before);
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(0);
});
it('standalone generic HTTP execution returns a migration conflict for native and dry runs',async()=>{
  const f=await standalone();httpOwner.id=f.userId;native.mockClear();
  for(const dryRun of [true,false]){
    const request=new NextRequest(`http://127.0.0.1/api/loops/${f.loopId}/execute`,{method:'POST',headers:{'Content-Type':'application/json','X-Work-Actor':f.userId},body:JSON.stringify({commandId:randomUUID(),expectedVersion:0,dryRun})});
    const response=await postGenericLoopExecution(request,{params:Promise.resolve({id:f.loopId})});
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'loop_migration_required'});
  }
  expect(native).not.toHaveBeenCalled();
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(0);
});
it('standalone scheduled observations never advance due, missed, holiday or future cursors',async()=>{
  for(const [trigger,slot] of [
    [{type:'once',at:'2026-10-01T01:10:00Z'},'2026-10-01T01:10:00Z'],
    [{type:'cron',expression:'0 9 * * *',timezone:'Asia/Shanghai'},'2026-09-01T01:00:00Z'],
    [{type:'cron',expression:'10 9 * * 1-5',timezone:'Asia/Shanghai',tradingCalendar:'a-share'},'2026-10-01T01:10:00Z'],
    [{type:'once',at:'2030-01-01T00:00:00Z'},'2030-01-01T00:00:00Z'],
  ]){
    const f=await standalone();
    await client`UPDATE loops SET trigger_config=${client.json(trigger)} WHERE id=${f.loopId}`;
    await upsertLoopState(f.loopId,{stateJson:{nextScheduledRunAt:slot},lastObservation:'keep'});
    const before=await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`;
    const now=new Date('2026-10-01T01:11:00Z'),isDue=new Date(slot)<=now;
    expect(await listDueNativeLoops({userId:f.userId,now})).toHaveLength(isDue?1:0);
    const result=await runDueNativeLoops({userId:f.userId,now,awaitCompletion:true});
    expect(result.launched).toBe(0);expect(result.skipped).toBe(isDue?1:0);
    if(isDue)expect(result.errors).toMatchObject([{code:'loop_migration_required'}]);
    expect(await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`).toEqual(before);
    expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(0);
  }
});
async function migrationCommand(f){return {userId:f.userId,loopId:f.loopId,commandId:randomUUID(),expectedVersion:0,expectedSnapshotHash:(await previewStandaloneLoopMigration(f)).snapshotHash,controllersStopped:true};}
async function legacyFixture(){
  const f=await standalone(),jobId=randomUUID();
  const job={id:jobId,userId:f.userId,name:'legacy fixture',description:'old task instructions',enabled:true,scheduleType:'interval',intervalMinutes:10,timezone:'Asia/Shanghai'};
  await client`INSERT INTO scheduled_jobs(id,user_id,name,description,schedule_type,interval_minutes,job_config,next_run_at) VALUES (${jobId},${f.userId},${job.name},${job.description},'interval',10,'{"type":"custom","handler":"legacy_callback","modelConfig":{"apiKey":"isolated-secret-do-not-preview"}}'::jsonb,'2030-01-01')`;
  await client`UPDATE loops SET trigger_config=${client.json({type:'scheduled_job',scheduledJobId:jobId})} WHERE id=${f.loopId}`;
  expect((await client`SELECT jsonb_typeof(trigger_config) AS kind FROM loops WHERE id=${f.loopId}`)[0].kind).toBe('object');
  return {...f,jobId,job};
}
async function staleLegacyFixture(){
  const f=await legacyFixture(),executionId=randomUUID();
  await client`INSERT INTO job_executions(id,job_id,status,started_at,error,result,output) VALUES (${executionId},${f.jobId},'running',clock_timestamp()-interval '10 days','original diagnostic','{"originalFact":"keep"}'::jsonb,'original output')`;
  await client`UPDATE scheduled_jobs SET last_status='running',last_run_at=clock_timestamp()-interval '10 days',next_run_at=clock_timestamp()-interval '1 day' WHERE id=${f.jobId}`;
  return {...f,executionId};
}
it('legacy reads never repair or advance job state',async()=>{
  const f=await staleLegacyFixture();
  const before=await client`SELECT * FROM scheduled_jobs WHERE id=${f.jobId}`;
  expect((await getJob(f.userId,f.jobId)).lastStatus).toBe('running');
  expect(await getDueJobs(new Date(),f.userId)).toHaveLength(0);
  expect(await client`SELECT * FROM scheduled_jobs WHERE id=${f.jobId}`).toEqual(before);
});
it('legacy timeout quarantine is owner-scoped, concurrent-safe, preserves history and never creates a retry',async()=>{
  const f=await staleLegacyFixture(),other=await staleLegacyFixture();
  const originalJob=(await client`SELECT * FROM scheduled_jobs WHERE id=${f.jobId}`)[0];
  expect(await recoverStuckJobs()).toBe(0);expect(await cleanupStuckJobs()).toBe(0);
  const results=await Promise.all([recoverStuckJobs(f.userId),cleanupStuckJobs(f.userId)]);
  expect(results.reduce((a,b)=>a+b,0)).toBe(1);expect(await recoverStuckJobs(f.userId)).toBe(0);
  const rows=await client`SELECT * FROM job_executions WHERE job_id=${f.jobId}`;expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({id:f.executionId,status:'needs_review',completed_at:null,output:'original output',result:{originalFact:'keep',recoveryObservation:{ownerId:f.userId,fromStatus:'running',toStatus:'needs_review'}}});
  expect(rows[0].error).toContain('original diagnostic');
  const [job]=await client`SELECT * FROM scheduled_jobs WHERE id=${f.jobId}`;
  expect(job.next_run_at).toEqual(originalJob.next_run_at);expect(job.run_count).toBe(originalJob.run_count);
  expect((await client`SELECT status FROM job_executions WHERE id=${other.executionId}`)[0].status).toBe('running');
  expect(await getDueJobs(new Date(),f.userId)).toHaveLength(0);
  await expect(assertLegacyJobExecutionAllowed({userId:f.userId,jobId:f.jobId,executionId:f.executionId})).rejects.toMatchObject({code:'invalid_lease'});
});
it('legacy quarantine job-write failure rolls back execution observation and status',async()=>{
  const f=await staleLegacyFixture(),before=await client`SELECT * FROM job_executions WHERE id=${f.executionId}`;
  await client`CREATE FUNCTION reject_legacy_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.last_status='needs_review' THEN RAISE EXCEPTION 'quarantine fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_legacy_quarantine BEFORE UPDATE ON scheduled_jobs FOR EACH ROW EXECUTE FUNCTION reject_legacy_quarantine()`;
  try{await expect(recoverStuckJobs(f.userId)).rejects.toBeTruthy();}
  finally{await client`DROP TRIGGER reject_legacy_quarantine ON scheduled_jobs`;await client`DROP FUNCTION reject_legacy_quarantine()`;}
  expect(await client`SELECT * FROM job_executions WHERE id=${f.executionId}`).toEqual(before);
  expect(await recoverStuckJobs(f.userId)).toBe(1);
});
const nativeReplacement={goal:'Owner reviewed native task instructions',triggerConfig:{type:'interval',minutes:15},confirmLegacyReplacement:true};
async function legacyReviewFixture(){
  const f=await staleLegacyFixture();await recoverStuckJobs(f.userId);
  const preview=await previewStandaloneLoopMigration(f);
  const command={userId:f.userId,loopId:f.loopId,executionId:f.executionId,commandId:randomUUID(),expectedSnapshotHash:preview.source.legacyJob.executions[0].snapshotHash,controllersStopped:true,outcome:'no_effect',evidence:'Verified original executor stopped and checked recipient history'};
  return {...f,command};
}
it('owner legacy review is idempotent, preserves execution facts and permits only paused migration',async()=>{
  const f=await legacyReviewFixture(),before=await client`SELECT * FROM job_executions WHERE id=${f.executionId}`;
  expect((await previewStandaloneLoopMigration(f)).blockers).toContain('legacy_execution_unfinished');
  const receipts=await Promise.all([reviewLegacyExecution(f.command),reviewLegacyExecution(f.command)]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect(await client`SELECT * FROM job_executions WHERE id=${f.executionId}`).toEqual(before);
  expect((await client`SELECT count(*)::int AS n FROM legacy_execution_reviews WHERE execution_id=${f.executionId}`)[0].n).toBe(1);
  expect((await getJob(f.userId,f.jobId)).enabled).toBe(false);
  expect((await client`SELECT status FROM loops WHERE id=${f.loopId}`)[0].status).toBe('paused');
  const preview=await previewStandaloneLoopMigration(f);expect(preview.blockers).toEqual(['legacy_scheduled_job']);
  const migrated=await migrateStandaloneLoopToWork({...await migrationCommand(f),nativeReplacement});
  expect(migrated.status).toBe('paused');expect(await reviewLegacyExecution(f.command)).toEqual(receipts[0]);
  expect(await client`SELECT * FROM job_executions WHERE id=${f.executionId}`).toEqual(before);
});
it('legacy review rejects another owner, changed intent, missing attestation and unquarantined runs',async()=>{
  const f=await legacyReviewFixture(),other=await fixture(),running=await staleLegacyFixture();
  await expect(reviewLegacyExecution({...f.command,userId:other.userId})).rejects.toMatchObject({code:'not_found'});
  await expect(reviewLegacyExecution({...f.command,controllersStopped:false})).rejects.toMatchObject({code:'invalid_command'});
  const p=await previewStandaloneLoopMigration(running);
  await expect(reviewLegacyExecution({...f.command,...running,executionId:running.executionId,expectedSnapshotHash:p.source.legacyJob.executions[0].snapshotHash})).rejects.toMatchObject({code:'target_busy'});
  await reviewLegacyExecution(f.command);
  await expect(reviewLegacyExecution({...f.command,evidence:'different attestation'})).rejects.toMatchObject({code:'payload_conflict'});
});
it('changed legacy observations invalidate review and require a fresh recorded owner decision',async()=>{
  const f=await legacyReviewFixture();
  await client`UPDATE job_executions SET output='late observation' WHERE id=${f.executionId}`;
  await expect(reviewLegacyExecution(f.command)).rejects.toMatchObject({code:'version_conflict'});
  let preview=await previewStandaloneLoopMigration(f);
  await reviewLegacyExecution({...f.command,expectedSnapshotHash:preview.source.legacyJob.executions[0].snapshotHash});
  await client`UPDATE job_executions SET output='additional observation' WHERE id=${f.executionId}`;
  preview=await previewStandaloneLoopMigration(f);expect(preview.blockers).toContain('legacy_execution_unfinished');
  await reviewLegacyExecution({...f.command,commandId:randomUUID(),expectedSnapshotHash:preview.source.legacyJob.executions[0].snapshotHash,evidence:'Checked additional observation'});
  expect((await client`SELECT count(*)::int AS n FROM legacy_execution_reviews WHERE execution_id=${f.executionId}`)[0].n).toBe(2);
});
it('legacy review and job disable roll back together on a database failure',async()=>{
  const f=await legacyReviewFixture();
  await client`CREATE FUNCTION reject_review_disable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT NEW.enabled THEN RAISE EXCEPTION 'review fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_review_disable BEFORE UPDATE ON scheduled_jobs FOR EACH ROW EXECUTE FUNCTION reject_review_disable()`;
  try{await expect(reviewLegacyExecution(f.command)).rejects.toBeTruthy();}
  finally{await client`DROP TRIGGER reject_review_disable ON scheduled_jobs`;await client`DROP FUNCTION reject_review_disable()`;}
  expect((await client`SELECT count(*)::int AS n FROM legacy_execution_reviews WHERE execution_id=${f.executionId}`)[0].n).toBe(0);
  expect((await getJob(f.userId,f.jobId)).enabled).toBe(true);
});
it('legacy review HTTP uses the authenticated owner and rejects actor changes',async()=>{
  const f=await legacyReviewFixture();httpOwner.id=f.userId;
  const context={params:Promise.resolve({id:f.loopId,executionId:f.executionId})},url=`http://localhost/api/loops/${f.loopId}/legacy-executions/${f.executionId}/review`;
  const request=actor=>new NextRequest(url,{method:'POST',headers:{'Content-Type':'application/json','X-Work-Actor':actor},body:JSON.stringify({...f.command,userId:randomUUID(),expectedVersion:0})});
  expect((await postLegacyReview(request(randomUUID()),context)).status).toBe(409);
  const result=await postLegacyReview(request(f.userId),context);expect(result.status).toBe(200);
  expect((await result.json()).executionId).toBe(f.executionId);
  expect((await client`SELECT owner_id,source FROM legacy_execution_reviews WHERE execution_id=${f.executionId}`)[0]).toEqual({owner_id:f.userId,source:'owner'});
});
it('reviewing legacy evidence never reopens an archived Loop',async()=>{
  const f=await legacyReviewFixture();
  await client`UPDATE loops SET status='archived' WHERE id=${f.loopId}`;
  await reviewLegacyExecution(f.command);
  expect((await client`SELECT status FROM loops WHERE id=${f.loopId}`)[0].status).toBe('archived');
  expect((await previewStandaloneLoopMigration(f)).blockers).toContain('unsupported_status');
});
it('legacy conversion requires a reviewed native replacement and retires the old job without losing history',async()=>{
  const f=await legacyFixture(),oldRun=randomUUID();
  await client`INSERT INTO job_executions(id,job_id,status,output) VALUES (${oldRun},${f.jobId},'success','historic observation')`;
  const preview=await previewStandaloneLoopMigration(f);expect(preview.blockers).toEqual(['legacy_scheduled_job']);
  expect(JSON.stringify(preview)).not.toContain('isolated-secret-do-not-preview');expect(preview.source.legacyJob.hasModelOverrides).toBe(true);
  const command={...await migrationCommand(f),nativeReplacement};const adopted=await migrateStandaloneLoopToWork(command);expect(await migrateStandaloneLoopToWork(command)).toEqual(adopted);
  expect((await client`SELECT enabled,next_run_at FROM scheduled_jobs WHERE id=${f.jobId}`)[0]).toEqual({enabled:false,next_run_at:null});
  expect((await client`SELECT status,goal,trigger_config FROM loops WHERE id=${f.loopId}`)[0]).toMatchObject({status:'paused',goal:nativeReplacement.goal,trigger_config:nativeReplacement.triggerConfig});
  expect((await client`SELECT output FROM job_executions WHERE id=${oldRun}`)[0].output).toBe('historic observation');
  expect((await client`SELECT legacy_job_id FROM loop_runtime_migrations WHERE loop_id=${f.loopId}`)[0].legacy_job_id).toBe(f.jobId);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${adopted.workId} AND type='legacy_job_retired'`)[0].n).toBe(1);
});
it('legacy conversion rejects changed private config, unfinished execution and ambiguous source bindings',async()=>{
  const f=await legacyFixture(),command={...await migrationCommand(f),nativeReplacement};
  await client`UPDATE scheduled_jobs SET job_config='{"modelConfig":{"apiKey":"changed-secret"}}'::jsonb WHERE id=${f.jobId}`;
  await expect(migrateStandaloneLoopToWork(command)).rejects.toMatchObject({code:'version_conflict'});
  const running=randomUUID();await client`INSERT INTO job_executions(id,job_id,status) VALUES (${running},${f.jobId},'running')`;
  expect((await previewStandaloneLoopMigration(f)).blockers).toContain('legacy_execution_unfinished');
  await expect(migrateStandaloneLoopToWork({...await migrationCommand(f),nativeReplacement})).rejects.toMatchObject({code:'target_busy'});
  await client`UPDATE job_executions SET status='success' WHERE id=${running}`;
  await client`INSERT INTO loops(user_id,name,goal,trigger_config) VALUES (${f.userId},'duplicate','observe',${client.json({type:'scheduled_job',scheduledJobId:f.jobId})})`;
  expect((await previewStandaloneLoopMigration(f)).blockers).toContain('legacy_source_ambiguous');
  await expect(findLoopForScheduledJob(f.userId,f.jobId)).rejects.toThrow('multiple Loop bindings');
});
it('retired jobs cannot restart through old aliases, execution admission or enabling writes',async()=>{
  const f=await legacyFixture(),historical=randomUUID();
  await client`INSERT INTO job_executions(id,job_id,status) VALUES (${historical},${f.jobId},'success')`;
  await migrateStandaloneLoopToWork({...await migrationCommand(f),nativeReplacement});
  expect((await findLoopForScheduledJob(f.userId,f.jobId)).id).toBe(f.loopId);
  expect((await getOrCreateLoopForScheduledJob(f.job)).id).toBe(f.loopId);
  await expect(client`UPDATE scheduled_jobs SET enabled=true WHERE id=${f.jobId}`).rejects.toMatchObject({code:'23514'});
  await expect(client`UPDATE scheduled_jobs SET description='stale writer' WHERE id=${f.jobId}`).rejects.toMatchObject({code:'23514'});
  await expect(client`UPDATE job_executions SET output='stale writer' WHERE id=${historical}`).rejects.toMatchObject({code:'23514'});
  await expect(client`INSERT INTO job_executions(job_id,status) VALUES (${f.jobId},'running')`).rejects.toMatchObject({code:'23514'});
  await expect(assertLegacyJobExecutionAllowed({userId:f.userId,jobId:f.jobId,executionId:randomUUID()})).rejects.toMatchObject({code:'invalid_lease'});
  const execute=vi.fn();await expect(runScheduledJobLoop({job:f.job,context:{userId:f.userId,jobId:f.jobId,executionId:randomUUID(),triggeredBy:'manual'},execute})).rejects.toMatchObject({code:'loop_migration_required'});expect(execute).not.toHaveBeenCalled();
});
it('retired execution exports never call handlers or mutate an unmigrated legacy execution',async()=>{
  const f=await staleLegacyFixture(),context={userId:f.userId,jobId:f.jobId,executionId:f.executionId,triggeredBy:'manual'},execute=vi.fn();
  const before={jobs:await client`SELECT * FROM scheduled_jobs WHERE id=${f.jobId}`,executions:await client`SELECT * FROM job_executions WHERE job_id=${f.jobId}`,loops:await client`SELECT * FROM loops WHERE id=${f.loopId}`};
  for(const operation of [()=>executeJob(context,'{"type":"custom"}'),()=>startJobExecution(context),()=>completeJobExecution(context,{status:'success',output:'late result',duration:1}),()=>runScheduledJobLoop({job:f.job,context,execute})])await expect(operation()).rejects.toMatchObject({code:'loop_migration_required'});
  expect(()=>registerCustomHandler('old handler',execute)).toThrowError(/迁入车间/);
  expect(Object.keys(customJobHandlers)).toHaveLength(0);expect(execute).not.toHaveBeenCalled();
  expect({jobs:await client`SELECT * FROM scheduled_jobs WHERE id=${f.jobId}`,executions:await client`SELECT * FROM job_executions WHERE job_id=${f.jobId}`,loops:await client`SELECT * FROM loops WHERE id=${f.loopId}`}).toEqual(before);
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(0);
});
it('legacy aliases are exact beyond the old list cap and concurrent creation makes one mirror',async()=>{
  const f=await legacyFixture();
  await client`INSERT INTO loops(user_id,name,goal) SELECT ${f.userId}::uuid,'noise','ignore' FROM generate_series(1,1001)`;
  expect((await findLoopForScheduledJob(f.userId,f.jobId)).id).toBe(f.loopId);
  const jobId=randomUUID();await client`INSERT INTO scheduled_jobs(id,user_id,name) VALUES (${jobId},${f.userId},'new legacy')`;
  const [a,b]=await Promise.all([getOrCreateLoopForScheduledJob({...f.job,id:jobId}),getOrCreateLoopForScheduledJob({...f.job,id:jobId})]);expect(a.id).toBe(b.id);expect(a.name).toBe('new legacy');
});
it('legacy conversion rolls back retirement and can retry after an event failure',async()=>{
  const f=await legacyFixture(),command={...await migrationCommand(f),nativeReplacement};
  await client`CREATE FUNCTION reject_legacy_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='legacy_job_retired' THEN RAISE EXCEPTION 'retirement fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_legacy_retirement BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_legacy_retirement()`;
  try{await expect(migrateStandaloneLoopToWork(command)).rejects.toBeTruthy();}finally{await client`DROP TRIGGER reject_legacy_retirement ON workshop_events`;await client`DROP FUNCTION reject_legacy_retirement()`;}
  expect((await client`SELECT enabled FROM scheduled_jobs WHERE id=${f.jobId}`)[0].enabled).toBe(true);
  expect((await client`SELECT workshop_id,trigger_config FROM loops WHERE id=${f.loopId}`)[0]).toMatchObject({workshop_id:null,trigger_config:{type:'scheduled_job'}});
  expect((await client`SELECT count(*)::int AS n FROM loop_runtime_migrations WHERE legacy_job_id=${f.jobId}`)[0].n).toBe(0);
  expect(await migrateStandaloneLoopToWork(command)).toMatchObject({status:'paused'});
});
it('native replacements reject missing confirmation, invalid cron/timezone and invalid one-shot dates',async()=>{
  const f=await legacyFixture(),command=await migrationCommand(f);
  for(const value of [{...nativeReplacement,confirmLegacyReplacement:false},{...nativeReplacement,goal:''},{...nativeReplacement,triggerConfig:{type:'cron',expression:'bad'}},{...nativeReplacement,triggerConfig:{type:'cron',expression:'* * * * *',timezone:'invalid/zone'}},{...nativeReplacement,triggerConfig:{type:'once',at:'bad'}}])await expect(migrateStandaloneLoopToWork({...command,nativeReplacement:value})).rejects.toMatchObject({code:'invalid_command'});
});
it('legacy executor admission requires its owned running execution and rejects completed or foreign rows',async()=>{
  const f=await legacyFixture(),executionId=randomUUID();
  await expect(assertLegacyJobExecutionAllowed({userId:f.userId,jobId:f.jobId,executionId})).rejects.toMatchObject({code:'invalid_lease'});
  await client`INSERT INTO job_executions(id,job_id,status) VALUES (${executionId},${f.jobId},'running')`;
  await expect(assertLegacyJobExecutionAllowed({userId:f.userId,jobId:f.jobId,executionId})).resolves.toBeUndefined();
  await expect(assertLegacyJobExecutionAllowed({userId:randomUUID(),jobId:f.jobId,executionId})).rejects.toMatchObject({code:'invalid_lease'});
  await client`UPDATE job_executions SET status='success' WHERE id=${executionId}`;
  await expect(assertLegacyJobExecutionAllowed({userId:f.userId,jobId:f.jobId,executionId})).rejects.toMatchObject({code:'invalid_lease'});
});
it('independent processes replay one legacy conversion and one retirement event',async()=>{
  const f=await legacyFixture(),command={...await migrationCommand(f),nativeReplacement};
  const [a,b]=await Promise.all([migrateInProcess(command),migrateInProcess(command)]);expect(a).toEqual(b);
  expect((await client`SELECT count(*)::int AS n FROM loop_runtime_migrations WHERE legacy_job_id=${f.jobId}`)[0].n).toBe(1);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${a.workId} AND type='legacy_job_retired'`)[0].n).toBe(1);
});
it('migration HTTP uses the session owner and replays the original preview command',async()=>{
  const f=await standalone();httpOwner.id=f.userId;
  const url=`http://127.0.0.1/api/loops/${f.loopId}/migration`,context={params:Promise.resolve({id:f.loopId})};
  const preview=await getLoopMigration(new NextRequest(url),context);expect(preview.status).toBe(200);
  const body={expectedVersion:0,expectedSnapshotHash:(await preview.json()).snapshotHash,controllersStopped:true,userId:randomUUID(),source:'workshop_agent'};
  const request=()=>new NextRequest(url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':f.commandId,'X-Work-Actor':f.userId},body:JSON.stringify(body)});
  const first=await postLoopMigration(request(),context);expect(first.status).toBe(200);const saved=await first.json();
  expect(await (await postLoopMigration(request(),context)).json()).toEqual(saved);
  expect((await client`SELECT owner_id FROM loop_runtime_migrations WHERE loop_id=${f.loopId}`)[0].owner_id).toBe(f.userId);
  expect((await getLoopMigration(new NextRequest(url),context)).status).toBe(200);
});
it('legacy conversion HTTP preserves the reviewed replacement on retry and clears the old description',async()=>{
  const f=await legacyFixture();httpOwner.id=f.userId;
  await client`UPDATE loops SET description='old summary' WHERE id=${f.loopId}`;
  const url=`http://127.0.0.1/api/loops/${f.loopId}/migration`,context={params:Promise.resolve({id:f.loopId})};
  const body={...await migrationCommand(f),nativeReplacement};
  const request=value=>new NextRequest(url,{method:'POST',headers:{'Content-Type':'application/json','X-Work-Actor':f.userId},body:JSON.stringify(value)});
  expect((await postLoopMigration(request({...body,nativeReplacement:{...nativeReplacement,confirmLegacyReplacement:false}}),context)).status).toBe(400);
  const first=await postLoopMigration(request(body),context);expect(first.status).toBe(200);expect(await (await postLoopMigration(request(body),context)).json()).toEqual(await first.json());
  expect((await client`SELECT goal,description FROM loops WHERE id=${f.loopId}`)[0]).toEqual({goal:nativeReplacement.goal,description:null});
  expect((await postLoopMigration(request({...body,nativeReplacement:{...nativeReplacement,goal:'changed intent'}}),context)).status).toBe(409);
});
it('migration HTTP rejects anonymous, foreign, changed-actor and invalid commands without writing',async()=>{
  const f=await standalone(),other=await fixture(),body=await migrationCommand(f);
  const url=`http://127.0.0.1/api/loops/${f.loopId}/migration`,context={params:Promise.resolve({id:f.loopId})};
  const request=(value=body,actor=httpOwner.id)=>new NextRequest(url,{method:'POST',headers:{'Content-Type':'application/json','X-Work-Actor':actor},body:JSON.stringify(value)});
  httpOwner.id='';expect((await getLoopMigration(new NextRequest(url),context)).status).toBe(401);expect((await postLoopMigration(request(),context)).status).toBe(401);
  httpOwner.id=other.userId;expect((await getLoopMigration(new NextRequest(url),context)).status).toBe(404);expect((await postLoopMigration(request(),context)).status).toBe(404);
  httpOwner.id=f.userId;expect((await postLoopMigration(request(body,other.userId),context)).status).toBe(409);
  for(const changed of [{...body,expectedVersion:1},{...body,controllersStopped:false},{...body,commandId:undefined},{...body,expectedSnapshotHash:'stale'}])expect((await postLoopMigration(request(changed),context)).status).toBe(400);
  expect((await client`SELECT count(*)::int AS n FROM loop_runtime_migrations WHERE loop_id=${f.loopId}`)[0].n).toBe(0);
});
it('standalone migration preserves identity and observations, creates one paused Work and replays the receipt',async()=>{
  const f=await standalone(),run=await createLoopRun({loopId:f.loopId,triggeredBy:'manual'});
  await completeLoopRun(run.id,{status:'success',outputSummary:'historic result'});
  const preview=await previewStandaloneLoopMigration(f),command=await migrationCommand(f);
  expect(preview.blockers).toEqual([]);expect(preview.proposed).toMatchObject({status:'paused',autonomyLevel:'draft'});
  const [a,b]=await Promise.all([migrateStandaloneLoopToWork(command),migrateStandaloneLoopToWork(command)]);expect(a).toEqual(b);
  expect((await client`SELECT workshop_id,status FROM loops WHERE id=${f.loopId}`)[0]).toMatchObject({workshop_id:a.workId,status:'paused'});
  expect((await client`SELECT status,autonomy_level FROM workshops WHERE id=${a.workId}`)[0]).toMatchObject({status:'paused',autonomy_level:'draft'});
  expect((await client`SELECT source_snapshot FROM loop_runtime_migrations WHERE loop_id=${f.loopId}`)[0].source_snapshot).toEqual(preview.source);
  expect((await client`SELECT output_summary FROM loop_runs WHERE id=${run.id}`)[0].output_summary).toBe('historic result');
  expect((await client`SELECT memory_summary FROM loop_states WHERE loop_id=${f.loopId}`)[0].memory_summary).toBe('preserved observation');
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${a.workId} AND type='loop_migrated'`)[0].n).toBe(1);
  await expect(migrateStandaloneLoopToWork({...command,commandId:randomUUID()})).rejects.toMatchObject({code:'target_busy'});
});
it('migration rejects stale snapshots, active runs, unresolved approval, foreign owners and agent callers',async()=>{
  const f=await standalone(),command=await migrationCommand(f);
  await upsertLoopState(f.loopId,{memorySummary:'new observation'});
  await expect(migrateStandaloneLoopToWork(command)).rejects.toMatchObject({code:'version_conflict'});
  await expect(migrateStandaloneLoopToWork({...command,source:'workshop_agent'})).rejects.toMatchObject({code:'invalid_command'});
  await expect(migrateStandaloneLoopToWork({...command,controllersStopped:false})).rejects.toMatchObject({code:'invalid_command'});
  await expect(migrateStandaloneLoopToWork({...command,commandId:undefined})).rejects.toMatchObject({code:'invalid_command'});
  await expect(previewStandaloneLoopMigration({...f,userId:randomUUID()})).rejects.toMatchObject({code:'not_found'});
  const run=await createLoopRun({loopId:f.loopId,triggeredBy:'manual'});
  expect((await previewStandaloneLoopMigration(f)).blockers).toContain('unfinished_run');
  await expect(migrateStandaloneLoopToWork(await migrationCommand(f))).rejects.toMatchObject({code:'target_busy'});
  await completeLoopRun(run.id,{status:'success'});
  await createLoopApprovalRequest({loopId:f.loopId,loopRunId:run.id,userId:f.userId,actionName:'send_message'});
  expect((await previewStandaloneLoopMigration(f)).blockers).toContain('unresolved_approval');
});
it('migration fences cached legacy writes but permits accepted Work queue execution after explicit activation',async()=>{
  const f=await standalone(),run=await createLoopRun({loopId:f.loopId,triggeredBy:'manual'});
  await completeLoopRun(run.id,{status:'success'});
  const adopted=await migrateStandaloneLoopToWork(await migrationCommand(f));
  for(const write of [()=>createLoopRun({loopId:f.loopId,triggeredBy:'manual'}),()=>completeLoopRun(run.id,{status:'failed'}),()=>upsertLoopState(f.loopId,{memorySummary:'stale'}),()=>updateLoop(f.userId,f.loopId,{workshopId:null}),()=>createLoopApprovalRequest({loopId:f.loopId,loopRunId:run.id,userId:f.userId,actionName:'send_message'})])await expect(write()).rejects.toMatchObject({code:'invalid_lease'});
  await expect(client`INSERT INTO loop_runs(loop_id,status) VALUES (${f.loopId},'running')`).rejects.toMatchObject({code:'23514'});
  await client`UPDATE workshops SET status='active' WHERE id=${adopted.workId}`;
  await client`UPDATE loops SET status='active' WHERE id=${f.loopId}`;
  const result=await enqueueWorkLoop({...queueInput(f),workId:adopted.workId,expectedVersion:1});
  await consumeOwnedLoopRuns({userId:f.userId,workerId:'migrated-fixture'});
  expect((await client`SELECT status FROM loop_runs WHERE id=${result.runId}`)[0].status).toBe('success');
});
it('migration event failure rolls back ownership, new Work, provenance and command receipt together',async()=>{
  const f=await standalone(),command=await migrationCommand(f);
  await client`CREATE FUNCTION reject_loop_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='loop_migrated' THEN RAISE EXCEPTION 'migration fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_loop_migration BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_loop_migration()`;
  try{await expect(migrateStandaloneLoopToWork(command)).rejects.toBeTruthy();}
  finally{await client`DROP TRIGGER reject_loop_migration ON workshop_events`;await client`DROP FUNCTION reject_loop_migration()`;}
  expect((await client`SELECT workshop_id,status FROM loops WHERE id=${f.loopId}`)[0]).toMatchObject({workshop_id:null,status:'active'});
  expect((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${f.userId}`)[0].n).toBe(1);
  expect((await client`SELECT count(*)::int AS n FROM work_commands WHERE owner_id=${f.userId}`)[0].n).toBe(0);
  expect((await client`SELECT count(*)::int AS n FROM loop_runtime_migrations WHERE loop_id=${f.loopId}`)[0].n).toBe(0);
  expect(await migrateStandaloneLoopToWork(command)).toMatchObject({status:'paused'});
});
it('legacy scheduled jobs stay visible as an explicit migration blocker',async()=>{
  const f=await standalone();await client`UPDATE loops SET trigger_config='{"type":"scheduled_job"}'::jsonb WHERE id=${f.loopId}`;
  expect((await previewStandaloneLoopMigration(f)).blockers).toContain('legacy_scheduled_job');
  await expect(migrateStandaloneLoopToWork(await migrationCommand(f))).rejects.toMatchObject({code:'target_busy'});
});
it('migration preview preserves a standalone external-write denial',async()=>{
  const f=await standalone();await client`UPDATE loops SET approval_policy='{"externalWrites":"deny"}'::jsonb WHERE id=${f.loopId}`;
  const preview=await previewStandaloneLoopMigration(f);
  expect(preview.proposed.boundaryPolicy.externalMessages).toBe('blocked');
  expect(preview.proposed.effectivePolicies.approvalPolicy.externalWrites).toBe('deny');
  const adopted=await migrateStandaloneLoopToWork(await migrationCommand(f));
  expect((await client`SELECT boundary_policy FROM workshops WHERE id=${adopted.workId}`)[0].boundary_policy.externalMessages).toBe('blocked');
});
async function migrateInProcess(input){
  const child=spawn(process.execPath,['--import','./tests/integration/deny-external-transports.mjs','--import','tsx','--conditions=react-server','tests/integration/loop-migration-worker.mjs',JSON.stringify(input)],{cwd:process.cwd(),windowsHide:true,env:{...process.env,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});expect(code,output).toBe(0);
  return JSON.parse(output.split('\n').findLast(line=>line.startsWith('{"migration"'))).migration;
}
it('two independent migration processes converge on one paused Work and receipt',async()=>{
  const f=await standalone(),command=await migrationCommand(f);
  const [a,b]=await Promise.all([migrateInProcess(command),migrateInProcess(command)]);expect(a).toEqual(b);
  expect((await client`SELECT count(*)::int AS n FROM loop_runtime_migrations WHERE loop_id=${f.loopId}`)[0].n).toBe(1);
  expect((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${f.userId}`)[0].n).toBe(2);
});
it('legacy completion evidence observes committed state through a separate database connection',async()=>{
  const f=await standalone(),run=await createLoopRun({loopId:f.loopId});
  let observed;
  capturedLoop.mockImplementationOnce(async runId=>{
    observed=(await client`SELECT status,output_summary FROM loop_runs WHERE id=${runId}`)[0];
  });
  const previous=process.env.WORK_HARNESS_EVOLUTION_ENABLED;process.env.WORK_HARNESS_EVOLUTION_ENABLED='true';
  try{await completeLoopRun(run.id,{status:'success',outputSummary:'committed observation'});expect(capturedLoop).toHaveBeenCalledWith(run.id);expect(observed).toMatchObject({status:'success',output_summary:'committed observation'});}
  finally{if(previous===undefined)delete process.env.WORK_HARNESS_EVOLUTION_ENABLED;else process.env.WORK_HARNESS_EVOLUTION_ENABLED=previous;}
});
function outerInput(f){return {userId:f.userId,workshopId:f.workId,loopId:f.loopId,commandId:f.commandId,mode:'native_agent',createOutboxDrafts:true};}
function queueInput(f,mode='dry_run'){return {userId:f.userId,workId:f.workId,loopId:f.loopId,commandId:f.commandId,mode};}
it('the generic Loop HTTP entry preserves the Work command identity and original version on retry',async()=>{
  const f=await fixture();httpOwner.id=f.userId;
  const url=`http://127.0.0.1/api/loops/${f.loopId}/execute`,context={params:Promise.resolve({id:f.loopId})};
  const body={commandId:f.commandId,expectedVersion:0,dryRun:true};
  const request=(value=body)=>new NextRequest(url,{method:'POST',headers:{'Content-Type':'application/json','X-Work-Actor':f.userId},body:JSON.stringify(value)});
  const first=await postGenericLoopExecution(request(),context);expect(first.status).toBe(200);const saved=await first.json();
  const repeated=await postGenericLoopExecution(request(),context);expect(repeated.status).toBe(200);expect((await repeated.json()).result).toEqual(saved.result);
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(1);
  expect((await postGenericLoopExecution(request({...body,dryRun:false}),context)).status).toBe(409);
  expect((await postGenericLoopExecution(request({dryRun:true}),context)).status).toBe(400);
});
it('review listing filters before keyset pagination and rejects foreign or anonymous reads',async()=>{
  const f=await fixture(),foreign=await fixture();httpOwner.id=f.userId;
  await client`INSERT INTO workshop_runs(workshop_id,status,created_at) SELECT ${f.workId}::uuid,'needs_review','2020-01-01'::timestamptz FROM generate_series(1,23)`;
  await client`INSERT INTO workshop_runs(workshop_id,status) SELECT ${f.workId}::uuid,'completed' FROM generate_series(1,101)`;
  const url=`http://127.0.0.1/api/workshops/${f.workId}/runs/review`,context={params:Promise.resolve({id:f.workId})};
  const first=await getRunReviews(new NextRequest(url),context);expect(first.status).toBe(200);const page=await first.json();expect(page.runs).toHaveLength(20);expect(page.nextCursor).toBeTruthy();
  const last=await (await getRunReviews(new NextRequest(`${url}?cursor=${page.nextCursor}`),context)).json();expect(last.runs).toHaveLength(3);expect(last.nextCursor).toBeNull();
  expect(new Set([...page.runs,...last.runs].map(run=>run.id)).size).toBe(23);
  expect((await getRunReviews(new NextRequest(`${url}?cursor=invalid`),context)).status).toBe(400);
  httpOwner.id=foreign.userId;expect((await getRunReviews(new NextRequest(url),context)).status).toBe(404);
  httpOwner.id='';expect((await getRunReviews(new NextRequest(url),context)).status).toBe(401);
});
async function reviewFixture(ordinary=false){
  const f=await fixture();let runId;
  if(ordinary){runId=randomUUID();await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${f.workId},'queued',NULL)`;}
  else runId=(await enqueueWorkLoop(queueInput(f))).runId;
  const claimed=await claimWorkshopExecution({userId:f.userId,workshopId:f.workId,runId,workerId:'review-fixture',leaseMs:60000});
  await markExecutionEffect(claimed.lease);
  await cancelWorkRun({userId:f.userId,workId:f.workId,runId,commandId:randomUUID()});
  return {...f,runId,lease:claimed.lease};
}
async function reviewCommand(f,extra={}){
  const state=await getWorkRunReview(f);
  return {...f,commandId:randomUUID(),expectedVersion:state.expectedVersion,expectedLeaseToken:state.expectedLeaseToken,outcome:'no_effect',evidence:'Owner checked the isolated executor and all effect receipts.',executorStopped:true,...extra};
}
it('owner closure is idempotent, fences the old worker and pauses backlog without replaying the Loop',async()=>{
  const f=await reviewFixture(),command=await reviewCommand(f);const [a,b]=await Promise.all([resolveWorkRun(command),resolveWorkRun(command)]);
  expect(a).toEqual(b);expect(a).toMatchObject({closed:true,status:'cancelled',workStatus:'paused'});
  const [row]=await client`SELECT x.active,r.status,l.token,l.phase,w.status AS work_status FROM workshop_loop_executions x JOIN loop_runs r ON r.id=x.loop_run_id JOIN workshop_execution_leases l ON l.workshop_id=x.workshop_id JOIN workshops w ON w.id=x.workshop_id WHERE x.run_id=${f.runId}`;
  expect(row).toMatchObject({active:false,status:'cancelled',token:f.lease.token+1,phase:'idle',work_status:'paused'});
  await expect(renewExecutionLease(f.lease,60000)).rejects.toMatchObject({code:'lease_lost'});
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'no-replay'})).toEqual([]);
  expect((await getWorkRunReview(f)).resolution).toMatchObject({actorId:f.userId,outcome:'no_effect',priorCompletion:{result:{status:'needs_review'}}});
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='run_review_closed'`)[0].n).toBe(1);
  await expect(resolveWorkRun({...command,evidence:'Changed owner evidence after closure'})).rejects.toMatchObject({code:'payload_conflict'});
});
it('unknown review records evidence once and keeps execution and Loop occupancy blocked',async()=>{
  const f=await reviewFixture(),command=await reviewCommand(f,{outcome:'unknown',executorStopped:false});
  expect(await resolveWorkRun(command)).toMatchObject({closed:false,status:'needs_review'});await resolveWorkRun(command);
  expect(await getWorkRunReview(f)).toMatchObject({reviewable:true,status:'needs_review',workStatus:'active',expectedLeaseToken:f.lease.token});
  expect((await getWorkRunReview(f)).lastReview).toMatchObject({evidence:command.evidence,metadata:{outcome:'unknown',actorId:f.userId}});
  expect((await client`SELECT active FROM workshop_loop_executions WHERE run_id=${f.runId}`)[0].active).toBe(true);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='run_review_observed'`)[0].n).toBe(1);
});
it('domain effects must be reconciled and a sent receipt contradicts a no-effect assertion',async()=>{
  const f=await reviewFixture(),outbox=randomUUID();
  await client`INSERT INTO workshop_outbox(id,workshop_id,run_id,message,status) VALUES (${outbox},${f.workId},${f.runId},'fixture only','unknown')`;
  expect((await getWorkRunReview(f)).pendingOutbox).toEqual([{id:outbox,status:'unknown'}]);
  await expect(resolveWorkRun(await reviewCommand(f))).rejects.toMatchObject({code:'unresolved_effect'});
  await client`UPDATE workshop_outbox SET status='sent' WHERE id=${outbox}`;
  await expect(resolveWorkRun(await reviewCommand(f))).rejects.toMatchObject({code:'payload_conflict'});
  expect(await resolveWorkRun(await reviewCommand(f,{outcome:'effects_recorded'}))).toMatchObject({closed:true});
  expect((await client`SELECT status FROM workshop_outbox WHERE id=${outbox}`)[0].status).toBe('sent');
});
it('review event failure rolls back closure, pause, linked state and the command receipt',async()=>{
  const f=await reviewFixture(),command=await reviewCommand(f);
  await client`CREATE FUNCTION reject_review_close() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_review_closed' THEN RAISE EXCEPTION 'review close fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_review_close BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_review_close()`;
  try{await expect(resolveWorkRun(command)).rejects.toMatchObject({cause:{message:'review close fault'}});}
  finally{await client`DROP TRIGGER reject_review_close ON workshop_events`;await client`DROP FUNCTION reject_review_close()`;}
  expect(await getWorkRunReview(f)).toMatchObject({status:'needs_review',workStatus:'active',expectedLeaseToken:f.lease.token});
  expect((await client`SELECT active FROM workshop_loop_executions WHERE run_id=${f.runId}`)[0].active).toBe(true);
  expect((await client`SELECT status FROM work_commands WHERE owner_id=${f.userId} AND command_id=${command.commandId}`)[0].status).toBe('queued');
  expect(await resolveWorkRun(command)).toMatchObject({closed:true});
});
it('review rejects foreign owners, agent authority, stale observations and absent shutdown confirmation',async()=>{
  const f=await reviewFixture(),foreign=await fixture(),command=await reviewCommand(f);
  await expect(getWorkRunReview({...f,userId:foreign.userId})).rejects.toMatchObject({code:'not_found'});
  await expect(resolveWorkRun({...command,userId:foreign.userId})).rejects.toMatchObject({code:'not_found'});
  await expect(resolveWorkRun({...command,source:'system'})).rejects.toMatchObject({code:'invalid_command'});
  await expect(withExecutionContext(f.lease,()=>resolveWorkRun(command))).rejects.toMatchObject({code:'invalid_command'});
  await expect(resolveWorkRun({...command,executorStopped:false})).rejects.toMatchObject({code:'invalid_command'});
  await expect(resolveWorkRun({...command,evidence:' '})).rejects.toMatchObject({code:'invalid_command'});
  await expect(resolveWorkRun({...command,expectedLeaseToken:f.lease.token+1})).rejects.toMatchObject({code:'version_conflict'});
});
it('actual review routes expose a scoped baseline and replay closure after response loss',async()=>{
  const f=await reviewFixture(),foreign=await fixture();httpOwner.id=f.userId;
  const url=`http://127.0.0.1/api/workshops/${f.workId}/runs/${f.runId}/review`,context={params:Promise.resolve({id:f.workId,runId:f.runId})};
  const view=await getRunReview(new NextRequest(url),context);expect(view.status).toBe(200);const baseline=await view.json();
  const command={commandId:randomUUID(),expectedVersion:baseline.expectedVersion,expectedLeaseToken:baseline.expectedLeaseToken,outcome:'no_effect',evidence:'Verified executor shutdown and fixture effect receipts.',executorStopped:true,userId:foreign.userId,source:'system'};
  const request=(payload=command,actor=f.userId)=>new NextRequest(url,{method:'POST',headers:{'Content-Type':'application/json','X-Work-Actor':actor},body:JSON.stringify(payload)});
  expect((await postRunReview(request(command,foreign.userId),context)).status).toBe(409);
  expect((await postRunReview(request({...command,executorStopped:false}),context)).status).toBe(400);
  const response=await postRunReview(request(),context);expect(response.status).toBe(200);const saved=await response.json();
  expect(await (await postRunReview(request(),context)).json()).toEqual(saved);
  httpOwner.id=foreign.userId;expect((await getRunReview(new NextRequest(url),context)).status).toBe(404);
  expect((await postRunReview(request(command,foreign.userId),context)).status).toBe(404);
  httpOwner.id='';expect((await getRunReview(new NextRequest(url),context)).status).toBe(401);
  expect((await postRunReview(request(),context)).status).toBe(401);
});
it('ordinary Work runs use the same owner review closure without requiring a Loop link',async()=>{
  const f=await reviewFixture(true);expect(await resolveWorkRun(await reviewCommand(f))).toMatchObject({closed:true,workStatus:'paused'});
  expect((await client`SELECT status FROM workshop_runs WHERE id=${f.runId}`)[0].status).toBe('cancelled');
});
it('provider attempt facts take priority over a stale outbox projection during review',async()=>{
  const f=await reviewFixture(),outbox=randomUUID(),attempt=randomUUID();
  await client`INSERT INTO workshop_outbox(id,workshop_id,run_id,message,status) VALUES (${outbox},${f.workId},${f.runId},'fixture only','draft')`;
  await client`INSERT INTO workshop_outbox_attempts(id,outbox_id,workshop_id,owner_id,command_id,content_hash,policy_hash,payload,status) VALUES (${attempt},${outbox},${f.workId},${f.userId},${randomUUID()},'fixture','fixture','{}'::jsonb,'unknown')`;
  expect((await getWorkRunReview(f)).pendingOutbox).toHaveLength(1);
  await expect(resolveWorkRun(await reviewCommand(f))).rejects.toMatchObject({code:'unresolved_effect'});
  await client`UPDATE workshop_outbox_attempts SET status='sent' WHERE id=${attempt}`;
  await expect(resolveWorkRun(await reviewCommand(f))).rejects.toMatchObject({code:'payload_conflict'});
  expect(await resolveWorkRun(await reviewCommand(f,{outcome:'effects_recorded'}))).toMatchObject({closed:true});
});
it('an unfenced historical needs-review run cannot be silently adopted by owner closure',async()=>{
  const f=await fixture(),runId=randomUUID();
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${f.workId},'needs_review')`;
  expect(await getWorkRunReview({...f,runId})).toMatchObject({reviewable:false,expectedLeaseToken:null});
  await expect(resolveWorkRun({...f,runId,expectedLeaseToken:1,outcome:'no_effect',evidence:'Historical executor is not covered by this lease protocol.',executorStopped:true})).rejects.toMatchObject({code:'target_busy'});
});
it('claim rechecks a queued Loop pause and leaves its acceptance available for resume',async()=>{
  const f=await fixture(),queued=await enqueueWorkLoop(queueInput(f));
  const input={userId:f.userId,workshopId:f.workId,runId:queued.runId,workerId:'pause-claim',leaseMs:60000};
  await client`UPDATE loops SET status='paused' WHERE id=${f.loopId}`;
  expect(await claimWorkshopExecution(input)).toEqual({state:'paused',runId:queued.runId,runtimeSnapshot:null});
  expect((await client`SELECT status,started_at FROM workshop_runs WHERE id=${queued.runId}`)[0]).toEqual({status:'queued',started_at:null});
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${queued.runId} AND type='execution_claimed'`)[0].n).toBe(0);
  await client`UPDATE loops SET status='active' WHERE id=${f.loopId}`;
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'resume-paused'})).toMatchObject([{runId:queued.runId,state:'completed'}]);
});
it('a consumer candidate cannot start after the Loop is paused between observation and claim',async()=>{
  const f=await fixture(),queued=await enqueueWorkLoop(queueInput(f,'native_agent'));native.mockReset();
  const result=await consumeOwnedLoopRuns({userId:f.userId,workerId:'stale-candidate'},async(command,control)=>{
    await client`UPDATE loops SET status='paused' WHERE id=${f.loopId}`;
    return executeWorkshopLoopCommand(command,control);
  });
  expect(result).toMatchObject([{runId:queued.runId,state:'paused'}]);expect(native).not.toHaveBeenCalled();
  expect((await client`SELECT status FROM workshop_runs WHERE id=${queued.runId}`)[0].status).toBe('queued');
});
it('Loop pause permits an existing lease heartbeat but prevents a new recovery claim',async()=>{
  const f=await fixture(),queued=await enqueueWorkLoop(queueInput(f));
  const input={userId:f.userId,workshopId:f.workId,runId:queued.runId,workerId:'paused-recovery',leaseMs:60000};
  const claimed=await claimWorkshopExecution(input);expect(claimed.state).toBe('claimed');
  await client`UPDATE loops SET status='paused' WHERE id=${f.loopId}`;
  await expect(renewExecutionLease(claimed.lease,60000)).resolves.toBeInstanceOf(Date);
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
  expect(await claimWorkshopExecution({...input,workerId:'replacement'})).toEqual({state:'paused',runId:queued.runId,runtimeSnapshot:null});
  await client`UPDATE loops SET status='active' WHERE id=${f.loopId}`;
  const recovered=await claimWorkshopExecution({...input,workerId:'replacement'});expect(recovered.state).toBe('claimed');expect(recovered.lease.token).toBeGreaterThan(claimed.lease.token);
});
async function scheduleFixture(trigger={type:'interval',minutes:5},at=new Date(Date.now()-1000).toISOString()){
  const f=await fixture();
  await client`UPDATE loops SET trigger_config=${JSON.stringify(trigger)}::jsonb WHERE id=${f.loopId}`;
  await upsertLoopState(f.loopId,{stateJson:{nextScheduledRunAt:at,schedulerStatus:'idle',ownerNote:'keep'}});
  return {...f,scheduledAt:at,mode:'dry_run',trigger};
}
it('one scheduled slot atomically admits one run and advances the cursor across concurrent callers',async()=>{
  const f=await scheduleFixture();
  const [a,b]=await Promise.all([dispatchScheduledWorkLoop(f),dispatchScheduledWorkLoop(f)]);
  expect(a.state).toBe('accepted');expect(b.runId).toBe(a.runId);expect([a.replayed,b.replayed].sort()).toEqual([false,true]);
  await expect(dispatchScheduledWorkLoop({...f,mode:'native_agent'})).rejects.toMatchObject({code:'payload_conflict'});
  const [state]=await client`SELECT state_json FROM loop_states WHERE loop_id=${f.loopId}`;
  expect(state.state_json.schedulerStatus).toBe('queued');expect(state.state_json.ownerNote).toBe('keep');expect(Date.parse(state.state_json.nextScheduledRunAt)).toBeGreaterThan(Date.now());
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'scheduled-consumer'})).toMatchObject([{runId:a.runId,state:'completed'}]);
  expect((await client`SELECT state_json FROM loop_states WHERE loop_id=${f.loopId}`)[0].state_json.schedulerStatus).toBe('idle');
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${a.runId} AND type='loop_schedule_advanced'`)[0].n).toBe(1);
  await expect(enqueueWorkLoop({...queueInput(f),commandId:a.commandId})).rejects.toMatchObject({code:'payload_conflict'});
});
it('a resumed acceptance rejects a changed payload or another run identity before execution',async()=>{
  const f=await fixture(),foreign=await fixture(),queued=await enqueueWorkLoop(queueInput(f)),other=await enqueueWorkLoop(queueInput(foreign));native.mockReset();
  const command=(await client`SELECT request_json FROM workshop_loop_executions WHERE run_id=${queued.runId}`)[0].request_json;
  await expect(executeWorkshopLoopCommand({...command,mode:'native_agent'},{acceptedRunId:queued.runId})).rejects.toMatchObject({code:'invalid_lease'});
  await expect(executeWorkshopLoopCommand(command,{acceptedRunId:other.runId})).rejects.toMatchObject({code:'not_found'});
  expect(native).not.toHaveBeenCalled();expect((await client`SELECT status FROM workshop_runs WHERE id=${queued.runId}`)[0].status).toBe('queued');
});
it('a once schedule stays queued until execution and does not queue itself again after completion',async()=>{
  const at=new Date(Date.now()-1000).toISOString(),f=await scheduleFixture({type:'once',at},at);
  const accepted=await dispatchScheduledWorkLoop(f);expect(accepted.state).toBe('accepted');
  expect((await client`SELECT state_json FROM loop_states WHERE loop_id=${f.loopId}`)[0].state_json.schedulerStatus).toBe('queued');
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'once-consumer'})).toMatchObject([{state:'completed'}]);
  expect(await listDueNativeLoops({userId:f.userId})).toEqual([]);
  expect(await dispatchScheduledWorkLoop(f)).toMatchObject({state:'accepted',runId:accepted.runId,status:'completed',replayed:true});
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(1);
});
it('a failed schedule advance event leaves both the cursor and all admission rows unchanged',async()=>{
  const f=await scheduleFixture();native.mockReset();
  await client`CREATE FUNCTION reject_schedule_advance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='loop_schedule_advanced' THEN RAISE EXCEPTION 'advance fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_schedule_advance BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_schedule_advance()`;
  try{const result=await runDueNativeLoops({userId:f.userId,executionMode:'dry_run'});expect(result.errors).toHaveLength(1);}
  finally{await client`DROP TRIGGER reject_schedule_advance ON workshop_events`;await client`DROP FUNCTION reject_schedule_advance()`;}
  expect((await client`SELECT state_json FROM loop_states WHERE loop_id=${f.loopId}`)[0].state_json.nextScheduledRunAt).toBe(f.scheduledAt);
  for(const table of ['workshop_runs','workshop_loop_executions'])expect((await client.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE workshop_id=$1`,[f.workId]))[0].n).toBe(0);
  expect(await runDueNativeLoops({userId:f.userId,executionMode:'dry_run'})).toMatchObject({queued:1,launched:0});expect(native).not.toHaveBeenCalled();
  expect((await runDueNativeLoops({userId:f.userId,executionMode:'dry_run'})).queued).toBeUndefined();
});
it('a scheduled slot retries after manual occupancy clears instead of being consumed by busy',async()=>{
  const f=await scheduleFixture(),manual=await enqueueWorkLoop(queueInput(f));
  expect(await dispatchScheduledWorkLoop(f)).toEqual({state:'busy'});
  expect((await client`SELECT state_json FROM loop_states WHERE loop_id=${f.loopId}`)[0].state_json.nextScheduledRunAt).toBe(f.scheduledAt);
  await cancelWorkRun({userId:f.userId,workId:f.workId,runId:manual.runId,commandId:randomUUID()});
  expect((await dispatchScheduledWorkLoop(f)).state).toBe('accepted');
});
it('missed cron slots are skipped once with an audit event instead of creating stale executions',async()=>{
  const f=await scheduleFixture({type:'cron',expression:'* * * * *',timezone:'UTC'},new Date(Date.now()-11*60000).toISOString());
  expect(await dispatchScheduledWorkLoop(f)).toMatchObject({state:'skipped',reason:'missed_cron_grace_exceeded'});
  expect(await dispatchScheduledWorkLoop(f)).toEqual({state:'stale'});
  expect((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${f.workId}`)[0].n).toBe(0);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${f.workId} AND type='loop_schedule_skipped'`)[0].n).toBe(1);
});
it('a non-trading-day once slot is consumed as skipped and does not resurface forever',async()=>{
  const date=new Date();date.setUTCHours(1,0,0,0);while(date.getUTCDay()!==6||date>new Date())date.setUTCDate(date.getUTCDate()-1);
  const at=date.toISOString(),trigger={type:'once',at,tradingDayOnly:true},f=await scheduleFixture(trigger,at);
  expect((await dispatchScheduledWorkLoop(f)).state).toBe('skipped');
  const state=(await client`SELECT state_json FROM loop_states WHERE loop_id=${f.loopId}`)[0].state_json;
  expect(state.onceScheduledAt).toBe(at);expect(state.tradingCalendarSource).toBeTruthy();
  expect(getEffectiveNextLoopRun({triggerConfig:trigger,stateJson:state,baseline:new Date()})).toBeNull();
  expect(await listDueNativeLoops({userId:f.userId})).toEqual([]);
});
it('schedule observations are read-only and early, paused or foreign slots cannot be admitted',async()=>{
  const f=await scheduleFixture({type:'interval',minutes:5},new Date(Date.now()+60000).toISOString()),foreign=await fixture();
  const before=(await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`)[0];
  expect(await listDueNativeLoops({userId:f.userId})).toEqual([]);expect((await client`SELECT * FROM loop_states WHERE loop_id=${f.loopId}`)[0]).toEqual(before);
  expect(await dispatchScheduledWorkLoop(f)).toEqual({state:'stale'});
  await expect(dispatchScheduledWorkLoop({...f,userId:foreign.userId})).rejects.toMatchObject({code:'not_found'});
  await client`UPDATE workshops SET status='paused' WHERE id=${f.workId}`;
  expect(await dispatchScheduledWorkLoop(f)).toEqual({state:'paused'});
});
async function dispatchInProcess(input){
  const child=spawn(process.execPath,['--import','./tests/integration/deny-external-transports.mjs','--import','tsx','--conditions=react-server','tests/integration/loop-schedule-worker.mjs',JSON.stringify(input)],{cwd:process.cwd(),windowsHide:true,env:{...process.env,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});expect(code,output).toBe(0);
  return JSON.parse(output.split('\n').findLast(line=>line.startsWith('{"state"')));
}
it('two independent scheduler processes receive the same durable scheduled acceptance',async()=>{
  const f=await scheduleFixture();const [a,b]=await Promise.all([dispatchInProcess(f),dispatchInProcess(f)]);
  expect(a.runId).toBe(b.runId);expect([a.replayed,b.replayed].sort()).toEqual([false,true]);
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${f.loopId}`)[0].n).toBe(1);
});
it('queued cancellation releases Loop occupancy and preserves the previous observation',async()=>{
  const f=await fixture();await upsertLoopState(f.loopId,{currentPhase:'complete',lastObservation:'previous observation',stateJson:{ownerNote:'preserve'}});
  const queued=await enqueueWorkLoop(queueInput(f));const cancel={userId:f.userId,workId:f.workId,runId:queued.runId,commandId:randomUUID()};
  const cancelled=await cancelWorkRun(cancel);expect(cancelled.status).toBe('cancelled');expect(await cancelWorkRun(cancel)).toEqual(cancelled);
  const [row]=await client`SELECT x.active,r.status,s.current_phase,s.last_observation,s.state_json FROM workshop_loop_executions x JOIN loop_runs r ON r.id=x.loop_run_id JOIN loop_states s ON s.loop_id=x.loop_id WHERE x.run_id=${queued.runId}`;
  expect(row).toMatchObject({active:false,status:'cancelled',current_phase:'complete',last_observation:'previous observation'});expect(row.state_json.ownerNote).toBe('preserve');
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'cancelled-queue'})).toEqual([]);
  expect((await enqueueWorkLoop({...queueInput(f),commandId:randomUUID()})).status).toBe('queued');
});
it('running cancellation aborts the Loop executor and fences its late completion',async()=>{
  const f=await fixture(),queued=await enqueueWorkLoop(queueInput(f,'native_agent'));let started;
  const ready=new Promise(resolve=>{started=resolve;});native.mockReset();
  native.mockImplementation(async input=>{
    started();await new Promise(resolve=>input.abortController.signal.addEventListener('abort',resolve,{once:true}));return suggestedResult();
  });
  const running=consumeOwnedLoopRuns({userId:f.userId,workerId:'cancel-running',leaseMs:1500});await ready;
  expect((await cancelWorkRun({userId:f.userId,workId:f.workId,runId:queued.runId,commandId:randomUUID()})).status).toBe('cancelled');
  expect(await running).toMatchObject([{state:'cancelled'}]);
  const [row]=await client`SELECT x.active,r.status,s.current_phase FROM workshop_loop_executions x JOIN loop_runs r ON r.id=x.loop_run_id JOIN loop_states s ON s.loop_id=x.loop_id WHERE x.run_id=${queued.runId}`;
  expect(row).toMatchObject({active:false,status:'cancelled',current_phase:'cancelled'});
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${queued.runId} AND type='loop_execution_result'`)[0].n).toBe(0);
});
it('cancellation after external intent retains both Work and Loop in needs_review',async()=>{
  const f=await fixture(),queued=await enqueueWorkLoop(queueInput(f,'native_agent'));let started,release;
  const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});native.mockReset();
  native.mockImplementation(async()=>{await markExecutionEffect(resolveExecutionLease());started();await gate;return suggestedResult();});
  const running=consumeOwnedLoopRuns({userId:f.userId,workerId:'cancel-effect'});await ready;
  try{expect((await cancelWorkRun({userId:f.userId,workId:f.workId,runId:queued.runId,commandId:randomUUID()})).status).toBe('needs_review');}finally{release();}
  await running;
  const [row]=await client`SELECT x.active,r.status,w.status AS work_status FROM workshop_loop_executions x JOIN loop_runs r ON r.id=x.loop_run_id JOIN workshop_runs w ON w.id=x.run_id WHERE x.run_id=${queued.runId}`;
  expect(row).toMatchObject({active:true,status:'needs_review',work_status:'needs_review'});
  await expect(enqueueWorkLoop({...queueInput(f),commandId:randomUUID()})).rejects.toMatchObject({code:'target_busy'});
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'never-replay-effect'})).toEqual([]);
});
it('cancellation event failure rolls back linked runs, state, occupancy and completion receipt',async()=>{
  const f=await fixture(),queued=await enqueueWorkLoop(queueInput(f));const cancel={userId:f.userId,workId:f.workId,runId:queued.runId,commandId:randomUUID()};
  await client`CREATE FUNCTION reject_linked_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_cancelled' THEN RAISE EXCEPTION 'linked cancel fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_linked_cancel BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_linked_cancel()`;
  try{await expect(cancelWorkRun(cancel)).rejects.toThrow();}
  finally{await client`DROP TRIGGER reject_linked_cancel ON workshop_events`;await client`DROP FUNCTION reject_linked_cancel()`;}
  const [row]=await client`SELECT x.active,r.status,w.status AS work_status,w.completion_json FROM workshop_loop_executions x JOIN loop_runs r ON r.id=x.loop_run_id JOIN workshop_runs w ON w.id=x.run_id WHERE x.run_id=${queued.runId}`;
  expect(row).toMatchObject({active:true,status:'queued',work_status:'queued',completion_json:null});
  expect((await client`SELECT count(*)::int AS n FROM loop_states WHERE loop_id=${f.loopId}`)[0].n).toBe(0);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${queued.runId} AND type='loop_execution_cancelled'`)[0].n).toBe(0);
  expect((await cancelWorkRun(cancel)).status).toBe('cancelled');
});
it('cancelling a captured result cannot replay it as a completed Work response',async()=>{
  const f=await fixture(),command=queueInput(f,'native_agent'),queued=await enqueueWorkLoop(command);native.mockReset();native.mockResolvedValue(suggestedResult());
  await client`CREATE FUNCTION reject_captured_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_completed' THEN RAISE EXCEPTION 'captured finish fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_captured_finish BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_captured_finish()`;
  try{expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'captured-before-cancel'})).toMatchObject([{state:'error'}]);}
  finally{await client`DROP TRIGGER reject_captured_finish ON workshop_events`;await client`DROP FUNCTION reject_captured_finish()`;}
  expect((await cancelWorkRun({userId:f.userId,workId:f.workId,runId:queued.runId,commandId:randomUUID()})).status).toBe('cancelled');
  await expect(runWorkLoop(command)).rejects.toMatchObject({code:'busy',executionState:'cancelled'});
  expect((await enqueueWorkLoop(command)).status).toBe('cancelled');expect(native).toHaveBeenCalledTimes(1);
});
it('generic Work completion cannot bypass the linked Loop result protocol',async()=>{
  const f=await fixture();await runNativeLoopOnce({...f,execute:async()=>{
    await expect(finishWorkshopExecution(resolveExecutionLease(),{status:'completed'})).rejects.toMatchObject({code:'invalid_lease'});
    return suggestedResult();
  }});
});
it('an error result after external intent keeps the Loop state visibly blocked for review',async()=>{
  const f=await fixture(),queued=await enqueueWorkLoop(queueInput(f,'native_agent'));native.mockReset();
  native.mockImplementation(async()=>{await markExecutionEffect(resolveExecutionLease());return {status:'error',error:'unknown provider reply',duration:1};});
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'effect-error'})).toMatchObject([{state:'needs_review'}]);
  const [row]=await client`SELECT x.active,r.status,s.current_phase,s.blocked_reason FROM workshop_loop_executions x JOIN loop_runs r ON r.id=x.loop_run_id JOIN loop_states s ON s.loop_id=x.loop_id WHERE x.run_id=${queued.runId}`;
  expect(row).toMatchObject({active:true,status:'needs_review',current_phase:'blocked',blocked_reason:'unknown provider reply'});
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'do-not-replay'})).toEqual([]);
});
it('the actual async HTTP route commits its queue before returning and reports replayed completion',async()=>{
  const f=await fixture(),foreign=await fixture();httpOwner.id=f.userId;native.mockReset();native.mockResolvedValue(suggestedResult());
  const request=()=>postLoopExecution(new NextRequest(`http://127.0.0.1/api/workshops/${f.workId}/loops/${f.loopId}/execute`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':f.commandId},body:JSON.stringify({mode:'native_agent',wait:false})}),{params:Promise.resolve({id:f.workId,loopId:f.loopId})});
  const first=await request();expect(first.status).toBe(202);const queued=await first.json();
  expect(queued).toMatchObject({commandId:f.commandId,status:'queued',accepted:true});
  expect((await client`SELECT status,started_at FROM workshop_runs WHERE id=${queued.runId}`)[0]).toMatchObject({status:'queued',started_at:null});
  expect(await (await request()).json()).toEqual(queued);expect(native).not.toHaveBeenCalled();
  httpOwner.id=foreign.userId;expect((await request()).status).toBe(404);httpOwner.id=f.userId;
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'http-consumer'})).toMatchObject([{state:'completed'}]);
  expect((await (await request()).json()).status).toBe('completed');expect(native).toHaveBeenCalledTimes(1);
});
it('persists an accepted queue item without executing and consumes only the requested owner',async()=>{
  const f=await fixture(),foreign=await fixture();native.mockReset();
  const queued=await enqueueWorkLoop(queueInput(f));expect(queued.status).toBe('queued');
  expect((await client`SELECT started_at FROM loop_runs WHERE id=${queued.loopRunId}`)[0].started_at).toBeNull();
  expect(await consumeOwnedLoopRuns({userId:foreign.userId,workerId:'foreign-consumer'})).toEqual([]);
  expect(await consumeOwnedLoopRuns({userId:f.userId.toUpperCase(),workerId:'owner-consumer'})).toMatchObject([{runId:queued.runId,state:'completed'}]);
  expect(native).not.toHaveBeenCalled();
  expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'again'})).toEqual([]);
  expect((await enqueueWorkLoop(queueInput(f))).status).toBe('completed');
});
it('two consumers retain one execution winner while its short lease is renewed',async()=>{
  const f=await fixture();await enqueueWorkLoop(queueInput(f,'native_agent'));native.mockReset();
  native.mockImplementation(async input=>{
    expect(input.abortController).toBeInstanceOf(AbortController);
    await sleep(2200);return suggestedResult();
  });
  const results=await Promise.all(['consumer-a','consumer-b'].map(workerId=>consumeOwnedLoopRuns({userId:f.userId,workerId,leaseMs:1500})));
  expect(native).toHaveBeenCalledTimes(1);expect(results.flat().some(item=>item.state==='completed')).toBe(true);
  const [lease]=await client`SELECT worker_id,phase,heartbeat_at>r.started_at AS renewed FROM workshop_execution_leases l JOIN workshop_runs r ON r.id=l.run_id WHERE l.workshop_id=${f.workId}`;
  expect(['consumer-a','consumer-b']).toContain(lease.worker_id);expect(lease.phase).toBe('idle');expect(lease.renewed).toBe(true);
});
it('consumer shutdown aborts the current executor and does not start another queued loop',async()=>{
  const f=await fixture(),next=await fixture();
  // Both queues belong to one owner but separate Work execution domains.
  await client`UPDATE workshops SET user_id=${f.userId} WHERE id=${next.workId}`;
  await client`UPDATE loops SET user_id=${f.userId} WHERE id=${next.loopId}`;next.userId=f.userId;
  await enqueueWorkLoop(queueInput(f,'native_agent'));await enqueueWorkLoop(queueInput(next,'native_agent'));
  native.mockReset();const stop=new AbortController();
  native.mockImplementation(async input=>{stop.abort();expect(input.abortController.signal.aborted).toBe(true);return suggestedResult();});
  const results=await consumeOwnedLoopRuns({userId:f.userId,workerId:'stopping-consumer',signal:stop.signal});
  expect(native).toHaveBeenCalledTimes(1);expect(results).toHaveLength(1);expect(results[0].state).toBe('error');
  expect((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id IN (${f.workId},${next.workId}) AND status='queued'`)[0].n).toBe(1);
});
async function consumeInProcess(userId){
  const child=spawn(process.execPath,['--import','./tests/integration/deny-external-transports.mjs','--import','tsx','--conditions=react-server','scripts/consume-loop-runs.mjs',`--userId=${userId}`,'--once'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',REPORT_QUALITY_EVALUATOR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  expect(code,output).toBe(0);return output;
}
it('two independent CLI processes consume one durable dry-run without external transports',async()=>{
  const f=await fixture();const queued=await enqueueWorkLoop(queueInput(f));
  await Promise.all([consumeInProcess(f.userId),consumeInProcess(f.userId)]);
  expect((await client`SELECT status FROM workshop_runs WHERE id=${queued.runId}`)[0].status).toBe('completed');
  for(const type of ['loop_run_started','loop_execution_result','loop_run_completed'])expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${queued.runId} AND type=${type}`)[0].n).toBe(1);
});
it('an independent CLI resumes a native result checkpoint without a model or duplicate draft',async()=>{
  const f=await fixture();const queued=await enqueueWorkLoop(queueInput(f,'native_agent'));
  native.mockReset();native.mockResolvedValue(suggestedResult());
  await client`CREATE FUNCTION reject_consumer_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_completed' THEN RAISE EXCEPTION 'consumer finish fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_consumer_finish BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_consumer_finish()`;
  try{expect(await consumeOwnedLoopRuns({userId:f.userId,workerId:'first-process'})).toMatchObject([{state:'error'}]);}
  finally{await client`DROP TRIGGER reject_consumer_finish ON workshop_events`;await client`DROP FUNCTION reject_consumer_finish()`;}
  expect(native).toHaveBeenCalledTimes(1);
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
  await consumeInProcess(f.userId);
  expect((await client`SELECT status FROM workshop_runs WHERE id=${queued.runId}`)[0].status).toBe('completed');
  expect((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE run_id=${queued.runId}`)[0].n).toBe(1);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${queued.runId} AND type='loop_execution_result'`)[0].n).toBe(1);
});
it('replays outer postprocessing and quality receipts after completion failure without duplicating drafts or reviews',async()=>{
  const f=await fixture();process.env.REPORT_QUALITY_EVALUATOR_ENABLED='true';
  native.mockReset();native.mockResolvedValue(suggestedResult());
  await client`CREATE FUNCTION reject_outer_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_completed' THEN RAISE EXCEPTION 'finish fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_outer_finish BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_outer_finish()`;
  try{await expect(runWorkshopLoopOnce(outerInput(f))).rejects.toThrow();}
  finally{await client`DROP TRIGGER reject_outer_finish ON workshop_events`;await client`DROP FUNCTION reject_outer_finish()`;}
  const [draft]=await client`SELECT id,run_id FROM workshop_outbox WHERE workshop_id=${f.workId}`;
  expect(draft).toBeDefined();
  const [quality]=await client`SELECT id FROM workshop_events WHERE workshop_id=${f.workId} AND type='report_quality_review'`;
  expect(quality).toBeDefined();
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
  const response=await runWorkshopLoopOnce(outerInput(f));
  expect(response.loopRunId).toBe(draft.run_id);expect(response.outboxDrafts[0].id).toBe(draft.id);
  expect(await runWorkshopLoopOnce(outerInput(f))).toEqual(response);
  expect(native).toHaveBeenCalledTimes(1);
  for(const type of ['loop_run_started','loop_run_completed','report_quality_review','report_quality_config_proposed']){
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${f.workId} AND type=${type}`)[0].n).toBe(1);
  }
  expect((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE workshop_id=${f.workId}`)[0].n).toBe(1);
  expect((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${f.workId}`)[0].n).toBe(1);
  process.env.REPORT_QUALITY_EVALUATOR_ENABLED='false';
});
it('rolls back completion event and review closure if draft insertion fails, then resumes the same output',async()=>{
  const f=await fixture(),reviewId=randomUUID();
  native.mockReset();native.mockImplementation(async input=>{
    await client`INSERT INTO workshop_review_items(id,workshop_id,kind,title,metadata) VALUES (${reviewId},${f.workId},'service_error','fixture error',${JSON.stringify({loopRunId:input.runId})}::jsonb)`;
    return suggestedResult();
  });
  await client`CREATE FUNCTION reject_outer_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'draft fault'; END $$`;
  await client`CREATE TRIGGER reject_outer_draft BEFORE INSERT ON workshop_outbox FOR EACH ROW EXECUTE FUNCTION reject_outer_draft()`;
  try{await expect(runWorkshopLoopOnce(outerInput(f))).rejects.toThrow();}
  finally{await client`DROP TRIGGER reject_outer_draft ON workshop_outbox`;await client`DROP FUNCTION reject_outer_draft()`;}
  expect((await client`SELECT status FROM workshop_review_items WHERE id=${reviewId}`)[0].status).toBe('pending');
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${f.workId} AND type='loop_run_completed'`)[0].n).toBe(0);
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
  const response=await runWorkshopLoopOnce(outerInput(f));
  expect(response.outboxDrafts).toHaveLength(1);expect(native).toHaveBeenCalledTimes(1);
  expect((await client`SELECT status FROM workshop_review_items WHERE id=${reviewId}`)[0].status).toBe('superseded');
});
it('does not emit a false start or failure for an outer trigger rejected as busy',async()=>{
  const f=await fixture();let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  native.mockReset();native.mockImplementation(async()=>{entered();await gate;return suggestedResult();});
  const first=runWorkshopLoopOnce(outerInput(f));await ready;
  try{await expect(runWorkshopLoopOnce({...outerInput(f),commandId:randomUUID(),triggeredBy:'scheduler'})).rejects.toMatchObject({code:'busy'});}finally{release();}
  await first;
  expect(native).toHaveBeenCalledTimes(1);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${f.workId} AND type='loop_run_started'`)[0].n).toBe(1);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${f.workId} AND type='loop_run_failed'`)[0].n).toBe(0);
});
it('replays a completed command without another execution and preserves current state fields',async()=>{
  const f=await fixture();let calls=0;
  const execute=async()=>{
    calls++;
    await client`UPDATE loop_states SET state_json=state_json||'{"ownerAnnotation":"keep"}'::jsonb WHERE loop_id=${f.loopId}`;
    return {status:'success',output:'saved observation',duration:1};
  };
  const first=await runNativeLoopOnce({...f,execute});
  expect(await runNativeLoopOnce({...f,execute})).toEqual(first);expect(calls).toBe(1);
  const [state]=await client`SELECT state_json FROM loop_states WHERE loop_id=${f.loopId}`;
  expect(state.state_json.ownerAnnotation).toBe('keep');
  const [row]=await client`SELECT x.active,r.status,l.phase FROM workshop_loop_executions x JOIN workshop_runs r ON r.id=x.run_id JOIN workshop_execution_leases l ON l.workshop_id=x.workshop_id WHERE x.loop_id=${f.loopId}`;
  expect(row).toMatchObject({active:false,status:'completed',phase:'idle'});
});
it('resumes a captured Loop result after completion commit failure without rerunning the executor',async()=>{
  const f=await fixture();let calls=0;
  const execute=async()=>{calls++;return {status:'success',output:'checkpoint',duration:1};};
  await client`CREATE FUNCTION reject_loop_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_completed' THEN RAISE EXCEPTION 'finish fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_loop_finish BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_loop_finish()`;
  try{await expect(runNativeLoopOnce({...f,execute})).rejects.toThrow();}
  finally{await client`DROP TRIGGER reject_loop_finish ON workshop_events`;await client`DROP FUNCTION reject_loop_finish()`;}
  const [before]=await client`SELECT result_json,active FROM workshop_loop_executions WHERE loop_id=${f.loopId}`;
  expect(before.result_json.output).toBe('checkpoint');expect(before.active).toBe(true);
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
  expect((await runNativeLoopOnce({...f,execute})).output).toBe('checkpoint');expect(calls).toBe(1);
  expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${f.workId} AND type='loop_execution_result'`)[0].n).toBe(1);
});
it('rolls back Loop result, state and receipt when result event insertion fails',async()=>{
  const f=await fixture();let calls=0;
  const execute=async()=>{calls++;return {status:'success',output:'atomic observation',duration:1};};
  await client`CREATE FUNCTION reject_loop_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='loop_execution_result' THEN RAISE EXCEPTION 'result fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_loop_result BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_loop_result()`;
  try{await expect(runNativeLoopOnce({...f,execute})).rejects.toThrow();}
  finally{await client`DROP TRIGGER reject_loop_result ON workshop_events`;await client`DROP FUNCTION reject_loop_result()`;}
  const [row]=await client`SELECT x.result_json,r.status,s.current_phase FROM workshop_loop_executions x JOIN loop_runs r ON r.id=x.loop_run_id JOIN loop_states s ON s.loop_id=x.loop_id WHERE x.loop_id=${f.loopId}`;
  expect(row).toMatchObject({result_json:null,status:'running',current_phase:'running'});
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
  expect((await runNativeLoopOnce({...f,execute})).status).toBe('success');expect(calls).toBe(2);
});
it('rejects a late executor result and late state writes after its lease expires',async()=>{
  const f=await fixture();let oldLease,runId;
  await expect(runNativeLoopOnce({...f,execute:async context=>{
    oldLease=resolveExecutionLease();runId=context.loopRun.id;
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
    return {status:'success',output:'stale',duration:1};
  }})).rejects.toMatchObject({code:'lease_lost'});
  await expect(withExecutionContext(oldLease,()=>completeLoopRun(runId,{status:'success',outputSummary:'stale'}))).rejects.toMatchObject({code:'lease_lost'});
  await expect(withExecutionContext(oldLease,()=>upsertLoopState(f.loopId,{lastObservation:'stale'}))).rejects.toMatchObject({code:'lease_lost'});
  await expect(completeLoopRun(runId,{status:'success',outputSummary:'unfenced'})).rejects.toMatchObject({code:'invalid_lease'});
  expect((await client`SELECT result_json FROM workshop_loop_executions WHERE loop_id=${f.loopId}`)[0].result_json).toBeNull();
});
it('does not automatically replay an expired execution after external effect intent',async()=>{
  const f=await fixture();let calls=0;
  const execute=async()=>{
    calls++;await markExecutionEffect(resolveExecutionLease());
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
    return {status:'success',output:'uncertain effect',duration:1};
  };
  await expect(runNativeLoopOnce({...f,execute})).rejects.toMatchObject({code:'lease_lost'});
  await expect(runNativeLoopOnce({...f,execute})).rejects.toMatchObject({code:'busy'});
  expect(calls).toBe(1);
  expect((await client`SELECT phase FROM workshop_execution_leases WHERE workshop_id=${f.workId}`)[0].phase).toBe('needs_review');
  expect((await client`SELECT status FROM loop_runs WHERE loop_id=${f.loopId}`)[0].status).toBe('needs_review');
  expect((await client`SELECT current_phase FROM loop_states WHERE loop_id=${f.loopId}`)[0].current_phase).toBe('blocked');
});
it('manual and scheduled execution of one Loop have only one execution winner',async()=>{
  const userId=randomUUID(),workId=randomUUID(),loopId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'loop-race@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'loop owner','test')`;
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,verification_config) VALUES (${loopId},${userId},${workId},'concurrent loop','observe','{"modelChecker":{"enabled":false}}'::jsonb)`;
  let calls=0,started,release;
  const ready=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const execute=async()=>{calls++;started();await gate;return {status:'success',output:'observed fixture',duration:1};};
  const first=runNativeLoopOnce({userId,loopId,commandId:randomUUID(),triggeredBy:'manual',modelChecker:null,execute});
  const firstResult=first.then(value=>({value}),error=>({error}));
  await ready;
  const second=runNativeLoopOnce({userId,loopId,commandId:randomUUID(),triggeredBy:'scheduler',modelChecker:null,execute});
  const secondResult=second.then(value=>({value}),error=>({error}));
  await Promise.race([secondResult,sleep(75)]);release();
  const [a,b]=await Promise.all([firstResult,secondResult]);
  expect(a.error).toBeUndefined();expect(a.value.status).toBe('success');
  expect(calls).toBe(1);expect(b.error).toMatchObject({code:'busy'});
  expect((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${loopId}`)[0].n).toBe(1);
});
