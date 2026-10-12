// Build a versioned evaluation package. No model, application write or business action is called.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { definitions, suiteVersion, designDate } from './platform-capability-eval-v2-specs.mjs';
import { validateV2Catalog, validateV2QuestionInputs, buildV2Rubric } from './lib/platform-eval-v2-contract.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const publicFolder=path.join(root,'docs/evals/platform-capability-100-v2');
const privateBase=path.join(root,'.runtime/evals/platform-capability-100-v2');
const snapshotArgument=process.argv.find(arg=>arg.startsWith('--snapshot='))?.slice(11);
const catalogOnly=process.argv.includes('--catalog-only');
if(!snapshotArgument&&!catalogOnly) throw Error('Use --snapshot=<legacy snapshot folder or snapshot.json> or --catalog-only. A snapshot is never inferred from live data.');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const repositoryCapturedAt=new Date().toISOString();
const write=(folder,name,value)=>fs.writeFileSync(path.join(folder,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n','utf8');
const counts=(items,field)=>items.reduce((result,item)=>{const key=field(item);result[key]=(result[key]??0)+1;return result;},{});
const project=(value,names)=>Object.fromEntries(names.map(name=>{
  if(!Object.hasOwn(value??{},name)) throw Error(`Asked field is absent from snapshot projection: ${name}`);
  return [name,value[name]];
}));
const requirementList=expected=>Object.entries(expected).flatMap(([key,value])=>{
  if(['nullMeans','basis'].includes(key)) return [];
  if(key==='must') return value.map((entry,index)=>({id:`must.${index}`,expected:entry}));
  if(['facts','left','right'].includes(key)) return Object.entries(value).map(([name,fact])=>({id:`${key}.${name}`,expected:fact}));
  if(key==='relationship') return [{id:'relationship',expected:'正确说明两个证据对象的关联；不要求复述外键名称。'}];
  return [{id:key,expected:value}];
});
const safeSource=ref=>{
  const absolute=path.resolve(root,ref.path);
  if(!absolute.startsWith(root+path.sep)||/(?:^|[/\\])(?:\.env[^/\\]*|\.runtime|node_modules)(?:[/\\]|$)/.test(ref.path)
    ||/eval(?:s|uation)?[\/\\]|eval.*spec|rubric/i.test(ref.path)) throw Error(`Disallowed evaluation source: ${ref.path}`);
  const content=fs.readFileSync(absolute,'utf8');
  const position=content.indexOf(ref.anchor);
  if(position<0) throw Error(`Stale source anchor: ${ref.path}: ${ref.anchor}`);
  return {id:`file:${ref.path}`,kind:'repository_file',path:ref.path,content,sha256:hash(content),
    locator:{path:ref.path,anchor:ref.anchor,line:content.slice(0,position).split('\n').length}};
};
// These are evidence files, not questions or gold. Authoring files are expressly excluded.
const sourceDocuments=new Map();
for(const definition of definitions) for(const ref of definition.sourceRefs??[]) {
  const document=safeSource(ref);
  if(!sourceDocuments.has(document.id)) sourceDocuments.set(document.id,document);
}

function expectedFor(definition,legacy,documents,snapshot){
  if(definition.binding.kind==='source') return {must:definition.must};
  if(definition.binding.kind==='record') {
    const source=snapshot.sources[definition.binding.table];
    const row=source?.rows[definition.binding.rowIndex??0];
    if(!row) throw Error(`${definition.id}: missing real record; do not invent a fixture`);
    return {facts:project(row,definition.projection.facts),must:definition.must};
  }
  const original=legacy.expected;
  const expected=structuredClone(original);
  const projection=definition.projection;
  if(projection?.facts && original.facts && !legacy.dataShape) expected.facts=project(documents.get(legacy.evidence[0]).content,projection.facts);
  if(projection?.left) expected.left=project(documents.get(legacy.evidence[0]).content,projection.left);
  if(projection?.right) expected.right=project(documents.get(legacy.evidence[1]).content,projection.right);
  if(projection?.must) return {must:definition.must};
  expected.must=[...new Set([...(expected.must??[]),...(definition.must??[])])];
  // Gold states absence only if the count query actually observed absence.
  if(legacy.dataShape) return {must:[...definition.must,'只证明快照时该用户该来源无记录；无法报告不存在的最近调度记录，不能推断所有任务没运行或整个平台没有该功能。']};
  return expected;
}
function label(document){
  const row=document.content;
  const name=row.name??row.title??row.subject??row.conversation_name;
  return `${name?`“${String(name).slice(0,70)}”`:document.table}（记录 ${document.recordId}）`;
}

function renderCases(cases,privateData=false){
  const changeLabels={retained:'保留核心考点',rewritten:'重写',replaced:'替换'};
  const trackLabels={record_qa:'固定快照问答',source_qa:'当前实现与规则问答',sandbox_workflow:'隔离工作流'};
  return `# 当前功能评测 100 题 v2\n\n版本：${suiteVersion}；设计日期：${designDate}。${privateData?'含本地私有绑定与评分答案，仅保留本地。':'公开模板不包含私有消息、真实对象或生产答案。'}\n\n这不是实跑成绩。每题的对象/原文由正常受控读取提供，评分要点、禁止行为和夹具说明不传入模型。\n\n`+
    cases.map(c=>`## ${c.id} · ${c.category}\n\n${c.question}\n\n- 变更：${changeLabels[c.change.kind]}。${c.change.reason}\n- 轨道：${trackLabels[c.executionTrack]}。\n- 来源：${(c.sourceRefs??[]).map(r=>`\`${r.path}\`（${r.anchor}）`).join('；')||'原题绑定的真实数据库记录、关联记录或全量统计查询；私有包保留证据ID。'}\n\n必须满足：\n\n${c.scoring.requirements.map(r=>`- ${r.id}：${typeof r.expected==='string'?r.expected:JSON.stringify(r.expected)}`).join('\n')}\n\n禁止：\n\n${c.scoring.mustNot.map(text=>`- ${text}`).join('\n')}\n${c.fixture?`\n夹具：${c.fixture.setup}\n\n回执断言：\n\n${c.fixture.assertions.map(a=>`- ${a.id}（${a.type}）：${a.expected}`).join('\n')}\n\n工作流必须观察真实服务/工具回执与前后状态。仅回答“会这样做”不算执行通过；没有隔离适配器记 fixture_error，不能使用生产业务当夹具。\n`:''}`).join('\n');
}

// Public definitions use field placeholders, never live private values.
const publicCases=definitions.map(definition=>{
  const fields=Object.entries(definition.projection??{}).filter(([,value])=>Array.isArray(value))
    .flatMap(([side,names])=>names.map(name=>({id:`${side}.${name}`,expected:`从实际来源核对题目所问的 ${name}；语义一致即可，未记录时披露未知。`}))) ;
  const must=(definition.must??[]).map((text,index)=>({id:`must.${index}`,expected:text}));
  const requirements=[...fields,...must];
  if(!requirements.length) requirements.push({id:'answer',expected:'只回答问题实际询问的事实，并说明来源、范围及未知；具体 gold 在本地快照包中绑定。'});
  return {...definition,question:definition.questionTemplate,expected:{must:requirements.map(r=>r.expected)},
    evidence:definition.sourceRefs?.map(ref=>`file:${ref.path}`)??[`binding:${definition.id}`],executionStatus:'not_run',
    scoring:{requirements,mustNot:definition.mustNot,toolPolicy:definition.toolPolicy}};
});
const publicValidation=validateV2Catalog(publicCases);
if(!publicValidation.valid) throw Error(`Invalid public catalog: ${publicValidation.errors.join('; ')}`);
fs.mkdirSync(publicFolder,{recursive:true});
write(publicFolder,'cases.json',{suiteVersion,designDate,executionStatus:'not_run',cases:publicCases});
write(publicFolder,'cases.md',renderCases(publicCases));
write(publicFolder,'questions.md',`# 根据现有功能重设计的100题\n\n版本：${suiteVersion}；日期：${designDate}。保留46题核心，重写39题，替换15题。\n\n67题核对记录与统计，23题核查当前实现和规则，10题在隔离环境中实际操作。所选对象在私有评测包中绑定；这里不展示私人记录。全部尚未运行。\n\n`+
  definitions.map((c,index)=>`${index+1}. **${c.id}**${c.executionTrack==='sandbox_workflow'?'【隔离操作】':''} ${c.questionTemplate}`).join('\n\n')+'\n');
write(publicFolder,'changes.md',`# 100 题逐题修订\n\n旧题文件、快照、gold、运行记录和分数保留。新版分数不能直接与旧分数比较。\n\n保留46题核心考点，重写39题，替换15题。保留指核心任务保留；措辞、未问字段、证据时点和评分公平性仍统一校正。\n\n| 题号 | 处理 | 新任务 | 修订依据 | 轨道 |\n| --- | --- | --- | --- | --- |\n`+
  definitions.map(c=>`| ${c.id} | ${c.change.kind} | ${c.questionTemplate.replaceAll('|','／')} | ${c.change.reason.replaceAll('|','／')} | ${c.executionTrack} |`).join('\n')+'\n');
if(catalogOnly){console.log(JSON.stringify({suiteVersion,publicFolder,count:100,changes:counts(definitions,c=>c.change.kind),tracks:counts(definitions,c=>c.executionTrack),performanceStatus:'not_run'},null,2));process.exit(0);}

const sourceFolder=path.resolve(snapshotArgument.endsWith('snapshot.json')?path.dirname(snapshotArgument):snapshotArgument);
const parse=name=>JSON.parse(fs.readFileSync(path.join(sourceFolder,name),'utf8'));
const sourceManifest=parse('manifest.json'),snapshot=parse('snapshot.json'),legacyCases=parse('cases.json');
const originalIntegrity=parse('integrity.json');
for(const [name,expected] of Object.entries(originalIntegrity)) if(hash(fs.readFileSync(path.join(sourceFolder,name),'utf8'))!==expected) throw Error(`Source snapshot integrity mismatch: ${name}`);
if(sourceManifest.version!==1||sourceManifest.caseCount!==100||snapshot.ownerId!==sourceManifest.ownerId||snapshot.capturedAt!==sourceManifest.capturedAt) throw Error('Unsupported or inconsistent source snapshot');
const legacyById=new Map(legacyCases.map(c=>[c.id,c]));
const originalDocuments=fs.readFileSync(path.join(sourceFolder,'corpus.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const documents=new Map(originalDocuments.filter(d=>!d.id.startsWith('file:')).map(d=>[d.id,d]));
for(const document of sourceDocuments.values())documents.set(document.id,{...document,capturedAt:repositoryCapturedAt,ownerId:snapshot.ownerId});
const cases=definitions.map(definition=>{
  const legacy=legacyById.get(definition.id);
  if(!legacy) throw Error(`Missing legacy case ${definition.id}`);
  let question=definition.questionTemplate;
  let evidence=definition.sourceRefs?.map(ref=>`file:${ref.path}`)??legacy.evidence;
  if(definition.binding.kind==='legacy') {
    if(definition.suffix && !legacy.dataShape) question=`${definition.questionTemplate}\n对象：${label(documents.get(legacy.evidence[0]))}`;
    else if(legacy.dataShape) question='请核查当前用户的车间调度记录。若该来源没有记录，最近调度状态、错误和失败次数能否确认？能否据此认定所有持续任务没有运行？';
  }else if(definition.binding.kind==='record'){
    const row=snapshot.sources[definition.binding.table]?.rows[definition.binding.rowIndex??0];
    const document=[...documents.values()].find(d=>d.table===definition.binding.table&&d.content.id===row?.id);
    if(!document)throw Error(`${definition.id}: missing bound evidence`);
    evidence=[document.id];question=`${definition.questionTemplate}\n对象：${label(document)}`;
  }
  const expected=expectedFor(definition,legacy,documents,snapshot);
  if(definition.executionTrack==='record_qa') question=`在随题提供的只读数据快照（${snapshot.capturedAt}）中，${question}`;
  return {...definition,question,asOf:definition.executionTrack==='record_qa'?snapshot.capturedAt:repositoryCapturedAt,requester:{type:'chat',userId:snapshot.ownerId,accessMode:'owner_override'},
    expected,evidence,executionStatus:'not_run',mutationsAllowed:definition.executionTrack==='sandbox_workflow'?'isolated_only':'none',
    scoring:{requirements:requirementList(expected),mustNot:definition.mustNot,toolPolicy:definition.toolPolicy}};
});
const catalogValidation=validateV2Catalog(cases);
if(!catalogValidation.valid)throw Error(`Invalid bound catalog: ${catalogValidation.errors.join('; ')}`);
const questions=cases.map(({id,question,asOf,requester})=>({id,question,asOf,requester}));
const inputValidation=validateV2QuestionInputs(questions);
if(!inputValidation.valid)throw Error(`Input leakage: ${inputValidation.errors.join('; ')}`);
const needed=new Set(cases.flatMap(c=>c.evidence));
for(const evidence of needed)if(!documents.has(evidence))throw Error(`Unresolved gold evidence ${evidence}`);
// Preserve related raw row evidence in the frozen corpus, but never import old answer files or evaluation specs.
const corpus=[...documents.values()].map(({locator,...document})=>document);
const generatedAt=new Date().toISOString();
const folder=path.join(privateBase,generatedAt.replace(/[:.]/g,'-'));
fs.mkdirSync(folder,{recursive:true});
const manifest={suiteVersion,designDate,generatedAt,capturedAt:snapshot.capturedAt,recordSnapshotCapturedAt:snapshot.capturedAt,repositoryCapturedAt,ownerId:snapshot.ownerId,sourceSnapshot:sourceFolder,
  sourceSnapshotManifestHash:hash(fs.readFileSync(path.join(sourceFolder,'manifest.json'),'utf8')),
  caseCount:100,changes:counts(cases,c=>c.change.kind),tracks:counts(cases,c=>c.executionTrack),categories:counts(cases,c=>c.category),
  executionTracks:Object.fromEntries(cases.map(c=>[c.id,c.executionTrack])),performanceStatus:'not_run',goldInjected:false,
  inputProtocol:'raw-user-question.v2',recordDataPolicy:'frozen snapshot must be accessible through normal isolated read tools; live reads require contemporaneous gold and a drift audit',
  workflowPolicy:'isolated fixtures only; prose answers are not execution receipts; no complete workflow runner shipped',
  comparisonPolicy:'different suite/gold versions are not directly comparable; all new cases are author-visible, not human-blind holdout',
  specificationHash:hash(fs.readFileSync(new URL('./platform-capability-eval-v2-specs.mjs',import.meta.url),'utf8')),
  rubricHash:hash(cases.map(buildV2Rubric)),sourceHashes:Object.fromEntries([...sourceDocuments.values()].map(d=>[d.path,d.sha256]))};
write(folder,'manifest.json',manifest);write(folder,'cases.json',cases);
write(folder,'questions.jsonl',questions.map(q=>JSON.stringify(q)).join('\n')+'\n');
write(folder,'gold.jsonl',cases.map(({id,category,expected,evidence,scoring,executionTrack,sourceRefs,fixture})=>JSON.stringify({id,category,expected,evidence,scoring,executionTrack,sourceRefs,fixture})).join('\n')+'\n');
write(folder,'corpus.jsonl',corpus.map(d=>JSON.stringify(d)).join('\n')+'\n');
write(folder,'rubric.json',cases.map(c=>({id:c.id,...buildV2Rubric(c)})));
write(folder,'results-template.jsonl',cases.map(c=>JSON.stringify({id:c.id,status:'not_run',fixtureStatus:c.executionTrack==='sandbox_workflow'?'not_prepared':'not_checked',answer:null,score:null})).join('\n')+'\n');
write(folder,'cases.md',renderCases(cases,true));
write(folder,'integrity.json',Object.fromEntries(fs.readdirSync(folder).map(name=>[name,hash(fs.readFileSync(path.join(folder,name),'utf8'))])));
write(privateBase,'latest.json',{folder,suiteVersion,generatedAt});
console.log(JSON.stringify({folder,suiteVersion,caseCount:100,changes:manifest.changes,tracks:manifest.tracks,capturedAt:manifest.capturedAt,sourceAnchorsChecked:true,performanceStatus:'not_run'},null,2));
