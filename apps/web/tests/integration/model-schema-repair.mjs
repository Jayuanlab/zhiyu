import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

async function seedAttachments(client,owner){
  const insight=randomUUID(),document=randomUUID();
  await client`INSERT INTO "Insight"(id,"botId","taskLabel",title,description,importance,urgency,time)
    VALUES (${insight},${randomUUID()},'schema','Preserved insight','fixture','medium','medium',now())`;
  await client`INSERT INTO rag_documents(id,user_id,file_name,content_type,size_bytes) VALUES (${document},${owner},'fixture.txt','text/plain',10)`;
  await client`INSERT INTO insight_notes(insight_id,user_id,content,source) VALUES (${insight},${owner},'Preserve original note','manual')`;
  await client`INSERT INTO insight_documents(insight_id,document_id,user_id) VALUES (${insight},${document},${owner})`;
  return {insight,document,notes:await client`SELECT * FROM insight_notes`,documents:await client`SELECT * FROM insight_documents`};
}

export async function prepareModelRepair({client,web,legacy}){
  const owner=randomUUID(),feedback=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'schema-repair@example.invalid')`;
  await client`INSERT INTO feedback(id,user_id,content,created_at) VALUES (${feedback},${owner},'Preserve original feedback','2020-01-02 03:04:05')`;
  const original=(await client`SELECT * FROM feedback WHERE id=${feedback}`)[0];
  if(legacy){
    for(const file of ['0074_rss_subscription_error_fields.sql','0075_add_insight_notes_and_documents_tables.sql','0076_enhance_feedback_table.sql','0087_rag_chunks_embedding_nullable.sql','0093_add_system_notification_to_characters.sql']){
      await client.unsafe(fs.readFileSync(path.join(web,'lib/db/migrations',file),'utf8'));
    }
    await client`UPDATE feedback SET title='Existing title',description='User description',status='resolved',updated_at='2021-02-03 04:05:06' WHERE id=${feedback}`;
  }
  return {owner,feedback,original,legacy,before:(await client`SELECT * FROM feedback WHERE id=${feedback}`)[0],attachments:legacy?await seedAttachments(client,owner):null};
}

export async function checkModelRepair({client,web,fixture}){
  const {owner,feedback,legacy}=fixture;
  const after=(await client`SELECT * FROM feedback WHERE id=${feedback}`)[0];
  if(legacy)assert.deepEqual(after,fixture.before);
  for(const key of Object.keys(fixture.original))assert.deepEqual(after[key],fixture.original[key]);
  if(!legacy)assert.deepEqual(after.updated_at,after.created_at);
  const attachments=fixture.attachments??await seedAttachments(client,owner);
  assert.deepEqual(await client`SELECT * FROM insight_notes`,attachments.notes);
  assert.deepEqual(await client`SELECT * FROM insight_documents`,attachments.documents);
  await client.unsafe(fs.readFileSync(path.join(web,'lib/db/migrations/0153_restore_model_schema_coverage.sql'),'utf8'));
  assert.deepEqual((await client`SELECT * FROM feedback WHERE id=${feedback}`)[0],after);
  assert.deepEqual(await client`SELECT * FROM insight_notes`,attachments.notes);
  assert.deepEqual(await client`SELECT * FROM insight_documents`,attachments.documents);
  await client`INSERT INTO feedback(content,user_id,source) VALUES ('Anonymous feedback',NULL,'web')`;
  await client`INSERT INTO rag_chunks(document_id,user_id,chunk_index,content,embedding) VALUES (${attachments.document},${owner},0,'text without embedding',NULL)`;
  await assert.rejects(client`INSERT INTO insight_notes(insight_id,user_id,content) VALUES (${randomUUID()},${owner},'orphan')`,e=>e.code==='23503');
  await assert.rejects(client`INSERT INTO insight_notes(insight_id,user_id,content) VALUES (${attachments.insight},${randomUUID()},'orphan')`,e=>e.code==='23503');
  await assert.rejects(client`INSERT INTO insight_documents(insight_id,document_id,user_id) VALUES (${attachments.insight},${attachments.document},${owner})`,e=>e.code==='23505');
  await assert.rejects(client`INSERT INTO insight_documents(insight_id,document_id,user_id) VALUES (${attachments.insight},${randomUUID()},${owner})`,e=>e.code==='23503');
  await client`DELETE FROM "Insight" WHERE id=${attachments.insight}`;
  assert.equal((await client`SELECT id FROM insight_notes WHERE insight_id=${attachments.insight}`).length,0);
  assert.equal((await client`SELECT id FROM insight_documents WHERE insight_id=${attachments.insight}`).length,0);
  return {name:'model schema repair preserves data and supports current writes',passed:true,legacyEnhanced:legacy,feedbackPreserved:true,attachmentsPreserved:true,repeatSqlPreservesData:true,anonymousFeedback:true,nullEmbedding:true,attachmentConstraints:true};
}

export async function checkMemoryQualityHttp({client,owner,origin}){
  const work=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'Schema verification','Isolated memory quality read')`;
  const response=await fetch(`${origin}/api/workshops/${work}/memory-recall-quality?days=7`,{signal:AbortSignal.timeout(60000)});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.coverage.workshops,1);
  assert.equal(body.coverage.platformFeedbackEvents,0);
  assert.equal(body.period.days,7);
  assert.equal(body.reviewItemSync.status,'synced');
  assert.equal(body.auditGuardrails.firstWindowIsBaselineOnly,true);
  return {memoryQualityHttp200:true,coverageMatchesFixture:true,reviewItemSync:true,baselineGuardrail:true};
}
