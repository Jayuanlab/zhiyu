import {config} from 'dotenv';
import {randomUUID} from 'node:crypto';
config({path:'.env',quiet:true});
const value=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const userId=value('userId');if(!userId)throw Error('Missing --userId');
const intervalMs=Number(value('intervalMs')??30000);
if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>300000)throw Error('Invalid intervalMs');
if(process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true')throw Error('Outbox recovery requires PostgreSQL server mode');
const {recoverOwnedOutbox}=await import('../lib/work-runtime/outbox-recovery.ts');
const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');
const workerId=randomUUID(),once=process.argv.includes('--once');
let stopped=false,wake;
const stop=()=>{stopped=true;wake?.();};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
  do{
    try{const result=await recoverOwnedOutbox({userId,workerId});console.log(JSON.stringify({workerId,checkedAt:new Date().toISOString(),...result}));if(once&&result.errors)process.exitCode=1;}
    catch(error){console.error(error);if(once)process.exitCode=1;}
    if(once||stopped)break;
    await new Promise(resolve=>{const timer=setTimeout(resolve,intervalMs);wake=()=>{clearTimeout(timer);resolve();};});wake=undefined;
  }while(!stopped);
}finally{await closePostgresDb();}
