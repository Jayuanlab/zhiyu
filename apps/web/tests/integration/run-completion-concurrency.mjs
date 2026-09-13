import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function checkRunCompletionConcurrency({env,databaseUrl,client,web}){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID(),directiveId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'complete-process@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'completion','isolated')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${workshopId},'running')`;
  await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content,scope) VALUES (${directiveId},${workshopId},${runId},'仅消费本轮','current_run')`;
  const input={userId,workshopId,runId,status:'completed',outputSummary:'两个进程同一结果',directiveIds:[directiveId]},workers=[];
  try{
    for(let i=0;i<2;i++){
      const child=fork(path.join(web,'tests/integration/execution-lease.worker.ts'),[],{cwd:web,execArgv:['--import','tsx','--conditions=react-server'],silent:true,windowsHide:true,
        env:{...env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',TAURI_MODE:'false',IS_TAURI:'false',ZHIYU_TEST_DATABASE_URL:databaseUrl,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ZHIYU_TEST_LEASE_INPUT:JSON.stringify(input),ZHIYU_TEST_OPERATION:'completion',ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false'}});
      child.stdout.resume();child.stderr.resume();const exit=new Promise(resolve=>child.once('exit',resolve));
      const message=type=>new Promise((resolve,reject)=>{child.on('message',data=>{if(data.type===type)resolve(data);if(data.type==='failure')reject(Error(data.message));});child.once('error',reject);child.once('exit',()=>reject(Error('worker exited before '+type)));});
      const ready=message('ready'),result=message('result');ready.catch(()=>{});result.catch(()=>{});const timer=setTimeout(()=>child.kill(),45000);workers.push({child,exit,ready,result,timer});
    }
    await Promise.all(workers.map(w=>w.ready));workers.forEach(w=>w.child.send('start'));
    const results=await Promise.all(workers.map(w=>w.result));await Promise.all(workers.map(w=>w.exit));assert.deepEqual(results[0],results[1]);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${runId} AND type='run_completed'`)[0].n,1);
    assert.equal((await client`SELECT status FROM workshop_directives WHERE id=${directiveId}`)[0].status,'consumed');
    assert.equal((await client`SELECT output_summary FROM workshop_runs WHERE id=${runId}`)[0].output_summary,'两个进程同一结果');
    return {name:'two independent processes finalize once with identical receipt and one completion event',passed:true,pids:workers.map(w=>w.child.pid)};
  }finally{workers.forEach(w=>{clearTimeout(w.timer);if(w.child.exitCode===null)w.child.kill();});await Promise.all(workers.map(w=>w.exit));}
}
