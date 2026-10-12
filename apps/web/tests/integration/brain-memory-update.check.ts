import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type postgres from 'postgres';
import { getBrainMemoryById, upsertBrainMemory, upsertBrainObservation } from '@/lib/brain/repository';
import { getBrainMemoryRevisionVersion, reviseBrainMemory } from '@/lib/brain/memory-revision';
import { proposeBrainMemoryUpdate, getBrainMemoryUpdate, decideBrainMemoryUpdate, listBrainMemoryUpdates } from '@/lib/brain/memory-update-proposal';
import { getBrainMemoryAutoUpdatePolicy, updateBrainMemoryAutoUpdatePolicy } from '@/lib/brain/memory-update-policy';
import { applyDocumentMemoryUpdate } from '@/lib/brain/memory-update-document';
import { reviewBrainMemory, writeBrainMemory } from '@/lib/brain/service';
import { buildBrainContextPack } from '@/lib/brain/context';
import { claimWorkshopExecution, finishWorkshopExecution } from '@/lib/work-runtime/execution-lease';
import { withExecutionContext } from '@/lib/work-runtime/execution-context';
import { createWorkshopPiTools } from '@/lib/workshops/pi-domain-tools';
import { getWorkshop } from '@/lib/workshops/service';
import type { BrainMemory } from '@/lib/brain/types';

/** Synthetic fixture only. The runner creates and drops its own random PostgreSQL database. */
export async function checkBrainMemoryUpdate(client: postgres.Sql) {
  let realDocumentEvidence:Record<string,unknown>|undefined;
  const userId=randomUUID(),otherUserId=randomUUID(),workId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},${userId+'@example.invalid'}),(${otherUserId},${otherUserId+'@example.invalid'})`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'memory update fixture','bounded program facts')`;
  const owner={type:'chat' as const,userId,id:'update-owner-fixture'};
  const seed=async (overrides:Partial<BrainMemory>={}) => {
    const observation=await upsertBrainObservation({userId,sourceType:'update_fixture_original',sourceId:randomUUID(),observedAt:new Date(),content:'Independent source original',contentHash:randomUUID()});
    return upsertBrainMemory({id:randomUUID(),userId,scope:{type:'work',workId},ownerType:'work',ownerId:workId,memoryType:'insight',subject:'fixture source',content:'original memory',status:'active',confidence:85,evidenceRefs:[`brain-observation:${observation.id}`],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),metadata:{canonicalGroupId:`update-fixture:${randomUUID()}`},...overrides});
  };
  const propose=(base:BrainMemory,extra:Record<string,unknown>={}) => proposeBrainMemoryUpdate({requester:owner,request:{targetMemoryId:base.id,expectedVersion:getBrainMemoryRevisionVersion(base),commandId:randomUUID(),content:'proposed correction',reason:'New independent evidence disagrees',evidenceRefs:[],...extra}});
  const decision=(proposal:any,extra:Record<string,unknown>={}) => ({action:'accept',commandId:randomUUID(),expectedVersion:proposal.proposalVersion,expectedBaseVersion:proposal.baseVersion,reason:'Owner checked the referenced original source',evidenceConfirmed:true,...extra});
  const decide=(proposal:any,request:Record<string,unknown>) => decideBrainMemoryUpdate({requester:owner,proposalId:proposal.candidate.id,request});
  const counts=async () => (await client`SELECT (SELECT count(*) FROM brain_memory_reviews WHERE user_id=${userId})::int reviews,(SELECT count(*) FROM brain_observations WHERE user_id=${userId})::int observations,(SELECT count(*) FROM brain_memories WHERE user_id=${userId})::int memories`)[0];

  const mcpRequester={...owner,id:'brain-mcp'},mcpWorkBase=await seed(),mcpBefore=await counts();
  const mcpRequest=(target:BrainMemory)=>({targetMemoryId:target.id,expectedVersion:getBrainMemoryRevisionVersion(target),commandId:randomUUID(),content:'MCP proposal with original write permissions',reason:'Matched requester boundary fixture',evidenceRefs:target.evidenceRefs});
  await assert.rejects(proposeBrainMemoryUpdate({requester:mcpRequester,request:mcpRequest(mcpWorkBase)}),{code:'update_not_allowed',status:403});
  assert.deepEqual(await counts(),mcpBefore);
  assert.equal((await getBrainMemoryById({userId,memoryId:mcpWorkBase.id}))!.content,mcpWorkBase.content);
  const mcpChatBase=await seed({scope:{type:'global'},ownerType:'chat',ownerId:userId});
  const mcpOwn=await proposeBrainMemoryUpdate({requester:mcpRequester,request:mcpRequest(mcpChatBase)});
  assert.equal(mcpOwn.candidate.status,'candidate');assert.equal(mcpOwn.base.id,mcpChatBase.id);
  const mcpGrant=randomUUID();
  await client`INSERT INTO brain_access_grants(id,user_id,subject_type,subject_id,scope_type,scope_id,permissions,memory_types) VALUES (${mcpGrant},${userId},'chat','brain-mcp','work',${workId},'["write"]'::jsonb,'["insight"]'::jsonb)`;
  try{
    const request=mcpRequest(mcpWorkBase),mcpGranted=await proposeBrainMemoryUpdate({requester:mcpRequester,request});
    assert.equal(mcpGranted.candidate.status,'candidate');assert.equal(mcpGranted.base.id,mcpWorkBase.id);
    const afterGranted=await counts();
    await client`DELETE FROM brain_access_grants WHERE id=${mcpGrant}`;
    await assert.rejects(proposeBrainMemoryUpdate({requester:mcpRequester,request}),{code:'update_not_allowed',status:403});
    assert.deepEqual(await counts(),afterGranted);
    await client`INSERT INTO brain_access_grants(id,user_id,subject_type,subject_id,scope_type,scope_id,permissions,memory_types,expires_at) VALUES (${mcpGrant},${userId},'chat','brain-mcp','work',${workId},'["write"]'::jsonb,'["insight"]'::jsonb,'2000-01-01T00:00:00Z')`;
    await assert.rejects(proposeBrainMemoryUpdate({requester:mcpRequester,request}),{code:'update_not_allowed',status:403});
    assert.deepEqual(await counts(),afterGranted);
    await client`UPDATE brain_access_grants SET expires_at=null WHERE id=${mcpGrant}`;
    const replayed=await proposeBrainMemoryUpdate({requester:mcpRequester,request});
    assert.equal(replayed.replayed,true);assert.deepEqual(replayed.receipt,mcpGranted.receipt);assert.equal(replayed.candidate.id,mcpGranted.candidate.id);
    assert.deepEqual(await counts(),afterGranted);
  }finally{await client`DELETE FROM brain_access_grants WHERE id=${mcpGrant}`;}

  const base=await seed(),commandId=randomUUID();
  const pair=await Promise.all([propose(base,{commandId}),propose(base,{commandId})]);
  assert.equal(pair.filter(result=>result.replayed).length,1);
  const proposal=pair.find(result=>!result.replayed)!;
  assert.equal(proposal.candidate.status,'candidate');assert.equal(proposal.base.status,'active');assert.equal(proposal.receipt.effective,false);
  assert.equal(proposal.candidate.ownerId,base.ownerId);assert.deepEqual(proposal.candidate.scope,base.scope);
  assert.equal((await getBrainMemoryById({userId,memoryId:base.id}))!.content,base.content);
  assert.ok((await listBrainMemoryUpdates({userId,ownerType:'work',ownerId:workId})).some((memory:BrainMemory)=>memory.id===proposal.candidate.id));
  assert.equal((await getBrainMemoryUpdate({userId,proposalId:proposal.candidate.id})).proposalVersion,proposal.proposalVersion);
  const pendingPack=buildBrainContextPack({requester:owner,taskIntent:'fixture source',accessMode:'owner_override',memories:[base,proposal.candidate],grants:[]});
  assert.ok(pendingPack.items.some(item=>item.id===base.id));assert.ok(!pendingPack.items.some(item=>item.id===proposal.candidate.id));
  await assert.rejects(propose(base,{commandId,content:'command must not be repurposed'}),{code:'command_conflict'});
  await assert.rejects(proposeBrainMemoryUpdate({requester:{...owner,userId:otherUserId},request:{targetMemoryId:base.id,expectedVersion:getBrainMemoryRevisionVersion(base),commandId:randomUUID(),content:'foreign overwrite',reason:'fixture',evidenceRefs:[]}}),{code:'memory_not_found'});
  await assert.rejects(decideBrainMemoryUpdate({requester:{...owner,type:'work',id:workId},proposalId:proposal.candidate.id,request:decision(proposal)}),{code:'owner_decision_required'});
  await assert.rejects(decide(proposal,decision(proposal,{evidenceConfirmed:false})),{code:'evidence_verification_required'});
  await assert.rejects(propose(base,{ownerId:randomUUID()}),{code:'invalid_update'});
  for(const legacyDecision of ['confirmed','dismissed','rejected'] as const){
    await assert.rejects(reviewBrainMemory({requester:owner,memoryId:proposal.candidate.id,decision:legacyDecision,reason:'legacy bypass',expectedVersion:proposal.proposalVersion,evidenceConfirmed:true}),{code:'memory_update_decision_required'});
  }
  const acceptedRequest=decision(proposal);
  const acceptedPair=await Promise.all([decide(proposal,acceptedRequest),decide(proposal,acceptedRequest)]);
  assert.equal(acceptedPair.filter(result=>result.replayed).length,1);
  const accepted=acceptedPair.find(result=>!result.replayed)!;
  assert.equal(accepted.base.status,'superseded');assert.equal(accepted.base.content,base.content);
  assert.equal(accepted.candidate.status,'active');assert.equal(accepted.candidate.id,proposal.candidate.id);assert.equal(accepted.receipt.effective,true);
  assert.deepEqual(accepted.base.evidenceRefs,base.evidenceRefs);assert.equal(accepted.candidate.metadata?.revision?.previousMemoryId,base.id);
  const activePack=buildBrainContextPack({requester:owner,taskIntent:'fixture source',accessMode:'owner_override',memories:[accepted.base,accepted.candidate],grants:[]});
  assert.ok(!activePack.items.some(item=>item.id===base.id));assert.ok(activePack.items.some(item=>item.id===accepted.candidate.id));
  await assert.rejects(decide(proposal,{...acceptedRequest,reason:'different payload'}),{code:'command_conflict'});
  await assert.rejects(upsertBrainMemory({...base,content:'ordinary overwrite'}),{code:'memory_revision_required'});

  const rejectBase=await seed(),rejectProposal=await propose(rejectBase);
  const rejected=await decide(rejectProposal,decision(rejectProposal,{action:'reject',evidenceConfirmed:false}));
  assert.equal(rejected.candidate.status,'deleted');assert.equal(rejected.base.status,'active');assert.equal(rejected.candidate.metadata?.revisionRetired,undefined);
  assert.equal((await getBrainMemoryById({userId,memoryId:rejectBase.id}))!.content,rejectBase.content);
  await assert.rejects(reviseBrainMemory({requester:owner,memoryId:rejected.candidate.id,request:{operation:'restore',authority:'owner_statement',commandId:randomUUID(),expectedVersion:getBrainMemoryRevisionVersion(rejected.candidate),content:'must not restore rejected proposal',reason:'fixture',evidenceRefs:[]}}));

  const raceBase=await seed(),raceProposal=await propose(raceBase);
  const race=await Promise.allSettled([decide(raceProposal,decision(raceProposal)),decide(raceProposal,decision(raceProposal,{action:'reject'}))]);
  assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(race.filter(result=>result.status==='rejected'&&['proposal_closed','version_conflict'].includes(result.reason.code)).length,1);
  const staleBase=await seed(),staleProposal=await propose(staleBase);
  await reviseBrainMemory({requester:owner,memoryId:staleBase.id,request:{operation:'correct',authority:'owner_statement',commandId:randomUUID(),expectedVersion:getBrainMemoryRevisionVersion(staleBase),content:'owner correction after proposal',reason:'fixture owner change',evidenceRefs:[]}});
  await assert.rejects(decide(staleProposal,decision(staleProposal)),{code:'version_conflict'});
  const expired=await seed({expiresAt:'2000-01-01T00:00:00Z'}),expiredProposal=await propose(expired);
  await assert.rejects(decide(expiredProposal,decision(expiredProposal)),{code:'memory_inactive'});

  for(const table of ['brain_observations','brain_memory_reviews']){
    const target=await seed(),before=await counts(),request={commandId:randomUUID()};
    await client.unsafe("CREATE FUNCTION reject_update_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected update failure'; END $$");
    await client.unsafe(`CREATE TRIGGER reject_update_fixture BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_update_fixture()`);
    try{await assert.rejects(propose(target,request));}finally{await client.unsafe(`DROP TRIGGER reject_update_fixture ON ${table}`);await client.unsafe('DROP FUNCTION reject_update_fixture()');}
    assert.deepEqual(await counts(),before);assert.equal((await getBrainMemoryById({userId,memoryId:target.id}))!.status,'active');
    assert.equal((await propose(target,request)).replayed,false);
  }
  const rollbackBase=await seed(),rollbackProposal=await propose(rollbackBase),rollbackRequest=decision(rollbackProposal),beforeAccept=await counts();
  await client.unsafe("CREATE FUNCTION reject_update_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='superseded' THEN RAISE EXCEPTION 'injected accept failure'; END IF; RETURN NEW; END $$");
  await client.unsafe('CREATE TRIGGER reject_update_accept BEFORE UPDATE ON brain_memories FOR EACH ROW EXECUTE FUNCTION reject_update_accept()');
  try{await assert.rejects(decide(rollbackProposal,rollbackRequest));}finally{await client.unsafe('DROP TRIGGER reject_update_accept ON brain_memories');await client.unsafe('DROP FUNCTION reject_update_accept()');}
  assert.deepEqual(await counts(),beforeAccept);assert.equal((await getBrainMemoryById({userId,memoryId:rollbackBase.id}))!.status,'active');assert.equal((await getBrainMemoryById({userId,memoryId:rollbackProposal.candidate.id}))!.status,'candidate');
  assert.equal((await decide(rollbackProposal,rollbackRequest)).candidate.status,'active');

  const ordinaryBase=await seed({scope:{type:'global'},ownerType:'chat',ownerId:userId});
  const ordinaryInput={requester:owner,scope:ordinaryBase.scope,ownerType:ordinaryBase.ownerType,ownerId:ordinaryBase.ownerId,memoryType:ordinaryBase.memoryType,subject:ordinaryBase.subject,content:'ordinary conflicting understanding',status:'verified' as const,confidence:100,evidenceRefs:ordinaryBase.evidenceRefs,canonicalGroupId:ordinaryBase.metadata!.canonicalGroupId as string};
  const ordinary=await writeBrainMemory(ordinaryInput),ordinaryReplay=await writeBrainMemory(ordinaryInput);
  assert.equal(ordinary.status,'candidate');assert.equal(ordinaryReplay.id,ordinary.id);assert.equal((ordinary.metadata?.updateProposal as any).targetMemoryId,ordinaryBase.id);
  assert.equal((await getBrainMemoryById({userId,memoryId:ordinaryBase.id}))!.content,ordinaryBase.content);
  const modelInitial=await writeBrainMemory({requester:{...owner,id:'brain-mcp'},scope:{type:'global'},ownerType:'chat',ownerId:userId,memoryType:'insight',subject:'independent model understanding',content:'Model interpretation of an independent source',status:'verified',evidenceRefs:ordinaryBase.evidenceRefs,canonicalGroupId:`model-initial:${randomUUID()}`});
  assert.equal(modelInitial.status,'candidate');assert.equal((modelInitial.metadata?.admission as any).requiresOwnerVerification,true);
  await assert.rejects(reviewBrainMemory({requester:owner,memoryId:modelInitial.id,decision:'confirmed',reason:'missing guarded evidence'}),{code:'update_verification_required'});
  await assert.rejects(writeBrainMemory({...ordinaryInput,metadata:{documentProgramUpdate:{authority:'runtime'}} as any}),{code:'reserved_memory_metadata'});

  const initialPolicy=await getBrainMemoryAutoUpdatePolicy({userId});assert.equal(initialPolicy.enabled,true);
  const pauseRequest={commandId:randomUUID(),expectedVersion:initialPolicy.version,enabled:false,reason:'Matched fixture pause'};
  const pausedPair=await Promise.all([updateBrainMemoryAutoUpdatePolicy({requester:owner,request:pauseRequest}),updateBrainMemoryAutoUpdatePolicy({requester:owner,request:pauseRequest})]);
  assert.equal(pausedPair.filter(result=>result.replayed).length,1);assert.equal((await getBrainMemoryAutoUpdatePolicy({userId})).enabled,false);
  await assert.rejects(updateBrainMemoryAutoUpdatePolicy({requester:owner,request:{...pauseRequest,enabled:true}}),{code:'command_conflict'});
  await assert.rejects(updateBrainMemoryAutoUpdatePolicy({requester:owner,request:{...pauseRequest,commandId:randomUUID()}}),{code:'version_conflict'});
  await assert.rejects(updateBrainMemoryAutoUpdatePolicy({requester:{...owner,type:'work',id:workId},request:pauseRequest}),{code:'owner_decision_required'});
  const pausedPolicy=await getBrainMemoryAutoUpdatePolicy({userId});
  await updateBrainMemoryAutoUpdatePolicy({requester:owner,request:{commandId:randomUUID(),expectedVersion:pausedPolicy.version,enabled:true,reason:'Resume for matched document baseline'}});

  const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
  const source=async () => {const id=randomUUID();await client`INSERT INTO workshop_sources(id,workshop_id,type,name,enabled,config) VALUES (${id},${workId},'file','synthetic.md',true,'{}')`;return id;};
  const conversion=async (sourceId:string,value:string,extra:Record<string,unknown>={}) => {
    const sourceEventId=randomUUID(),sourceEventSeq=Number((await client`SELECT coalesce(max(seq),0)::int seq FROM workshop_events WHERE workshop_id=${workId}`)[0].seq)+1,observedAt=new Date().toISOString();
    const input={userId,workId,sourceId,sourceEventId,sourceEventSeq,observedAt,sourceSha256:hash('source:'+value),documentSha256:hash('document:'+value),manifestSha256:hash('manifest:'+value),sourceFormat:'markdown',chunkCount:1,warnings:[] as string[],...extra};
    const metadata={receiptAuthority:'runtime',sourceId,sourceSha256:input.sourceSha256,documentSha256:input.documentSha256,manifestSha256:input.manifestSha256,sourceFormat:input.sourceFormat,chunkCount:input.chunkCount,warnings:input.warnings};
    await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title,metadata,created_at) VALUES (${sourceEventId},${workId},${sourceEventSeq},'document_converted','synthetic conversion',${JSON.stringify(metadata)}::jsonb,${input.observedAt})`;
    await client`INSERT INTO workshop_event_counters(workshop_id,last_seq) VALUES (${workId},${sourceEventSeq}) ON CONFLICT(workshop_id) DO UPDATE SET last_seq=greatest(workshop_event_counters.last_seq,EXCLUDED.last_seq)`;
    return input;
  };
  const sourceId=await source(),a=await conversion(sourceId,'A');
  const documentPair=await Promise.all([applyDocumentMemoryUpdate(a),applyDocumentMemoryUpdate(a)]);
  assert.equal(documentPair.filter(result=>result.replayed).length,1);
  const first=documentPair.find(result=>!result.replayed)!;
  assert.ok(first.status==='created_active');assert.equal(first.memory.status,'active');assert.deepEqual(first.memory.evidenceRefs,[a.sourceEventId]);
  assert.equal((first.memory.metadata?.documentProgramUpdate as Record<string,unknown>).independentlyVerifiesDocumentClaims,false);
  const same=await applyDocumentMemoryUpdate(await conversion(sourceId,'A'));
  assert.ok(same.status==='noop');assert.equal(same.memory.id,first.memory.id);
  const b=await applyDocumentMemoryUpdate(await conversion(sourceId,'B'));
  assert.equal(b.status,'replaced_active');assert.equal((await getBrainMemoryById({userId,memoryId:first.memory.id}))!.status,'superseded');
  const again=await applyDocumentMemoryUpdate(await conversion(sourceId,'A'));
  assert.ok(again.status==='replaced_active');assert.equal(again.memory.content,first.memory.content);assert.notEqual(again.memory.id,first.memory.id);
  const late=await conversion(sourceId,'late'),newer=await conversion(sourceId,'newer');
  const newerApplied=await applyDocumentMemoryUpdate(newer);assert.ok(newerApplied.status==='replaced_active');
  assert.equal((await applyDocumentMemoryUpdate(late)).reason,'non_monotonic_source');
  assert.equal((await applyDocumentMemoryUpdate(late)).replayed,true);
  const latest=(await getBrainMemoryById({userId,memoryId:newerApplied.memory.id}))!;
  const paused=await getBrainMemoryAutoUpdatePolicy({userId});
  await updateBrainMemoryAutoUpdatePolicy({requester:owner,request:{commandId:randomUUID(),expectedVersion:paused.version,enabled:false,reason:'Pause before actual next source event'}});
  const pausedConversion=await applyDocumentMemoryUpdate(await conversion(sourceId,'paused'));
  assert.ok(pausedConversion.status==='pending_conflict');assert.equal(pausedConversion.reason,'automatic_updates_paused');assert.equal(pausedConversion.candidate.status,'candidate');
  assert.equal((await getBrainMemoryById({userId,memoryId:latest.id}))!.status,'active');
  const currentPolicy=await getBrainMemoryAutoUpdatePolicy({userId});
  await updateBrainMemoryAutoUpdatePolicy({requester:owner,request:{commandId:randomUUID(),expectedVersion:currentPolicy.version,enabled:true,reason:'Explicit resume'}});
  const pinned=await reviseBrainMemory({requester:owner,memoryId:latest.id,request:{operation:'correct',authority:'owner_statement',commandId:randomUUID(),expectedVersion:getBrainMemoryRevisionVersion(latest),content:'owner pinned conversion understanding',reason:'owner pin',evidenceRefs:[]}});
  const pinProposal=await applyDocumentMemoryUpdate(await conversion(sourceId,'after-pin'));
  assert.ok(pinProposal.status==='pending_conflict');assert.equal(pinProposal.reason,'owner_pinned');assert.equal(pinProposal.candidate.status,'candidate');assert.equal(pinProposal.base.id,pinned.newMemory!.id);
  const warningSource=await source(),warningBase=await applyDocumentMemoryUpdate(await conversion(warningSource,'clear'));
  assert.ok(warningBase.status==='created_active');
  const warningProposal=await applyDocumentMemoryUpdate(await conversion(warningSource,'warning',{warnings:['synthetic incomplete extraction']}));
  assert.ok(warningProposal.status==='pending_conflict');assert.equal(warningProposal.reason,'document_conversion_warnings');assert.equal(warningProposal.base.id,warningBase.memory.id);assert.equal(warningProposal.candidate.status,'candidate');
  const standalone=await applyDocumentMemoryUpdate(await conversion(await source(),'first-warning',{warnings:['source extraction warning']}));
  assert.ok(standalone.status==='candidate');assert.equal(standalone.memory.status,'candidate');assert.equal(standalone.memory.metadata?.updateProposal,undefined);
  await assert.rejects(reviewBrainMemory({requester:owner,memoryId:standalone.memory.id,decision:'confirmed',reason:'missing proof'}),{code:'revision_verification_required'});
  const standaloneConfirmed=await reviewBrainMemory({requester:owner,memoryId:standalone.memory.id,decision:'confirmed',expectedVersion:getBrainMemoryRevisionVersion(standalone.memory),evidenceConfirmed:true,reason:'Owner inspected the runtime source receipt'});
  assert.equal(standaloneConfirmed.status,'verified');
  const deletedPin=await reviseBrainMemory({requester:owner,memoryId:warningBase.memory.id,request:{operation:'deactivate',authority:'owner_statement',commandId:randomUUID(),expectedVersion:getBrainMemoryRevisionVersion(warningBase.memory),reason:'Owner explicitly retired program state',evidenceRefs:[]}});
  const afterDelete=await applyDocumentMemoryUpdate(await conversion(warningSource,'after-delete'));
  assert.ok(afterDelete.status==='pending_conflict');assert.equal(afterDelete.reason,'owner_pinned');assert.equal(afterDelete.base.id,deletedPin.oldMemory.id);assert.equal(afterDelete.base.status,'deleted');assert.equal(afterDelete.candidate.status,'candidate');
  const expirySource=await source(),expiryBase=await applyDocumentMemoryUpdate(await conversion(expirySource,'valid'));
  assert.ok(expiryBase.status==='created_active');
  await client`UPDATE brain_memories SET expires_at='2000-01-01T00:00:00Z' WHERE id=${expiryBase.memory.id}`;
  const expiredAuto=await applyDocumentMemoryUpdate(await conversion(expirySource,'expired-new-evidence'));
  assert.ok(expiredAuto.status==='pending_conflict');assert.equal(expiredAuto.reason,'memory_expired');assert.equal(expiredAuto.candidate.status,'candidate');
  const futureSource=await source(),futureInput=await conversion(futureSource,'future-base'),futureBase=await applyDocumentMemoryUpdate(futureInput),futureExpiry='2099-01-01T00:00:00.000Z';
  assert.ok(futureBase.status==='created_active');
  await client`UPDATE brain_memories SET expires_at=${futureExpiry} WHERE id=${futureBase.memory.id}`;
  const futureNext=await applyDocumentMemoryUpdate(await conversion(futureSource,'future-next'));
  assert.ok(futureNext.status==='replaced_active');assert.equal(futureNext.memory.expiresAt,futureExpiry);
  const historicalCount=await counts(),replayedOriginal=await applyDocumentMemoryUpdate(a);
  assert.ok(replayedOriginal.status==='replayed');assert.equal(replayedOriginal.receipt.historical,true);assert.equal(replayedOriginal.memory.id,pinned.newMemory!.id);assert.equal(replayedOriginal.currentEffective,true);assert.deepEqual(replayedOriginal.historicalReceipt,first.receipt);assert.deepEqual(await counts(),historicalCount);
  await reviseBrainMemory({requester:owner,memoryId:futureNext.memory.id,request:{operation:'deactivate',authority:'owner_statement',commandId:randomUUID(),expectedVersion:getBrainMemoryRevisionVersion(futureNext.memory),reason:'Owner retires current successor',evidenceRefs:[]}});
  const beforeDeletedReplay=await counts(),deletedReplay=await applyDocumentMemoryUpdate(futureInput);
  assert.ok(deletedReplay.status==='replayed');assert.equal(deletedReplay.memory.id,futureNext.memory.id);assert.equal(deletedReplay.memory.status,'deleted');assert.equal(deletedReplay.currentEffective,false);assert.deepEqual(await counts(),beforeDeletedReplay);
  const firstLateSource=await source(),firstLate=await conversion(firstLateSource,'first-old');await conversion(firstLateSource,'newer-not-yet-processed');
  const beforeNoBase=await counts(),noBaseIgnored=await applyDocumentMemoryUpdate(firstLate);assert.equal(noBaseIgnored.status,'skipped');assert.equal(noBaseIgnored.memory,null);assert.deepEqual(await counts(),beforeNoBase);
  const fakeWatermarkSource=await source(),realEvent=await conversion(fakeWatermarkSource,'real-event');
  const fakeSeq=Number((await client`SELECT max(seq)::int seq FROM workshop_events WHERE workshop_id=${workId}`)[0].seq)+1;
  await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title,metadata) VALUES (${randomUUID()},${workId},${fakeSeq},'document_converted','agent authored log',${JSON.stringify({receiptAuthority:'agent',sourceId:fakeWatermarkSource})}::jsonb)`;
  await client`UPDATE workshop_event_counters SET last_seq=${fakeSeq} WHERE workshop_id=${workId}`;
  assert.equal((await applyDocumentMemoryUpdate(realEvent)).status,'created_active');
  const futureWatermarkSource=await source(),watermarkBase=await applyDocumentMemoryUpdate(await conversion(futureWatermarkSource,'current-trusted'));
  assert.ok(watermarkBase.status==='created_active');
  const futureProposal=await applyDocumentMemoryUpdate(await conversion(futureWatermarkSource,'future-untrusted',{observedAt:new Date(Date.now()+60000).toISOString()}));
  assert.ok(futureProposal.status==='pending_conflict');assert.equal(futureProposal.reason,'stale_or_future_source');
  assert.equal((futureProposal.candidate.metadata?.documentProgramUpdate as Record<string,unknown>).appliedAsReliableVersion,false);
  await decide(futureProposal,decision(futureProposal,{action:'reject',evidenceConfirmed:false}));
  const freshAfterRejectedFuture=await applyDocumentMemoryUpdate(await conversion(futureWatermarkSource,'fresh-higher-sequence'));
  assert.ok(freshAfterRejectedFuture.status==='replaced_active');assert.equal(freshAfterRejectedFuture.baseMemoryId,watermarkBase.memory.id);
  const futureOwnerSource=await source();await applyDocumentMemoryUpdate(await conversion(futureOwnerSource,'fresh-owner-base'));
  const futureOwnerProposal=await applyDocumentMemoryUpdate(await conversion(futureOwnerSource,'future-owner-accepted',{observedAt:new Date(Date.now()+60000).toISOString()}));
  assert.ok(futureOwnerProposal.status==='pending_conflict');await decide(futureOwnerProposal,decision(futureOwnerProposal));
  const freshAfterOwnerFuture=await applyDocumentMemoryUpdate(await conversion(futureOwnerSource,'fresh-after-owner-future'));
  assert.ok(freshAfterOwnerFuture.status==='pending_conflict');assert.equal(freshAfterOwnerFuture.reason,'owner_pinned');

  // Full real seam: filesystem conversion -> persisted runtime event -> Brain
  // transaction. No model, network or provider is involved in this fixture.
  const realRunDir=await mkdtemp(join(tmpdir(),'zhiyu-memory-update-document-'));
  try{
    const realSourceId=randomUUID(),realRunId=randomUUID(),sourceText='# 真实隔离转换\n\n只验证产物程序事实，不证实文档业务主张。\n';
    await mkdir(join(realRunDir,'inputs'));const inputPath=join(realRunDir,'inputs','source.md');await writeFile(inputPath,sourceText,'utf8');
    await writeFile(join(realRunDir,'inputs','index.json'),JSON.stringify({staged:[{sourceId:realSourceId,runPath:inputPath,sha256:hash(sourceText)}]}),'utf8');
    await client`UPDATE workshops SET model_config='{"role":"document_markdown_cleaner","allowedTools":["workshopConvertDocument"]}'::jsonb WHERE id=${workId}`;
    await client`INSERT INTO workshop_sources(id,workshop_id,type,name,uri,enabled,config) VALUES (${realSourceId},${workId},'file','真实隔离来源.md',${inputPath},true,'{}')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${realRunId},${workId},'queued',NULL)`;
    const realWork=await getWorkshop(userId,workId);assert.ok(realWork);
    const realLease=await claimWorkshopExecution({userId,workshopId:workId,runId:realRunId,workerId:'real-document-fixture',leaseMs:120000});assert.ok(realLease.state==='claimed');
    const executeReal=(converter:ReturnType<typeof makeTool>,callId:string)=>withExecutionContext(realLease.lease,()=>converter.execute(callId,{sourceId:realSourceId}));
    const makeTool=()=>{const converter=createWorkshopPiTools({workshop:realWork,workshopId:workId,runId:realRunId,workDir:realRunDir,executionLease:realLease.lease}).find(tool=>tool.name==='workshopConvertDocument');assert.ok(converter);return converter;};
    const converter=makeTool(),output=(result:any)=>JSON.parse(result.content[0].text);
    await client.unsafe("CREATE FUNCTION reject_real_conversion_brain() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'real converter Brain audit failure'; END $$");
    await client.unsafe('CREATE TRIGGER reject_real_conversion_brain BEFORE INSERT ON brain_memory_reviews FOR EACH ROW EXECUTE FUNCTION reject_real_conversion_brain()');
    let failed:any;
    try{failed=output(await executeReal(converter,'real-first'));}finally{await client.unsafe('DROP TRIGGER reject_real_conversion_brain ON brain_memory_reviews');await client.unsafe('DROP FUNCTION reject_real_conversion_brain()');}
    assert.equal(failed.memoryUpdate.status,'failed');assert.equal(failed.chunkCount,1);assert.ok((await readFile(failed.documentPath,'utf8')).includes('不证实文档业务主张'));
    assert.equal((await client`SELECT count(*)::int n FROM brain_memories WHERE user_id=${userId} AND canonical_group_id=${'document-program:'+workId+':'+realSourceId}`)[0].n,0);
    const runtimeEvents=await client`SELECT id,seq,metadata,created_at FROM workshop_events WHERE workshop_id=${workId} AND type='document_converted' AND metadata->>'sourceId'=${realSourceId}`;assert.equal(runtimeEvents.length,1);
    const runtimeEvent=runtimeEvents[0];assert.equal(runtimeEvent.metadata.receiptAuthority,'runtime');assert.equal(runtimeEvent.metadata.documentSha256,createHash('sha256').update(await readFile(failed.documentPath)).digest('hex'));
    assert.equal((await client`SELECT count(*)::int n FROM workshop_events WHERE workshop_id=${workId} AND type='memory_update_failed' AND metadata->>'sourceEventId'=${runtimeEvent.id}`)[0].n,1);
    const recovered=output(await executeReal(converter,'real-retry'));assert.equal(recovered.memoryUpdate.status,'created_active');
    const realMemory=recovered.memoryUpdate.result.memory;assert.equal(realMemory.status,'active');assert.deepEqual(realMemory.evidenceRefs,[runtimeEvent.id]);assert.equal(realMemory.metadata.documentProgramUpdate.sourceEventSeq,runtimeEvent.seq);
    const beforeRealReplay=await counts(),reloaded=output(await executeReal(makeTool(),'real-reloaded'));assert.equal(reloaded.memoryUpdate.status,'replayed');assert.equal(reloaded.memoryUpdate.result.memory.id,realMemory.id);assert.equal(reloaded.memoryUpdate.result.currentEffective,true);assert.deepEqual(await counts(),beforeRealReplay);
    await reviseBrainMemory({requester:owner,memoryId:realMemory.id,request:{operation:'deactivate',authority:'owner_statement',commandId:randomUUID(),expectedVersion:getBrainMemoryRevisionVersion(realMemory),reason:'Owner retires real converted memory',evidenceRefs:[]}});
    const retiredReplay=output(await executeReal(makeTool(),'real-retired-replay'));assert.equal(retiredReplay.memoryUpdate.status,'replayed');assert.equal(retiredReplay.memoryUpdate.result.memory.status,'deleted');assert.equal(retiredReplay.memoryUpdate.result.currentEffective,false);
    assert.equal((await client`SELECT count(*)::int n FROM workshop_events WHERE workshop_id=${workId} AND type='document_converted' AND metadata->>'sourceId'=${realSourceId}`)[0].n,1);
    const realBrainEvents=await client`SELECT metadata FROM workshop_events WHERE workshop_id=${workId} AND run_id=${realRunId} AND type='brain_memory_written'`;
    assert.equal(realBrainEvents.length,1);assert.equal(realBrainEvents[0].metadata.execution.token,realLease.lease.token);
    realDocumentEvidence={sourceId:realSourceId,runId:realRunId,executionWorker:'real-document-fixture',executionToken:realLease.lease.token,brainWriteEventCount:realBrainEvents.length,runtimeEventId:runtimeEvent.id,runtimeSeq:runtimeEvent.seq,sourceSha256:runtimeEvent.metadata.sourceSha256,documentSha256:runtimeEvent.metadata.documentSha256,manifestSha256:runtimeEvent.metadata.manifestSha256,memoryId:realMemory.id,initialSynchronization:failed.memoryUpdate.status,recoveredSynchronization:recovered.memoryUpdate.status,reloadedSynchronization:reloaded.memoryUpdate.status,retiredSynchronization:retiredReplay.memoryUpdate.status,finalCurrentStatus:retiredReplay.memoryUpdate.result.memory.status,finalCurrentEffective:retiredReplay.memoryUpdate.result.currentEffective,conversionEventCount:1};
    const realCompletion=await finishWorkshopExecution(realLease.lease,{status:'completed',summary:'Synthetic document conversion and memory recovery verified'});assert.equal(realCompletion.status,'completed');
  }finally{const target=resolve(realRunDir);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('zhiyu-memory-update-document-'))throw Error('Unexpected real document fixture cleanup');await rm(target,{recursive:true,force:true});}

  const unauthorized=await conversion(await source(),'unauthorized');
  await client`UPDATE workshop_events SET metadata=jsonb_set(metadata,'{receiptAuthority}','"agent"') WHERE id=${unauthorized.sourceEventId}`;
  const beforeUnauthorized=await counts();
  await assert.rejects(applyDocumentMemoryUpdate(unauthorized),{code:'document_evidence_not_authorized'});assert.deepEqual(await counts(),beforeUnauthorized);
  await assert.rejects(applyDocumentMemoryUpdate({...a,userId:otherUserId}),{code:'document_evidence_not_authorized'});
  await assert.rejects(applyDocumentMemoryUpdate({...a,sourceSha256:hash('spoofed')}),{code:'command_conflict'});
  const disabled=await conversion(await source(),'disabled');await client`UPDATE workshop_sources SET enabled=false WHERE id=${disabled.sourceId}`;
  await assert.rejects(applyDocumentMemoryUpdate(disabled),{code:'document_evidence_not_authorized'});
  const temporary=await conversion(await source(),'temporary');await client`UPDATE workshop_sources SET config='{"scope":"conversation"}'::jsonb WHERE id=${temporary.sourceId}`;
  await assert.rejects(applyDocumentMemoryUpdate(temporary),{code:'document_evidence_not_authorized'});
  const runId=randomUUID();await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workId},'queued',NULL)`;
  const lease=await claimWorkshopExecution({userId,workshopId:workId,runId,workerId:'update-fixture',leaseMs:30000});if(lease.state!=='claimed')throw Error('Fixture execution lease unavailable');
  const scoped=<T>(callback:()=>Promise<T>)=>withExecutionContext(lease.lease,callback);
  const eventSource=await source(),eventInput=await conversion(eventSource,'event-rollback'),beforeEvent=await counts();
  await client.unsafe("CREATE FUNCTION reject_update_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='brain_memory_written' THEN RAISE EXCEPTION 'injected execution event failure'; END IF; RETURN NEW; END $$");
  await client.unsafe('CREATE TRIGGER reject_update_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_update_event()');
  try{await assert.rejects(scoped(()=>applyDocumentMemoryUpdate(eventInput)));}finally{await client.unsafe('DROP TRIGGER reject_update_event ON workshop_events');await client.unsafe('DROP FUNCTION reject_update_event()');}
  assert.deepEqual(await counts(),beforeEvent);
  const eventCount=async()=>Number((await client`SELECT count(*) n FROM workshop_events WHERE workshop_id=${workId} AND type='brain_memory_written'`)[0].n),eventsBefore=await eventCount();
  await scoped(()=>applyDocumentMemoryUpdate(eventInput));await scoped(()=>applyDocumentMemoryUpdate(eventInput));assert.equal(await eventCount(),eventsBefore+1);
  return {name:'memory update: dual-version decisions, stable receipts/races/rollback, policy, trusted program-fact baseline/noop/A-B-A, pause/pin/warning/expiry/watermark, current historical replay and full real conversion-event-artifact-to-PG recovery',passed:true,realDocumentEvidence};
}
