import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {getWechatDesktopSendStatus,resolveWechatDesktopSend} from '@/lib/wechat-desktop/client';
import {reconcileOutboxAttempt} from './outbox-dispatch';
import {resolveWorkOutbox} from './outbox-resolution';
import {resolveExecutionLease} from './execution-context';

type Provider={status:typeof getWechatDesktopSendStatus;resolve:typeof resolveWechatDesktopSend};
/** Host observer only: query existing sends and resume already persisted owner
 * decisions. No preview, new send, model or new approval is available here. */
export async function recoverOwnedOutbox(input:{userId:string;workerId:string;limit?:number;signal?:AbortSignal},provider:Provider={status:getWechatDesktopSendStatus,resolve:resolveWechatDesktopSend}){
  if(resolveExecutionLease())throw Error('Outbox observation must run outside producer execution');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.userId)||!input.workerId?.trim()||input.workerId.length>256)throw Error('Invalid recovery owner/worker');
  const limit=input.limit??10;if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Invalid recovery limit');
  const report={claimed:0,settled:0,unconfirmed:0,errors:0};
  if(input.signal?.aborted)return report;
  await db.execute(sql`INSERT INTO workshop_outbox_recovery(attempt_id) SELECT a.id FROM workshop_outbox_attempts a JOIN workshops w ON w.id=a.workshop_id WHERE a.owner_id=${input.userId}::uuid AND w.user_id=${input.userId}::uuid AND (a.status IN ('sending','unknown') OR EXISTS(SELECT 1 FROM workshop_outbox_resolutions x WHERE x.attempt_id=a.id AND x.status='pending')) ON CONFLICT DO NOTHING`);
  for(let i=0;i<limit;i++){
    if(input.signal?.aborted)break;
    const token=randomUUID();
    const rows=await db.execute(sql`WITH due AS (SELECT r.attempt_id FROM workshop_outbox_recovery r JOIN workshop_outbox_attempts a ON a.id=r.attempt_id JOIN workshops w ON w.id=a.workshop_id WHERE a.owner_id=${input.userId}::uuid AND w.user_id=${input.userId}::uuid AND r.next_check_at<=clock_timestamp() AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp()) AND (a.status IN ('sending','unknown') OR EXISTS(SELECT 1 FROM workshop_outbox_resolutions x WHERE x.attempt_id=a.id AND x.status='pending')) ORDER BY r.next_check_at,r.attempt_id FOR UPDATE OF r SKIP LOCKED LIMIT 1) UPDATE workshop_outbox_recovery r SET token=${token}::uuid,worker_id=${input.workerId},lease_until=clock_timestamp()+interval '90 seconds' FROM due WHERE r.attempt_id=due.attempt_id RETURNING r.attempt_id`);
    if(!rows[0])break;
    report.claimed++;
    const attemptId=rows[0].attempt_id;let detail='provider_result_unconfirmed',settled=false;
    const status:typeof getWechatDesktopSendStatus=async id=>{input.signal?.throwIfAborted();try{const result=await provider.status(id);detail=result.status;return result;}catch(error){detail=error instanceof Error?error.message:String(error);throw error;}};
    const resolve:Provider['resolve']=async request=>{input.signal?.throwIfAborted();return provider.resolve(request);};
    try{
      input.signal?.throwIfAborted();
      const attempts=await db.execute(sql`SELECT * FROM workshop_outbox_attempts WHERE id=${attemptId}::uuid AND owner_id=${input.userId}::uuid`);
      const attempt=attempts[0];
      const pending=await db.execute(sql`SELECT request_json FROM workshop_outbox_resolutions WHERE attempt_id=${attemptId}::uuid AND owner_id=${input.userId}::uuid AND status='pending' LIMIT 1`);
      if(pending[0]){
        const request=pending[0].request_json;
        const result=await resolveWorkOutbox({userId:input.userId,workId:attempt.workshop_id,outboxId:attempt.outbox_id,attemptId,commandId:request.commandId,expectedContentHash:request.expectedContentHash,decision:request.decision,evidence:request.evidence},resolve,status);
        settled=result.status==='sent'||result.status==='failed';detail=settled?'owner_resolution_completed':'owner_kept_unknown';
      }else{
        const result=await reconcileOutboxAttempt({userId:input.userId,workId:attempt.workshop_id,outboxId:attempt.outbox_id},{status});
        settled=result.status==='sent'||result.status==='failed';
      }
      if(settled)report.settled++;else report.unconfirmed++;
    }catch(error){report.errors++;detail=error instanceof Error?error.message:String(error);}
    await db.execute(sql`UPDATE workshop_outbox_recovery SET last_checked_at=clock_timestamp(),next_check_at=CASE WHEN ${settled} THEN NULL ELSE clock_timestamp()+make_interval(secs=>LEAST(300,5*power(2,LEAST(failures,6)))::int) END,failures=CASE WHEN ${settled} THEN 0 ELSE LEAST(failures+1,1000000) END,detail=${detail.slice(0,1000)},lease_until=NULL,token=NULL WHERE attempt_id=${attemptId}::uuid AND token=${token}::uuid`);
  }
  return report;
}
