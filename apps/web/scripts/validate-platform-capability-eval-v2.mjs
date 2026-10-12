// Dataset/ground-truth checks only. This never evaluates a model or executes a workflow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { validateV2Catalog,validateV2QuestionInputs,buildV2Rubric,PLATFORM_EVAL_V2_SUITE_VERSION } from './lib/platform-eval-v2-contract.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const argument=process.argv.find(arg=>arg.startsWith('--folder='))?.slice(9);
const folder=argument?path.resolve(argument):path.join(root,'docs/evals/platform-capability-100-v2');
const read=name=>fs.readFileSync(path.join(folder,name),'utf8');
const json=name=>JSON.parse(read(name));
const lines=name=>read(name).trim().split('\n').filter(Boolean).map(JSON.parse);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const raw=json('cases.json');
const cases=Array.isArray(raw)?raw:raw.cases;
const errors=[...validateV2Catalog(cases).errors];
const check=(condition,message)=>{if(!condition)errors.push(message);};
const equal=(left,right)=>{try{assert.deepStrictEqual(left,right);return true;}catch{return false;}};
let negativeChecks=0;
const privatePackage=fs.existsSync(path.join(folder,'manifest.json'));
if(privatePackage){
  const manifest=json('manifest.json'),questions=lines('questions.jsonl'),gold=lines('gold.jsonl'),corpus=lines('corpus.jsonl'),rubrics=json('rubric.json'),results=lines('results-template.jsonl');
  check(manifest.suiteVersion===PLATFORM_EVAL_V2_SUITE_VERSION,'manifest suite version');
  check(manifest.performanceStatus==='not_run','unearned performance claim');
  errors.push(...validateV2QuestionInputs(questions).errors);
  for(const collection of [questions,gold,rubrics,results])check(collection.length===100&&new Set(collection.map(row=>row.id)).size===100,'split count/IDs');
  const documents=new Map(corpus.map(document=>[document.id,document]));
  check(documents.size===corpus.length,'duplicate evidence IDs');
  for(const document of corpus){
    check(document.sha256===hash(document.content),`evidence hash ${document.id}`);
    check(document.ownerId===manifest.ownerId,`evidence owner ${document.id}`);
    check(document.capturedAt===(document.kind==='repository_file'?manifest.repositoryCapturedAt:manifest.recordSnapshotCapturedAt),`evidence time ${document.id}`);
    if(document.kind==='repository_file')check(!/eval(?:s|uation)?[\/\\]|eval.*spec|rubric/i.test(document.path),'evaluation material in corpus');
  }
  for(const c of cases){
    const question=questions.find(row=>row.id===c.id),answer=gold.find(row=>row.id===c.id),rubric=rubrics.find(row=>row.id===c.id),result=results.find(row=>row.id===c.id);
    check(question?.question===c.question&&question?.asOf===c.asOf&&equal(question?.requester,c.requester),`question mismatch ${c.id}`);
    check(equal(answer?.expected,c.expected)&&equal(answer?.scoring,c.scoring)&&equal(answer?.evidence,c.evidence),`gold mismatch ${c.id}`);
    check(equal(rubric,{id:c.id,...buildV2Rubric(c)}),`rubric mismatch ${c.id}`);
    check(result?.status==='not_run'&&result.score===null,`result template ${c.id}`);
    check(manifest.executionTracks[c.id]===c.executionTrack,`execution track ${c.id}`);
    check(c.asOf===(c.executionTrack==='record_qa'?manifest.recordSnapshotCapturedAt:manifest.repositoryCapturedAt)&&c.requester.userId===manifest.ownerId,`scope/time ${c.id}`);
    const evidence=c.evidence.map(ref=>documents.get(ref));
    check(evidence.length>0&&evidence.every(Boolean),`missing source ${c.id}`);
    if(!evidence.every(Boolean))continue;
    for(const [side,index] of [['facts',0],['left',0],['right',1]])if(c.expected[side]){
      for(const [key,value] of Object.entries(c.expected[side]))check(equal(value,evidence[index]?.content?.[key]),`unsupported fact ${c.id}.${side}.${key}`);
    }
    if(c.expected.relationship){const {leftKey,rightKey}=c.expected.relationship;
      check(evidence[0]?.content?.[leftKey]===evidence[1]?.content?.[rightKey],`broken association ${c.id}`);
      if(evidence[0]?.table==='paper_fills')check(evidence[0].content.account_id===evidence[1].content.account_id,`cross-account association ${c.id}`);
    }
    if(c.expected.groups){check(equal(c.expected.groups,evidence[0].content.groups)&&c.expected.total===evidence[0].content.total,`unsupported aggregate ${c.id}`);
      check(c.expected.groups.reduce((sum,group)=>sum+group.count,0)===c.expected.total,`aggregate sum ${c.id}`);}
    for(const ref of c.sourceRefs??[])check(documents.get(`file:${ref.path}`)?.content.includes(ref.anchor),`stale source anchor ${c.id}`);
  }
  check(manifest.rubricHash===hash(cases.map(buildV2Rubric)),'manifest rubric hash');
  for(const [name,expected]of Object.entries(json('integrity.json')))check(hash(read(name))===expected,`file integrity ${name}`);
}else{
  check(raw.suiteVersion===PLATFORM_EVAL_V2_SUITE_VERSION,'public catalog suite version');
  check(raw.executionStatus==='not_run','public catalog execution status');
  for(const c of cases)for(const ref of c.sourceRefs??[]){
    const absolute=path.resolve(root,ref.path);
    check(absolute.startsWith(root+path.sep)&&fs.existsSync(absolute),`source path ${c.id}`);
    if(fs.existsSync(absolute))check(fs.readFileSync(absolute,'utf8').includes(ref.anchor),`current anchor ${c.id}`);
  }
}
if(!errors.length&&process.argv.includes('--self-test')){
  const corruptions=[
    value=>value.pop(),value=>{value[1].id=value[0].id;},value=>{value[0].scoring.requirements=[];},
    value=>{value[0].evalRequirements={requiredTools:['platformRecall']};},
    value=>{value.find(c=>c.executionTrack==='sandbox_workflow').productionExecutionAllowed=true;},
    value=>{value[0].question='\uFFFD';},
  ];
  for(const corrupt of corruptions){const candidate=structuredClone(cases);corrupt(candidate);assert(!validateV2Catalog(candidate).valid);negativeChecks++;}
  const clean={id:'REAL-001',question:cases[0].question};
  assert(validateV2QuestionInputs([clean]).valid);
  assert(!validateV2QuestionInputs([{...clean,expected:'answer leak'}]).valid);negativeChecks++;
}
const report={status:errors.length?'failed':'passed',suiteVersion:PLATFORM_EVAL_V2_SUITE_VERSION,caseCount:cases.length,
  changes:cases.reduce((out,c)=>(out[c.change.kind]=(out[c.change.kind]??0)+1,out),{}),
  tracks:cases.reduce((out,c)=>(out[c.executionTrack]=(out[c.executionTrack]??0)+1,out),{}),
  checks:'definition-integrity-input-separation-source-grounding-only',negativeChecks,errors,modelEvaluation:'not_run',workflowEvaluation:'not_run'};
if(privatePackage)fs.writeFileSync(path.join(folder,'validation.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify(report,null,2));
if(errors.length)process.exitCode=1;
