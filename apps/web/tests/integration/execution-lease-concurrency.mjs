import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function checkExecutionLeaseConcurrency({env,databaseUrl,client,web}){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID(),other=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'lease-process@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'before','isolated')`;
  for(const id of [runId,other])await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${id},${workshopId},'queued',NULL)`;
  const workers=[];
  function spawn(id,crash=false){
    const input={userId,workshopId,runId:id,workerId:randomUUID(),leaseMs:30000};
    const child=fork(path.join(web,'tests/integration/execution-lease.worker.ts'),[],{cwd:web,execArgv:['--import','tsx','--conditions=react-server'],silent:true,windowsHide:true,
      env:{...env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',TAURI_MODE:'false',IS_TAURI:'false',ZHIYU_TEST_DATABASE_URL:databaseUrl,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ZHIYU_TEST_LEASE_INPUT:JSON.stringify(input),ZHIYU_TEST_CRASH:String(crash),ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false'}});
    child.stdout.resume();let stderr='';child.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000);});
    const exit=new Promise(resolve=>child.once('exit',resolve));
    const message=type=>new Promise((resolve,reject)=>{child.on('message',data=>{if(data.type===type)resolve(data);if(data.type==='failure')reject(Error(data.message));});child.once('error',reject);child.once('exit',()=>reject(Error(`worker exited before ${type}: ${stderr}`)));});
    const ready=message('ready'),result=message(crash?'uncommitted':'result');ready.catch(()=>{});result.catch(()=>{});
    const timer=setTimeout(()=>child.kill(),45000),worker={child,ready,result,exit,timer};workers.push(worker);return worker;
  }
  try{
    const pair=[spawn(runId),spawn(other)];await Promise.all(pair.map(w=>w.ready));pair.forEach(w=>w.child.send('start'));
    const results=await Promise.all(pair.map(w=>w.result));await Promise.all(pair.map(w=>w.exit));
    assert.deepEqual(results.map(r=>r.result.state).sort(),['busy','claimed']);
    const winner=results.find(r=>r.result.state==='claimed').result;
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${workshopId} AND status='running'`)[0].n,1);
    await client`UPDATE workshop_execution_leases SET lease_until=now()-interval '1 second' WHERE workshop_id=${workshopId}`;
    const crash=spawn(winner.lease.runId,true);await crash.ready;crash.child.send('start');const uncommitted=await crash.result;crash.child.kill();await crash.exit;
    assert.equal((await client`SELECT name FROM workshops WHERE id=${workshopId}`)[0].name,'before');
    assert.equal(uncommitted.lease.token,winner.lease.token+1);
    await client`UPDATE workshop_execution_leases SET lease_until=now()-interval '1 second' WHERE workshop_id=${workshopId}`;
    const recovery=spawn(winner.lease.runId);await recovery.ready;recovery.child.send('start');const recovered=(await recovery.result).result;await recovery.exit;
    assert.equal(recovered.state,'claimed');assert.equal(recovered.lease.token,uncommitted.lease.token+1);
    return {name:'two processes claim one Work; killed guarded transaction rolls back; replacement increments fencing token',passed:true,pids:pair.map(w=>w.child.pid),crashedPid:crash.child.pid,recoveredPid:recovery.child.pid};
  }finally{for(const w of workers){clearTimeout(w.timer);if(w.child.exitCode===null)w.child.kill();}await Promise.all(workers.map(w=>w.exit));}
}
