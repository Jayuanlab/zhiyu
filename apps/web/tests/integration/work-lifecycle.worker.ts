import {createWork,deleteWork} from "@/lib/work-runtime/commands";
import {runWorkLifecycleCommand} from "@/lib/work-runtime/lifecycle-command";
import {createWorkshop} from "@/lib/workshops/service";
import {closePostgresDb} from "@/lib/db/adapters/postgres";
if(process.env.ZHIYU_TEST_MODE!=="integration") throw Error("Isolated fixture required");
const owner=process.env.ZHIYU_TEST_OWNER_ID!,commandId=process.env.ZHIYU_TEST_COMMAND_ID!,operation=process.env.ZHIYU_TEST_OPERATION!;
process.send?.({type:'ready',pid:process.pid});
process.once('message',async()=>{
  try {
    const command={commandId,input:{userId:owner,name:'Concurrent lifecycle',mission:'isolated lifecycle'}};
    let result;
    if(operation==='crash') {
      result=await runWorkLifecycleCommand({ownerId:owner,type:'createWork',command},async(input,context,workId)=>{
        const work=await createWorkshop(input.input,context,workId);
        process.send?.({type:'uncommitted',pid:process.pid});
        await new Promise(()=>{});return work;
      });
    } else if(operation==='delete') {
      result=await deleteWork({userId:owner,workId:process.env.ZHIYU_TEST_WORK_ID!,commandId,expectedVersion:1});
    } else result=await createWork(command);
    process.send?.({type:'result',pid:process.pid,result});
  } catch(error) {process.send?.({type:'failure',message:String(error)});process.exitCode=1;}
  finally {await closePostgresDb();process.disconnect();}
});
