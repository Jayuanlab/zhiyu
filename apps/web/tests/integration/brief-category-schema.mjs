import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function seedBriefCategory(client,owner=randomUUID()){
  await client`INSERT INTO "User" (id,email) VALUES (${owner},${owner+'@example.invalid'}) ON CONFLICT DO NOTHING`;
  const id=randomUUID();
  await client`INSERT INTO "Insight" (id,"botId","taskLabel",title,description,importance,urgency,time)
    VALUES (${id},${randomUUID()},'layout regression','Fixture brief','Isolated evidence','medium','medium',now())`;
  await client`INSERT INTO insight_brief_categories(user_id,insight_id,category,title,source)
    VALUES (${owner},${id},'important','Fixture brief','manual')`;
  return {owner,id};
}

export async function prepareLegacyBriefCategory({client,web}){
  await client.unsafe(fs.readFileSync(path.join(web,'lib/db/migrations/0077_add_insight_brief_categories_table.sql'),'utf8'));
  const fixture=await seedBriefCategory(client);
  fixture.before=(await client`SELECT * FROM insight_brief_categories WHERE insight_id=${fixture.id}`)[0];
  // Model an interrupted/manual repair: the first FK exists, the second does not.
  await client`ALTER TABLE insight_brief_categories DROP CONSTRAINT insight_brief_categories_insight_id_fkey`;
  return fixture;
}

export async function checkBriefCategorySchema({client,web,legacy}){
  const fixture=legacy??await seedBriefCategory(client);
  const {owner,id}=fixture;
  if(legacy)assert.deepEqual((await client`SELECT * FROM insight_brief_categories WHERE insight_id=${id}`)[0],legacy.before);
  const before=await client`SELECT * FROM insight_brief_categories ORDER BY id`;
  // SQL idempotency as well as the runner's journal idempotency.
  await client.unsafe(fs.readFileSync(path.join(web,'lib/db/migrations/0152_restore_brief_category_schema.sql'),'utf8'));
  assert.deepEqual(await client`SELECT * FROM insight_brief_categories ORDER BY id`,before);
  await assert.rejects(client`INSERT INTO insight_brief_categories(user_id,insight_id,category) VALUES (${owner},${id},'monitor')`,e=>e.code==='23505');
  await assert.rejects(client`UPDATE insight_brief_categories SET category='invalid' WHERE insight_id=${id}`,e=>e.code==='23514');
  await assert.rejects(client`UPDATE insight_brief_categories SET source='invalid' WHERE insight_id=${id}`,e=>e.code==='23514');
  await assert.rejects(client`INSERT INTO insight_brief_categories(user_id,insight_id,category) VALUES (${owner},${randomUUID()},'monitor')`,e=>e.code==='23503');
  await assert.rejects(client`INSERT INTO insight_brief_categories(user_id,insight_id,category) VALUES (${randomUUID()},${id},'monitor')`,e=>e.code==='23503');
  await client`UPDATE insight_brief_categories SET source='unpinned' WHERE insight_id=${id}`;
  assert.equal((await client`SELECT source FROM insight_brief_categories WHERE insight_id=${id}`)[0].source,'unpinned');
  await client`DELETE FROM "Insight" WHERE id=${id}`;
  assert.equal((await client`SELECT id FROM insight_brief_categories WHERE insight_id=${id}`).length,0);
  const second=await seedBriefCategory(client);
  await client`DELETE FROM "User" WHERE id=${second.owner}`;
  assert.equal((await client`SELECT id FROM insight_brief_categories WHERE user_id=${second.owner}`).length,0);
  return {name:'brief categories schema compatibility and constraints',passed:true,legacyRowsPreserved:!!legacy,repeatSqlPreservesRows:true,unique:true,categoryAndSourceChecks:true,bothForeignKeys:true,cascades:true,unpinnedAccepted:true};
}

export async function checkBriefCategoryHttp({client,owner,origin}){
  async function request(route,method='GET',body){
    const r=await fetch(origin+route,{method,headers:{'content-type':'application/json',origin},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    assert.equal(r.status,200,`${method} ${route}: ${await r.clone().text()}`);
    return r.json();
  }
  const pinned='/api/insights/brief-categories/pinned';
  const denied=await fetch(origin+'/api/insights/brief-categories/overrides',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({insights:[]})});
  assert.equal(denied.status,403);
  assert.deepEqual((await request(pinned)).data.insights,[]);
  const own=await seedBriefCategory(client,owner),other=await seedBriefCategory(client);
  const entries=(await request(pinned)).data.insights;
  assert.deepEqual(entries.map(item=>item.id),[own.id]);
  const overrides=await request('/api/insights/brief-categories/overrides','POST',{insights:entries});
  assert.equal(overrides.data.overrides[own.id],'important');
  await request('/api/insights/batch/unpin','DELETE',{ids:[own.id]});
  assert.deepEqual((await request(pinned)).data.insights,[]);
  assert.equal((await client`SELECT source FROM insight_brief_categories WHERE insight_id=${own.id}`)[0].source,'unpinned');
  assert.equal((await client`SELECT source FROM insight_brief_categories WHERE insight_id=${other.id}`)[0].source,'manual');
  const after=await request('/api/insights/brief-categories/overrides','POST',{insights:entries});
  assert.ok(after.data.unpinnedIds.includes(own.id));
  return {missingOriginDenied:true,emptyHomepageRead:true,pinnedRead:true,ownCategoryRecordsOnly:true,overrides:true,unpinPersisted:true,otherOwnerUnchanged:true};
}
