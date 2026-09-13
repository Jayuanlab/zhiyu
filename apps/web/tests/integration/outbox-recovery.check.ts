import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import type postgres from 'postgres';
import {recoverOwnedOutbox} from '@/lib/work-runtime/outbox-recovery';
import {beginOutboxAttempt,outboxContentHash} from '@/lib/work-runtime/outbox-attempt';
import {getWorkshopOutboxItem} from '@/lib/workshops/service';
import {resolveWorkOutbox} from '@/lib/work-runtime/outbox-resolution';
import {withFakeWechat} from './outbox-send-production.mjs';

export async function checkOutboxRecovery(client:postgres.Sql){
  const userId=randomUUID(),workId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'recovery@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission,autonomy_level,boundary_policy) VALUES (${workId},${userId},'recovery','test','auto','{"externalMessages":"auto","allowedRecipients":["recipient"],"requireSourcesForOutbox":false,"minConfidenceToSend":0,"minConfidenceToDraft":0}'::jsonb)`;
  async function fixture(){
    const outboxId=randomUUID();
    await client`INSERT INTO workshop_outbox(id,workshop_id,recipient_name,message,confidence,risk_level) VALUES (${outboxId},${workId},'recipient','test',100,'low')`;
    const item=(await getWorkshopOutboxItem(workId,outboxId))!;
    const expectedContentHash=outboxContentHash(item);
    const {attempt}=await beginOutboxAttempt({userId,workId,outboxId,commandId:randomUUID(),expectedContentHash});
    return {userId,workId,outboxId,attemptId:attempt.id,expectedContentHash};
  }
  const first=await fixture();let queries=0;
  const provider:NonNullable<Parameters<typeof recoverOwnedOutbox>[1]>={
    status:async()=>{queries++;return {ok:true,status:'sent',result:{sent:true}};},
    resolve:async()=>{throw Error('No owner decision exists');},
  };
  assert.equal((await recoverOwnedOutbox({userId:randomUUID(),workerId:'other'},provider)).claimed,0);
  const concurrent=await Promise.all(['one','two'].map(workerId=>recoverOwnedOutbox({userId,workerId},provider)));
  assert.equal(concurrent.reduce((n,r)=>n+r.settled,0),1);assert.equal(queries,1);
  assert.equal((await getWorkshopOutboxItem(workId,first.outboxId))?.status,'sent');
  const unknown=await fixture();
  const missing:typeof provider={...provider,status:async()=>({ok:true,status:'not_found'})};
  assert.equal((await recoverOwnedOutbox({userId,workerId:'missing'},missing)).unconfirmed,1);
  const row=(await client`SELECT * FROM workshop_outbox_recovery WHERE attempt_id=${unknown.attemptId}`)[0];
  assert.equal(row.detail,'not_found');assert.equal(row.failures,1);assert(row.last_checked_at);assert(row.next_check_at);
  assert.equal((await recoverOwnedOutbox({userId,workerId:'backoff'},provider)).claimed,0);
  await client`UPDATE workshop_outbox_recovery SET next_check_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()+interval '90 seconds',token=${randomUUID()} WHERE attempt_id=${unknown.attemptId}`;
  assert.equal((await recoverOwnedOutbox({userId,workerId:'live-claim'},provider)).claimed,0);
  await client`UPDATE workshop_outbox_recovery SET lease_until=clock_timestamp()-interval '1 second' WHERE attempt_id=${unknown.attemptId}`;
  assert.equal((await recoverOwnedOutbox({userId,workerId:'restart'},provider)).settled,1);
  const pending=await fixture();
  await recoverOwnedOutbox({userId,workerId:'observe'},missing);
  const ids:string[]=[];
  await assert.rejects(resolveWorkOutbox({...pending,commandId:randomUUID(),decision:'not_sent',evidence:'Owner verified the complete conversation'},async input=>{ids.push(input.resolutionId);throw Error('lost response');}),/lost response/);
  const resumed=await recoverOwnedOutbox({userId,workerId:'resume'},{...provider,resolve:async input=>{ids.push(input.resolutionId);return {ok:true,status:'not_sent',result:{ok:true,resolution:{decision:'not_sent'}}};}});
  assert.equal(resumed.settled,1);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
  assert.equal((await getWorkshopOutboxItem(workId,pending.outboxId))?.status,'failed');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${workId} AND boundary_result->>'resolvedFromOutboxId'=${pending.outboxId}`)[0].n,1);
  assert.equal((await recoverOwnedOutbox({userId,workerId:'again'},provider)).claimed,0);
  const restarted=await fixture();
  await withFakeWechat(async (env:Record<string,string>,state:{sends:number;queries:number})=>{
    async function cli(){
      return new Promise<string>((resolve,reject)=>{
        const child=spawn(process.execPath,['--import','tsx','--conditions=react-server','scripts/recover-outbox.mjs',`--userId=${userId}`,'--once'],{cwd:process.cwd(),env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
        let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
        const timer=setTimeout(()=>{child.kill();reject(Error(`Recovery CLI timed out: ${output}`));},30000);
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.once('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(`Recovery CLI exit ${code}: ${output}`));});
      });
    }
    assert.match(await cli(),/"unconfirmed":1/);assert.equal(state.queries,1);assert.equal(state.sends,0);
    await client`UPDATE workshop_outbox_recovery SET next_check_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '1 second',token=${randomUUID()} WHERE attempt_id=${restarted.attemptId}`;
    assert.match(await cli(),/"unconfirmed":1/);assert.equal(state.queries,2);assert.equal(state.sends,0);
    const recovered=(await client`SELECT failures,token,lease_until FROM workshop_outbox_recovery WHERE attempt_id=${restarted.attemptId}`)[0];
    assert.equal(recovered.failures,2);assert.equal(recovered.token,null);assert.equal(recovered.lease_until,null);
  });
  await client`UPDATE workshop_outbox_recovery SET next_check_at=clock_timestamp()+interval '1 day' WHERE attempt_id IN (SELECT id FROM workshop_outbox_attempts WHERE owner_id=${userId})`;
  await fixture();await fixture();
  const cancelled=new AbortController();let cancelledQueries=0;
  const cancelProvider:typeof provider={...provider,status:async()=>{cancelledQueries++;cancelled.abort();return {ok:true,status:'sent',result:{sent:true}};}};
  const cancelledResult=await recoverOwnedOutbox({userId,workerId:'cancel-between-items',signal:cancelled.signal},cancelProvider);
  assert.equal(cancelledResult.claimed,1);assert.equal(cancelledResult.settled,1);assert.equal(cancelledQueries,1);
  assert.deepEqual(await recoverOwnedOutbox({userId,workerId:'already-cancelled',signal:cancelled.signal},cancelProvider),{claimed:0,settled:0,unconfirmed:0,errors:0});
  assert.equal(cancelledQueries,1);
  return {name:'outbox recovery: ownership, concurrent claims, backoff, expired claim, persisted owner decision replay and cancellation between items',passed:true};
}
