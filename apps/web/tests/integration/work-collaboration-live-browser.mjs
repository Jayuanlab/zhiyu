import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';

const origin=process.env.ZHIYU_BROWSER_ORIGIN||'http://127.0.0.1:3515';
const workId=process.env.ZHIYU_PILOT_TRADER_ID;
if(!/^[a-f\d-]{36}$/i.test(workId||''))throw Error('Trader Work ID required');
const screenshot=resolve(import.meta.dirname,'../../../../docs/plans/agent-work-autonomous-cooperation/records/2026-09-25-trader-hunter-live-browser.png');
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.setDefaultTimeout(30000);
  const response=await page.goto(`${origin}/workshop?tab=collaboration&workId=${workId}`,
    {waitUntil:'domcontentloaded',timeout:120000});
  assert.equal(response?.status(),200);
  const request=page.locator('button').filter({hasText:'当前正式自选股（core pool）共2只标的'}).first();
  await request.waitFor();
  await request.click();
  await page.getByText('已验证解决').first().waitFor();
  await page.getByLabel('协作记录').getByText('提交回复',{exact:false}).waitFor();
  await page.getByLabel('协作记录').scrollIntoViewIfNeeded();
  await page.screenshot({path:screenshot});
  console.log(JSON.stringify({passed:true,url:page.url(),verifiedVisible:true,screenshot}));
}finally{await browser.close();}
