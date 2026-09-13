import {config} from 'dotenv';
import {randomUUID} from 'node:crypto';
config({path:'.env',quiet:true});
const value=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const userId=value('userId'),intervalMs=Number(value('intervalMs')??3000);
if(!userId)throw Error('Missing --userId');
if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>300000)throw Error('Invalid intervalMs');
if(process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true')throw Error('Consumer requires PostgreSQL server mode');
if(process.env.ENABLE_LOCAL_SCHEDULER!=='false'||process.env.ENABLE_STARTUP_LISTENERS!=='false')throw Error('Disable legacy scheduler and startup listeners before starting consumer');
const {consumeOwnedWorkRuns}=await import('../lib/work-runtime/run-consumer.ts');
const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');
const controller=new AbortController(),workerId=randomUUID(),once=process.argv.includes('--once');
let wake;
const stop=()=>{controller.abort();wake?.();};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
  do{
    try{
      const runs=await consumeOwnedWorkRuns({userId,workerId,signal:controller.signal});
      console.log(JSON.stringify({workerId,checkedAt:new Date().toISOString(),runs}));
      if(once&&runs.some(run=>run.state==='error'))process.exitCode=1;
    }catch(error){console.error(error);if(once)process.exitCode=1;}
    if(once||controller.signal.aborted)break;
    await new Promise(resolve=>{const timer=setTimeout(resolve,intervalMs);wake=()=>{clearTimeout(timer);resolve();};});wake=undefined;
  }while(!controller.signal.aborted);
}finally{await closePostgresDb();}
