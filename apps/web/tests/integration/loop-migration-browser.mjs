import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import fs from 'node:fs';

export async function checkLoopMigrationBrowser({client,owner,origin,root,recordPrefix='06E2',legacyConversion=false,responsive=false,legacyReview=false}){
  const artifact=name=>`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-migration-${name}`;
  const loop=randomUUID(),legacy=randomUUID();
  await client`INSERT INTO loops(id,user_id,name,goal,approval_policy) VALUES (${loop},${owner},'迁移浏览器回测任务','保留独立任务的历史','{"externalWrites":"deny"}'::jsonb)`;
  await client`INSERT INTO loops(id,user_id,name,goal,trigger_config) VALUES (${legacy},${owner},'旧任务迁移阻塞回测','观察旧入口','{"type":"scheduled_job"}'::jsonb)`;
  await client`INSERT INTO loop_states(loop_id,current_phase,memory_summary) VALUES (${loop},'idle','原始观测')`;
  const convertible=randomUUID(),job=randomUUID(),legacyExecution=randomUUID();
  if(legacyConversion){
    await client`INSERT INTO scheduled_jobs(id,user_id,name,description,schedule_type,interval_minutes,job_config) VALUES (${job},${owner},'旧任务审核回测','原任务说明','interval',10,'{"type":"custom","handler":"old_handler","modelConfig":{"apiKey":"isolated-private-model-key"}}'::jsonb)`;
    await client`INSERT INTO loops(id,user_id,name,description,goal,trigger_config) VALUES (${convertible},${owner},'旧任务转换浏览器回测','旧摘要','旧目标',jsonb_build_object('type','scheduled_job','scheduledJobId',${job}::text))`;
    assert.equal((await client`SELECT jsonb_typeof(trigger_config) AS kind FROM loops WHERE id=${convertible}`)[0].kind,'object');
    if(legacyReview)await client`INSERT INTO job_executions(id,job_id,status,output,error) VALUES (${legacyExecution},${job},'needs_review','原执行保存的业务输出','超时后结果待核对')`;
  }
  assert.equal((await fetch(origin+'/api/page-state/loops?refresh=1')).status,200);
  const browser=await chromium.launch({headless:true});let page;const submitted=[],diagnostics=[],scriptCaptures=[];
  try{
    page=await browser.newPage({viewport:{width:1440,height:1100}});
    if(responsive){
      page.on('response',response=>{
        if(!new URL(response.url()).pathname.endsWith('/static/chunks/app/layout.js'))return;
        scriptCaptures.push(response.body().then(async body=>{
          const disk=fs.readFileSync(`${root}/apps/web/.tmp/next-review-65/dev/static/chunks/app/layout.js`);
          diagnostics.push({type:'layout-response',url:response.url(),headers:await response.allHeaders(),bytes:body.length,diskBytes:disk.length,exactDisk:body.equals(disk),prefix:disk.subarray(0,body.length).equals(body),sha256:createHash('sha256').update(body).digest('hex')});
        }).catch(error=>diagnostics.push({type:'layout-response-error',message:error.message})));
      });
      const debuggerSession=await page.context().newCDPSession(page);
      debuggerSession.on('Debugger.scriptFailedToParse',event=>{
        scriptCaptures.push(debuggerSession.send('Debugger.getScriptSource',{scriptId:event.scriptId}).then(result=>{
          fs.writeFileSync(artifact(`parse-failed-${event.scriptId}.js`),result.scriptSource);
          diagnostics.push({type:'parse-failed',url:event.url,scriptId:event.scriptId});
        }).catch(error=>diagnostics.push({type:'capture-failed',message:error.message})));
      });
      await debuggerSession.send('Debugger.enable');
    }
    page.on('pageerror',error=>diagnostics.push({type:'pageerror',message:error.message,stack:error.stack}));
    if(responsive)await page.addInitScript(()=>window.addEventListener('error',event=>{
      console.error(JSON.stringify({source:event.filename,line:event.lineno,column:event.colno,message:event.message}));
    }));
    page.on('requestfailed',request=>diagnostics.push({type:'requestfailed',url:request.url(),failure:request.failure()}));
    page.on('console',message=>{if(message.type()==='error')diagnostics.push({type:'console',message:message.text()});});
    if(responsive)page.setDefaultNavigationTimeout(120000);
    await page.route(/\/api\/(quant|wechat|douyin)\//,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated test"}'}));
    await page.goto(origin+'/loops');
    await page.getByRole('button',{name:/迁移浏览器回测任务/}).first().click({timeout:30000});
    const panel=page.getByRole('region',{name:'迁入车间',exact:true});
    if(['06E6','06E10'].includes(recordPrefix)){
      await expect(panel.getByText('独立任务的原生执行与自动调度已停用，请先迁入车间。',{exact:true})).toBeVisible();
      const before=await client`SELECT * FROM loop_states WHERE loop_id=${loop}`;
      const denied=await page.request.post(origin+`/api/loops/${loop}/execute`,{data:{commandId:randomUUID(),dryRun:true}});
      assert.equal(denied.status(),403);assert.equal((await denied.json()).error,'same_origin_required');
      for(const dryRun of [true,false]){
        const response=await page.request.post(origin+`/api/loops/${loop}/execute`,{headers:{Origin:origin,'X-Work-Actor':owner},data:{commandId:randomUUID(),expectedVersion:0,dryRun}});
        assert.equal(response.status(),409);assert.equal((await response.json()).code,'loop_migration_required');
      }
      assert.deepEqual(await client`SELECT * FROM loop_states WHERE loop_id=${loop}`,before);
      assert.equal((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${loop}`)[0].n,0);
    }
    await panel.getByRole('button',{name:'查看迁移预检',exact:true}).click({timeout:30000});
    const commit=panel.getByRole('button',{name:'迁入并保持暂停',exact:true});
    await expect(commit).toBeVisible({timeout:responsive?30000:5000});
    await expect(commit).toBeDisabled();await expect(panel.getByText('外部写入：保持禁止。',{exact:true})).toBeVisible();
    await panel.getByRole('checkbox').check();await expect(commit).toBeEnabled();
    if(responsive){
      for(const width of [390,768,1440]){
        await page.setViewportSize({width,height:900});
        await commit.scrollIntoViewIfNeeded();
        const geometry=await panel.evaluate(element=>({width:element.getBoundingClientRect().width,viewport:innerWidth,bodyWidth:document.documentElement.scrollWidth}));
        assert.ok(geometry.width<=width,JSON.stringify(geometry));assert.ok(geometry.bodyWidth<=width+1,JSON.stringify(geometry));
        await expect(commit).toBeInViewport();
        assert.ok(await commit.evaluate(element=>{const r=element.getBoundingClientRect();return element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Submit must not be covered');
        await page.screenshot({path:artifact(`viewport-${width}.png`)});
      }
      await page.setViewportSize({width:1440,height:1100});
    }
    await client`UPDATE loop_states SET memory_summary='另一执行器已更新的观测' WHERE loop_id=${loop}`;
    await commit.click();await expect(panel.getByRole('alert')).toContainText('配置已变化',{timeout:30000});
    assert.equal((await client`SELECT count(*)::int AS n FROM loop_runtime_migrations WHERE loop_id=${loop}`)[0].n,0);
    await panel.getByRole('button',{name:'重新读取预检',exact:true}).click();
    await expect(panel.getByRole('checkbox')).not.toBeChecked();await expect(commit).toBeDisabled();
    await panel.getByRole('checkbox').check();await expect(commit).toBeEnabled();
    await panel.screenshot({path:artifact('decision.png')});
    let dropped=false;
    await page.route(`**/api/loops/${loop}/migration`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      submitted.push(route.request().postDataJSON());
      if(!dropped){const response=await route.fetch();assert.equal(response.status(),200);dropped=true;await route.abort('failed');}
      else await route.continue();
    });
    await commit.click();await expect(panel.getByRole('button',{name:'核对上次提交',exact:true})).toBeVisible({timeout:30000});
    await expect(panel.getByRole('checkbox')).toBeDisabled();await panel.screenshot({path:artifact('response-lost.png')});
    await page.reload();await page.getByRole('button',{name:/迁移浏览器回测任务/}).first().click({timeout:30000});
    await panel.getByRole('button',{name:'核对上次提交',exact:true}).click({timeout:30000});
    const receiptText='迁移已完成，提交时车间与任务均暂停，原历史已保留。请在车间查看当前状态并审核启用。';
    await expect(panel.getByText(receiptText,{exact:true})).toBeVisible({timeout:30000});
    assert.equal(submitted.length,2);assert.deepEqual(submitted[0],submitted[1]);assert.equal(submitted[0].expectedVersion,0);
    const [state]=await client`SELECT p.status,w.status AS work_status,w.boundary_policy,s.memory_summary FROM loops p JOIN workshops w ON w.id=p.workshop_id JOIN loop_states s ON s.loop_id=p.id WHERE p.id=${loop}`;
    assert.equal(state.status,'paused');assert.equal(state.work_status,'paused');assert.equal(state.boundary_policy.externalMessages,'blocked');assert.equal(state.memory_summary,'另一执行器已更新的观测');
    assert.equal((await client`SELECT count(*)::int AS n FROM loop_runtime_migrations WHERE loop_id=${loop}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${loop}`)[0].n,0);
    await panel.screenshot({path:artifact('recovered.png')});
    await page.getByRole('button',{name:/旧任务迁移阻塞回测/}).first().click();
    await panel.getByRole('button',{name:'查看迁移预检',exact:true}).click({timeout:30000});
    await expect(panel.getByRole('alert')).toContainText('旧定时任务需先转换执行配置');
    await expect(panel.getByRole('button',{name:'迁入并保持暂停',exact:true})).toHaveCount(0);
    await page.setViewportSize({width:390,height:844});await panel.screenshot({path:artifact('blocked-mobile.png')});
    if(legacyConversion){
      await page.setViewportSize({width:1440,height:1100});
      await page.getByRole('button',{name:/旧任务转换浏览器回测/}).first().click();
      await panel.getByRole('button',{name:'查看迁移预检',exact:true}).click({timeout:30000});
      if(legacyReview){
        const review=panel.getByRole('region',{name:'旧执行结果核对',exact:true});
        await expect(review.getByText('核对旧执行结果',{exact:true})).toBeVisible({timeout:30000});
        await expect(commit).toHaveCount(0);
        const save=review.getByRole('button',{name:'保存核对并停用旧任务',exact:true});
        await expect(save).toBeDisabled();
        await review.getByRole('combobox',{name:'核对结论',exact:true}).selectOption('no_effect');
        await review.getByRole('textbox',{name:'核对依据',exact:true}).fill('已停用旧执行器，并核查收件记录，未产生外部动作。');
        await review.getByRole('checkbox').check();await expect(save).toBeEnabled();
        await review.screenshot({path:artifact('legacy-review.png')});
        const writes=[];let lostReview=false;
        await page.route(`**/api/loops/${convertible}/legacy-executions/${legacyExecution}/review`,async route=>{
          if(route.request().method()!=='POST')return route.continue();writes.push(route.request().postDataJSON());
          if(!lostReview){const response=await route.fetch();assert.equal(response.status(),200);lostReview=true;await route.abort('failed');}else await route.continue();
        });
        await save.click();await expect(panel.getByRole('button',{name:'核对上次提交',exact:true})).toBeVisible({timeout:30000});
        await page.reload();await page.getByRole('button',{name:/旧任务转换浏览器回测/}).first().click({timeout:30000});
        await panel.getByRole('button',{name:'核对上次提交',exact:true}).click();
        await expect(panel.getByText('已核对旧执行',{exact:true})).toBeVisible({timeout:30000});
        await expect(panel.getByText('已停用旧执行器，并核查收件记录，未产生外部动作。',{exact:true})).toBeVisible();
        await panel.getByRole('region',{name:'旧执行结果核对',exact:true}).screenshot({path:artifact('legacy-review-recovered.png')});
        assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
        assert.equal((await client`SELECT count(*)::int AS n FROM legacy_execution_reviews WHERE execution_id=${legacyExecution}`)[0].n,1);
        const [original]=await client`SELECT status,output,completed_at FROM job_executions WHERE id=${legacyExecution}`;
        assert.equal(original.status,'needs_review');assert.equal(original.output,'原执行保存的业务输出');assert.equal(original.completed_at,null);
        assert.equal((await client`SELECT enabled FROM scheduled_jobs WHERE id=${job}`)[0].enabled,false);
      }
      const goal=panel.getByRole('textbox',{name:'新任务说明',exact:true}),approval=panel.getByRole('checkbox',{name:/我已审核新任务说明/}),shutdown=panel.getByRole('checkbox',{name:/我已停止此任务/});
      await expect(goal).toHaveValue('原任务说明');await expect(commit).toBeDisabled();
      await goal.fill('审核后的任务说明：每二十分钟读取并整理资料，不执行外部动作。');
      await panel.getByRole('combobox',{name:'新触发方式',exact:true}).selectOption('interval');
      await panel.getByRole('spinbutton',{name:'间隔分钟',exact:true}).fill('20');
      if(responsive){
        await page.setViewportSize({width:390,height:900});
        await panel.getByRole('spinbutton',{name:'间隔分钟',exact:true}).scrollIntoViewIfNeeded();
        assert.ok(await panel.evaluate(element=>element.getBoundingClientRect().right<=innerWidth));
        await page.screenshot({path:artifact('legacy-interval-mobile.png')});
        await page.setViewportSize({width:1440,height:1100});
      }
      await approval.check();await shutdown.check();await expect(commit).toBeEnabled();
      assert.ok(!(await panel.innerText()).includes('isolated-private-model-key'));
      await client`UPDATE scheduled_jobs SET description='另一个窗口更新的旧说明' WHERE id=${job}`;
      await commit.click();await expect(panel.getByRole('alert')).toContainText('配置已变化',{timeout:30000});
      await expect(goal).toHaveValue('审核后的任务说明：每二十分钟读取并整理资料，不执行外部动作。');
      await panel.getByRole('button',{name:'重新读取预检',exact:true}).click();
      await expect(goal).toHaveValue('审核后的任务说明：每二十分钟读取并整理资料，不执行外部动作。');
      await expect(approval).not.toBeChecked();await expect(shutdown).not.toBeChecked();
      await approval.check();await shutdown.check();await panel.screenshot({path:artifact('legacy-decision.png')});
      const legacyWrites=[];let lost=false;
      await page.route(`**/api/loops/${convertible}/migration`,async route=>{
        if(route.request().method()!=='POST')return route.continue();legacyWrites.push(route.request().postDataJSON());
        if(!lost){const response=await route.fetch();assert.equal(response.status(),200);lost=true;await route.abort('failed');}else await route.continue();
      });
      await commit.click();await expect(panel.getByRole('button',{name:'核对上次提交',exact:true})).toBeVisible({timeout:30000});await expect(goal).toBeDisabled();
      await page.reload();await page.getByRole('button',{name:/旧任务转换浏览器回测/}).first().click({timeout:30000});
      await panel.getByRole('button',{name:'核对上次提交',exact:true}).click({timeout:30000});await expect(panel.getByText(receiptText,{exact:true})).toBeVisible({timeout:30000});
      assert.equal(legacyWrites.length,2);assert.deepEqual(legacyWrites[0],legacyWrites[1]);assert.deepEqual(legacyWrites[0].nativeReplacement.triggerConfig,{type:'interval',minutes:20});
      const [converted]=await client`SELECT p.status,p.description,p.goal,p.trigger_config,j.enabled,w.status AS work_status FROM loops p JOIN loop_runtime_migrations m ON m.loop_id=p.id JOIN scheduled_jobs j ON j.id=m.legacy_job_id JOIN workshops w ON w.id=p.workshop_id WHERE p.id=${convertible}`;
      assert.equal(converted.enabled,false);assert.equal(converted.status,'paused');assert.equal(converted.work_status,'paused');assert.equal(converted.description,null);assert.equal(converted.goal,legacyWrites[0].nativeReplacement.goal);
      assert.deepEqual(converted.trigger_config,{type:'interval',minutes:20});
      assert.equal((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${convertible}`)[0].n,0);
      await panel.screenshot({path:artifact('legacy-recovered.png')});
    }
    if(responsive){
      await page.setViewportSize({width:390,height:900});
      await expect(page.getByTestId('btn-accept-cookie')).toBeVisible({timeout:10000});
      await page.evaluate(()=>document.documentElement.style.fontSize='200%');
      const destination=panel.getByRole('link');
      await destination.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));
      await expect(destination).toBeInViewport();
      assert.ok(await panel.evaluate(element=>element.getBoundingClientRect().right<=innerWidth));
      await page.screenshot({path:artifact('text-200-percent.png')});
      const hit=await destination.evaluate(element=>{
        const r=element.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {reachable:element.contains(target),rect:r.toJSON(),target:target?.outerHTML.slice(0,800),viewport:{width:innerWidth,height:innerHeight},cookieHeight:document.documentElement.style.getPropertyValue('--cookie-consent-height')};
      });
      assert.ok(hit.reachable,JSON.stringify(hit));
      await page.evaluate(()=>document.documentElement.style.removeProperty('font-size'));
      const cookie=page.getByTestId('btn-accept-cookie');
      await expect(cookie).toBeVisible();
      await cookie.click();
      await expect(cookie).toHaveCount(0,{timeout:30000});
      await expect.poll(()=>page.evaluate(()=>document.documentElement.style.getPropertyValue('--cookie-consent-height'))).toBe('');
      await page.screenshot({path:artifact('cookie-dismissed.png')});
    }
    return {passed:true,explicitShutdownConfirmation:true,stalePreviewRejected:true,denialPreserved:true,responseLossReloadRecovery:true,exactCommandReplay:true,workAndLoopPaused:true,historyPreserved:true,noExecution:true,legacyBlockerVisible:true,legacyConversionReviewed:legacyConversion};
  }catch(error){if(page){await page.screenshot({path:artifact('failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(artifact('failure.txt'),await page.locator('body').innerText().catch(()=>String(error)),'utf8');}throw error;}
  finally{await Promise.all(scriptCaptures);fs.writeFileSync(artifact('diagnostics.json'),JSON.stringify(diagnostics,null,2));await browser.close();}
}
