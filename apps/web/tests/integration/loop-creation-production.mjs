import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

export async function checkLoopCreationProduction({env,databaseUrl,client,web,root}) {
  const owner=randomUUID(),work=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'creation-http@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'creation','isolated')`;
  const origin='http://127.0.0.1:3525';
  const log=fs.openSync(path.join(root,'docs/plans/2026-09-06-review-remediation/records/06B5-production-server.log'),'w');
  const child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-p','3525','-H','127.0.0.1'],{
    cwd:web,windowsHide:true,stdio:['ignore',log,log],env:{...env,NODE_ENV:'production',AUTH_MODE:'local_owner',DEV_USER_ID:owner,ZHIYU_REVIEW_BUILD:'19',
      POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',TAURI_MODE:'false',IS_TAURI:'false'},
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const request=(url,body,method='POST')=>fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  try {
    let ready=false;
    for(let i=0;i<60;i++) {
      if(child.exitCode!==null)throw Error('Creation candidate exited');
      try{if((await request('/api/identity',undefined,'GET')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert(ready);
    const command={type:'template',templateId:'work-self-audit',commandId:randomUUID(),expectedVersion:0};
    const responses=await Promise.all([request(`/api/workshops/${work}/loops`,command),request(`/api/workshops/${work}/loops`,command)]);
    assert.deepEqual(responses.map(r=>r.status),[201,201]);const [a,b]=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(a,b);
    assert.equal((await request(`/api/workshops/${work}/loops`,{...command,input:{timezone:'UTC'}})).status,409);
    await client`UPDATE loops SET updated_at='2020-01-01' WHERE id=${a.loop.id}`;
    await client`INSERT INTO loops(user_id,workshop_id,name,goal) SELECT ${owner}::uuid,${work}::uuid,'other','unrelated' FROM generate_series(1,301)`;
    const ensured=await request(`/api/workshops/${work}/commands`,{command:'ensureWorkSelfAuditLoop',commandId:randomUUID(),expectedVersion:1});
    assert.equal(ensured.status,200);const ensureBody=await ensured.json();assert.equal(ensureBody.created,false);assert.equal(ensureBody.loop.id,a.loop.id);
    const natural={type:'natural_language',commandId:randomUUID(),expectedVersion:2,intent:'每个交易日早上9点检查自选股风险并生成报告',create:true};
    const nlResponses=await Promise.all([request(`/api/workshops/${work}/loops`,natural),request(`/api/workshops/${work}/loops`,natural)]);
    assert.deepEqual(nlResponses.map(r=>r.status),[201,201]);const [c,d]=await Promise.all(nlResponses.map(r=>r.json()));assert.deepEqual(c,d);
    assert.equal(c.draft.planner.parser,'local_rules');
    assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${work}`)[0].n,303);
    const receipt=await request(`/api/workshops/${work}/commands/${natural.commandId}`,undefined,'GET');assert.equal(receipt.status,200);
    const body=await receipt.json();assert.equal(body.command.status,'succeeded');assert(body.command.preparedAt);assert(body.command.preparedPayload);
    assert.equal((await request(`/api/workshops/${work}/loops`,{...natural,commandId:randomUUID()})).status,409);
    return {name:'production concurrent template/NLP create replay, self-audit backlog, payload/version conflict and prepared receipt',passed:true,port:3525};
  } finally{if(child.exitCode===null)child.kill();await exited;fs.closeSync(log);}
}
