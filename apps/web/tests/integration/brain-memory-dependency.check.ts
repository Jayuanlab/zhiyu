import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {getBrainMemoryById} from '@/lib/brain/repository';
import {getBrainMemoryRevisionVersion,reviseBrainMemory} from '@/lib/brain/memory-revision';
import {bindMemoryDependencies,getMemoryDependencies,listMemoryDependencyImpacts,captureMemoryDependenciesInTransaction,
  assertMemoryDependenciesCurrentInTransaction,getMemoryDependencySummariesForEntities,type MemoryDependencySnapshot,type MemoryDependencyEntityKind,type MemoryDependencySource,MemoryDependencyError} from '@/lib/brain/memory-dependencies';
import {proposeBrainMemoryUpdate,decideBrainMemoryUpdate} from '@/lib/brain/memory-update-proposal';
import {applyDocumentMemoryUpdate} from '@/lib/brain/memory-update-document';
import {createInteractionNote,createInteractionTask,listInteractionWiki} from '@/lib/interactions/service';
import {getInteractionWikiMemoryEntities,projectInteractionWikiMemoryBasis} from '@/lib/interactions/wiki-memory-basis';
import {actOnInteractionTask} from '@/lib/interactions/task-state';
import {createLoop} from '@/lib/loops/service';
import {acceptWorkLoopExecution} from '@/lib/work-runtime/loop-command';
import {executeAcceptedWorkLoop} from '@/lib/work-runtime/loop-execution';
import {claimWorkshopExecution,finishWorkshopExecution,renewExecutionLease,withExecutionBusinessWrite,withExecutionWrite} from '@/lib/work-runtime/execution-lease';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';
import {withExecutionWriteContext} from '@/lib/work-runtime/execution-write-context';
import {runAcceptedNativeLoopOnce} from '@/lib/loops/runtime';
import {BrainMemoryWriteBusy} from '@/lib/brain/write-errors';
import {buildBrainContextPack} from '@/lib/brain/context';
import {writeBrainMemory} from '@/lib/brain/service';
import {seedMemoryDependencyFixture,dependencyFixtureState} from './brain-memory-dependency-fixture.mjs';

/** Never points at a daily database; the owning runner creates/drops a random loopback database. */
export async function checkBrainMemoryDependency(client:postgres.Sql){
  const userId=randomUUID(),foreignUser=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},${userId+'@example.invalid'}),(${foreignUser},${foreignUser+'@example.invalid'})`;
  const owner={type:'chat' as const,userId,id:'memory-dependency-human'};
  const kinds:MemoryDependencyEntityKind[]=['wiki_note','interaction_task','loop'];
  const fixture=()=>seedMemoryDependencyFixture(client,userId);
  const memory=async(id:string)=>{const result=await getBrainMemoryById({userId,memoryId:id});assert.ok(result);return result;};
  const refs=async(id:string):Promise<MemoryDependencySource[]>=>[{memoryId:id,expectedVersion:getBrainMemoryRevisionVersion(await memory(id))}];
  const get=(f:Awaited<ReturnType<typeof fixture>>,kind:MemoryDependencyEntityKind)=>getMemoryDependencies({requester:owner,entityKind:kind,entityId:f.entities[kind]});
  const request=(snapshot:MemoryDependencySnapshot,sources:MemoryDependencySource[],extra:Record<string,unknown>={})=>({commandId:randomUUID(),action:snapshot.coverage==='unknown'?'register':'rebind',expectedDependencyVersion:snapshot.dependencyVersion,
    expectedEntityVersion:snapshot.entity.version,sources,reason:'Owner checked exact entity content and actual source versions',evidenceConfirmed:true,...extra});
  const bind=(f:Awaited<ReturnType<typeof fixture>>,kind:MemoryDependencyEntityKind,command:unknown)=>bindMemoryDependencies({requester:owner,entityKind:kind,entityId:f.entities[kind],request:command});
  const register=async(f:Awaited<ReturnType<typeof fixture>>,kind:MemoryDependencyEntityKind,sourceId:string=f.memoryId)=>bind(f,kind,request(await get(f,kind),await refs(sourceId)));
  const revise=async(id:string,extra:Record<string,unknown>={})=>reviseBrainMemory({requester:owner,memoryId:id,request:{commandId:randomUUID(),expectedVersion:getBrainMemoryRevisionVersion(await memory(id)),operation:'correct',authority:'owner_statement',content:'新合成记忆：周二核对资料。',reason:'Matched original source correction',evidenceRefs:[],...extra}});
  const counts=async()=> (await client`SELECT (SELECT count(*) FROM brain_state_snapshots WHERE user_id=${userId} AND snapshot_type='memory_dependency_registry')::int registries,
    (SELECT count(*) FROM brain_state_snapshots WHERE user_id=${userId} AND snapshot_type='memory_dependency_change')::int changes,
    (SELECT count(*) FROM brain_memories WHERE user_id=${userId})::int memories,(SELECT count(*) FROM brain_observations WHERE user_id=${userId})::int observations,
    (SELECT count(*) FROM brain_memory_reviews WHERE user_id=${userId})::int reviews`)[0];
  const gate=(f:Awaited<ReturnType<typeof fixture>>,kind:MemoryDependencyEntityKind)=>db.transaction(store=>assertMemoryDependenciesCurrentInTransaction(store,{userId,entityKind:kind,entityId:f.entities[kind]}));

  const baseline=await fixture(),beforeBody=await dependencyFixtureState(client,baseline);
  for(const kind of kinds){const initial=await get(baseline,kind);assert.equal(initial.coverage,'unknown');assert.equal(initial.assessment,'unknown');assert.equal(initial.dependencyVersion,'bmdd1:initial');
    const legacy=await gate(baseline,kind);assert.equal(legacy.verified,false);assert.equal(legacy.assessment,'unknown');await register(baseline,kind);assert.equal((await get(baseline,kind)).assessment,'current');assert.equal((await gate(baseline,kind)).verified,true);}
  assert.deepEqual(await dependencyFixtureState(client,baseline),beforeBody);
  const invalidFixture=await fixture(),initial=await get(invalidFixture,'wiki_note'),valid=request(initial,await refs(invalidFixture.memoryId)),beforeInvalid=await counts();
  await assert.rejects(bind(invalidFixture,'wiki_note',{...valid,metadata:{assessment:'current'}}),{code:'invalid_dependency',status:400});
  await assert.rejects(bindMemoryDependencies({requester:{...owner,id:'brain-mcp'},entityKind:'wiki_note',entityId:invalidFixture.entities.wiki_note,request:valid}),{code:'dependency_owner_review_required',status:403});
  await assert.rejects(bindMemoryDependencies({requester:{type:'chat',userId:foreignUser,id:'foreign'},entityKind:'wiki_note',entityId:invalidFixture.entities.wiki_note,request:valid}),{code:'dependency_target_not_found',status:404});
  assert.deepEqual(await counts(),beforeInvalid);

  const replayFixture=await fixture(),replayRequest=request(await get(replayFixture,'wiki_note'),await refs(replayFixture.memoryId));
  const copies=await Promise.all([bind(replayFixture,'wiki_note',replayRequest),bind(replayFixture,'wiki_note',replayRequest)]);
  assert.equal(copies.filter(value=>value.replayed).length,1);assert.deepEqual(copies[0].receipt,copies[1].receipt);
  await assert.rejects(bind(replayFixture,'wiki_note',{...replayRequest,reason:'Different payload'}),{code:'dependency_command_conflict'});
  const racers=await fixture(),raceRequest=request(await get(racers,'wiki_note'),await refs(racers.memoryId));
  const races=await Promise.allSettled([bind(racers,'wiki_note',raceRequest),bind(racers,'wiki_note',{...raceRequest,commandId:randomUUID()})]);
  assert.equal(races.filter(result=>result.status==='fulfilled').length,1);assert.ok(races.some(result=>result.status==='rejected'&&result.reason.code==='dependency_version_conflict'));
  // Observe actual database waiters, rather than relying on random sleeps.
  const waitMemoryLocks=async(minimum:number)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){
    const row=(await client`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%brain_memories%'`)[0];
    if(row.n>=minimum)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error(`Expected ${minimum} real source-row waiters`);};
  for(const action of ['register','rebind'] as const)for(const revisionFirst of [false,true]){
    const target=await fixture();if(action==='rebind')await register(target,'wiki_note');
    const saved=request(await get(target,'wiki_note'),await refs(target.memoryId)),testBarrierKey=`dependency-fixture-barrier:${randomUUID()}`;
    let locked!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{locked=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
    await client.unsafe(`CREATE FUNCTION hold_dependency_fixture_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (NEW.snapshot_type='memory_dependency_registry' AND NEW.content->>'entityId'='${target.entities.wiki_note}') OR (NEW.snapshot_type='memory_dependency_change' AND NEW.content->>'oldMemoryId'='${target.memoryId}') THEN PERFORM pg_advisory_xact_lock(hashtextextended('${testBarrierKey}',0)); END IF; RETURN NEW; END $$`);
    await client.unsafe('CREATE TRIGGER hold_dependency_fixture_write BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION hold_dependency_fixture_write()');
    const holder=client.begin(async transaction=>{await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${testBarrierKey},0))`;locked();await released;});
    await ready;let registration:ReturnType<typeof bind>,revision:ReturnType<typeof revise>;
    const waitSnapshotInsert=async()=>{const deadline=Date.now()+5000;while(Date.now()<deadline){const row=(await client`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%brain_state_snapshots%'`)[0];if(row.n>=1)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Expected actual source/registry transaction held at fixture trigger');};
    try{
      if(revisionFirst){revision=revise(target.memoryId);void revision.catch(()=>{});await waitSnapshotInsert();registration=bind(target,'wiki_note',saved);void registration.catch(()=>{});await assert.rejects(registration,{code:'memory_write_busy',status:409});}
      else{registration=bind(target,'wiki_note',saved);void registration.catch(()=>{});await waitSnapshotInsert();revision=revise(target.memoryId);void revision.catch(()=>{});await waitMemoryLocks(1);}
    }finally{release();await holder;await client.unsafe('DROP TRIGGER hold_dependency_fixture_write ON brain_state_snapshots');await client.unsafe('DROP FUNCTION hold_dependency_fixture_write()');}
    const outcomes=await Promise.allSettled([registration!,revision!]);assert.equal(outcomes[1].status,'fulfilled');
    if(revisionFirst){assert.equal(outcomes[0].status,'rejected');if(outcomes[0].status==='rejected')assert.equal(outcomes[0].reason.code,'memory_write_busy');}
    else assert.equal(outcomes[0].status,'fulfilled');
    const assessed=await get(target,'wiki_note');assert.notEqual(assessed.assessment,'current');
  }

  const unrelated=await fixture();await revise(unrelated.memoryId);assert.equal((await get(baseline,'wiki_note')).assessment,'current');
  const base=await memory(baseline.memoryId),proposal=await proposeBrainMemoryUpdate({requester:owner,request:{targetMemoryId:base.id,expectedVersion:getBrainMemoryRevisionVersion(base),commandId:randomUUID(),content:'Conflicting unverified understanding',reason:'Matched pending conflict',evidenceRefs:[]}});
  assert.equal((await get(baseline,'wiki_note')).assessment,'stale');await assert.rejects(gate(baseline,'loop'),{code:'memory_dependency_stale'});
  assert.ok((await get(baseline,'wiki_note')).reasons.includes('source_update_pending'));
  await assert.rejects(bind(baseline,'wiki_note',request(await get(baseline,'wiki_note'),await refs(base.id))),{code:'dependency_source_conflict'});
  await assert.rejects(bind(invalidFixture,'wiki_note',{...valid,sources:await refs(base.id)}),{code:'dependency_source_conflict'});
  await decideBrainMemoryUpdate({requester:owner,proposalId:proposal.candidate.id,request:{action:'reject',commandId:randomUUID(),expectedVersion:proposal.proposalVersion,expectedBaseVersion:proposal.baseVersion,reason:'Owner rejected the proposed conflict'}});
  assert.equal((await get(baseline,'wiki_note')).assessment,'current');assert.equal((await gate(baseline,'loop')).verified,true);

  const changeCommand=randomUUID(),retired=await revise(baseline.memoryId,{commandId:changeCommand});assert.ok(retired.newMemory);
  for(const kind of kinds){const assessed=await get(baseline,kind);assert.equal(assessed.assessment,'stale');assert.equal(assessed.sources[0].currentMemory?.id,retired.newMemory.id);await assert.rejects(gate(baseline,kind),{code:'memory_dependency_stale'});}
  assert.deepEqual(await dependencyFixtureState(client,baseline),beforeBody);
  const changes=await client`SELECT * FROM brain_state_snapshots WHERE user_id=${userId} AND snapshot_type='memory_dependency_change' AND metadata->>'commandId'=${changeCommand}`;assert.equal(changes.length,1);
  await reviseBrainMemory({requester:owner,memoryId:baseline.memoryId,request:{commandId:changeCommand,expectedVersion:retired.receipt.previousVersion,operation:'correct',authority:'owner_statement',content:'新合成记忆：周二核对资料。',reason:'Matched original source correction',evidenceRefs:[]}});
  assert.deepEqual(await client`SELECT * FROM brain_state_snapshots WHERE id=${changes[0].id}`,changes);
  for(const kind of kinds){const stale=await get(baseline,kind);await bind(baseline,kind,request(stale,await refs(retired.newMemory.id)));assert.equal((await get(baseline,kind)).assessment,'current');}
  const impact=await listMemoryDependencyImpacts({requester:owner,sourceMemoryId:baseline.memoryId});assert.ok(!impact.items.some(item=>Object.values(baseline.entities).some(id=>id===item.entity.id)));
  const currentImpact=await listMemoryDependencyImpacts({requester:owner,sourceMemoryId:retired.newMemory.id});assert.equal(currentImpact.items.filter(item=>Object.values(baseline.entities).some(id=>id===item.entity.id)).length,3);

  const deactivated=await revise(retired.newMemory.id,{operation:'deactivate',content:undefined}),restored=await revise(deactivated.oldMemory.id,{operation:'restore',content:'明确恢复为新的合成有效版本。'});assert.ok(restored.newMemory);assert.notEqual(restored.newMemory.id,retired.newMemory.id);
  for(const kind of kinds)assert.equal((await get(baseline,kind)).assessment,'stale');
  for(const kind of kinds){await bind(baseline,kind,request(await get(baseline,kind),await refs(restored.newMemory.id)));assert.equal((await get(baseline,kind)).assessment,'current');}
  const edited=await fixture();await register(edited,'wiki_note');const oldEntity=await get(edited,'wiki_note');
  await client`UPDATE interaction_notes SET body='Owner changed the exact derived text',updated_at=now() WHERE id=${edited.entities.wiki_note}`;
  await assert.rejects(bind(edited,'wiki_note',request(oldEntity,await refs(edited.memoryId))),{code:'dependency_entity_conflict'});
  assert.equal((await get(edited,'wiki_note')).assessment,'stale');
  await client`UPDATE interaction_notes SET metadata=metadata||'{"deletedAt":"2026-10-02T10:00:00Z"}'::jsonb WHERE id=${edited.entities.wiki_note}`;
  await assert.rejects(bind(edited,'wiki_note',request(await get(edited,'wiki_note'),await refs(edited.memoryId))),{code:'dependency_target_unavailable'});
  const multiple=await fixture(),extraSource=await fixture();await bind(multiple,'wiki_note',request(await get(multiple,'wiki_note'),[...await refs(multiple.memoryId),...await refs(extraSource.memoryId)]));
  const replacement=await revise(multiple.memoryId);assert.ok(replacement.newMemory);
  await assert.rejects(bind(multiple,'wiki_note',request(await get(multiple,'wiki_note'),await refs(replacement.newMemory.id))),{code:'dependency_source_conflict'});
  await assert.rejects(bind(multiple,'wiki_note',request(await get(multiple,'wiki_note'),[...await refs(replacement.newMemory.id),...await refs(invalidFixture.memoryId)])),{code:'dependency_source_conflict'});

  const controls=await fixture();await register(controls,'interaction_task');await register(controls,'loop');const controlsVersion=(await get(controls,'loop')).entity.version;
  await actOnInteractionTask({userId,id:controls.entities.interaction_task,commandId:randomUUID(),expectedVersion:0,action:'confirmEvidence'});
  await actOnInteractionTask({userId,id:controls.entities.interaction_task,commandId:randomUUID(),expectedVersion:1,action:'completeTask'});
  assert.equal((await get(controls,'interaction_task')).assessment,'current');
  await client`UPDATE loop_states SET last_observation='New runtime heartbeat',state_json=state_json||'{"schedulerStatus":"idle","heartbeat":"observed"}'::jsonb,updated_at=now() WHERE loop_id=${controls.entities.loop}`;
  assert.equal((await get(controls,'loop')).entity.version,controlsVersion);assert.equal((await get(controls,'loop')).assessment,'current');
  await client`UPDATE loops SET status='paused' WHERE id=${controls.entities.loop}`;assert.equal((await get(controls,'loop')).assessment,'current');
  await client`UPDATE loops SET status='active' WHERE id=${controls.entities.loop}`;assert.equal((await get(controls,'loop')).entity.version,controlsVersion);
  await client`UPDATE interaction_tasks SET due_at='2030-01-01T00:00:00Z' WHERE id=${controls.entities.interaction_task}`;assert.equal((await get(controls,'interaction_task')).assessment,'stale');

  const captured=await fixture(),capturedSources=await refs(captured.memoryId);
  const createdNote=await createInteractionNote({userId,noteType:'summary',title:'Explicit captured note',body:'Captured derived body',sourceEventIds:[captured.eventId],memoryDependencies:capturedSources,memoryRequester:owner});
  const createdTask=await createInteractionTask({userId,title:'Explicit captured task',sourceEventIds:[captured.eventId],memoryDependencies:capturedSources,memoryRequester:owner});
  const createdLoop=await createLoop({userId,workshopId:captured.workId,name:'Explicit captured Loop',goal:'Synthetic only',triggerConfig:{type:'manual'},memoryDependencies:capturedSources,memoryRequester:owner});
  for(const [entityKind,entityId] of [['wiki_note',createdNote.id],['interaction_task',createdTask.id],['loop',createdLoop.id]] as const){const value=await getMemoryDependencies({requester:owner,entityKind,entityId});assert.equal(value.assessment,'current');assert.deepEqual(value.sources.map(s=>({memoryId:s.memoryId,expectedVersion:s.expectedVersion})),capturedSources);}
  const pack=await buildBrainContextPack({requester:owner,taskIntent:'Explicit captured source',memories:[await memory(captured.memoryId)],accessMode:'owner_override'});
  assert.equal(pack.items.find(item=>item.id===captured.memoryId)?.revisionVersion,capturedSources[0].expectedVersion);
  await revise(captured.memoryId);const beforeBadCreation=(await client`SELECT count(*)::int n FROM interaction_notes WHERE user_id=${userId}`)[0].n;
  await assert.rejects(createInteractionNote({userId,noteType:'summary',title:'Must roll back',body:'Stale basis',sourceEventIds:[captured.eventId],memoryDependencies:capturedSources,memoryRequester:owner}),{code:'dependency_source_conflict'});
  assert.equal((await client`SELECT count(*)::int n FROM interaction_notes WHERE user_id=${userId}`)[0].n,beforeBadCreation);

  const rollback=await fixture(),rollbackCommand=randomUUID(),rollbackBefore=await counts(),rollbackState=await memory(rollback.memoryId);
  await client.unsafe("CREATE FUNCTION reject_dependency_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot_type='memory_dependency_change' THEN RAISE EXCEPTION 'injected dependency change failure'; END IF; RETURN NEW; END $$");
  await client.unsafe('CREATE TRIGGER reject_dependency_change BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION reject_dependency_change()');
  try{await assert.rejects(revise(rollback.memoryId,{commandId:rollbackCommand}));}finally{await client.unsafe('DROP TRIGGER reject_dependency_change ON brain_state_snapshots');await client.unsafe('DROP FUNCTION reject_dependency_change()');}
  assert.deepEqual(await counts(),rollbackBefore);assert.deepEqual(await memory(rollback.memoryId),rollbackState);await revise(rollback.memoryId,{commandId:rollbackCommand});
  const registryRollback=await fixture(),registryCommand=request(await get(registryRollback,'wiki_note'),await refs(registryRollback.memoryId)),registryBefore=await counts();
  await client.unsafe("CREATE FUNCTION reject_dependency_registry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot_type='memory_dependency_registry' THEN RAISE EXCEPTION 'injected registry failure'; END IF; RETURN NEW; END $$");
  await client.unsafe('CREATE TRIGGER reject_dependency_registry BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION reject_dependency_registry()');
  try{await assert.rejects(bind(registryRollback,'wiki_note',registryCommand));}finally{await client.unsafe('DROP TRIGGER reject_dependency_registry ON brain_state_snapshots');await client.unsafe('DROP FUNCTION reject_dependency_registry()');}
  assert.deepEqual(await counts(),registryBefore);assert.equal((await get(registryRollback,'wiki_note')).coverage,'unknown');await bind(registryRollback,'wiki_note',registryCommand);

  const foreignSource=await fixture(),grantedTarget=await fixture(),grant=randomUUID(),model={type:'loop' as const,userId,id:grantedTarget.entities.loop,workId:grantedTarget.workId},grantSources=await refs(foreignSource.memoryId),captureCommand=randomUUID();
  const capture=()=>db.transaction(store=>captureMemoryDependenciesInTransaction(store,{requester:model,entityKind:'loop',entityId:grantedTarget.entities.loop,sources:grantSources,commandId:captureCommand,reason:'Explicit actual source capture'}));
  await assert.rejects(capture(),{code:'dependency_source_denied'});
  await client`INSERT INTO brain_access_grants(id,user_id,subject_type,subject_id,scope_type,scope_id,permissions,memory_types) VALUES (${grant},${userId},'loop',${model.id},'work',${foreignSource.workId},'["read"]'::jsonb,'["insight"]'::jsonb)`;
  const granted=await capture();assert.equal((await getMemoryDependencies({requester:model,entityKind:'loop',entityId:model.id})).assessment,'current');
  await client`DELETE FROM brain_access_grants WHERE id=${grant}`;const revokedCounts=await counts();
  const denied=await getMemoryDependencies({requester:model,entityKind:'loop',entityId:model.id});assert.equal(denied.assessment,'denied');assert.ok(denied.sources.every(source=>!source.oldMemory&&!source.currentMemory));
  await assert.rejects(capture(),{code:'dependency_source_denied'});await assert.rejects(gate(grantedTarget,'loop'),{code:'memory_dependency_stale'});assert.deepEqual(await counts(),revokedCounts);
  await client`INSERT INTO brain_access_grants(id,user_id,subject_type,subject_id,scope_type,scope_id,permissions,memory_types,expires_at) VALUES (${grant},${userId},'loop',${model.id},'work',${foreignSource.workId},'["read"]'::jsonb,'["insight"]'::jsonb,'2000-01-01T00:00:00Z')`;
  await assert.rejects(capture(),{code:'dependency_source_denied'});assert.deepEqual(await counts(),revokedCounts);
  await client`UPDATE brain_access_grants SET expires_at=NULL WHERE id=${grant}`;assert.deepEqual((await capture()).receipt,granted.receipt);assert.equal((await capture()).replayed,true);
  await bind(grantedTarget,'loop',request(await get(grantedTarget,'loop'),grantSources));

  const accepted=await fixture();await register(accepted,'wiki_note');const acceptedBase=await memory(accepted.memoryId),acceptedProposal=await proposeBrainMemoryUpdate({requester:owner,request:{targetMemoryId:accepted.memoryId,expectedVersion:getBrainMemoryRevisionVersion(acceptedBase),commandId:randomUUID(),content:'Owner-reviewed replacement',reason:'Real explicit proposal',evidenceRefs:[]}});
  await decideBrainMemoryUpdate({requester:owner,proposalId:acceptedProposal.candidate.id,request:{action:'accept',commandId:randomUUID(),expectedVersion:acceptedProposal.proposalVersion,expectedBaseVersion:acceptedProposal.baseVersion,reason:'Owner checked source and entity',evidenceConfirmed:true}});
  assert.equal((await get(accepted,'wiki_note')).assessment,'stale');

  const automatic=await fixture(),sourceId=randomUUID(),hash=(v:string)=>createHash('sha256').update(v).digest('hex');
  await client`INSERT INTO workshop_sources(id,workshop_id,type,name,enabled,config) VALUES (${sourceId},${automatic.workId},'file','synthetic.md',true,'{}')`;
  const conversion=async(value:string)=>{const eventId=randomUUID(),seq=Number((await client`SELECT coalesce(max(seq),0)::int n FROM workshop_events WHERE workshop_id=${automatic.workId}`)[0].n)+1,observedAt=new Date().toISOString();
    const input={userId,workId:automatic.workId,sourceId,sourceEventId:eventId,sourceEventSeq:seq,observedAt,sourceSha256:hash('source:'+value),documentSha256:hash('document:'+value),manifestSha256:hash('manifest:'+value),sourceFormat:'markdown',chunkCount:1,warnings:[] as string[]};
    await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title,metadata,created_at) VALUES (${eventId},${automatic.workId},${seq},'document_converted','synthetic program facts',${JSON.stringify({receiptAuthority:'runtime',sourceId,sourceSha256:input.sourceSha256,documentSha256:input.documentSha256,manifestSha256:input.manifestSha256,sourceFormat:input.sourceFormat,chunkCount:1,warnings:[]})}::jsonb,${observedAt})`;
    await client`INSERT INTO workshop_event_counters(workshop_id,last_seq) VALUES (${automatic.workId},${seq}) ON CONFLICT(workshop_id) DO UPDATE SET last_seq=EXCLUDED.last_seq`;return input;};
  const first=await applyDocumentMemoryUpdate(await conversion('A'));assert.ok(first.status==='created_active');await register(automatic,'wiki_note',first.memory.id);
  const noChangeBefore=(await counts()).changes,noop=await applyDocumentMemoryUpdate(await conversion('A'));assert.ok(noop.status==='noop');assert.equal((await counts()).changes,noChangeBefore);assert.equal((await get(automatic,'wiki_note')).assessment,'current');
  const newInput=await conversion('B'),changed=await applyDocumentMemoryUpdate(newInput);assert.ok(changed.status==='replaced_active');assert.equal((await get(automatic,'wiki_note')).assessment,'stale');
  const changedCount=(await counts()).changes;await applyDocumentMemoryUpdate(newInput);assert.equal((await counts()).changes,changedCount);

  const queued=await fixture();await register(queued,'loop');const command={userId,workId:queued.workId,loopId:queued.entities.loop,commandId:randomUUID(),source:'owner' as const,reason:'Synthetic queued dependency gate',expectedVersion:0,mode:'dry_run' as const,triggeredBy:'manual' as const,completionMode:'native' as const};
  const queuedRun=await acceptWorkLoopExecution(command);await revise(queued.memoryId);let executions=0;
  await assert.rejects(executeAcceptedWorkLoop(command,async()=>{executions++;return {status:'success',duration:0,output:'Synthetic only'};},undefined,{acceptedRunId:queuedRun.runId,workerId:'dependency-queued-fixture',leaseMs:120000}),{code:'memory_dependency_stale'});
  assert.equal(executions,0);assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${queuedRun.runId}`)[0].status,'needs_review');
  assert.equal((await client`SELECT phase FROM workshop_execution_leases WHERE workshop_id=${queued.workId}`)[0].phase,'needs_review');
  const preQueue=await fixture();await register(preQueue,'loop');await revise(preQueue.memoryId);const beforeRuns=(await client`SELECT count(*)::int n FROM workshop_runs WHERE workshop_id=${preQueue.workId}`)[0].n;
  await assert.rejects(acceptWorkLoopExecution({...command,workId:preQueue.workId,loopId:preQueue.entities.loop,commandId:randomUUID()}),{code:'memory_dependency_stale'});assert.equal((await client`SELECT count(*)::int n FROM workshop_runs WHERE workshop_id=${preQueue.workId}`)[0].n,beforeRuns);

  const guarded=await fixture();await register(guarded,'loop');const guardedCommand={...command,workId:guarded.workId,loopId:guarded.entities.loop,commandId:randomUUID()},guardedRun=await acceptWorkLoopExecution(guardedCommand);
  const claim=await claimWorkshopExecution({userId,workshopId:guarded.workId,runId:guardedRun.runId,workerId:'dependency-write-fixture',leaseMs:120000});assert.equal(claim.state,'claimed');assert.ok(claim.state==='claimed');
  await withExecutionContext(claim.lease,async()=>{
    await client`UPDATE brain_memories SET expires_at='2000-01-01T00:00:00Z' WHERE id=${guarded.memoryId}`;let writes=0;
    await assert.rejects(withExecutionBusinessWrite(claim.lease,async()=>{writes++;return true;}),{code:'memory_dependency_stale'});assert.equal(writes,0);
    const beforeBusiness=await counts();
    await assert.rejects(writeBrainMemory({requester:{type:'loop',userId,id:guarded.entities.loop,workId:guarded.workId},scope:{type:'work',workId:guarded.workId},ownerType:'work',ownerId:guarded.workId,memoryType:'insight',subject:'Must not write using expired basis',content:'Synthetic business write blocked by real execution lease',evidenceRefs:[`brain-observation:${guarded.observationId}`],canonicalGroupId:`protected:${randomUUID()}`}),{code:'memory_dependency_stale'});
    assert.deepEqual(await counts(),beforeBusiness);
    await renewExecutionLease(claim.lease,120000);await withExecutionWrite(claim.lease,async({append})=>append({workshopId:guarded.workId,runId:guardedRun.runId,type:'dependency_fixture_observed',title:'Raw observation remains writable'}));
    const blockedResult={status:'error' as const,duration:0,error:'Synthetic expired basis',result:{memoryDependencyBlocked:true}};
    await withExecutionWrite(claim.lease,async({db:store})=>store.execute(sql`UPDATE workshop_loop_executions SET result_json=${JSON.stringify(blockedResult)}::jsonb WHERE run_id=${guardedRun.runId}::uuid`));
    await finishWorkshopExecution(claim.lease,{status:'needs_review',summary:'Explicit stale-source fixture quarantine',loopResult:{loopId:guarded.entities.loop,result:blockedResult}});
  });
  const revokedCommand={...command,workId:grantedTarget.workId,loopId:grantedTarget.entities.loop,commandId:randomUUID()},revokedRun=await acceptWorkLoopExecution(revokedCommand);
  const revokedClaim=await claimWorkshopExecution({userId,workshopId:grantedTarget.workId,runId:revokedRun.runId,workerId:'dependency-revoked-fixture',leaseMs:120000});assert.ok(revokedClaim.state==='claimed');
  await client`DELETE FROM brain_access_grants WHERE id=${grant}`;
  await withExecutionContext(revokedClaim.lease,async()=>{
    const beforeBusiness=await counts();await assert.rejects(writeBrainMemory({requester:model,scope:{type:'work',workId:grantedTarget.workId},ownerType:'work',ownerId:grantedTarget.workId,memoryType:'insight',subject:'Revoked dependency must block',content:'Synthetic protected memory write must never be saved',evidenceRefs:[`brain-observation:${grantedTarget.observationId}`],canonicalGroupId:`revoked:${randomUUID()}`}),{code:'memory_dependency_stale'});assert.deepEqual(await counts(),beforeBusiness);
    const blockedResult={status:'error' as const,duration:0,error:'Synthetic revoked dependency'};
    await renewExecutionLease(revokedClaim.lease,120000);await withExecutionWrite(revokedClaim.lease,async({db:store})=>store.execute(sql`UPDATE workshop_loop_executions SET result_json=${JSON.stringify(blockedResult)}::jsonb WHERE run_id=${revokedRun.runId}::uuid`));
    await finishWorkshopExecution(revokedClaim.lease,{status:'needs_review',summary:'Revoked dependency quarantined',loopResult:{loopId:grantedTarget.entities.loop,result:blockedResult}});
  });
  const leasedFixture=async(target:Awaited<ReturnType<typeof fixture>>)=>{const input={...command,workId:target.workId,loopId:target.entities.loop,commandId:randomUUID()};const accepted=await acceptWorkLoopExecution(input),claim=await claimWorkshopExecution({userId,workshopId:target.workId,runId:accepted.runId,workerId:`dependency-busy-${randomUUID()}`,leaseMs:120000});assert.ok(claim.state==='claimed');return {runId:accepted.runId,lease:claim.lease};};
  const quarantine=async(target:Awaited<ReturnType<typeof fixture>>,active:Awaited<ReturnType<typeof leasedFixture>>)=>withExecutionContext(active.lease,async()=>{const result={status:'error' as const,duration:0,error:'Synthetic explicit busy-fixture audit'};await renewExecutionLease(active.lease,120000);await withExecutionWrite(active.lease,async({db:store})=>store.execute(sql`UPDATE workshop_loop_executions SET result_json=${JSON.stringify(result)}::jsonb WHERE run_id=${active.runId}::uuid`));await finishWorkshopExecution(active.lease,{status:'needs_review',summary:'Synthetic busy fixture quarantined',loopResult:{loopId:target.entities.loop,result}});});
  // A real owner revision holds canonical and waits for this leased gate's
  // source SHARE. The nested real proposal must fail busy and release its fence.
  const advisoryBusy=await fixture();await register(advisoryBusy,'loop');const advisoryLease=await leasedFixture(advisoryBusy),advisoryBase=await memory(advisoryBusy.memoryId),advisoryCommand=randomUUID();
  let sourceHeld!:()=>void,allowAttempt!:()=>void;const held=new Promise<void>(resolve=>{sourceHeld=resolve;}),attempt=new Promise<void>(resolve=>{allowAttempt=resolve;});
  const leasedProposal=withExecutionContext(advisoryLease.lease,()=>withExecutionBusinessWrite(advisoryLease.lease,async context=>{
    sourceHeld();await attempt;return withExecutionWriteContext(advisoryLease.lease,context,()=>proposeBrainMemoryUpdate({requester:{type:'loop',userId,id:advisoryBusy.entities.loop,workId:advisoryBusy.workId},request:{targetMemoryId:advisoryBase.id,expectedVersion:getBrainMemoryRevisionVersion(advisoryBase),commandId:advisoryCommand,content:'This conflicting proposal must roll back',reason:'Canonical lock contention fixture',evidenceRefs:[]}}));}));void leasedProposal.catch(()=>{});
  await held;const ownerRevision=revise(advisoryBusy.memoryId);void ownerRevision.catch(()=>{});
  try{await waitMemoryLocks(1);}finally{allowAttempt();}
  await assert.rejects(leasedProposal,{code:'memory_write_busy',status:409});const ownerResult=await ownerRevision;assert.ok(ownerResult.newMemory);
  assert.equal((await client`SELECT count(*)::int n FROM brain_memory_reviews WHERE user_id=${userId} AND metadata->>'commandId'=${advisoryCommand}`)[0].n,0);
  assert.equal((await client`SELECT count(*)::int n FROM brain_memories WHERE user_id=${userId} AND metadata->'updateProposal'->>'commandId'=${advisoryCommand}`)[0].n,0);await quarantine(advisoryBusy,advisoryLease);
  // Two actual Work leases consume A+B. Different canonical targets do not
  // protect against a SHARE->UPDATE cycle; NOWAIT must roll back the real write.
  const upgradeA=await fixture(),upgradeB=await fixture(),upgradeSources=[...await refs(upgradeA.memoryId),...await refs(upgradeB.memoryId)];
  for(const [target,other] of [[upgradeA,upgradeB],[upgradeB,upgradeA]])await client`INSERT INTO brain_access_grants(id,user_id,subject_type,subject_id,scope_type,scope_id,permissions,memory_types) VALUES (${randomUUID()},${userId},'loop',${target.entities.loop},'work',${other.workId},'["read"]'::jsonb,'["insight"]'::jsonb)`;
  for(const target of [upgradeA,upgradeB])await bind(target,'loop',request(await get(target,'loop'),upgradeSources));
  const upgradeLeaseA=await leasedFixture(upgradeA),upgradeLeaseB=await leasedFixture(upgradeB),upgradeBase=await memory(upgradeA.memoryId),upgradeCommand=randomUUID(),upgradeBefore=await counts();
  let firstHeld!:()=>void,tryUpgrade!:()=>void,secondHeld!:()=>void,releaseSecond!:()=>void;
  const firstReady=new Promise<void>(resolve=>{firstHeld=resolve;}),upgradeReady=new Promise<void>(resolve=>{tryUpgrade=resolve;}),secondReady=new Promise<void>(resolve=>{secondHeld=resolve;}),secondRelease=new Promise<void>(resolve=>{releaseSecond=resolve;});
  const firstWriter=withExecutionContext(upgradeLeaseA.lease,()=>withExecutionBusinessWrite(upgradeLeaseA.lease,async context=>{firstHeld();await upgradeReady;return withExecutionWriteContext(upgradeLeaseA.lease,context,()=>proposeBrainMemoryUpdate({requester:{type:'loop',userId,id:upgradeA.entities.loop,workId:upgradeA.workId},request:{targetMemoryId:upgradeA.memoryId,expectedVersion:getBrainMemoryRevisionVersion(upgradeBase),commandId:upgradeCommand,content:'Real row upgrade must fail explicitly',reason:'Two leased consumers share exact sources',evidenceRefs:[]}}));}));void firstWriter.catch(()=>{});await firstReady;
  const secondReader=withExecutionContext(upgradeLeaseB.lease,()=>withExecutionBusinessWrite(upgradeLeaseB.lease,async()=>{secondHeld();await secondRelease;return true;}));await secondReady;
  try{tryUpgrade();await assert.rejects(firstWriter,{code:'memory_write_busy',status:409});}finally{releaseSecond();await secondReader;}
  assert.deepEqual(await counts(),upgradeBefore);assert.equal((await get(upgradeA,'loop')).assessment,'current');assert.equal((await get(upgradeB,'loop')).assessment,'current');
  await quarantine(upgradeA,upgradeLeaseA);await quarantine(upgradeB,upgradeLeaseB);
  const chained=await fixture();await register(chained,'loop');const successor=await revise(chained.memoryId);assert.ok(successor.newMemory);
  let oldShared!:()=>void,readSuccessor!:()=>void;const oldReady=new Promise<void>(resolve=>{oldShared=resolve;}),successorReady=new Promise<void>(resolve=>{readSuccessor=resolve;});
  const chainedReader=db.transaction(async store=>{await store.execute(sql`SELECT id FROM brain_memories WHERE id=${chained.memoryId}::uuid FOR SHARE`);oldShared();await successorReady;return assertMemoryDependenciesCurrentInTransaction(store,{userId,entityKind:'loop',entityId:chained.entities.loop});});void chainedReader.catch(()=>{});await oldReady;
  const reverseWriter=client.begin(async transaction=>{await transaction`SELECT id FROM brain_memories WHERE id=${successor.newMemory!.id} FOR UPDATE`;await transaction`SELECT id FROM brain_memories WHERE id=${chained.memoryId} FOR UPDATE`;return true;});void reverseWriter.catch(()=>{});
  try{await waitMemoryLocks(1);}finally{readSuccessor();}
  await assert.rejects(chainedReader,{code:'memory_write_busy',status:409});assert.equal(await reverseWriter,true);assert.equal((await get(chained,'loop')).assessment,'stale');
  let typedCompleteCallbacks=0;
  for(const injected of [new MemoryDependencyError('memory_dependency_stale',409,'Synthetic typed callback failure'),new BrainMemoryWriteBusy()]){
    const typed=await fixture();await register(typed,'loop');const typedCommand={...command,workId:typed.workId,loopId:typed.entities.loop,commandId:randomUUID(),completionMode:'workshop' as const},typedRun=await acceptWorkLoopExecution(typedCommand);
    await assert.rejects(executeAcceptedWorkLoop(typedCommand,async()=>{throw injected;},async result=>{typedCompleteCallbacks++;return result;},{acceptedRunId:typedRun.runId,workerId:'dependency-typed-callback',leaseMs:120000}),{code:injected.code});
    assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${typedRun.runId}`)[0].status,'needs_review');assert.equal((await client`SELECT phase FROM workshop_execution_leases WHERE workshop_id=${typed.workId}`)[0].phase,'needs_review');
  }
  assert.equal(typedCompleteCallbacks,0);
  const native=await fixture();await client`UPDATE loops SET verification_config='{"type":"legacy_status","modelChecker":{"enabled":true}}'::jsonb WHERE id=${native.entities.loop}`;await register(native,'loop');
  const nativeCommand={...command,workId:native.workId,loopId:native.entities.loop,commandId:randomUUID()},nativeRun=await acceptWorkLoopExecution(nativeCommand),nativeBefore=(await client`SELECT memory_summary,next_action,state_json FROM loop_states WHERE loop_id=${native.entities.loop}`)[0];let localChecks=0;
  await assert.rejects(executeAcceptedWorkLoop(nativeCommand,controller=>runAcceptedNativeLoopOnce({userId,loopId:native.entities.loop,triggeredBy:'manual',modelChecker:{check:async()=>{localChecks++;await revise(native.memoryId);return {passed:true,feedback:'Synthetic local checker, no provider or model call'};}}},controller),undefined,{acceptedRunId:nativeRun.runId,workerId:'dependency-native-commit',leaseMs:120000}),{code:'memory_dependency_stale'});
  assert.equal(localChecks,1);const nativeAfter=(await client`SELECT memory_summary,next_action,state_json FROM loop_states WHERE loop_id=${native.entities.loop}`)[0];assert.equal(nativeAfter.memory_summary,nativeBefore.memory_summary);assert.notEqual(nativeAfter.state_json.lastOutcomeAction,'complete');
  assert.equal((await client`SELECT count(*)::int n FROM workshop_events WHERE run_id=${nativeRun.runId} AND type='loop_execution_result'`)[0].n,0);assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${nativeRun.runId}`)[0].status,'needs_review');
  const capturedActor=await fixture(),actorSource=await fixture(),actorGrant=randomUUID(),actorRun=randomUUID(),actorRequester={type:'work' as const,userId,id:capturedActor.workId},actorSources=await refs(actorSource.memoryId);
  await client`INSERT INTO brain_access_grants(id,user_id,subject_type,subject_id,scope_type,scope_id,permissions,memory_types) VALUES (${actorGrant},${userId},'work',${capturedActor.workId},'work',${actorSource.workId},'["reference"]'::jsonb,'["insight"]'::jsonb)`;
  const noteInput={userId,noteType:'summary' as const,title:'Model-captured exact basis',body:'Synthetic derived text, no model call',sourceEventIds:[capturedActor.eventId],metadata:{workshopId:capturedActor.workId},memoryDependencies:actorSources,memoryRequester:actorRequester};
  await assert.rejects(createInteractionNote(noteInput),{code:'dependency_not_allowed'});
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${actorRun},${capturedActor.workId},'queued')`;const actorClaim=await claimWorkshopExecution({userId,workshopId:capturedActor.workId,runId:actorRun,workerId:'dependency-capture-actor',leaseMs:120000});assert.ok(actorClaim.state==='claimed');
  const modelNote=await withExecutionContext(actorClaim.lease,()=>createInteractionNote(noteInput));
  const noteSnapshot=await getMemoryDependencies({requester:owner,entityKind:'wiki_note',entityId:modelNote.id});assert.equal(noteSnapshot.assessment,'current');
  const modelReviewed=await bindMemoryDependencies({requester:owner,entityKind:'wiki_note',entityId:modelNote.id,request:request(noteSnapshot,actorSources)});
  const persistedConsumer=(await client`SELECT metadata->'consumerRequester' consumer FROM brain_state_snapshots WHERE id=${modelReviewed.receipt.id}`)[0].consumer;
  assert.equal(persistedConsumer.type,'work');assert.equal(persistedConsumer.id,capturedActor.workId);
  await client`DELETE FROM brain_access_grants WHERE id=${actorGrant}`;const capturedDenied=await getMemoryDependencies({requester:owner,entityKind:'wiki_note',entityId:modelNote.id});assert.equal(capturedDenied.assessment,'denied');assert.ok(capturedDenied.sources.every(source=>!source.oldMemory&&!source.currentMemory));
  await assert.rejects(bindMemoryDependencies({requester:owner,entityKind:'wiki_note',entityId:modelNote.id,request:request(capturedDenied,actorSources)}),{code:'dependency_source_denied'});
  await withExecutionContext(actorClaim.lease,()=>finishWorkshopExecution(actorClaim.lease,{status:'completed',summary:'Synthetic capture fixture complete without external actions'}));
  const wikiTarget=await fixture(),legacyWiki=await fixture(),wikiRequester={type:'work' as const,userId,id:wikiTarget.workId};
  const loadedWiki=async(target:Awaited<ReturnType<typeof fixture>>)=>{const raw=await listInteractionWiki({userId,limit:200});return {...raw,notes:raw.notes.filter(row=>row.id===target.entities.wiki_note),tasks:raw.tasks.filter(row=>row.id===target.entities.interaction_task)};};
  const modelWiki=async(target:Awaited<ReturnType<typeof fixture>>,loaded=undefined as Awaited<ReturnType<typeof loadedWiki>>|undefined)=>{const raw=loaded??await loadedWiki(target),summaries=await getMemoryDependencySummariesForEntities({requester:wikiRequester,entities:getInteractionWikiMemoryEntities(raw)});assert.ok(Object.values(summaries).every(value=>!('sources' in value)&&!('memoryId' in value)));return projectInteractionWikiMemoryBasis(raw,summaries);};
  const unknownWiki=await modelWiki(legacyWiki);assert.equal(unknownWiki.notes[0].body,legacyWiki.body);assert.equal(unknownWiki.notes[0].memoryBasis.verified,false);assert.equal(unknownWiki.notes[0].memoryBasis.coverage,'unknown');
  await register(wikiTarget,'wiki_note');await register(wikiTarget,'interaction_task');const currentWiki=await modelWiki(wikiTarget);assert.equal(currentWiki.notes[0].body,wikiTarget.body);assert.equal(currentWiki.tasks[0].description,'原始合成待办说明。');assert.equal(currentWiki.notes[0].memoryBasis.verified,true);assert.equal(currentWiki.notes[0].memoryBasis.independentlyVerifiesCompleteness,false);
  const observedWiki=await loadedWiki(wikiTarget);await client`UPDATE interaction_notes SET body='Edited between actual wiki load and actual summary read' WHERE id=${wikiTarget.entities.wiki_note}`;const changedWiki=await modelWiki(wikiTarget,observedWiki);assert.equal(changedWiki.notes[0].memoryBasis.assessment,'stale');assert.equal(changedWiki.notes[0].body,undefined);assert.ok(changedWiki.notes[0].memoryBasis.reasons.includes('entity_version_changed'));
  await revise(wikiTarget.memoryId);const retiredWiki=await modelWiki(wikiTarget);for(const row of [...retiredWiki.notes,...retiredWiki.tasks]){assert.deepEqual(Object.keys(row).sort(),['id','memoryBasis','status']);assert.equal(row.memoryBasis.assessment,'stale');assert.equal(row.memoryBasis.contentAvailable,false);}
  const capturedWiki=await listInteractionWiki({userId,limit:200}),capturedModelWiki={...capturedWiki,notes:capturedWiki.notes.filter(row=>row.id===modelNote.id),tasks:[]};
  const deniedSummary=await getMemoryDependencySummariesForEntities({requester:actorRequester,entities:getInteractionWikiMemoryEntities(capturedModelWiki)}),deniedProjection=projectInteractionWikiMemoryBasis(capturedModelWiki,deniedSummary);assert.equal(deniedProjection.notes[0].memoryBasis.assessment,'denied');assert.deepEqual(Object.keys(deniedProjection.notes[0]).sort(),['id','memoryBasis','status']);
  return {name:'phase3 exact dependency registry/immutable source changes, unknown coverage, three target kinds, capture composition/current consumer permissions, dual versions/replay/rollback, pending conflict, restore/accept/automatic replacement, deterministic revision races and real leased gates/typed lock contention',passed:true,queuedExecutionCount:executions,registerRevisionOrderings:4,advisoryContentionTyped:true,sharedRowUpgradeTyped:true,successorReadContentionTyped:true,modelCaptureConsumerPreserved:true,typedCompleteCallbacks,nativeCommitPrevented:true,realWikiConsumptionProjection:true};
}
