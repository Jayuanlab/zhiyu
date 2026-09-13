import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});

export async function checkRuntimeStatusBrowser({client,owner,origin,root,recordPrefix}){
  const instance=randomUUID();
  const modules=[{name:'paper-matching',phase:'error',inFlight:false,lastStartedAt:Date.now(),lastCompletedAt:Date.now(),lastSuccessAt:null,nextRunAt:Date.now()+10000,lastError:'paper_migration_required',durationMs:1,skipReason:null,skipped:0}];
  await client`INSERT INTO runtime_instances(id,owner_id,mode,phase,desired_status,last_heartbeat_at,modules) VALUES (${instance},${owner},'worker','running','paused',clock_timestamp(),${JSON.stringify(modules)}::jsonb)`;
  await client`INSERT INTO runtime_owner_leases(owner_id,instance_id,token,lease_until) VALUES (${owner},${instance},1,clock_timestamp()+interval '20 minutes')`;
  const browser=await chromium.launch({headless:true});
  const failures=[];let page;
  try{
    page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(180000);
    page.on('pageerror',error=>failures.push(error.message));
    await page.goto(origin+'/loops');
    const panel=page.getByRole('region',{name:'后台运行状态',exact:true});
    await expect(panel.getByText('后台在线 · 已暂停新调度',{exact:true})).toBeVisible();
    await panel.locator('summary').click();
    await expect(panel.getByText('模拟账户尚未完成迁移或配置，撮合未启动')).toBeVisible();
    for(const width of [390,768,1440]){
      await page.setViewportSize({width,height:1000});
      assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-${width}.png`});
    }
    await page.route('**/api/runtime/bootstrap',route=>route.fulfill({status:503,body:'{}',contentType:'application/json'}));
    await panel.getByRole('button',{name:'刷新后台状态'}).click();
    await expect(panel.getByText('后台状态待确认',{exact:true})).toBeVisible();
    await expect(panel.getByText('查看 1 个模块的上次状态（非实时）',{exact:true})).toBeVisible();
    await page.unroute('**/api/runtime/bootstrap');
    await client`UPDATE runtime_owner_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE owner_id=${owner}`;
    await panel.getByRole('button',{name:'刷新后台状态'}).click();
    await expect(panel.getByText('后台离线',{exact:true})).toBeVisible();
    const other=await browser.newPage();other.setDefaultNavigationTimeout(180000);
    await other.goto(origin+'/workshop');
    await expect(other.getByRole('region',{name:'后台运行状态',exact:true}).getByText('后台离线',{exact:true})).toBeVisible({timeout:60000});
    await page.reload();await expect(panel.getByText('后台离线',{exact:true})).toBeVisible();
    await other.close();
    const response=await page.request.get(origin+'/api/runtime/bootstrap?cloudAuthToken=ignored-test-token');
    assert.equal((await response.json()).startupRequested,false);
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${owner}`)[0].n,1);
    assert.equal((await client`SELECT token FROM runtime_owner_leases WHERE owner_id=${owner}`)[0].token,1);
    assert.deepEqual(failures,[]);
    return {paused:true,moduleFailure:true,refreshFailureUnknown:true,expired:true,twoPages:true,instanceCount:1,responsive:[390,768,1440],pageErrors:failures,fixture:'seeded durable host status; scheduler disabled; no real worker launched'};
  }catch(error){
    if(page)await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failed.png`}).catch(()=>{});
    throw error;
  }finally{await browser.close();}
}
