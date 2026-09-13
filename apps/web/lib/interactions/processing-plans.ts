import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {listInteractionSourcePolicies} from '@/lib/knowledge-pipeline/source-policies';
import {isInteractionEventAllowedBySourcePolicy,sourcePolicyMentionAliases} from '@/lib/knowledge-pipeline/source-policy-runtime';
import type {InteractionEvent} from '@/lib/db/schema';
export const processingDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>
  item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');
export async function interactionPlanContext(userId:string,events:InteractionEvent[],mode:string){
  const policies=await listInteractionSourcePolicies({userId,platform:'wechat'});
  const byId=new Map(policies.map(policy=>[policy.sourceId,policy]));
  const context=events.map(event=>{
    const policy=byId.get(event.conversationId??'');
    if(policy&&(!policy.enabled||!isInteractionEventAllowedBySourcePolicy({policy:policy.policy,event,
      mentionAliases:sourcePolicyMentionAliases({metadata:policy.metadata})})||(policy.policy==='summary'&&mode!=='summary_only')))throw Error('interaction_source_policy_denied');
    return {id:event.id,content:event.content,contentPreview:event.contentPreview,conversationId:event.conversationId,
      sourceRaw:event.sourceRaw,messageTime:event.messageTime,policy:policy?{policy:policy.policy,enabled:policy.enabled,metadata:policy.metadata}:null};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  return processingDigest({mode,context});
}
export async function readInteractionProcessingPlan(userId:string,jobId:string){
  const [row]=await db.execute(sql`SELECT plan_hash,payload,execution_attempt,atomic_write_version FROM interaction_processing_plans
    WHERE owner_id=${userId}::uuid AND job_id=${jobId}::uuid`);
  return row??null;
}
export async function saveInteractionProcessingPlan(input:{userId:string;jobId:string;attempt:number;payload:Record<string,unknown>}){
  const hash=processingDigest(input.payload);
  return db.transaction(async(tx:any)=>{
    const [job]=await tx.execute(sql`SELECT id FROM interaction_processing_jobs WHERE user_id=${input.userId}::uuid AND id=${input.jobId}::uuid
      AND attempts=${input.attempt} AND status='running' FOR UPDATE`);
    if(!job)throw Error('interaction_processing_attempt_lost');
    await tx.execute(sql`INSERT INTO interaction_processing_plans(job_id,owner_id,execution_attempt,atomic_write_version,plan_hash,payload)
      VALUES (${input.jobId}::uuid,${input.userId}::uuid,${input.attempt},1,${hash},${JSON.stringify(input.payload)}::jsonb) ON CONFLICT(job_id) DO NOTHING`);
    const rows=await tx.execute(sql`UPDATE interaction_processing_plans SET execution_attempt=${input.attempt}
      WHERE job_id=${input.jobId}::uuid AND owner_id=${input.userId}::uuid AND plan_hash=${hash} RETURNING plan_hash`);
    if(!rows.length)throw Error('interaction_plan_changed');
    return hash;
  });
}
