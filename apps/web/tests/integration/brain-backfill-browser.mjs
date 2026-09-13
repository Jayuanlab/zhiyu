import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkBrainBackfillBrowser({client,owner,origin,root,recordPrefix}){
  const ids=Array.from({length:25},()=>randomUUID()).sort();
  for(const id of ids)await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content) VALUES (${id},${owner},'global','chat',${owner},'boundary','模拟盘边界','不得发起真实交易')`;
  const browser=await chromium.launch({headless:true});let page;
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    await page.goto(origin+'/memory');await page.getByRole('link',{name:'记忆索引维护',exact:true}).click();
    const preview=page.getByRole('button',{name:'生成回填预览',exact:true});await expect(preview).toBeEnabled();await preview.click();
    const plan=page.getByRole('region',{name:'回填计划'});await expect(plan).toContainText('待审核');await expect(plan).toContainText('模拟盘边界');await expect(plan).toContainText('缺证据：25');
    const approve=page.getByRole('button',{name:'批准本批计划',exact:true});await expect(approve).toBeDisabled();
    await page.getByRole('checkbox',{name:'我已核对本批计划，同意仅补分类与分组索引。'}).check();await approve.click();
    await expect(plan).toContainText('可继续执行');
    let dropped=false;let routeFailure;let committedResult;
    await page.route('**/api/brain/backfill',async route=>{
      try{
        if(route.request().method()==='POST'&&route.request().postDataJSON()?.action==='apply'&&!dropped){
          dropped=true;
          const committed=await fetch(origin+'/api/brain/backfill',{method:'POST',headers:{'Content-Type':'application/json',origin},body:route.request().postData(),signal:AbortSignal.timeout(10000)});
          committedResult=await committed.json();assert.equal(committed.status,200,JSON.stringify(committedResult));await route.abort('failed');return;
        }
        await route.continue();
      }catch(error){routeFailure=error;await route.abort().catch(()=>{});}
    });
    await page.getByRole('button',{name:'执行下一段',exact:true}).click();
    await expect(page.getByRole('region',{name:'待确认操作'})).toBeVisible();await expect(page.getByRole('alert',{name:'回填状态警告'})).toBeVisible();
    await expect.poll(()=>{if(routeFailure)throw routeFailure;return committedResult;},{timeout:20000}).toBeTruthy();
    const diagnostic={committedResult,items:await client`SELECT i.status,i.detail FROM brain_backfill_items i JOIN brain_backfill_batches b ON b.id=i.batch_id WHERE b.user_id=${owner}`};
    fs.writeFileSync(`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-apply-diagnostic.json`,JSON.stringify(diagnostic,null,2));
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${owner} AND canonical_kind IS NOT NULL`)[0].n,20,JSON.stringify(committedResult));
    await page.reload();
    const retry=page.getByRole('button',{name:'重试原请求',exact:true});await expect(retry).toBeEnabled();await retry.click();
    await expect(page.getByRole('region',{name:'待确认操作'})).toHaveCount(0);await expect(plan).toContainText('已补索引：20');
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${owner} AND canonical_kind IS NOT NULL`)[0].n,20);
    await page.getByRole('button',{name:'暂停本批',exact:true}).click();await expect(plan).toContainText('已暂停');
    await page.reload();await expect(plan).toContainText('已暂停');await page.getByRole('button',{name:'恢复本批',exact:true}).click();
    await expect(plan).toContainText('可继续执行');
    await client`UPDATE brain_memories SET content='用户纠错：保持候选，不自动确认' WHERE id=${ids[24]}`;
    await page.getByRole('button',{name:'执行下一段',exact:true}).click();await expect(plan).toContainText('部分完成，需核对冲突');await expect(plan).toContainText('来源已变更：1');
    await client`UPDATE brain_memories SET content='回填后新的主人纠错' WHERE id=${ids[0]}`;
    await plan.getByText('回退本批修改',{exact:true}).click();
    const rollback=page.getByRole('button',{name:'回退下一段',exact:true});await expect(rollback).toBeDisabled();
    const acknowledgement=page.getByRole('checkbox',{name:'我理解回退会取消本批未处理项，仅恢复本批写入且未被后续修改的索引。'});
    await acknowledgement.check();await rollback.click();await expect(plan).toContainText('回退中');
    await acknowledgement.check();await rollback.click();await expect(plan).toContainText('部分回退，需核对冲突');
    assert.equal((await client`SELECT content FROM brain_memories WHERE id=${ids[0]}`)[0].content,'回填后新的主人纠错');
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${owner} AND canonical_kind IS NOT NULL`)[0].n,1);
    await page.unroute('**/api/brain/backfill');
    await page.route('**/api/brain/backfill',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'backfill_unavailable'})}));
    await page.getByRole('button',{name:'刷新当前状态',exact:true}).click();await expect(page.getByRole('alert',{name:'回填状态警告'})).toContainText('读取失败');await expect(plan).toContainText('部分回退，需核对冲突');await expect(preview).toBeDisabled();
    await page.unroute('**/api/brain/backfill');await page.getByRole('button',{name:'刷新当前状态',exact:true}).click();await expect(page.getByRole('alert',{name:'回填状态警告'})).toHaveCount(0);await expect(preview).toBeEnabled();
    await page.getByRole('heading',{name:'记忆索引维护',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-mobile.png`,fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-desktop.png`,fullPage:true});
    return {memoryEntry:true,previewSamples:true,explicitApproval:true,responseLostAfterCommit:true,reloadRetrySameCommand:true,pausePersists:true,resume:true,sourceConflictVisible:true,guardedRollback:true,mobileNoHorizontalOverflow:true,failedRefreshPreservesVisibleState:true};
  }catch(error){if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally{await browser.close();}
}
