import {sql} from 'drizzle-orm';
import type {WorkshopDirective} from '@/lib/db/schema';
import type {WorkshopDirectivePlan} from '@/lib/workshops/directive-planner';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import {withExecutionWrite,type ExecutionLease} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';
import {canonicalCommandJson} from './command-payload';
import {applyRecordedStep} from './recorded-step';

export type CapturedRunPlan={
  directive:Pick<WorkshopDirective,'id'|'content'|'scope'|'priority'>;
  directiveIds:string[];
  plan:WorkshopDirectivePlan&{model:string};
  duplicateLoop:{id:string;name:string}|null;
};
type PlanStep='planned'|'clarification'|'duplicate'|'subtasks';

export async function captureRunPlan(lease:ExecutionLease,input:CapturedRunPlan):Promise<CapturedRunPlan>{
  const value=JSON.parse(JSON.stringify({...input,directiveIds:[...new Set(input.directiveIds.map(id=>id.toLowerCase()))].sort()})) as CapturedRunPlan;
  if(!['run_once','create_loop_task','ask_clarification','spawn_subtask','ignore_duplicate'].includes(value.plan.action)||!Number.isFinite(value.plan.confidence)||value.plan.confidence<0||value.plan.confidence>1||!value.plan.reason?.trim()||!value.plan.model?.trim())throw new ExecutionLeaseError('result_conflict');
  return withExecutionWrite(lease,async({db,append})=>{
    const existing=await db.execute(sql`SELECT checkpoint_json FROM workshop_run_plans WHERE run_id=${lease.runId}::uuid AND workshop_id=${lease.workshopId}::uuid`);
    if(existing[0]){
      if(canonicalCommandJson(existing[0].checkpoint_json)!==canonicalCommandJson(value as any))throw new ExecutionLeaseError('result_conflict');
      return existing[0].checkpoint_json as CapturedRunPlan;
    }
    const output=await db.execute(sql`SELECT 1 FROM workshop_run_outputs WHERE run_id=${lease.runId}::uuid`);
    if(output[0])throw new ExecutionLeaseError('result_conflict');
    const rows=await db.execute(sql`SELECT id,content,scope,priority FROM workshop_directives WHERE id=${value.directive.id}::uuid AND workshop_id=${lease.workshopId}::uuid AND status='active' AND (run_id IS NULL OR run_id=${lease.runId}::uuid) FOR SHARE`);
    if(!rows[0]||canonicalCommandJson(rows[0] as any)!==canonicalCommandJson(value.directive as any))throw new ExecutionLeaseError('invalid_lease');
    if(value.directive.scope==='current_run'&&!value.directiveIds.includes(value.directive.id.toLowerCase()))throw new ExecutionLeaseError('invalid_lease');
    if(value.directiveIds.length){
      const selected=await db.execute(sql`SELECT id FROM workshop_directives WHERE id=ANY(${sql.param(value.directiveIds)}::uuid[]) AND workshop_id=${lease.workshopId}::uuid AND scope='current_run' AND status='active' AND (run_id IS NULL OR run_id=${lease.runId}::uuid) FOR SHARE`);
      if(selected.length!==value.directiveIds.length)throw new ExecutionLeaseError('invalid_lease');
    }
    if(value.duplicateLoop){
      const duplicate=await db.execute(sql`SELECT id,name FROM loops WHERE id=${value.duplicateLoop.id}::uuid AND workshop_id=${lease.workshopId}::uuid AND user_id=${lease.userId}::uuid FOR SHARE`);
      if(!duplicate[0]||duplicate[0].name!==value.duplicateLoop.name)throw new ExecutionLeaseError('invalid_lease');
    }
    await db.execute(sql`INSERT INTO workshop_run_plans(run_id,workshop_id,checkpoint_json,worker_id,fencing_token) VALUES (${lease.runId}::uuid,${lease.workshopId}::uuid,${JSON.stringify(value)}::jsonb,${lease.workerId},${lease.token})`);
    await append({workshopId:lease.workshopId,runId:lease.runId,type:'run_plan_captured',title:'本轮指令规划已保存',metadata:{actorId:lease.userId,workerId:lease.workerId,fencingToken:lease.token,directiveId:value.directive.id,action:value.plan.action}});
    return value;
  });
}

export async function readCapturedRunPlan(lease:ExecutionLease):Promise<CapturedRunPlan|null>{
  return withExecutionWrite(lease,async({db})=>{
    const rows=await db.execute(sql`SELECT checkpoint_json FROM workshop_run_plans WHERE run_id=${lease.runId}::uuid AND workshop_id=${lease.workshopId}::uuid`);
    return rows[0]?.checkpoint_json as CapturedRunPlan??null;
  });
}

export async function applyRunPlanStep<T>(lease:ExecutionLease,step:PlanStep,apply:(context:WorkshopWriteContext,checkpoint:CapturedRunPlan)=>Promise<T>):Promise<T>{
  if(!['planned','clarification','duplicate','subtasks'].includes(step))throw new ExecutionLeaseError('invalid_lease');
  return withExecutionWrite(lease,async context=>{
    const rows=await context.db.execute(sql`SELECT checkpoint_json FROM workshop_run_plans WHERE run_id=${lease.runId}::uuid AND workshop_id=${lease.workshopId}::uuid`);
    const checkpoint=rows[0]?.checkpoint_json as CapturedRunPlan|undefined;
    if(!checkpoint||(step==='clarification'&&!['ask_clarification','ignore_duplicate'].includes(checkpoint.plan.action))||(step==='duplicate'&&(checkpoint.plan.action!=='create_loop_task'||!checkpoint.duplicateLoop))||(step==='subtasks'&&checkpoint.plan.action!=='spawn_subtask'))throw new ExecutionLeaseError('result_conflict');
    return applyRecordedStep(context,lease,`planning:${step}`,0,ctx=>apply(ctx,checkpoint));
  });
}
