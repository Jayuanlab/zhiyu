import assert from 'node:assert/strict';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkspacePickerBrowser({origin,root,recordPrefix}){
  const browser=await chromium.launch({headless:true});let page;
  try{
    const context=await browser.newContext({viewport:{width:1280,height:960}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);page.setDefaultTimeout(60000);
    const requests=[];let failure;
    await page.route('**/api/workspace/files?*',async route=>{
      try{
        const url=new URL(route.request().url());
        if(url.searchParams.get('pagination')!=='bounded'){await route.fulfill({status:200,contentType:'application/json',body:'{"files":[]}'});return;}
        requests.push(url.searchParams.toString());const taskId=url.searchParams.get('taskId');assert.ok(taskId);
        const body=url.searchParams.has('cursor')?{files:[{taskId,name:'Chosen.txt',path:'docs/Chosen.txt',type:'txt'}],hasMore:false,nextCursor:null}:
          {files:[],hasMore:true,nextCursor:'picker-next'};
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
      }catch(error){failure=error;await route.abort().catch(()=>{});}
    });
    await page.goto(origin+'/');
    await page.getByRole('button',{name:'添加文件',exact:true}).click();
    await page.getByRole('menuitem',{name:'从空间内添加',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'从工作空间选择文件',exact:true});
    const state=dialog.getByRole('region',{name:'文件选择扫描状态'});
    await expect(state).toContainText('列表尚未完整');if(failure)throw failure;
    await state.getByRole('button',{name:'继续扫描',exact:true}).click();
    await expect(state).toContainText('扫描完成');
    await dialog.getByRole('button',{name:'Chosen.txt',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await expect(state).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-mobile.png`,fullPage:true});
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Chosen.txt',{exact:true}).first()).toBeVisible();
    assert.equal(requests.filter(query=>query.includes('cursor=picker-next')).length,1);
    assert.ok(requests.every(query=>new URLSearchParams(query).get('taskId')===new URLSearchParams(requests[0]).get('taskId')));
    return {actualChatPicker:true,boundedTaskQuery:true,emptyPageContinues:true,chosenFileAttached:true,mobileNoHorizontalOverflow:true,fixtureFileResponses:true,observedRequests:requests.length,continuationRequests:1};
  }catch(error){if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally{await browser.close();}
}
