import {createInteractionProcessingJob,claimInteractionProcessingJob,beginInteractionProcessingWrites,failInteractionProcessingJob} from '../../lib/interactions/processing-jobs.ts';
import {getInteractionEventsByIds} from '../../lib/interactions/service.ts';
import {interactionPlanContext,saveInteractionProcessingPlan} from '../../lib/interactions/processing-plans.ts';
import {runPendingInteractionProcessingJobs} from '../../lib/interactions/worker.ts';
import {closePostgresDb} from '../../lib/db/adapters/postgres.ts';
const [mode,userId,eventId]=process.argv.slice(2);
try{
  if(mode==='seed'||mode==='seed-summary'){
    const created=await createInteractionProcessingJob({userId,eventIds:[eventId],processingMode:'full'});
    const job=await claimInteractionProcessingJob({userId,jobId:created.id});
    const events=await getInteractionEventsByIds({userId,ids:[eventId]});
    const attempt={userId,jobId:job.id,attempt:job.attempts};
    const contextHash=await interactionPlanContext(userId,events,'full');
    const payload=mode==='seed-summary'?{version:1,mode:'fallback_summary',processingMode:'full',contextHash,error:'fixture model unavailable'}:
      {version:1,mode:'llm',model:'saved-fixture',processingMode:'full',contextHash,
      plan:{notes:[{title:'恢复计划笔记',body:'来自保存的计划，不再次请求模型',sourceEventIds:[eventId]}],tasks:[],memories:[]}};
    const hash=await saveInteractionProcessingPlan({...attempt,payload});
    await beginInteractionProcessingWrites(attempt);await failInteractionProcessingJob({...attempt,error:Error('fixture before atomic commit')});
    console.log(JSON.stringify({event:'resume_fixture',jobId:job.id,hash}));
  }else if(mode==='drain'){
    // Any model request is a test failure: this task already has a persisted plan.
    globalThis.fetch=async()=>{throw Error('unexpected_model_request');};
    console.log(JSON.stringify({event:'resume_fixture',result:await runPendingInteractionProcessingJobs({userId})}));
  }else throw Error('invalid_fixture_mode');
}finally{await closePostgresDb();}
