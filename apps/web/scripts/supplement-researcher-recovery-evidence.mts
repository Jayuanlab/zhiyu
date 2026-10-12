import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import YAML from 'yaml';
const base='http://127.0.0.1:3515',id='cec5143f-567b-453d-9d18-4ad90d193572';
const folder=resolve('.tmp/agent-frontier-role-20261002/recovery-evidence',String(Date.now()));
mkdirSync(folder,{recursive:true});
async function api(path:string,body?:unknown,method='POST'){
 const response=await fetch(base+path,body?{method,headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)}:undefined);
 const data=await response.json();if(!response.ok)throw Error(JSON.stringify({status:response.status,data}));return data;
}
const paths=[
 'docs/reviews/researcher-recovery-evidence-2026-10-02.md',
 'apps/web/lib/work-runtime/run-plan.ts','apps/web/lib/work-runtime/output-step.ts',
 'apps/web/lib/workshops/runtime.ts','apps/web/lib/workshops/loop-runtime.ts',
 'apps/web/lib/workshops/mcp-tools.ts','apps/web/lib/work-evolution/report-quality-evaluator.ts',
 'apps/web/lib/work-runtime/outbox-attempt.ts','apps/web/lib/work-runtime/outbox-recovery.ts',
 'apps/web/lib/work-runtime/outbox-resolution.ts',
 'apps/web/tests/integration/execution-lease.check.ts','apps/web/tests/integration/execution-lease-concurrency.mjs',
 'apps/web/tests/integration/outbox-recovery.check.ts',
 'docs/plans/2026-09-06-review-remediation/records/research-recovery-lease-20261002-postgres.json',
 'docs/plans/2026-09-06-review-remediation/records/research-recovery-outbox-20261002-postgres.json',
 'apps/web/tests/integration/loop-lifecycle.test.mjs',
 'docs/plans/2026-09-06-review-remediation/records/research-recovery-loop-20261002-postgres.json',
 'docs/plans/2026-09-06-review-remediation/records/research-recovery-loop-fixed-20261002-postgres.json',
];
for(const path of paths)readFileSync(resolve('../..',path),'utf8');
const before=await api(`/api/workshops/${id}/manifest`);
writeFileSync(resolve(folder,'before.yaml'),before.manifestYaml,'utf8');
const manifest=YAML.parse(before.manifestYaml),loop=manifest.spec.loops.find((x:any)=>x.name==='agent-frontier-study');
const additions=paths.map(path=>({name:'zhiyu-project-source-v2:'+path,type:'file',uri:resolve('../..',path),purpose:'恢复机制工程交接证据。每轮读取当前副本；测试结果仅证明指定隔离场景，不代表全工具或生产验收。',freshnessPolicy:'per_run_content_hash'}));
for(const source of additions){
 if(!manifest.spec.sources.some((x:any)=>x.name===source.name))manifest.spec.sources.push(source);
 if(!loop.context.sources.some((x:any)=>x.name===source.name))loop.context.sources.push({name:source.name,type:source.type,uri:source.uri});
}
const hint='恢复机制研究先读取 researcher-recovery-evidence-2026-10-02.md 及相关原始测试回执；工程侧测试与自身工具调用分开。未包装 recorded-step 不等于无外部幂等机制。';
if(!loop.context.instructions.includes(hint))loop.context.instructions+='\n'+hint;
const candidate=YAML.stringify(manifest);
writeFileSync(resolve(folder,'candidate.yaml'),candidate,'utf8');
const review=await api(`/api/workshops/${id}`,{manifestYaml:candidate,dryRun:true},'PATCH');
if(!review.review.ok)throw Error(JSON.stringify(review.review.issues));
const receipt=await api(`/api/workshops/${id}`,{manifestYaml:candidate,expectedVersion:before.commandVersion,commandId:`researcher-recovery-evidence-20261002:${before.commandVersion}`},'PATCH');
writeFileSync(resolve(folder,'receipt.json'),JSON.stringify(receipt,null,2),'utf8');
const after=await api(`/api/workshops/${id}/manifest`),loaded=YAML.parse(after.manifestYaml);
const loadedLoop=loaded.spec.loops.find((x:any)=>x.name==='agent-frontier-study');
for(const source of additions){if(!loaded.spec.sources.some((x:any)=>x.name===source.name)||!loadedLoop.context.sources.some((x:any)=>x.name===source.name))throw Error('Source readback mismatch');}
if(/\uFFFD|\?{3}/u.test(after.manifestYaml))throw Error('Encoding mismatch');
writeFileSync(resolve(folder,'after.yaml'),after.manifestYaml,'utf8');
const templatePath=resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml'),template=YAML.parse(readFileSync(templatePath,'utf8'));
template.spec.sources=manifest.spec.sources;template.spec.loops.find((x:any)=>x.name==='agent-frontier-study').context=loop.context;
writeFileSync(templatePath,YAML.stringify(template),'utf8');
console.log(JSON.stringify({commandVersion:after.commandVersion,addedEvidenceSources:additions.length,totalLoopSources:loadedLoop.context.sources.length,trigger:loadedLoop.trigger,allowedActions:loadedLoop.allowedActions,deniedActions:loadedLoop.deniedActions}));
