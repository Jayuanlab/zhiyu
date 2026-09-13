import type {Loop,LoopState} from '@/lib/db/schema';
import {executeWorkshopLoopCommand} from '@/lib/workshops/loop-runtime';
import {dispatchScheduledWorkLoop} from '@/lib/work-runtime/loop-schedule';
import {getEffectiveNextLoopRun,isNativeScheduledTrigger,type LoopSchedulerStateJson} from './schedule';
import {getLoopState,listLoops} from './service';
import {LOOP_MIGRATION_REQUIRED_MESSAGE} from './execution-boundary';

export type NativeLoopSchedulerExecutionMode='agent'|'dry_run';

/** Observation only. The Work schedule transaction owns cursor initialization,
 * missed-slot decisions, holiday skipping and admission. */
export async function listDueNativeLoops(input:{userId:string;now?:Date}):Promise<Array<{loop:Loop;state:LoopState|null;nextRunAt:Date}>>{
  const now=input.now??new Date(),loops=await listLoops(input.userId,{status:'active',limit:500});
  const due:Array<{loop:Loop;state:LoopState|null;nextRunAt:Date}>=[];
  for(const loop of loops){
    if(!isNativeScheduledTrigger(loop.triggerConfig))continue;
    const state=await getLoopState(loop.id);
    const nextRunAt=getEffectiveNextLoopRun({triggerConfig:loop.triggerConfig,stateJson:(state?.stateJson??{}) as LoopSchedulerStateJson,baseline:state?.updatedAt??loop.updatedAt??loop.createdAt});
    if(nextRunAt&&nextRunAt<=now)due.push({loop,state,nextRunAt});
  }
  return due;
}

export async function runDueNativeLoops(input:{userId?:string;now?:Date;executionMode?:NativeLoopSchedulerExecutionMode;awaitCompletion?:boolean;signal?:AbortSignal}):Promise<{launched:number;skipped:number;queued?:number;errors?:Array<{loopId:string;message:string;code?:string}>}>{
  if(!input.userId||input.signal?.aborted)return {launched:0,skipped:0};
  const due=await listDueNativeLoops({userId:input.userId,now:input.now});
  let launched=0,skipped=0,queued=0;
  const errors:Array<{loopId:string;message:string;code?:string}>=[];
  for(const {loop,nextRunAt} of due){
    if(input.signal?.aborted)break;
    if(!loop.workshopId){
      skipped++;errors.push({loopId:loop.id,code:'loop_migration_required',message:LOOP_MIGRATION_REQUIRED_MESSAGE});continue;
    }
    try{
      const accepted=await dispatchScheduledWorkLoop({userId:input.userId,workId:loop.workshopId,loopId:loop.id,scheduledAt:nextRunAt.toISOString(),mode:input.executionMode==='dry_run'?'dry_run':'native_agent'});
      if(accepted.state==='accepted'&&!accepted.replayed){
        queued++;
        if(input.awaitCompletion&&!input.signal?.aborted){await executeWorkshopLoopCommand(accepted.request,{acceptedRunId:accepted.runId,workerId:`scheduler:${crypto.randomUUID()}`,signal:input.signal});launched++;}
      }else skipped++;
    }catch(error){errors.push({loopId:loop.id,message:error instanceof Error?error.message:String(error)});skipped++;}
  }
  return {launched,skipped,...(queued?{queued}:{}),...(errors.length?{errors}:{})};
}

/** Compatibility view of local tracking only. Actual execution authority and
 * running state live in persistent Work leases, never a process-local Set. */
export function getNativeLoopSchedulerStatus(){
  return {runningLoopIds:[] as string[],executionAuthority:'work-runtime' as const};
}
