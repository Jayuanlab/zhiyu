import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';

export async function checkPaperReviewBrowser({origin,root,recordPrefix}){
  const browser=await chromium.launch({headless:true});
  const checks=[],errors=[];let calls=0,fail=true,decision='pending';const decisions=[];
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    const reviewId='00000000-0000-4000-8000-000000000001';
    await page.route('**/api/quant/paper/migration/reviews',route=>route.fulfill({json:{reviewId}}));
    await page.route('**/api/quant/paper/migration/reviews/*',async route=>{
      if(route.request().method()==='POST'){
        decisions.push(route.request().postDataJSON());decision='approved';
        await route.fulfill({status:503,json:{error:'paper_result_unknown'}});return;
      }
      await route.fulfill({json:{reviewId,reviewHash:'c'.repeat(64),decision,evidence:{review:{sourceHash:'a'.repeat(64),
        evidence:{balances:{cash:'900.00',frozen_cash:'0.00'}},openingProposal:{baseline:{cashAdjustment:'-100.00',realizedPnlAdjustment:'-2.00',
          lots:[{lotId:'fixture',code:'159278.SZ',quantity:100,costPrice:'1.000',tradeDate:'2026-09-08'}]}}}}}});
    });
    await page.route('**/api/page-state/quant*',route=>route.fulfill({json:{dashboard:null,account:{
      id:'fixture',migrationRequired:true,initial_cash:1000,cash:900,frozen_cash:0,total_asset:900,
      total_pnl:-100,total_pnl_pct:-10,market_value:0,realized_pnl:-2,positions:[],open_orders:[],recent_orders:[],recent_fills:[]},
      meta:{dashboard:{pending:false},account:{refreshing:false}}}}));
    await page.route('**/api/quant/paper/migration/review',async route=>{
      calls++;await new Promise(resolve=>setTimeout(resolve,500));
      await route.fulfill({status:fail?503:200,json:fail?{error:'fixture offline'}:{validation:{status:'rejected'},sourceHash:'a'.repeat(64),reviewHash:'b'.repeat(64),
        openingProposal:{status:'needs_owner_review'},evidence:{unexplainedCash:'-100.00',unexplainedRealizedPnl:'-2.00',counts:{orders:0,fills:0,lots:0}}}});
    });
    await page.goto(origin+'/quant',{waitUntil:'domcontentloaded',timeout:120000});
    const panel=page.getByRole('region',{name:'模拟账户迁移核对'});
    await expect(panel).toBeVisible({timeout:60000});
    assert.equal(calls,0);
    const cookie=page.getByTestId('btn-accept-cookie');
    if(await cookie.isVisible())await cookie.click();
    await panel.getByRole('button',{name:'查看迁移差异'}).click();
    await expect(panel.getByRole('status')).toBeVisible();
    await expect(panel.getByRole('alert')).toContainText('暂不可用');
    fail=false;
    await panel.getByRole('button',{name:'重新核对'}).click();
    await expect(panel).toContainText('-100.00 元');
    await expect(panel).toContainText('不代表确认亏损');
    checks.push({name:'lazy load, loading, failure and successful retry',passed:true});
    await panel.getByRole('button',{name:'核实来源并打开审核'}).click();
    await expect(panel.getByRole('button',{name:'确认恢复基线'})).toBeDisabled();
    for(const checkbox of await panel.getByRole('checkbox').all())await checkbox.check();
    await panel.getByRole('button',{name:'确认恢复基线'}).click();
    await expect(panel.getByRole('button',{name:'查询确认结果'})).toBeVisible();
    await panel.getByRole('button',{name:'查询确认结果'}).click();
    await expect(panel).toContainText('恢复基线已确认');
    assert.equal(decisions.length,1);
    assert.equal(decisions[0].decision,'approved');
    assert.ok(decisions[0].commandId);
    checks.push({name:'explicit owner acknowledgements and lost response recovered without resubmission',passed:true});
    fail=true;
    await panel.getByRole('button',{name:'重新核对'}).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel).toContainText('保留上次核对结果');
    await panel.getByText('核对依据',{exact:true}).click();
    for(const width of [1280,390,320]){
      await page.setViewportSize({width,height:900});
      await panel.scrollIntoViewIfNeeded();
      assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-paper-${width}.png`});
      const fingerprint=panel.getByText('报告指纹：',{exact:false});
      await fingerprint.evaluate(el=>el.scrollIntoView({block:'center'}));
      await expect.poll(()=>fingerprint.evaluate(el=>{
        const r=el.getBoundingClientRect();
        const target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return target===el||el.contains(target);
      })).toBe(true);
      checks.push({name:`review panel no horizontal overflow at ${width}px`,passed:true});
    }
    assert.deepEqual(errors,[]);
    return [...checks,{name:'no browser runtime errors',passed:true}];
  }finally{await browser.close();}
}
