import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium, expect as baseExpect} from '@playwright/test';
import {checkWorkshopReviewLocationBrowser} from './workshop-review-location-browser.mjs';
const expect=baseExpect.configure({timeout:60000});

export async function checkReviewCommandsBrowser(args) {
  const {client,owner,origin,root,recordPrefix}=args;
  const work=randomUUID(),foreign=randomUUID(),other=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${other},'review-command-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'审核事务回测','隔离数据'),(${foreign},${other},'私有审核','隔离数据')`;
  const version=async()=>Number((await client`SELECT version FROM work_command_targets WHERE workshop_id=${work}`)[0]?.version??0);
  const send=async(body,target=work)=>{
    const response=await fetch(`${origin}/api/workshops/${target}/review-items`,{method:'PATCH',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const command=async body=>({commandId:randomUUID(),expectedVersion:await version(),...body});
  const item=async(kind,metadata={})=>{
    const id=randomUUID();
    await client`INSERT INTO workshop_review_items(id,workshop_id,kind,title,metadata) VALUES (${id},${work},${kind},'隔离审核项目',${JSON.stringify(metadata)})`;
    return id;
  };
  assert.equal((await send({itemId:randomUUID(),status:'dismissed'})).status,400);
  assert.equal((await send(await command({status:'dismissed',itemId:randomUUID()}),foreign)).status,404);
  const action='Review evidence';
  const metadata={issueKind:'no_evidence_selected',recommendedActions:[action],governanceActionDetails:[{label:action}],evidenceHints:['isolated source']};
  const first=await item('memory_recall_quality',metadata),second=await item('memory_recall_quality',metadata);
  const batch=await command({action:'confirm_memory_recall_governance_batch',itemId:first,limit:5});
  // Fail after the confirmation event but before proposal/state completion.
  await client.unsafe(`CREATE FUNCTION review_command_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='memory_recall_governance_proposed' AND (SELECT count(*) FROM workshop_events WHERE workshop_id=NEW.workshop_id AND type='memory_recall_governance_proposed') > 0 THEN RAISE EXCEPTION 'isolated review transaction fault'; END IF; RETURN NEW; END $$`);
  await client`CREATE TRIGGER review_command_fault BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION review_command_fault()`;
  assert.equal((await send(batch)).status,500);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='memory_recall_governance_action_confirmed'`)[0].n,0);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE id IN (${first},${second}) AND status='pending'`)[0].n,2);
  assert.equal((await client`SELECT status FROM work_commands WHERE command_id=${batch.commandId}`)[0].status,'queued');
  assert.equal(await version(),0);
  await client`DROP TRIGGER review_command_fault ON workshop_events`;
  await client`DROP FUNCTION review_command_fault()`;
  const [done,replay]=await Promise.all([send(batch),send(batch)]);
  assert.equal(done.status,200);assert.deepEqual(replay,done);assert.equal(done.body.count,2);assert.equal(await version(),1);
  assert.equal((await send({...batch,limit:1})).status,409);
  assert.equal((await send({...batch,commandId:randomUUID()})).status,409);
  const proposals=await client`SELECT id FROM workshop_review_items WHERE workshop_id=${work} AND kind='memory_recall_governance_proposal'`;
  assert.equal(proposals.length,2);
  const approve=await command({action:'resolve_memory_recall_governance_proposal',itemId:proposals[0].id,resolution:'approved'});
  const approved=await send(approve);assert.equal(approved.status,200);assert.deepEqual(await send(approve),approved);
  const [plan]=await client`SELECT id FROM workshop_review_items WHERE workshop_id=${work} AND kind='memory_recall_change_plan'`;
  const apply=await command({action:'resolve_memory_recall_change_plan',itemId:plan.id,resolution:'approved'});
  const applied=await send(apply);assert.equal(applied.status,200);assert.deepEqual(await send(apply),applied);
  assert.equal(applied.body.executionPlan.metadata.appliedMemoryMutation,false);
  assert.equal(applied.body.rollbackAudit.metadata.rollbackRequired,false);
  assert.equal((await send(await command({action:'resolve_memory_recall_governance_proposal',itemId:proposals[1].id,resolution:'rejected'}))).status,200);
  const single=await item('memory_recall_quality',metadata);
  assert.equal((await send(await command({action:'confirm_memory_recall_governance',itemId:single,governanceAction:'unapproved action'}))).status,400);
  assert.equal((await send(await command({action:'confirm_memory_recall_governance',itemId:single,governanceAction:action}))).status,200);
  const g1=await item('service_error',{serviceKey:'isolated-service'}),g2=await item('service_error',{serviceKey:'isolated-service'});
  const group=await command({action:'dismiss_group',itemId:g1});
  const dismissed=await send(group);assert.equal(dismissed.status,200);assert.equal(dismissed.body.items.length,2);assert.deepEqual(await send(group),dismissed);
  assert.equal((await send(await command({itemId:g2,status:'approved'}))).status,409);
  const audit=await client`SELECT metadata FROM workshop_events WHERE workshop_id=${work} AND type LIKE 'memory_recall_%'`;
  assert(audit.length>5);assert(audit.every(row=>row.metadata.commandId&&row.metadata.actorId===owner));

  // Existing desktop deep-link flow includes an item outside the 200-row list.
  await checkWorkshopReviewLocationBrowser(args);
  const asset=await fetch(`${origin}/_next/static/chunks/app/(chat)/layout.js`,{method:'HEAD'});
  assert.equal(asset.status,200);assert.match(asset.headers.get('cache-control')??'',/no-store/);

  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    const page=await context.newPage();page.setDefaultNavigationTimeout(180000);
    const target=await item('service_error');
    await page.goto(`${origin}/workshop?workId=${work}&reviewId=${target}`);
    const card=page.locator(`[data-review-item-id="${target}"]`);
    await expect(card).toBeVisible();
    let sent=null;
    await page.route(`**/api/workshops/${work}/review-items`,async route=>{
      if(route.request().method()!=='PATCH'||sent)return route.continue();
      sent=route.request().postDataJSON();
      const response=await route.fetch();assert.equal(response.status(),200);
      await route.abort('failed');
    });
    await card.getByRole('button',{name:'暂不处理',exact:true}).click();
    await expect(page.getByRole('button',{name:'核对上次提交'}).first()).toBeVisible();
    await page.reload();
    await page.getByRole('button',{name:'核对上次提交'}).first().click();
    await expect(page.getByRole('status').filter({hasText:'上次提交已核对'})).toBeVisible();
    await expect(page.getByRole('region',{name:'定位审核记录'}).getByText('审核状态：已暂不处理',{exact:true})).toBeVisible();
    assert(sent.commandId);assert(Number.isInteger(sent.expectedVersion));
    assert.equal((await client`SELECT count(*)::int AS n FROM work_commands WHERE owner_id=${owner} AND command_id=${sent.commandId} AND status='succeeded'`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='work_command_applied' AND metadata->>'commandId'=${sent.commandId}`)[0].n,1);
    await page.screenshot({path:`${root}/docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-desktop-recovered.png`});
  } finally {await browser.close();}
  return {name:'review commands: real transaction rollback, concurrent replay, payload/version conflict, owner boundary, governance dry-run, group dismissal, desktop deep-link and lost response recovery',passed:true};
}
