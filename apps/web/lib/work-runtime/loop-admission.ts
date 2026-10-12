import {sql} from 'drizzle-orm';
import type {Loop,LoopState} from '@/lib/db/schema';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import type {AcceptWorkLoopCommand} from './loop-command';
import {workCommandChildId} from './child-id';
import {assertMemoryDependenciesCurrentInTransaction} from '@/lib/brain/memory-dependencies';

export async function setLoopScheduleExecutionPhase({db}:WorkshopWriteContext,runId:string,phase:'running'|'idle'|'needs_review'){
  await db.execute(sql`UPDATE loop_states SET state_json=jsonb_set(state_json,'{schedulerStatus}',to_jsonb(${phase}::text)),updated_at=clock_timestamp() WHERE loop_id IN (SELECT loop_id FROM workshop_loop_executions WHERE run_id=${runId}::uuid) AND state_json->>'lastScheduledRunId'=${runId}`);
}

/** Database-only insertion shared by owner commands and the schedule cursor
 * transaction. The caller locks and validates the owned Work and Loop first. */
export async function insertAcceptedLoopExecution(request:AcceptWorkLoopCommand,loop:Loop,previousState:LoopState|null,{db,append}:WorkshopWriteContext){
  await assertMemoryDependenciesCurrentInTransaction(db,{userId:request.userId,entityKind:'loop',entityId:loop.id});
  const runId=workCommandChildId(request.userId,request.workId,request.commandId!,'loop-run');
  const trigger={type:'loop_execution',loopId:loop.id,mode:request.mode,triggeredBy:request.triggeredBy,reason:request.triggerReason??{},commandId:request.commandId};
  const snapshot={loopName:loop.name,triggerConfig:loop.triggerConfig,previousState};
  await db.execute(sql`INSERT INTO workshop_runs(id,workshop_id,status,trigger_reason,input_snapshot,started_at) VALUES (${runId}::uuid,${request.workId}::uuid,'queued',${JSON.stringify(trigger)}::jsonb,${JSON.stringify(snapshot)}::jsonb,NULL)`);
  await db.execute(sql`INSERT INTO loop_runs(id,loop_id,status,trigger_reason,input_snapshot,started_at) VALUES (${runId}::uuid,${loop.id}::uuid,'queued',${JSON.stringify(trigger)}::jsonb,${JSON.stringify(snapshot)}::jsonb,NULL)`);
  await db.execute(sql`INSERT INTO workshop_loop_executions(run_id,loop_run_id,loop_id,workshop_id,request_json) VALUES (${runId}::uuid,${runId}::uuid,${loop.id}::uuid,${request.workId}::uuid,${JSON.stringify(request)}::jsonb)`);
  await append({workshopId:request.workId,runId,loopId:loop.id,loopRunId:runId,type:'loop_execution_accepted',title:'Loop 运行已排队',metadata:{actorId:request.userId,commandId:request.commandId,mode:request.mode,triggeredBy:request.triggeredBy}});
  return {commandId:request.commandId!,runId,loopRunId:runId,loopId:loop.id,workId:request.workId,status:'queued' as const};
}
