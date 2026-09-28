import { chromium } from '@playwright/test';

const origin = process.env.ZHIYU_BROWSER_ORIGIN || 'http://127.0.0.1:3515';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(`page:${error.message}`));
  page.on('console', message => {if(message.type()==='error')errors.push(`console:${message.text()}`);});
  page.on('requestfailed', request => errors.push(`request:${request.url()}:${request.failure()?.errorText}`));
  const response = await page.goto(`${origin}/workshop?tab=collaboration`, {waitUntil:'domcontentloaded',timeout:120000});
  await page.getByText('\u540c\u4f34\u534f\u4f5c').waitFor({timeout:30000}).catch(()=>{});
  const body = await page.locator('body').innerText();
  const result = {status:response?.status(),url:page.url(),
    collaborationTab:body.includes('\u534f\u4f5c'),
    collaborationPanel:body.includes('\u540c\u4f34\u534f\u4f5c'),
    error:body.slice(-700),browserErrors:errors.slice(0,10)};
  await page.screenshot({path:'../../.tmp-collaboration-desktop.png',fullPage:true});
  if (!result.collaborationTab || !result.collaborationPanel) {
    throw Error(JSON.stringify(result));
  }
  await page.setViewportSize({width:1024,height:768});
  await page.screenshot({path:'../../.tmp-collaboration-narrow.png',fullPage:true});
  console.log(JSON.stringify({...result,desktop:1440,narrow:1024}));
} finally {
  await browser.close();
}
