import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {getBrainMemoryById} from '@/lib/brain/repository';
import {getBrainMemoryRevisionVersion,reviseBrainMemory} from '@/lib/brain/memory-revision';
import {createBrainMemoryCorrectionDraft,getBrainMemoryCorrectionDraft} from '@/lib/brain/memory-correction-draft';
import {bindMemoryDependencies,getMemoryDependencies,type MemoryDependencyEntityKind} from '@/lib/brain/memory-dependencies';
import {buildBrainContextPack} from '@/lib/brain/context';
import {seedMemoryCorrectionFixture,memoryCorrectionCounts,memoryCorrectionOriginalRecords} from './brain-memory-correction-fixture.mjs';

/** Full service composition, exclusively in the owning runner's random loopback database. */
export async function checkBrainMemoryCorrection(client:postgres.Sql){
  const userId=randomUUID(),foreignUser=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},${userId+'@example.invalid'}),(${foreignUser},${foreignUser+'@example.invalid'})`;
  const owner={type:'chat' as const,userId,id:'memory-correction-human'};
  const kinds:MemoryDependencyEntityKind[]=['wiki_note','interaction_task','loop'];
  const fixture=()=>seedMemoryCorrectionFixture(client,userId);
  const memory=async(id:string)=>{const value=await getBrainMemoryById({userId,memoryId:id});assert.ok(value);return value;};
  const request=async(id:string,intent='完整改为：新的完整合成记忆：周二核对资料。')=>({commandId:randomUUID() as string,expectedVersion:getBrainMemoryRevisionVersion(await memory(id)),intent});
  const create=(memoryId:string,body:unknown)=>createBrainMemoryCorrectionDraft({requester:owner,memoryId,request:body});
  const get=(memoryId:string,commandId:string)=>getBrainMemoryCorrectionDraft({requester:owner,memoryId,commandId});
  const register=async(f:Awaited<ReturnType<typeof fixture>>,kind:MemoryDependencyEntityKind)=>{
    const snapshot=await getMemoryDependencies({requester:owner,entityKind:kind,entityId:f.entities[kind]});
    await bindMemoryDependencies({requester:owner,entityKind:kind,entityId:f.entities[kind],request:{commandId:randomUUID(),action:'register',expectedDependencyVersion:snapshot.dependencyVersion,expectedEntityVersion:snapshot.entity.version,
      sources:[{memoryId:f.memoryId,expectedVersion:getBrainMemoryRevisionVersion(await memory(f.memoryId))}],reason:'Synthetic owner checked original body and exact source version',evidenceConfirmed:true}});
  };
  const baseline=await fixture();for(const kind of kinds)await register(baseline,kind);
  const original=await memoryCorrectionOriginalRecords(client,baseline),before=await memoryCorrectionCounts(client,userId),body=await request(baseline.memoryId);
  const ready=await create(baseline.memoryId,body);
  assert.equal(ready.draft.outcome,'ready');assert.equal(ready.draft.operation,'correct');assert.equal(ready.draft.content,'新的完整合成记忆：周二核对资料。');
  assert.equal(ready.draft.intent,body.intent);assert.equal(ready.draft.authority,null);assert.equal(ready.draft.sourceObservedAt,null);assert.equal(ready.draft.provider,'deterministic_rules');
  assert.equal(ready.receipt.effective,false);assert.equal(ready.current.versionMatches,true);assert.equal(ready.current.canSeed,true);assert.ok(ready.draft.quote);
  assert.equal(ready.draft.quote.text,body.intent.slice(ready.draft.quote.start,ready.draft.quote.end));
  assert.deepEqual(ready.draft.evidenceRefs,[`brain-observation:${ready.receipt.observationId}`]);
  const after=await memoryCorrectionCounts(client,userId);assert.deepEqual(after,{...before,observations:before.observations+1,snapshots:before.snapshots+1});
  assert.deepEqual(await memoryCorrectionOriginalRecords(client,baseline),original);
  for(const kind of kinds)assert.equal((await getMemoryDependencies({requester:owner,entityKind:kind,entityId:baseline.entities[kind]})).assessment,'current');
  const raw=(await client`SELECT * FROM brain_observations WHERE id=${ready.receipt.observationId} AND user_id=${userId}`)[0];assert.ok(raw);assert.equal(raw.source_type,'owner_memory_correction_intent');assert.equal(raw.content,body.intent);
  assert.equal(raw.metadata.provesOwnerSubmissionOnly,true);assert.equal(raw.metadata.independentlyVerifiesBusinessFact,false);
  const saved=(await client`SELECT * FROM brain_state_snapshots WHERE id=${ready.draft.id} AND user_id=${userId}`)[0];assert.ok(saved);assert.equal(saved.snapshot_type,'memory_correction_draft');
  const replay=await create(baseline.memoryId,body);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,ready.receipt);assert.deepEqual(replay.draft,ready.draft);
  assert.deepEqual((await get(baseline.memoryId,body.commandId)).draft,ready.draft);assert.deepEqual(await memoryCorrectionCounts(client,userId),after);
  await assert.rejects(create(baseline.memoryId,{...body,intent:'完整改为：不同的完整内容'}),{code:'draft_command_conflict',status:409});
  await assert.rejects(create(baseline.memoryId,{...body,expectedVersion:`bmrv1:${'f'.repeat(64)}`}),{code:'draft_command_conflict',status:409});
  await assert.rejects(create(baseline.memoryId,{...body,commandId:randomUUID(),expectedVersion:`bmrv1:${'f'.repeat(64)}`}),{code:'version_conflict',status:409});
  await assert.rejects(create(baseline.memoryId,{...body,commandId:randomUUID(),metadata:{authority:'verified'}}),{status:400});
  await assert.rejects(create(baseline.memoryId,{...body,commandId:randomUUID(),intent:'x'.repeat(4001)}),{status:400});
  await assert.rejects(createBrainMemoryCorrectionDraft({requester:{...owner,userId:foreignUser},memoryId:baseline.memoryId,request:{...body,commandId:randomUUID()}}),{status:404});
  await assert.rejects(getBrainMemoryCorrectionDraft({requester:{...owner,userId:foreignUser},memoryId:baseline.memoryId,commandId:body.commandId}),{status:404});
  await assert.rejects(createBrainMemoryCorrectionDraft({requester:{...owner,id:'brain-mcp'},memoryId:baseline.memoryId,request:{...body,commandId:randomUUID()}}),{status:403});
  await assert.rejects(createBrainMemoryCorrectionDraft({requester:{type:'work',userId,id:baseline.workId},memoryId:baseline.memoryId,request:{...body,commandId:randomUUID()}}),{status:403});
  assert.deepEqual(await memoryCorrectionCounts(client,userId),after);

  const grammar:[string,'supplement'|'state_change'|'deactivate',string|null][]=[
    ['完整补充为：周一整理资料，周二核对来源。','supplement','周一整理资料，周二核对来源。'],
    ['状态变化后的完整内容：目前已经完成资料核对。','state_change','目前已经完成资料核对。'],
    ['停用这条记忆','deactivate',null],
  ];
  for(const [intent,operation,content]of grammar){const target=await fixture(),result=await create(target.memoryId,await request(target.memoryId,intent));assert.equal(result.draft.outcome,'ready');assert.equal(result.draft.operation,operation);assert.equal(result.draft.content,content);assert.equal(result.receipt.effective,false);assert.equal((await memory(target.memoryId)).status,'active');}
  for(const intent of ['以前不是这样，你理解错了','如果以后改变，要不要改这条记忆？','他曾说“完整改为：不同正文”，请分析这句话']){
    const target=await fixture(),result=await create(target.memoryId,await request(target.memoryId,intent));assert.equal(result.draft.outcome,'needs_clarification');assert.equal(result.draft.operation,null);assert.equal(result.draft.content,null);assert.equal(result.draft.reason,null);assert.ok(result.draft.questions.length>0);assert.equal((await memory(target.memoryId)).content,target.memoryContent);
  }
  const whitespace=await fixture(),whitespaceRequest=await request(whitespace.memoryId,'  完整改为：保留首尾空白的原话来源。  '),whitespaceDraft=await create(whitespace.memoryId,whitespaceRequest);
  assert.equal(whitespaceDraft.draft.intent,whitespaceRequest.intent);assert.equal(whitespaceDraft.draft.content,'保留首尾空白的原话来源。');assert.ok(whitespaceDraft.draft.quote);assert.equal(whitespaceDraft.draft.quote.text,whitespaceRequest.intent.slice(whitespaceDraft.draft.quote.start,whitespaceDraft.draft.quote.end));
  assert.equal((await client`SELECT content FROM brain_observations WHERE id=${whitespaceDraft.receipt.observationId}`)[0].content,whitespaceRequest.intent);
  const concurrent=await fixture(),raceRequest=await request(concurrent.memoryId),raceCounts=await memoryCorrectionCounts(client,userId);
  const races=await Promise.all([create(concurrent.memoryId,raceRequest),create(concurrent.memoryId,raceRequest)]);assert.equal(races.filter(result=>result.replayed).length,1);assert.deepEqual(races[0].receipt,races[1].receipt);
  assert.deepEqual(await memoryCorrectionCounts(client,userId),{...raceCounts,observations:raceCounts.observations+1,snapshots:raceCounts.snapshots+1});
  const distinct=await fixture(),distinctBefore=await memoryCorrectionOriginalRecords(client,distinct),distinctRequest=await request(distinct.memoryId);
  const separate=await Promise.all([create(distinct.memoryId,distinctRequest),create(distinct.memoryId,{...distinctRequest,commandId:randomUUID(),intent:'完整改为：另一份待主人核对的完整草稿。'})]);
  assert.ok(separate.every(result=>!result.replayed&&result.receipt.effective===false));assert.notEqual(separate[0].draft.id,separate[1].draft.id);assert.deepEqual(await memoryCorrectionOriginalRecords(client,distinct),distinctBefore);

  let faultRecoveries=0;
  for(const table of ['brain_observations','brain_state_snapshots']as const){
    const target=await fixture(),faultRequest=await request(target.memoryId),faultCounts=await memoryCorrectionCounts(client,userId),predicate=table==='brain_observations'?"NEW.source_type='owner_memory_correction_intent'":"NEW.snapshot_type='memory_correction_draft'";
    await client.unsafe(`CREATE FUNCTION reject_correction_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RAISE EXCEPTION 'injected correction draft failure'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER reject_correction_fixture BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_correction_fixture()`);
    try{await assert.rejects(create(target.memoryId,faultRequest));}finally{await client.unsafe(`DROP TRIGGER reject_correction_fixture ON ${table}`);await client.unsafe('DROP FUNCTION reject_correction_fixture()');}
    assert.deepEqual(await memoryCorrectionCounts(client,userId),faultCounts);assert.equal((await create(target.memoryId,faultRequest)).replayed,false);assert.equal((await create(target.memoryId,faultRequest)).replayed,true);faultRecoveries++;
  }
  const busy=await fixture(),busyRequest=await request(busy.memoryId),busyCounts=await memoryCorrectionCounts(client,userId);let signal!:()=>void,release!:()=>void;const held=new Promise<void>(resolve=>{signal=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  const holder=client.begin(async transaction=>{await transaction`SELECT id FROM brain_memories WHERE id=${busy.memoryId} FOR UPDATE`;signal();await released;});void holder.catch(()=>{});await held;
  try{await assert.rejects(create(busy.memoryId,busyRequest),{code:'memory_write_busy',status:409});assert.deepEqual(await memoryCorrectionCounts(client,userId),busyCounts);}finally{release();await holder;}
  assert.equal((await create(busy.memoryId,busyRequest)).replayed,false);

  const priorCounts=await memoryCorrectionCounts(client,userId),current=await memory(baseline.memoryId);
  const adopted=await reviseBrainMemory({requester:owner,memoryId:baseline.memoryId,request:{commandId:randomUUID(),expectedVersion:ready.draft.expectedVersion,operation:'correct',authority:'owner_statement',content:ready.draft.content!,reason:ready.draft.reason!,evidenceRefs:ready.draft.evidenceRefs}});
  assert.ok(adopted.newMemory);assert.equal(adopted.oldMemory.status,'superseded');assert.equal(adopted.newMemory.status,'active');assert.ok(adopted.newMemory.evidenceRefs.includes(`brain-observation:${ready.receipt.observationId}`));assert.notEqual(adopted.newMemory.status,'verified');
  const pack=buildBrainContextPack({requester:owner,accessMode:'owner_override',taskIntent:'周二核对资料',memories:[await memory(baseline.memoryId),await memory(adopted.newMemory.id)],grants:[]});assert.ok(pack.items.some(item=>item.id===adopted.newMemory!.id&&item.revisionVersion===getBrainMemoryRevisionVersion(adopted.newMemory!)));assert.ok(!pack.items.some(item=>item.id===baseline.memoryId));
  for(const kind of kinds)assert.equal((await getMemoryDependencies({requester:owner,entityKind:kind,entityId:baseline.entities[kind]})).assessment,'stale');
  assert.deepEqual((await memoryCorrectionOriginalRecords(client,baseline)).observation,original.observation);assert.deepEqual((await memoryCorrectionOriginalRecords(client,baseline)).entities,original.entities);
  assert.deepEqual((await client`SELECT * FROM brain_observations WHERE id=${ready.receipt.observationId}`)[0],raw);assert.deepEqual((await client`SELECT * FROM brain_state_snapshots WHERE id=${ready.draft.id}`)[0],saved);
  const historical=await create(baseline.memoryId,body);assert.equal(historical.replayed,true);assert.deepEqual(historical.receipt,ready.receipt);assert.deepEqual(historical.draft,ready.draft);assert.equal(historical.current.versionMatches,false);assert.equal(historical.current.canSeed,false);assert.equal(historical.current.status,'superseded');
  assert.equal((await get(baseline.memoryId,body.commandId)).current.canSeed,false);assert.equal((await memoryCorrectionCounts(client,userId)).changes,priorCounts.changes+1);
  const fact=await seedMemoryCorrectionFixture(client,userId,{memoryType:'fact'}),factDraft=await create(fact.memoryId,await request(fact.memoryId,'完整改为：合成事实仍需独立核对。'));assert.equal(factDraft.draft.outcome,'ready');assert.ok(factDraft.draft.content);assert.ok(factDraft.draft.reason);
  const factRevision=await reviseBrainMemory({requester:owner,memoryId:fact.memoryId,request:{commandId:randomUUID(),expectedVersion:factDraft.draft.expectedVersion,operation:'correct',authority:'owner_statement',content:factDraft.draft.content!,reason:factDraft.draft.reason!,evidenceRefs:factDraft.draft.evidenceRefs}});assert.ok(factRevision.newMemory);assert.equal(factRevision.newMemory.status,'candidate');assert.equal(factRevision.receipt.effective,false);
  assert.ok(!buildBrainContextPack({requester:owner,accessMode:'owner_override',taskIntent:'合成事实',memories:[factRevision.newMemory],grants:[]}).items.length);
  const expired=await fixture();await client`UPDATE brain_memories SET expires_at=now()-interval '1 day' WHERE id=${expired.memoryId}`;const expiredMemory=await memory(expired.memoryId),expiredDraft=await create(expired.memoryId,await request(expired.memoryId));assert.equal(expiredDraft.receipt.effective,false);assert.equal((await memory(expired.memoryId)).expiresAt,expiredMemory.expiresAt);
  assert.deepEqual(current.evidenceRefs,original.memory.evidence_refs);
  return {name:'phase4 exact correction draft: conservative rules, immutable original intent, no memory/proposal/dependency writes, stable command replay/races, owner-only isolation, transaction fault and typed busy recovery, historical drift and actual revision/context/dependency composition',passed:true,
    draftOnlyPreservesDependencies:true,originalIntentImmutable:true,faultRecoveries,concurrentDraftCount:1,typedBusyRollback:true,actualRevisionUsesRawObservation:true,factRemainsCandidate:true,currentContextUsesNewVersion:true,threeDependenciesStaleAfterRevision:true,historicalDraftCanSeed:false};
}
