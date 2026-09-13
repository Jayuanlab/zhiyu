import assert from 'node:assert/strict';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkspaceBoundedBrowser({origin,root,recordPrefix}){
  const browser=await chromium.launch({headless:true});let page;
  try{
    const context=await browser.newContext({viewport:{width:1280,height:960}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    const requests=[];let initial=0,continuation=0;
    const item=name=>({taskId:'fixture-task',name,path:name,type:'txt',size:12,modifiedTime:'2026-09-08T00:00:00.000Z',isDirectory:false});
    await page.route('**/api/workspace/files?*',async route=>{
      const url=new URL(route.request().url());requests.push(url.searchParams.toString());
      assert.equal(url.searchParams.get('pagination'),'bounded');
      const cursor=url.searchParams.get('cursor');
      let status=200,body;
      if(!cursor){initial++;body=initial===1?{files:[],hasMore:true,nextCursor:'page-one',total:null}:{files:[item('Restarted.txt')],hasMore:false,nextCursor:null,total:null};}
      else if(cursor==='page-one'){
        continuation++;if(continuation===1){status=503;body={error:'fixture_unavailable'};}
        else body={files:[item('Recovered.txt')],hasMore:true,nextCursor:'page-two',total:null};
      }else{status=410;body={error:'cursor_expired',resetRequired:true};}
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(origin+'/workspace?tab=stuff');
    const region=page.getByRole('region',{name:'工作区扫描状态'});
    await expect(region).toContainText('列表尚未完整');
    await region.getByRole('button',{name:'继续扫描',exact:true}).click();
    await expect(region).toContainText('读取失败');
    await region.getByRole('button',{name:'重试读取',exact:true}).click();
    await expect(page.getByText('Recovered.txt',{exact:true}).first()).toBeVisible();
    await expect(region).toContainText('已加载 1 个文件');
    await region.getByRole('button',{name:'继续扫描',exact:true}).click();
    await expect(region).toContainText('游标已变化');
    await expect(page.getByText('Recovered.txt',{exact:true}).first()).toBeVisible();
    await region.getByRole('button',{name:'重新扫描',exact:true}).click();
    await expect(region).toContainText('本次扫描完成');
    await expect(page.getByText('Restarted.txt',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('Recovered.txt',{exact:true})).toHaveCount(0);
    assert.equal(requests.length,5);assert.equal(requests[1],requests[2]);
    await region.scrollIntoViewIfNeeded();
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-desktop.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await region.scrollIntoViewIfNeeded();await expect(region).toBeVisible();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-mobile.png`,fullPage:true});
    return {pageUsesBoundedEndpoint:true,fixtureResponses:true,emptyPageContinues:true,sameCursorNetworkRetry:true,expiredCursorPreservesLoadedFiles:true,restartReplacesOldFiles:true,completionExplicit:true,mobileNoHorizontalOverflow:true};
  }catch(error){if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally{await browser.close();}
}
