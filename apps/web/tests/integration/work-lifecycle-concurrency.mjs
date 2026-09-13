import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function checkWorkLifecycleConcurrency({env,databaseUrl,client,web}) {
  const owner=randomUUID();await client`INSERT INTO "User"(id,email) VALUES (${owner},'concurrent-lifecycle@example.invalid')`;
  const children=[];
  function spawn(operation,commandId,workId='') {
    const child=fork(path.join(web,'tests/integration/work-lifecycle.worker.ts'),[],{
      cwd:web,execArgv:['--import','tsx','--conditions=react-server'],silent:true,
      env:{...env,NODE_ENV:'test',TAURI_MODE:'false',IS_TAURI:'false',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,
        POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ZHIYU_TEST_OWNER_ID:owner,ZHIYU_TEST_COMMAND_ID:commandId,ZHIYU_TEST_WORK_ID:workId,
        ZHIYU_TEST_OPERATION:operation,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false'},
    });
    let error='';child.stdout.resume();child.stderr.on('data',chunk=>{error=(error+chunk).slice(-3000);});
    function message(type) {return new Promise((resolve,reject)=>{
      child.on('message',data=>{if(data.type===type)resolve(data);if(data.type==='failure')reject(Error(data.message));});
      child.once('error',reject);child.once('exit',()=>reject(Error(`Exited before ${type}: ${error}`)));
    });}
    const ready=message('ready'),outcome=message(operation==='crash'?'uncommitted':'result');ready.catch(()=>{});outcome.catch(()=>{});
    const exit=new Promise(resolve=>child.once('exit',resolve));
    const timer=setTimeout(()=>child.kill(),45000);
    const worker={child,ready,outcome,exit,timer};children.push(worker);return worker;
  }
  async function pair(operation,id,workId) {
    const workers=[spawn(operation,id,workId),spawn(operation,id,workId)];
    await Promise.all(workers.map(w=>w.ready));workers.forEach(w=>w.child.send({type:'start'}));
    const results=await Promise.all(workers.map(w=>w.outcome));await Promise.all(workers.map(w=>w.exit));
    assert.deepEqual(results[0].result,results[1].result);return results[0].result;
  }
  try {
    const creationId=randomUUID(),created=await pair('create',creationId);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_work_versions WHERE workshop_id=${created.id}`)[0].n,1);
    await pair('delete',randomUUID(),created.id);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM work_command_events WHERE owner_id=${owner}`)[0].n,4);
    const crashId=randomUUID(),crash=spawn('crash',crashId);
    await crash.ready;crash.child.send({type:'start'});await crash.outcome;crash.child.kill();await crash.exit;
    assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM work_commands WHERE owner_id=${owner} AND command_id=${crashId}`)[0].n,0);
    await pair('create',crashId);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,1);
    return {name:'independent processes create/delete once; killed uncommitted creation fully rolls back and retries once',passed:true,pids:children.map(w=>w.child.pid)};
  } finally {for(const w of children){clearTimeout(w.timer);if(w.child.exitCode===null)w.child.kill();}await Promise.all(children.map(w=>w.exit));}
}
