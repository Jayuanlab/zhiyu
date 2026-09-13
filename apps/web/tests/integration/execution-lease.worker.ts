import {sql} from 'drizzle-orm';
import {claimWorkshopExecution,withExecutionWrite} from '@/lib/work-runtime/execution-lease';
import {closePostgresDb} from '@/lib/db/adapters/postgres';
import {completeWorkshopRun} from '@/lib/workshops/service';
if(process.env.ZHIYU_TEST_MODE!=='integration')throw Error('Isolated fixture required');
const input=JSON.parse(process.env.ZHIYU_TEST_LEASE_INPUT!);
process.send?.({type:'ready'});
process.once('message',async()=>{
  try{
    if(process.env.ZHIYU_TEST_OPERATION==='completion'){
      process.send?.({type:'result',result:await completeWorkshopRun(input)});return;
    }
    const result=await claimWorkshopExecution(input);
    if(process.env.ZHIYU_TEST_CRASH==='true'&&result.state==='claimed'){
      await withExecutionWrite(result.lease,async context=>{
        await context.db.execute(sql`UPDATE workshops SET name='uncommitted' WHERE id=${input.workshopId}::uuid`);
        process.send?.({type:'uncommitted',lease:result.lease});
        await new Promise(()=>{});
      });
    }
    process.send?.({type:'result',result});
  }catch(error){process.send?.({type:'failure',message:String(error)});process.exitCode=1;}
  finally{await closePostgresDb();process.disconnect();}
});
