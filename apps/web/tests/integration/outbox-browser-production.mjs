import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import fs from 'node:fs';

export async function checkOutboxBrowserProduction({client,owner,origin,root,state,recordPrefix='07D'}){
  const work=randomUUID(),outbox=randomUUID();
  const policy={externalMessages:'draft',allowedRecipients:['recipient'],requireSourcesForOutbox:false,minConfidenceToSend:0,minConfidenceToDraft:0};
  await client`INSERT INTO workshops(id,user_id,name,mission,autonomy_level,boundary_policy) VALUES (${work},${owner},'发信浏览器回测','只使用隔离假微信服务','draft',${JSON.stringify(policy)}::jsonb)`;
  await client`INSERT INTO workshop_outbox(id,workshop_id,status,recipient_name,message,confidence,risk_level) VALUES (${outbox},${work},'draft','recipient','浏览器故障回测消息',100,'low')`;
  const before=state.sends;
  const browser=await chromium.launch({headless:true});
  let page;
  try{
    page=await browser.newPage({viewport:{width:1440,height:1100}});
    await page.route(/\/api\/(quant|wechat|douyin)\//,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated test"}'}));
    await page.route(/\/events\/stream\?/,route=>route.abort('failed'));
    await page.goto(origin+'/workshop');
    await page.getByRole('button',{name:/发信浏览器回测/}).first().click({timeout:30000});
    await page.getByRole('button',{name:'工作详情',exact:true}).click();
    await page.getByRole('navigation',{name:'工作详情分类'}).getByRole('button',{name:'待我处理'}).click();
    await page.getByRole('tab',{name:/待发/}).click();
    await expect(page.getByText('浏览器故障回测消息',{exact:true})).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'生成预览',exact:true}).click();
    await expect(page.getByRole('button',{name:'确认发送',exact:true})).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'确认发送',exact:true}).click();
    const query=page.getByRole('button',{name:'查询发送结果',exact:true});
    await expect(query).toBeVisible({timeout:30000});
    await expect(page.getByRole('button',{name:'确认发送',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'生成预览',exact:true})).toHaveCount(0);
    await expect(page.getByLabel('发送对象',{exact:true})).toBeDisabled();
    assert.equal(state.sends,before+1);
    await page.screenshot({path:root+`/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-outbox-unknown.png`,fullPage:true});
    await query.click();
    await expect(query).toHaveCount(0,{timeout:30000});
    assert.equal((await client`SELECT status FROM workshop_outbox WHERE id=${outbox}`)[0].status,'sent');
    assert.equal(state.sends,before+1);
    await page.screenshot({path:root+`/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-outbox-sent.png`,fullPage:true});
    return {passed:true,sendCalls:state.sends-before,previewConfirmUnknownQuerySent:true};
  }catch(error){
    if(page){
      await page.screenshot({path:root+`/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-outbox-browser-failure.png`,fullPage:true}).catch(()=>{});
      fs.writeFileSync(root+`/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-outbox-browser-failure.txt`,await page.locator('body').innerText().catch(()=>String(error)),'utf8');
    }
    throw error;
  }finally{await browser.close();}
}
