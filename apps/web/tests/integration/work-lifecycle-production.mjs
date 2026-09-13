import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

export async function checkWorkLifecycleProduction({env,databaseUrl,client,web,root}) {
  const owner=randomUUID(),other=randomUUID(),privateWork=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'lifecycle-http@example.invalid'),(${other},'lifecycle-http-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${privateWork},${other},'private','fixture')`;
  const origin='http://127.0.0.1:3523';
  const log=fs.openSync(path.join(root,'docs/plans/2026-09-06-review-remediation/records/06B3-production-server.log'),'w');
  const child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-p','3523','-H','127.0.0.1'],{
    cwd:web,windowsHide:true,stdio:['ignore',log,log],env:{...env,AUTH_MODE:'local_owner',NODE_ENV:'production',ZHIYU_REVIEW_BUILD:'17',DEV_USER_ID:owner,
      POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',TAURI_MODE:'false',IS_TAURI:'false'},
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const request=(url,method,body)=>fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  try {
    let ready=false;
    for(let i=0;i<60;i++) {
      if(child.exitCode!==null)throw Error('Lifecycle candidate exited');
      try{if((await request('/api/identity','GET')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert(ready);
    const creation={commandId:randomUUID(),name:'生产创建回测',mission:'isolated lifecycle HTTP'};
    const responses=await Promise.all([request('/api/workshops','POST',creation),request('/api/workshops','POST',creation)]);
    assert.deepEqual(responses.map(r=>r.status),[201,201]);
    const [a,b]=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(a,b);assert.equal(a.workshop.name,'生产创建回测');
    const work=a.workshop.id;
    assert.equal((await request('/api/workshops','POST',{...creation,name:'different'})).status,409);
    assert.equal((await request('/api/workshops','POST',{...creation,commandId:randomUUID(),expectedVersion:1})).status,400);
    const deletion={commandId:randomUUID(),expectedVersion:1};
    assert.equal((await request(`/api/workshops/${privateWork}`,'DELETE',deletion)).status,404);
    assert.equal((await request(`/api/workshops/${work}`,'DELETE',{...deletion,expectedVersion:0})).status,409);
    const run=randomUUID();await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${run},${work},'running')`;
    assert.equal((await request(`/api/workshops/${work}`,'DELETE',deletion)).status,409);
    await client`UPDATE workshop_runs SET status='completed' WHERE id=${run}`;
    const removed=await Promise.all([request(`/api/workshops/${work}`,'DELETE',deletion),request(`/api/workshops/${work}`,'DELETE',deletion)]);
    assert.deepEqual(removed.map(r=>r.status),[200,200]);
    const [first,last]=await Promise.all(removed.map(r=>r.json()));assert.deepEqual(first,last);
    await client`UPDATE work_command_events SET seq=CASE WHEN phase='accepted' THEN 9999999 ELSE 10000000 END
      WHERE owner_id=${owner} AND command_id=${deletion.commandId}`;
    const receipt=await request(`/api/workshops/${work}/commands/${deletion.commandId}`,'GET');assert.equal(receipt.status,200);
    const audit=await receipt.json();assert.equal(audit.command.status,'succeeded');assert.deepEqual(audit.events.map(e=>e.phase),['accepted','succeeded']);
    assert.equal(audit.events[1].metadata.targetDeleted,true);
    assert.equal((await request(`/api/workshops/${privateWork}/commands/${deletion.commandId}`,'GET')).status,404);
    assert.equal((await request('/api/workshops','POST',creation)).status,201);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM work_commands WHERE owner_id=${owner}`)[0].n,2);
    return {name:'production duplicate create/delete, surviving receipt/audit, busy/owner/version boundaries, no resurrection',passed:true,port:3523};
  } finally {if(child.exitCode===null)child.kill();await exited;fs.closeSync(log);}
}
