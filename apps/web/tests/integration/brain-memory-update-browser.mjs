import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
const hash=text=>createHash('sha256').update(text).digest('hex');
function requestFor(origin){return async(route,body)=>{const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});return {status:response.status,value:await response.json()};};}
async function seed(client,owner,{global=false,work,subject,sourceContent='原始合成来源，独立于模型解释。',status='active'}={}){
  const id=randomUUID(),observationId=randomUUID(),name=subject??`独立记忆提案 ${id}`;
  const workId=global?null:work??randomUUID();
  if(workId&&!work)await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${owner},${name},'Synthetic memory update acceptance')`;
  await client`INSERT INTO brain_observations(id,user_id,source_type,source_id,observed_at,content,content_hash,metadata) VALUES (${observationId},${owner},'update_browser_fixture',${id},now(),${sourceContent},${hash(sourceContent)},'{}')`;
  const evidenceRef=`brain-observation:${observationId}`,scope=global?'global':'work',ownerType=global?'chat':'work',memoryOwner=global?owner:workId;
  const metadata={canonicalGroupId:`browser-update:${id}`,observationTime:new Date().toISOString()};
  await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,evidence_refs,metadata,created_at,updated_at) VALUES (${id},${owner},${scope},${workId},${ownerType},${memoryOwner},'insight',${name},'原来的理解，继续有效直到主人接受提案。',${status},90,${JSON.stringify([evidenceRef])}::jsonb,${JSON.stringify(metadata)}::jsonb,now(),now())`;
  return {id,work:workId,subject:name,evidenceRef};
}
async function propose(request,fixture,extra={}){const current=await request(`/api/brain/memories/${fixture.id}/revision`);assert.equal(current.status,200,JSON.stringify(current.value));const payload={targetMemoryId:fixture.id,expectedVersion:current.value.expectedVersion,commandId:randomUUID(),content:'新的理解，需核对来源后由主人决定。',reason:'合成新证据与当前理解不同',evidenceRefs:['fixture:unresolved-source'],...extra};const proposal=await request('/api/brain/memory-updates',payload);assert.equal(proposal.status,200,JSON.stringify(proposal.value));return {payload,...proposal.value};}
const decision=(proposal,extra={})=>({action:'accept',commandId:randomUUID(),expectedVersion:proposal.proposalVersion,expectedBaseVersion:proposal.baseVersion,reason:'合成验收：主人核对实际来源',evidenceConfirmed:true,...extra});

export async function checkBrainMemoryUpdateHttp({client,owner,origin,records}){
  const request=requestFor(origin),fixture=await seed(client,owner);
  const search=async()=>{const response=await request('/api/memory/search',{query:fixture.subject,sources:['memory'],threshold:0,limit:30});assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
  assert.ok((await search()).results.some(memory=>memory.id===fixture.id));assert.equal((await search()).cache.hit,true);
  const proposal=await propose(request,fixture);
  assert.equal(proposal.candidate.status,'candidate');assert.equal(proposal.base.status,'active');
  const whilePending=await search();assert.ok(whilePending.results.some(memory=>memory.id===fixture.id));assert.ok(!whilePending.results.some(memory=>memory.id===proposal.candidate.id));
  assert.equal(whilePending.results.find(memory=>memory.id===fixture.id).metadata.pendingMemoryUpdate.requiresOwnerDecision,true);assert.ok(whilePending.results.find(memory=>memory.id===fixture.id).metadata.warnings.includes('memory_update_pending'));
  const view=await request(`/api/brain/memory-updates/${proposal.candidate.id}`);assert.equal(view.status,200);assert.equal(view.value.proposal.status,'pending');
  const evidence=await request(`/api/brain/memory-updates/evidence?proposalId=${proposal.candidate.id}`);assert.equal(evidence.status,200,JSON.stringify(evidence.value));
  assert.ok(evidence.value.sources.some(source=>source.id===fixture.evidenceRef&&source.status==='resolved'&&source.content.includes('独立于模型解释')));
  assert.ok(evidence.value.sources.some(source=>source.status==='unresolved'&&source.content===null&&source.warning));
  for(const legacyDecision of ['confirmed','dismissed','rejected']){const legacy=await request(`/api/brain/candidates/${proposal.candidate.id}/review`,{decision:legacyDecision,expectedVersion:proposal.proposalVersion,evidenceConfirmed:true,reason:'不能绕过提案审核'});assert.equal(legacy.status,409);assert.equal(legacy.value.code,'memory_update_decision_required');}
  const acceptedRequest=decision(proposal),copies=await Promise.all([request(`/api/brain/memory-updates/${proposal.candidate.id}/decision`,acceptedRequest),request(`/api/brain/memory-updates/${proposal.candidate.id}/decision`,acceptedRequest)]);
  assert.deepEqual(copies.map(result=>result.status),[200,200]);assert.equal(copies.filter(result=>result.value.replayed).length,1);
  assert.equal(copies[0].value.candidate.status,'active');assert.equal(copies[0].value.base.status,'superseded');
  assert.equal((await client`SELECT count(*)::int n FROM brain_memory_reviews WHERE user_id=${owner} AND metadata->>'commandId'=${acceptedRequest.commandId}`)[0].n,1);
  const after=await search();assert.ok(after.results.some(memory=>memory.id===proposal.candidate.id));assert.ok(!after.results.some(memory=>memory.id===fixture.id));
  assert.equal(after.results.find(memory=>memory.id===proposal.candidate.id).metadata.pendingMemoryUpdate,null);assert.ok(!after.results.find(memory=>memory.id===proposal.candidate.id).metadata.warnings.includes('memory_update_pending'));
  const changed=await request(`/api/brain/memory-updates/${proposal.candidate.id}/decision`,{...acceptedRequest,reason:'different payload'});assert.equal(changed.status,409);assert.equal(changed.value.code,'command_conflict');
  const other=randomUUID();await client`INSERT INTO "User"(id,email) VALUES (${other},${other+'@example.invalid'})`;
  const foreign=await seed(client,other),foreignObservation=await client`SELECT * FROM brain_observations WHERE user_id=${other}`;
  // A direct fixture pending candidate allows owner isolation to be checked without another auth server.
  const foreignCandidate=randomUUID(),foreignMetadata={updateProposal:{status:'pending',targetMemoryId:foreign.id,expectedBaseVersion:proposal.baseVersion,commandId:'foreign-fixture',reason:'foreign',createdAt:new Date().toISOString()}};
  await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,evidence_refs,metadata) VALUES (${foreignCandidate},${other},'work',${foreign.work},'work',${foreign.work},'insight','foreign candidate','PRIVATE FIXTURE MUST NOT RETURN','candidate',80,${JSON.stringify([foreign.evidenceRef])}::jsonb,${JSON.stringify(foreignMetadata)}::jsonb)`;
  assert.equal((await request(`/api/brain/memory-updates/${foreignCandidate}`)).status,404);assert.equal((await request(`/api/brain/memory-updates/evidence?proposalId=${foreignCandidate}`)).status,404);
  assert.equal((await request(`/api/brain/memory-updates/${foreignCandidate}/decision`,{...acceptedRequest,commandId:randomUUID()})).status,404);
  assert.ok(!(await request('/api/brain/memory-updates')).value.proposals.some(item=>item.id===foreignCandidate));
  assert.deepEqual(await client`SELECT * FROM brain_observations WHERE user_id=${other}`,foreignObservation);
  const standalone=await seed(client,owner,{work:fixture.work,status:'candidate',sourceContent:'合成独立来源'.repeat(6000)});
  await client`UPDATE brain_memories SET metadata=metadata || '{"admission":{"requiresOwnerVerification":true}}'::jsonb,evidence_refs=evidence_refs || ${JSON.stringify([foreign.evidenceRef,'https://example.invalid/no-fetch','C:\\private\\no-read.txt'])}::jsonb WHERE id=${standalone.id}`;
  const standaloneEvidence=await request(`/api/brain/memory-updates/evidence?proposalId=${standalone.id}`);assert.equal(standaloneEvidence.status,200,JSON.stringify(standaloneEvidence.value));assert.equal(standaloneEvidence.value.truncated,true);
  const truncatedSource=standaloneEvidence.value.sources.find(source=>source.id===standalone.evidenceRef);assert.equal(truncatedSource.content.length,20000);assert.equal(truncatedSource.truncated,true);assert.ok(truncatedSource.warning);
  assert.ok(standaloneEvidence.value.sources.filter(source=>source.id!==standalone.evidenceRef).every(source=>source.status==='unresolved'&&source.content===null));
  assert.equal((await request(`/api/brain/memory-updates/evidence?proposalId=${randomUUID()}`)).status,404);assert.equal((await request('/api/brain/memory-updates/evidence?proposalId=malformed')).status,400);
  const rejectedFixture=await seed(client,owner,{work:fixture.work}),rejectedProposal=await propose(request,rejectedFixture);
  const rejection=await request(`/api/brain/memory-updates/${rejectedProposal.candidate.id}/decision`,decision(rejectedProposal,{action:'reject',evidenceConfirmed:undefined}));assert.equal(rejection.status,200);assert.equal(rejection.value.candidate.status,'deleted');assert.equal(rejection.value.base.status,'active');
  const failedFixture=await seed(client,owner,{work:fixture.work}),failedProposal=await propose(request,failedFixture),failedRequest=decision(failedProposal);
  await client.unsafe("CREATE FUNCTION reject_update_http() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected HTTP audit failure'; END $$");await client.unsafe('CREATE TRIGGER reject_update_http BEFORE INSERT ON brain_memory_reviews FOR EACH ROW EXECUTE FUNCTION reject_update_http()');
  try{assert.equal((await request(`/api/brain/memory-updates/${failedProposal.candidate.id}/decision`,failedRequest)).status,500);}finally{await client.unsafe('DROP TRIGGER reject_update_http ON brain_memory_reviews');await client.unsafe('DROP FUNCTION reject_update_http()');}
  assert.equal((await request(`/api/brain/memory-updates/${failedProposal.candidate.id}`)).value.proposal.status,'pending');
  assert.equal((await request(`/api/brain/memory-updates/${failedProposal.candidate.id}/decision`,failedRequest)).status,200);
  const policy=await request('/api/brain/memory-updates/policy');assert.equal(policy.status,200);
  const pause={commandId:randomUUID(),expectedVersion:policy.value.version,enabled:false,reason:'HTTP fixture pause'};
  const policyCopies=await Promise.all([request('/api/brain/memory-updates/policy',pause),request('/api/brain/memory-updates/policy',pause)]);assert.deepEqual(policyCopies.map(result=>result.status),[200,200]);assert.equal(policyCopies.filter(result=>result.value.replayed).length,1);
  assert.equal((await request('/api/brain/memory-updates/policy')).value.enabled,false);
  const resumed=await request('/api/brain/memory-updates/policy',{commandId:randomUUID(),expectedVersion:policyCopies[0].value.version,enabled:true,reason:'HTTP fixture resume'});assert.equal(resumed.status,200);
  const result={name:'real phase2 HTTP: two-version acceptance, cached current recall, exact typed source expansion/unresolved warning, owner isolation, legacy bypass deny, reject and transactional audit-failure recovery, policy replay',passed:true};
  fs.writeFileSync(path.join(records,'memory-update-http.json'),JSON.stringify(result,null,2));return result;
}

export async function checkBrainMemoryUpdateBrowser({client,owner,origin,records}){
  // Raw fixture creation does not run the real Work-created invalidation. Reuse
  // the owned Work actually displayed by the preceding browser regression.
  const precedingPath=path.join(records,'browser-progress.json');
  const preceding=fs.existsSync(precedingPath)?JSON.parse(fs.readFileSync(precedingPath,'utf8')):null;
  const work=preceding?.fixture.work??(await client`SELECT id FROM workshops WHERE user_id=${owner} ORDER BY created_at ASC,id ASC LIMIT 1`)[0]?.id;
  assert.ok(work&&(await client`SELECT id FROM workshops WHERE id=${work} AND user_id=${owner}`).length===1);
  const request=requestFor(origin),fixture=await seed(client,owner,{work}),proposal=await propose(request,fixture);
  const browser=await chromium.launch({headless:true}),milestones=[],submitted=[],pageErrors=[];
  let page,routeFailure,committed,first=true;
  const record=name=>{milestones.push({name,at:new Date().toISOString()});fs.writeFileSync(path.join(records,'memory-update-browser-progress.json'),JSON.stringify({fixture,milestones},null,2));};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
    page=await context.newPage();page.setDefaultNavigationTimeout(180000);page.setDefaultTimeout(60000);
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const key=`memory-update-pending:v1:${owner}`;
    const dialog=()=>page.getByRole('dialog',{name:'记忆更新提案审核'});
    const policyDialog=()=>page.getByRole('dialog',{name:'记忆自动生效设置'});
    const waitReady=async()=>{await expect(page.locator(`[data-workshop-id="${fixture.work}"]`)).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('button',{name:'刷新记忆',exact:true})).toBeEnabled();};
    const navigate=async()=>{await page.goto(`${origin}/workshop?workId=${fixture.work}&tab=memory`);await waitReady();};
    const expand=async()=>{const list=page.getByRole('region',{name:'记忆更新提案列表'});await expect(list).toBeVisible();const collapsed=list.getByRole('button',{name:'查看记忆更新提案',exact:true});if(await collapsed.count())await collapsed.click();return list;};
    const refreshList=async()=>{const list=await expand();const refresh=list.getByRole('button',{name:'刷新记忆更新提案',exact:true});await expect(refresh).toBeEnabled();await refresh.click();};
    const openProposal=async id=>{
      const list=await expand();await list.locator(`[data-proposal-id="${id}"]`).getByRole('button',{name:'审核更新提案',exact:true}).click();
      const reason=dialog().getByLabel('审核理由');
      // A dev route can compile past the UI's bounded read timeout. Recover
      // through its actual readonly retry control; never retry a POST here.
      for(let retry=0;retry<2;retry++){
        const timeoutAlert=dialog().getByRole('alert').filter({hasText:/timed out|超时/});
        const outcome=await Promise.race([reason.waitFor({state:'visible'}).then(()=> 'ready'),timeoutAlert.waitFor({state:'visible'}).then(()=> 'read_error')]);
        if(outcome==='ready')break;
        const alert=await timeoutAlert.innerText();
        assert.ok(/timed out|超时/.test(alert),`Unexpected readonly load failure: ${alert}`);
        await dialog().getByRole('button',{name:'刷新提案与基准',exact:true}).click();
      }
      await expect(reason).toHaveCount(1);await expect(reason).toBeEnabled();
    };
    const fillAccept=async()=>{await dialog().getByLabel('审核理由').fill('桌面合成验收：已人工核对本次原始来源。');await dialog().getByLabel('我已核对原始来源，确认可以采用提案',{exact:true}).check();};
    const acknowledge=async()=>{await dialog().getByRole('button',{name:'完成并刷新提案列表',exact:true}).click();await expect(dialog()).toHaveCount(0);assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),key),null);};
    const acknowledgePolicy=async()=>{await policyDialog().getByRole('button',{name:'完成政策核对',exact:true}).click();await expect(policyDialog()).toHaveCount(0);await expect.poll(()=>page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();};

    let ownerReadSeen=false,releaseOwnerRead;const ownerReadBarrier=new Promise(resolve=>{releaseOwnerRead=resolve;});
    const ownerOverviewEndpoint=`${origin}/api/page-state/workshop/owner`;
    await page.route(ownerOverviewEndpoint,async route=>{if(route.request().method()==='GET'&&!ownerReadSeen){ownerReadSeen=true;await ownerReadBarrier;}return route.continue();});
    try{
      await page.goto(`${origin}/workshop?workId=${fixture.work}&tab=memory`,{waitUntil:'domcontentloaded'});
      await expect.poll(()=>ownerReadSeen).toBe(true);
      await expect(page.getByRole('status').filter({hasText:'正在确认当前车间，记忆更新提案入口随后可用'})).toBeVisible();
      await expect(page.getByRole('region',{name:'记忆更新提案列表'})).toHaveCount(0);
      await page.screenshot({path:path.join(records,'memory-update-cold-owner-guard.png')});
    }finally{releaseOwnerRead();await page.unroute(ownerOverviewEndpoint);}
    await waitReady();await expand();await openProposal(proposal.candidate.id);
    await dialog().getByText('查看原始证据',{exact:true}).click();
    await expect(dialog().locator(`[data-source-ref="${fixture.evidenceRef}"]`)).toContainText('独立于模型解释');
    await expect(dialog().locator('[data-source-ref="fixture:unresolved-source"]')).toContainText('无法解析来源');
    await expect(dialog().getByRole('button',{name:'接受提案',exact:true})).toBeDisabled();
    await page.setViewportSize({width:1024,height:768});
    await expect.poll(async()=>dialog().evaluate(element=>{const r=element.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
    const geometry=await dialog().evaluate(element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return {viewport:{width:innerWidth,height:innerHeight},dialog:{top:r.top,bottom:r.bottom,height:r.height},maxHeight:s.maxHeight,overflowY:s.overflowY,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight};});
    await dialog().getByRole('button',{name:'关闭提案审核',exact:true}).scrollIntoViewIfNeeded();await dialog().getByRole('button',{name:'关闭提案审核',exact:true}).click({trial:true});
    geometry.bottomAction=await dialog().getByRole('button',{name:'关闭提案审核',exact:true}).evaluate(element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom};});
    fs.writeFileSync(path.join(records,'memory-update-desktop-1024-geometry.json'),JSON.stringify(geometry,null,2));await page.screenshot({path:path.join(records,'memory-update-desktop-1024-actions.png')});
    await page.keyboard.press('Escape');await expect(dialog()).toHaveCount(0);await page.setViewportSize({width:1440,height:1000});record('lazy proposal, original-source/unresolved explanation, keyboard and 1024 modal actions');

    const endpoint=`${origin}/api/brain/memory-updates/${proposal.candidate.id}/decision`;
    await page.route(endpoint,async route=>{if(route.request().method()!=='POST')return route.continue();try{submitted.push(route.request().postDataJSON());if(first){first=false;const response=await route.fetch();committed=await response.json();assert.equal(response.status(),200,JSON.stringify(committed));return route.abort('failed');}return route.continue();}catch(error){routeFailure=error;return route.abort().catch(()=>{});}});
    await openProposal(proposal.candidate.id);await fillAccept();await dialog().getByRole('button',{name:'接受提案',exact:true}).click();
    await expect.poll(()=>{if(routeFailure)throw routeFailure;return committed;}).toBeTruthy();await expect(dialog().getByRole('alert').filter({hasText:'结果尚未确认'})).toContainText('结果尚未确认');
    const firstPending=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),key);assert.equal(firstPending.request.commandId,submitted[0].commandId);
    await page.reload();await waitReady();const recovery=page.getByRole('region',{name:'记忆提案审核恢复'});await expect(recovery).toBeVisible();await recovery.getByRole('button',{name:'恢复提案审核',exact:true}).click();
    await expect(dialog().getByRole('button',{name:'重试原审核',exact:true})).toBeEnabled();await page.screenshot({path:path.join(records,'memory-update-response-lost-recovery.png'),fullPage:true});
    await dialog().getByRole('button',{name:'重试原审核',exact:true}).click();await expect(dialog().getByRole('status').filter({hasText:'提案已接受'})).toContainText('提案已接受');assert.deepEqual(submitted[1],submitted[0]);
    assert.equal((await client`SELECT count(*)::int n FROM brain_memory_reviews WHERE user_id=${owner} AND metadata->>'commandId'=${submitted[0].commandId}`)[0].n,1);
    await acknowledge();await expect(page.locator(`[data-memory-id="${committed.candidate.id}"]`)).toBeVisible();record('accepted commit response lost, reload original command replay once and current card');

    const failedFixture=await seed(client,owner,{work:fixture.work}),failedProposal=await propose(request,failedFixture),failedEndpoint=`${origin}/api/brain/memory-updates/${failedProposal.candidate.id}/decision`,failedSubmitted=[];
    let failBeforeCommit=true;
    await page.route(failedEndpoint,route=>{if(route.request().method()!=='POST')return route.continue();failedSubmitted.push(route.request().postDataJSON());if(failBeforeCommit){failBeforeCommit=false;return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'synthetic failure before commit'})});}return route.continue();});
    await refreshList();await openProposal(failedProposal.candidate.id);await fillAccept();await dialog().getByRole('button',{name:'接受提案',exact:true}).click();await expect(dialog().getByRole('alert').filter({hasText:'结果尚未确认'})).toContainText('结果尚未确认');
    await dialog().getByRole('button',{name:'重新读取提案状态',exact:true}).click();await expect(dialog().getByRole('button',{name:'重试原审核',exact:true})).toBeEnabled();assert.equal((await request(`/api/brain/memory-updates/${failedProposal.candidate.id}`)).value.proposal.status,'pending');
    await page.reload();await waitReady();await page.getByRole('region',{name:'记忆提案审核恢复'}).getByRole('button',{name:'恢复提案审核',exact:true}).click();await dialog().getByRole('button',{name:'重试原审核',exact:true}).click();await expect(dialog().getByRole('status').filter({hasText:'提案已接受'})).toContainText('提案已接受');assert.deepEqual(failedSubmitted[1],failedSubmitted[0]);await acknowledge();record('500 before commit remains pending, reload and exact retry succeeds once');

    const staleFixture=await seed(client,owner,{work:fixture.work}),staleProposal=await propose(request,staleFixture);
    await refreshList();await openProposal(staleProposal.candidate.id);await fillAccept();
    const staleCurrent=await request(`/api/brain/memories/${staleFixture.id}/revision`);
    assert.equal((await request(`/api/brain/memories/${staleFixture.id}/revision`,{commandId:randomUUID(),expectedVersion:staleCurrent.value.expectedVersion,operation:'correct',authority:'owner_statement',content:'另一窗口主人已明确更正基准。',reason:'制造真实版本竞争',evidenceRefs:[]})).status,200);
    await dialog().getByRole('button',{name:'接受提案',exact:true}).click();await expect(dialog().getByRole('alert').filter({hasText:'服务器未接受'})).toContainText('服务器未接受');await dialog().getByRole('button',{name:'重新读取提案状态',exact:true}).click();await expect(dialog().getByRole('button',{name:'完成并刷新提案列表',exact:true})).toBeEnabled();await acknowledge();
    await openProposal(staleProposal.candidate.id);await expect(dialog().getByRole('button',{name:'接受提案',exact:true})).toBeDisabled();await dialog().getByLabel('审核理由').fill('当前基准已改变，拒绝旧提案保留主人新版本。');await dialog().getByRole('button',{name:'拒绝提案',exact:true}).click();await expect(dialog().getByRole('status').filter({hasText:'提案已拒绝'})).toContainText('提案已拒绝');await acknowledge();record('real base conflict blocks stale acceptance, refresh and reject original proposal');

    const obsoleteFixture=await seed(client,owner,{work:fixture.work}),obsoleteProposal=await propose(request,obsoleteFixture),obsoleteEndpoint=`${origin}/api/brain/memory-updates/${obsoleteProposal.candidate.id}/decision`;
    await page.route(obsoleteEndpoint,route=>route.request().method()==='POST'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'synthetic unknown before commit'})}):route.continue());
    await refreshList();await openProposal(obsoleteProposal.candidate.id);await fillAccept();await dialog().getByRole('button',{name:'接受提案',exact:true}).click();await expect(dialog().getByRole('alert').filter({hasText:'结果尚未确认'})).toContainText('结果尚未确认');
    const obsoleteCurrent=await request(`/api/brain/memories/${obsoleteFixture.id}/revision`);
    assert.equal((await request(`/api/brain/memories/${obsoleteFixture.id}/revision`,{commandId:randomUUID(),expectedVersion:obsoleteCurrent.value.expectedVersion,operation:'deactivate',authority:'owner_statement',reason:'另一窗口明确停用基准',evidenceRefs:[]})).status,200);
    await page.reload();await waitReady();await page.getByRole('region',{name:'记忆提案审核恢复'}).getByRole('button',{name:'恢复提案审核',exact:true}).click();await dialog().getByRole('button',{name:'重新读取提案状态',exact:true}).click();await expect(dialog().getByRole('button',{name:'关闭并结束此次提案审核恢复',exact:true})).toBeEnabled();await dialog().getByRole('button',{name:'关闭并结束此次提案审核恢复',exact:true}).click();await expect(dialog()).toHaveCount(0);assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),key),null);record('unknown decision plus explicit base retirement permits bounded local recovery end');

    const timeoutFixture=await seed(client,owner,{work:fixture.work}),timeoutProposal=await propose(request,timeoutFixture),timeoutEndpoint=`${origin}/api/brain/memory-updates/${timeoutProposal.candidate.id}/decision`,timeoutSubmitted=[];let hang=true;
    await page.addInitScript(()=>{const original=AbortSignal.timeout;AbortSignal.timeout=milliseconds=>original(milliseconds===30000&&sessionStorage.getItem('memory-update-short-timeout')==='1'?1500:milliseconds);});
    await page.reload();await waitReady();await expand();
    await page.route(timeoutEndpoint,async route=>{if(route.request().method()!=='POST')return route.continue();timeoutSubmitted.push(route.request().postDataJSON());if(hang){hang=false;await new Promise(resolve=>setTimeout(resolve,6000));return route.fulfill({status:500,contentType:'application/json',body:'{"error":"synthetic delayed response"}'}).catch(()=>{});}return route.continue();});
    await openProposal(timeoutProposal.candidate.id);await fillAccept();
    await page.evaluate(()=>sessionStorage.setItem('memory-update-short-timeout','1'));
    await dialog().getByRole('button',{name:'接受提案',exact:true}).click();await expect(dialog().getByRole('alert').filter({hasText:'结果尚未确认'})).toContainText('结果尚未确认');
    await page.evaluate(()=>sessionStorage.removeItem('memory-update-short-timeout'));
    await expect(dialog().getByRole('button',{name:'重试原审核',exact:true})).toBeEnabled();await dialog().getByRole('button',{name:'重试原审核',exact:true}).click();await expect(dialog().getByRole('status').filter({hasText:'提案已接受'})).toContainText('提案已接受');assert.deepEqual(timeoutSubmitted[1],timeoutSubmitted[0]);await acknowledge();record('aborted pending POST releases flight and reuses the original decision command');

    const storageFixture=await seed(client,owner,{work:fixture.work}),storageProposal=await propose(request,storageFixture),storageEndpoint=`${origin}/api/brain/memory-updates/${storageProposal.candidate.id}/decision`;let storagePosts=0;
    page.on('request',request=>{if(request.url()===storageEndpoint&&request.method()==='POST')storagePosts++;});
    await refreshList();await openProposal(storageProposal.candidate.id);await fillAccept();
    await page.evaluate(()=>{const original=Storage.prototype.setItem;window.__memoryUpdateOriginalSetItem=original;Storage.prototype.setItem=function(key,value){if(key.startsWith('memory-update-pending:'))throw Error('synthetic storage quota');return original.call(this,key,value);};});
    await dialog().getByRole('button',{name:'接受提案',exact:true}).click();await expect(dialog().getByRole('alert').filter({hasText:'synthetic storage quota'})).toContainText('synthetic storage quota');assert.equal(storagePosts,0);assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),key),null);
    await page.evaluate(()=>{Storage.prototype.setItem=window.__memoryUpdateOriginalSetItem;delete window.__memoryUpdateOriginalSetItem;});
    const identityEndpoint=`${origin}/api/identity`;
    await page.route(identityEndpoint,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({actorId:randomUUID()})}));
    await dialog().getByRole('button',{name:'接受提案',exact:true}).click();await expect(dialog().getByRole('alert').filter({hasText:'登录身份已变化'})).toContainText('登录身份已变化');assert.equal(storagePosts,0);await page.unroute(identityEndpoint);
    await dialog().getByRole('button',{name:'接受提案',exact:true}).click();await expect(dialog().getByRole('status').filter({hasText:'提案已接受'})).toContainText('提案已接受');await acknowledge();record('storage failure and changed identity send no POST, then bounded recovery succeeds');

    const policySubmitted=[];let firstPolicy=true;
    await page.route(`${origin}/api/brain/memory-updates/policy`,async route=>{if(route.request().method()!=='POST')return route.continue();policySubmitted.push(route.request().postDataJSON());if(firstPolicy){firstPolicy=false;const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}return route.continue();});
    await page.getByRole('region',{name:'记忆自动生效政策'}).getByRole('button',{name:'暂停自动生效',exact:true}).click();await policyDialog().getByLabel('设置理由').fill('合成验收：暂停自动应用，仍允许候选审核。');await policyDialog().getByRole('button',{name:'保存暂停自动生效',exact:true}).click();await expect(policyDialog().getByRole('alert').filter({hasText:'结果尚未确认'})).toContainText('结果尚未确认');
    await page.reload();await waitReady();await page.getByRole('region',{name:'记忆自动生效设置恢复'}).getByRole('button',{name:'恢复自动生效设置',exact:true}).click();await policyDialog().getByRole('button',{name:'重试原政策设置',exact:true}).click();await expect(policyDialog().getByRole('status').filter({hasText:'已保存暂停'})).toContainText('已保存暂停');assert.deepEqual(policySubmitted[1],policySubmitted[0]);await acknowledgePolicy();
    await page.getByRole('region',{name:'记忆自动生效政策'}).getByRole('button',{name:'读取当前政策',exact:true}).click();await page.getByRole('region',{name:'记忆自动生效政策'}).getByRole('button',{name:'恢复自动生效',exact:true}).click();await policyDialog().getByLabel('设置理由').fill('合成验收：重新允许受控程序事实自动应用。');await policyDialog().getByRole('button',{name:'保存恢复自动生效',exact:true}).click();await expect(policyDialog().getByRole('status').filter({hasText:'已保存恢复'})).toContainText('已保存恢复');await acknowledgePolicy();assert.equal(policySubmitted[2].enabled,true);assert.notEqual(policySubmitted[2].commandId,policySubmitted[0].commandId);record('policy commit response lost, stable recovery/replay and explicit resume');

    const globalFixture=await seed(client,owner,{global:true}),globalProposal=await propose(request,globalFixture);
    await page.goto(`${origin}/memory`);await expand();await openProposal(globalProposal.candidate.id);await dialog().getByLabel('审核理由').fill('统一记忆入口拒绝非 work 全局提案。');await dialog().getByRole('button',{name:'拒绝提案',exact:true}).click();await expect(dialog().getByRole('status').filter({hasText:'提案已拒绝'})).toContainText('提案已拒绝');await acknowledge();record('unified memory global proposal lazy list and owner rejection');
    assert.deepEqual(pageErrors,[]);return {name:'actual phase2 desktop browser workflow',passed:true,milestones,postCount:submitted.length,policyPostCount:policySubmitted.length,pageErrors};
  }catch(error){if(page){await page.screenshot({path:path.join(records,'memory-update-browser-failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(records,'memory-update-browser-failure.html'),await page.content().catch(()=>''));}throw error;}
  finally{await browser.close();}
}
