import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

export async function checkRunAcceptanceProduction({env,databaseUrl,client,web,root}) {
  const owner=randomUUID(),work=randomUUID(),other=randomUUID(),foreignRun=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'run-http@example.invalid')`;
  for(const id of [work,other])await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${id},${owner},'queue','isolated')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${foreignRun},${other},'completed')`;
  const origin='http://127.0.0.1:3526';
  const log=fs.openSync(path.join(root,'docs/plans/2026-09-06-review-remediation/records/06B6-production-server.log'),'w');
  const launch=()=>spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-p','3526','-H','127.0.0.1'],{
    cwd:web,windowsHide:true,stdio:['ignore',log,log],env:{...env,NODE_ENV:'production',AUTH_MODE:'local_owner',DEV_USER_ID:owner,ZHIYU_REVIEW_BUILD:'20',
      POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',TAURI_MODE:'false',IS_TAURI:'false'},
  });
  let child=launch();
  let exited=new Promise(resolve=>child.once('exit',resolve));
  const request=(url,body,method='POST')=>fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  try {
    let ready=false;
    for(let i=0;i<60;i++) {
      if(child.exitCode!==null)throw Error('Run candidate exited');
      try{if((await request('/api/identity',undefined,'GET')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert(ready);
    const command={commandId:randomUUID(),expectedVersion:0};
    const responses=await Promise.all([request(`/api/workshops/${work}/runs`,command),request(`/api/workshops/${work}/runs`,command)]);
    assert.deepEqual(responses.map(r=>r.status),[202,202]);const [a,b]=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(a,b);
    assert.equal(a.run.status,'queued');assert.equal(a.run.startedAt,null);
    const bad=await request(`/api/workshops/${work}/directives`,{commandId:randomUUID(),expectedVersion:1,content:'越界',runId:foreignRun,triggerRun:false});assert.equal(bad.status,404);
    const directive={commandId:randomUUID(),expectedVersion:1,content:'检查资料后给出摘要'};
    const pairs=await Promise.all([request(`/api/workshops/${work}/directives`,directive),request(`/api/workshops/${work}/directives`,directive)]);
    assert.deepEqual(pairs.map(r=>r.status),[201,201]);const [c,d]=await Promise.all(pairs.map(r=>r.json()));assert.deepEqual(c,d);
    assert.equal(c.run.status,'queued');assert.equal(c.run.startedAt,null);assert.equal(c.runError,null);
    assert.equal(c.run.triggerReason.directiveId,c.directive.id);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${work}`)[0].n,2);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_directives WHERE workshop_id=${work}`)[0].n,1);
    assert.equal((await request(`/api/workshops/${work}/directives`,{...directive,content:'不同内容'})).status,409);
    assert.equal((await request(`/api/workshops/${work}/runs`,{...command,commandId:randomUUID()})).status,409);
    const receipt=await request(`/api/workshops/${work}/commands/${directive.commandId}`,undefined,'GET');assert.equal(receipt.status,200);
    assert.equal((await receipt.json()).command.status,'succeeded');
    child.kill();await exited;
    child=launch();exited=new Promise(resolve=>child.once('exit',resolve));
    let restarted=false;
    for(let i=0;i<60;i++) {
      if(child.exitCode!==null)throw Error('Restarted run candidate exited');
      try{if((await request('/api/identity',undefined,'GET')).ok){restarted=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert(restarted);
    const recovered=await request(`/api/workshops/${work}/directives`,directive);assert.equal(recovered.status,201);assert.deepEqual(await recovered.json(),c);
    const history=await request(`/api/workshops/${work}/runs`,undefined,'GET');assert.equal(history.status,200);
    const returned=await history.json();assert(Array.isArray(returned.runs));assert(returned.runs.some(run=>run.id===c.run.id && run.status==='queued' && run.startedAt===null));
    assert.equal((await request(`/api/workshops/${work}/runs?limit=101`,undefined,'GET')).status,400);
    assert.equal((await request(`/api/workshops/${randomUUID()}/runs`,undefined,'GET')).status,404);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='run_started'`)[0].n,0);
    return {name:'production queued acceptance, concurrent directive/run replay, cross-Work reference, conflicts, process restart receipt and live run history',passed:true,port:3526};
  } finally{if(child.exitCode===null)child.kill();await exited;fs.closeSync(log);}
}
