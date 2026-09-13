import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import YAML from 'yaml';
import {chromium,expect} from '@playwright/test';
import {configurationManifest} from './configuration-fixture.mjs';

export async function checkClientCommandProduction({client,owner,request,origin,root,recordPrefix='06B14'}) {
  const fixture=configurationManifest(`client-command-${randomUUID()}`);
  fixture.manifest.metadata.title='恢复浏览器车间';
  const created=await request('/api/workshops',{manifestYaml:YAML.stringify(fixture.manifest),commandId:randomUUID()});assert.equal(created.status,201);
  const {workshop}=await created.json(),id=workshop.id;
  const list=await request('/api/page-state/workshop?refresh=1',undefined,'GET');assert.equal(list.status,200);assert((await list.json()).workshops.some(item=>item.id===id));
  for(const [url,method,body] of [['/api/workshops','POST',{name:'must not create',mission:'test'}],[`/api/workshops/${id}`,'PATCH',{name:'must not update'}],[`/api/workshops/${id}`,'DELETE',{}]]){
    const denied=await fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Work-Actor':randomUUID()},body:JSON.stringify(body)});
    assert.equal(denied.status,409);assert.equal((await denied.json()).error,'actor_changed');
  }
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    await page.route(/\/api\/(quant|wechat|douyin)\//,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated test"}'}));
    await page.goto(origin+'/workshop');
    await expect(page.getByText('恢复浏览器车间',{exact:true}).first()).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'修改',exact:true}).first().click();
    const dialog=page.getByRole('dialog'),editor=dialog.getByLabel('Workshop YAML');
    await expect(editor).toBeVisible();
    const draft=YAML.parse(await editor.inputValue());draft.metadata.title='响应丢失但已提交';
    await editor.fill(YAML.stringify(draft));await dialog.getByRole('button',{name:'审核 YAML',exact:true}).click();await expect(dialog.getByText('审核通过',{exact:true})).toBeVisible({timeout:30000});
    let sent,drop=true;
    const attempts=[];
    await page.route(origin+`/api/workshops/${id}`,async route=>{
      const body=route.request().postDataJSON();
      if(route.request().method()==='PATCH' && body?.apply===true){
        attempts.push(body);
        if(drop){drop=false;sent=body;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');return;}
      }
      await route.continue();
    });
    await dialog.getByRole('button',{name:'应用 YAML',exact:true}).click();
    await expect(dialog.getByRole('alert')).toContainText('提交结果尚未确认',{timeout:30000});
    assert.equal((await client`SELECT name FROM workshops WHERE id=${id}`)[0].name,'响应丢失但已提交');
    const edited=YAML.parse(await editor.inputValue());edited.metadata.title='新的未提交草稿';await editor.fill(YAML.stringify(edited));
    await dialog.getByRole('button',{name:'审核 YAML',exact:true}).click();await expect(dialog.getByText('审核通过',{exact:true})).toBeVisible({timeout:30000});
    await dialog.getByRole('button',{name:'应用 YAML',exact:true}).click();
    await expect(dialog.getByRole('alert')).toContainText('上次提交尚未确认');assert.equal(attempts.length,1);
    await page.reload();
    await expect(page.getByRole('button',{name:'核对上次提交',exact:true})).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'核对上次提交',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'上次提交已核对'})).toBeVisible({timeout:30000});
    assert.equal(attempts.length,2);assert.deepEqual(attempts[1],sent);
    assert.equal((await client`SELECT count(*)::int AS n FROM work_commands WHERE owner_id=${owner} AND command_id=${sent.commandId}`)[0].n,1);
    assert.equal((await client`SELECT version FROM work_command_targets WHERE workshop_id=${id}`)[0].version,2);
    await page.getByRole('button',{name:'工作详情',exact:true}).click();
    await page.getByRole('tab',{name:'运行配置',exact:true}).click();
    const interval=page.locator('#workshop-heartbeat-min-interval');await expect(interval).toBeVisible();const originalInterval=await interval.inputValue();await interval.fill('17');
    let observedVersion=0;
    page.on('response',async response=>{if(response.url().includes(`/api/page-state/workshop/${id}/summary`)){try {observedVersion=(await response.json()).commandVersion;}catch{}}});
    const update=await request(`/api/workshops/${id}`,{name:'后台刷新设置',commandId:randomUUID(),expectedVersion:2},'PATCH');assert.equal(update.status,200);
    await expect.poll(()=>observedVersion,{timeout:30000}).toBe(3);
    await expect(interval).toHaveValue('17');
    const failed=page.waitForResponse(response=>response.url()===origin+`/api/workshops/${id}` && response.request().method()==='PATCH');
    await page.getByRole('button',{name:'保存心跳',exact:true}).click();assert.equal((await failed).status(),409);
    await expect(interval).toHaveValue('17');
    await page.getByRole('button',{name:'放弃设置草稿并载入最新配置',exact:true}).click();
    await expect(interval).toHaveValue(originalInterval);
    await expect(page.getByRole('status').filter({hasText:'上次提交已核对'})).not.toBeVisible();
    await expect(page.getByText('配置已变化。当前草稿已保留，请核对最新配置后重新提交。',{exact:true})).not.toBeVisible();
    await page.screenshot({path:root+`/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-command-recovery.png`,fullPage:true});
  } finally {await browser.close();}
}
