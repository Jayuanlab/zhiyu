import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkWorkshopRecordEvidenceBrowser({client,owner,origin,root,recordPrefix}) {
  const work=randomUUID(),unknown=randomUUID(),recorded=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'记录证据回测','隔离语义回测')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${unknown},${work},'completed'),(${recorded},${work},'failed')`;
  await client`INSERT INTO workshop_events(workshop_id,run_id,seq,type,title,body,created_at) VALUES
    (${work},${unknown},1,'decision','交易判断','先空仓等待；条件满足后已买入。','2026-09-07T00:00:00Z'),
    (${work},${unknown},2,'work_command_applied','Work command committed','accepted','2026-09-08T00:00:00Z'),
    (${work},${recorded},3,'memory_written','Memory written','已保存本轮记录','2026-09-08T01:00:00Z'),
    (${work},${recorded},4,'tool_error','工具失败','服务返回错误','2026-09-08T02:00:00Z')`;
  const browser=await chromium.launch({headless:true});let page;
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    const dialog=page.getByRole('dialog');
    await page.goto(`${origin}/workshop?workId=${work}&runId=${unknown}`);
    await expect(dialog.getByText('先空仓等待；条件满足后已买入。',{exact:true}).first()).toBeVisible();
    await expect(dialog.getByText('运行记录加载中',{exact:true})).toHaveCount(0);
    await expect(dialog.getByText('处理需求待核实',{exact:true})).toBeVisible();
    await expect(dialog.getByText('当前记录未提供执行动作的证据，不能据此认定没有发生动作。',{exact:true})).toBeVisible();
    await expect(dialog.getByText('本轮记录未提供后续计划；实际调度请查看运行配置。',{exact:true})).toBeVisible();
    await expect(dialog.getByText('本轮记录未提供明确目标。',{exact:true})).toBeVisible();
    await expect(dialog.getByText('未执行买入或卖出动作：本轮结论未触发对应条件。',{exact:true})).toHaveCount(0);
    await expect(dialog.getByText('无需处理',{exact:true})).toHaveCount(0);
    await expect(dialog.getByText('等待下一次运行。',{exact:true})).toHaveCount(0);
    await expect(dialog.getByText('最近记录 09/08 08:00',{exact:true})).toBeVisible();
    await dialog.evaluate(async element=>{await Promise.all(element.getAnimations().map(animation=>animation.finished.catch(()=>{})));});
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-unknown.png`});
    await page.goto(`${origin}/workshop?workId=${work}&runId=${recorded}`);
    await expect(dialog.getByText('已写入长期记忆。',{exact:true})).toBeVisible();
    await expect(dialog.getByText('有异常记录',{exact:true})).toBeVisible();
    await expect(dialog.getByText('记录中存在异常或阻断，请结合当前状态和原始记录核实。',{exact:true})).toBeVisible();
    const [count]=await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work}`;assert.equal(count.n,4);
    return {decisionIsNotExecution:true,keywordsDoNotInventSkippedTrade:true,missingEvidenceStaysUnknown:true,recordTimeIsNotCompletion:true,explicitMemoryActionPreserved:true,recordedFailurePreserved:true,rawEventsUnchanged:true};
  } catch(error) {if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failure.png`}).catch(()=>{});throw error;}
  finally {await browser.close();}
}
