import {config} from 'dotenv';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {workerConfiguration} from '../lib/runtime/mode.ts';
import {RuntimeHostStore} from '../lib/runtime/host-store.ts';
import {RuntimeHostController} from '../lib/runtime/host-controller.ts';

// Explicit process environment wins; local overrides base, matching Next.
config({path:'.env.local',quiet:true});
config({path:'.env',quiet:true});
const configuration=workerConfiguration();
if(!configuration.enabled){
  console.log(JSON.stringify({event:'runtime_not_started',mode:configuration.mode}));
  process.exit(0);
}
if(process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true')throw Error('runtime_requires_postgres');
const databaseUrl=process.env.POSTGRES_URL||process.env.DATABASE_URL;
if(!databaseUrl)throw Error('runtime_database_required');
const {assertTestDatabaseConnection}=await import('../lib/db/test-connection-guard.ts');
assertTestDatabaseConnection('postgres',databaseUrl);
const sql=postgres(databaseUrl,{max:1,connect_timeout:5,idle_timeout:10,
  connection:{statement_timeout:10000},onnotice:()=>{}});
const store=new RuntimeHostStore(sql);
if(process.argv.includes('--status')){
  try{console.log(JSON.stringify({event:'runtime_status',ownerId:configuration.ownerId,status:await store.status(configuration.ownerId)}));}
  finally{await sql.end({timeout:2});}
}else{
  const instanceId=randomUUID();
  // Load business code only after the explicit mode and owner checks.
  const {createWorkModules}=await import('../lib/runtime/work-modules.ts');
  const {PaperTickStore}=await import('../lib/runtime/paper-tick-store.ts');
  const {createPaperMatchingModule}=await import('../lib/runtime/paper-matching-module.ts');
  const host=new RuntimeHostController({store,ownerId:configuration.ownerId,instanceId,mode:'worker',
    ttlMs:configuration.leaseMs,enabled:()=>workerConfiguration().enabled,
    modules:[...createWorkModules(configuration.ownerId,instanceId),createPaperMatchingModule(configuration.ownerId,new PaperTickStore(sql))]});
  let stopping=false,lastState='',timer;
  const report=()=>{
    const snapshot=host.snapshot();
    const state=JSON.stringify({phase:snapshot.phase,error:snapshot.error,
      modules:snapshot.modules.map(({name,phase,lastError})=>({name,phase,lastError}))});
    if(state!==lastState){lastState=state;console.log(JSON.stringify({event:'runtime_state',instanceId,at:new Date().toISOString(),...snapshot}));}
    return snapshot;
  };
  async function stop(reason){
    if(stopping)return;
    stopping=true;clearInterval(timer);
    // A hung adapter or pool shutdown must not keep this process alive forever.
    // An unconfirmed stop retains the lease/module evidence for expiry recovery.
    const deadline=setTimeout(()=>{
      console.error(JSON.stringify({event:'runtime_exit_unconfirmed',instanceId,reason,snapshot:host.snapshot()}));
      process.exit(1);
    },configuration.stopGraceMs+configuration.leaseMs+5000);
    try{
      const result=await host.stop(configuration.stopGraceMs);
      const snapshot=report();
      console.log(JSON.stringify({event:'runtime_stop',instanceId,reason,...result,phase:snapshot.phase}));
      process.exitCode=result.settled&&snapshot.phase==='stopped'&&reason!=='lease_lost'?0:1;
      const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');
      await Promise.all([sql.end({timeout:2}),closePostgresDb()]);
      if(process.connected)process.disconnect();
      if(!result.settled)process.exit(1);
    }finally{clearTimeout(deadline);}
  }
  process.once('SIGINT',()=>void stop('SIGINT'));
  process.once('SIGTERM',()=>void stop('SIGTERM'));
  if(process.connected)process.once('disconnect',()=>void stop('parent_disconnect'));
  // IPC is available only to the local parent that created this child process.
  process.on('message',message=>{
    if(message==='stop')void stop('parent_stop');
    else if(message==='pause')host.pause();
    else if(message==='resume')host.resume();
  });
  async function step(){
    if(stopping)return;
    await host.step();
    if(report().phase==='lost')await stop('lease_lost');
  }
  timer=setInterval(()=>void step(),configuration.heartbeatMs);
  await step();
  if(host.snapshot().phase==='running'&&process.connected)process.send({event:'runtime_ready',instanceId},()=>{});
}
