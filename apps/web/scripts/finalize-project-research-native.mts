import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import YAML from 'yaml';
const base='http://127.0.0.1:3515',id='cec5143f-567b-453d-9d18-4ad90d193572',folder=resolve('.tmp/agent-frontier-role-20261002');
async function api(path:string,body?:unknown,method='POST'){
 const r=await fetch(base+path,body?{method,headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)}:undefined);
 const d=await r.json();if(!r.ok)throw Error(JSON.stringify({status:r.status,data:d}));return d;
}
const baseline=await api(`/api/workshops/${id}/manifest`),m=YAML.parse(baseline.manifestYaml);
const paths=JSON.parse(readFileSync(resolve(folder,'applied-summary.json'),'utf8')).sourcePaths;
const fresh=paths.map((p:string)=>({name:'zhiyu-project-source-v2:'+p,type:'file',uri:resolve('../..',p),purpose:'主人授权的持续项目资料。每轮获取当前文件副本并计算哈希，绑定实际读取范围；项目变化时旧结论须重验。',freshnessPolicy:'per_run_content_hash'}));
m.spec.sources=m.spec.sources.filter((x:any)=>!x.name?.startsWith('zhiyu-source:')&&!x.name?.startsWith('zhiyu-project-source-v2:')).concat(fresh);
const l=m.spec.loops.find((x:any)=>x.name==='agent-frontier-study');
l.trigger={type:'cron',expression:'0 9 * * *',timezone:'Asia/Shanghai'};
l.context.instructions=l.context.instructions.replace(/\n当前宿主每天 09:00[^\n]*/u,'');
l.context.instructions+='\n每日研究由知遇项目原生后台工作器和本 Loop 调度执行，不依赖 Codex 定时。只有真实运行与保存回执才能说明持续研究已执行。';
l.context.sources=l.context.sources.filter((x:any)=>!x.name?.startsWith('zhiyu-source:')&&!x.name?.startsWith('zhiyu-project-source-v2:')).concat(fresh.map((x:any)=>({name:x.name,type:'file',uri:x.uri})));
m.spec.creationReport={title:'知遇技术研究员 v2（项目原生调度）',body:'在知遇项目中维护同一车间、持续 Loop 和研究状态。每天 09:00（Asia/Shanghai）检查，有用增量再汇报；无需 Codex 定时。源码通过明确登记来源准备当轮副本；后台工作器需在线，事实、业务效果和静默通知需核验。'};
const candidate=YAML.stringify(m);const review=await api(`/api/workshops/${id}`,{manifestYaml:candidate,dryRun:true},'PATCH');if(!review.review.ok)throw Error(JSON.stringify(review.review.issues));
const receipt=await api(`/api/workshops/${id}`,{manifestYaml:candidate,expectedVersion:baseline.commandVersion,commandId:`project-researcher-native-v2-20261002:${baseline.commandVersion}`},'PATCH');
writeFileSync(resolve(folder,'native-receipt.json'),JSON.stringify(receipt,null,2),'utf8');
const after=await api(`/api/workshops/${id}/manifest`);writeFileSync(resolve(folder,'native-after.yaml'),after.manifestYaml,'utf8');
const loaded=YAML.parse(after.manifestYaml),actual=loaded.spec.sources.filter((x:any)=>x.name?.startsWith('zhiyu-project-source-v2:'));
if(actual.length!==paths.length||actual.some((x:any)=>x.sha256)||loaded.spec.loops.find((x:any)=>x.name==='agent-frontier-study').trigger.expression!=='0 9 * * *')throw Error('Fresh source/schedule readback mismatch');
if(/\uFFFD|\?{3}/u.test(after.manifestYaml))throw Error('Encoding mismatch');
const target=resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml'),t=YAML.parse(readFileSync(target,'utf8'));
t.spec.sources=m.spec.sources;t.spec.loops.find((x:any)=>x.name==='agent-frontier-study').context=l.context;t.spec.loops.find((x:any)=>x.name==='agent-frontier-study').trigger=l.trigger;t.spec.creationReport=m.spec.creationReport;
writeFileSync(target,YAML.stringify(t),'utf8');
console.log(JSON.stringify({commandVersion:after.commandVersion,nativeSchedule:l.trigger,freshSources:actual.length}));
