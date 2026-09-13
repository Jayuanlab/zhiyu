import assert from 'node:assert/strict';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkspaceSecondaryBrowser({origin,root,recordPrefix}){
  const browser=await chromium.launch({headless:true});let page;
  try{
    const context=await browser.newContext({viewport:{width:1280,height:960}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(180000);
    let phase='mention',attempts=0,panelStarts=0,failure;const requests=[];
    await page.route('**/api/workspace/files?*',async route=>{
      try{
        const url=new URL(route.request().url());
        if(url.searchParams.get('pagination')!=='bounded'){await route.fulfill({status:200,contentType:'application/json',body:'{"files":[]}'});return;}
        const taskId=url.searchParams.get('taskId');assert.ok(taskId);requests.push({phase,query:url.searchParams.toString()});
        const item=name=>({taskId,name,path:name,type:'txt'});let status=200,body;
        if(phase==='mention'){
          if(!url.searchParams.has('cursor'))body={files:[],hasMore:true,nextCursor:'mention-next'};
          else if(++attempts===1){status=503;body={error:'injected'};}
          else body={files:[item('Mention.txt')],hasMore:false,nextCursor:null};
        }else{
          if(url.searchParams.has('cursor')){status=410;body={error:'cursor_expired'};}
          else if(++panelStarts===1)body={files:[item('Panel.txt')],hasMore:true,nextCursor:'panel-next'};
          else body={files:[item('Rescanned.txt')],hasMore:false,nextCursor:null};
        }
        await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      }catch(error){failure=error;await route.abort().catch(()=>{});}
    });
    await page.goto(origin+'/');
    const textarea=page.locator('#openzhiyu-reply-textarea');await expect(textarea).toBeVisible();
    assert.equal(requests.length,0);
    await textarea.fill('@');await page.getByRole('button',{name:'从空间内添加',exact:true}).click();
    const mention=page.getByRole('region',{name:'文件选择扫描状态'});
    await expect(mention).toContainText('列表尚未完整');if(failure)throw failure;
    await mention.getByRole('button',{name:'继续扫描',exact:true}).click();await expect(mention).toContainText('读取失败');
    await mention.getByRole('button',{name:'重试读取',exact:true}).click();await expect(mention).toContainText('扫描完成');
    await page.getByRole('button',{name:'Mention.txt',exact:true}).click();
    await expect(mention).toHaveCount(0);await expect(page.getByText('Mention.txt',{exact:true}).first()).toBeVisible();
    const mentionRequests=requests.filter(item=>item.phase==='mention');assert.equal(mentionRequests.length,3);assert.equal(mentionRequests[1].query,mentionRequests[2].query);
    phase='panel';await page.getByRole('button',{name:'Chat Vault',exact:true}).click();
    const panel=page.getByRole('region',{name:'面板文件扫描状态'});await expect(panel).toContainText('列表尚未完整');
    await expect(page.getByRole('button',{name:'Panel.txt',exact:true})).toBeVisible();
    await panel.getByRole('button',{name:'继续扫描',exact:true}).click();await expect(panel).toContainText('游标已变化');
    await expect(page.getByRole('button',{name:'Panel.txt',exact:true})).toBeVisible();
    await panel.getByRole('button',{name:'重新扫描',exact:true}).click();await expect(panel).toContainText('扫描完成');
    await expect(page.getByRole('button',{name:'Rescanned.txt',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Panel.txt',exact:true})).toHaveCount(0);
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-desktop.png`,fullPage:true});
    return {hiddenPanelNoFileReads:true,mentionBounded:true,mentionEmptyContinues:true,mentionSameCursorRetry:true,mentionAttachmentPreserved:true,panelBounded:true,panelExpiredCursorPreservesFiles:true,panelRestartReplacesFiles:true,fixtureResponses:true};
  }catch(error){if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally{await browser.close();}
}
