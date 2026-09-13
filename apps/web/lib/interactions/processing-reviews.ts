import 'server-only';
import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {readInteractionProcessingPlan} from './processing-plans';

export async function listInteractionProcessingReviews(userId:string,history=false){
  return db.execute(sql`SELECT id,attempts,status,started_at,updated_at,
    CASE WHEN last_error='interaction_host_lost_result_unknown' THEN 'host_lost' WHEN last_error IN ('interaction_source_policy_denied','interaction_plan_context_changed') THEN 'source_context_changed' ELSE 'partial_result_unknown' END AS reason
    FROM interaction_processing_jobs j WHERE user_id=${userId}::uuid AND ${history?sql`EXISTS(SELECT 1 FROM interaction_review_decisions d WHERE d.job_id=j.id AND d.owner_id=j.user_id)`:sql`status='needs_review'`}
    ORDER BY updated_at DESC,id LIMIT 101`);
}
export async function getInteractionProcessingReview(userId:string,jobId:string){
  const [job]=await db.execute(sql`SELECT id,attempts,status,started_at,updated_at,
    CASE WHEN last_error IN ('interaction_source_policy_denied','interaction_plan_context_changed') THEN 'source_context_changed' ELSE 'partial_result_unknown' END AS reason FROM interaction_processing_jobs
    WHERE user_id=${userId}::uuid AND id=${jobId}::uuid AND (status IN ('needs_review','review_closed') OR EXISTS(SELECT 1 FROM interaction_review_decisions d WHERE d.job_id=interaction_processing_jobs.id AND d.owner_id=${userId}::uuid))`);
  if(!job)return null;
  const [events,results,claims,decisions,plan]=await Promise.all([
    db.execute(sql`SELECT e.id,e.conversation_name,e.message_time,e.content_preview,LEFT(e.content,4000) AS content,
      length(e.content)>4000 AS truncated FROM interaction_events e JOIN interaction_processing_jobs j ON j.user_id=e.user_id
      AND j.event_ids ? e.id::text WHERE j.id=${jobId}::uuid AND j.user_id=${userId}::uuid ORDER BY e.message_time,e.id LIMIT 101`),
    db.execute(sql`SELECT * FROM (
      SELECT id,'note' AS kind,title,LEFT(body,4000) AS content,length(body)>4000 AS truncated,created_at FROM interaction_notes
        WHERE user_id=${userId}::uuid AND metadata->>'processingJobId'=${jobId} AND metadata->>'processingAttempt'=${String(job.attempts)}
      UNION ALL SELECT id,'task',title,LEFT(description,4000),length(description)>4000,created_at FROM interaction_tasks
        WHERE user_id=${userId}::uuid AND metadata->>'processingJobId'=${jobId} AND metadata->>'processingAttempt'=${String(job.attempts)}
      UNION ALL SELECT id,'memory',subject,LEFT(content,4000),length(content)>4000,created_at FROM brain_memories
        WHERE user_id=${userId}::uuid AND metadata->>'processingJobId'=${jobId} AND metadata->>'processingAttempt'=${String(job.attempts)}
    ) results ORDER BY created_at,id LIMIT 101`),
    db.execute(sql`SELECT instance_id,claimed_at,recovered_at FROM runtime_interaction_claims
      WHERE owner_id=${userId}::uuid AND job_id=${jobId}::uuid AND attempt=${job.attempts}`),
    db.execute(sql`SELECT command_id,decision,decided_at FROM interaction_review_decisions
      WHERE owner_id=${userId}::uuid AND job_id=${jobId}::uuid ORDER BY decided_at DESC LIMIT 100`),
    readInteractionProcessingPlan(userId,jobId),
  ]);
  return {job,events:events.slice(0,100),results:results.slice(0,100),claims,decisions,
    plan:plan?{hash:plan.plan_hash,payload:plan.payload,resumable:job.status==='needs_review'&&plan.atomic_write_version===1}:null,
    truncated:events.length>100||results.length>100,
    evidenceWarning:'Only explicitly linked results are listed; missing records do not prove that no writes occurred.'};
}

export class InteractionReviewConflict extends Error {}
export async function closeInteractionProcessingReview(input:{userId:string;jobId:string;attempt:number;commandId:string;acknowledgedUnknown:boolean;decision?:'keep_results_end'|'resume_plan';planHash?:string}){
  const action=input.decision??'keep_results_end';
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(![input.userId,input.jobId,input.commandId].every(value=>uuid.test(value))||!Number.isSafeInteger(input.attempt)||input.attempt<1||input.acknowledgedUnknown!==true)throw new InteractionReviewConflict('review_acknowledgement_required');
  if(!['keep_results_end','resume_plan'].includes(action)||(action==='resume_plan'&&!/^[a-f0-9]{64}$/.test(input.planHash??'')))throw new InteractionReviewConflict('review_plan_required');
  return db.transaction(async(tx:any)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'interaction-review:'+input.userId.toLowerCase()+':'+input.commandId.toLowerCase()},0))`);
    const [previous]=await tx.execute(sql`SELECT * FROM interaction_review_decisions WHERE owner_id=${input.userId}::uuid AND command_id=${input.commandId}::uuid`);
    if(previous){
      if(previous.job_id!==input.jobId.toLowerCase()||previous.attempt!==input.attempt||previous.decision!==action||(action==='resume_plan'&&previous.plan_hash!==input.planHash))throw new InteractionReviewConflict('review_command_conflict');
      return {decision:previous,replayed:true};
    }
    const [job]=await tx.execute(sql`SELECT id,status,attempts FROM interaction_processing_jobs WHERE id=${input.jobId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`);
    if(!job||job.status!=='needs_review'||job.attempts!==input.attempt)throw new InteractionReviewConflict('review_state_changed');
    if(action==='resume_plan'){
      const [plan]=await tx.execute(sql`SELECT plan_hash,atomic_write_version FROM interaction_processing_plans WHERE job_id=${job.id}::uuid AND owner_id=${input.userId}::uuid`);
      if(!plan||plan.atomic_write_version!==1||plan.plan_hash!==input.planHash)throw new InteractionReviewConflict('review_plan_changed');
    }
    const [decision]=await tx.execute(sql`INSERT INTO interaction_review_decisions(owner_id,command_id,job_id,attempt,decision,acknowledged_unknown,plan_hash)
      VALUES (${input.userId}::uuid,${input.commandId}::uuid,${input.jobId}::uuid,${input.attempt},${action},true,${action==='resume_plan'?input.planHash:null}) RETURNING *`);
    await tx.execute(sql`UPDATE interaction_processing_jobs SET status=${action==='resume_plan'?'resume_pending':'review_closed'},scheduled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${job.id}::uuid`);
    return {decision,replayed:false};
  });
}
