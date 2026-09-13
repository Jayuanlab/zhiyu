import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {RuntimeHostStore} from '../../lib/runtime/host-store.ts';

export async function checkRuntimeHostCli({client,databaseUrl,web,root,recordPrefix}){
  const owner=randomUUID(),work=randomUUID(),loop=randomUUID(),children=[],checks=[];
  const env={...process.env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,
    POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,TAURI_MODE:'false',IS_TAURI:'false',
    ZHIYU_RUNTIME_MODE:'worker',ZHIYU_RUNTIME_OWNER_ID:owner,ENABLE_LOCAL_SCHEDULER:'true',
    QUANT_PAPER_ACCOUNT_ID:'',QUANT_PAPER_OWNER_ID:'',QUANT_PAPER_SIGNING_KEY:'',QUANT_INTERNAL_TOKEN:'',
    ENABLE_STARTUP_LISTENERS:'false',WORK_HARNESS_EVOLUTION_ENABLED:'false',REPORT_QUALITY_EVALUATOR_ENABLED:'false'};
  function start(script,args=[],overrides={}){
    const child=fork(path.join(web,script),args,{cwd:web,windowsHide:true,execArgv:['--import','tsx','--conditions=react-server'],
      env:{...env,...overrides},stdio:['ignore','pipe','pipe','ipc']});
    const record={child,stdout:'',stderr:'',done:false};
    record.exited=new Promise(resolve=>{child.once('error',error=>{record.done=true;resolve({error:String(error)});});child.once('exit',(code,signal)=>{record.done=true;resolve({code,signal});});});
    child.stdout.on('data',data=>record.stdout+=data);child.stderr.on('data',data=>record.stderr+=data);children.push(record);return record;
  }
  async function until(check,label,timeout=30000){
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}
    throw Error(`Timed out: ${label}`);
  }
  async function exit(record){await until(()=>record.done,'CLI exit');return record.exited;}
  try{
    await client`INSERT INTO "User"(id,email) VALUES (${owner},'runtime-cli@example.invalid')`;
    // The real admission transaction queues a dry-run slot; no model or external action is needed.
    const at=new Date(Date.now()-10000).toISOString();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'runtime CLI','isolated')`;
    await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,status,trigger_config,verification_config)
      VALUES (${loop},${owner},${work},'runtime CLI','observe','active',${JSON.stringify({type:'once',at})}::jsonb,${JSON.stringify({modelChecker:{enabled:false}})}::jsonb)`;
    await client`UPDATE loops SET created_at=clock_timestamp()-interval '60 seconds',updated_at=clock_timestamp()-interval '60 seconds' WHERE id=${loop}`;
    const producer=start('tests/integration/loop-schedule-worker.mjs',[JSON.stringify({userId:owner,workId:work,loopId:loop,scheduledAt:at,mode:'dry_run'})]);
    assert.equal((await exit(producer)).code,0,producer.stderr);
    const [queued]=await client`SELECT run_id FROM workshop_loop_executions WHERE loop_id=${loop}`;
    assert.ok(queued?.run_id,'durable dry-run was admitted');
    const store=new RuntimeHostStore(client),before=Date.now();
    const worker=start('scripts/start-runtime-worker.mjs');
    await until(async()=>Boolean((await store.status(owner))?.online),'first durable heartbeat',10000);
    const firstHeartbeatMs=Date.now()-before;
    await until(async()=>{
      const [run]=await client`SELECT status FROM workshop_runs WHERE id=${queued.run_id}`;
      return run?.status==='completed';
    },'real queued Loop consumed',60000);
    const state=await store.status(owner);
    assert.equal(state.modules.length,8);
    await until(async()=>(await store.status(owner)).modules.every(module=>module.name==='paper-matching'?module.lastError==='paper_migration_required':module.lastSuccessAt!==null),'each adapter completed a scan or explicitly reported missing paper migration');
    checks.push({name:'CLI heartbeat and actual queued dry-run execution without a browser',passed:true,firstHeartbeatMs,runId:queued.run_id});
    worker.child.send('pause');
    await until(async()=>(await store.status(owner)).desired_status==='paused','persisted pause');
    const query=start('scripts/start-runtime-worker.mjs',['--status']);assert.equal((await exit(query)).code,0,query.stderr);
    assert.ok(query.stdout.includes('runtime_status'));assert.equal((await store.status(owner)).instance_id,state.instance_id);
    worker.child.send('resume');await until(async()=>(await store.status(owner)).desired_status==='running','persisted resume');
    worker.child.send('stop');assert.equal((await exit(worker)).code,0,worker.stderr);
    const stopped=await store.status(owner);assert.equal(stopped.online,false);assert.equal(stopped.phase,'stopped');
    checks.push({name:'parent pause/resume, read-only status and confirmed stop',passed:true});
    for(const NODE_ENV of ['development','production']){
      for(const script of ['scripts/start-runtime-worker.mjs','scripts/start-workshop-heartbeat-scheduler.ts']){
        const disabled=start(script,[],{NODE_ENV,ENABLE_LOCAL_SCHEDULER:'false'});
        assert.equal((await exit(disabled)).code,0,disabled.stderr);
        assert.ok(disabled.stdout.includes('not_started'));
      }
    }
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${owner}`)[0].n,1);
    checks.push({name:'new and legacy entries obey disabled in development and production',passed:true});
    return {name:'formal runtime CLI with real Work execution',passed:true,checks};
  }finally{
    for(const record of children)if(!record.done){record.child.kill();await record.exited;}
    fs.writeFileSync(path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-cli.json`),JSON.stringify({checks,children:children.map(({stdout,stderr})=>({stdout,stderr}))},null,2));
  }
}
