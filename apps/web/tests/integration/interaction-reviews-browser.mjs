import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkInteractionReviewsBrowser({client,owner,origin,root,recordPrefix,databaseUrl}){
  const jobId=randomUUID();
  await client`INSERT INTO interaction_processing_jobs(id,user_id,status,attempts,last_error) VALUES (${jobId},${owner},'needs_review',1,'interaction_host_lost_result_unknown')`;
  const eventId=randomUUID();
  await client`INSERT INTO interaction_events(id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${eventId},${owner},'wechat','isolated','核对来源会话','原始消息：明天确认交付清单',clock_timestamp(),${eventId})`;
  await client`UPDATE interaction_processing_jobs SET event_ids=${JSON.stringify([eventId])}::jsonb WHERE id=${jobId}`;
  await client`INSERT INTO interaction_notes(user_id,note_type,title,body,metadata) VALUES (${owner},'summary','隔离核对笔记','已写入的部分结果',${JSON.stringify({processingJobId:jobId,processingAttempt:1})}::jsonb)`;
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultNavigationTimeout(180000);
    await page.goto(origin+'/interaction-reviews');
    await page.getByRole('button',{name:/后台中断，结果待确认/}).click({timeout:60000});
    const panel=page.getByRole('region',{name:'理解任务核对详情'});
    await expect(panel.getByText('笔记 · 隔离核对笔记',{exact:true})).toBeVisible();
    await expect(panel.getByText('已写入的部分结果',{exact:true})).toBeVisible();
    await expect(panel.getByText('原始消息：明天确认交付清单',{exact:true})).toBeVisible();
    await expect(panel.getByText(/没有记录不代表从未写入/)).toBeVisible();
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-review.png`});
    const before=(await client`SELECT status,attempts FROM interaction_processing_jobs WHERE id=${jobId}`)[0];
    await page.getByRole('button',{name:'刷新待核对任务'}).click();
    assert.deepEqual((await client`SELECT status,attempts FROM interaction_processing_jobs WHERE id=${jobId}`)[0],before);
    await page.route('**/api/interactions/processing-reviews',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
    await page.getByRole('button',{name:'刷新待核对任务'}).click();
    await expect(page.getByText('读取失败，请刷新重试。当前任务状态尚未确认。',{exact:true})).toBeVisible();
    await page.unroute('**/api/interactions/processing-reviews');
    await page.getByRole('button',{name:'刷新待核对任务'}).click();
    const close=panel.getByRole('button',{name:'保留结果并结束处理',exact:true});await expect(close).toBeDisabled();
    await panel.getByRole('checkbox').check();await expect(close).toBeEnabled();
    const submissions=[];
    await page.route('**/api/interactions/processing-reviews',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      submissions.push(route.request().postDataJSON());
      if(submissions.length===1){const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}
      return route.continue();
    });
    await close.click();await expect(page.getByText(/提交结果尚未确认，原提交凭据已保留/)).toBeVisible();
    assert.equal((await client`SELECT status FROM interaction_processing_jobs WHERE id=${jobId}`)[0].status,'review_closed');
    await page.reload();
    await expect(page.getByRole('button',{name:'核对提交结果',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'核对提交结果',exact:true}).click();
    await expect(page.getByText('已保留现有结果并结束本次处理。未重跑、删除或确认生成内容正确。',{exact:true})).toBeVisible();
    assert.equal(submissions.length,2);assert.equal(submissions[0].commandId,submissions[1].commandId);
    assert.equal((await client`SELECT count(*)::int AS n FROM interaction_review_decisions WHERE job_id=${jobId}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM interaction_notes WHERE user_id=${owner}`)[0].n,1);
    await page.getByRole('button',{name:'查看已处置记录',exact:true}).click();
    await expect(page.getByRole('button',{name:/已保留结果并结束处理/})).toBeVisible();
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-decision.png`});
    await page.unroute('**/api/interactions/processing-reviews');
    const fixture=async mode=>{
      const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--conditions=react-server','tests/integration/interaction-resume-fixture.mjs',mode,owner,eventId],{
        cwd:`${root}/apps/web`,windowsHide:true,timeout:30000,env:{...process.env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,TAURI_MODE:'false',IS_TAURI:'false'}});
      return JSON.parse(stdout.split(/\r?\n/).find(line=>line.startsWith('{"event":"resume_fixture"')));
    };
    const saved=await fixture('seed');
    await page.getByRole('button',{name:'查看待核对',exact:true}).click();await page.getByRole('button',{name:'刷新待核对任务',exact:true}).click();
    await page.getByRole('button').filter({hasText:saved.jobId}).click();
    await panel.getByText('查看保存的理解计划',{exact:true}).click();
    await expect(panel.getByText('计划笔记 · 恢复计划笔记',{exact:true})).toBeVisible();
    const resume=panel.getByRole('button',{name:'按原计划恢复',exact:true});await expect(resume).toBeDisabled();await panel.getByRole('checkbox').check();
    const resumeSubmissions=[];
    await page.route('**/api/interactions/processing-reviews',async route=>{
      if(route.request().method()!=='POST')return route.continue();resumeSubmissions.push(route.request().postDataJSON());
      if(resumeSubmissions.length===1){const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}
      return route.continue();
    });
    await resume.click();await expect(page.getByText(/提交结果尚未确认，原提交凭据已保留/)).toBeVisible();await page.reload();
    await page.getByRole('button',{name:'核对提交结果',exact:true}).click();
    await expect(page.getByText(/已提交按原计划恢复，等待后台领取/)).toBeVisible();
    assert.equal(resumeSubmissions.length,2);assert.equal(resumeSubmissions[0].commandId,resumeSubmissions[1].commandId);
    assert.equal((await client`SELECT status FROM interaction_processing_jobs WHERE id=${saved.jobId}`)[0].status,'resume_pending');
    assert.equal((await fixture('drain')).result.completed,1);
    await expect(panel.getByRole('status')).toContainText('原计划处理已完成');
    await expect(page.getByText('原计划处理已完成，结果已保存。',{exact:true})).toBeVisible();
    await expect(panel.getByText('笔记 · 恢复计划笔记',{exact:true})).toBeVisible();
    assert.equal((await client`SELECT count(*)::int n FROM interaction_review_decisions WHERE job_id=${saved.jobId}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int n FROM interaction_notes WHERE metadata->>'processingJobId'=${saved.jobId}`)[0].n,1);
    for(const width of [390,1440]){await page.setViewportSize({width,height:1000});await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-resume-${width}.png`});}
    const summary=await fixture('seed-summary');await page.getByRole('button',{name:'刷新待核对任务',exact:true}).click();
    await page.getByRole('button').filter({hasText:summary.jobId}).click();await panel.getByText('查看保存的理解计划',{exact:true}).click();
    await expect(panel.getByText('基于原始消息生成摘要，不创建待办或记忆。',{exact:true})).toBeVisible();
    await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'按原计划恢复',exact:true}).click();
    await expect(page.getByText(/已提交按原计划恢复，等待后台领取/)).toBeVisible();
    const summaryDrained=await fixture('drain');assert.equal(summaryDrained.result.completed,1);assert.equal(summaryDrained.result.degraded,1);
    await expect(panel.getByRole('status')).toContainText('原计划处理已完成');
    assert.equal((await client`SELECT count(*)::int n FROM interaction_notes WHERE metadata->>'processingJobId'=${summary.jobId}`)[0].n,1);
    return {originalEventVisible:true,linkedResultVisible:true,evidenceWarning:true,readOnlyObservation:true,refreshFailureVisible:true,ownerDecision:true,lostResponseReloadReplay:true,decisionCount:1,retainedResults:true,
      savedPlanVisible:true,resumeLostResponseReplay:true,realWorkerDrainWithoutModel:true,resumeCompletedVisible:true,resumeDecisionCount:1,resumeNoteCount:1,summaryPlanResume:true,completedNoticeReplacesQueued:true};
  }finally{await browser.close();}
}
