import {sql} from 'drizzle-orm';
import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import {getLoopInWorkshop,getLoopState,upsertLoopState} from '@/lib/loops/service';
import {computeNextLoopRun,getEffectiveNextLoopRun,isNativeScheduledTrigger,shouldSkipMissedCronRun} from '@/lib/loops/schedule';
import {isAShareTradingDay} from '@/lib/markets/a-share-trading-calendar';
import {WorkCommandConflict} from './command-ledger';
import {resolveExecutionLease} from './execution-context';
import {workCommandChildId} from './child-id';
import {canonicalCommandJson} from './command-payload';
import {insertAcceptedLoopExecution} from './loop-admission';
import type {AcceptWorkLoopCommand} from './loop-command';
import {scheduledLoopAuthority} from './scheduled-loop-authority';

type Input={userId:string;workId:string;loopId:string;scheduledAt:string;mode:'dry_run'|'native_agent'};
/** A schedule slot is a cursor transition, not an owner configuration version.
 * Its stable request/receipt lives in the linked run. Busy does not consume a
 * slot or a terminal command rejection; the next tick may retry it. */
export async function dispatchScheduledWorkLoop(input:Input){
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(resolveExecutionLease()||![input.userId,input.workId,input.loopId].every(id=>uuid.test(id))||!['dry_run','native_agent'].includes(input.mode)||!Number.isFinite(Date.parse(input.scheduledAt)))throw new WorkCommandConflict('invalid_command');
  input={...input,userId:input.userId.toLowerCase(),workId:input.workId.toLowerCase(),loopId:input.loopId.toLowerCase(),scheduledAt:new Date(input.scheduledAt).toISOString()};
  const commandId=`scheduled-loop:${input.loopId}:${input.scheduledAt}`;
  const request:AcceptWorkLoopCommand={userId:input.userId,workId:input.workId,loopId:input.loopId,commandId,source:'system',reason:'Scheduled Loop trigger',mode:input.mode,triggeredBy:'scheduler',triggerReason:{type:'native_scheduler',scheduledAt:input.scheduledAt},completionMode:'workshop'};
  const runId=workCommandChildId(input.userId,input.workId,commandId,'loop-run');
  return withWorkshopEventTransaction(async(db,append)=>{
    const works=await db.execute(sql`SELECT status FROM workshops WHERE id=${input.workId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`);
    if(!works[0])throw new WorkCommandConflict('not_found');
    await db.execute(sql`SELECT id FROM loops WHERE id=${input.loopId}::uuid AND workshop_id=${input.workId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`);
    const loop=await getLoopInWorkshop({userId:input.userId,workshopId:input.workId,loopId:input.loopId},db);
    if(!loop)throw new WorkCommandConflict('not_found');
    const prior=await db.execute(sql`SELECT x.request_json,r.status FROM workshop_loop_executions x JOIN workshop_runs r ON r.id=x.run_id WHERE x.run_id=${runId}::uuid`);
    if(prior[0]){
      if(canonicalCommandJson(prior[0].request_json)!==canonicalCommandJson(request))throw new WorkCommandConflict('payload_conflict');
      return {state:'accepted' as const,runId,commandId,status:String(prior[0].status),replayed:true,request};
    }
    if(scheduledLoopAuthority({workStatus:String(works[0].status),loopStatus:loop.status,previouslyAccepted:false})==='paused')return {state:'paused' as const};
    if(!isNativeScheduledTrigger(loop.triggerConfig))throw new WorkCommandConflict('invalid_command');
    const state=await getLoopState(loop.id,db),stateJson=state?.stateJson??{};
    const current=getEffectiveNextLoopRun({triggerConfig:loop.triggerConfig,stateJson,baseline:state?.updatedAt??loop.updatedAt??loop.createdAt});
    const clock=await db.execute(sql`SELECT clock_timestamp() AS now`),now=new Date(clock[0].now as string|Date);
    if(!current||current.toISOString()!==input.scheduledAt||current>now)return {state:'stale' as const};
    const occupied=await db.execute(sql`SELECT 1 FROM workshop_loop_executions WHERE loop_id=${loop.id}::uuid AND active UNION ALL SELECT 1 FROM loop_runs WHERE loop_id=${loop.id}::uuid AND status IN ('queued','running','cancel_requested','needs_review') LIMIT 1`);
    if(occupied[0])return {state:'busy' as const};
    const trigger=loop.triggerConfig,metadata=(stateJson.loopSpec as {metadata?:Record<string,unknown>}|undefined)?.metadata??{};
    const calendar=(trigger.tradingCalendar==='a-share'||trigger.tradingDayOnly===true||metadata.tradingCalendar==='a-share'||metadata.tradingDayOnly===true)?isAShareTradingDay(current):null;
    const skipReason=calendar&&!calendar.isTradingDay?calendar.reason:shouldSkipMissedCronRun({triggerConfig:trigger,nextRunAt:current,now})?'missed_cron_grace_exceeded':null;
    const once=trigger.type==='once',next=once?null:computeNextLoopRun({triggerConfig:trigger,from:now});
    if(!once&&!next)throw new WorkCommandConflict('invalid_command');
    const nextState={...stateJson,nextScheduledRunAt:next?.toISOString(),...(once?{onceScheduledAt:input.scheduledAt}:{}),schedulerError:undefined};
    if(skipReason){
      await upsertLoopState(loop.id,{stateJson:{...nextState,lastMissedRunAt:input.scheduledAt,schedulerStatus:'idle',lastScheduleSkipReason:skipReason,...(calendar&&!calendar.isTradingDay?{lastSkippedTradingCalendarAt:input.scheduledAt,lastSkippedTradingCalendarDate:calendar.date,lastSkippedTradingCalendarReason:calendar.reason,tradingCalendarSource:calendar.source}:{})}},db);
      await append({workshopId:input.workId,loopId:loop.id,type:'loop_schedule_skipped',title:'Loop 定时时刻已跳过',metadata:{actorId:input.userId,scheduledAt:input.scheduledAt,nextScheduledRunAt:next?.toISOString()??null,reason:skipReason,calendar}});
      return {state:'skipped' as const,reason:skipReason};
    }
    await insertAcceptedLoopExecution(request,loop,state,{db,append});
    await upsertLoopState(loop.id,{stateJson:{...nextState,lastScheduledRunAt:input.scheduledAt,schedulerStatus:'queued',lastScheduledRunId:runId}},db);
    await append({workshopId:input.workId,runId,loopId:loop.id,loopRunId:runId,type:'loop_schedule_advanced',title:'Loop 已排队并推进计划',metadata:{actorId:input.userId,commandId,scheduledAt:input.scheduledAt,nextScheduledRunAt:next?.toISOString()??null}});
    return {state:'accepted' as const,runId,commandId,status:'queued',replayed:false,request};
  });
}
