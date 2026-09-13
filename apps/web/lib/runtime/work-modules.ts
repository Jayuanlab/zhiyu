import type {RuntimeModule} from './module-supervisor';

/** Admission commits durable commands; consumers own execution and its cancellation.
 * Never detach a consumer promise: host occupancy must cover its actual lifetime. */
export function createWorkModules(ownerId:string,instanceId:string):RuntimeModule[]{
  return [
    {name:'loop-admission',intervalMs:10000,timeoutMs:30000,run:async signal=>{
      const {runDueNativeLoops}=await import('../loops/native-scheduler');
      if(signal.aborted)return;
      const result=await runDueNativeLoops({userId:ownerId,signal});
      if(result.errors?.length)throw Error(result.errors.every(error=>error.code==='loop_migration_required')?'loop_migration_required':'loop_admission_failed');
      return result;
    }},
    {name:'loop-execution',intervalMs:1000,timeoutMs:30*60*1000,run:async signal=>{
      const {consumeOwnedLoopRuns}=await import('../work-runtime/loop-consumer');
      if(signal.aborted)return;
      const result=await consumeOwnedLoopRuns({userId:ownerId,workerId:instanceId,signal,limit:5});
      if(result.some(run=>run.state==='error'))throw Error('loop_execution_failed');
      return result;
    }},
    {name:'work-execution',intervalMs:1000,timeoutMs:30*60*1000,run:async signal=>{
      const {consumeOwnedWorkRuns}=await import('../work-runtime/run-consumer');
      if(signal.aborted)return;
      const result=await consumeOwnedWorkRuns({userId:ownerId,workerId:instanceId,signal,limit:5});
      if(result.some(run=>run.state==='error'))throw Error('work_execution_failed');
      return result;
    }},
    {name:'heartbeat-admission',intervalMs:10000,timeoutMs:30000,run:async signal=>{
      const {runDueWorkshopHeartbeats}=await import('../workshops/heartbeat-scheduler');
      if(signal.aborted)return;
      const result=await runDueWorkshopHeartbeats({userId:ownerId,signal});
      if(result.errors.length)throw Error('heartbeat_scan_failed');
      return result;
    }},
    {name:'interaction-processing',intervalMs:10000,timeoutMs:5*60*1000,run:async signal=>{
      const {runPendingInteractionProcessingJobs}=await import('../interactions/worker');
      const {countInteractionProcessingReviews,recoverInterruptedInteractionJobs}=await import('../interactions/processing-jobs');
      if(signal.aborted)return;
      await recoverInterruptedInteractionJobs(ownerId);
      if(signal.aborted)return;
      const result=await runPendingInteractionProcessingJobs({userId:ownerId,runtimeInstanceId:instanceId,signal,limit:20,concurrency:2});
      if(result.failed)throw Error('interaction_processing_failed');
      if(result.degraded)throw Error('interaction_processing_degraded');
      if(await countInteractionProcessingReviews(ownerId))throw Error('interaction_processing_needs_review');
      return result;
    }},
    {name:'interaction-ingestion',intervalMs:10000,timeoutMs:3*60*1000,run:async signal=>{
      const {runDueInteractionIngestion}=await import('../knowledge-pipeline/ingestion-runtime');
      if(signal.aborted)return;
      const result=await runDueInteractionIngestion({userId:ownerId,signal});
      if(result.lastStatus==='error')throw Error(result.lastError==='wechat_sources_partially_unavailable'?'interaction_ingestion_degraded':'interaction_ingestion_failed');
      return result;
    }},
    {name:'outbox-recovery',intervalMs:10000,timeoutMs:3*60*1000,run:async signal=>{
      const {recoverOwnedOutbox}=await import('../work-runtime/outbox-recovery');
      if(signal.aborted)return;
      const result=await recoverOwnedOutbox({userId:ownerId,workerId:instanceId,signal,limit:10});
      if(result.errors)throw Error('outbox_recovery_failed');
      if(result.unconfirmed)throw Error('outbox_result_unconfirmed');
      return result;
    }},
  ];
}
