import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import fs from 'node:fs';

export async function checkOutboxResolutionBrowser({client,owner,origin,root,state,recordPrefix='07E2'}){
  const artifact=name=>`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-resolution-${name}`;
  const work=randomUUID(),outbox=randomUUID();
  const policy={externalMessages:'auto',allowedRecipients:['recipient'],requireSourcesForOutbox:false,minConfidenceToSend:0,minConfidenceToDraft:0};
  await client`INSERT INTO workshops(id,user_id,name,mission,autonomy_level,boundary_policy) VALUES (${work},${owner},'人工核实浏览器回测','仅验证假服务与重新审批','auto',${JSON.stringify(policy)}::jsonb)`;
  await client`INSERT INTO workshop_outbox(id,workshop_id,status,recipient_name,message,confidence,risk_level) VALUES (${outbox},${work},'draft','recipient','人工核实回测消息',100,'low')`;
  assert.equal((await fetch(origin+'/api/page-state/workshop?refresh=1')).status,200);
  const before={sends:state.sends,effects:state.effects,resolutions:state.resolutions,resolutionCalls:state.resolutionCalls};
  const browser=await chromium.launch({headless:true});let page;
  try{
    page=await browser.newPage({viewport:{width:1440,height:1200}});
    await page.route(/\/api\/(quant|wechat|douyin)\//,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated test"}'}));
    await page.route(/\/events\/stream\?/,route=>route.abort('failed'));
    async function openWork(){
      await page.getByRole('button',{name:/人工核实浏览器回测/}).first().click({timeout:30000});
      await page.getByRole('button',{name:'工作详情',exact:true}).click();
      await page.getByRole('navigation',{name:'工作详情分类'}).getByRole('button',{name:'待我处理'}).click();
      await page.getByRole('tab',{name:/待发/}).click();
    }
    await page.goto(origin+'/workshop');await openWork();
    await page.getByRole('button',{name:'生成预览',exact:true}).click();
    state.unknownNextSend=true;
    await page.getByRole('button',{name:'确认发送',exact:true}).click();
    await expect(page.getByRole('combobox',{name:/核实决定/})).toBeVisible({timeout:30000});
    await page.getByRole('combobox',{name:/核实决定/}).selectOption('not_sent');
    await page.getByRole('textbox',{name:/核实依据/}).fill('已核对完整会话和收件人，确认本条消息未发送。');
    state.dropNextResolutionResponse=true;
    await page.getByRole('button',{name:'提交核实决定',exact:true}).click();
    await expect(page.getByRole('button',{name:'继续上次核实',exact:true})).toBeVisible({timeout:30000});
    const oldReview=randomUUID();
    if(recordPrefix==='07F'){
      await client`INSERT INTO workshop_review_items(id,workshop_id,kind,title,metadata) VALUES (${oldReview},${work},'service_error','Historical unresolved send review',${JSON.stringify({outboxId:outbox})}::jsonb)`;
      const pending=(await client`SELECT * FROM workshop_outbox_resolutions WHERE workshop_id=${work} AND status='pending'`)[0];
      await client`INSERT INTO workshop_outbox_resolutions(id,owner_id,workshop_id,attempt_id,command_id,payload_hash,request_json,status,created_at,completed_at,result_json) VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff',${owner},${work},${pending.attempt_id},${randomUUID()},${'0'.repeat(64)},'{"decision":"unknown","evidence":"Historical retained unknown"}'::jsonb,'completed',${pending.created_at},${pending.created_at},'{"status":"unknown"}'::jsonb)`;
      const response=await fetch(origin+`/api/workshops/${work}/outbox/${outbox}/resolve`);
      assert.equal(response.status,200);assert.equal((await response.json()).resolution.command_id,pending.command_id);
    }
    await page.reload();await openWork();
    await expect(page.getByRole('button',{name:'继续上次核实',exact:true})).toBeVisible({timeout:30000});
    await expect(page.getByRole('textbox',{name:/核实依据/})).toBeDisabled();
    if(recordPrefix==='07F')await expect(page.getByText('Historical unresolved send review',{exact:true})).toBeVisible();
    await page.screenshot({path:artifact('pending.png'),fullPage:true});
    let lostFinalResponse=false;
    if(recordPrefix==='07F')await page.route(`**/api/workshops/${work}/outbox/${outbox}/resolve`,async route=>{
      if(route.request().method()==='POST'&&!lostFinalResponse){
        const response=await route.fetch();assert.equal(response.status(),200);
        lostFinalResponse=true;await route.abort('failed');
      }else await route.continue();
    });
    await page.getByRole('button',{name:'继续上次核实',exact:true}).click();
    await expect(page.getByText('已核实未发送',{exact:true})).toBeVisible({timeout:30000});
    await expect(page.getByRole('button',{name:'生成预览',exact:true})).toBeVisible({timeout:30000});
    if(recordPrefix==='07F')assert.equal(lostFinalResponse,true);
    if(recordPrefix==='07F'){
      assert.equal((await client`SELECT status FROM workshop_review_items WHERE id=${oldReview}`)[0].status,'superseded');
      await expect(page.getByText('Historical unresolved send review',{exact:true})).toHaveCount(0);
    }
    assert.equal(state.sends,before.sends+1);assert.equal(state.effects,before.effects);
    assert.equal(state.resolutions,before.resolutions+1);assert.equal(state.resolutionCalls,before.resolutionCalls+2);
    const replacement=await client`SELECT * FROM workshop_outbox WHERE boundary_result->>'resolvedFromOutboxId'=${outbox}`;
    assert.equal(replacement.length,1);assert.equal(replacement[0].status,'draft');assert.equal(replacement[0].boundary_result.requiresOwnerReapproval,true);
    const hash=(await client`SELECT content_hash FROM workshop_outbox_attempts WHERE outbox_id=${outbox}`)[0].content_hash;
    for(const id of [outbox,replacement[0].id]){
      const denied=await fetch(origin+`/api/workshops/${work}/outbox/${id}/send`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({expectedContentHash:hash})});
      assert.equal(denied.status,400);
    }
    await page.screenshot({path:artifact('new-draft.png'),fullPage:true});
    await page.getByRole('button',{name:'生成预览',exact:true}).click();
    await page.getByRole('button',{name:'确认发送',exact:true}).click();
    await expect(page.getByRole('button',{name:'查询发送结果',exact:true})).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'查询发送结果',exact:true}).click();
    await expect(page.getByRole('button',{name:'查询发送结果',exact:true})).toHaveCount(0,{timeout:30000});
    assert.equal(state.sends,before.sends+2);assert.equal(state.effects,before.effects+1);
    assert.notEqual(state.sendCommandIds.at(-1),state.sendCommandIds.at(-2));
    assert.equal((await client`SELECT status FROM workshop_outbox WHERE id=${replacement[0].id}`)[0].status,'sent');
    return {passed:true,pendingSurvivesReload:true,resolutionCalls:2,durableResolutions:1,replacementDrafts:1,freshApprovalRequired:true,newSendUsesNewCommand:true,lostFinalResponseRecovered:lostFinalResponse};
  }catch(error){
    if(page){await page.screenshot({path:artifact('failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(artifact('failure.txt'),await page.locator('body').innerText().catch(()=>String(error)),'utf8');}
    throw error;
  }finally{await browser.close();}
}
