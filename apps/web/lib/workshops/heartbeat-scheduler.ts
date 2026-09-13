import {listWorkshopHeartbeatCandidates} from './service';
import {admitWorkshopHeartbeat} from '@/lib/work-runtime/heartbeat-admission';
import {projectWorkshopHeartbeat} from '@/lib/work-runtime/heartbeat-projection';

/** Observation only. Expiration/skip decisions are committed by admission. */
export async function listDueWorkshopHeartbeats(input:{userId?:string;now?:Date}){
  if(!input.userId)return [];
  const now=input.now??new Date();
  return (await listWorkshopHeartbeatCandidates(input.userId)).flatMap(({workshop,heartbeat})=>
    heartbeat&&workshop.status==='active'&&heartbeat.enabled&&heartbeat.schedulerStatus!=='paused'
      &&heartbeat.nextWakeupAt&&heartbeat.nextWakeupAt<=now
      ?[{workshop,heartbeat,scheduledAt:heartbeat.nextWakeupAt}]:[]);
}

/** Queue only, including callers that previously requested awaitCompletion.
 * The leased Work consumer owns execution; there is no detached lifecycle here. */
export async function runDueWorkshopHeartbeats(input:{userId?:string;now?:Date;awaitCompletion?:boolean;signal?:AbortSignal}){
  const result={launched:0,queued:0,skipped:0,errors:[] as Array<{workId:string;code:string}>};
  if(!input.userId||input.signal?.aborted)return result;
  const rows=await listWorkshopHeartbeatCandidates(input.userId),now=input.now??new Date();
  for(const {workshop,heartbeat} of rows){
    if(input.signal?.aborted)break;
    if(!heartbeat)continue;
    try{
      await projectWorkshopHeartbeat({userId:input.userId,workId:workshop.id,signal:input.signal});
      if(input.signal?.aborted)break;
      if(!heartbeat.nextWakeupAt||heartbeat.nextWakeupAt>now)continue;
      const accepted=await admitWorkshopHeartbeat({userId:input.userId,workId:workshop.id,scheduledAt:heartbeat.nextWakeupAt.toISOString(),signal:input.signal});
      if(accepted.state==='accepted'&&!accepted.replayed)result.queued++;
      else result.skipped++;
    }catch{
      result.errors.push({workId:workshop.id,code:'heartbeat_scan_failed'});
    }
  }
  return result;
}

/** Compatibility view. Task execution is read from persistent Work Runs. */
export function getWorkshopHeartbeatSchedulerStatus(){
  return {runningWorkshopIds:[] as string[],executionAuthority:'work-runtime' as const};
}
