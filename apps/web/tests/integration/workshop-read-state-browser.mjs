import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkshopReadStateBrowser({client,owner,origin,root,recordPrefix}) {
  const work=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'读取状态回测','隔离刷新失败')`;
  const browser=await chromium.launch({headless:true});let page;
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    await page.goto(`${origin}/workshop?workId=${work}&tab=memory`);
    const report=page.getByRole('region',{name:'记忆质量信息'}),refresh=page.getByRole('button',{name:'刷新记忆',exact:true});
    await expect(report).toBeVisible();await expect(refresh).toBeEnabled();
    const original=await report.textContent();assert.ok(original?.includes('Recall quality'));
    const match=`**/api/workshops/${work}/memory-recall-quality?days=7`;
    let failedRequests=0;
    await page.route(match,route=>{failedRequests++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'isolated_quality_offline'})});});
    await refresh.click();
    const warning=page.getByRole('status',{name:'信息读取状态'});
    await expect(warning).toContainText('记忆质量：读取失败；最近成功读取于');
    await expect(refresh).toBeEnabled();assert.ok(failedRequests>0);
    assert.equal(await report.textContent(),original,'failed refresh must retain the previous visible report');
    await warning.scrollIntoViewIfNeeded();await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-degraded.png`});
    await page.unroute(match);await refresh.click();await expect(refresh).toBeEnabled();await expect(warning).toHaveCount(0);await expect(report).toBeVisible();
    return {realReportInitiallyLoaded:true,refreshFailureExplicit:true,lastSuccessShown:true,previousReportPreserved:true,manualRetryRecovers:true};
  } catch(error) {if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally {await browser.close();}
}
