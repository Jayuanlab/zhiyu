import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {getWorkshop} from '@/lib/workshops/service';
import {scheduleWorkshopWakeupFromSuggestion} from '@/lib/workshops/heartbeat';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';

export async function checkWakeupSuggestion(client:postgres.Sql){
  const userId=randomUUID(),now=new Date('2026-09-07T02:00:00Z');
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'wakeup-suggestion@example.invalid')`;
  async function fixture(options:{enabled?:boolean;mode?:string;policy?:boolean;configured?:boolean;status?:string}={}){
    const workId=randomUUID(),runId=randomUUID();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'suggestion','test')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workId},${options.status??'running'},NULL)`;
    if(options.configured!==false)await client`INSERT INTO workshop_heartbeats(workshop_id,enabled,mode,scheduler_status,scheduler_error,lease_until,consecutive_failures,heartbeat_policy) VALUES (${workId},${options.enabled??true},${options.mode??'suggested'},'running','preserve',${new Date('2026-09-08T00:00:00Z').toISOString()},2,${JSON.stringify({allowAgentSuggestedWakeup:options.policy??true,minIntervalMinutes:15})}::jsonb)`;
    return {workshop:(await getWorkshop(userId,workId))!,runId,now,suggestion:{delayMinutes:1,reason:'下一次观测'}};
  }
  for(const [options,reason] of [[{configured:false},'not_configured'],[{enabled:false},'disabled'],[{mode:'cron'},'mode_locked'],[{policy:false},'policy_denied']] as const){
    const input=await fixture(options);assert.equal(await scheduleWorkshopWakeupFromSuggestion(input),null);
    const rows=await client`SELECT enabled,next_wakeup_at,mode FROM workshop_heartbeats WHERE workshop_id=${input.workshop.id}`;
    if(options.configured===false)assert.equal(rows.length,0);else{assert.equal(rows[0].next_wakeup_at,null);if('enabled' in options)assert.equal(rows[0].enabled,false);}
    const event=(await client`SELECT metadata FROM workshop_events WHERE run_id=${input.runId} AND type='heartbeat_skipped'`)[0];assert.equal(event.metadata.reasonCode,reason);
  }
  const paused=await fixture();await client`UPDATE workshops SET status='paused' WHERE id=${paused.workshop.id}`;
  assert.equal(await scheduleWorkshopWakeupFromSuggestion(paused),null);
  assert.equal((await client`SELECT metadata FROM workshop_events WHERE run_id=${paused.runId} AND type='heartbeat_skipped'`)[0].metadata.reasonCode,'work_inactive');
  const invalid=await fixture();assert.equal(await scheduleWorkshopWakeupFromSuggestion({...invalid,suggestion:{delayMinutes:0,reason:'invalid'}}),null);
  assert.equal((await client`SELECT metadata FROM workshop_events WHERE run_id=${invalid.runId} AND type='heartbeat_skipped'`)[0].metadata.reasonCode,'invalid_suggestion');
  const terminal=await fixture({status:'completed'});await assert.rejects(scheduleWorkshopWakeupFromSuggestion(terminal),{code:'invalid_command'});
  const input=await fixture();
  await client.unsafe(`CREATE FUNCTION reject_wakeup_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='heartbeat_scheduled' THEN RAISE EXCEPTION 'injected wakeup event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_wakeup_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_wakeup_event()');
  try{await assert.rejects(scheduleWorkshopWakeupFromSuggestion(input));}
  finally{await client.unsafe('DROP TRIGGER reject_wakeup_event ON workshop_events');await client.unsafe('DROP FUNCTION reject_wakeup_event()');}
  assert.equal((await client`SELECT next_wakeup_at FROM workshop_heartbeats WHERE workshop_id=${input.workshop.id}`)[0].next_wakeup_at,null);
  const results=await Promise.all([scheduleWorkshopWakeupFromSuggestion(input),scheduleWorkshopWakeupFromSuggestion({...input,workshop:{...input.workshop,id:input.workshop.id.toUpperCase(),userId:input.workshop.userId.toUpperCase()},runId:input.runId.toUpperCase()})]);
  assert.deepEqual(results[0],results[1]);assert.equal(results[0]!.nextWakeupAt!.toISOString(),'2026-09-07T02:15:00.000Z');
  assert.equal(results[0]!.schedulerStatus,'running');assert.equal(results[0]!.schedulerError,'preserve');assert.equal(results[0]!.leaseUntil!.toISOString(),'2026-09-08T00:00:00.000Z');assert.equal(results[0]!.consecutiveFailures,2);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${input.runId} AND type='heartbeat_scheduled'`)[0].n,1);
  await assert.rejects(scheduleWorkshopWakeupFromSuggestion({...input,suggestion:{delayMinutes:60}}),{code:'payload_conflict'});
  const earlier=await fixture();await client`UPDATE workshop_heartbeats SET next_wakeup_at='2026-09-07T02:05:00Z' WHERE workshop_id=${earlier.workshop.id}`;
  assert.equal((await scheduleWorkshopWakeupFromSuggestion(earlier))!.nextWakeupAt!.toISOString(),'2026-09-07T02:05:00.000Z');
  const controlled=await fixture({status:'queued'});
  const claim=await claimWorkshopExecution({userId,workshopId:controlled.workshop.id,runId:controlled.runId,workerId:'wakeup',leaseMs:30000});if(claim.state!=='claimed')throw Error('not claimed');
  await assert.rejects(scheduleWorkshopWakeupFromSuggestion(controlled),{code:'lease_lost'});
  const scoped=<T>(work:()=>Promise<T>)=>withExecutionContext(claim.lease,work);
  await client.unsafe(`CREATE FUNCTION delay_wakeup_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='heartbeat_scheduled' THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER delay_wakeup_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION delay_wakeup_event()');
  try{
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '1 second' WHERE workshop_id=${controlled.workshop.id}`;
    await assert.rejects(scoped(()=>scheduleWorkshopWakeupFromSuggestion(controlled)),{code:'lease_lost'});
  }finally{await client.unsafe('DROP TRIGGER delay_wakeup_event ON workshop_events');await client.unsafe('DROP FUNCTION delay_wakeup_event()');}
  assert.equal((await client`SELECT next_wakeup_at FROM workshop_heartbeats WHERE workshop_id=${controlled.workshop.id}`)[0].next_wakeup_at,null);
  const recovered=await claimWorkshopExecution({userId,workshopId:controlled.workshop.id,runId:controlled.runId,workerId:'replacement',leaseMs:30000});if(recovered.state!=='claimed')throw Error('not recovered');
  await withExecutionContext(recovered.lease,()=>scheduleWorkshopWakeupFromSuggestion(controlled));
  const event=(await client`SELECT metadata FROM workshop_events WHERE run_id=${controlled.runId} AND type='heartbeat_scheduled'`)[0];assert.equal(event.metadata.execution.token,recovered.lease.token);
  return {name:'wakeup suggestion ledger: disabled/unconfigured/fixed policy boundaries, state and lease preservation, earlier time preserved, atomic retry/replay and stale worker rollback/recovery',passed:true};
}
