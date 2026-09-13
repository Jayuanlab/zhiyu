import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createWorkCommandClient} from '../../lib/work-runtime/client-command.ts';

export async function checkClientActionsProduction({client,owner,request,origin,root}) {
  const work=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'动作恢复回测','仅验证排队，不执行模型或外部动作')`;
  const memory=new Map(),storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
  let drop=false,lastResult,attempts=[];
  const transport=async(url,init={})=>{
    const response=await fetch(origin+url,{...init,headers:{...init.headers,Origin:origin}});
    if(init.method && init.method!=='GET'){
      attempts.push({url,method:init.method,body:JSON.parse(init.body)});
      if(drop){drop=false;assert(response.ok,await response.clone().text());lastResult=await response.clone().json();throw Error('response lost after commit');}
    }
    return response;
  };
  const makeClient=()=>createWorkCommandClient({storage,fetch:transport,uuid:randomUUID});
  let api=makeClient(),replays=0;
  const baseline=async(id=work)=>(await (await request(`/api/workshops/${id}`,undefined,'GET')).json()).commandVersion;
  async function replay(path,body,method='POST',id=work){
    attempts=[];drop=true;
    const input={url:`/api/workshops/${id}${path}`,method,body,expectedVersion:await baseline(id)};
    await assert.rejects(api.submit(input),error=>error.code==='result_unknown');
    const pending=await api.pending();assert(pending);
    api=makeClient();const result=await api.recover();
    assert.deepEqual(result,lastResult);assert.deepEqual(attempts[0],attempts[1]);assert.equal(memory.size,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM work_commands WHERE owner_id=${owner} AND command_id=${pending.commandId} AND status='succeeded'`)[0].n,1);
    replays++;return result;
  }
  const loop=(await replay('/loops',{type:'template',templateId:'daily-brief',input:{timezone:'Asia/Shanghai'}})).loop;
  assert.equal(loop.workshopId,work);
  assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${work}`)[0].n,1);
  assert.equal((await replay(`/loops/${loop.id}`,{action:'pause'},'PATCH')).loop.status,'paused');
  assert.equal((await replay(`/loops/${loop.id}`,{action:'resume'},'PATCH')).loop.status,'active');
  await client`UPDATE loop_states SET current_phase='blocked',blocked_reason='fixture' WHERE loop_id=${loop.id}`;
  await replay(`/loops/${loop.id}`,{action:'clear_blocker'},'PATCH');
  assert.equal((await client`SELECT blocked_reason FROM loop_states WHERE loop_id=${loop.id}`)[0].blocked_reason,null);
  for(const action of ['activate','reject']){
    const proposed=randomUUID();
    await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,status,trigger_config) VALUES (${proposed},${owner},${work},'待审核任务','test','paused','{"type":"cron","expression":"0 9 * * 1-5","timezone":"Asia/Shanghai"}'::jsonb)`;
    await client`INSERT INTO loop_states(loop_id,current_phase,state_json) VALUES (${proposed},'approval','{"requiresOwnerActivation":true,"ownerActivationStatus":"pending"}'::jsonb)`;
    await replay(`/loops/${proposed}/activation`,{action});
    assert.equal((await client`SELECT state_json FROM loop_states WHERE loop_id=${proposed}`)[0].state_json.ownerActivationStatus,action==='activate'?'activated':'rejected');
    const oldVersion=await baseline(),rejectedId=randomUUID();
    const rejectedClient=createWorkCommandClient({storage,fetch:transport,uuid:()=>rejectedId});
    await assert.rejects(rejectedClient.submit({url:`/api/workshops/${work}/loops/${proposed}/activation`,method:'POST',body:{action},expectedVersion:oldVersion}),error=>error.code==='proposal_already_resolved');
    assert.equal(memory.size,0);assert.equal(await baseline(),oldVersion);
    assert.equal((await client`SELECT status FROM work_commands WHERE owner_id=${owner} AND command_id=${rejectedId}`)[0].status,'failed');
    const again=await request(`/api/workshops/${work}/loops/${proposed}/activation`,{action,commandId:rejectedId,expectedVersion:oldVersion});assert.equal(again.status,409);assert.equal((await again.json()).error,'proposal_already_resolved');
  }
  await replay(`/loops/${loop.id}`,{},'DELETE');
  assert.equal((await client`SELECT status FROM loops WHERE id=${loop.id}`)[0].status,'archived');
  const natural=await replay('/loops',{type:'natural_language',intent:'每个交易日早上9点检查自选股风险并生成报告',create:true,externalWriteMode:'manual_approval'});
  assert.equal(natural.draft.planner.parser,'local_rules');
  const version=(await client`SELECT id FROM workshop_work_versions WHERE workshop_id=${work} ORDER BY created_at LIMIT 1`)[0]?.id;
  // Template creation is not a configuration version; create an ordinary config change when needed.
  if(!version)assert.equal((await request(`/api/workshops/${work}`,{mission:'保留历史配置',commandId:randomUUID(),expectedVersion:await baseline()},'PATCH')).status,200);
  const historical=version??(await client`SELECT id FROM workshop_work_versions WHERE workshop_id=${work} ORDER BY created_at LIMIT 1`)[0].id;
  await replay('/work/versions',{action:'restore',versionId:historical});
  for(const action of ['reject','recreate','apply']){
    const event=randomUUID(),workshop=(await (await request(`/api/workshops/${work}`,undefined,'GET')).json()).workshop;
    await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title,metadata) VALUES (${event},${work},(SELECT coalesce(max(seq),0)+1 FROM workshop_events WHERE workshop_id=${work}),'workshop_agent_change_proposed','proposal',${JSON.stringify({patch:{mission:`核对提案 ${action}`},workModelVersion:workshop.modelConfig.workVersion})}::jsonb)`;
    await client`UPDATE workshop_event_counters SET last_seq=(SELECT max(seq) FROM workshop_events WHERE workshop_id=${work}) WHERE workshop_id=${work}`;
    await replay(`/agent-change-proposals/${event}`,{action});
  }
  const run=(await replay('/runs',{triggerReason:{type:'manual'}})).run;
  assert.equal(run.status,'queued');assert.equal(run.startedAt,null);
  const directive=await replay('/directives',{content:'请核对资料来源后生成摘要',scope:'current_run'});
  assert.equal(directive.directive.content,'请核对资料来源后生成摘要');assert.equal(directive.run.status,'queued');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${work}`)[0].n,2);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_directives WHERE workshop_id=${work}`)[0].n,1);
  const deniedRequests=[['/runs','POST',{}],['/directives','POST',{content:'denied'}],['/loops','POST',{type:'template',templateId:'daily-brief'}],[`/loops/${loop.id}`,'PATCH',{action:'pause'}],[`/loops/${loop.id}`,'DELETE',{}],[`/loops/${loop.id}/activation`,'POST',{action:'activate'}],[`/agent-change-proposals/${randomUUID()}`,'POST',{action:'apply'}],['/work/versions','POST',{action:'restore',versionId:historical}]];
  for(const [path,method,body] of deniedRequests){
    const denied=await fetch(origin+`/api/workshops/${work}${path}`,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Work-Actor':randomUUID()},body:JSON.stringify({...body,commandId:randomUUID(),expectedVersion:await baseline()})});
    assert.equal(denied.status,409);assert.equal((await denied.json()).error,'actor_changed');
  }
  await assert.rejects(api.submit({url:`/api/workshops/${work}/loops/${randomUUID()}`,method:'DELETE',body:{},expectedVersion:await baseline()}),error=>error.code==='not_found');assert.equal(memory.size,0);
  await assert.rejects(api.submit({url:`/api/workshops/${work}/loops/${loop.id}`,method:'PATCH',body:{action:'pause'},expectedVersion:0}),error=>error.code==='version_conflict');assert.equal(memory.size,0);
  const removed=randomUUID();await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${removed},${owner},'delete fixture','test')`;
  await replay('',{},'DELETE',removed);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE id=${removed}`)[0].n,0);
  await checkActionsBrowser({client,request,origin,root});
  return {name:'production client action replay and browser run/directive recovery',passed:true,replays,actorGuards:deniedRequests.length,browser:true};
}

async function checkActionsBrowser({client,request,origin,root}) {
  const response=await request('/api/workshops',{name:'运行与方向恢复浏览器车间',mission:'隔离回测，不消费排队任务',commandId:randomUUID()});assert.equal(response.status,201);
  const work=(await response.json()).workshop.id;
  await request('/api/page-state/workshop?refresh=1',undefined,'GET');
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    await page.route(/\/api\/(quant|wechat|douyin)\//,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated test"}'}));
    await page.goto(origin+'/workshop');await expect(page.getByText('运行与方向恢复浏览器车间',{exact:true}).first()).toBeVisible({timeout:30000});
    let dropRun=true;const runAttempts=[];
    await page.route(origin+`/api/workshops/${work}/runs`,async route=>{
      if(route.request().method()==='POST'){
        runAttempts.push(route.request().postDataJSON());
        if(dropRun){dropRun=false;assert.equal((await route.fetch()).status(),202);await route.abort('failed');return;}
      }
      await route.continue();
    });
    await page.getByRole('button',{name:'运行一次',exact:true}).first().click();
    await expect(page.getByText('提交结果尚未确认，原请求已保留，请使用“核对上次提交”。',{exact:true})).toBeVisible({timeout:30000});
    await page.reload();await expect(page.getByRole('button',{name:'核对上次提交',exact:true})).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'核对上次提交',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'上次提交已核对'})).toBeVisible({timeout:30000});
    await expect(page.getByRole('button',{name:'运行一次',exact:true}).first()).toBeEnabled();
    assert.equal(runAttempts.length,2);assert.deepEqual(runAttempts[0],runAttempts[1]);
    const runs=await client`SELECT status,started_at FROM workshop_runs WHERE workshop_id=${work}`;assert.equal(runs.length,1);assert.equal(runs[0].status,'queued');assert.equal(runs[0].started_at,null);
    const input=page.getByLabel('追加车间方向');
    await input.fill('原始方向');let release,arrived;const held=new Promise(resolve=>release=resolve),sent=new Promise(resolve=>arrived=resolve);let dropDirective=true;const directiveAttempts=[];
    await page.route(origin+`/api/workshops/${work}/directives`,async route=>{
      if(route.request().method()==='POST'){
        directiveAttempts.push(route.request().postDataJSON());
        if(dropDirective){dropDirective=false;assert.equal((await route.fetch()).status(),201);arrived();await held;await route.abort('failed');return;}
      }
      await route.continue();
    });
    await page.getByRole('button',{name:'追加方向',exact:true}).click();
    let timeout;
    try {await Promise.race([sent,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('directive was not committed within 25s')),25000);})]);await input.fill('提交期间补充的新方向');}finally{clearTimeout(timeout);release();}
    await expect(page.getByText('提交结果尚未确认，原请求已保留，请使用“核对上次提交”。',{exact:true})).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'核对上次提交',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'上次提交已核对'})).toBeVisible({timeout:30000});
    await expect(page.getByRole('button',{name:'追加方向',exact:true})).toBeEnabled();
    await expect(page.getByRole('button',{name:'核对上次提交',exact:true})).not.toBeVisible();
    await expect(input).toHaveValue('提交期间补充的新方向');assert.equal(directiveAttempts.length,2);assert.deepEqual(directiveAttempts[0],directiveAttempts[1]);
    assert.deepEqual((await client`SELECT content FROM workshop_directives WHERE workshop_id=${work}`).map(row=>row.content),['原始方向']);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${work}`)[0].n,2);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='run_started'`)[0].n,0);
    await page.screenshot({path:root+'/docs/plans/2026-09-06-review-remediation/records/06B15-action-recovery.png',fullPage:true});
  } finally {await browser.close();}
}
