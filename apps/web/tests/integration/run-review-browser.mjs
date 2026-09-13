import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import fs from 'node:fs';

export async function checkRunReviewBrowser({client,owner,origin,root}){
  const artifact=name=>`${root}/docs/plans/2026-09-06-review-remediation/records/06D9-review-${name}`;
  const work=randomUUID(),loop=randomUUID(),run=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'运行核对浏览器回测','只核对隔离状态，不执行外部动作')`;
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal) VALUES (${loop},${owner},${work},'隔离核对任务','观察')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,error) VALUES (${run},${work},'needs_review','fixture_provider_reply_unknown')`;
  await client`INSERT INTO loop_runs(id,loop_id,status,error) VALUES (${run},${loop},'needs_review','fixture_provider_reply_unknown')`;
  await client`INSERT INTO workshop_loop_executions(run_id,loop_run_id,loop_id,workshop_id,request_json) VALUES (${run},${run},${loop},${work},'{}'::jsonb)`;
  await client`INSERT INTO loop_states(loop_id,current_phase,blocked_reason,state_json) VALUES (${loop},'blocked','fixture_provider_reply_unknown',${JSON.stringify({lastLoopRunId:run})}::jsonb)`;
  await client`INSERT INTO workshop_execution_leases(workshop_id,run_id,worker_id,token,phase,effect_started,lease_until) VALUES (${work},${run},'stopped-fixture',7,'needs_review',true,clock_timestamp()-interval '1 minute')`;
  assert.equal((await fetch(origin+'/api/page-state/workshop?refresh=1')).status,200);
  const browser=await chromium.launch({headless:true});let page;const submitted=[];
  try{
    page=await browser.newPage({viewport:{width:1440,height:1100}});
    await page.route(/\/api\/(quant|wechat|douyin)\//,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated test"}'}));
    await page.route(/\/events\/stream\?/,route=>route.abort('failed'));
    await page.goto(origin+'/workshop');
    await page.getByRole('button',{name:/运行核对浏览器回测/}).first().click({timeout:30000});
    const panel=page.getByRole('region',{name:'运行结果核对'});
    await panel.getByRole('button',{name:'核对本轮',exact:true}).click({timeout:30000});
    await panel.getByRole('textbox',{name:'核对依据',exact:true}).fill('已检查隔离执行器，目前仍缺少完整外部结果依据。');
    await panel.getByRole('button',{name:'记录依据，继续待核对',exact:true}).click();
    await expect(panel.getByText('核对依据已记录，本轮继续保留待核对。',{exact:true})).toBeVisible({timeout:30000});
    assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${run}`)[0].status,'needs_review');
    await panel.getByRole('combobox',{name:'核对结论',exact:true}).selectOption('no_effect');
    await panel.getByRole('textbox',{name:'核对依据',exact:true}).fill('已检查隔离执行器停止，外部消息及订单均未执行。');
    const close=panel.getByRole('button',{name:'关闭本轮并暂停车间',exact:true});await expect(close).toBeDisabled();
    await panel.getByRole('checkbox').check();await expect(close).toBeEnabled();
    const baseline=await (await fetch(origin+`/api/workshops/${work}/runs/${run}/review`)).json();
    const changed=await fetch(origin+`/api/workshops/${work}`,{method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({mission:'另一个页面更新的隔离配置',commandId:randomUUID(),expectedVersion:baseline.expectedVersion})});assert.equal(changed.status,200);
    await close.click();
    await expect(panel.getByRole('alert')).toContainText('配置已变化',{timeout:30000});
    await expect(panel.getByRole('textbox',{name:'核对依据',exact:true})).toHaveValue('已检查隔离执行器停止，外部消息及订单均未执行。');
    assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${run}`)[0].status,'needs_review');
    await panel.getByRole('button',{name:'重新读取核对状态',exact:true}).click();
    await expect(panel.getByRole('checkbox')).not.toBeChecked();await expect(close).toBeDisabled();
    await panel.getByRole('checkbox').check();await expect(close).toBeEnabled();
    await page.screenshot({path:artifact('decision.png'),fullPage:true});
    let dropped=false;
    await page.route(`**/api/workshops/${work}/runs/${run}/review`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      submitted.push(route.request().postDataJSON());
      if(!dropped){const response=await route.fetch();assert.equal(response.status(),200);dropped=true;await route.abort('failed');}
      else await route.continue();
    });
    await close.click();
    await expect(page.getByRole('button',{name:'核对上次提交',exact:true}).first()).toBeVisible({timeout:30000});
    await expect(panel.getByRole('textbox',{name:'核对依据',exact:true})).toBeDisabled();
    await page.screenshot({path:artifact('response-lost.png'),fullPage:true});
    await page.reload();
    await page.getByRole('button',{name:'核对上次提交',exact:true}).first().click({timeout:30000});
    await expect(page.getByText('上次提交已核对，未提交的新编辑保持不变。',{exact:true}).first()).toBeVisible({timeout:30000});
    assert.equal(submitted.length,2);assert.deepEqual(submitted[1],submitted[0]);assert.equal(submitted[0].expectedLeaseToken,7);
    const [state]=await client`SELECT r.status,w.status AS work_status,l.token,l.phase,x.active FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id JOIN workshop_execution_leases l ON l.workshop_id=w.id JOIN workshop_loop_executions x ON x.run_id=r.id WHERE r.id=${run}`;
    assert.deepEqual(state,{status:'cancelled',work_status:'paused',token:8,phase:'idle',active:false});
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${run} AND type='run_review_closed'`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${work}`)[0].n,1);
    await page.getByRole('button',{name:/运行核对浏览器回测/}).first().click();
    await expect(page.getByRole('button',{name:'核对本轮',exact:true})).toHaveCount(0,{timeout:30000});
    await page.screenshot({path:artifact('recovered.png'),fullPage:true});
    return {passed:true,unknownRetained:true,explicitShutdownConfirmation:true,staleBaselinePreservesDraft:true,responseLossReloadRecovery:true,exactCommandReplay:true,closedOnce:true,workPaused:true,noNewRun:true};
  }catch(error){if(page){await page.screenshot({path:artifact('failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(artifact('failure.txt'),await page.locator('body').innerText().catch(()=>String(error)),'utf8');}throw error;}
  finally{await browser.close();}
}
