import postgres from 'postgres';
import {RuntimeHostStore} from '../../lib/runtime/host-store.ts';
import {RuntimeHostController} from '../../lib/runtime/host-controller.ts';

const url=new URL(process.env.RUNTIME_HOST_TEST_URL);
if(!url.pathname.startsWith('/zhiyu_test_')||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Isolated database required');
const sql=postgres(url.toString(),{max:1,connect_timeout:1,idle_timeout:1,onnotice:()=>{}});
const emit=value=>process.send?.({...value,instanceId:process.env.RUNTIME_HOST_TEST_INSTANCE});
const host=new RuntimeHostController({store:new RuntimeHostStore(sql),ownerId:process.env.RUNTIME_HOST_TEST_OWNER,
  instanceId:process.env.RUNTIME_HOST_TEST_INSTANCE,mode:'worker',ttlMs:1500,enabled:()=>true,
  modules:[{name:'slow',intervalMs:10000,timeoutMs:10000,run:signal=>new Promise(resolve=>{
    emit({kind:'slow_started'});
    signal.addEventListener('abort',()=>{emit({kind:'slow_aborted'});resolve();},{once:true});
  })},{name:'fast',intervalMs:100,timeoutMs:500,run:async()=>{emit({kind:'fast_started'});}}]});
let lastPhase;
async function step(){
  await host.step();const phase=host.snapshot().phase;
  if(phase!==lastPhase){lastPhase=phase;emit({kind:'phase',phase});}
}
const timer=setInterval(()=>void step(),150);
process.on('message',async message=>{
  if(message==='disconnect'){await sql.end({timeout:0});emit({kind:'database_disconnected'});}
  if(message==='stop'){
    clearInterval(timer);await host.stop(500);emit({kind:'stopped',snapshot:host.snapshot()});
    await sql.end({timeout:1});process.disconnect();
  }
});
await step();
