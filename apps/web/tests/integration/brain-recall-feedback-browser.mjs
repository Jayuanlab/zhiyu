import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60000 });
export async function checkRecallFeedbackBrowser({client,owner,origin,root,recordPrefix}) {
  const contextId = randomUUID();
  await client`INSERT INTO brain_context_logs(id,user_id,requester_type,task_intent) VALUES (${contextId},${owner},'owner','Feedback browser fixture')`;
  const browser = await chromium.launch({headless:true});
  let page;
  try {
    const context = await browser.newContext({viewport:{width:1280,height:900}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page = await context.newPage(); page.setDefaultNavigationTimeout(180000);
    await page.route('**/api/memory/search', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      query:'Feedback browser fixture',sources:['memory'],sourceSemantics:{memory:'canonical_context_candidate'},
      results:[],count:0,warnings:[],contextTrace:{contextLogId:contextId,interfaceVersion:'brain-context-trace.v1',
        selection:{selectedCount:0,deniedCount:0,omittedCount:0,duplicateCanonicalGroupCount:0,selectedCanonicalKinds:{}},
        selected:[],omitted:[],denied:[]},
    })}));
    let first=true, committed, routeError; const requests=[];
    await page.route('**/api/memory/recall-feedback', async route => {
      try {
        requests.push(route.request().postDataJSON());
        if(first) {
          first=false;
          const response=await fetch(origin+'/api/memory/recall-feedback',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:route.request().postData(),signal:AbortSignal.timeout(60000)});
          committed=await response.json(); assert.equal(response.status,201,JSON.stringify(committed));
          await route.abort('failed'); return;
        }
        await route.continue();
      } catch(error) {routeError=error;await route.abort().catch(()=>{});}
    });
    await page.goto(origin+'/memory');
    await page.getByPlaceholder('例如：盘中模拟交易员现在要复盘今日交易，需要召回哪些边界、计划、证据和历史结论？').fill('Feedback browser fixture');
    await page.getByRole('button',{name:'开始召回',exact:true}).click();
    const used=page.getByRole('button',{name:'有用',exact:true});await expect(used).toBeEnabled();await used.click();
    await expect.poll(()=>{if(routeError)throw routeError;return committed;}).toBeTruthy();
    await expect(page.getByRole('status',{name:'召回反馈状态'})).toContainText('暂未确认');
    await expect(used).toBeDisabled();
    await page.reload();
    await expect(page.getByRole('region',{name:'反馈恢复'})).toContainText('Feedback browser fixture');
    const retry = page.getByRole('button',{name:'重试原反馈',exact:true});
    await expect(retry).toBeEnabled();
    const retryResponse=page.waitForResponse(response=>response.url().endsWith('/api/memory/recall-feedback')&&response.status()===201);
    await retry.click();await retryResponse;
    assert.equal(requests.length,2);assert.equal(requests[0].feedbackId,requests[1].feedbackId);
    assert.equal((await client`SELECT count(*)::int AS n FROM feedback WHERE user_id=${owner}`)[0].n,1);
    await expect(page.getByText('已记录这次召回反馈。',{exact:true})).toBeVisible();
    await expect(page.getByRole('status',{name:'召回反馈状态'})).toContainText('不会重复计数');
    assert.equal(await page.evaluate(owner=>sessionStorage.getItem(`recall-feedback-pending:v1:${owner}`),owner),null);
    await page.getByPlaceholder('例如：盘中模拟交易员现在要复盘今日交易，需要召回哪些边界、计划、证据和历史结论？').fill('Feedback browser fixture');
    await page.getByRole('button',{name:'开始召回',exact:true}).click();
    await expect(used).toBeEnabled();
    await page.evaluate(()=>{
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key.startsWith('recall-feedback-pending:'))throw Error('Injected storage failure');return original.call(this,key,value);};
    });
    await used.click();
    await expect(page.getByRole('status',{name:'召回反馈状态'})).toContainText('反馈未发送');
    assert.equal(requests.length,2);
    await page.reload();
    await page.getByPlaceholder('例如：盘中模拟交易员现在要复盘今日交易，需要召回哪些边界、计划、证据和历史结论？').fill('Feedback browser fixture');
    await page.getByRole('button',{name:'开始召回',exact:true}).click();await expect(used).toBeEnabled();
    await page.route('**/api/identity',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({actorId:randomUUID()})}));
    await used.click();await expect(page.getByRole('status',{name:'召回反馈状态'})).toContainText('登录用户已变化');
    assert.equal(requests.length,2);
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-desktop.png`,fullPage:true});
    return {searchResponseFixture:true,realFeedbackHttp:true,responseLostAfterCommit:true,reloadRestoresPending:true,retrySameId:true,persistedRecords:1,successVisible:true,receiptClearsPending:true,storageFailurePreventsSend:true,ownerChangePreventsSend:true};
  } catch(error) {if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally {await browser.close();}
}
