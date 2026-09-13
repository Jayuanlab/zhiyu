import assert from 'node:assert/strict';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
export async function checkRuntimeLiveBrowser({client,owner,origin,root,recordPrefix,child}){
  const browser=await chromium.launch({headless:true});
  const status=async()=> (await client`SELECT i.*,l.token FROM runtime_instances i JOIN runtime_owner_leases l ON l.instance_id=i.id WHERE i.owner_id=${owner}`)[0];
  let page;
  try{
    const initial=await status();assert.equal(initial.phase,'running');assert.equal(initial.mode,'worker');
    const legacy=await fetch(origin+'/api/scheduled-jobs/internal/scheduler?cloudAuthToken=ignored-fixture-token');
    assert.equal(legacy.status,200);assert.equal((await legacy.json()).startupRequested,false);
    const retired=await fetch(origin+'/api/scheduled-jobs/internal/scheduler',{method:'POST',headers:{Origin:origin}});
    assert.equal(retired.status,410);
    page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultNavigationTimeout(180000);
    await page.goto(origin+'/workshop');
    const panel=page.getByRole('region',{name:'后台运行状态',exact:true});
    await expect(panel.getByText('后台在线',{exact:true})).toBeVisible();
    child.send('pause');
    await expect.poll(async()=>(await status()).desired_status).toBe('paused');
    await panel.getByRole('button',{name:'刷新后台状态'}).click();
    await expect(panel.getByText('后台在线 · 已暂停新调度',{exact:true})).toBeVisible();
    await panel.locator('summary').click();
    await expect(panel.getByText('模拟账户尚未完成迁移或配置，撮合未启动')).toBeVisible();
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-workshop.png`});
    const other=await browser.newPage();other.setDefaultNavigationTimeout(180000);await other.goto(origin+'/loops');
    await expect(other.getByRole('region',{name:'后台运行状态'}).getByText('后台在线 · 已暂停新调度',{exact:true})).toBeVisible();
    await page.reload();await expect(panel.getByText('后台在线 · 已暂停新调度',{exact:true})).toBeVisible();await other.close();
    const after=await status();assert.equal(after.id,initial.id);assert.equal(after.token,initial.token);
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${owner}`)[0].n,1);
    assert.ok(new Date(after.last_heartbeat_at)>new Date(initial.last_heartbeat_at));
    child.send('resume');await expect.poll(async()=>(await status()).desired_status).toBe('running');
    await browser.close();child.send('stop');
    await expect.poll(async()=>(await status()).phase).toBe('stopped');
    await expect.poll(()=>child.exitCode).toBe(0);
    return {realWorker:true,realNext:true,twoPages:true,pauseResume:true,instanceCount:1,heartbeatAdvances:true,confirmedShutdown:true,legacyReadOnly:true,legacyControlRetired:true};
  }catch(error){if(page&&!page.isClosed())await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-failed.png`}).catch(()=>{});throw error;}
  finally{await browser.close();}
}
