import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {workshops,workshopOutbox} from '@/lib/db/schema';
import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import {resolveWechatDesktopSend,getWechatDesktopSendStatus,WechatDesktopServiceError} from '@/lib/wechat-desktop/client';
import {commandPayloadHash} from './command-payload';
import {resolveExecutionLease} from './execution-context';
import {WorkCommandConflict} from './command-ledger';
import {outboxContentHash} from './outbox-attempt';
import {db as database} from '@/lib/db/client';
import {closeTerminalOutboxReviews} from '@/lib/workshops/outbox-reviews';

export type OutboxResolutionCommand={userId:string;workId:string;outboxId:string;attemptId:string;commandId:string;expectedContentHash:string;decision:'sent'|'not_sent'|'unknown';evidence:string};
type ResolutionProvider=typeof resolveWechatDesktopSend;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function getOutboxResolutionState(input:{userId:string;workId:string;outboxId:string}){
  if(![input.userId,input.workId,input.outboxId].every(id=>uuid.test(id)))throw new WorkCommandConflict('invalid_command');
  const attempts=await database.execute(sql`SELECT a.id,a.status,a.content_hash,a.created_at,a.updated_at FROM workshop_outbox_attempts a JOIN workshops w ON w.id=a.workshop_id WHERE w.user_id=${input.userId}::uuid AND a.owner_id=${input.userId}::uuid AND a.workshop_id=${input.workId}::uuid AND a.outbox_id=${input.outboxId}::uuid ORDER BY a.created_at DESC LIMIT 1`);
  if(!attempts[0])throw new WorkCommandConflict('not_found');
  const attempt=attempts[0];
  const resolutions=await database.execute(sql`SELECT command_id,status,request_json->>'decision' AS decision,request_json->>'evidence' AS evidence,result_json FROM workshop_outbox_resolutions WHERE attempt_id=${attempt.id}::uuid ORDER BY (status='pending') DESC,created_at DESC,id DESC LIMIT 1`);
  const recovery=await database.execute(sql`SELECT last_checked_at,next_check_at,lease_until,detail,failures FROM workshop_outbox_recovery WHERE attempt_id=${attempt.id}::uuid`);
  return {attemptId:attempt.id,status:attempt.status,contentHash:attempt.content_hash,createdAt:attempt.created_at,updatedAt:attempt.updated_at,resolution:resolutions[0]??null,recovery:recovery[0]??null};
}

/** Commit human intent before contacting the provider. A pending receipt blocks
 * competing decisions; retry uses the same provider resolution id. */
export async function resolveWorkOutbox(input:OutboxResolutionCommand,provider:ResolutionProvider=resolveWechatDesktopSend,query:typeof getWechatDesktopSendStatus=getWechatDesktopSendStatus){
  if(resolveExecutionLease())throw new WorkCommandConflict('invalid_command');
  if(![input.userId,input.workId,input.outboxId,input.attemptId].every(id=>typeof id==='string'&&uuid.test(id))||!input.commandId?.trim()||input.commandId.length>256||!['sent','not_sent','unknown'].includes(input.decision)||!input.evidence?.trim()||input.evidence.trim().length<8||input.evidence.length>4000||!/^[a-f0-9]{64}$/.test(input.expectedContentHash))throw new WorkCommandConflict('invalid_command');
  const command={...input,userId:input.userId.toLowerCase(),workId:input.workId.toLowerCase(),outboxId:input.outboxId.toLowerCase(),attemptId:input.attemptId.toLowerCase(),evidence:input.evidence.trim()};
  const hash=commandPayloadHash(command);
  const admitted=await withWorkshopEventTransaction(async(db,append)=>{
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.userId+':outbox-resolution:'+command.commandId},0))`);
    const [work]=await db.select({id:workshops.id}).from(workshops).where(and(eq(workshops.id,command.workId),eq(workshops.userId,command.userId))).for('update');
    if(!work)throw new WorkCommandConflict('not_found');
    const existing=await db.execute(sql`SELECT * FROM workshop_outbox_resolutions WHERE owner_id=${command.userId}::uuid AND command_id=${command.commandId}`);
    if(existing[0]){
      if(existing[0].payload_hash!==hash)throw new WorkCommandConflict('payload_conflict');
      return existing[0];
    }
    const rows=await db.execute(sql`SELECT * FROM workshop_outbox_attempts WHERE id=${command.attemptId}::uuid AND owner_id=${command.userId}::uuid AND workshop_id=${command.workId}::uuid AND outbox_id=${command.outboxId}::uuid FOR UPDATE`);
    const attempt=rows[0];if(!attempt)throw new WorkCommandConflict('not_found');
    if(attempt.status!=='unknown')throw new WorkCommandConflict('target_busy');
    if(attempt.content_hash!==command.expectedContentHash)throw new WorkCommandConflict('payload_conflict');
    const pending=await db.execute(sql`SELECT id FROM workshop_outbox_resolutions WHERE attempt_id=${attempt.id}::uuid AND status='pending'`);
    if(pending[0])throw new WorkCommandConflict('target_busy');
    const created=await db.execute(sql`INSERT INTO workshop_outbox_resolutions(id,owner_id,workshop_id,attempt_id,command_id,payload_hash,request_json,status) VALUES (${randomUUID()}::uuid,${command.userId}::uuid,${command.workId}::uuid,${attempt.id}::uuid,${command.commandId},${hash},${JSON.stringify({...command,payload:attempt.payload})}::jsonb,'pending') RETURNING *`);
    await db.execute(sql`UPDATE workshop_outbox_recovery SET next_check_at=clock_timestamp() WHERE attempt_id=${attempt.id}::uuid AND token IS NULL`);
    await append({workshopId:command.workId,type:'outbox_resolution_requested',title:'发信核实请求已记录',metadata:{actorId:command.userId,outboxId:command.outboxId,attemptId:attempt.id,resolutionId:created[0].id,commandId:command.commandId,decision:command.decision,evidence:command.evidence}});
    return created[0];
  });
  if(admitted.status==='completed')return admitted.result_json;
  const request=admitted.request_json as OutboxResolutionCommand&{payload:{recipientName:string;message:string}};
  // No automatic retry here. Transport loss leaves pending; explicit retry uses
  // the provider's durable receipt, never sends another message.
  let observation:Awaited<ReturnType<ResolutionProvider>>|null=null;
  let outcome=request.decision;
  if(request.decision!=='unknown'){
    try{observation=await provider({commandId:request.attemptId,recipientName:request.payload.recipientName,message:request.payload.message,resolutionId:admitted.id,decision:request.decision,actorId:request.userId,evidence:request.evidence});}
    catch(error){
      if(!(error instanceof WechatDesktopServiceError)||error.status!==409)throw error;
      const known=await query(request.attemptId);
      if(known.ok!==true||(known.status!=='sent'&&known.status!=='not_sent')||!known.result)throw error;
      observation=known;outcome=known.status;
    }
  }
  if(observation&&(observation.ok!==true||observation.status!==outcome||!observation.result))throw new WorkCommandConflict('payload_conflict');
  if(observation){
    const result=observation.result;
    if(outcome==='sent'&&!(result.ok===true||(result.ok===undefined&&result.sent===true)))throw new WorkCommandConflict('payload_conflict');
    if(outcome==='not_sent'&&(result.resolution as Record<string,unknown>|undefined)?.decision!=='not_sent')throw new WorkCommandConflict('payload_conflict');
  }
  return withWorkshopEventTransaction(async(db,append)=>{
    const [work]=await db.select({id:workshops.id}).from(workshops).where(and(eq(workshops.id,command.workId),eq(workshops.userId,command.userId))).for('update');
    if(!work)throw new WorkCommandConflict('not_found');
    const rows=await db.execute(sql`SELECT * FROM workshop_outbox_resolutions WHERE id=${admitted.id}::uuid FOR UPDATE`);
    if(rows[0].status==='completed')return rows[0].result_json;
    const attempts=await db.execute(sql`SELECT * FROM workshop_outbox_attempts WHERE id=${request.attemptId}::uuid FOR UPDATE`);
    const attempt=attempts[0];
    if(attempt.status==='sent'&&outcome==='unknown'){outcome='sent';observation={ok:true,status:'sent',result:attempt.provider_receipt};}
    if(attempt.status!=='unknown'&&!(attempt.status==='sent'&&outcome==='sent'))throw new WorkCommandConflict('target_busy');
    const [outbox]=await db.select().from(workshopOutbox).where(eq(workshopOutbox.id,request.outboxId)).for('update');
    if(!outbox||outboxContentHash(outbox)!==request.expectedContentHash)throw new WorkCommandConflict('payload_conflict');
    let replacementOutboxId:string|null=null;
    const status=outcome==='not_sent'?'failed':outcome;
    if(outcome!=='unknown'){
      await db.execute(sql`UPDATE workshop_outbox_attempts SET status=${status},provider_receipt=${JSON.stringify(observation!.result)}::jsonb,failure_phase=${outcome==='not_sent'?'owner_verified_not_sent':null},updated_at=clock_timestamp() WHERE id=${attempt.id}::uuid`);
      await db.update(workshopOutbox).set({status,sentAt:status==='sent'?new Date():null,boundaryResult:{...outbox.boundaryResult,resolution:{id:admitted.id,decision:outcome,requestedDecision:request.decision,actorId:request.userId,evidence:request.evidence}},updatedAt:new Date()}).where(eq(workshopOutbox.id,outbox.id));
      await closeTerminalOutboxReviews({db,append},{workId:work.id,outboxId:outbox.id,attemptId:attempt.id});
      if(outcome==='not_sent'){
        replacementOutboxId=randomUUID();
        await db.insert(workshopOutbox).values({id:replacementOutboxId,workshopId:outbox.workshopId,runId:null,channel:outbox.channel,recipientName:outbox.recipientName,message:outbox.message,status:'draft',confidence:outbox.confidence,riskLevel:outbox.riskLevel,sourceEventIds:outbox.sourceEventIds,boundaryResult:{requiresOwnerReapproval:true,resolvedFromOutboxId:outbox.id,resolvedFromAttemptId:attempt.id,resolutionId:admitted.id,sourceRunId:outbox.runId}});
      }
    }
    const result={resolutionId:admitted.id,outboxId:request.outboxId,attemptId:attempt.id,status,replacementOutboxId,decisionMismatch:outcome!==request.decision};
    await db.execute(sql`UPDATE workshop_outbox_resolutions SET status='completed',result_json=${JSON.stringify(result)}::jsonb,completed_at=clock_timestamp() WHERE id=${admitted.id}::uuid`);
    await append({workshopId:request.workId,type:'outbox_resolution_completed',title:outcome!==request.decision?'保留服务端已有发送结果':outcome==='unknown'?'发信结果继续保留未知':outcome==='sent'?'主人已核实发送':'主人已核实未发送，新草稿待重新审核',metadata:{...result,actorId:request.userId,decision:outcome,requestedDecision:request.decision,evidence:request.evidence,commandId:request.commandId}});
    return result;
  });
}
