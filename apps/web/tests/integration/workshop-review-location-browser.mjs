import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkshopReviewLocationBrowser({client,owner,origin,root,recordPrefix}) {
  const work=randomUUID(),target=randomUUID(),foreign=randomUUID(),other=randomUUID(),foreignItem=randomUUID(),source=randomUUID(),foreignSource=randomUUID(),badReference=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${other},'review-location-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'审核定位回测','隔离审核'),(${foreign},${other},'私有审核车间','私有任务')`;
  await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title,body) VALUES (${source},${work},1,'observation','审核来源','本车间原始证据'),(${foreignSource},${foreign},1,'observation','私有来源','私有原始证据')`;
  await client`INSERT INTO workshop_review_items(id,workshop_id,kind,title,summary,source_event_id,created_at) VALUES (${target},${work},'service_error','早期待审核记录','早期审核依据',${source},'2020-01-01'),(${foreignItem},${foreign},'service_error','私有审核','私有审核依据',${foreignSource},now())`;
  await client`INSERT INTO workshop_review_items(id,workshop_id,kind,title,source_event_id,status) VALUES (${badReference},${work},'service_error','错误关联记录',${foreignSource},'dismissed')`.catch(async error=>{
    // A source event has a unique review. Move the reference to the owned fixture
    // to exercise the separate workshop condition on source retrieval.
    if(error.code!=='23505')throw error;
    await client`UPDATE workshop_review_items SET source_event_id=NULL WHERE id=${foreignItem}`;
    await client`INSERT INTO workshop_review_items(id,workshop_id,kind,title,source_event_id,status) VALUES (${badReference},${work},'service_error','错误关联记录',${foreignSource},'dismissed')`;
  });
  await client`INSERT INTO workshop_review_items(workshop_id,kind,title) SELECT ${work},'service_error','其他待处理记录' FROM generate_series(1,202)`;
  const browser=await chromium.launch({headless:true});let page;const diagnostics=[];
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    page.on('pageerror',error=>diagnostics.push({type:'pageerror',message:error.message}));
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())diagnostics.push({type:'navigation',url:frame.url()});});
    page.on('console',message=>diagnostics.push({type:'console',message:message.text()}));
    page.on('requestfailed',request=>diagnostics.push({type:'requestfailed',url:request.url(),failure:request.failure()}));
    const url=`${origin}/workshop?workId=${work}&reviewId=${target}`;
    const focus=page.getByRole('region',{name:'定位审核记录',exact:true});
    await page.goto(url);await expect(focus.getByText('早期待审核记录',{exact:true})).toBeVisible();
    await expect(page.getByRole('tab',{name:/审核/})).toHaveAttribute('aria-selected','true');
    await page.reload();await expect(focus.getByText('审核状态：待处理',{exact:true})).toBeVisible();
    const list=await page.request.get(`${origin}/api/workshops/${work}/review-items`);assert.equal(list.status(),200);
    assert.equal((await list.json()).items.some(item=>item.id===target),false);
    const direct=await page.request.get(`${origin}/api/workshops/${work}/review-items?reviewId=${target}`);assert.equal(direct.status(),200);
    assert.equal((await direct.json()).sourceEvent.id,source);
    const card=page.locator(`[data-review-item-id="${target}"]`);
    await expect(card.getByRole('link',{name:'定位此审核'})).toHaveAttribute('href',`?workId=${work}&tab=review&reviewId=${target}`);
    await card.getByRole('button',{name:'暂不处理',exact:true}).click();
    await expect(focus.getByText('审核状态：已暂不处理',{exact:true})).toBeVisible();
    await expect(card).toHaveCount(0);
    const [stored]=await client`SELECT status FROM workshop_review_items WHERE id=${target}`;assert.equal(stored.status,'dismissed');
    diagnostics.push({type:'before-copy',url:page.url(),focusCount:await focus.count()});
    const copied=await context.newPage();await copied.goto(page.url());
    await expect(copied.getByRole('region',{name:'定位审核记录'}).getByText('审核状态：已暂不处理',{exact:true})).toBeVisible();await copied.close();
    diagnostics.push({type:'after-copy',url:page.url(),focusCount:await focus.count()});
    await focus.getByRole('button',{name:'返回审核列表'}).click();await expect(focus).toHaveCount(0);
    await page.goBack();await expect(focus.getByText('审核状态：已暂不处理',{exact:true})).toBeVisible();
    await focus.scrollIntoViewIfNeeded();await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-resolved.png`});
    const forbidden=await page.request.get(`${origin}/api/workshops/${work}/review-items?reviewId=${foreignItem}`);assert.equal(forbidden.status(),404);
    const foreignWork=await page.request.get(`${origin}/api/workshops/${foreign}/review-items?reviewId=${foreignItem}`);assert.equal(foreignWork.status(),404);
    const scopedSource=await page.request.get(`${origin}/api/workshops/${work}/review-items?reviewId=${badReference}`);assert.equal((await scopedSource.json()).sourceEvent,null);
    await page.goto(`${origin}/workshop?workId=${work}&reviewId=${foreignItem}`);await expect(focus.getByText('未找到可访问的审核记录。',{exact:true})).toBeVisible();await expect(page.getByText('私有审核依据',{exact:true})).toHaveCount(0);
    const match=`**/api/workshops/${work}/review-items?reviewId=${target}`;
    await page.route(match,route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
    await page.goto(url);await expect(focus.getByText('审核记录读取失败，请重试。',{exact:true})).toBeVisible();
    await page.unroute(match);await focus.getByRole('button',{name:'重新读取审核记录'}).click();await expect(focus.getByText('审核状态：已暂不处理',{exact:true})).toBeVisible();
    return {outsidePendingWindow:true,sourceScopedToWorkshop:true,directReloadAndCopiedLink:true,existingActionUpdatesStatus:true,resolvedHasNoAction:true,backRestoresReview:true,foreignIdAndWorkshop404:true,readFailureRetry:true};
  } catch(error) {if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally {fs.writeFileSync(`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-review-diagnostics.json`,JSON.stringify(diagnostics,null,2));await browser.close();}
}
