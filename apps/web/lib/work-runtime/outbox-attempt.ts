import {createHash,randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {workshops,workshopOutbox,type WorkshopOutboxItem,type Workshop} from '@/lib/db/schema';
import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import {evaluateWorkshopOutboxBoundary,parseAllowedRecipientsFromEnv} from '@/lib/workshops/outbox-boundary';
import {getWorkshopBoundaryPolicy} from '@/lib/workshops/boundary-policy';
import {canonicalCommandJson} from './command-payload';
import {resolveExecutionLease} from './execution-context';
import {withExecutionBusinessTransaction} from './execution-lease';
import {WorkCommandConflict} from './command-ledger';
import {db as database} from '@/lib/db/client';
import {closeTerminalOutboxReviews} from '@/lib/workshops/outbox-reviews';

/** Read an owned existing attempt. This grants no permission to create a send. */
export async function readOutboxAttempt(input:{userId:string;workId:string;outboxId:string}){
  const rows=await database.execute(sql`SELECT a.* FROM workshop_outbox_attempts a JOIN workshops w ON w.id=a.workshop_id WHERE a.owner_id=${input.userId}::uuid AND w.user_id=${input.userId}::uuid AND a.workshop_id=${input.workId}::uuid AND a.outbox_id=${input.outboxId}::uuid AND a.status IN ('sending','unknown','sent') ORDER BY a.created_at DESC LIMIT 1`);
  if(!rows[0])throw new WorkCommandConflict('not_found');
  return rows[0];
}

function hash(value:unknown){return createHash('sha256').update(canonicalCommandJson(value as any)).digest('hex');}
function policyFingerprint(work:Workshop){return hash({policy:getWorkshopBoundaryPolicy(work),autonomyLevel:work.autonomyLevel,environmentRecipients:parseAllowedRecipientsFromEnv()});}
export function outboxContentHash(outbox:Pick<WorkshopOutboxItem,'channel'|'recipientName'|'message'|'confidence'|'riskLevel'|'sourceEventIds'>){
  return hash({channel:outbox.channel,recipientName:outbox.recipientName,message:outbox.message,confidence:outbox.confidence,riskLevel:outbox.riskLevel,sourceEventIds:outbox.sourceEventIds});
}
type Target={userId:string;workId:string;outboxId:string;commandId:string;expectedContentHash:string};
/** The winner alone gets dispatch=true. Every subsequent request observes the
 * durable attempt and must query its provider status instead of dispatching. */
export async function beginOutboxAttempt(input:Target){
  if(!input.commandId?.trim()||input.commandId.length>256)throw new WorkCommandConflict('invalid_command');
  return withWorkshopEventTransaction(async(db,append)=>{
    const [work]=await db.select().from(workshops).where(and(eq(workshops.id,input.workId),eq(workshops.userId,input.userId))).for('update');
    if(!work)throw new WorkCommandConflict('not_found');
    const execute=async()=>{
      const [outbox]=await db.select().from(workshopOutbox).where(and(eq(workshopOutbox.id,input.outboxId),eq(workshopOutbox.workshopId,input.workId))).for('update');
      if(!outbox)throw new WorkCommandConflict('not_found');
      const producer=resolveExecutionLease();
      if(producer&&outbox.runId!==producer.runId)throw new WorkCommandConflict('invalid_command');
      const existing=await db.execute(sql`SELECT * FROM workshop_outbox_attempts WHERE owner_id=${input.userId}::uuid AND command_id=${input.commandId}`);
      if(existing[0]){
        if(existing[0].outbox_id!==input.outboxId||existing[0].content_hash!==input.expectedContentHash)throw new WorkCommandConflict('payload_conflict');
        return {dispatch:false,attempt:existing[0]};
      }
      const active=await db.execute(sql`SELECT id FROM workshop_outbox_attempts WHERE outbox_id=${input.outboxId}::uuid`);
      if(active[0]||!['draft','pending_approval','approved'].includes(outbox.status))throw new WorkCommandConflict('target_busy');
      const contentHash=outboxContentHash(outbox);
      if(contentHash!==input.expectedContentHash)throw new WorkCommandConflict('payload_conflict');
      const policyHash=policyFingerprint(work);
      const boundary=evaluateWorkshopOutboxBoundary({workshop:work,outbox,action:'send'});
      const approval=outbox.boundaryResult?.sendApproval as {contentHash?:string;policyHash?:string}|undefined;
      if(!boundary.allowed||(boundary.requiresApproval&&(outbox.status!=='approved'||approval?.contentHash!==contentHash||approval.policyHash!==policyHash)))throw new WorkCommandConflict('invalid_command');
      const id=randomUUID();
      const payload={recipientName:outbox.recipientName,message:outbox.message,channel:outbox.channel};
      const rows=await db.execute(sql`INSERT INTO workshop_outbox_attempts(id,outbox_id,workshop_id,owner_id,command_id,content_hash,policy_hash,payload,status) VALUES (${id}::uuid,${outbox.id}::uuid,${work.id}::uuid,${input.userId}::uuid,${input.commandId},${contentHash},${policyHash},${JSON.stringify(payload)}::jsonb,'sending') RETURNING *`);
      await db.update(workshopOutbox).set({status:'sending',updatedAt:new Date()}).where(eq(workshopOutbox.id,outbox.id));
      const lease=resolveExecutionLease();
      if(lease){
        await db.execute(sql`UPDATE workshop_execution_leases SET effect_started=true,updated_at=clock_timestamp() WHERE workshop_id=${work.id}::uuid`);
      }
      await append({workshopId:work.id,runId:lease?.runId??null,type:'outbox_sending',title:'发信尝试已记录',metadata:{actorId:input.userId,attemptId:id,outboxId:outbox.id,sourceRunId:outbox.runId,commandId:input.commandId,contentHash,policyHash}});
      return {dispatch:true,attempt:rows[0]};
    };
    const lease=resolveExecutionLease();
    if(lease){
      if(lease.userId!==input.userId||lease.workshopId!==input.workId)throw new WorkCommandConflict('invalid_command');
      return withExecutionBusinessTransaction(lease,{db,append},execute);
    }
    return execute();
  });
}

export async function approveOutboxSend(input:{userId:string;workId:string;outboxId:string;expectedContentHash:string}){
  if(resolveExecutionLease())throw new WorkCommandConflict('invalid_command');
  return withWorkshopEventTransaction(async(db,append)=>{
    const [work]=await db.select().from(workshops).where(and(eq(workshops.id,input.workId),eq(workshops.userId,input.userId))).for('update');
    if(!work)throw new WorkCommandConflict('not_found');
    const [outbox]=await db.select().from(workshopOutbox).where(and(eq(workshopOutbox.id,input.outboxId),eq(workshopOutbox.workshopId,work.id))).for('update');
    if(!outbox)throw new WorkCommandConflict('not_found');
    const attempts=await db.execute(sql`SELECT id FROM workshop_outbox_attempts WHERE outbox_id=${outbox.id}::uuid`);
    if(attempts[0]||!['draft','pending_approval','approved'].includes(outbox.status))throw new WorkCommandConflict('target_busy');
    const contentHash=outboxContentHash(outbox),policyHash=policyFingerprint(work);
    if(contentHash!==input.expectedContentHash)throw new WorkCommandConflict('payload_conflict');
    if(!evaluateWorkshopOutboxBoundary({workshop:work,outbox,action:'send'}).allowed)throw new WorkCommandConflict('invalid_command');
    const previous=outbox.boundaryResult?.sendApproval as Record<string,unknown>|undefined;
    if(outbox.status==='approved'&&previous?.contentHash===contentHash&&previous?.policyHash===policyHash)return previous;
    const approval={contentHash,policyHash,actorId:input.userId,approvedAt:new Date().toISOString()};
    await db.update(workshopOutbox).set({status:'approved',boundaryResult:{...outbox.boundaryResult,sendApproval:approval},updatedAt:new Date()}).where(eq(workshopOutbox.id,outbox.id));
    await append({workshopId:work.id,type:'outbox_approved',title:'发信内容已审核',metadata:{outboxId:outbox.id,sourceRunId:outbox.runId,...approval}});
    return approval;
  });
}

/** Host-side provider observation may arrive after the producer lost its lease.
 * It records the outcome of an existing attempt, never authorizes a new send. */
export async function settleOutboxAttempt(input:{userId:string;workId:string;attemptId:string;status:'sent'|'unknown';receipt?:Record<string,unknown>;failurePhase?:string}){
  return withWorkshopEventTransaction(async(db,append)=>{
    const [work]=await db.select({id:workshops.id}).from(workshops).where(and(eq(workshops.id,input.workId),eq(workshops.userId,input.userId))).for('update');
    if(!work)throw new WorkCommandConflict('not_found');
    const attempts=await db.execute(sql`SELECT * FROM workshop_outbox_attempts WHERE id=${input.attemptId}::uuid AND workshop_id=${input.workId}::uuid AND owner_id=${input.userId}::uuid FOR UPDATE`);
    const attempt=attempts[0];if(!attempt)throw new WorkCommandConflict('not_found');
    if(attempt.status==='sent'||attempt.status==='failed'){
      await closeTerminalOutboxReviews({db,append},{workId:work.id,outboxId:attempt.outbox_id,attemptId:attempt.id});
      return attempt;
    }
    if(attempt.status==='unknown'&&input.status==='unknown')return attempt;
    if(input.status==='sent'&&!input.receipt)throw new WorkCommandConflict('invalid_command');
    const rows=await db.execute(sql`UPDATE workshop_outbox_attempts SET status=${input.status},provider_receipt=${JSON.stringify(input.receipt??null)}::jsonb,failure_phase=${input.failurePhase??null},updated_at=clock_timestamp() WHERE id=${input.attemptId}::uuid RETURNING *`);
    await db.update(workshopOutbox).set({status:input.status,sentAt:input.status==='sent'?new Date():null,updatedAt:new Date()}).where(eq(workshopOutbox.id,attempt.outbox_id));
    if(input.status==='sent')await closeTerminalOutboxReviews({db,append},{workId:work.id,outboxId:attempt.outbox_id,attemptId:attempt.id});
    await append({workshopId:work.id,type:input.status==='sent'?'outbox_sent':'outbox_unknown',title:input.status==='sent'?'发信结果已确认':'发信结果待核对',metadata:{actorId:input.userId,source:'send_attempt_observation',outboxId:attempt.outbox_id,attemptId:attempt.id,failurePhase:input.failurePhase??null}});
    return rows[0];
  });
}
