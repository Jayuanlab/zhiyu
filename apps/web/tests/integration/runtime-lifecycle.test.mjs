import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
const execute=vi.hoisted(()=>vi.fn());
const plan=vi.hoisted(()=>vi.fn(()=>{throw Error('Unexpected model planner');}));
const propose=vi.hoisted(()=>vi.fn(()=>{throw Error('Unexpected loop proposal');}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/workshops/executor',()=>({executeWorkshopAgent:execute}));
vi.mock('@/lib/workshops/directive-planner',()=>({planWorkshopDirective:plan}));
vi.mock('@/lib/workshops/loop-service',async importOriginal=>({...await importOriginal(),proposeWorkshopLoopFromNaturalLanguage:propose}));
vi.mock('@/lib/workshops/outbox-wechat',()=>({autoSendWorkshopOutboxIfWhitelisted:()=>{throw Error('Unexpected external send');}}));
import {executeWorkshopRunLifecycle} from '@/lib/workshops/runtime';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {cancelWorkRun} from '@/lib/work-runtime/cancel-run';
import {getWorkshop} from '@/lib/workshops/service';
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {captureRunOutput} from '@/lib/work-runtime/run-output';
import {applyOutputStep} from '@/lib/work-runtime/output-step';
import {consumeOwnedWorkRuns} from '@/lib/work-runtime/run-consumer';
import {captureRunPlan,applyRunPlanStep} from '@/lib/work-runtime/run-plan';
import {createOutboxDraft} from '@/lib/workshops/service';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {closePostgresDb} from '@/lib/db/adapters/postgres';
let client;
beforeAll(()=>{
  const url=new URL(process.env.ZHIYU_TEST_DATABASE_URL??'');
  if(!['localhost','127.0.0.1'].includes(url.hostname)||!/^\/zhiyu_test_[a-f0-9]{32}$/.test(url.pathname))throw Error('Random isolated PostgreSQL required');
  client=postgres(url.toString(),{max:2});
});
afterAll(async()=>{await closePostgresDb();await client?.end();});
async function fixture(leaseMs=1500,claimRun=true){
  const userId=randomUUID(),workId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},${`${userId}@runtime.invalid`})`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'runtime integration','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${workId},'queued')`;
  const claim=claimRun?await claimWorkshopExecution({userId,workshopId:workId,runId,workerId:'runtime-test',leaseMs}):null;
  if(claimRun)expect(claim.state).toBe('claimed');
  return {userId,workId,runId,input:{userId,workshop:await getWorkshop(userId,workId),run:{id:runId},executionLease:claim?.lease,executionLeaseMs:leaseMs}};
}
describe('actual lifecycle and database with simulated model transport',()=>{
  it('does not fall back to another model execution after a persisted plan action fails',async()=>{
    const f=await fixture(30000),id=randomUUID();
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${id},${f.workId},${f.runId},'proposal')`;
    await captureRunPlan(f.input.executionLease,{directive:{id,content:'proposal',scope:'current_run',priority:0},directiveIds:[id],plan:{action:'create_loop_task',reason:'Recurring',confidence:0.9,model:'fake'},duplicateLoop:null});
    propose.mockReset();propose.mockRejectedValue(Error('proposal unavailable'));execute.mockClear();plan.mockClear();
    await executeWorkshopRunLifecycle(f.input);
    expect(execute).not.toHaveBeenCalled();expect(plan).not.toHaveBeenCalled();
    expect((await client`SELECT status,error FROM workshop_runs WHERE id=${f.runId}`)[0]).toMatchObject({status:'failed',error:'proposal unavailable'});
    expect((await client`SELECT status FROM workshop_directives WHERE id=${id}`)[0].status).toBe('active');
  });
  it('includes a replayed planning event only once in executor observations',async()=>{
    const f=await fixture(30000),id=randomUUID();
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${id},${f.workId},${f.runId},'observe')`;
    await captureRunPlan(f.input.executionLease,{directive:{id,content:'observe',scope:'current_run',priority:0},directiveIds:[id],plan:{action:'run_once',reason:'Observe',confidence:0.9,model:'fake'},duplicateLoop:null});
    const event=await applyRunPlanStep(f.input.executionLease,'planned',async({append})=>append({workshopId:f.workId,runId:f.runId,type:'directive_planned',title:'saved plan'}));
    execute.mockClear();plan.mockClear();
    execute.mockImplementation(async input=>{
      expect(input.events.filter(item=>item.id===event.id)).toHaveLength(1);
      return {status:'success',output:'observed',structured:{},toolCallCount:0,durationMs:1};
    });
    await executeWorkshopRunLifecycle(f.input);
    expect(execute).toHaveBeenCalledTimes(1);expect(plan).not.toHaveBeenCalled();
    expect((await client`SELECT status FROM workshop_runs WHERE id=${f.runId}`)[0].status).toBe('completed');
  });
  it('reuses the original loop proposal command after response loss instead of reclassifying its own loop',async()=>{
    const f=await fixture(30000),id=randomUUID(),loopId=randomUUID();
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${id},${f.workId},${f.runId},'Daily observation')`;
    await captureRunPlan(f.input.executionLease,{directive:{id,content:'Daily observation',scope:'current_run',priority:0},directiveIds:[id],plan:{action:'create_loop_task',reason:'Recurring observation',taskIntent:'Daily observation',confidence:0.9,model:'fake'},duplicateLoop:null});
    // A proposal command already persisted this Loop before its response was lost.
    await client`INSERT INTO loops(id,user_id,workshop_id,name,goal) VALUES (${loopId},${f.userId},${f.workId},'Daily observation','Daily observation')`;
    propose.mockClear();plan.mockClear();execute.mockClear();
    propose.mockImplementationOnce(async()=>{throw new ExecutionLeaseError('lease_lost');});
    propose.mockImplementationOnce(async()=>({loop:{id:loopId,name:'Daily observation'}}));
    await expect(executeWorkshopRunLifecycle(f.input)).rejects.toMatchObject({code:'lease_lost'});
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
    expect(await consumeOwnedWorkRuns({userId:f.userId,workerId:'proposal-restart'})).toMatchObject([{state:'completed'}]);
    expect(propose).toHaveBeenCalledTimes(2);
    expect(propose.mock.calls[0][0].commandId).toBe(propose.mock.calls[1][0].commandId);
    expect(plan).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
    expect((await client`SELECT output_summary FROM workshop_runs WHERE id=${f.runId}`)[0].output_summary).toBe('Created paused task proposal: Daily observation');
    expect((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${f.workId}`)[0].n).toBe(1);
  });
  it.each(['ask_clarification','ignore_duplicate','spawn_subtask','run_once','create_loop_task'])('captures and applies a fresh %s plan under the current lease',async action=>{
    const f=await fixture(30000),id=randomUUID();
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${id},${f.workId},${f.runId},'fresh directive')`;
    if(action==='create_loop_task')await client`INSERT INTO loops(user_id,workshop_id,name,goal) VALUES (${f.userId},${f.workId},'fresh directive','fresh directive')`;
    plan.mockClear();execute.mockClear();
    plan.mockResolvedValue({action,reason:'Plan explanation',clarificationQuestion:'Which target?',confidence:0.9,model:'fake',subtasks:[{title:'Observe',prompt:'Observe facts'}]});
    execute.mockResolvedValue({status:'success',output:'fresh result',structured:{},toolCallCount:0,durationMs:1});
    await executeWorkshopRunLifecycle({...f.input,triggerReason:{type:'directive',directiveId:id,content:'fresh directive'}});
    expect(plan).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(['spawn_subtask','run_once'].includes(action)?1:0);
    expect((await client`SELECT status FROM workshop_runs WHERE id=${f.runId}`)[0].status).toBe('completed');
    expect((await client`SELECT count(*)::int AS n FROM workshop_run_plans WHERE run_id=${f.runId}`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='directive_planned'`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${f.workId}`)[0].n).toBe(action==='ask_clarification'?1:0);
  });
  it.each(['output','plan'])('independent CLI process resumes a %s checkpoint with external transports disabled',async kind=>{
    const f=await fixture(30000);
    if(kind==='plan'){
      const id=randomUUID();
      await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${id},${f.workId},${f.runId},'CLI directive')`;
      await captureRunPlan(f.input.executionLease,{directive:{id,content:'CLI directive',scope:'current_run',priority:0},directiveIds:[id],plan:{action:'ask_clarification',reason:'Clarify',clarificationQuestion:'CLI checkpoint',confidence:0.9,model:'fake'},duplicateLoop:null});
    }else{
    await captureRunOutput(f.input.executionLease,{result:{status:'success',output:'CLI checkpoint',structured:{},toolCallCount:0,durationMs:1},directiveIds:[]});
    }
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx','--conditions=react-server','--import','./tests/integration/deny-external-transports.mjs','scripts/consume-work-runs.mjs',`--userId=${f.userId}`,'--once'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',TAURI_MODE:'false',IS_TAURI:'false',WORK_HARNESS_EVOLUTION_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      const timer=setTimeout(()=>{child.kill();reject(Error(`CLI timeout: ${output}`));},30000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(`CLI exit ${code}: ${output}`));});
    });
    expect(output).toContain('"state":"completed"');
    expect((await client`SELECT status,output_summary FROM workshop_runs WHERE id=${f.runId}`)[0]).toMatchObject({status:'completed',output_summary:'CLI checkpoint'});
  });
  it('resumes a committed clarification without planning again or duplicating its draft',async()=>{
    const f=await fixture(30000),id=randomUUID(),late=randomUUID();
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${id},${f.workId},${f.runId},'original question')`;
    await captureRunPlan(f.input.executionLease,{directive:{id,content:'original question',scope:'current_run',priority:0},directiveIds:[id],plan:{action:'ask_clarification',reason:'Missing target',clarificationQuestion:'Which target?',confidence:0.9,model:'fake'},duplicateLoop:null});
    await applyRunPlanStep(f.input.executionLease,'clarification',async({append})=>{
      await createOutboxDraft({workshopId:f.workId,runId:f.runId,channel:'wechat_desktop',recipientName:null,message:'Which target?',status:'draft',confidence:90,riskLevel:'low',boundaryResult:{status:'needs_owner_input'}});
      return append({workshopId:f.workId,runId:f.runId,type:'directive_needs_clarification',title:'saved clarification'});
    });
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${late},${f.workId},${f.runId},'later question')`;
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
    plan.mockClear();execute.mockClear();
    plan.mockImplementation(()=>{throw Error('Saved plan must not be regenerated');});
    execute.mockImplementation(()=>{throw Error('Clarification must not invoke executor');});
    expect(await consumeOwnedWorkRuns({userId:f.userId,workerId:'plan-restart'})).toMatchObject([{state:'completed'}]);
    expect(plan).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
    expect((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${f.workId}`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='directive_needs_clarification'`)[0].n).toBe(1);
    expect((await client`SELECT status FROM workshop_directives WHERE id=${id}`)[0].status).toBe('consumed');
    expect((await client`SELECT status FROM workshop_directives WHERE id=${late}`)[0].status).toBe('active');
  });
  it('consumes queued commands once under concurrent host cycles',async()=>{
    const f=await fixture(30000,false);
    execute.mockClear();execute.mockResolvedValue({status:'success',output:'consumed queue',structured:{},toolCallCount:0,durationMs:1});
    const results=await Promise.all(['consumer-one','consumer-two'].map(workerId=>consumeOwnedWorkRuns({userId:f.userId,workerId,leaseMs:30000})));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.flat().filter(item=>item.state==='completed')).toHaveLength(1);
    expect((await client`SELECT status FROM workshop_runs WHERE id=${f.runId}`)[0].status).toBe('completed');
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='execution_claimed'`)[0].n).toBe(1);
  });
  it('consumer respects owner, pause, pre-abort and batch limits',async()=>{
    const f=await fixture(30000,false);
    execute.mockClear();execute.mockResolvedValue({status:'success',output:'queue',structured:{},toolCallCount:0,durationMs:1});
    expect(await consumeOwnedWorkRuns({userId:randomUUID(),workerId:'other'})).toEqual([]);
    await client`UPDATE workshops SET status='paused' WHERE id=${f.workId}`;
    expect(await consumeOwnedWorkRuns({userId:f.userId,workerId:'paused'})).toEqual([]);
    await client`UPDATE workshops SET status='active' WHERE id=${f.workId}`;
    expect(await consumeOwnedWorkRuns({userId:f.userId,workerId:'aborted',signal:AbortSignal.abort()})).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    await client`INSERT INTO workshop_runs(workshop_id,status) VALUES (${f.workId},'queued')`;
    expect(await consumeOwnedWorkRuns({userId:f.userId,workerId:'batch',limit:1})).toHaveLength(1);
    expect((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${f.workId} AND status='queued'`)[0].n).toBe(1);
    expect(await consumeOwnedWorkRuns({userId:f.userId,workerId:'next',limit:1})).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('consumer resumes captured output but quarantines expired external effects',async()=>{
    const f=await fixture(30000);
    await captureRunOutput(f.input.executionLease,{result:{status:'success',output:'recovered by consumer',structured:{},toolCallCount:0,durationMs:1},directiveIds:[]});
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
    execute.mockClear();execute.mockImplementation(()=>{throw Error('Recovery must use checkpoint');});
    expect(await consumeOwnedWorkRuns({userId:f.userId,workerId:'restart'})).toMatchObject([{runId:f.runId,state:'completed'}]);
    const effect=await fixture(30000);
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second',effect_started=true WHERE workshop_id=${effect.workId}`;
    expect(await consumeOwnedWorkRuns({userId:effect.userId,workerId:'effect-restart'})).toMatchObject([{runId:effect.runId,state:'needs_review'}]);
    expect((await client`SELECT status FROM workshop_runs WHERE id=${effect.runId}`)[0].status).toBe('needs_review');
    expect(execute).not.toHaveBeenCalled();
  });
  it('resumes a saved output after lease expiry without rerunning the model or committed steps',async()=>{
    const f=await fixture(30000);
    const directiveId=randomUUID(),lateDirectiveId=randomUUID();
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${directiveId},${f.workId},${f.runId},'original directive')`;
    const event={type:'replayed_observation',title:'saved fact',body:'unchanged observation'};
    const result={status:'success',output:'saved output',structured:{logEvents:[event],memoryCandidates:[{content:'saved memory observation',kind:'finding',confidence:70}],outboxDrafts:[{message:'suppressed without justification'}]},toolCallCount:0,durationMs:1};
    await captureRunOutput(f.input.executionLease,{result,directiveIds:[directiveId]});
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content) VALUES (${lateDirectiveId},${f.workId},${f.runId},'arrived after capture')`;
    await applyOutputStep(f.input.executionLease,'logEvents',0,event,({append})=>append({workshopId:f.workId,runId:f.runId,...event}));
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${f.workId}`;
    const claim=await claimWorkshopExecution({userId:f.userId,workshopId:f.workId,runId:f.runId,workerId:'replacement',leaseMs:30000});
    expect(claim.state).toBe('claimed');
    execute.mockClear();plan.mockClear();execute.mockImplementation(()=>{throw Error('Saved result must bypass model');});
    await executeWorkshopRunLifecycle({...f.input,executionLease:claim.lease,triggerReason:{type:'directive',directiveId,content:'original directive'}});
    expect(execute).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect((await client`SELECT status FROM workshop_directives WHERE id=${directiveId}`)[0].status).toBe('consumed');
    expect((await client`SELECT status FROM workshop_directives WHERE id=${lateDirectiveId}`)[0].status).toBe('active');
    expect((await client`SELECT status,output_summary FROM workshop_runs WHERE id=${f.runId}`)[0]).toMatchObject({status:'completed',output_summary:'saved output'});
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='replayed_observation'`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${f.userId}`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM workshop_output_steps WHERE run_id=${f.runId}`)[0].n).toBe(3);
    expect((await client`SELECT worker_id FROM workshop_run_outputs WHERE run_id=${f.runId}`)[0].worker_id).toBe('runtime-test');
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='run_output_captured'`)[0].n).toBe(1);
  });
  it('finishes a captured model failure without model retry or structured actions',async()=>{
    const f=await fixture(30000);
    await captureRunOutput(f.input.executionLease,{result:{status:'error',output:'saved failure',error:'transport failed',structured:{memoryCandidates:[{content:'must not persist'}]},toolCallCount:0,durationMs:1},directiveIds:[]});
    execute.mockClear();execute.mockImplementation(()=>{throw Error('Failure checkpoint must bypass model');});
    await executeWorkshopRunLifecycle(f.input);
    expect(execute).not.toHaveBeenCalled();
    expect((await client`SELECT status,error FROM workshop_runs WHERE id=${f.runId}`)[0]).toMatchObject({status:'failed',error:'transport failed'});
    expect((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${f.userId}`)[0].n).toBe(0);
  });
  it('renews during a long model call and atomically completes with a snapshot',async()=>{
    const f=await fixture();
    execute.mockImplementation(async input=>{
      expect(resolveExecutionLease()).toEqual(input.executionLease);
      await sleep(2100);
      return {status:'success',output:'done',structured:{logEvents:[{type:'runtime_output_observation',title:'observed',body:'fact'}],memoryCandidates:[{content:'remembered observation',kind:'finding',confidence:70}],outboxDrafts:[{message:'suppressed without justification'}],nextWakeupSuggestion:{delayMinutes:30,reason:'observe later'}},toolCallCount:0,durationMs:2100};
    });
    await executeWorkshopRunLifecycle(f.input);
    const [run]=await client`SELECT status,completion_json FROM workshop_runs WHERE id=${f.runId}`;
    expect(run.status).toBe('completed');expect(run.completion_json.execution.workerId).toBe('runtime-test');
    expect((await client`SELECT count(*)::int AS n FROM workshop_output_steps WHERE run_id=${f.runId} AND step_kind='logEvents'`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM workshop_output_steps WHERE run_id=${f.runId} AND step_kind='memoryCandidates'`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM workshop_output_steps WHERE run_id=${f.runId} AND step_kind IN ('outboxDrafts','nextWakeupSuggestion')`)[0].n).toBe(2);
    expect((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${f.userId}`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='runtime_output_observation'`)[0].n).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE scope_id=${f.workId}`)[0].n).toBe(1);
    const before=await client`SELECT heartbeat_at,phase FROM workshop_execution_leases WHERE workshop_id=${f.workId}`;
    expect(before[0].phase).toBe('idle');await sleep(650);
    expect(await client`SELECT heartbeat_at,phase FROM workshop_execution_leases WHERE workshop_id=${f.workId}`).toEqual(before);
  });
  it('persists failure without applying partial structured memory or wakeup actions',async()=>{
    const f=await fixture();
    execute.mockResolvedValue({status:'error',output:'partial',error:'model failed',structured:{memories:[{content:'must not persist'}],outboxDrafts:[{message:'must not send'}],nextWakeupSuggestion:{delayMinutes:30}},toolCallCount:1,durationMs:1});
    await executeWorkshopRunLifecycle(f.input);
    expect((await client`SELECT status FROM workshop_runs WHERE id=${f.runId}`)[0].status).toBe('failed');
    expect((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${f.userId}`)[0].n).toBe(0);
    expect((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${f.workId}`)[0].n).toBe(0);
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='next_wakeup_suggested'`)[0].n).toBe(0);
  });
  it('owner cancellation interrupts renewal and rejects late model output',async()=>{
    const f=await fixture();let started;const ready=new Promise(resolve=>{started=resolve;});let release;
    const output=new Promise(resolve=>{release=resolve;});let controller;
    execute.mockImplementation(async input=>{controller=input.abortController;started();return output;});
    const running=executeWorkshopRunLifecycle(f.input);
    const outcome=running.then(()=>({ok:true}),error=>({error}));
    await ready;
    await cancelWorkRun({userId:f.userId,workId:f.workId,runId:f.runId,commandId:randomUUID()});
    for(let i=0;i<30&&!controller.signal.aborted;i++)await sleep(100);
    expect(controller.signal.aborted).toBe(true);
    release({status:'success',output:'late',structured:{nextWakeupSuggestion:{delayMinutes:30}},toolCallCount:0,durationMs:1});
    expect((await outcome).error).toMatchObject({code:'lease_lost'});
    expect((await client`SELECT status FROM workshop_runs WHERE id=${f.runId}`)[0].status).toBe('cancelled');
    expect((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${f.runId} AND type='run_completed'`)[0].n).toBe(0);
  });
});
