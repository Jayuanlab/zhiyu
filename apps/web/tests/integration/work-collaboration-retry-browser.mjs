import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';

const origin=process.env.ZHIYU_BROWSER_ORIGIN||'http://127.0.0.1:3515';
const requestId=randomUUID();
const recipientWorkId=randomUUID();
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  page.setDefaultTimeout(30000);
  await page.route(url=>/^\/api\/workshops\/[^/]+\/collaboration$/.test(url.pathname),async route=>{
    const workId=route.request().url().match(/\/api\/workshops\/([^/]+)\/collaboration$/)?.[1];
    const data={requests:[{
      id:requestId,requesterWorkId:workId,recipientWorkId,
      requesterName:'Requester',recipientName:'Recipient',kind:'consult',status:'delivered',
      problem:'Retry browser fixture',desiredOutcome:'A checked result',whyHelpNeeded:'Specialized help',
      acceptanceCriteria:'Result is verified',response:null,resolutionNote:null,
      recipientRunId:randomUUID(),recipientRunStatus:'failed',recipientRunError:'Model unavailable',
      recipientWorkStatus:'active',dueAt:new Date(Date.now()+3600000).toISOString(),
      attentionReason:'recipient_run_failed',attentionAt:new Date().toISOString(),
      version:2,updatedAt:new Date().toISOString(),
    }],peers:[]};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.route(url=>url.pathname.endsWith(`/collaboration/${requestId}`),async route=>{
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({events:[]})});
  });
  const response=await page.goto(`${origin}/workshop?tab=collaboration`,{waitUntil:'domcontentloaded',timeout:120000});
  assert.equal(response?.status(),200);
  await page.getByText('Retry browser fixture').first().click();
  await page.getByText('交给接收方运行').waitFor();
  assert.equal(await page.getByRole('checkbox',{name:/我已核对旧运行/}).count(),1);
  assert.equal(await page.getByText('需要关注：接收方运行失败，需要人工核对后再处理').count()>0,true);
  console.log(JSON.stringify({passed:true,retryControl:true,attentionVisible:true}));
}finally{await browser.close();}
