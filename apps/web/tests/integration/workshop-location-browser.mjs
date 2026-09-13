import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});

export async function checkWorkshopLocationBrowser({client,owner,origin,root,recordPrefix}){
  const a=randomUUID(),b=randomUUID(),foreign=randomUUID(),other=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${other},'location-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES
    (${a},${owner},'位置回测甲','位置回测甲的任务'),
    (${b},${owner},'位置回测乙','位置回测乙的任务'),
    (${foreign},${other},'不可见车间','不可见任务')`;
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    const page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    const selected=id=>page.locator(`[data-workshop-id="${id}"]`);
    const assertSelected=async id=>expect(selected(id)).toHaveAttribute('aria-pressed','true');
    await page.route('**/api/page-state/workshop',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'list_unavailable'})}));
    await page.goto(`${origin}/workshop?workId=${b}&tab=sources`);
    await expect(page.getByText('list_unavailable',{exact:true})).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get('workId'),b,'temporary list failure must preserve the requested destination');
    await page.unroute('**/api/page-state/workshop');
    await page.goto(`${origin}/workshop?workId=${b}&tab=sources`);
    await assertSelected(b);
    await expect(page.getByRole('tab',{name:'资料',exact:true})).toHaveAttribute('aria-selected','true');
    await page.reload();await assertSelected(b);
    await expect(page.getByRole('tab',{name:'资料',exact:true})).toHaveAttribute('aria-selected','true');
    await page.getByRole('tab',{name:'运行配置',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`workId=${b}&tab=loops`));
    await selected(a).click();await assertSelected(a);
    await page.goBack();await assertSelected(b);
    await page.goBack();await expect(page.getByRole('tab',{name:'资料',exact:true})).toHaveAttribute('aria-selected','true');
    const copied=await context.newPage();await copied.goto(page.url());
    await expect(copied.locator(`[data-workshop-id="${b}"]`)).toHaveAttribute('aria-pressed','true');
    await expect(copied.getByRole('tab',{name:'资料',exact:true})).toHaveAttribute('aria-selected','true');
    await copied.close();
    for(const [tab,name] of [['memory','记忆'],['sources','资料'],['review','审核'],['outbox','待发']]){
      await page.getByRole('tab',{name,exact:true}).click();
      await expect.poll(()=>new URL(page.url()).searchParams.get('tab')).toBe(tab);
      await expect(page.getByRole('tab',{name,exact:true})).toHaveAttribute('aria-selected','true');
      if(tab==='memory'){
        await expect(page.getByRole('region',{name:'记忆质量信息'})).toBeVisible();
        await expect(page.getByPlaceholder('资料名称')).toHaveCount(0);
      }
      if(tab==='sources'){
        await expect(page.getByPlaceholder('资料名称')).toBeVisible();
        await expect(page.getByRole('region',{name:'记忆质量信息'})).toHaveCount(0);
      }
      if(tab==='outbox')await expect(page.getByText('智能体操作审核',{exact:true})).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('tab',{name,exact:true})).toHaveAttribute('aria-selected','true');
    }
    const forbiddenRequests=[];
    page.on('request',r=>{if(r.url().includes('/api/')&&r.url().includes(foreign))forbiddenRequests.push(r.url());});
    await page.goto(`${origin}/workshop?workId=${foreign}&tab=constructor&runId=old&reviewId=old`);
    await expect.poll(()=>new URL(page.url()).searchParams.get('workId')).not.toBe(foreign);
    await expect(page.getByRole('tab',{name:'本次运行',exact:true})).toHaveAttribute('aria-selected','true');
    assert.equal(new URL(page.url()).searchParams.has('runId'),false);
    assert.equal(new URL(page.url()).searchParams.has('reviewId'),false);
    await expect(page.getByText('不可见车间',{exact:true})).toHaveCount(0);
    assert.deepEqual(forbiddenRequests,[]);
    await page.goto(`${origin}/workshop?workId=${a}&tab=memory`);
    await expect.poll(()=>new URL(page.url()).searchParams.get('tab')).toBe('memory');
    await page.goto(`${origin}/workshop?workId=${a}&tab=tools`);
    await expect.poll(()=>new URL(page.url()).searchParams.get('tab')).toBe('loops');

    // Hold a real A response, switch to B, then release A.
    await page.goto(`${origin}/workshop?workId=${b}`);await assertSelected(b);
    let release,received;
    const gate=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{received=resolve;});
    await page.route(`**/api/page-state/workshop/${a}/summary*`,async route=>{
      const response=await route.fetch();received();await gate;await route.fulfill({response});
    });
    await selected(a).click();
    let arrivalTimer;
    try{await Promise.race([arrived,new Promise((_,reject)=>{arrivalTimer=setTimeout(()=>reject(Error('A summary request did not reach the delay gate')),60000);})]);}
    finally{clearTimeout(arrivalTimer);}
    await selected(b).click();await assertSelected(b);
    const delayedResponse=page.waitForResponse(r=>r.url().includes(`/api/page-state/workshop/${a}/summary`));
    release();await (await delayedResponse).finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(page.locator(`[data-workshop-overview-id="${b}"]`).getByText('位置回测乙',{exact:true})).toBeVisible();
    await expect(page.locator(`[data-workshop-overview-id="${a}"]`)).toHaveCount(0);
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-selected.png`});
    return {listFailurePreservesDestination:true,refresh:true,back:true,copiedLink:true,ownerScopedFallback:true,noForeignDetailRequest:true,legacyTabAlias:true,lateResponseDoesNotReplaceSelection:true};
  }finally{await browser.close();}
}
