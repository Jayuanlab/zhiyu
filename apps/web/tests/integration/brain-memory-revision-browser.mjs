import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {chromium,expect as baseExpect} from '@playwright/test';

const expect=baseExpect.configure({timeout:60000});

async function seedMemory(client,owner,options={}){
  const work=options.global?null:options.work??randomUUID(),id=randomUUID();
  if(work&&!options.work)await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'Memory revision fixture','Synthetic evidence only')`;
  const subject=options.subject??`Memory revision preference ${id}`;
  const content=options.content??'我喜欢早上收到简短日报。';
  const type=options.type??'preference';
  const status=options.status??'verified';
  const scope=options.global?'global':'work',ownerType=options.global?'chat':'work',memoryOwner=options.global?owner:work;
  const evidenceRef=`fixture:original-statement:${id}`;
  await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,evidence_refs,created_at,updated_at,metadata)
    VALUES (${id},${owner},${scope},${work},${ownerType},${memoryOwner},${type},${subject},${content},${status},90,${JSON.stringify([evidenceRef])}::jsonb,'2026-09-01T01:00:00Z','2026-09-01T01:00:00Z','{"observationTime":"2026-09-01T01:00:00Z"}'::jsonb)`;
  return {id,work,subject,content,type,status,evidenceRef};
}

function requestFor(origin){
  return async (route,body,method=body===undefined?'GET':'POST')=>{
    const response=await fetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
    const value=await response.json();return {status:response.status,value};
  };
}

export async function checkBrainMemoryRevisionHttp({client,owner,origin}){
  const request=requestFor(origin),fixture=await seedMemory(client,owner);
  const revisionPath=id=>`/api/brain/memories/${id}/revision`;
  const read=async id=>{const response=await request(revisionPath(id));assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
  const search=async query=>{const response=await request('/api/memory/search',{query,sources:['memory'],threshold:0,limit:30});assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
  const initial=await read(fixture.id);assert.equal(initial.memory.content,fixture.content);assert.ok(initial.expectedVersion);
  const before=await search(fixture.subject);assert.ok(before.results.some(item=>item.id===fixture.id));
  const cached=await search(fixture.subject);assert.equal(cached.cache.hit,true,'must create the real cached old result before correction');
  const command={commandId:randomUUID(),expectedVersion:initial.expectedVersion,operation:'correct',authority:'owner_statement',content:'更正：我喜欢晚上收到详细日报。',reason:'主人更正偏好，合成验收样本',evidenceRefs:['fixture:owner-correction']};
  const corrected=await request(revisionPath(fixture.id),command);assert.equal(corrected.status,200,JSON.stringify(corrected.value));
  const receipt=corrected.value;assert.equal(receipt.newMemory.status,'active');assert.equal(receipt.oldMemory.status,'superseded');assert.equal(receipt.oldMemory.content,fixture.content);
  assert.equal(receipt.receipt.status,'applied');assert.equal(receipt.receipt.effective,true);assert.equal(receipt.newMemory.content,command.content);
  const activeAuditCount=(await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${receipt.newMemory.id}`)[0].n;
  for(const decision of ['dismissed','rejected']){
    const legacyRetire=await request(`/api/brain/candidates/${receipt.newMemory.id}/review`,{decision,reason:'合成旧工具退役请求，不含版本保护'});
    assert.equal(legacyRetire.status,409,JSON.stringify(legacyRetire.value));assert.equal(legacyRetire.value.code,'memory_revision_required');
    const guardedRetire=await request(`/api/brain/candidates/${receipt.newMemory.id}/review`,{decision,expectedVersion:receipt.newMemory.revisionVersion,evidenceConfirmed:true,reason:'即便带核实参数也必须明确修订停用'});
    assert.equal(guardedRetire.status,409,JSON.stringify(guardedRetire.value));assert.equal(guardedRetire.value.code,'memory_revision_required');
  }
  assert.equal((await read(receipt.newMemory.id)).memory.status,'active');
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${receipt.newMemory.id}`)[0].n,activeAuditCount);
  assert.equal(new Date(receipt.newMemory.metadata.observationTime).toISOString(),'2026-09-01T01:00:00.000Z','correction time must not freshen the observation');
  const replayed=await request(revisionPath(fixture.id),command);assert.equal(replayed.status,200);assert.equal(replayed.value.replayed,true);assert.equal(replayed.value.newMemory.id,receipt.newMemory.id);
  const changedCommand=await request(revisionPath(fixture.id),{...command,content:'different payload'});assert.equal(changedCommand.status,409);assert.equal(changedCommand.value.code,'command_conflict');
  const after=await search(fixture.subject);assert.ok(after.results.some(item=>item.id===receipt.newMemory.id));assert.ok(!after.results.some(item=>item.id===fixture.id));
  assert.ok(!JSON.stringify(after.results).includes(fixture.content),'cached wrong content must not survive the correction');
  const oldStored=(await client`SELECT content,status,evidence_refs FROM brain_memories WHERE id=${fixture.id}`)[0];assert.equal(oldStored.content,fixture.content);assert.deepEqual(oldStored.evidence_refs,[fixture.evidenceRef]);assert.equal(oldStored.status,'superseded');

  const fact=await seedMemory(client,owner,{type:'fact',content:'交付日期已确定。'}),factCurrent=await read(fact.id);
  const factCommand={...command,commandId:randomUUID(),expectedVersion:factCurrent.expectedVersion,authority:'external_fact',content:'交付日期仍在讨论，尚未确认。'};
  const pending=await request(revisionPath(fact.id),factCommand);assert.equal(pending.status,200,JSON.stringify(pending.value));assert.equal(pending.value.newMemory.status,'candidate');assert.equal(pending.value.receipt.status,'pending_verification');assert.equal(pending.value.receipt.effective,false);
  const candidateAuditCount=(await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${pending.value.newMemory.id}`)[0].n;
  for(const decision of ['dismissed','rejected']){
    const legacyRetire=await request(`/api/brain/candidates/${pending.value.newMemory.id}/review`,{decision,reason:'合成候选旧审核退役请求'});
    assert.equal(legacyRetire.status,409,JSON.stringify(legacyRetire.value));assert.equal(legacyRetire.value.code,'memory_revision_required');
    const guardedRetire=await request(`/api/brain/candidates/${pending.value.newMemory.id}/review`,{decision,expectedVersion:pending.value.newMemory.revisionVersion,evidenceConfirmed:true,reason:'修订候选也必须明确停用'});
    assert.equal(guardedRetire.status,409,JSON.stringify(guardedRetire.value));assert.equal(guardedRetire.value.code,'memory_revision_required');
  }
  assert.equal((await read(pending.value.newMemory.id)).memory.status,'candidate');
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${pending.value.newMemory.id}`)[0].n,candidateAuditCount);
  const legacyCandidate=await seedMemory(client,owner,{work:fixture.work,status:'candidate',content:'未修订候选保留旧审核兼容。'});
  const legacyDismissed=await request(`/api/brain/candidates/${legacyCandidate.id}/review`,{decision:'dismissed',reason:'兼容旧候选审核'});assert.equal(legacyDismissed.status,200,JSON.stringify(legacyDismissed.value));assert.equal(legacyDismissed.value.memory.status,'deleted');
  const factSearch=await search(fact.subject);assert.ok(!factSearch.results.some(item=>[fact.id,pending.value.newMemory.id].includes(item.id)));
  const unsafeReview=await request(`/api/brain/candidates/${pending.value.newMemory.id}/review`,{decision:'confirmed',reason:'missing evidence/version'});assert.equal(unsafeReview.status,400);assert.equal(unsafeReview.value.code,'revision_verification_required');
  const candidateCurrent=await read(pending.value.newMemory.id);
  const approveInput={decision:'confirmed',expectedVersion:candidateCurrent.expectedVersion,evidenceConfirmed:true,reason:'核对隔离证据后确认'};
  const approvals=await Promise.all([request(`/api/brain/candidates/${pending.value.newMemory.id}/review`,approveInput),request(`/api/brain/candidates/${pending.value.newMemory.id}/review`,approveInput)]);
  assert.deepEqual(approvals.map(item=>item.status).sort(),[200,409]);assert.equal(approvals.find(item=>item.status===409).value.code,'version_conflict');assert.equal(approvals.find(item=>item.status===200).value.memory.status,'verified');
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${pending.value.newMemory.id} AND decision='confirmed'`)[0].n,1);
  const factVerified=await search(fact.subject);assert.ok(factVerified.results.some(item=>item.id===pending.value.newMemory.id),'verification invalidates the cached candidate omission');

  const simultaneous=await seedMemory(client,owner),simultaneousCurrent=await read(simultaneous.id);
  const same={...command,commandId:randomUUID(),expectedVersion:simultaneousCurrent.expectedVersion};
  const copies=await Promise.all([request(revisionPath(simultaneous.id),same),request(revisionPath(simultaneous.id),same)]);
  assert.deepEqual(copies.map(item=>item.status),[200,200]);assert.equal(copies[0].value.newMemory.id,copies[1].value.newMemory.id);
  assert.equal(copies.filter(item=>item.value.replayed).length,1);
  const competing=await seedMemory(client,owner),competingCurrent=await read(competing.id);
  const races=await Promise.all([request(revisionPath(competing.id),{...command,commandId:randomUUID(),expectedVersion:competingCurrent.expectedVersion}),request(revisionPath(competing.id),{...command,commandId:randomUUID(),expectedVersion:competingCurrent.expectedVersion,content:'另一份同时提交的偏好'})]);
  assert.deepEqual(races.map(item=>item.status).sort(),[200,409]);assert.equal(races.find(item=>item.status===409).value.code,'version_conflict');
  const changedState=await seedMemory(client,owner,{type:'relationship',content:'合作仍在讨论。'}),stateCurrent=await read(changedState.id);
  const stateChange=await request(revisionPath(changedState.id),{...command,commandId:randomUUID(),expectedVersion:stateCurrent.expectedVersion,operation:'state_change',content:'合作已结束。',sourceObservedAt:'2026-09-21T08:30:00Z'});
  assert.equal(stateChange.status,200,JSON.stringify(stateChange.value));assert.equal(stateChange.value.newMemory.metadata.observationTime,'2026-09-21T08:30:00.000Z');assert.equal(stateChange.value.oldMemory.content,changedState.content);

  const other=randomUUID();await client`INSERT INTO "User"(id,email) VALUES (${other},${other+'@example.invalid'})`;
  const foreign=await seedMemory(client,other),foreignStored=(await client`SELECT * FROM brain_memories WHERE id=${foreign.id}`)[0];
  assert.equal((await request(revisionPath(foreign.id))).status,404);
  assert.equal((await request(revisionPath(foreign.id),{...command,commandId:randomUUID()})).status,404);
  assert.deepEqual((await client`SELECT * FROM brain_memories WHERE id=${foreign.id}`)[0],foreignStored);

  const failed=await seedMemory(client,owner),failedCurrent=await read(failed.id),failedCommand={...command,commandId:randomUUID(),expectedVersion:failedCurrent.expectedVersion};
  const countBefore=(await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${owner}`)[0].n;
  await client.unsafe("CREATE FUNCTION reject_revision_observation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fixture observation failure'; END $$");
  await client.unsafe('CREATE TRIGGER reject_revision_observation_fixture BEFORE INSERT ON brain_observations FOR EACH ROW EXECUTE FUNCTION reject_revision_observation_fixture()');
  try{const failure=await request(revisionPath(failed.id),failedCommand);assert.equal(failure.status,500,JSON.stringify(failure.value));}
  finally{await client.unsafe('DROP TRIGGER reject_revision_observation_fixture ON brain_observations');await client.unsafe('DROP FUNCTION reject_revision_observation_fixture()');}
  assert.equal((await read(failed.id)).expectedVersion,failedCurrent.expectedVersion);assert.equal((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${owner}`)[0].n,countBefore);
  const recovered=await request(revisionPath(failed.id),failedCommand);assert.equal(recovered.status,200,JSON.stringify(recovered.value));assert.equal(recovered.value.replayed,false);

  const current=await read(receipt.newMemory.id);
  assert.ok(current.history.some(item=>item.id===fixture.id&&item.content===fixture.content));
  const undo=await request(revisionPath(receipt.newMemory.id),{...command,commandId:randomUUID(),expectedVersion:current.expectedVersion,content:fixture.content,reason:'撤销上次合成修订，保留完整历史'});assert.equal(undo.status,200);assert.notEqual(undo.value.newMemory.id,fixture.id);assert.notEqual(undo.value.newMemory.id,receipt.newMemory.id);assert.equal(undo.value.newMemory.content,fixture.content);
  const allVersions=await client`SELECT id,content,status FROM brain_memories WHERE id IN (${fixture.id},${receipt.newMemory.id},${undo.value.newMemory.id})`;assert.equal(allVersions.length,3);assert.equal(allVersions.filter(row=>row.status==='superseded').length,2);
  const undoCurrent=await read(undo.value.newMemory.id);
  assert.deepEqual(undoCurrent.history.map(item=>item.id),[receipt.newMemory.id,fixture.id]);
  const deactivated=await request(revisionPath(undo.value.newMemory.id),{commandId:randomUUID(),expectedVersion:undoCurrent.expectedVersion,operation:'deactivate',authority:'owner_statement',reason:'停用合成偏好',evidenceRefs:['fixture:deactivation']});assert.equal(deactivated.status,200);assert.equal(deactivated.value.oldMemory.status,'deleted');assert.equal(deactivated.value.newMemory,null);
  const workshopList=await request(`/api/workshops/${fixture.work}/memories`);assert.equal(workshopList.status,200);assert.ok(!workshopList.value.memories.some(item=>[fixture.id,receipt.newMemory.id,undo.value.newMemory.id].includes(item.id)));
  const deletedCurrent=await read(undo.value.newMemory.id);
  const restored=await request(revisionPath(undo.value.newMemory.id),{...command,commandId:randomUUID(),expectedVersion:deletedCurrent.expectedVersion,operation:'restore',content:fixture.content,reason:'误停用后恢复为新的有效版本'});assert.equal(restored.status,200,JSON.stringify(restored.value));assert.equal(restored.value.oldMemory.status,'superseded');assert.equal(restored.value.newMemory.status,'active');assert.notEqual(restored.value.newMemory.id,undo.value.newMemory.id);
  const supersededCurrent=await read(fixture.id);
  const oldRestore=await request(revisionPath(fixture.id),{...command,commandId:randomUUID(),expectedVersion:supersededCurrent.expectedVersion,operation:'restore',content:fixture.content});assert.equal(oldRestore.status,409);
  const restoredCurrent=await read(restored.value.newMemory.id);
  assert.equal((await request(revisionPath(restored.value.newMemory.id),{commandId:randomUUID(),expectedVersion:restoredCurrent.expectedVersion,operation:'deactivate',authority:'owner_statement',reason:'结束合成恢复样本',evidenceRefs:['fixture:done']})).status,200);
  return {name:'real isolated HTTP revision and next recall',passed:true,sameRankCorrection:true,oldContentPreserved:true,cacheInvalidated:true,verifiedPreferenceBecomesActive:true,factCandidateNeedsExplicitVerification:true,legacyRetirementRequiresRevision:true,concurrentVerificationSingleAudit:true,verificationCacheInvalidated:true,sameIdConcurrentReplay:true,conflictingReplayRejected:true,versionRaceSingleWinner:true,stateChangeObservationTime:true,correctionPreservesObservationTime:true,foreignOwnerDenied:true,observationFailureRollsBack:true,sameIdRecovery:true,undoCreatesThirdVersion:true,deactivationHiddenFromWorkshop:true,restoreCreatesNewVersion:true,supersededRestoreDenied:true};
}

export async function checkBrainMemoryRevisionBrowser({client,owner,origin,records}){
  const browser=await chromium.launch({headless:true});let page;
  const request=requestFor(origin),fixture=await seedMemory(client,owner),submitted=[],memoryResponses=[],pageErrors=[];
  let committed,routeError,first=true,summaryDelayed=false,summaryReleasedAt=null,firstMemoryRequestedAt=null;
  const milestones=[];
  const recordMilestone=name=>{milestones.push({name,at:new Date().toISOString()});fs.writeFileSync(path.join(records,'browser-progress.json'),JSON.stringify({fixture,milestones,initialLoadTiming:{summaryReleasedAt,firstMemoryRequestedAt}},null,2));};
  try{
    const list=await request(`/api/workshops/${fixture.work}/memories`);assert.equal(list.status,200,JSON.stringify(list.value));assert.ok(list.value.memories.some(item=>item.id===fixture.id),'browser fixture must be returned by the actual workshop memory API');
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);page.setDefaultTimeout(60000);
    page.on('pageerror',error=>pageErrors.push(error.message));
    page.on('request',request=>{if(request.url().endsWith(`/api/workshops/${fixture.work}/memories`)&&firstMemoryRequestedAt===null)firstMemoryRequestedAt=Date.now();});
    page.on('response',response=>{if(response.url().endsWith(`/api/workshops/${fixture.work}/memories`))void response.json().then(body=>memoryResponses.push(body)).catch(()=>{});});
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.route(`${origin}/api/page-state/workshop/${fixture.work}/summary**`,async route=>{
      if(summaryDelayed)return route.continue();
      summaryDelayed=true;const response=await route.fetch();await new Promise(resolve=>setTimeout(resolve,2000));
      summaryReleasedAt=Date.now();return route.fulfill({response});
    });
    const endpoint=`${origin}/api/brain/memories/${fixture.id}/revision`;
    await page.route(endpoint,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      try{
        submitted.push(route.request().postDataJSON());
        if(first){first=false;const response=await route.fetch();committed=await response.json();assert.equal(response.status(),200,JSON.stringify(committed));await route.abort('failed');return;}
        await route.continue();
      }catch(error){routeError=error;await route.abort().catch(()=>{});}
    });
    const navigate=async()=>{await page.goto(`${origin}/workshop?workId=${fixture.work}&tab=memory`);await expect(page.locator(`[data-workshop-id="${fixture.work}"]`)).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('button',{name:'刷新记忆',exact:true})).toBeEnabled();};
    const openCard=async id=>{await page.locator(`[data-memory-id="${id}"]`).getByRole('button',{name:'纠错与更新',exact:true}).click();await expect(page.getByRole('dialog',{name:'记忆纠错与更新'})).toBeVisible();};
    const dialog=()=>page.getByRole('dialog',{name:'记忆纠错与更新'});
    const fill=async (content,authority='owner_statement')=>{await expect(dialog().getByLabel('信息来源')).toBeEnabled();await dialog().getByLabel('信息来源').selectOption(authority);await dialog().getByLabel('新版本完整内容').fill(content);await dialog().getByLabel('修改理由').fill('桌面隔离验收：主人明确纠正');await dialog().getByLabel('来源引用，每行一条').fill('fixture:browser-correction');};
    await navigate();await openCard(fixture.id);assert.ok(summaryReleasedAt&&firstMemoryRequestedAt>=summaryReleasedAt,'initial memory loading waits for delayed matching summary, without manual refresh');recordMilestone('delayed summary automatic memory card loaded');await fill('我现在希望晚上收到简短日报。');
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();
    await expect.poll(()=>{if(routeError)throw routeError;return committed;}).toBeTruthy();
    await expect(dialog().getByRole('alert')).toContainText('暂未确认是否保存');
    await expect(dialog().getByLabel('新版本完整内容')).toBeDisabled();
    const savedPending=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),`memory-revision-pending:v1:${owner}`);assert.equal(savedPending.request.commandId,submitted[0].commandId);
    await page.reload();
    await expect(page.locator(`[data-memory-id="${fixture.id}"]`)).toHaveCount(0);
    const recovery=page.getByRole('region',{name:'记忆更新恢复'});await expect(recovery).toBeVisible();
    await recovery.getByRole('button',{name:'恢复记忆更新',exact:true}).click();
    await expect(dialog().getByRole('button',{name:'重试原提交',exact:true})).toBeEnabled();
    await page.screenshot({path:path.join(records,'desktop-response-lost-recovery.png'),fullPage:true});
    await dialog().getByRole('button',{name:'重试原提交',exact:true}).click();
    await expect(dialog().getByRole('status')).toContainText('已保存');
    assert.equal(submitted.length,2);assert.deepEqual(submitted[1],submitted[0]);
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE user_id=${owner} AND metadata->>'commandId'=${submitted[0].commandId}`)[0].n,1);
    await dialog().getByRole('button',{name:'查看新版本',exact:true}).click();
    await expect(dialog().getByText('我现在希望晚上收到简短日报。',{exact:true})).toBeVisible();
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();
    await expect(recovery).toHaveCount(0);assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),`memory-revision-pending:v1:${owner}`),null);
    await expect(page.locator(`[data-memory-id="${committed.newMemory.id}"]`)).toBeVisible();
    recordMilestone('revision committed response lost and recovered once');

    const fact=await seedMemory(client,owner,{work:fixture.work,type:'fact',content:'供应商已确认交付日期。'});
    await page.reload();await openCard(fact.id);await fill('供应商尚未确认交付日期。','external_fact');
    const factResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${origin}/api/brain/memories/${fact.id}/revision`&&response.status()===200);
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();const pending=await (await factResponse).json();
    await expect(dialog().getByRole('status')).toContainText('待核实');assert.equal(pending.receipt.effective,false);
    const pendingSearch=await request('/api/memory/search',{query:fact.subject,sources:['memory'],threshold:0});assert.ok(!pendingSearch.value.results.some(item=>item.id===pending.newMemory.id));
    await dialog().getByRole('button',{name:'查看新版本',exact:true}).click();
    await expect(dialog().getByRole('button',{name:'核实后启用',exact:true})).toBeDisabled();
    await dialog().getByRole('checkbox',{name:'我已核对以上来源与新内容，确认可以启用'}).check();
    await dialog().getByLabel('核实依据与理由').fill('已核对合成供应商回执，只有待讨论记录。');
    let firstReviewFailure=true;const reviewEndpoint=`${origin}/api/brain/candidates/${pending.newMemory.id}/review`;
    await page.route(reviewEndpoint,route=>{if(firstReviewFailure&&route.request().method()==='POST'){firstReviewFailure=false;return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'fixture review unavailable'})});}return route.continue();});
    await dialog().getByRole('button',{name:'核实后启用',exact:true}).click();
    await expect(dialog().getByRole('alert')).toContainText('暂未确认启用结果');
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${pending.newMemory.id} AND decision='confirmed'`)[0].n,0);
    await dialog().getByRole('button',{name:'核对启用结果',exact:true}).click();
    await expect(dialog().getByRole('alert')).toContainText('当前仍待核实');
    await expect(dialog().getByRole('checkbox',{name:'我已核对以上来源与新内容，确认可以启用'})).toBeEnabled();
    await expect(dialog().getByLabel('核实依据与理由')).toHaveValue('');
    await dialog().getByRole('checkbox',{name:'我已核对以上来源与新内容，确认可以启用'}).check();
    await dialog().getByLabel('核实依据与理由').fill('重新核对合成回执后确认当前待核实版本。');
    await dialog().getByRole('button',{name:'核实后启用',exact:true}).click();
    await expect(dialog().getByRole('alert')).toContainText('核实已保存');
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${pending.newMemory.id} AND decision='confirmed'`)[0].n,1);
    const factSearch=await request('/api/memory/search',{query:fact.subject,sources:['memory'],threshold:0});assert.ok(factSearch.value.results.some(item=>item.id===pending.newMemory.id));
    await page.screenshot({path:path.join(records,'desktop-candidate-verified.png'),fullPage:true});
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();
    recordMilestone('unknown uncommitted verification rechecked and confirmed once');

    const lostReview=await seedMemory(client,owner,{work:fixture.work,type:'fact',content:'核实回执丢失原始样本。'});
    await page.reload();await openCard(lostReview.id);await fill('核实回执丢失后的事实候选。','external_fact');
    const lostRevisionResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${origin}/api/brain/memories/${lostReview.id}/revision`&&response.status()===200);
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();const lostPending=await (await lostRevisionResponse).json();await expect(dialog().getByRole('status')).toContainText('待核实');
    await dialog().getByRole('button',{name:'查看新版本',exact:true}).click();await dialog().getByRole('checkbox',{name:'我已核对以上来源与新内容，确认可以启用'}).check();await dialog().getByLabel('核实依据与理由').fill('合成回执已核对，本次测试丢失成功响应。');
    let reviewCommitted,reviewRouteError;
    await page.route(`${origin}/api/brain/candidates/${lostPending.newMemory.id}/review`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      try{const response=await route.fetch();reviewCommitted=await response.json();assert.equal(response.status(),200,JSON.stringify(reviewCommitted));await route.abort('failed');}
      catch(error){reviewRouteError=error;await route.abort().catch(()=>{});}
    });
    await dialog().getByRole('button',{name:'核实后启用',exact:true}).click();await expect.poll(()=>{if(reviewRouteError)throw reviewRouteError;return reviewCommitted;}).toBeTruthy();await expect(dialog().getByRole('alert')).toContainText('暂未确认启用结果');
    await page.reload();const inlineReviewRecovery=page.getByRole('region',{name:'记忆核实恢复'});await expect(inlineReviewRecovery).toBeVisible();
    await inlineReviewRecovery.getByRole('button',{name:'恢复记忆核实',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('已核对当前版本');
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${lostPending.newMemory.id} AND decision='confirmed'`)[0].n,1);
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();await expect(inlineReviewRecovery).toHaveCount(0);
    if(await page.evaluate(key=>sessionStorage.getItem(key),`memory-revision-pending:v1:${owner}`)){
      await expect(recovery).toBeVisible();await recovery.getByRole('button',{name:'恢复记忆更新',exact:true}).click();
      await dialog().getByRole('button',{name:'重试原提交',exact:true}).click();await expect(dialog().getByRole('status')).toContainText('待核实');
      await dialog().getByRole('button',{name:'查看新版本',exact:true}).click();await expect(dialog().getByText('已核实',{exact:true})).toBeVisible();
      await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();
    }
    await expect(recovery).toHaveCount(0);
    recordMilestone('committed verification response lost and recovered after reload');

    const deferred=await seedMemory(client,owner,{work:fixture.work,type:'fact',content:'关闭后再核实的原始合成事实。'});
    await page.reload();await openCard(deferred.id);await fill('关闭后直接核实已有候选，不再修订。','external_fact');
    const deferredResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${origin}/api/brain/memories/${deferred.id}/revision`&&response.status()===200);
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();const deferredReceipt=await (await deferredResponse).json();
    await expect(dialog().getByRole('status')).toContainText('待核实');await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();
    assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),`memory-revision-pending:v1:${owner}`),null);
    let duplicateRevisionPosts=0,deferredReviewPosts=0,deferredReviewCommitted,deferredReviewRouteError;
    await page.route(`${origin}/api/brain/memories/${deferredReceipt.newMemory.id}/revision`,route=>{if(route.request().method()==='POST')duplicateRevisionPosts++;return route.continue();});
    await page.route(`${origin}/api/brain/candidates/${deferredReceipt.newMemory.id}/review`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      deferredReviewPosts++;try{const response=await route.fetch();deferredReviewCommitted=await response.json();assert.equal(response.status(),200,JSON.stringify(deferredReviewCommitted));await route.abort('failed');}
      catch(error){deferredReviewRouteError=error;await route.abort().catch(()=>{});}
    });
    await page.reload();await openCard(deferredReceipt.newMemory.id);
    await expect(dialog().getByRole('region',{name:'已有修订版本核实'})).toBeVisible();
    await dialog().getByLabel('新版本完整内容').fill('普通修订草稿不应因点击核实区完成按钮而发送。');await dialog().getByLabel('修改理由').fill('让普通表单有效，验证完成按钮无隐式提交。');
    await dialog().locator('form').evaluate(form=>{window.fixtureCandidateSubmitEvents=0;form.addEventListener('submit',()=>window.fixtureCandidateSubmitEvents++);});
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();await expect(dialog()).toHaveCount(0);
    assert.equal(await page.evaluate(()=>window.fixtureCandidateSubmitEvents),0);assert.equal(duplicateRevisionPosts,0);assert.equal(deferredReviewPosts,0);
    await openCard(deferredReceipt.newMemory.id);await expect(dialog().getByLabel('新版本完整内容')).toHaveValue(deferredReceipt.newMemory.content);
    await dialog().getByRole('checkbox',{name:'我已核对以上来源与新内容，确认可以启用'}).check();await dialog().getByLabel('核实依据与理由').fill('关闭后重新核对原候选的现有来源。');
    await dialog().getByRole('button',{name:'核实后启用',exact:true}).click();await expect.poll(()=>{if(deferredReviewRouteError)throw deferredReviewRouteError;return deferredReviewCommitted;}).toBeTruthy();await expect(dialog().getByRole('alert')).toContainText('暂未确认启用结果');
    const standaloneReview=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),`memory-revision-review-pending:v1:${owner}`);
    assert.equal(standaloneReview.kind,'memory_revision_review_pending.v1');assert.equal(standaloneReview.memoryId,deferredReceipt.newMemory.id);assert.equal(standaloneReview.ownerId,owner);assert.equal(standaloneReview.request,undefined);
    assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),`memory-revision-pending:v1:${owner}`),null);
    await page.reload();const reviewRecovery=page.getByRole('region',{name:'记忆核实恢复'});await expect(reviewRecovery).toBeVisible();
    await reviewRecovery.getByRole('button',{name:'恢复记忆核实',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('已核对当前版本');
    assert.equal(duplicateRevisionPosts,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE metadata->>'commandId'=${deferredReceipt.commandId}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${deferredReceipt.newMemory.id} AND decision='confirmed'`)[0].n,1);
    await page.screenshot({path:path.join(records,'desktop-existing-candidate-review-recovery.png'),fullPage:true});
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();await expect(reviewRecovery).toHaveCount(0);
    assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),`memory-revision-review-pending:v1:${owner}`),null);
    recordMilestone('closed candidate directly verified and standalone lost response recovered without revision');

    const retiredReview=await seedMemory(client,owner,{work:fixture.work,type:'fact',content:'未知审核期间退役的合成事实。'});
    const retiredReviewCurrent=(await request(`/api/brain/memories/${retiredReview.id}/revision`)).value;
    const retiredReviewRevision=await request(`/api/brain/memories/${retiredReview.id}/revision`,{commandId:randomUUID(),expectedVersion:retiredReviewCurrent.expectedVersion,operation:'correct',authority:'external_fact',content:'未知审核退役前的候选版本。',reason:'构造恢复扰动样本',evidenceRefs:['fixture:retired-review']});assert.equal(retiredReviewRevision.status,200);
    const retiredCandidateId=retiredReviewRevision.value.newMemory.id;
    await page.route(`${origin}/api/brain/candidates/${retiredCandidateId}/review`,route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'fixture review unavailable'})}));
    await page.reload();await openCard(retiredCandidateId);await dialog().getByRole('checkbox',{name:'我已核对以上来源与新内容，确认可以启用'}).check();await dialog().getByLabel('核实依据与理由').fill('此审核将收到未知响应，再由另一窗口退役。');
    await dialog().getByRole('button',{name:'核实后启用',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('暂未确认启用结果');
    const retireCandidateCurrent=(await request(`/api/brain/memories/${retiredCandidateId}/revision`)).value;
    const outsideRetire=await request(`/api/brain/memories/${retiredCandidateId}/revision`,{commandId:randomUUID(),expectedVersion:retireCandidateCurrent.expectedVersion,operation:'deactivate',authority:'owner_statement',reason:'另一窗口明确停用候选',evidenceRefs:['fixture:outside-retire']});assert.equal(outsideRetire.status,200);assert.equal(outsideRetire.value.oldMemory.status,'deleted');
    await dialog().getByRole('button',{name:'核对启用结果',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('原审核结果');
    assert.ok(await page.evaluate(key=>sessionStorage.getItem(key),`memory-revision-review-pending:v1:${owner}`),'retired current state must not silently clear unknown review');
    await dialog().getByRole('button',{name:'关闭并结束此次核实恢复',exact:true}).click();await expect(dialog()).toHaveCount(0);
    assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),`memory-revision-review-pending:v1:${owner}`),null);
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${retiredCandidateId} AND decision='confirmed'`)[0].n,0);
    const released=await seedMemory(client,owner,{work:fixture.work,content:'结束无效审核恢复后继续操作。'});
    await page.reload();await openCard(released.id);await fill('已解除无效审核锁，可以保存新修订。');
    const releasedResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${origin}/api/brain/memories/${released.id}/revision`&&response.status()===200);
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();const releasedReceipt=await (await releasedResponse).json();await expect(dialog().getByRole('status')).toContainText('已保存');assert.equal(releasedReceipt.newMemory.status,'active');
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();recordMilestone('retired unknown review explicitly ended and later revision saved');

    const timedOut=await seedMemory(client,owner,{work:fixture.work,content:'请求超时恢复合成样本。'}),timeoutRequests=[];let hangFirst=true;
    await page.route(`${origin}/api/brain/memories/${timedOut.id}/revision`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      timeoutRequests.push(route.request().postDataJSON());
      if(hangFirst){hangFirst=false;await new Promise(resolve=>setTimeout(resolve,2000));await route.abort('timedout').catch(()=>{});return;}
      return route.continue();
    });
    await page.reload();await openCard(timedOut.id);await fill('超时后使用原命令恢复。');
    await page.evaluate(()=>{const original=AbortSignal.timeout;AbortSignal.timeout=function(milliseconds){return original.call(AbortSignal,milliseconds===30_000?200:milliseconds);};});
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();
    await expect(dialog().getByRole('alert')).toContainText('暂未确认是否保存');
    assert.equal((await client`SELECT status FROM brain_memories WHERE id=${timedOut.id}`)[0].status,'verified');
    await page.reload();await expect(recovery).toBeVisible();await recovery.getByRole('button',{name:'恢复记忆更新',exact:true}).click();
    await dialog().getByRole('button',{name:'重试原提交',exact:true}).click();await expect(dialog().getByRole('status')).toContainText('已保存');
    assert.equal(timeoutRequests.length,2);assert.deepEqual(timeoutRequests[1],timeoutRequests[0]);
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE metadata->>'commandId'=${timeoutRequests[0].commandId}`)[0].n,1);
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();await expect(recovery).toHaveCount(0);
    recordMilestone('timed out revision recovered with original command');

    const conflict=await seedMemory(client,owner,{work:fixture.work,content:'冲突样本原正文。'});
    await page.reload();await openCard(conflict.id);await fill('保留的未提交修改草稿。');
    const current=(await request(`/api/brain/memories/${conflict.id}/revision`)).value;
    const replacement=await request(`/api/brain/memories/${conflict.id}/revision`,{commandId:randomUUID(),expectedVersion:current.expectedVersion,operation:'correct',authority:'owner_statement',content:'另一个已提交版本。',reason:'合成并发修订',evidenceRefs:['fixture:concurrent']});assert.equal(replacement.status,200);
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('当前版本或提交记录已变化');
    await expect(dialog().getByLabel('新版本完整内容')).toHaveValue('保留的未提交修改草稿。');
    await dialog().getByRole('button',{name:'刷新当前记忆',exact:true}).click();
    await expect(dialog().getByRole('button',{name:'保存更新',exact:true})).toBeDisabled();
    await dialog().getByRole('button',{name:'读取当前替代版本',exact:true}).click();
    await expect(dialog().getByText('另一个已提交版本。',{exact:true})).toBeVisible();
    await expect(dialog().getByLabel('新版本完整内容')).toHaveValue('保留的未提交修改草稿。');
    await expect(dialog().getByRole('button',{name:'保存更新',exact:true})).toBeEnabled();
    await page.keyboard.press('Escape');await expect(dialog()).toHaveCount(0);
    recordMilestone('version conflict preserved draft and read current replacement');

    const malformed=await seedMemory(client,owner,{work:fixture.work,content:'错误回执样本。'}),malformedRequests=[];let inject=true;
    const malformedCurrent=(await request(`/api/brain/memories/${malformed.id}/revision`)).value;
    const malformedEndpoint=`${origin}/api/brain/memories/${malformed.id}/revision`;
    await page.route(malformedEndpoint,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      malformedRequests.push(route.request().postDataJSON());
      if(inject){inject=false;const input=malformedRequests.at(-1),newId=randomUUID(),oldVersion=`bmrv1:${'1'.repeat(64)}`,newVersion=`bmrv1:${'2'.repeat(64)}`;
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({commandId:input.commandId,operation:input.operation,replayed:false,oldMemory:{...malformedCurrent.memory,status:'superseded',revisionVersion:oldVersion},newMemory:{...malformedCurrent.memory,id:newId,status:'active',content:'正文与本次提交不一致。',revisionVersion:newVersion},receipt:{id:randomUUID(),commandId:input.commandId,status:'applied',effective:true,previousVersion:input.expectedVersion,currentVersion:oldVersion,newVersion,oldMemoryId:malformed.id,newMemoryId:newId,createdAt:new Date().toISOString()}})});}
      return route.continue();
    });
    await page.reload();await openCard(malformed.id);await fill('错误回执不代表已保存。');
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('暂未确认是否保存');
    assert.equal((await client`SELECT status FROM brain_memories WHERE id=${malformed.id}`)[0].status,'verified');
    await dialog().getByRole('button',{name:'重试原提交',exact:true}).click();await expect(dialog().getByRole('status')).toContainText('已保存');
    assert.equal(malformedRequests.length,2);assert.deepEqual(malformedRequests[0],malformedRequests[1]);
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();
    recordMilestone('malformed successful receipt rejected and original command retried');

    const blocked=await seedMemory(client,owner,{work:fixture.work,content:'恢复记录写失败样本。'});let blockedRequests=0;
    await page.route(`${origin}/api/brain/memories/${blocked.id}/revision`,route=>{if(route.request().method()==='POST')blockedRequests++;return route.continue();});
    await page.reload();await openCard(blocked.id);await fill('存储故障期间不能发送。');
    await page.evaluate(()=>{const write=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('memory-revision-pending:'))throw Error('Fixture session storage offline');return write.call(this,key,value);};});
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('本次更新未发送');assert.equal(blockedRequests,0);
    await page.reload();await openCard(blocked.id);await fill('身份变化后不能发送。');
    await page.route(`${origin}/api/identity`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({actorId:randomUUID()})}));
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();await expect(dialog()).toHaveCount(0);assert.equal(blockedRequests,0);
    await page.unroute(`${origin}/api/identity`);
    recordMilestone('storage failure and identity change prevented writes');

    await page.reload();
    const trigger=page.locator(`[data-memory-id="${committed.newMemory.id}"]`).getByRole('button',{name:'纠错与更新',exact:true});
    await trigger.focus();await page.keyboard.press('Enter');await expect(dialog()).toBeVisible();await expect(dialog().getByLabel('新版本完整内容')).toBeEnabled();
    await page.keyboard.press('Tab');assert.equal(await dialog().evaluate(element=>element.contains(document.activeElement)),true);
    await page.setViewportSize({width:1024,height:768});
    const readDialogGeometry=()=>dialog().evaluate(element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight,maxHeight:style.maxHeight,overflowY:style.overflowY,position:style.position,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,scrollTop:element.scrollTop};});
    const geometry={initial:await readDialogGeometry()};
    const saveGeometry=()=>fs.writeFileSync(path.join(records,'desktop-1024-geometry.json'),JSON.stringify(geometry,null,2));saveGeometry();
    await expect.poll(async()=>{const current=await readDialogGeometry();geometry.stable=current;saveGeometry();return current.left>=-1&&current.right<=current.viewportWidth+1&&current.top>=-1&&current.bottom<=current.viewportHeight+1;},{timeout:5000}).toBe(true);
    assert.ok(geometry.stable.scrollWidth<=geometry.stable.clientWidth+2);assert.ok(['auto','scroll'].includes(geometry.stable.overflowY));
    const saveButton=dialog().getByRole('button',{name:'保存更新',exact:true});await saveButton.scrollIntoViewIfNeeded();await saveButton.click({trial:true});
    geometry.saveButton=await saveButton.boundingBox();geometry.atSave=await readDialogGeometry();saveGeometry();
    assert.ok(geometry.saveButton.y>=0&&geometry.saveButton.y+geometry.saveButton.height<=geometry.atSave.viewportHeight+1);assert.ok(geometry.atSave.scrollTop>geometry.stable.scrollTop,'the overflowing modal must scroll to its save action');
    await page.screenshot({path:path.join(records,'desktop-1024-save-reachable.png'),fullPage:true});
    const closeButton=dialog().getByRole('button',{name:'Close',exact:true});await closeButton.scrollIntoViewIfNeeded();await closeButton.click({trial:true});
    geometry.closeButton=await closeButton.boundingBox();geometry.atClose=await readDialogGeometry();saveGeometry();
    assert.ok(geometry.closeButton.y>=0&&geometry.closeButton.y+geometry.closeButton.height<=geometry.atClose.viewportHeight+1);
    await page.screenshot({path:path.join(records,'desktop-1024-keyboard.png'),fullPage:true});
    await page.keyboard.press('Escape');await expect(dialog()).toHaveCount(0);
    recordMilestone('desktop keyboard focus and 1024 viewport verified');
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(origin+'/memory');await expect(page.getByRole('heading',{name:'统一记忆召回',exact:true})).toBeVisible();
    await page.getByRole('textbox',{name:'召回需求',exact:true}).fill(fixture.subject);await page.getByRole('button',{name:'开始召回',exact:true}).click();
    // Match the visible UUID code inside the actual search result article.
    const articleFor=id=>page.locator('article').filter({has:page.getByText(id,{exact:true})});
    await expect(articleFor(committed.newMemory.id)).toBeVisible();await articleFor(committed.newMemory.id).getByRole('button',{name:'纠错与更新',exact:true}).click();
    await expect(dialog().getByLabel('新版本完整内容')).toBeEnabled();
    await dialog().getByText(/^查看历史版本/).click();await dialog().getByRole('button',{name:'采用该历史正文',exact:true}).click();
    await expect(dialog().getByLabel('新版本完整内容')).toHaveValue(fixture.content);
    await dialog().getByLabel('修改理由').fill('桌面统一记忆入口恢复采用历史正文，保存新版本。');
    const historyResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${origin}/api/brain/memories/${committed.newMemory.id}/revision`&&response.status()===200);
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();const historical=await (await historyResponse).json();
    await expect(dialog().getByRole('status')).toContainText('已保存');assert.notEqual(historical.newMemory.id,fixture.id);assert.notEqual(historical.newMemory.id,committed.newMemory.id);assert.equal(historical.newMemory.content,fixture.content);
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();await expect(articleFor(historical.newMemory.id)).toBeVisible();await expect(articleFor(committed.newMemory.id)).toHaveCount(0);
    await articleFor(historical.newMemory.id).getByRole('button',{name:'纠错与更新',exact:true}).click();await expect(dialog().getByLabel('更新方式')).toBeEnabled();
    await dialog().getByLabel('更新方式').selectOption('deactivate');await dialog().getByLabel('修改理由').fill('合成误停用样本，用最近停用入口恢复。');
    const offResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${origin}/api/brain/memories/${historical.newMemory.id}/revision`&&response.status()===200);
    await dialog().getByRole('button',{name:'保存并停用',exact:true}).click();const stopped=await (await offResponse).json();assert.equal(stopped.oldMemory.status,'deleted');
    await expect(dialog().getByRole('status')).toContainText('已停用');await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();await expect(articleFor(historical.newMemory.id)).toHaveCount(0);
    await page.getByRole('button',{name:'查看最近停用记忆',exact:true}).click();
    await page.locator(`article[data-memory-id="${historical.newMemory.id}"]`).getByRole('button',{name:'恢复为新版本',exact:true}).click();await expect(dialog().getByLabel('更新方式')).toHaveValue('restore');
    await dialog().getByLabel('修改理由').fill('确认误停用，恢复为新记忆而不复活历史版本。');
    const restoreResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${origin}/api/brain/memories/${historical.newMemory.id}/revision`&&response.status()===200);
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();const restored=await (await restoreResponse).json();assert.equal(restored.operation,'restore');assert.notEqual(restored.newMemory.id,historical.newMemory.id);
    await expect(dialog().getByRole('status')).toContainText('已保存');await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();await expect(articleFor(restored.newMemory.id)).toBeVisible();
    assert.equal((await client`SELECT status FROM brain_memories WHERE id=${historical.newMemory.id}`)[0].status,'superseded');
    await page.screenshot({path:path.join(records,'desktop-unified-history-restore.png'),fullPage:true});
    recordMilestone('unified memory historical body adoption and new-id restore verified');

    const globalFact=await seedMemory(client,owner,{global:true,type:'fact',subject:`统一全局交付核实 ${randomUUID()}`,content:'全局事实原结论，等待合成纠错。'});
    await page.getByRole('textbox',{name:'召回需求',exact:true}).fill(globalFact.subject);await page.getByRole('button',{name:'开始召回',exact:true}).click();
    await expect(articleFor(globalFact.id)).toBeVisible();await articleFor(globalFact.id).getByRole('button',{name:'纠错与更新',exact:true}).click();await fill('全局事实已更正，但需主人稍后核实。','external_fact');
    const globalRevisionResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${origin}/api/brain/memories/${globalFact.id}/revision`&&response.status()===200);
    await dialog().getByRole('button',{name:'保存更新',exact:true}).click();const globalPending=await (await globalRevisionResponse).json();assert.equal(globalPending.newMemory.scope.type,'global');assert.equal(globalPending.newMemory.ownerType,'chat');
    await expect(dialog().getByRole('status')).toContainText('待核实');await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();
    assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),`memory-revision-pending:v1:${owner}`),null);await expect(articleFor(globalFact.id)).toHaveCount(0);await expect(articleFor(globalPending.newMemory.id)).toHaveCount(0);
    let globalExtraRevisions=0;await page.route(`${origin}/api/brain/memories/${globalPending.newMemory.id}/revision`,route=>{if(route.request().method()==='POST')globalExtraRevisions++;return route.continue();});
    await page.reload();await page.getByRole('button',{name:'查看待核实修订',exact:true}).click();
    const globalCandidateCard=page.getByRole('region',{name:'待核实修订列表'}).locator(`[data-memory-id="${globalPending.newMemory.id}"]`);
    await expect(globalCandidateCard).toBeVisible();await globalCandidateCard.getByRole('button',{name:'核实已有版本',exact:true}).click();await expect(dialog().getByRole('region',{name:'已有修订版本核实'})).toBeVisible();
    await dialog().getByRole('checkbox',{name:'我已核对以上来源与新内容，确认可以启用'}).check();await dialog().getByLabel('核实依据与理由').fill('从统一入口核对原全局候选来源，没有车间卡片。');
    await dialog().getByRole('button',{name:'核实后启用',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('核实已保存');
    assert.equal(globalExtraRevisions,0);assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE metadata->>'commandId'=${globalPending.commandId}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${globalPending.newMemory.id} AND decision='confirmed'`)[0].n,1);
    await dialog().getByRole('button',{name:'完成并刷新列表',exact:true}).click();await expect(globalCandidateCard).toHaveCount(0);
    await page.getByRole('textbox',{name:'召回需求',exact:true}).fill(globalFact.subject);await page.getByRole('button',{name:'开始召回',exact:true}).click();await expect(articleFor(globalPending.newMemory.id)).toBeVisible();await expect(articleFor(globalFact.id)).toHaveCount(0);
    await page.screenshot({path:path.join(records,'desktop-unified-global-candidate-verified.png'),fullPage:true});recordMilestone('unified non-work candidate found after close and directly verified once');
    return {name:'desktop browser memory revision and durable recovery',passed:true,realRevisionHttp:true,fixtureWorkshopSelected:true,delayedSummaryAutomaticMemoryLoaded:true,initialLoadTiming:{summaryReleasedAt,firstMemoryRequestedAt},responseLostAfterCommit:true,reloadRestoresPendingWithoutOldCard:true,retrySameId:true,oneRevisionReceipt:true,receiptClearsRecovery:true,candidateStateVisible:true,explicitEvidenceVerification:true,unknownReviewCurrentCandidateAllowsRecheck:true,lostCommittedReviewVerifiedAfterReload:true,closedCandidateDirectVerification:true,completionDoesNotImplicitlySubmitDraft:true,standaloneReviewRecoveryWithoutRevision:true,retiredUnknownReviewExplicitlyEnds:true,oneVerificationAudit:true,timeoutRecoversSameCommand:true,nextRecallUsesNewId:true,conflictPreservesDraft:true,readsReplacementVersion:true,malformedReceiptDoesNotSucceed:true,storageFailurePreventsSend:true,identityChangePreventsSend:true,desktop1440And1024:true,keyboardOpenFocusAndClose:true,unifiedMemoryEntry:true,historyAdoptionCreatesThirdVersion:true,recentDeactivationRestoresNewId:true,unifiedNonWorkCandidateDirectVerification:true};
  }catch(error){if(page){await page.screenshot({path:path.join(records,'browser-failure.png'),fullPage:true}).catch(()=>{});const dom=await page.evaluate(()=>({url:location.href,memoryIds:[...document.querySelectorAll('[data-memory-id]')].map(item=>item.getAttribute('data-memory-id')),workshops:[...document.querySelectorAll('[data-workshop-id]')].map(item=>({id:item.getAttribute('data-workshop-id'),selected:item.getAttribute('aria-pressed')})),buttons:[...document.querySelectorAll('button')].map(item=>item.textContent),text:document.body.innerText})).catch(()=>null);fs.writeFileSync(path.join(records,'browser-diagnostics.json'),JSON.stringify({fixture,memoryResponses,pageErrors,dom},null,2));}throw error;}
  finally{await browser.close();}
}
