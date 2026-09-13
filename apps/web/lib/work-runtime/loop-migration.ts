import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import type {DrizzleDB} from '@/lib/db/types';
import {createWorkshop} from '@/lib/workshops/service';
import {serializeWorkshopBoundaryPolicy,workshopBoundaryToLoopPolicies} from '@/lib/workshops/boundary-policy';
import {getLoop,getLoopState,updateLoop,upsertLoopState} from '@/lib/loops/service';
import {loopApprovalPolicySchema,loopTriggerSchema} from '@/lib/loops/spec';
import {validateCronExpression} from '@/lib/cron/scheduler';
import {inspectLegacyLoopSource} from './legacy-loop-source';
import {commandPayloadHash} from './command-payload';
import {WorkCommandConflict} from './command-ledger';
import {runWorkLifecycleCommand} from './lifecycle-command';
import {resolveExecutionLease} from './execution-context';
import type {WorkCommandMeta} from './types';

type Target={userId:string;loopId:string};
type NativeReplacement={goal:string;triggerConfig:Record<string,unknown>;confirmLegacyReplacement:true};
type MigrationCommand=Target&WorkCommandMeta&{commandId:string;expectedSnapshotHash:string;controllersStopped:boolean;nativeReplacement?:NativeReplacement};
function replacement(value:NativeReplacement|undefined){
  if(value===undefined)return undefined;
  if(!value||value.confirmLegacyReplacement!==true||typeof value.goal!=='string'||!value.goal.trim()||value.goal.length>8000)throw new WorkCommandConflict('invalid_command');
  const parsed=loopTriggerSchema.safeParse(value.triggerConfig);
  if(!parsed.success||parsed.data.type==='scheduled_job')throw new WorkCommandConflict('invalid_command');
  const trigger=parsed.data;
  if(trigger.type==='cron'){
    if(!validateCronExpression(trigger.expression))throw new WorkCommandConflict('invalid_command');
    try{new Intl.DateTimeFormat('en',{timeZone:trigger.timezone});}catch{throw new WorkCommandConflict('invalid_command');}
  }
  if(trigger.type==='once'&&!Number.isFinite(Date.parse(trigger.at)))throw new WorkCommandConflict('invalid_command');
  return {goal:value.goal.trim(),triggerConfig:trigger,confirmLegacyReplacement:true as const};
}
function validate(input:Target){
  if(process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true')throw new WorkCommandConflict('invalid_command');
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(![input.userId,input.loopId].every(id=>typeof id==='string'&&uuid.test(id)))throw new WorkCommandConflict('invalid_command');
}
async function snapshot(input:Target,store:DrizzleDB){
  const loop=await getLoop(input.userId,input.loopId,store);
  if(!loop)throw new WorkCommandConflict('not_found');
  const state=await getLoopState(input.loopId,store);
  const legacy=await inspectLegacyLoopSource(loop,store);
  const source=JSON.parse(JSON.stringify({loop,state,...(legacy?{legacyJob:legacy.job}:{})}));
  const originalApproval=loopApprovalPolicySchema.parse(loop.approvalPolicy);
  const boundaryPolicy=serializeWorkshopBoundaryPolicy({mode:'draft',externalMessages:originalApproval.externalWrites==='deny'?'blocked':'draft'});
  const effectivePolicies=workshopBoundaryToLoopPolicies({workshop:{autonomyLevel:'draft',boundaryPolicy},actionPolicy:loop.actionPolicy,approvalPolicy:loop.approvalPolicy});
  const blockers:string[]=[];
  if(loop.workshopId)blockers.push('already_owned');
  if(!['active','paused'].includes(loop.status))blockers.push('unsupported_status');
  if(loop.triggerConfig.type==='scheduled_job')blockers.push('legacy_scheduled_job');
  if(legacy)blockers.push(...legacy.blockers);
  const busy=await store.execute(sql`SELECT 1 FROM loop_runs WHERE loop_id=${input.loopId}::uuid AND status IN ('queued','running','cancel_requested','needs_review') LIMIT 1`);
  if(busy[0])blockers.push('unfinished_run');
  const approvals=await store.execute(sql`SELECT 1 FROM loop_approval_requests WHERE loop_id=${input.loopId}::uuid AND
    (status='pending' OR (status='approved' AND action_payload->'continuation'->>'status'='ready')) LIMIT 1`);
  if(approvals[0])blockers.push('unresolved_approval');
  return {source,snapshotHash:commandPayloadHash(source),blockers,proposed:{name:loop.name,mission:loop.goal,status:'paused' as const,autonomyLevel:'draft' as const,boundaryPolicy,effectivePolicies}};
}

/** Owner preview is serialized with legacy mutations; nothing is executed. */
export async function previewStandaloneLoopMigration(input:Target){
  validate(input);
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT id FROM loops WHERE id=${input.loopId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`);
    return snapshot(input,tx as DrizzleDB);
  });
}

/** Preserve identity/history, bind to a paused controller, and commit provenance
 * and the replayable receipt atomically. Shutdown is an owner attestation, not
 * an assertion that this process has inspected every external worker. */
export async function migrateStandaloneLoopToWork(input:MigrationCommand){
  validate(input);
  if(resolveExecutionLease()||(input.source!==undefined&&input.source!=='owner')||input.controllersStopped!==true||
    typeof input.commandId!=='string'||!input.commandId.trim()||input.commandId.length>256||
    typeof input.expectedSnapshotHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedSnapshotHash))throw new WorkCommandConflict('invalid_command');
  const nativeReplacement=replacement(input.nativeReplacement);
  const command={...input,...(nativeReplacement?{nativeReplacement}:{}),userId:input.userId.toLowerCase(),loopId:input.loopId.toLowerCase(),source:'owner' as const};
  return runWorkLifecycleCommand({ownerId:command.userId,type:'migrateStandaloneLoop',command},async(persisted,context,workId)=>{
    const store=context.db;
    await store.execute(sql`SELECT id FROM loops WHERE id=${persisted.loopId}::uuid AND user_id=${persisted.userId}::uuid FOR UPDATE`);
    const preview=await snapshot(persisted,store);
    const legacyJob=preview.source.legacyJob;
    if(persisted.nativeReplacement&&!legacyJob)throw new WorkCommandConflict('invalid_command');
    if(preview.blockers.some(code=>code!=='legacy_scheduled_job'||!persisted.nativeReplacement))throw new WorkCommandConflict('target_busy');
    if(preview.snapshotHash!==persisted.expectedSnapshotHash)throw new WorkCommandConflict('version_conflict');
    const {effectivePolicies,...proposed}=preview.proposed;
    await createWorkshop({...proposed,mission:persisted.nativeReplacement?.goal??proposed.mission,userId:persisted.userId,modelConfig:{loopMigration:{loopId:persisted.loopId,commandId:persisted.commandId}}},context,workId);
    await updateLoop(persisted.userId,persisted.loopId,{workshopId:workId,status:'paused',...(persisted.nativeReplacement?{goal:persisted.nativeReplacement.goal,description:null,triggerConfig:persisted.nativeReplacement.triggerConfig}:{})},store);
    if(legacyJob){
      await store.execute(sql`UPDATE scheduled_jobs SET enabled=false,next_run_at=NULL,updated_at=clock_timestamp() WHERE id=${legacyJob.id}::uuid`);
      const state=await getLoopState(persisted.loopId,store),stateJson={...state?.stateJson};
      delete stateJson.nextScheduledRunAt;delete stateJson.onceScheduledAt;
      await upsertLoopState(persisted.loopId,{stateJson:{...stateJson,schedulerStatus:'idle',retiredScheduledJobId:legacyJob.id}},store);
    }
    await store.execute(sql`INSERT INTO loop_runtime_migrations(loop_id,workshop_id,owner_id,command_id,snapshot_hash,source_snapshot,legacy_job_id)
      VALUES (${persisted.loopId}::uuid,${workId}::uuid,${persisted.userId}::uuid,${persisted.commandId},${preview.snapshotHash},${JSON.stringify(preview.source)}::jsonb,${legacyJob?.id??null}::uuid)`);
    if(legacyJob)await context.append({workshopId:workId,type:'legacy_job_retired',title:'旧定时任务已停用',body:'按主人审核的新任务说明与触发配置迁入车间；旧执行器、角色和模型覆盖配置未自动带入。',metadata:{legacyJobId:legacyJob.id,loopId:persisted.loopId,commandId:persisted.commandId,nativeReplacement:persisted.nativeReplacement}});
    await context.append({workshopId:workId,type:'loop_migrated',title:'Loop 已迁入车间并暂停',body:'原任务与历史已保留。审核权限后再启用。',metadata:{loopId:persisted.loopId,commandId:persisted.commandId,snapshotHash:preview.snapshotHash,controllersStopped:true,effectivePolicies}});
    return {workId,loopId:persisted.loopId,status:'paused',snapshotHash:preview.snapshotHash};
  });
}
