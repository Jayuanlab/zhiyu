import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createFrozenEvalTools,FROZEN_SOURCE_READER_VERSION} from './lib/platform-eval-v2-frozen-tools.mts';

const owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const work='33333333-3333-4333-8333-333333333333';
const run='44444444-4444-4444-8444-444444444444';
const account='55555555-5555-4555-8555-555555555555';
const otherAccount='66666666-6666-4666-8666-666666666666';
const recordAt='2026-10-02T01:00:00.000Z',repoAt='2026-10-02T02:00:00.000Z';
const digest=(value:any)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'zhiyu-frozen-adapter-check-'));
const outcomes:Array<{id:string;passed:boolean;error?:string}>=[];
const metrics:Record<string,number>={};
const doc=(kind:string,id:string,content:any,extra:any={})=>({kind,id,content,sha256:digest(content),capturedAt:kind==='repository_file'?repoAt:recordAt,...(kind!=='repository_file'?{ownerId:owner}:{}),...extra});
const row=(table:string,id:string,content:any)=>doc('database_row',`db:${table}:${id}`,content,{table,recordId:id});
const baseDocuments=()=>[
  row('workshops',work,{id:work,name:'Source workshop',mission:'Read evidence',status:'active',created_at:recordAt}),
  row('workshop_runs',run,{id:run,workshop_id:work,status:'completed',output_summary:'source output '.repeat(1800),error:null,created_at:recordAt}),
  doc('database_aggregate','aggregate:workshops:status',{total:37,groupedBy:'status',groups:[{status:'active',count:30},{status:'paused',count:7}]},{table:'workshops'}),
  row('paper_accounts',account,{id:account,version:4,initial_cash:10000,cash:9700,frozen_cash:0,realized_pnl:0,created_at:recordAt}),
  row('paper_orders',`${account}/order-same`,{account_id:account,id:'order-same',code:'000001.SZ',side:'buy',status:'filled',quantity:100,remaining_quantity:0,limit_price:3}),
  row('paper_orders',`${otherAccount}/order-same`,{account_id:otherAccount,id:'order-same',code:'CROSS_ACCOUNT_SECRET',side:'sell',status:'cancelled',quantity:999,remaining_quantity:0,limit_price:9}),
  row('paper_fills',`${account}/fill-1`,{account_id:account,id:'fill-1',order_id:'order-same',quantity:100,price:3,amount:300}),
  doc('repository_file','file:apps/web/lib/fixture.ts','export const normalSource = true;\n// evidence boundary\n',{path:'apps/web/lib/fixture.ts'}),
];
function fixture(id:string,documents=baseDocuments()){
  const folder=path.join(root,id);fs.mkdirSync(folder);
  const manifest={ownerId:owner,recordSnapshotCapturedAt:recordAt,repositoryCapturedAt:repoAt,sourceHashes:Object.fromEntries(documents.filter(d=>d.kind==='repository_file').map(d=>[(d as any).path,d.sha256]))};
  fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest),'utf8');
  fs.writeFileSync(path.join(folder,'corpus.jsonl'),documents.map(d=>JSON.stringify(d)).join('\n'),'utf8');
  for(const name of ['cases.json','gold.jsonl','rubric.json','questions.jsonl'])fs.writeFileSync(path.join(folder,name),'SCORING_SENTINEL_MUST_NEVER_BE_READ','utf8');
  return {folder,manifest,question:{question:`Read ${run}`,requester:{userId:owner}},model:'actual-test-model',provider:'pi',documents};
}
const invoke=async(tools:any[],name:string,params:any,id=name)=>{
  const result=await tools.find(t=>t.name===name).execute(id,params);
  return {result,text:result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'),data:JSON.parse(result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'))};
};
async function check(id:string,fn:()=>Promise<void>|void){try{await fn();outcomes.push({id,passed:true});}catch(error){outcomes.push({id,passed:false,error:error instanceof Error?error.message:String(error)});}}

await check('owner-and-corpus-owner-denied',()=>{
  const f=fixture('owner');assert.throws(()=>createFrozenEvalTools({...f,question:{...f.question,requester:{userId:other}}}),/owner mismatch/);
  f.documents[0].ownerId=other;fs.writeFileSync(path.join(f.folder,'corpus.jsonl'),f.documents.map(d=>JSON.stringify(d)).join('\n'),'utf8');assert.throws(()=>createFrozenEvalTools(f),/owner mismatch/);
});
await check('tampered-content-hash-denied',()=>{
  const f=fixture('hash');f.documents[0].content.status='paused';fs.writeFileSync(path.join(f.folder,'corpus.jsonl'),f.documents.map(d=>JSON.stringify(d)).join('\n'),'utf8');assert.throws(()=>createFrozenEvalTools(f),/identity\/hash/);
});
await check('persisted-manifest-source-pin-drift-denied',()=>{
  const f=fixture('source-pin');const source=f.documents.find(d=>d.kind==='repository_file')!;source.content+='// changed\n';source.sha256=digest(source.content);f.manifest.sourceHashes[(source as any).path]=source.sha256;
  fs.writeFileSync(path.join(f.folder,'corpus.jsonl'),f.documents.map(d=>JSON.stringify(d)).join('\n'),'utf8');assert.throws(()=>createFrozenEvalTools(f),/manifest|pin|hash/i);
});
await check('source-catalog-env-gold-and-path-escape-denied',()=>{
  for(const [index,name] of ['.env.local','gold.jsonl','cases.json','../outside.ts','C:/outside.ts'].entries()){
    const polluted=doc('repository_file',`file:${name}`,'SHOULD_NOT_BE_CATALOGED',{path:name});const f=fixture(`bad-source-${index}`,[...baseDocuments(),polluted]);assert.throws(()=>createFrozenEvalTools(f),/source catalog|source path/i,name);
  }
});
await check('only-manifest-and-corpus-opened-no-scoring',async()=>{
  const f=fixture('no-scoring'),opened:string[]=[];const original=fs.readFileSync;
  (fs as any).readFileSync=(file:any,...args:any[])=>{opened.push(String(file));return (original as any)(file,...args);};
  let tools:any[];try{tools=createFrozenEvalTools({...f,question:{...f.question,scoring:{answer:'SCORING_SENTINEL_MUST_NEVER_BE_READ'}} as any});}finally{fs.readFileSync=original;}
  assert.deepEqual(opened.map(p=>path.basename(p)).sort(),['corpus.jsonl','manifest.json']);
  const catalog=await invoke(tools!,'readPlatformSource',{});assert.equal(catalog.data.status,'catalog_summary');assert.equal(catalog.data.counts.repositoryFiles,1);assert.ok(!catalog.text.includes('SCORING_SENTINEL'));
  const missing=await invoke(tools!,'readPlatformSource',{sourceId:'gold.jsonl'});assert.equal(missing.data.status,'not_found_in_captured_scope');
});
await check('full-query-statistics-not-sample-count',async()=>{
  const f=fixture('aggregate'),tools=createFrozenEvalTools(f),answer=await invoke(tools,'platformRecall',{question:'count workshops by status'});
  assert.equal(answer.data.data.statistics.status,'captured_full_queries');assert.equal(answer.data.data.statistics.results[0].total,37);
  assert.equal(answer.data.data.statistics.results[0].groups[1].count,7);assert.ok(answer.text.includes('bounded samples'));assert.equal(answer.data.frozenSnapshotCapturedAt,recordAt);
});
await check('uncaptured-population-dimension-stays-unknown',async()=>{
  const f=fixture('uncaptured-aggregate'),tools=createFrozenEvalTools(f),answer=await invoke(tools,'platformRecall',{question:'count memories by status'});
  assert.equal(answer.data.data.statistics.status,'source_unavailable');assert.deepEqual(answer.data.data.statistics.results,[]);
  assert.deepEqual(answer.data.data.statistics.selectedSources,[]);assert.ok(answer.data.data.statistics.warning.includes('unknown, not zero'));
});
await check('unknown-record-stays-captured-scope-gap',async()=>{
  const f=fixture('unknown'),tools=createFrozenEvalTools(f),id='77777777-7777-4777-8777-777777777777';const discovery=await invoke(tools,'platformRecall',{question:`Read ${id}`});
  assert.equal(discovery.data.data.exactRecords.records.length,0);assert.ok(discovery.data.data.exactRecords.missingIds.includes(id));assert.ok(discovery.text.includes('not globally absent')||discovery.text.includes('bounded samples'));
  const exact=await invoke(tools,'platformRecall',{recordRead:{source:'workshops',id}},'exact-unknown');assert.equal(exact.data.ok,false);assert.equal(exact.data.recordRead.status,'not_found_in_scope');assert.ok(exact.text.includes('does not prove global absence'));
});
await check('formal-projection-unread-page-hash-and-capture-time',async()=>{
  const f=fixture('pages'),tools=createFrozenEvalTools(f),discovery=await invoke(tools,'platformRecall',{question:`Read ${run}`});
  const record=discovery.data.data.exactRecords.records.find((r:any)=>r.source==='workshopRuns');assert.equal(record.fieldAvailability.outputSummary,'present_unread');assert.ok(!record.fields.outputSummary);
  const first=await invoke(tools,'platformRecall',{recordRead:record.read},'page-first');assert.equal(first.data.recordRead.status,'read');assert.equal(first.data.recordRead.observedAt,recordAt);assert.ok(!first.data.recordRead.provenanceWarning.includes('live read'));
  assert.ok(!Object.hasOwn(first.data,'data'),'Model text must contain the record page only once');
  assert.deepEqual(first.result.details.result.data.recordRead,first.result.details.result.recordRead,'Structured receipt retains the original formal result shape');
  assert.equal((first.text.match(/"recordRead":/g)??[]).length,1);assert.ok(first.text.length<12000);metrics.recordPageCharacters=first.text.length;
  assert.ok(first.data.recordRead.nextOffset>0);const next={...record.read,offset:first.data.recordRead.nextOffset,expectedHash:first.data.recordRead.contentHash};
  const second=await invoke(tools,'platformRecall',{recordRead:next},'page-second');assert.equal(second.data.recordRead.contentHash,first.data.recordRead.contentHash);assert.ok(second.data.recordRead.content.length>0);
  const changed=await invoke(tools,'platformRecall',{recordRead:{...next,offset:0,expectedHash:'0'.repeat(64)}},'page-wrong-hash');assert.equal(changed.data.recordRead.status,'version_changed');assert.equal(changed.data.recordRead.content,'');
});
await check('paper-fill-same-account-order-provenance-only',async()=>{
  const f=fixture('paper'),tools=createFrozenEvalTools(f),answer=await invoke(tools,'platformRecall',{question:`Read ${account}/fill-1`});
  const fill=answer.data.data.exactRecords.records.find((r:any)=>r.source==='paper_fills');assert.ok(fill);assert.equal(fill.fields.order_id,'order-same');
  assert.equal(fill.fields.code,'000001.SZ');assert.equal(fill.fields.side,'buy');assert.equal(fill.fields.order_quantity,100);assert.equal(fill.fields.order_status,'filled');assert.ok(!answer.text.includes('CROSS_ACCOUNT_SECRET'));
});
await check('shared-budget-and-actual-self-identity',async()=>{
  const f=fixture('self'),tools=createFrozenEvalTools(f),self=await invoke(tools,'askMemory',{question:'What model and tools do you have?',domains:['self']});
  assert.equal(self.data.observations[0].identity.model,'actual-test-model');assert.equal(self.data.observations[0].identity.provider,'pi');assert.equal(self.data.observations[0].scope,'this_runtime_only');assert.equal(self.data.coverage.answerCompleteness,'not_verified');
  await invoke(tools,'readPlatformSource',{},'catalog-1');await assert.rejects(()=>invoke(tools,'readPlatformSource',{},'catalog-2'),/memory_read_not_repeated/);
});
await check('compact-catalog-and-all-entries-paged-without-selection-labels',async()=>{
  const extraFiles=Array.from({length:29},(_,index)=>doc('repository_file',`file:apps/web/lib/catalog-${index}.ts`,`export const catalogSource${index} = true;\n`,{path:`apps/web/lib/catalog-${index}.ts`}));
  const f=fixture('paged-catalog',[...baseDocuments(),...extraFiles]),tools=createFrozenEvalTools(f);
  const summary=await invoke(tools,'readPlatformSource',{});assert.equal(summary.data.status,'catalog_summary');assert.equal(summary.data.counts.repositoryFiles,30);assert.ok(!summary.data.entries&&!summary.data.sources);
  assert.ok(summary.text.length<2200);metrics.catalogSummaryCharacters=summary.text.length;
  const discovery=await invoke(tools,'platformRecall',{question:'Describe platform architecture',sections:['registry','architecture']});
  assert.equal(discovery.data.data.sourceCatalog.catalogHash,summary.data.catalogHash);assert.ok(discovery.text.length<5000);metrics.registryDiscoveryCharacters=discovery.text.length;
  const entries:any[]=[];let cursor:string|undefined;
  do{
    const page=await invoke(tools,'readPlatformSource',{view:'catalog',limit:12,...(cursor?{cursor}:{})},`catalog-page-${entries.length}`);
    assert.equal(page.data.status,'catalog_page');assert.equal(page.data.catalogHash,summary.data.catalogHash);assert.ok(page.data.entries.length<=12);assert.ok(page.text.length<12000);
    entries.push(...page.data.entries);cursor=page.data.nextCursor??undefined;
  }while(cursor);
  assert.equal(entries.length,summary.data.counts.totalEntries);assert.equal(entries.filter(e=>e.kind==='repository_file').length,30);
  assert.equal(new Set(entries.map(e=>JSON.stringify(e))).size,entries.length);assert.ok(!JSON.stringify(entries).includes('SCORING_SENTINEL'));
});
await check('catalog-cursor-drift-invalid-and-mixed-mode-denied',async()=>{
  const f=fixture('catalog-cursor'),tools=createFrozenEvalTools(f),first=await invoke(tools,'readPlatformSource',{view:'catalog',limit:1});assert.ok(first.data.nextCursor);
  await assert.rejects(()=>invoke(tools,'readPlatformSource',{cursor:first.data.nextCursor}),/requires view:catalog/);
  await assert.rejects(()=>invoke(tools,'readPlatformSource',{view:'catalog',cursor:'not-a-cursor'}),/Invalid.*cursor/);
  await assert.rejects(()=>invoke(tools,'readPlatformSource',{view:'catalog',cursor:Buffer.from('null').toString('base64url')}),/Invalid.*cursor/);
  await assert.rejects(()=>invoke(tools,'readPlatformSource',{view:'catalog',sourceId:'apps/web/lib/fixture.ts'}),/cannot be combined/);
  const altered=baseDocuments();altered.push(doc('repository_file','file:apps/web/lib/new-source.ts','export const newlyCaptured = true;\n',{path:'apps/web/lib/new-source.ts'}));
  const changedTools=createFrozenEvalTools(fixture('catalog-cursor-changed',altered)),changed=await invoke(changedTools,'readPlatformSource',{view:'catalog',cursor:first.data.nextCursor,limit:1});
  assert.equal(changed.data.status,'version_changed');assert.deepEqual(changed.data.entries,[]);assert.equal(changed.data.nextCursor,null);
});
await check('source-offset-reconstructs-long-lines-crlf-and-unicode',async()=>{
  const source='header\r\n'+'x'.repeat(19000)+'\r\n'+'\u4e2d\u6587\ud83d\ude00'.repeat(2600)+'\r\ntail\n';
  const documents=baseDocuments();const target=documents.find(d=>d.kind==='repository_file')!;target.content=source;target.sha256=digest(source);
  const tools=createFrozenEvalTools(fixture('continuous-source',documents));let request:any={sourceId:'apps/web/lib/fixture.ts',offset:0},reconstructed='',pages=0,contentHash:string|undefined;
  do{
    const page=await invoke(tools,'readPlatformSource',request,`source-page-${pages++}`);assert.equal(page.data.status,'read');assert.equal(page.data.representation,'raw_source_text');
    assert.equal(page.data.sourceHash,target.sha256);assert.equal(page.data.contentHash,contentHash??target.sha256);contentHash=page.data.contentHash;
    assert.equal(page.data.offset,reconstructed.length);assert.ok(page.data.content.length<=8000);reconstructed+=page.data.content;
    request=page.data.nextRead;if(request)assert.equal(request.offset,reconstructed.length);
  }while(request);
  assert.equal(reconstructed,source);assert.ok(pages>3);assert.equal(contentHash,digest(source));metrics.continuousSourcePages=pages;
});
await check('legacy-start-line-continues-partial-line-and-hash-refuses-mixing',async()=>{
  const source='header\r\n'+'z'.repeat(21000)+'\r\nfooter\n',documents=baseDocuments(),target=documents.find(d=>d.kind==='repository_file')!;target.content=source;target.sha256=digest(source);
  const tools=createFrozenEvalTools(fixture('legacy-source',documents)),first=await invoke(tools,'readPlatformSource',{sourceId:'apps/web/lib/fixture.ts',startLine:2});
  assert.equal(first.data.startLine,2);assert.equal(first.data.offset,'header\r\n'.length);assert.equal(first.data.nextLine,null);assert.ok(first.data.nextRead);assert.equal(first.data.content,'z'.repeat(8000));
  let reconstructed=first.data.content,next=first.data.nextRead;
  while(next){const page=await invoke(tools,'readPlatformSource',next,`legacy-${next.offset}`);reconstructed+=page.data.content;next=page.data.nextRead;}
  assert.equal(reconstructed,source.slice('header\r\n'.length));
  const changed=await invoke(tools,'readPlatformSource',{sourceId:'apps/web/lib/fixture.ts',offset:0,expectedHash:'0'.repeat(64)},'source-version-changed');
  assert.equal(changed.data.status,'version_changed');assert.equal(changed.data.content,'');assert.equal(changed.data.nextRead,null);
  await assert.rejects(()=>invoke(tools,'readPlatformSource',{sourceId:'apps/web/lib/fixture.ts',offset:1,startLine:2}),/not both/);
  await assert.rejects(()=>invoke(tools,'readPlatformSource',{sourceId:'apps/web/lib/fixture.ts',startLine:999}),/exceeds source length/);
});
await check('source-continuation-through-actual-ask-memory-delegation',async()=>{
  const documents=baseDocuments(),target=documents.find(d=>d.kind==='repository_file')!;target.content='header\n'+'a'.repeat(17000);target.sha256=digest(target.content);
  const tools=createFrozenEvalTools(fixture('delegated-source',documents));
  const first=await invoke(tools,'askMemory',{question:'Read source evidence',domains:[],reads:[{kind:'platform_source',id:'apps/web/lib/fixture.ts',offset:0}]},'delegated-first');
  assert.equal(first.data.observations[0].status,'retrieved');const page=JSON.parse(first.data.observations[0].evidence);assert.equal(page.offset,0);assert.ok(page.nextRead);
  const second=await invoke(tools,'askMemory',{question:'Continue source evidence',domains:[],reads:[{kind:'platform_source',id:page.nextRead.sourceId,offset:page.nextRead.offset,expectedHash:page.nextRead.expectedHash}]},'delegated-second');
  assert.equal(second.data.observations[0].status,'retrieved');const next=JSON.parse(second.data.observations[0].evidence);assert.equal(next.offset,page.nextOffset);assert.equal(next.contentHash,page.contentHash);
  assert.equal(first.result.details.result.details.delegatedReceipts[0].deliveredComplete,true);
  const changed=await invoke(tools,'askMemory',{question:'Read source version',domains:[],reads:[{kind:'platform_source',id:'apps/web/lib/fixture.ts',offset:0,expectedHash:'0'.repeat(64)}]},'delegated-changed');
  assert.equal(changed.data.observations[0].status,'unavailable');assert.equal(changed.result.details.result.details.delegatedReceipts[0].deliveredComplete,false);
});
await check('published-alias-resolves-only-an-actually-captured-file',async()=>{
  const document=doc('repository_file','file:apps/web/lib/memory/context/pack.ts','export const contextSelection = true;\n',{path:'apps/web/lib/memory/context/pack.ts'});
  const tools=createFrozenEvalTools(fixture('published-alias',[...baseDocuments(),document]));
  const page=await invoke(tools,'readPlatformSource',{sourceId:'memory-selection'});
  assert.equal(page.data.sourcePath,document.path);assert.equal(page.data.content,document.content);assert.equal(page.data.sourceHash,document.sha256);
  const absent=await invoke(tools,'readPlatformSource',{sourceId:'memory-policy'},'missing-published-alias');
  assert.equal(absent.data.status,'not_found_in_captured_scope');
});
await check('catalog-kind-and-cursor-scope-remain-bound',async()=>{
  const documents=baseDocuments();
  documents.push(doc('repository_file','file:apps/web/lib/fixture-two.ts','export const second = true;\n',{path:'apps/web/lib/fixture-two.ts'}));
  const tools=createFrozenEvalTools(fixture('catalog-kind',documents));
  const first=await invoke(tools,'readPlatformSource',{view:'catalog',kind:'repository_file',limit:1});
  assert.equal(first.data.totalEntries,2);assert.equal(first.data.entries[0].kind,'repository_file');assert.ok(first.data.nextCursor);
  const next=await invoke(tools,'readPlatformSource',{view:'catalog',kind:'repository_file',limit:1,cursor:first.data.nextCursor},'kind-next');
  assert.equal(next.data.entries[0].kind,'repository_file');assert.notEqual(first.data.entries[0].sourceId,next.data.entries[0].sourceId);
  await assert.rejects(()=>invoke(tools,'readPlatformSource',{view:'catalog',kind:'aggregate',cursor:first.data.nextCursor},'wrong-kind'),/cursor/);
  await assert.rejects(()=>invoke(tools,'readPlatformSource',{kind:'repository_file',query:'source'},'kind-without-view'),/view:catalog/);
  const stale=JSON.parse(Buffer.from(first.data.nextCursor,'base64url').toString('utf8'));stale.catalogHash='0'.repeat(64);
  const restartedTools=createFrozenEvalTools(fixture('catalog-kind-restart',documents));
  const changed=await invoke(restartedTools,'readPlatformSource',{view:'catalog',kind:'repository_file',limit:1,cursor:Buffer.from(JSON.stringify(stale)).toString('base64url')},'stale-kind');
  assert.equal(changed.data.status,'version_changed');assert.equal(changed.data.restart.kind,'repository_file');
  const restarted=await invoke(restartedTools,'readPlatformSource',changed.data.restart,'restart-kind');
  assert.equal(restarted.data.kind,'repository_file');assert.equal(restarted.data.entries[0].kind,'repository_file');
});
if(process.argv[3])await check('existing-corpus-compact-discovery-and-fixed-catalog-smoke',async()=>{
  const folder=path.resolve(process.argv[3]),manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
  const tools=createFrozenEvalTools({folder,manifest,question:{question:'Describe platform implementation',requester:{userId:manifest.ownerId}},model:'no-model-contract-check',provider:'none'});
  const summary=await invoke(tools,'readPlatformSource',{});assert.equal(summary.data.status,'catalog_summary');assert.equal(summary.data.counts.repositoryFiles,Object.keys(manifest.sourceHashes).length);assert.ok(summary.text.length<2200);
  const page=await invoke(tools,'readPlatformSource',{view:'catalog',limit:12});assert.equal(page.data.status,'catalog_page');assert.ok(page.data.entries.length<=12);assert.ok(page.text.length<12000);
  const discovery=await invoke(tools,'platformRecall',{question:'Describe platform implementation',sections:['registry','architecture'],limit:3});assert.equal(discovery.data.ok,true);assert.ok(discovery.text.length<5000);
  metrics.existingCorpusCatalogSummaryCharacters=summary.text.length;metrics.existingCorpusCatalogPageCharacters=page.text.length;metrics.existingCorpusRegistryDiscoveryCharacters=discovery.text.length;
});
const report={at:new Date().toISOString(),track:'deterministic-real-frozen-adapter-calls-no-model-no-production-db',readerContractVersion:FROZEN_SOURCE_READER_VERSION,adapterSha256:digest(fs.readFileSync(path.join(import.meta.dirname,'lib/platform-eval-v2-frozen-tools.mts'),'utf8')),checks:outcomes,metrics,passed:outcomes.filter(o=>o.passed).length,failed:outcomes.filter(o=>!o.passed).length};
if(process.argv[2])fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify(report,null,2));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'zhiyu-frozen-adapter-check-'),'Refuse cleanup outside this check\'s named temporary directory');
fs.rmSync(root,{recursive:true,force:true});
process.exit(report.failed?1:0);
