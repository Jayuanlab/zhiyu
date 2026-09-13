import {sql} from 'drizzle-orm';
import {runDatabaseWorkCommand} from './database-command';
import {WorkCommandConflict} from './command-ledger';
import {insertAcceptedLoopExecution} from './loop-admission';
import {workCommandChildId} from './child-id';
import type {WorkCommandMeta} from './types';
import {getLoopInWorkshop,getLoopState} from '@/lib/loops/service';

export type AcceptWorkLoopCommand=WorkCommandMeta&{userId:string;workId:string;loopId:string;mode:'dry_run'|'native_agent';triggeredBy:'manual'|'scheduler'|'api';triggerReason?:Record<string,unknown>;createOutboxDrafts?:boolean;completionMode?:'native'|'workshop'};

/** Accept only. Queue, Loop observation and event commit with the command
 * receipt; execution will claim the linked Work run in a separate transaction. */
export async function acceptWorkLoopExecution(command:AcceptWorkLoopCommand){
  command={...command,completionMode:command.completionMode??'native'};
  if(!['native','workshop'].includes(command.completionMode!))throw new WorkCommandConflict('invalid_command');
  if(!['dry_run','native_agent'].includes(command.mode)||!['manual','scheduler','api'].includes(command.triggeredBy)||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(command.loopId))throw new WorkCommandConflict('invalid_command');
  return runDatabaseWorkCommand(command,'acceptWorkLoopExecution',async(request,{db,append})=>{
    const work=await db.execute(sql`SELECT status FROM workshops WHERE id=${request.workId}::uuid AND user_id=${request.userId}::uuid FOR UPDATE`);
    if(!work[0])throw new WorkCommandConflict('not_found');
    if(work[0].status!=='active')throw new WorkCommandConflict('target_busy');
    await db.execute(sql`SELECT id FROM loops WHERE id=${request.loopId}::uuid AND workshop_id=${request.workId}::uuid AND user_id=${request.userId}::uuid FOR UPDATE`);
    const loop=await getLoopInWorkshop({userId:request.userId,workshopId:request.workId,loopId:request.loopId},db);
    if(!loop)throw new WorkCommandConflict('not_found');
    if(loop.status!=='active')throw new WorkCommandConflict('target_busy');
    if(loop.triggerConfig?.type==='scheduled_job')throw new WorkCommandConflict('invalid_command');
    const runId=workCommandChildId(request.userId,request.workId,request.commandId!,'loop-run');
    const reserved=await db.execute(sql`SELECT 1 FROM workshop_loop_executions WHERE run_id=${runId}::uuid`);
    if(reserved[0])throw new WorkCommandConflict('payload_conflict');
    const occupied=await db.execute(sql`SELECT 1 FROM workshop_loop_executions WHERE loop_id=${loop.id}::uuid AND active UNION ALL SELECT 1 FROM loop_runs WHERE loop_id=${loop.id}::uuid AND status IN ('queued','running','cancel_requested','needs_review') LIMIT 1`);
    if(occupied[0])throw new WorkCommandConflict('target_busy');
    const previousState=await getLoopState(loop.id,db);
    return insertAcceptedLoopExecution(request,loop,previousState,{db,append});
  });
}
