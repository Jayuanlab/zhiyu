import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkshopDraftsBrowser({client,owner,origin,root,recordPrefix}){
  const a=randomUUID(),b=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${a},${owner},'草稿甲','隔离草稿回测'),(${b},${owner},'草稿乙','隔离草稿回测')`;
  const browser=await chromium.launch({headless:true});
  let page;
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    const select=async id=>{await page.locator(`[data-workshop-id="${id}"]`).click();await expect(page.locator(`[data-workshop-id="${id}"]`)).toHaveAttribute('aria-pressed','true');};
    const direction=page.getByRole('textbox',{name:'追加车间方向',exact:true});
    await page.goto(`${origin}/workshop?workId=${a}`);
    await direction.fill('甲的未提交方向');await select(b);await expect(direction).toHaveValue('');
    await direction.fill('乙的未提交方向');await select(a);await expect(direction).toHaveValue('甲的未提交方向');
    await page.reload();await expect(direction).toHaveValue('甲的未提交方向');
    await page.goto(`${origin}/workshop?workId=${a}&tab=loops`);
    const intent=page.getByRole('textbox',{name:'持续任务意图',exact:true});
    await intent.fill('甲的持续任务草稿');await select(b);await expect(intent).toHaveValue('');
    await intent.fill('乙的持续任务草稿');await select(a);await expect(intent).toHaveValue('甲的持续任务草稿');
    await page.reload();await expect(intent).toHaveValue('甲的持续任务草稿');
    await page.goto(`${origin}/workshop?workId=${a}`);
    await expect(direction).toHaveValue('甲的未提交方向');
    await expect(page.getByRole('button',{name:'追加方向',exact:true})).toBeEnabled();
    let release,arrive;
    const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{arrive=resolve;});
    await page.route(`**/api/workshops/${a}/directives`,async route=>{
      const response=await route.fetch();assert.equal(response.status(),201,await response.text());arrive();await gate;await route.fulfill({response});
    });
    await page.getByRole('button',{name:'追加方向',exact:true}).click();
    let timer;try{await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('directive command did not reach receipt gate')),60000);})]);}finally{clearTimeout(timer);}
    await direction.fill('甲在提交后继续编辑');await select(b);await direction.fill('甲的未提交方向');
    release();await expect(page.getByRole('button',{name:'追加方向',exact:true})).toBeEnabled();
    await expect(direction).toHaveValue('甲的未提交方向');await select(a);await expect(direction).toHaveValue('甲在提交后继续编辑');
    await page.reload();await expect(direction).toHaveValue('甲在提交后继续编辑');
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-saved.png`});
    const [commands]=await client`SELECT count(*)::int AS count FROM work_commands WHERE owner_id=${owner} AND status='succeeded'`;
    assert.equal(commands.count,1);
    return {perWorkshopDirection:true,perWorkshopLoopIntent:true,reloadAndNavigationRestore:true,lateReceiptPreservesNewEdit:true,receiptDoesNotClearOtherWorkshop:true,oneCommittedCommand:true};
  }catch(error){if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally{await browser.close();}
}
