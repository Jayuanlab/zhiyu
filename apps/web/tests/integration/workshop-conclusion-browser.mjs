import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkshopConclusionBrowser({client,owner,origin,root,recordPrefix}) {
  const empty=randomUUID(),complete=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${empty},${owner},'仅提交方向','这是使命，不是运行结果'),(${complete},${owner},'有真实结论','隔离概览回测')`;
  await client`INSERT INTO workshop_events(workshop_id,seq,type,title,body,created_at) VALUES
    (${empty},1,'work_command_applied','Work command committed','accepted','2026-09-08T01:00:00Z'),
    (${complete},1,'loop_run_completed','Loop completed','已完成资料核对，发现两项待确认信息。','2026-09-07T01:00:00Z'),
    (${complete},2,'work_command_applied','Work command committed','accepted','2026-09-08T01:00:00Z'),
    (${complete},3,'agent_text','Agent partial output','仍在分析','2026-09-08T02:00:00Z')`;
  const browser=await chromium.launch({headless:true});let page;
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    await page.goto(`${origin}/workshop?workId=${empty}`);
    await expect(page.getByRole('heading',{name:'暂无可展示的运行结论',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Work command committed',exact:true})).toHaveCount(0);
    await expect(page.getByText('当前加载的记录中没有可展示的运行结论。',{exact:false})).toBeVisible();
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-empty.png`});
    await page.locator(`[data-workshop-id="${complete}"]`).click();
    await expect(page.getByRole('heading',{name:'已完成资料核对，发现两项待确认信息',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Work command committed',exact:true})).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading',{name:'已完成资料核对，发现两项待确认信息',exact:true})).toBeVisible();
    const response=await page.request.get(`${origin}/api/workshops/${complete}/summary`);
    assert.equal(response.status(),200);
    const summary=await response.json();
    assert.equal(summary.dashboard.latestConclusion.type,'loop_run_completed');
    assert.equal(new Date(summary.dashboard.latestConclusion.createdAt).toISOString(),'2026-09-07T01:00:00.000Z');
    const [raw]=await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${complete} AND type='work_command_applied'`;
    assert.equal(raw.n,1);
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-complete.png`});
    return {submittedIsNotExecuted:true,missionIsNotResult:true,partialIsNotConclusion:true,reloadKeepsConclusion:true,typedConclusionAndTimestamp:true,rawTechnicalEventPreserved:true};
  } catch(error) {
    if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});
    throw error;
  } finally {await browser.close();}
}
