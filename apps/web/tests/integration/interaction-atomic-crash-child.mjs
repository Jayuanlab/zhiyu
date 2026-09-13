import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {RuntimeHostStore} from '../../lib/runtime/host-store.ts';
import {claimInteractionProcessingJob,beginInteractionProcessingWrites,applyInteractionProcessingWrites} from '../../lib/interactions/processing-jobs.ts';
import {createInteractionNote,createInteractionBrainMemory} from '../../lib/interactions/service.ts';
const [owner,jobId,eventId]=process.argv.slice(2),instanceId=randomUUID();
const sql=postgres(process.env.POSTGRES_URL,{max:1}),store=new RuntimeHostStore(sql);
const lease=await store.acquire(owner,instanceId,'worker',3000);await store.heartbeat(lease,3000,[]);
const job=await claimInteractionProcessingJob({userId:owner,jobId,runtimeInstanceId:instanceId});
const attempt={userId:owner,jobId,attempt:job.attempts,runtimeInstanceId:instanceId};
await beginInteractionProcessingWrites(attempt);
await applyInteractionProcessingWrites(attempt,async()=>{
  await createInteractionNote({userId:owner,title:'uncommitted',body:'never commit',noteType:'summary',sourceEventIds:[eventId]});
  await createInteractionBrainMemory({userId:owner,memoryType:'project',subject:'Uncommitted crash memory',content:'never commit',sourceEventIds:[eventId]});
  process.send({ready:true,instanceId});
  await new Promise(()=>{});
});
