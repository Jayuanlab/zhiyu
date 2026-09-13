import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import YAML from 'yaml';
import {chromium,expect} from '@playwright/test';
import {configurationManifest} from './configuration-fixture.mjs';

export async function checkManifestExportProduction({client,owner,request,origin,root,recordPrefix='06B13'}) {
  const fixture=configurationManifest(`export-http-${randomUUID()}`);
  fixture.manifest.metadata.title='导出浏览器车间';
  const response=await request('/api/workshops',{manifestYaml:YAML.stringify(fixture.manifest),commandId:randomUUID()});assert.equal(response.status,201);
  const {workshop}=await response.json(),id=workshop.id;
  const exported=await request(`/api/workshops/${id}/manifest`,undefined,'GET');assert.equal(exported.status,200);assert.equal(exported.headers.get('cache-control'),'no-store');
  const baseline=await exported.json();assert.equal(baseline.commandVersion,1);assert.deepEqual(YAML.parse(baseline.manifestYaml).spec.control,fixture.manifest.spec.control);
  const original=await client`SELECT id,context_config,action_policy,verification_config,approval_policy,retry_policy,escalation_policy FROM loops WHERE workshop_id=${id} ORDER BY id`;
  const stranger=randomUUID(),foreign=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${stranger},'foreign-export@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${foreign},${stranger},'foreign','isolated')`;
  assert.equal((await request(`/api/workshops/${foreign}/manifest`,undefined,'GET')).status,404);
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    // The candidate has no real scheduler/listeners. Browser reads of unrelated
    // services are also blocked so this test cannot reach daily trading/WeChat.
    await page.route(/\/api\/(quant|wechat|douyin)\//, route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated test"}'}));
    await page.goto(origin+'/workshop');
    const cookies=page.getByRole('button',{name:'仅必要',exact:true});
    if(await cookies.isVisible())await cookies.click();
    await expect(page.getByText('导出浏览器车间',{exact:true}).first()).toBeVisible({timeout:30000});
    await page.getByRole('button',{name:'修改',exact:true}).first().click();
    const dialog=page.getByRole('dialog'),editor=dialog.getByLabel('Workshop YAML');
    await expect(editor).toBeVisible();
    const draft=YAML.parse(await editor.inputValue());assert.equal(draft.metadata.name,fixture.manifest.metadata.name);
    draft.metadata.title='浏览器只改标题';
    await editor.fill(YAML.stringify(draft));
    await dialog.getByRole('button',{name:'审核 YAML',exact:true}).click();
    await expect(dialog.getByText('审核通过',{exact:true})).toBeVisible({timeout:30000});
    await dialog.getByRole('button',{name:'应用 YAML',exact:true}).click();
    await expect(dialog).not.toBeVisible({timeout:30000});
    assert.equal((await client`SELECT name FROM workshops WHERE id=${id}`)[0].name,'浏览器只改标题');
    assert.deepEqual(await client`SELECT id,context_config,action_policy,verification_config,approval_policy,retry_policy,escalation_policy FROM loops WHERE workshop_id=${id} ORDER BY id`,original);
    await page.getByRole('button',{name:'修改',exact:true}).first().click();
    await expect(editor).toBeVisible();
    const oldDraft=YAML.parse(await editor.inputValue());oldDraft.metadata.title='保留冲突草稿';
    await editor.fill(YAML.stringify(oldDraft));
    const changed=await request(`/api/workshops/${id}`,{name:'后台更新',expectedVersion:2,commandId:randomUUID()},'PATCH');assert.equal(changed.status,200);
    await dialog.getByRole('button',{name:'审核 YAML',exact:true}).click();
    await expect(dialog.getByText('审核通过',{exact:true})).toBeVisible({timeout:30000});
    await dialog.getByRole('button',{name:'应用 YAML',exact:true}).click();
    await expect(dialog.getByRole('alert')).toContainText('当前草稿已保留',{timeout:30000});
    const bounds=await dialog.boundingBox();assert(bounds);assert(bounds.height<=1100*0.85+1);
    await dialog.getByRole('button',{name:'应用 YAML',exact:true}).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button',{name:'应用 YAML',exact:true})).toBeInViewport();
    await dialog.getByRole('alert').scrollIntoViewIfNeeded();
    assert.equal(YAML.parse(await editor.inputValue()).metadata.title,'保留冲突草稿');
    assert.equal((await client`SELECT name FROM workshops WHERE id=${id}`)[0].name,'后台更新');
    await page.screenshot({path:root+`/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-editor-conflict.png`,fullPage:true});
  } finally {await browser.close();}
}
