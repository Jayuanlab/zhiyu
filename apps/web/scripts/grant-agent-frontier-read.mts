import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import YAML from 'yaml';
const base='http://127.0.0.1:3515',workId='cec5143f-567b-453d-9d18-4ad90d193572';
const folder=resolve('.tmp/agent-frontier-read-20261002');mkdirSync(folder,{recursive:true});
async function api(path:string,body?:unknown,method='POST'){
 const res=await fetch(base+path,body?{method,headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)}:undefined);
 const data=await res.json();if(!res.ok)throw Error(JSON.stringify({status:res.status,data}));return data;
}
const baseline=await api(`/api/workshops/${workId}/manifest`);
writeFileSync(resolve(folder,'before.yaml'),baseline.manifestYaml,'utf8');
const m=YAML.parse(baseline.manifestYaml),s=m.spec;
if(s.role!=='agent_frontier_researcher')throw Error('Unexpected target');
for(const key of ['allowedTools','observationTools'])s.modelConfig[key]=[...new Set([...(s.modelConfig[key]??[]),'Read'])];
s.boundaryPolicy.hardDeniedActions=[...new Set([...(s.boundaryPolicy.hardDeniedActions??[]),'PowerShell'])];
const files=[
 'docs/architecture/engineering-cybernetics-guiding-principles.md',
 'docs/architecture/zhiyu-control-architecture-contract.md',
 'apps/web/lib/work-runtime/execution-lease.ts',
 'apps/web/lib/work-runtime/loop-execution.ts',
 'apps/web/lib/work-runtime/loop-consumer.ts',
 'apps/web/lib/work-runtime/loop-control-state.ts',
 'apps/web/lib/loops/native-executor.ts',
 'apps/web/lib/workshops/pi-local-tools.ts',
];
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:resolve('../..'),encoding:'utf8'}).trim();
const sources=files.map(path=>{
 const uri=resolve('../..',path);const sha256=createHash('sha256').update(readFileSync(uri)).digest('hex');
 return {name:`zhiyu-source:${path}`,type:'file',uri,purpose:`主人授权的恢复机制研究源码/架构资料：${path}。参考 HEAD=${head}；工作区可能有未提交修改，以本文件 SHA-256 为实际版本依据。`,sha256,repositoryHead:head,observedAt:new Date().toISOString()};
});
for(const source of sources){const index=s.sources.findIndex((item:any)=>item.name===source.name);if(index>=0)s.sources[index]=source;else s.sources.push(source);}
for(const l of s.loops){
 l.actionPolicy.allowed=[...new Set([...l.actionPolicy.allowed,'Read'])];
 l.actionPolicy.denied=[...new Set([...(l.actionPolicy.denied??[]),'PowerShell'])];
 l.context.instructions += '\n源码读取只限系统准备的获准副本，引用文件及 SHA-256；文件变动时停止沿用旧依据。未经读取不得判断项目是否实现对应机制。';
 const existingNames=new Set(l.context.sources.map((x:any)=>x.name));
 for(const source of sources)if(!existingNames.has(source.name))l.context.sources.push({type:'file',name:source.name,uri:source.uri});
}
const candidate=YAML.stringify(m);
if(/\uFFFD|\?{3}/u.test(candidate))throw Error('Encoding invalid');
writeFileSync(resolve(folder,'candidate.yaml'),candidate,'utf8');
const checked=await api(`/api/workshops/${workId}`,{manifestYaml:candidate,dryRun:true},'PATCH');
if(!checked.review.ok)throw Error(JSON.stringify(checked.review.issues));
const applied=await api(`/api/workshops/${workId}`,{manifestYaml:candidate,expectedVersion:baseline.commandVersion,commandId:`agent-frontier-read-20261002:${baseline.commandVersion}`},'PATCH');
writeFileSync(resolve(folder,'receipt.json'),JSON.stringify(applied,null,2),'utf8');
const after=await api(`/api/workshops/${workId}/manifest`);
writeFileSync(resolve(folder,'after.yaml'),after.manifestYaml,'utf8');
const saved=YAML.parse(after.manifestYaml);
if(!saved.spec.modelConfig.allowedTools.includes('Read'))throw Error('Read grant missing');
for(const l of saved.spec.loops){const old=s.loops.find((x:any)=>x.name===l.name);if(l.status!==old.status||JSON.stringify(l.trigger)!==JSON.stringify(old.trigger))throw Error('Activation changed');if(!l.actionPolicy.allowed.includes('Read'))throw Error('Loop grant missing');}
for(const source of sources){const found=saved.spec.sources.find((x:any)=>x.name===source.name);if(!found||found.sha256!==source.sha256||found.uri!==source.uri)throw Error('Source readback mismatch');}
if(/\uFFFD|\?{3}/u.test(after.manifestYaml))throw Error('Readback encoding invalid');
console.log(JSON.stringify({workId,beforeVersion:baseline.commandVersion,afterVersion:after.commandVersion,allowedTools:saved.spec.modelConfig.allowedTools,sourceCount:sources.length,review:checked.review.ok,readback:true},null,2));
