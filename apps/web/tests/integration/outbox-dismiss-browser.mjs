import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';

export async function checkOutboxDismissBrowser({client,owner,origin,root,recordPrefix}){
  const work=randomUUID(),first=randomUUID(),second=randomUUID(),review=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'Dismiss regression','Isolated regression')`;
  for(const id of [first,second])await client`INSERT INTO workshop_outbox(id,workshop_id,status,message,boundary_result,created_at) VALUES (${id},${work},'blocked','Retained message','{"violations":["original boundary"]}'::jsonb,'2020-01-01')`;
  await client`INSERT INTO workshop_outbox(workshop_id,status,message) SELECT ${work},'sent','History' FROM generate_series(1,55)`;
  await client`INSERT INTO workshop_review_items(id,workshop_id,kind,title,metadata) VALUES (${review},${work},'permission_boundary','Old boundary',${JSON.stringify({outboxId:first})}::jsonb)`;
  const row=async id=>(await client`SELECT * FROM workshop_outbox WHERE id=${id}`)[0];
  const post=(id,stamp,workId=work)=>fetch(`${origin}/api/workshops/${workId}/outbox/${id}/dismiss`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({expectedUpdatedAt:stamp})});
  const dashboard=async()=> (await (await fetch(`${origin}/api/page-state/workshop/${work}/summary?refresh=1`)).json()).dashboard;
  const attempted=randomUUID();
  await client`INSERT INTO workshop_outbox(id,workshop_id,status,message) VALUES (${attempted},${work},'blocked','Attempted')`;
  await client`INSERT INTO workshop_outbox_attempts(id,outbox_id,workshop_id,owner_id,command_id,content_hash,policy_hash,payload,status) VALUES (${randomUUID()},${attempted},${work},${owner},${randomUUID()},'hash','hash','{}','failed')`;
  assert.equal((await post(attempted,(await row(attempted)).updated_at)).status,409);
  await client`DELETE FROM workshop_outbox_attempts WHERE outbox_id=${attempted}`;
  await client`DELETE FROM workshop_outbox WHERE id=${attempted}`;
  assert.equal((await post(first,'2000-01-01')).status,409);
  assert.equal((await post(first,(await row(first)).updated_at,randomUUID())).status,404);
  for(const status of ['sending','unknown','sent','failed']){
    const id=randomUUID();await client`INSERT INTO workshop_outbox(id,workshop_id,status,message) VALUES (${id},${work},${status},'Terminal')`;
    assert.equal((await post(id,(await row(id)).updated_at)).status,409);
    await client`DELETE FROM workshop_outbox WHERE id=${id}`;
  }
  await fetch(origin+'/api/page-state/workshop?refresh=1');
  assert.equal((await dashboard()).counts.outboxBlocked,2);
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1200}});let sendCalls=0;
  try{
    await page.route(/\/api\/(quant|wechat|douyin)\//,r=>r.fulfill({status:503,body:'{}'}));
    await page.route(/\/outbox\/[^/]+\/send$/,r=>{sendCalls++;return r.abort();});
    await page.route(/\/events\/stream\?/,r=>r.abort());
    await page.goto(origin+`/workshop?workId=${work}&tab=outbox`);
    const card=id=>page.locator(`[data-outbox-id="${id}"]`);
    await expect(card(first).getByRole('button',{name:'不再发送',exact:true})).toBeVisible({timeout:30000});
    await expect(card(second).getByRole('button',{name:'不再发送',exact:true})).toBeVisible();
    const stamp=(await row(first)).updated_at;
    await card(first).getByRole('button',{name:'不再发送',exact:true}).click();
    await expect.poll(async()=>(await row(first)).status).toBe('rejected');
    await expect(card(first).getByRole('button',{name:'不再发送',exact:true})).toHaveCount(0);
    assert.equal((await dashboard()).counts.outboxBlocked,1);
    const retries=await Promise.all([post(first,stamp),post(first,stamp)]);assert.deepEqual(retries.map(x=>x.status),[200,200]);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='outbox_dismissed'`)[0].n,1);
    assert.equal((await client`SELECT status FROM workshop_review_items WHERE id=${review}`)[0].status,'superseded');
    assert.equal((await row(first)).message,'Retained message');
    assert.deepEqual((await row(first)).boundary_result.violations,['original boundary']);
    assert.equal((await row(first)).boundary_result.ownerDismissal.actorId,owner);
    await card(second).getByRole('button',{name:'不再发送',exact:true}).click();
    await expect.poll(async()=>(await row(second)).status).toBe('rejected');
    await expect.poll(async()=>(await dashboard()).counts.outboxBlocked).toBe(0);
    assert.equal((await dashboard()).status,'active');
    await page.reload();
    await expect(page.getByRole('button',{name:/Dismiss regression/}).first()).toBeVisible({timeout:30000});
    await expect(page.getByText('待发草稿加载中',{exact:true})).toHaveCount(0,{timeout:30000});
    await expect(page.getByRole('button',{name:'不再发送',exact:true})).toHaveCount(0);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${work} AND status='blocked'`)[0].n,0);
    assert.equal(sendCalls,0);
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-page.png`,fullPage:true});
    return {passed:true,oldBlockedVisibleBeyond50:true,browserDismissals:2,idempotentRetries:true,evidenceRetained:true,reviewClosed:true,staleAndForeignRejected:true,terminalStatesProtected:true,externalSendCalls:sendCalls};
  }finally{await browser.close();}
}
