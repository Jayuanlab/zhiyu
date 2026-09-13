import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {previewCanonicalBackfill} from '@/lib/brain/canonical-backfill-preview';
import {upsertBrainMemory} from '@/lib/brain/repository';
import type postgres from 'postgres';

export async function checkCanonicalBackfill(client:postgres.Sql,web:string) {
  const user=randomUUID(),other=randomUUID(),ids=Array.from({length:5},()=>randomUUID());
  await client`INSERT INTO "User"(id,email) VALUES (${user},'canonical-preview@example.invalid'),(${other},'canonical-other@example.invalid')`;
  for(const id of ids)await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content) VALUES (${id},${user},'global','chat',${user},'boundary','边界','禁止真实交易')`;
  await client`INSERT INTO brain_memories(user_id,scope_type,owner_type,owner_id,memory_type,subject,content) VALUES (${other},'global','chat',${other},'fact','private','not visible')`;
  await client`UPDATE brain_memories SET canonical_kind='boundary',canonical_group_id='known' WHERE id=${ids[1]}`;
  await client`UPDATE brain_memories SET canonical_kind='boundary',metadata='{"canonicalKind":"plan"}'::jsonb WHERE id=${ids[2]}`;
  await client`UPDATE brain_memories SET scope_type='unknown' WHERE id=${ids[3]}`;
  const before=JSON.stringify(await client`SELECT * FROM brain_memories ORDER BY id`);
  const seen:unknown[]=[];let cursor:string|undefined;
  do {const page=await previewCanonicalBackfill({userId:user,cursor,limit:2});seen.push(...page.items);cursor=page.nextCursor??undefined;} while(cursor);
  assert.equal(seen.length,5);assert.equal(new Set(seen.map((item:any)=>item.id)).size,5);
  const all=await previewCanonicalBackfill({userId:user});
  assert.deepEqual(all.counts,{scanned:5,mappable:2,unchanged:1,conflicts:1,invalid:1,missingEvidence:4});
  await assert.rejects(previewCanonicalBackfill({userId:user,limit:501}));
  await assert.rejects(previewCanonicalBackfill({userId:user,cursor:'invalid'}));
  const cli=createRequire(import.meta.url).resolve('tsx/cli');
  const output=execFileSync(process.execPath,[cli,'scripts/backfill-brain-memory.ts','--canonical-dry-run'],{cwd:web,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,USER_ID:user}});
  const pages=output.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  assert.equal(pages.length,1);assert.equal(pages[0].dryRun,true);assert.equal(pages[0].counts.scanned,5);
  assert.equal(JSON.stringify(await client`SELECT * FROM brain_memories ORDER BY id`),before);
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_observations WHERE user_id=${user}`)[0].n,0);
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE user_id=${user}`)[0].n,0);
  const [raw]=await client`SELECT created_at,updated_at FROM brain_memories WHERE id=${ids[0]}`;
  await upsertBrainMemory({id:ids[0],userId:user,scope:{type:'global'},ownerType:'chat',ownerId:user,memoryType:'preference',subject:'Corrected preference',content:'User corrected content',status:'candidate',confidence:50,evidenceRefs:[],metadata:{canonicalKind:'preference',canonicalGroupId:'corrected-existing-group'},createdAt:new Date(raw.created_at).toISOString(),updatedAt:new Date(raw.updated_at).toISOString()});
  const [updated]=await client`SELECT canonical_kind,canonical_group_id,metadata,status FROM brain_memories WHERE id=${ids[0]}`;
  assert.equal(updated.canonical_kind,'preference');assert.equal(updated.canonical_kind,updated.metadata.canonicalKind);assert.equal(updated.canonical_group_id,updated.metadata.canonicalGroupId);assert.equal(updated.status,'candidate');
  const after=await previewCanonicalBackfill({userId:user});
  assert.notEqual(after.items.find(item=>item.id===ids[0])?.beforeValueHash,all.items.find(item=>item.id===ids[0])?.beforeValueHash);
  return {name:'canonical preview: bounded owner pagination, real CLI no writes, conflict classification and canonical update consistency',passed:true,counts:all.counts};
}
