import {sql} from 'drizzle-orm';
import type {WorkshopWriteContext} from '@/lib/workshops/service';

/** Database-only control transition. The caller already owns the Work lock
 * and authority to cancel or quarantine its run; all changes share its commit. */
export async function updateLinkedLoopControlState(context:WorkshopWriteContext,input:{workshopId:string;runId:string;userId:string;status:'cancelled'|'needs_review';reason:string;wasRunning:boolean;commandId?:string;execution?:unknown}){
  const {db,append}=context;
  const links=await db.execute(sql`SELECT loop_id,loop_run_id FROM workshop_loop_executions WHERE run_id=${input.runId}::uuid AND workshop_id=${input.workshopId}::uuid FOR UPDATE`);
  if(!links[0])return;
  const loopId=String(links[0].loop_id),loopRunId=String(links[0].loop_run_id);
  await db.execute(sql`UPDATE loop_runs SET status=${input.status},error=${input.reason},completed_at=CASE WHEN ${input.status}='cancelled' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE id=${loopRunId}::uuid`);
  await db.execute(sql`UPDATE workshop_loop_executions SET active=${input.status==='needs_review'} WHERE run_id=${input.runId}::uuid`);
  const metadata={lastControlRunId:loopRunId,lastControlReason:input.reason,lastControlStatus:input.status,...(input.commandId?{lastCancellationCommandId:input.commandId,lastCancelledLoopRunId:loopRunId,lastCancellationReason:input.reason,lastCancellationStatus:input.status}:{})};
  const current=sql`(${input.wasRunning} OR loop_states.state_json->>'lastLoopRunId'=${loopRunId})`;
  await db.execute(sql`INSERT INTO loop_states(loop_id,current_phase,last_observation,next_action,blocked_reason,state_json)
    VALUES (${loopId}::uuid,${input.status==='needs_review'?'blocked':'cancelled'},${input.reason},${input.status==='needs_review'?'Review the external outcome':'Wait for the next trigger'},${input.status==='needs_review'?input.reason:null},${JSON.stringify(metadata)}::jsonb)
    ON CONFLICT (loop_id) DO UPDATE SET
      current_phase=CASE WHEN ${current} THEN EXCLUDED.current_phase ELSE loop_states.current_phase END,
      last_observation=CASE WHEN ${current} THEN EXCLUDED.last_observation ELSE loop_states.last_observation END,
      next_action=CASE WHEN ${current} THEN EXCLUDED.next_action ELSE loop_states.next_action END,
      blocked_reason=CASE WHEN ${current} THEN EXCLUDED.blocked_reason ELSE loop_states.blocked_reason END,
      state_json=loop_states.state_json||EXCLUDED.state_json||CASE WHEN loop_states.state_json->>'lastScheduledRunId'=${input.runId} THEN jsonb_build_object('schedulerStatus',${input.status==='needs_review'?'needs_review':'idle'}::text) ELSE '{}'::jsonb END,updated_at=clock_timestamp()`);
  await append({workshopId:input.workshopId,runId:input.runId,loopId,loopRunId,type:`loop_execution_${input.status}`,title:input.status==='needs_review'?'Loop 执行结果待核对':'Loop 运行已取消',metadata:{actorId:input.userId,commandId:input.commandId,reasonCode:input.reason,execution:input.execution}});
}
