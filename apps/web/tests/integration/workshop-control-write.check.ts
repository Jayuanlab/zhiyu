import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {appendWorkshopEvent,createOutboxDraft} from '@/lib/workshops/service';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';

export async function checkWorkshopControlWrite(client:postgres.Sql){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'control-write@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'control write','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL)`;
  const claimed=await claimWorkshopExecution({userId,workshopId,runId,workerId:'control',leaseMs:30000});if(claimed.state!=='claimed')throw Error('not claimed');
  const scoped=<T>(work:()=>Promise<T>)=>withExecutionContext(claimed.lease,work);
  const event=await scoped(()=>appendWorkshopEvent({workshopId,type:'control_fixture',title:'中文事件',metadata:{actorId:'forged',execution:{token:999}}}));
  assert.equal(event.runId,runId);assert.equal(event.metadata.actorId,userId);assert.equal((event.metadata.execution as any).token,claimed.lease.token);
  await assert.rejects(scoped(()=>appendWorkshopEvent({workshopId:randomUUID(),type:'control_fixture',title:'wrong'})),{code:'invalid_lease'});
  await assert.rejects(scoped(()=>createOutboxDraft({workshopId,runId:randomUUID(),message:'wrong'})),{code:'invalid_lease'});
  await client.unsafe(`CREATE FUNCTION reject_control_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='outbox_draft' THEN RAISE EXCEPTION 'injected outbox event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_control_draft BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_control_draft()');
  try{
    await assert.rejects(scoped(()=>createOutboxDraft({workshopId,message:'不能留下半条草稿'})));
    await assert.rejects(createOutboxDraft({workshopId,message:'普通调用同样原子提交'}));
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${workshopId}`)[0].n,0);
  }finally{await client.unsafe('DROP TRIGGER reject_control_draft ON workshop_events');await client.unsafe('DROP FUNCTION reject_control_draft()');}
  const draft=await scoped(()=>createOutboxDraft({workshopId,message:'草稿与事件一起提交'}));
  assert.equal(draft.runId,runId);assert.equal(draft.message,'草稿与事件一起提交');
  const stored=(await client`SELECT metadata,run_id FROM workshop_events WHERE workshop_id=${workshopId} AND type='outbox_draft'`)[0];
  assert.equal(stored.run_id,runId);assert.equal(stored.metadata.outboxId,draft.id);assert.equal(stored.metadata.execution.token,claimed.lease.token);
  const counter=(await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq;
  await client.unsafe(`CREATE FUNCTION delay_control_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='outbox_draft' THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER delay_control_draft BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION delay_control_draft()');
  try{
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '1 second' WHERE workshop_id=${workshopId}`;
    await assert.rejects(scoped(()=>createOutboxDraft({workshopId,message:'超时写入必须回滚'})),{code:'lease_lost'});
  }finally{await client.unsafe('DROP TRIGGER delay_control_draft ON workshop_events');await client.unsafe('DROP FUNCTION delay_control_draft()');}
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${workshopId}`)[0].n,1);
  assert.equal((await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq,counter);
  await assert.rejects(scoped(()=>appendWorkshopEvent({workshopId,type:'control_fixture',title:'stale'})),{code:'lease_lost'});
  return {name:'actual event/outbox services: scoped provenance, cross-target denial, event failure atomic rollback, expired transaction rolls back draft/event/counter',passed:true};
}
