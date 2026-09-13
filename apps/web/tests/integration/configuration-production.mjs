import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {configurationManifest} from './configuration-fixture.mjs';
import YAML from 'yaml';

export async function checkConfigurationProduction({env,databaseUrl,client,web,root,reviewStage,portOverride,recordPrefix,outboxState,legacyRunWrites=false,manifestLifecycle=false,configurationIdentity=false,commandRejections=false,loopAliases=false,manifestExport=false,clientCommands=false,clientActions=false}) {
  const port=portOverride??(clientActions?3534:clientCommands?3533:manifestExport?3532:loopAliases?3531:commandRejections?3530:configurationIdentity?3529:manifestLifecycle?3528:3527);
  const owner=randomUUID(),work=randomUUID(),importWork=randomUUID(),loop=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'configuration-http@example.invalid')`;
  for(const id of [work,importWork])await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${id},${owner},'old','old')`;
  async function proposal(version,patch={mission:'审核后目标'}) {
    const id=randomUUID();
    await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title,metadata) VALUES (${id},${work},(SELECT coalesce(max(seq),0)+1 FROM workshop_events WHERE workshop_id=${work}),'workshop_agent_change_proposed','proposal',${JSON.stringify({patch,workModelVersion:version})}::jsonb)`;
    await client`INSERT INTO workshop_event_counters(workshop_id,last_seq) VALUES (${work},(SELECT max(seq) FROM workshop_events WHERE workshop_id=${work})) ON CONFLICT(workshop_id) DO UPDATE SET last_seq=EXCLUDED.last_seq`;
    await client`INSERT INTO workshop_review_items(workshop_id,source_event_id,kind,title,metadata) VALUES (${work},${id},'agent_change','proposal','{"origin":"preserve"}'::jsonb)`;
    return id;
  }
  const proposalId=await proposal(new Date((await client`SELECT updated_at FROM workshops WHERE id=${work}`)[0].updated_at).toISOString());
  const fixture=configurationManifest(`production-${importWork}`);
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,updated_at) VALUES (${loop},${owner},${importWork},'旧目标','old','2020-01-01')`;
  await client`INSERT INTO loops(user_id,workshop_id,name,goal) SELECT ${owner}::uuid,${importWork}::uuid,'unrelated','noise' FROM generate_series(1,301)`;
  await client`INSERT INTO workshop_sources(workshop_id,type,name,created_at) VALUES (${importWork},'manual','old-source','2020-01-01')`;
  await client`INSERT INTO workshop_sources(workshop_id,type,name) SELECT ${importWork}::uuid,'manual','unrelated' FROM generate_series(1,301)`;
  const origin=`http://127.0.0.1:${port}`;
  if(['06D3','06D6','06D9','06E2','06E4','06E6','06E10'].includes(recordPrefix))env={...env,REPORT_QUALITY_EVALUATOR_ENABLED:'false'};
  if(['06D6','06D9','06E2','06E4','06E6','06E10'].includes(recordPrefix))env={...env,NODE_OPTIONS:[env.NODE_OPTIONS,`--import=${pathToFileURL(path.join(web,'tests/integration/deny-external-transports.mjs')).href}`].filter(Boolean).join(' ')};
  const log=fs.openSync(path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix??(clientActions?'06B15':clientCommands?'06B14':manifestExport?'06B13':loopAliases?'06B12':commandRejections?'06B11':configurationIdentity?'06B10':manifestLifecycle?'06B9':'06B8')}-production-server.log`),'w');
  const child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-p',String(port),'-H','127.0.0.1'],{cwd:web,windowsHide:true,stdio:['ignore',log,log],env:{...env,NODE_ENV:'production',NODE_PATH:[path.join(root,'node_modules'),env.NODE_PATH].filter(Boolean).join(path.delimiter),AUTH_MODE:'local_owner',DEV_USER_ID:owner,ZHIYU_REVIEW_BUILD:reviewStage??(clientActions?'34':clientCommands?'32':manifestExport?'28':loopAliases?'26':commandRejections?'25':configurationIdentity?'24':manifestLifecycle?'23':'22'),POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',TAURI_MODE:'false',IS_TAURI:'false'}});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const request=(url,body,method='POST')=>fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  try {
    let ready=false;for(let i=0;i<60;i++){if(child.exitCode!==null)throw Error('Configuration candidate exited');try{if((await request('/api/identity',undefined,'GET')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}assert(ready);
    const fontManifest=JSON.parse(fs.readFileSync(path.join(web,'public/vendor/fonts/provenance.json'),'utf8'));
    const html=await (await fetch(origin+'/workshop')).text();
    assert(html.includes('zhiyu-font-sans zhiyu-font-serif zhiyu-font-roboto'));
    assert(!html.includes('fonts.googleapis.com'));
    for(const url of fontManifest.preloads)assert(html.includes(url));
    for(const asset of fontManifest.assets){
      const response=await fetch(origin+'/vendor/fonts/'+asset.file);
      assert.equal(response.status,200);
      assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),asset.sha256);
    }
    const apply={action:'apply',commandId:randomUUID(),expectedVersion:0};
    const results=await Promise.all([request(`/api/workshops/${work}/agent-change-proposals/${proposalId}`,apply),request(`/api/workshops/${work}/agent-change-proposals/${proposalId}`,apply)]);
    assert.deepEqual(results.map(r=>r.status),[200,200]);const [a,b]=await Promise.all(results.map(r=>r.json()));assert.deepEqual(a,b);
    assert.equal((await client`SELECT metadata FROM workshop_review_items WHERE source_event_id=${proposalId}`)[0].metadata.origin,'preserve');
    const staleId=await proposal(a.workshop.modelConfig.workVersion);
    const changed=await request(`/api/workshops/${work}`,{mission:'新基线',commandId:randomUUID(),expectedVersion:1},'PATCH');assert.equal(changed.status,200);
    const staleCommand={action:'apply',commandId:randomUUID(),expectedVersion:2};
    const stale=await request(`/api/workshops/${work}/agent-change-proposals/${staleId}`,staleCommand);assert.equal(stale.status,409);
    const manifest={manifestYaml:fixture.yaml,commandId:randomUUID(),expectedVersion:0};
    const imports=await Promise.all([request(`/api/workshops/${importWork}`,manifest,'PATCH'),request(`/api/workshops/${importWork}`,manifest,'PATCH')]);
    assert.deepEqual(imports.map(r=>r.status),[200,200]);const [c,d]=await Promise.all(imports.map(r=>r.json()));assert.deepEqual(c,d);
    assert.equal(c.updated.loops,1);assert.equal(c.created.loops,1);assert.equal(c.created.sources,1);
    assert.equal((await client`SELECT goal FROM loops WHERE id=${loop}`)[0].goal,'更新后的观察目标');
    assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${importWork}`)[0].n,303);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_sources WHERE workshop_id=${importWork}`)[0].n,303);
    assert.equal((await request(`/api/workshops/${importWork}`,{...manifest,commandId:randomUUID()},'PATCH')).status,409);
    if(manifestLifecycle){
      const fresh=configurationManifest(`http-create-${randomUUID()}`);
      const payload={manifestYaml:fresh.yaml,commandId:randomUUID(),expectedVersion:0};
      const creation=await Promise.all([request('/api/workshops',payload),request('/api/workshops',payload)]);
      assert.deepEqual(creation.map(response=>response.status),[201,201]);
      const [first,second]=await Promise.all(creation.map(response=>response.json()));assert.deepEqual(first,second);
      assert.equal((await request('/api/workshops',{...payload,commandId:randomUUID()})).status,409);
      fresh.manifest.spec.loops[0].title='生产改名观察任务';
      const renamed=await request(`/api/workshops/${first.workshop.id}`,{manifestYaml:YAML.stringify(fresh.manifest),commandId:randomUUID(),expectedVersion:1},'PATCH');
      assert.equal(renamed.status,200);const result=await renamed.json();assert.equal(result.updated.loops,2);assert.equal(result.created.loops,0);
      assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${first.workshop.id}`)[0].n,2);
      const replay=await request('/api/workshops',payload);assert.equal(replay.status,201);assert.deepEqual(await replay.json(),first);
      await client`INSERT INTO loops(user_id,workshop_id,name,goal) VALUES (${owner},${first.workshop.id},'old-target','ambiguous')`;
      assert.equal((await request(`/api/workshops/${first.workshop.id}`,{manifestYaml:YAML.stringify(fresh.manifest),commandId:randomUUID(),expectedVersion:2},'PATCH')).status,409);
      if(configurationIdentity){
        assert.equal((await request('/api/workshops',{name:'forged',mission:'identity',modelConfig:{manifestName:'forged'},commandId:randomUUID()})).status,409);
        assert.equal((await request(`/api/workshops/${first.workshop.id}`,{modelConfig:{manifestName:'forged'},commandId:randomUUID(),expectedVersion:2},'PATCH')).status,409);
        const replacement=await request(`/api/workshops/${first.workshop.id}`,{modelConfig:{model:'replacement'},commandId:randomUUID(),expectedVersion:2},'PATCH');
        assert.equal(replacement.status,200);assert.equal((await replacement.json()).workshop.modelConfig.manifestName,fresh.manifest.metadata.name);
        const version=(await client`SELECT id FROM workshop_work_versions WHERE workshop_id=${first.workshop.id} ORDER BY created_at LIMIT 1`)[0].id;
        await client`UPDATE workshop_work_versions SET snapshot=jsonb_set(snapshot,'{modelConfig,manifestName}','"historical-name"'::jsonb) WHERE id=${version}`;
        const restored=await request(`/api/workshops/${first.workshop.id}/work/versions`,{action:'restore',versionId:version,commandId:randomUUID(),expectedVersion:3});assert.equal(restored.status,200);
        assert.equal((await client`SELECT model_config FROM workshops WHERE id=${first.workshop.id}`)[0].model_config.manifestName,fresh.manifest.metadata.name);
        await client`UPDATE workshops SET model_config=jsonb_set(model_config,'{workVersion}','"2050-01-01T00:00:00.000Z"'::jsonb) WHERE id=${first.workshop.id}`;
        const monotonic=await request(`/api/workshops/${first.workshop.id}`,{mission:'after clock rollback',commandId:randomUUID(),expectedVersion:4},'PATCH');assert.equal(monotonic.status,200);assert.equal((await monotonic.json()).workshop.modelConfig.workVersion,'2050-01-01T00:00:00.001Z');
        const malicious=await proposal((await client`SELECT model_config FROM workshops WHERE id=${work}`)[0].model_config.workVersion,{modelConfig:{manifestName:'from-agent'}});
        assert.equal((await request(`/api/workshops/${work}/agent-change-proposals/${malicious}`,{action:'apply',commandId:randomUUID(),expectedVersion:2})).status,409);
      }
    }
    if(commandRejections){
      const receipt=await request(`/api/workshops/${work}/commands/${staleCommand.commandId}`,undefined,'GET');assert.equal(receipt.status,200);
      const stored=await receipt.json();assert.equal(stored.command.status,'failed');assert.equal(stored.command.errorCode,'WORK_VERSION_STALE');assert.equal(stored.events.filter(event=>event.phase==='failed').length,1);
      const retry=await request(`/api/workshops/${work}/agent-change-proposals/${staleId}`,staleCommand);assert.equal(retry.status,409);assert.equal((await retry.json()).code,'WORK_VERSION_STALE');
      const invalid={manifestYaml:'invalid: true',commandId:randomUUID(),expectedVersion:2};
      const rejected=await request(`/api/workshops/${work}`,invalid,'PATCH');assert.equal(rejected.status,400);
      const duplicate=await request(`/api/workshops/${work}`,invalid,'PATCH');assert.equal(duplicate.status,400);assert.deepEqual(await duplicate.json(),await rejected.json());
      assert.equal((await (await request(`/api/workshops/${work}/commands/${invalid.commandId}`,undefined,'GET')).json()).command.status,'failed');
      const oldSummary=await (await request(`/api/page-state/workshop/${work}/summary?refresh=1`,undefined,'GET')).json();assert.equal(oldSummary.commandVersion,2);assert.equal(oldSummary.workshop.name,'old');
      assert.equal((await request(`/api/workshops/${work}`,{name:'paired-version-3',commandId:randomUUID(),expectedVersion:2},'PATCH')).status,200);
      const cached=await (await request(`/api/page-state/workshop/${work}/summary`,undefined,'GET')).json();
      assert.equal(cached.workshop.name,cached.commandVersion===2?'old':'paired-version-3');assert([2,3].includes(cached.commandVersion));
      const fresh=await (await request(`/api/page-state/workshop/${work}/summary?refresh=1`,undefined,'GET')).json();assert.equal(fresh.commandVersion,3);assert.equal(fresh.workshop.name,'paired-version-3');
      const detail=await (await request(`/api/workshops/${work}`,undefined,'GET')).json();assert.equal(detail.commandVersion,3);assert.equal(detail.workshop.name,'paired-version-3');
    }
    if(loopAliases){
      const {checkLoopAliasesProduction}=await import('./loop-aliases-production.mjs');
      await checkLoopAliasesProduction({client,owner,request});
    }
    if(manifestExport){
      const {checkManifestExportProduction}=await import('./manifest-export-production.mjs');
      await checkManifestExportProduction({client,owner,request,origin,root,recordPrefix:clientActions?'06B15':undefined});
    }
    if(clientCommands){
      const {checkClientCommandProduction}=await import('./client-command-production.mjs');
      await checkClientCommandProduction({client,owner,request,origin,root,recordPrefix:clientActions?'06B15':undefined});
    }
    let actionChecks;
    if(clientActions){
      const {checkClientActionsProduction}=await import('./client-actions-production.mjs');
      actionChecks=await checkClientActionsProduction({client,owner,request,origin,root});
    }
    let legacyRunWriteChecks;
    if(legacyRunWrites){
      const {checkLegacyRunWriteProduction}=await import('./legacy-run-write-production.mjs');
      legacyRunWriteChecks=await checkLegacyRunWriteProduction({client,owner,request});
    }
    let brainMemoryWriteChecks;
    if(['06C3f','06C3g','06C3h','06C3i','06C3j','06C3k'].includes(recordPrefix)){
      const {checkBrainMemoryWriteProduction}=await import('./brain-memory-write-production.mjs');
      brainMemoryWriteChecks=await checkBrainMemoryWriteProduction({client,owner,request,review:recordPrefix!=='06C3f',extendedReview:['06C3i','06C3j','06C3k'].includes(recordPrefix)});
    }
    let runSnapshotChecks;
    if(['06C3h','06C3i','06C3j','06C3k'].includes(recordPrefix)){
      const {checkRunSnapshotProduction}=await import('./run-snapshot-production.mjs');
      runSnapshotChecks=await checkRunSnapshotProduction({client,owner,request});
    }
    let brainRecordChecks;
    if(['06C3j','06C3k'].includes(recordPrefix)){
      const {checkBrainRecordProduction}=await import('./brain-record-production.mjs');
      brainRecordChecks=await checkBrainRecordProduction({client,owner,request});
    }
    let outboxSendChecks;
    if(outboxState){
      const {checkOutboxSendProduction}=await import('./outbox-send-production.mjs');
      outboxSendChecks=await checkOutboxSendProduction({client,owner,request,state:outboxState,reconcile:['07D','07E2','07F'].includes(recordPrefix)});
      if(['07D','07E2','07F'].includes(recordPrefix)){
        const {checkOutboxBrowserProduction}=await import('./outbox-browser-production.mjs');
        outboxSendChecks.browser=await checkOutboxBrowserProduction({client,owner,origin,root,state:outboxState,recordPrefix});
      }
      if(['07E2','07F'].includes(recordPrefix)){
        const {checkOutboxResolutionBrowser}=await import('./outbox-resolution-browser.mjs');
        outboxSendChecks.manualBrowser=await checkOutboxResolutionBrowser({client,owner,origin,root,state:outboxState,recordPrefix});
      }
    }
    let wakeupSuggestionChecks;
    let cancellationChecks;
    if(['06C4','06C5','06C6','06C7','06C8','06D3','06D6','06D9','06E2','06E4','06E6','06E10'].includes(recordPrefix)){
      const {checkCancelRunProduction}=await import('./cancel-run-production.mjs');
      cancellationChecks=await checkCancelRunProduction({client,owner,request});
      if(['06D3','06D6','06D9','06E2','06E4','06E6','06E10'].includes(recordPrefix)){
        const {checkLoopExecutionProduction}=await import('./loop-execution-production.mjs');
        cancellationChecks.loopExecution=await checkLoopExecutionProduction({client,owner,request,queued:['06D6','06D9','06E2','06E4','06E6','06E10'].includes(recordPrefix)});
      }
      if(recordPrefix==='06D9'){
        const {checkRunReviewBrowser}=await import('./run-review-browser.mjs');
        cancellationChecks.runReviewBrowser=await checkRunReviewBrowser({client,owner,origin,root});
      }
      if(['06E2','06E4','06E6','06E10'].includes(recordPrefix)){
        const {checkLoopMigrationBrowser}=await import('./loop-migration-browser.mjs');
        cancellationChecks.loopMigrationBrowser=await checkLoopMigrationBrowser({client,owner,origin,root,recordPrefix,responsive:recordPrefix==='06E10',legacyReview:recordPrefix==='06E10',legacyConversion:['06E4','06E6','06E10'].includes(recordPrefix)});
      }
    }
    if(recordPrefix==='06C3k'){
      const {checkWakeupSuggestionProduction}=await import('./wakeup-suggestion-production.mjs');
      wakeupSuggestionChecks=await checkWakeupSuggestionProduction({client,owner,request});
    }
    return {name:'production configuration replay, stale proposal, manifest matching/version conflicts and local fonts',passed:true,port,manifestLifecycle,configurationIdentity,commandRejections,loopAliases,manifestExport,clientCommands,actionChecks,legacyRunWriteChecks,brainMemoryWriteChecks,runSnapshotChecks,brainRecordChecks,wakeupSuggestionChecks,cancellationChecks,outboxSendChecks,fontAssetsVerified:fontManifest.assets.length,fontPreloadsVerified:fontManifest.preloads.length};
  }finally{if(child.exitCode===null)child.kill();await exited;fs.closeSync(log);}
}
