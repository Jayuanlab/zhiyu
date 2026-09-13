import assert from 'node:assert/strict';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkbenchLayoutBrowser({origin,root,recordPrefix}){
  const browser=await chromium.launch({headless:true});
  const samples=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultNavigationTimeout(180000);
    await page.goto(origin+'/interaction-reviews');
    await expect(page.getByRole('heading',{name:'消息理解待核对',exact:true})).toBeVisible();
    const card=page.locator('.content-area-card').first();
    const banner=page.getByRole('region').filter({has:page.getByTestId('btn-accept-cookie')});
    await expect(banner).toBeVisible();
    await page.setViewportSize({width:390,height:1000});
    const immediate=await page.locator('[data-sidebar-spacer]').evaluate(element=>({margin:getComputedStyle(element).marginLeft,transition:getComputedStyle(element).transitionProperty}));
    assert.equal(immediate.margin,'0px');assert.equal(immediate.transition,'none');
    for(const route of ['/interaction-reviews','/loops','/workshop','/quant']){
      await page.goto(origin+route);
      await expect(card).toBeVisible();
      for(const width of [390,768,1440]){
        await page.setViewportSize({width,height:1000});
        if(width>=768)await expect.poll(async()=>page.locator('[data-sidebar-spacer]').evaluate(element=>[64,240].includes(parseFloat(getComputedStyle(element).marginLeft)))).toBe(true);
        await expect.poll(async()=>Math.round((await card.boundingBox()).width)).toBeGreaterThan(width===390?360:width-300);
        if(width===390)await expect(page.getByRole('navigation',{name:'移动页面导航'})).toBeVisible();
        else await expect(page.getByRole('navigation',{name:'移动页面导航'})).toBeHidden();
        await expect(banner).toBeVisible();
        await expect.poll(async()=>{
          const frame=await card.boundingBox(),cookie=await banner.boundingBox();
          return Math.round(frame.y+frame.height-cookie.y);
        },{message:`${route} at ${width}px: content must end above cookie banner`}).toBeLessThanOrEqual(1);
        const frame=await card.boundingBox(),cookie=await banner.boundingBox();
        assert.ok(frame.y>=0&&frame.height>100);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page-wide horizontal overflow');
        samples.push({route,width,x:frame.x,y:frame.y,contentWidth:frame.width,contentHeight:frame.height,cookieTop:cookie.y});
      }
    }
    await page.setViewportSize({width:390,height:1000});await page.goto(origin+'/interaction-reviews');
    await expect(banner).toBeVisible();
    const back=page.getByRole('button',{name:'返回主页',exact:true}),link=page.getByRole('link',{name:'返回车间',exact:true});
    await expect(back).toBeVisible();await expect(link).toBeVisible();
    const backBox=await back.boundingBox(),linkBox=await link.boundingBox();assert.ok(backBox.y+backBox.height<=linkBox.y);
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-390.png`});
    await page.evaluate(()=>document.documentElement.style.fontSize='200%');
    await expect.poll(async()=>Math.round((await card.boundingBox()).y+(await card.boundingBox()).height-(await banner.boundingBox()).y)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('button',{name:'仅必要',exact:true})).toBeVisible();
    const refresh=page.getByRole('button',{name:'刷新待核对任务',exact:true});
    await refresh.scrollIntoViewIfNeeded();
    await refresh.click();
    assert.ok(await refresh.evaluate(element=>{const r=element.getBoundingClientRect();return element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'review action remains reachable above fixed regions');
    await expect.poll(async()=>page.evaluate(()=>{
      const banner=document.querySelector('[data-testid="btn-accept-cookie"]').closest('[role="region"]');
      return Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cookie-consent-height'))-banner.getBoundingClientRect().height);
    })).toBeLessThan(1);
    const enlargedReadingHeight=(await card.boundingBox()).height;
    assert.ok(enlargedReadingHeight>300,'enlarged text must retain useful reading space after scrolling');
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-200percent.png`});
    const coveredHeight=(await card.boundingBox()).height;
    await page.getByRole('button',{name:'仅必要',exact:true}).click();await expect(banner).toBeHidden();
    await expect.poll(async()=>(await card.boundingBox()).height).toBeGreaterThan(coveredHeight+100);
    await page.evaluate(()=>document.documentElement.style.fontSize='');
    await back.focus();await page.keyboard.press('Enter');await expect(page).not.toHaveURL(origin+'/interaction-reviews');
    await expect(page).toHaveURL(origin+'/');
    await expect(page.getByRole('navigation',{name:'移动页面导航'})).toBeHidden();
    await page.goto(origin+'/interaction-reviews');await link.click();await expect(page).toHaveURL(origin+'/workshop');
    return {samples,immediateMobileOffset:immediate,navigationDoesNotCoverContent:true,cookieSpaceReserved:true,text200Percent:true,enlargedReadingHeight,enlargedReviewActionReachable:true,cookieDismissRestoresSpace:true,keyboardHomeNavigation:true,workshopLink:true};
  }finally{await browser.close();}
}
