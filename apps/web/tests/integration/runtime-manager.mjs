import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export async function checkRuntimeManager({client,databaseUrl,web,root,recordPrefix}){
  const owner=randomUUID(),children=[],checks=[];
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'runtime-manager@example.invalid')`;
  const env={...process.env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,
    POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ZHIYU_RUNTIME_MODE:'worker',ZHIYU_RUNTIME_OWNER_ID:owner,
    ENABLE_LOCAL_SCHEDULER:'true',TAURI_MODE:'false',IS_TAURI:'false',QUANT_PAPER_ACCOUNT_ID:'',QUANT_PAPER_OWNER_ID:'',
    QUANT_PAPER_SIGNING_KEY:'',QUANT_INTERNAL_TOKEN:'',ENABLE_STARTUP_LISTENERS:'false',WORK_HARNESS_EVOLUTION_ENABLED:'false',REPORT_QUALITY_EVALUATOR_ENABLED:'false'};
  const until=async(check,label)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timeout: '+label);};
  function start(overrides={}){
    const child=fork(path.join(web,'tests/integration/managed-application-child.mjs'),[],{cwd:web,env:{...env,...overrides},windowsHide:true,execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
    const item={child,stdout:'',stderr:'',done:false};children.push(item);
    child.stdout.on('data',data=>item.stdout+=data);child.stderr.on('data',data=>item.stderr+=data);
    item.exited=new Promise(resolve=>child.once('exit',code=>{item.done=true;resolve(code);}));return item;
  }
  const exit=async item=>{await until(()=>item.done,'manager exit');return item.exited;};
  const stop=async item=>{if(!item.done)item.child.send('stop');return exit(item);};
  try{
    const first=start();await until(()=>first.stdout.includes('fixture_web_ready'),'web after worker ready');
    assert.ok(first.stdout.indexOf('application_worker_ready')<first.stdout.indexOf('application_web_started'));
    assert.equal((await client`SELECT desired_status FROM runtime_instances WHERE owner_id=${owner}`)[0].desired_status,'running');
    const duplicate=start();assert.equal(await exit(duplicate),1);assert.ok(!duplicate.stdout.includes('application_web_started'));
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${owner}`)[0].n,1);
    first.child.send('pause');await until(async()=>(await client`SELECT desired_status FROM runtime_instances WHERE owner_id=${owner}`)[0].desired_status==='paused','manager pause');
    first.child.send('resume');await until(async()=>(await client`SELECT desired_status FROM runtime_instances WHERE owner_id=${owner}`)[0].desired_status==='running','manager resume');
    assert.equal(await stop(first),0);
    assert.equal((await client`SELECT phase FROM runtime_instances WHERE owner_id=${owner}`)[0].phase,'stopped');
    checks.push('real worker readiness before Web, duplicate launcher refusal, pause/resume and confirmed shutdown');
    for(const NODE_ENV of ['development','production']){
      const disabled=start({NODE_ENV,ENABLE_LOCAL_SCHEDULER:'false'});
      await until(()=>disabled.stdout.includes('fixture_web_ready'),'disabled web');assert.ok(!disabled.stdout.includes('application_worker_ready'));
      assert.equal(await stop(disabled),0);
    }
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${owner}`)[0].n,1);
    checks.push('disabled development and production start Web without a worker');
    const restarted=start();await until(()=>restarted.stdout.includes('fixture_web_ready'),'restart after confirmed shutdown');
    const ready=restarted.stdout.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>{try{return JSON.parse(line);}catch{return {};}}).find(item=>item.event==='application_worker_ready');
    assert.ok(Number.isInteger(ready?.pid));
    // PID was returned by this test's own manager, never discovered from global processes.
    process.kill(ready.pid,'SIGKILL');
    assert.equal(await exit(restarted),1);
    const webStarted=restarted.stdout.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>{try{return JSON.parse(line);}catch{return {};}}).find(item=>item.event==='application_web_started');
    assert.throws(()=>process.kill(webStarted.pid,0));
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${owner}`)[0].n,2);
    checks.push('restart after stop and unexpected worker exit stops owned Web with failure status');
    const disconnectedOwner=randomUUID();
    await client`INSERT INTO "User"(id,email) VALUES (${disconnectedOwner},'runtime-manager-disconnect@example.invalid')`;
    const disconnected=start({ZHIYU_RUNTIME_OWNER_ID:disconnectedOwner});
    await until(()=>disconnected.stdout.includes('fixture_web_ready'),'parent disconnect fixture');
    disconnected.child.disconnect();assert.equal(await exit(disconnected),0);
    assert.equal((await client`SELECT phase FROM runtime_instances WHERE owner_id=${disconnectedOwner}`)[0].phase,'stopped');
    checks.push('parent IPC disconnect confirms worker shutdown instead of leaving an orphan');
    return {name:'managed application with real runtime worker and isolated Web fixture',passed:true,checks};
  }finally{
    for(const item of children)if(!item.done)await stop(item);
    fs.writeFileSync(path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-manager.json`),JSON.stringify({checks,children:children.map(({stdout,stderr})=>({stdout,stderr}))},null,2));
  }
}
