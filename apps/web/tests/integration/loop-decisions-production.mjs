import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

export async function checkLoopDecisionsProduction({env,databaseUrl,client,web,root}) {
  const owner=randomUUID(),work=randomUUID(),loop=randomUUID(),otherLoop=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'decisions-http@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'decisions','isolated')`;
  for(const id of [loop,otherLoop]) {
    await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,status,trigger_config) VALUES (${id},${owner},${work},'proposal','test','paused',${JSON.stringify({type:'cron',expression:'0 9 * * 1-5',timezone:'Asia/Shanghai'})}::jsonb)`;
    await client`INSERT INTO loop_states(loop_id,current_phase,state_json) VALUES (${id},'approval',${JSON.stringify({requiresOwnerActivation:true,ownerActivationStatus:'pending'})}::jsonb)`;
  }
  const origin='http://127.0.0.1:3524';
  const log=fs.openSync(path.join(root,'docs/plans/2026-09-06-review-remediation/records/06B4-production-server.log'),'w');
  const child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-p','3524','-H','127.0.0.1'],{
    cwd:web,windowsHide:true,stdio:['ignore',log,log],env:{...env,NODE_ENV:'production',AUTH_MODE:'local_owner',DEV_USER_ID:owner,ZHIYU_REVIEW_BUILD:'18',
      POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',TAURI_MODE:'false',IS_TAURI:'false'},
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const request=(url,body,method='POST')=>fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  try {
    let ready=false;
    for(let i=0;i<60;i++) {
      if(child.exitCode!==null)throw Error('Decision candidate exited');
      try{if((await request('/api/identity',undefined,'GET')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert(ready);
    const activate={command:'activateWorkLoopProposal',commandId:randomUUID(),expectedVersion:0,loopId:loop,source:'system'};
    const responses=await Promise.all([request(`/api/workshops/${work}/commands`,activate),request(`/api/workshops/${work}/commands`,activate)]);
    assert.deepEqual(responses.map(r=>r.status),[200,200]);const [a,b]=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(a,b);
    assert.equal((await client`SELECT state_json FROM loop_states WHERE loop_id=${loop}`)[0].state_json.ownerActivatedBy,'owner');
    const reject={commandId:randomUUID(),expectedVersion:1,action:'reject',reason:'范围过大'};
    const rejected=await request(`/api/workshops/${work}/loops/${otherLoop}/activation`,reject);assert.equal(rejected.status,200);
    const replay=await request(`/api/workshops/${work}/loops/${otherLoop}/activation`,reject);assert.equal(replay.status,200);assert.deepEqual(await rejected.json(),await replay.json());
    await client`UPDATE loop_states SET current_phase='blocked',blocked_reason='fixture' WHERE loop_id=${loop}`;
    await client`INSERT INTO workshop_review_items(workshop_id,kind,title,metadata) SELECT ${work}::uuid,'service_error','unrelated','{}'::jsonb FROM generate_series(1,301)`;
    for(let n=0;n<2;n++)await client`INSERT INTO workshop_review_items(workshop_id,kind,title,created_at,metadata) VALUES (${work},'loop_blocker','old','2020-01-01',${JSON.stringify({loopId:loop})}::jsonb)`;
    const clear={commandId:randomUUID(),expectedVersion:2,action:'clear_blocker',reason:'已核对'};
    const cleared=await request(`/api/workshops/${work}/loops/${loop}`,clear,'PATCH');assert.equal(cleared.status,200);
    const again=await request(`/api/workshops/${work}/loops/${loop}`,clear,'PATCH');assert.equal(again.status,200);assert.deepEqual(await cleared.json(),await again.json());
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE workshop_id=${work} AND kind='loop_blocker' AND status='pending'`)[0].n,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE workshop_id=${work} AND status='pending'`)[0].n,301);
    assert.equal((await request(`/api/workshops/${work}/loops/${loop}`,{...clear,commandId:randomUUID()},'PATCH')).status,409);
    const receipt=await request(`/api/workshops/${work}/commands/${clear.commandId}`,undefined,'GET');assert.equal(receipt.status,200);
    assert.equal((await receipt.json()).command.status,'succeeded');
    return {name:'production activate/reject/clear replay, 301-item backlog, stale version, trusted HTTP actor and durable receipt',passed:true,port:3524};
  } finally{if(child.exitCode===null)child.kill();await exited;fs.closeSync(log);}
}
