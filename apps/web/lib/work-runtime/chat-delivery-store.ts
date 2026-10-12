import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import type {DrizzleDB} from '@/lib/db/types';
import {resolveExecutionLease} from './execution-context';
import {knownWorkshopRuntimeFailureMessage,resolveWorkshopRuntimeFailure,type WorkshopRuntimeFailureEvent} from '@/lib/workshops/runtime-failure';
import {buildChatRunDeliveryMessage,chatRunDeliveryIds,CHAT_DELIVERY_STATUSES,
  type ChatDeliveryDependencies,type ChatDeliveryResult,type ChatDeliveryRunStatus} from './chat-delivery';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type RunRow={id:string;workshop_id:string;trigger_reason:unknown;status:string};
type Origin={chatId:string;sourceMessageId:string|null};
type DeliveryRow={id:string;owner_id:string;chat_id:string;workshop_id:string;run_id:string;
  source_message_id:string|null;message_id:string;run_status:ChatDeliveryRunStatus;attempts:number};
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}

/** Compatibility origin is accepted only when the durable winning owner command
 * created this exact run with the same chat binding. A model-supplied trigger is insufficient. */
export function verifiedLegacyChatOrigin(run:RunRow,command:Record<string,unknown>|undefined):Origin|null{
  const trigger=record(run.trigger_reason),meta=record(trigger.commandMeta);
  const payload=record(record(command?.payload).value),savedTrigger=record(payload.triggerReason);
  const savedResult=record(record(command?.result).value),savedRun=record(savedResult.run);
  if(trigger.source!=='web_chat'||!command||command.status!=='succeeded'||command.target_id!==run.workshop_id
    ||!['startWorkRun','addWorkDirective'].includes(String(command.type))||meta.commandId!==command.command_id
    ||payload.source!=='chat_agent'||savedRun.id!==run.id||savedTrigger.chatId!==trigger.chatId
    ||savedTrigger.userMessageId!==trigger.userMessageId||typeof trigger.chatId!=='string'||!UUID.test(trigger.chatId))return null;
  const sourceMessageId=trigger.userMessageId;
  if(typeof sourceMessageId==='string'&&UUID.test(sourceMessageId))return {chatId:trigger.chatId,sourceMessageId};
  return trigger.origin==='owner_button'&&savedTrigger.origin==='owner_button'&&sourceMessageId==null
    ?{chatId:trigger.chatId,sourceMessageId:null}:null;
}

async function readChatOrigin(tx:DrizzleDB,ownerId:string,run:RunRow):Promise<Origin|null>{
  const trigger=record(run.trigger_reason);
  const items=await tx.execute(sql`SELECT chat_id,source_message_id FROM workshop_chat_work_items
    WHERE owner_id=${ownerId}::uuid AND workshop_id=${run.workshop_id}::uuid
      AND (latest_run_id=${run.id}::uuid OR id::text=${typeof trigger.workItemId==='string'?trigger.workItemId:''}) LIMIT 2`);
  if(items.length>1)return null;
  if(items[0])return {chatId:String(items[0].chat_id),sourceMessageId:items[0].source_message_id==null?null:String(items[0].source_message_id)};
  const commandId=record(trigger.commandMeta).commandId;
  if(typeof commandId!=='string')return null;
  const commands=await tx.execute(sql`SELECT command_id,target_id,type,status,payload,result FROM work_commands
    WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} LIMIT 1`);
  return verifiedLegacyChatOrigin(run,commands[0] as Record<string,unknown>|undefined);
}

/** Queue insertion belongs to the same transaction as completion. The periodic
 * scan also recovers cancellation/review paths and historical terminal runs. */
export async function enqueueChatRunDeliveryInTransaction(tx:DrizzleDB,input:{userId:string;workshopId:string;runId:string;status:string}){
  if(!CHAT_DELIVERY_STATUSES.includes(input.status as ChatDeliveryRunStatus))return false;
  const rows=await tx.execute(sql`SELECT r.id,r.workshop_id,r.trigger_reason,r.status FROM workshop_runs r
    JOIN workshops w ON w.id=r.workshop_id WHERE r.id=${input.runId}::uuid AND w.id=${input.workshopId}::uuid
      AND w.user_id=${input.userId}::uuid`);
  const run=rows[0] as RunRow|undefined;
  if(!run||run.status!==input.status)return false;
  const origin=await readChatOrigin(tx,input.userId,run);
  if(!origin||!UUID.test(origin.chatId)||(origin.sourceMessageId!==null&&!UUID.test(origin.sourceMessageId)))return false;
  const ids=chatRunDeliveryIds(input.userId,input.workshopId,input.runId,input.status as ChatDeliveryRunStatus);
  const inserted=await tx.execute(sql`INSERT INTO workshop_chat_deliveries
    (id,owner_id,chat_id,workshop_id,run_id,source_message_id,message_id,run_status,status)
    VALUES (${ids.deliveryId}::uuid,${input.userId}::uuid,${origin.chatId}::uuid,${input.workshopId}::uuid,
      ${input.runId}::uuid,${origin.sourceMessageId}::uuid,${ids.messageId}::uuid,${input.status},'pending')
    ON CONFLICT (run_id,run_status) DO NOTHING RETURNING id`);
  return inserted.length>0;
}

async function seed(ownerId:string,limit:number){
  if(resolveExecutionLease())throw Error('A producer cannot deliver chat notifications');
  return db.transaction(async(tx:DrizzleDB)=>{
    const candidates=await tx.execute(sql`SELECT r.id,r.workshop_id,r.status FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
      WHERE w.user_id=${ownerId}::uuid AND r.status IN ('completed','failed','interrupted','cancelled','needs_review')
      AND NOT EXISTS (SELECT 1 FROM workshop_chat_deliveries d WHERE d.run_id=r.id AND d.run_status=r.status)
      AND (1=(SELECT count(*) FROM workshop_chat_work_items i WHERE i.owner_id=${ownerId}::uuid
        AND i.workshop_id=w.id AND (i.latest_run_id=r.id OR i.id::text=r.trigger_reason->>'workItemId'))
        OR (r.trigger_reason->>'source'='web_chat' AND EXISTS (SELECT 1 FROM work_commands c
          WHERE c.owner_id=${ownerId}::uuid AND c.command_id=r.trigger_reason->'commandMeta'->>'commandId'
          AND c.target_id=w.id AND c.status='succeeded' AND c.type IN ('startWorkRun','addWorkDirective')
          AND c.payload->'value'->>'source'='chat_agent' AND c.result->'value'->'run'->>'id'=r.id::text
          AND c.payload->'value'->'triggerReason'->>'chatId'=r.trigger_reason->>'chatId'
          AND (c.payload->'value'->'triggerReason'->>'userMessageId' IS NOT DISTINCT FROM r.trigger_reason->>'userMessageId')
          AND (r.trigger_reason->>'userMessageId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
            OR (r.trigger_reason->>'origin'='owner_button' AND c.payload->'value'->'triggerReason'->>'origin'='owner_button'
              AND r.trigger_reason->>'userMessageId' IS NULL))
          AND r.trigger_reason->>'chatId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')))
      ORDER BY r.updated_at,r.id LIMIT ${limit}`);
    let inserted=0;
    for(const run of candidates){
      if(await enqueueChatRunDeliveryInTransaction(tx,{userId:ownerId,workshopId:String(run.workshop_id),runId:String(run.id),status:String(run.status)}))inserted++;
    }
    return inserted;
  });
}

async function blocked(tx:DrizzleDB,row:DeliveryRow,errorCode:string):Promise<ChatDeliveryResult>{
  await tx.execute(sql`UPDATE workshop_chat_deliveries SET status='blocked',last_error_code=${errorCode},
    attempts=attempts+1,updated_at=clock_timestamp() WHERE id=${row.id}::uuid`);
  return {state:'blocked',deliveryId:row.id,errorCode};
}

/** Row locking plus message insertion and settlement in one transaction make
 * concurrent/restarted consumers converge on one immutable assistant message. */
export async function deliverNextChatResultInTransaction(tx:DrizzleDB,ownerId:string):Promise<ChatDeliveryResult|null>{
  if(resolveExecutionLease())throw Error('A producer cannot deliver chat notifications');
  const jobs=await tx.execute(sql`SELECT * FROM workshop_chat_deliveries WHERE owner_id=${ownerId}::uuid
    AND status IN ('pending','failed') AND next_attempt_at<=clock_timestamp()
    ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
  const row=jobs[0] as DeliveryRow|undefined;if(!row)return null;
  const chats=await tx.execute(sql`SELECT id FROM "Chat" WHERE id=${row.chat_id}::uuid AND "userId"=${ownerId}::uuid FOR SHARE`);
  if(!chats[0])return blocked(tx,row,'origin_chat_unavailable');
  if(row.source_message_id){
    const sources=await tx.execute(sql`SELECT id FROM "Message_v2" WHERE id=${row.source_message_id}::uuid
      AND "chatId"=${row.chat_id}::uuid AND role='user' FOR SHARE`);
    if(!sources[0])return blocked(tx,row,'origin_message_unavailable');
  }
  const runs=await tx.execute(sql`SELECT r.status,r.output_summary,w.name,r.error,r.started_at,r.completion_json,EXISTS(SELECT 1 FROM workshop_events e
      WHERE e.workshop_id=w.id AND e.run_id=r.id AND e.type='directive_needs_clarification') AS needs_input
      ,(SELECT e.body FROM workshop_events e WHERE e.workshop_id=w.id AND e.run_id=r.id
        AND e.type='directive_needs_clarification' ORDER BY e.seq DESC LIMIT 1) AS clarification
    FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id WHERE r.id=${row.run_id}::uuid
      AND w.id=${row.workshop_id}::uuid AND w.user_id=${ownerId}::uuid FOR SHARE OF r`);
  if(!runs[0])return blocked(tx,row,'origin_work_unavailable');
  if(runs[0].status!==row.run_status)return blocked(tx,row,'run_status_changed');
  let runtimeFailure:unknown;
  const savedFailure=record(record(record(runs[0].completion_json).request).metadata).runtimeFailure;
  const candidate=record(savedFailure);
  // Completion metadata is written by the terminal transaction. Even then,
  // recheck its binding to this run's last host validation and runtime terminal.
  if(row.run_status==='failed'&&candidate.version==='workshop-runtime-failure/v1'
    &&candidate.receiptAuthority==='runtime'&&candidate.runId===row.run_id&&
    (candidate.code==='research_final_validation_rejected'||candidate.code==='agent_runtime_failed'&&knownWorkshopRuntimeFailureMessage(candidate.runtimeError))){
    const events=await tx.execute(sql`SELECT id,run_id AS "runId",seq,type,created_at AS "createdAt",metadata FROM workshop_events
      WHERE workshop_id=${row.workshop_id}::uuid AND run_id=${row.run_id}::uuid
        AND type IN ('agent_configured','run_started','research_final_validation_rejected','research_final_validation_passed','agent_final_output_rejected')
        AND metadata->>'receiptAuthority' IS DISTINCT FROM 'agent'
      ORDER BY seq DESC,id DESC LIMIT 21`);
    if(events.length<=20){
      const resolved=resolveWorkshopRuntimeFailure({runId:row.run_id,runtimeFailure:savedFailure,
        error:typeof runs[0].error==='string'?runs[0].error:null,
        startedAt:runs[0].started_at instanceof Date||typeof runs[0].started_at==='string'?runs[0].started_at:null,
        events:events as unknown as WorkshopRuntimeFailureEvent[]});
      if(resolved.code==='research_final_validation_rejected'||resolved.runtimeEventId&&knownWorkshopRuntimeFailureMessage(resolved.runtimeError))runtimeFailure=resolved;
    }
  }
  const content=buildChatRunDeliveryMessage({deliveryId:row.id,messageId:row.message_id,workshopId:row.workshop_id,
    runId:row.run_id,workshopName:String(runs[0].name),sourceMessageId:row.source_message_id,
    status:row.run_status,needsInput:runs[0].needs_input===true,
    summary:typeof runs[0].output_summary==='string'?runs[0].output_summary:null,
    clarification:typeof runs[0].clarification==='string'?runs[0].clarification:null,runtimeFailure});
  await tx.execute(sql`SAVEPOINT chat_delivery_message`);
  try{
    const inserted=await tx.execute(sql`INSERT INTO "Message_v2" (id,"chatId",role,parts,attachments,"createdAt",metadata)
      VALUES (${row.message_id}::uuid,${row.chat_id}::uuid,'assistant',${JSON.stringify(content.parts)}::json,
        '[]'::json,clock_timestamp(),${JSON.stringify(content.metadata)}::jsonb)
      ON CONFLICT (id) DO NOTHING RETURNING id`);
    if(!inserted[0]){
      const prior=await tx.execute(sql`SELECT "chatId",role,metadata,parts FROM "Message_v2" WHERE id=${row.message_id}::uuid`);
      const existing=prior[0];
      if(!existing||existing.chatId!==row.chat_id||existing.role!=='assistant'
        ||record(record(existing.metadata).workshopChatDelivery).deliveryId!==row.id){
        await tx.execute(sql`ROLLBACK TO SAVEPOINT chat_delivery_message`);
        await tx.execute(sql`RELEASE SAVEPOINT chat_delivery_message`);
        return blocked(tx,row,'message_identity_conflict');
      }
    }
    await tx.execute(sql`UPDATE workshop_chat_deliveries SET status='delivered',attempts=attempts+1,
      last_error_code=NULL,delivered_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${row.id}::uuid`);
    await tx.execute(sql`RELEASE SAVEPOINT chat_delivery_message`);
    return {state:inserted[0]?'delivered':'replayed',deliveryId:row.id};
  }catch{
    await tx.execute(sql`ROLLBACK TO SAVEPOINT chat_delivery_message`);
    await tx.execute(sql`RELEASE SAVEPOINT chat_delivery_message`);
    await tx.execute(sql`UPDATE workshop_chat_deliveries SET status='failed',attempts=attempts+1,
      last_error_code='message_persistence_failed',next_attempt_at=clock_timestamp()+
        LEAST(300,POWER(2,LEAST(attempts+1,8))) * interval '1 second',updated_at=clock_timestamp() WHERE id=${row.id}::uuid`);
    return {state:'failed',deliveryId:row.id,errorCode:'message_persistence_failed'};
  }
}

export const chatDeliveryDependencies:ChatDeliveryDependencies={seed,async next(ownerId){
  if(resolveExecutionLease())throw Error('A producer cannot deliver chat notifications');
  return db.transaction((tx:DrizzleDB)=>deliverNextChatResultInTransaction(tx,ownerId));
}};
