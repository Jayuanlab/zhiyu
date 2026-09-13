import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

export async function checkWorkCommandProduction({env, databaseUrl, client, web, root}) {
  const owner = randomUUID(), work = randomUUID(), otherOwner = randomUUID(), otherWork = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'command-http@example.invalid'),(${otherOwner},'command-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'before','http fixture'),(${otherWork},${otherOwner},'private','http fixture')`;
  const origin = 'http://127.0.0.1:3522';
  const log = fs.openSync(path.join(root, 'docs/plans/2026-09-06-review-remediation/records/06B2-production-server.log'),'w');
  const child = spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-p','3522','-H','127.0.0.1'], {
    cwd: web, windowsHide: true, stdio:['ignore',log,log],
    env:{...env, AUTH_MODE:'local_owner', NODE_ENV:'production', ZHIYU_REVIEW_BUILD:'16', DEV_USER_ID:owner,
      POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',TAURI_MODE:'false',IS_TAURI:'false'},
  });
  const exited = new Promise(resolve => child.once('exit',resolve));
  async function request(url, body, method='POST') {
    return fetch(origin+url,{method,headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  }
  try {
    let ready=false;
    for(let i=0;i<60;i++) {
      if(child.exitCode!==null) throw Error('Candidate exited');
      try {if((await fetch(origin+'/api/identity',{signal:AbortSignal.timeout(1500)})).ok) {ready=true;break;}} catch {}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert(ready);
    const commandId=randomUUID(), payload={commandId,expectedVersion:0,name:'生产接口事务回测',heartbeat:{enabled:false}};
    const responses=await Promise.all([request(`/api/workshops/${work}`,payload,'PATCH'),request(`/api/workshops/${work}`,payload,'PATCH')]);
    assert.deepEqual(responses.map(r=>r.status),[200,200]);
    const [first,second]=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(first,second);
    assert.equal(first.workshop.name,'生产接口事务回测');
    assert.equal((await request(`/api/workshops/${work}`,{...payload,name:'conflict'},'PATCH')).status,409);
    assert.equal((await request(`/api/workshops/${work}`,{...payload,commandId:randomUUID()},'PATCH')).status,409);
    assert.equal((await request(`/api/workshops/${work}`,{...payload,commandId:randomUUID(),expectedVersion:'invalid'},'PATCH')).status,400);
    assert.equal((await request(`/api/workshops/${otherWork}`,{...payload,commandId:randomUUID()},'PATCH')).status,404);
    const receipt=await fetch(`${origin}/api/workshops/${work}/commands/${commandId}`,{signal:AbortSignal.timeout(10000)});
    assert.equal(receipt.status,200);assert.equal((await receipt.json()).command.status,'succeeded');
    assert.equal((await fetch(`${origin}/api/workshops/${otherWork}/commands/${commandId}`)).status,404);
    const loopId=randomUUID();
    await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,status) VALUES (${loopId},${owner},${work},'pause fixture','test','active')`;
    const pause={commandId:randomUUID(),expectedVersion:1,action:'pause'};
    const paused=await request(`/api/workshops/${work}/loops/${loopId}`,pause,'PATCH');assert.equal(paused.status,200);
    const replay=await request(`/api/workshops/${work}/loops/${loopId}`,pause,'PATCH');assert.equal(replay.status,200);
    assert.deepEqual(await paused.json(),await replay.json());
    const [snapshot]=await client`SELECT id FROM workshop_work_versions WHERE workshop_id=${work}`;
    const restore={commandId:randomUUID(),expectedVersion:2,action:'restore',versionId:snapshot.id};
    const restored=await request(`/api/workshops/${work}/work/versions`,restore);assert.equal(restored.status,200);
    const restoredAgain=await request(`/api/workshops/${work}/work/versions`,restore);assert.equal(restoredAgain.status,200);
    assert.deepEqual(await restored.json(),await restoredAgain.json());
    assert.equal((await request(`/api/workshops/${work}/work/versions`,{...restore,commandId:randomUUID()})).status,409);
    const counts=await client`SELECT count(*)::int AS n FROM work_commands WHERE owner_id=${owner} AND status='succeeded'`;
    assert.equal(counts[0].n,3);
    return {name:'production concurrent PATCH, idempotent pause/restore, durable receipt, 400/404/409 boundaries',passed:true,port:3522};
  } finally {
    if(child.exitCode===null) child.kill();await exited;fs.closeSync(log);
  }
}
