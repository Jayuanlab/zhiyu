import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {fork} from 'node:child_process';
import postgres from 'postgres';
import {processInteractionEvents} from '../../lib/interactions/processor.ts';
import {createInteractionProcessingJob,recoverInterruptedInteractionJobs} from '../../lib/interactions/processing-jobs.ts';
import {createInteractionNote} from '../../lib/interactions/service.ts';
import {withDatabaseTransaction} from '../../lib/db/client.ts';
import {readInteractionProcessingPlan} from '../../lib/interactions/processing-plans.ts';
import {closeInteractionProcessingReview} from '../../lib/interactions/processing-reviews.ts';
import {runPendingInteractionProcessingJobs} from '../../lib/interactions/worker.ts';
import {upsertInteractionSourcePolicy,lockInteractionSourcePolicies} from '../../lib/knowledge-pipeline/source-policies.ts';
import {closePostgresDb} from '../../lib/db/adapters/postgres.ts';
const sql=postgres(process.env.POSTGRES_URL,{max:1});
const owner=randomUUID(),other=randomUUID(),event=randomUUID(),otherEvent=randomUUID();
let requests=0;
const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const request=JSON.parse(Buffer.concat(chunks));requests++;
  const analysis=request.messages[0].content.includes('knowledge analyst');
  const sourceEventIds=[event],scenarioHints=[{type:'project',key:'atomic-fixture',title:'Atomic fixture'}];
  const result=analysis?{summary:'Fixture analysis',topics:['fixture'],facts:[{claim:'Fixture source',sourceEventIds,evidenceStrength:'high'}]}:
    {notes:[{title:'Atomic note',body:'Derived note',sourceEventIds,scenarioHints}],
      tasks:[{title:'Atomic task',description:'Derived task',sourceEventIds,scenarioHints}],
      memories:[{memoryType:'project',subject:'Atomic memory',content:'Derived context',sourceEventIds,scenarioHints}]};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture-'+requests,created:1,model:'fixture',
    choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.env.INTERACTION_PROCESSOR_LLM_API_KEY='fixture';process.env.INTERACTION_PROCESSOR_LLM_BASE_URL=`http://127.0.0.1:${server.address().port}/v1`;
process.env.INTERACTION_PROCESSOR_LLM_MODEL='fixture';process.env.INTERACTION_PROCESSOR_LLM_PROVIDER='openai_compatible';
const counts=async()=>{
  const result={};for(const table of ['interaction_notes','interaction_tasks','brain_memories','brain_state_snapshots','memory_graph_entities','memory_graph_relations','memory_graph_evidence']){
    result[table]=Number((await sql`SELECT count(*)::int n FROM ${sql(table)} WHERE user_id=${owner}`)[0].n);
  }return result;
};
const makeJob=()=>createInteractionProcessingJob({userId:owner,eventIds:[event],processingMode:'full'});
const run=job=>processInteractionEvents({userId:owner,eventIds:[event],processingJobId:job.id,fallbackToSummary:false});
try{
  await sql`INSERT INTO "User"(id,email) VALUES (${owner},'atomic-owner@example.invalid'),(${other},'atomic-other@example.invalid')`;
  await sql`INSERT INTO interaction_events(id,user_id,platform,source,conversation_name,message_time,dedupe_key,content) VALUES
    (${event},${owner},'wechat','fixture','owned',clock_timestamp(),${event},'Immutable source'),
    (${otherEvent},${other},'wechat','fixture','other',clock_timestamp(),${otherEvent},'Other source')`;
  const baseline=await counts();
  await sql`CREATE FUNCTION reject_atomic_snapshot_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture late snapshot failure'; END $$`;
  await sql`CREATE TRIGGER reject_atomic_snapshot_fixture BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION reject_atomic_snapshot_fixture()`;
  const failed=await makeJob();await assert.rejects(run(failed),error=>error.cause?.message==='fixture late snapshot failure');
  assert.deepEqual(await counts(),baseline);
  assert.equal((await sql`SELECT status FROM interaction_processing_jobs WHERE id=${failed.id}`)[0].status,'needs_review');
  await sql`DROP TRIGGER reject_atomic_snapshot_fixture ON brain_state_snapshots`;await sql`DROP FUNCTION reject_atomic_snapshot_fixture()`;
  await sql`CREATE FUNCTION reject_atomic_completion_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RAISE EXCEPTION 'fixture completion failure'; END IF; RETURN NEW; END $$`;
  await sql`CREATE TRIGGER reject_atomic_completion_fixture BEFORE UPDATE ON interaction_processing_jobs FOR EACH ROW EXECUTE FUNCTION reject_atomic_completion_fixture()`;
  const failedCompletion=await makeJob();await assert.rejects(run(failedCompletion),error=>error.cause?.message==='fixture completion failure');
  assert.deepEqual(await counts(),baseline);
  await sql`DROP TRIGGER reject_atomic_completion_fixture ON interaction_processing_jobs`;await sql`DROP FUNCTION reject_atomic_completion_fixture()`;
  // The unrelated concurrent call must not be captured by the failed transaction scope.
  let release,started;const entered=new Promise(resolve=>{started=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  const rejected=assert.rejects(withDatabaseTransaction(async()=>{
    await createInteractionNote({userId:owner,title:'rollback',body:'rollback',noteType:'summary',sourceEventIds:[event]});started();await gate;throw Error('scope rollback');
  }),/scope rollback/);
  await entered;
  await createInteractionNote({userId:other,title:'independent',body:'keep',noteType:'summary',sourceEventIds:[otherEvent]});release();await rejected;
  assert.deepEqual(await counts(),baseline);
  assert.equal((await sql`SELECT count(*)::int n FROM interaction_notes WHERE user_id=${other}`)[0].n,1);
  let unlockPolicy,policyLocked;
  const policyEntered=new Promise(resolve=>{policyLocked=resolve;}),policyGate=new Promise(resolve=>{unlockPolicy=resolve;});
  const heldPolicy=withDatabaseTransaction(async()=>{await lockInteractionSourcePolicies(owner);policyLocked();await policyGate;});
  await policyEntered;
  const policyChange=upsertInteractionSourcePolicy({userId:owner,platform:'wechat',sourceId:'serialized-fixture',sourceName:'fixture',policy:'ignore'});
  try{
    const deadline=Date.now()+5000;let blocked=false;
    while(Date.now()<deadline){
      blocked=(await sql`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)[0].n>0;
      if(blocked)break;await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(blocked,true);
    await upsertInteractionSourcePolicy({userId:other,platform:'wechat',sourceId:'independent-fixture',sourceName:'other',policy:'sync'});
  }finally{unlockPolicy();await heldPolicy;await policyChange;}
  const crashJob=await makeJob();
  const crash=fork('tests/integration/interaction-atomic-crash-child.mjs',[owner,crashJob.id,event],{
    cwd:process.cwd(),env:process.env,windowsHide:true,execArgv:['--import','tsx','--conditions=react-server'],stdio:['ignore','ignore','pipe','ipc']});
  let crashExited=false,crashErrors='';crash.stderr.on('data',data=>crashErrors+=data);
  const crashExit=new Promise(resolve=>crash.once('exit',()=>{crashExited=true;resolve();}));
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('atomic crash fixture timeout: '+crashErrors)),20000);
      crash.once('message',message=>{clearTimeout(timer);message.ready?resolve():reject(Error('fixture not ready'));});
      crash.once('exit',()=>{clearTimeout(timer);reject(Error('fixture exited: '+crashErrors));});
    });
    // Uncommitted writes are invisible before the crash as well.
    assert.deepEqual(await counts(),baseline);
    crash.kill('SIGKILL');await crashExit;
    assert.deepEqual(await counts(),baseline);
    const deadline=Date.now()+6000;
    while(Date.now()<deadline){
      if(await recoverInterruptedInteractionJobs(owner))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal((await sql`SELECT status FROM interaction_processing_jobs WHERE id=${crashJob.id}`)[0].status,'needs_review');
    assert.deepEqual(await counts(),baseline);
  }finally{if(!crashExited){crash.kill('SIGKILL');await crashExit;}}
  const successful=await makeJob(),result=await run(successful);
  assert.equal(result.mode,'llm');assert.equal(result.notes.length,1);assert.equal(result.tasks.length,1);assert.equal(result.memories.length,1);
  assert.ok(result.scenarioSnapshots.createdCount>0);assert.ok(result.graphIndex.evidence>0);
  const committed=await counts();assert.equal(committed.interaction_notes,1);assert.equal(committed.interaction_tasks,1);assert.equal(committed.brain_memories,1);
  assert.equal((await sql`SELECT status FROM interaction_processing_jobs WHERE id=${successful.id}`)[0].status,'completed');
  assert.equal((await sql`SELECT processed_status FROM interaction_events WHERE id=${event}`)[0].processed_status,'seen');
  assert.equal(requests,6);assert.equal((await sql`SELECT content FROM interaction_events WHERE id=${event}`)[0].content,'Immutable source');
  const saved=await readInteractionProcessingPlan(owner,failed.id);
  assert.equal(saved.atomic_write_version,1);assert.equal(await readInteractionProcessingPlan(other,failed.id),null);
  const resume={userId:owner,jobId:failed.id,attempt:1,commandId:randomUUID(),acknowledgedUnknown:true,decision:'resume_plan',planHash:saved.plan_hash};
  await assert.rejects(closeInteractionProcessingReview({...resume,planHash:'0'.repeat(64)}),/review_plan_changed/);
  const approvals=await Promise.all([closeInteractionProcessingReview(resume),closeInteractionProcessingReview(resume)]);
  assert.equal(approvals.filter(result=>result.replayed).length,1);
  const resumed=await runPendingInteractionProcessingJobs({userId:owner});assert.equal(resumed.completed,1);
  assert.equal(requests,6);
  assert.equal((await sql`SELECT count(*)::int n FROM interaction_notes WHERE metadata->>'processingJobId'=${failed.id}`)[0].n,1);
  assert.equal((await sql`SELECT status FROM interaction_processing_jobs WHERE id=${failed.id}`)[0].status,'completed');
  assert.equal((await closeInteractionProcessingReview(resume)).replayed,true);
  await assert.rejects(closeInteractionProcessingReview({...resume,decision:'keep_results_end'}),/review_command_conflict/);
  const unchanged=await readInteractionProcessingPlan(owner,failed.id);assert.equal(unchanged.plan_hash,saved.plan_hash);assert.deepEqual(unchanged.payload,saved.payload);
  const blockedPlan=await readInteractionProcessingPlan(owner,failedCompletion.id);
  await sql`UPDATE interaction_events SET conversation_id='policy-fixture' WHERE id=${event}`;
  await upsertInteractionSourcePolicy({userId:owner,platform:'wechat',sourceId:'policy-fixture',sourceName:'fixture',policy:'ignore'});
  await closeInteractionProcessingReview({...resume,jobId:failedCompletion.id,commandId:randomUUID(),planHash:blockedPlan.plan_hash});
  const beforeDenied=await counts();const denied=await runPendingInteractionProcessingJobs({userId:owner});assert.equal(denied.failed,1);
  assert.deepEqual(await counts(),beforeDenied);assert.equal(requests,6);
  assert.equal((await sql`SELECT status FROM interaction_processing_jobs WHERE id=${failedCompletion.id}`)[0].status,'needs_review');
  console.log(JSON.stringify({lateSnapshotFailureRollsBackAll:true,completionFailureRollsBackAll:true,concurrentScopeIsolation:true,
    realProcessCrashRollsBackNestedWrites:true,realProcessorSuccess:true,committed,modelRequests:requests,rawSourceUnchanged:true,
    savedPlanImmutable:true,ownerResumeReplayOnce:true,resumedWithoutModelRequest:true,policyChangeDeniesWrites:true,policyEditSerializedPerOwner:true}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closePostgresDb();await sql.end();}
