import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {buildBrainContextPackFromStore} from '@/lib/brain/repository';

export async function checkRecallBoundaries(client:postgres.Sql){
  const owner=randomUUID(),other=randomUUID(),work=randomUUID(),sourceWork=randomUUID(),old=randomUUID(),shared=randomUUID(),expired=randomUUID(),candidate=randomUUID(),foreign=randomUUID(),grant=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'recall-boundary@example.invalid'),(${other},'recall-boundary-other@example.invalid')`;
  for(let n=0;n<220;n++)await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,updated_at) VALUES (${randomUUID()},${owner},'work',${work},'work',${work},'fact',${'Recent fact '+n},'Current market note','active',80,now())`;
  for(const [id,userId,scope,expires,status] of [[old,owner,work,null,'verified'],[shared,owner,sourceWork,null,'verified'],[expired,owner,work,'2020-01-01','verified'],[candidate,owner,work,null,'candidate'],[foreign,other,work,null,'verified']] as const){
    await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,created_at,updated_at,expires_at) VALUES (${id},${userId},'work',${scope},'work',${scope},'boundary',${'Permanent boundary '+id},'Never place live orders; paper trading only',${status},100,'2019-01-01','2019-01-01',${expires})`;
  }
  const input={requester:{type:'work' as const,userId:owner,id:work},taskIntent:'review trading risk boundary',maxItems:12,memoryLimit:200};
  const before=JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id IN (${owner},${other}) ORDER BY id`);
  const initial=await buildBrainContextPackFromStore(input);
  assert.ok(initial.items.some(item=>item.id===old),'Old permanent boundary must survive more than 200 recent facts');
  assert.ok(!initial.items.some(item=>new Set<string>([shared,expired,candidate,foreign]).has(item.id)));
  await client`INSERT INTO brain_access_grants(id,user_id,subject_type,subject_id,scope_type,scope_id,permissions,memory_types) VALUES (${grant},${owner},'work',${work},'work',${sourceWork},'["reference"]'::jsonb,'["boundary"]'::jsonb)`;
  const granted=await buildBrainContextPackFromStore(input);assert.ok(granted.items.some(item=>item.id===shared));assert.ok(granted.items.some(item=>item.id===old));
  const recentQuery=await buildBrainContextPackFromStore({...input,updatedAfter:'2025-01-01',searchTerms:['market']});assert.ok(recentQuery.items.some(item=>item.id===old));
  const factsOnly=await buildBrainContextPackFromStore({...input,memoryTypes:['fact']});assert.ok(!factsOnly.items.some(item=>item.memoryType==='boundary'));
  await client`DELETE FROM brain_access_grants WHERE id=${grant}`;
  const revoked=await buildBrainContextPackFromStore(input);assert.ok(!revoked.items.some(item=>item.id===shared));
  assert.ok(revoked.items.some(item=>item.id===old));
  assert.equal(JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id IN (${owner},${other}) ORDER BY id`),before);
  return {name:'old boundary retention with recent-memory saturation, grant/revoke, expiry, candidates and owner isolation',passed:true,recentFacts:220,oldBoundaryRetained:true,grantRevocationEffective:true};
}
