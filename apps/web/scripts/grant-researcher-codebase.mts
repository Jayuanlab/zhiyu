import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import YAML from 'yaml';
const base='http://127.0.0.1:3515',id='cec5143f-567b-453d-9d18-4ad90d193572',loopId='2cf7ef58-3349-4e6c-b54f-80d91b107d70';
const folder=resolve('.tmp/agent-frontier-codebase-20261002');mkdirSync(folder,{recursive:true});
async function api(path:string,body?:unknown,method='POST'){
 const r=await fetch(base+path,body?{method,headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)}:undefined);
 const data=await r.json();if(!r.ok)throw Error(JSON.stringify({status:r.status,data}));return data;
}
if(process.argv[2]==='apply'){
 const before=await api(`/api/workshops/${id}/manifest`);writeFileSync(resolve(folder,'before.yaml'),before.manifestYaml,'utf8');
 const manifest=YAML.parse(before.manifestYaml),loop=manifest.spec.loops.find((x:any)=>x.name==='agent-frontier-study');
 manifest.spec.modelConfig.codebaseRead={enabled:true,scope:'host_project',pathPrefix:'repo/',readOnly:true};
 manifest.spec.modelConfig.researchRoleVersion='2.1.0';
 for(const name of ['Glob','Grep']){
  for(const list of [manifest.spec.modelConfig.allowedTools,manifest.spec.modelConfig.observationTools,loop.actionPolicy.allowed])if(!list.includes(name))list.push(name);
 }
 loop.context.instructions+='\n主人已授权整个知遇代码库只读访问。用 Glob 查找未登记文件、Grep 字面搜索引用、Read repo/相对路径读取实时源码；权限固定在宿主项目根，生成依赖、密钥和运行数据排除。首次验收需实际 Glob **/recorded-step.ts，Grep applyRecordedStep（pattern apps/web/**/*.ts，检查分页和截断），再 Read 一份搜索结果的 repo/路径，记录哈希与实际范围。不可继续声称只能读取登记源码；搜索不完整应明确具体原因，不执行 shell、测试或修改。';
 const candidate=YAML.stringify(manifest);writeFileSync(resolve(folder,'candidate.yaml'),candidate,'utf8');
 const review=await api(`/api/workshops/${id}`,{manifestYaml:candidate,dryRun:true},'PATCH');if(!review.review.ok)throw Error(JSON.stringify(review.review.issues));
 const receipt=await api(`/api/workshops/${id}`,{manifestYaml:candidate,expectedVersion:before.commandVersion,commandId:`researcher-codebase-read-20261002:${before.commandVersion}`},'PATCH');writeFileSync(resolve(folder,'receipt.json'),JSON.stringify(receipt,null,2),'utf8');
 const after=await api(`/api/workshops/${id}/manifest`);const loaded=YAML.parse(after.manifestYaml);if(!loaded.spec.modelConfig.codebaseRead.enabled||!loaded.spec.modelConfig.allowedTools.includes('Grep'))throw Error('Grant readback mismatch');if(/\uFFFD|\?{3}/u.test(after.manifestYaml))throw Error('Encoding mismatch');writeFileSync(resolve(folder,'after.yaml'),after.manifestYaml,'utf8');
 const target=resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml');const template=YAML.parse(readFileSync(target,'utf8'));template.spec.modelConfig=manifest.spec.modelConfig;template.spec.loops.find((x:any)=>x.name==='agent-frontier-study').context=loop.context;template.spec.loops.find((x:any)=>x.name==='agent-frontier-study').actionPolicy=loop.actionPolicy;writeFileSync(target,YAML.stringify(template),'utf8');
 console.log(JSON.stringify({version:after.commandVersion,grant:loaded.spec.modelConfig.codebaseRead,tools:loaded.spec.modelConfig.allowedTools}));
}else if(process.argv[2]==='feedback'){
 const receipt=await api(`/api/workshops/${id}/commands`,{command:'addWorkDirective',commandId:'researcher-codebase-grant-feedback-20261002',scope:'persistent',triggerRun:false,reason:'主人已授权代码库只读访问，纠正历史能力限制。',content:'2026-10-02 主人已授权整个知遇代码库只读读取与搜索。旧报告或旧记忆中的“Glob/Grep denied、只能读取登记文件”已经失效：真实 Work 配置及原生只读分类已更新，当前工具提供 Glob、Grep、Read repo/。工程侧真实工具验收：Glob 找到 recorded-step.ts；Grep 在 apps/web/lib/**/*.ts 搜索 applyRecordedStep 返回10行且 truncated=false；Read 成功读取未登记 codebase-read.ts。请根据当前工具和真实回执更新能力认知，不将历史限制继续当作当前事实。若失败，实际尝试并记录工具名、参数和错误；不凭旧记忆推断 denied。工程侧验收不等于研究员自行执行。研究员仍不能改源码、执行 shell 或测试、读取密钥和外部目录。'});
 writeFileSync(resolve(folder,'grant-feedback-receipt.json'),JSON.stringify(receipt,null,2),'utf8');
 const directives=await api(`/api/workshops/${id}/directives`);writeFileSync(resolve(folder,'grant-feedback-readback.json'),JSON.stringify(directives,null,2),'utf8');
 if(!JSON.stringify(directives).includes('旧报告或旧记忆中的'))throw Error('Feedback readback mismatch');console.log(JSON.stringify({saved:true,encodingChecked:true}));
}else if(process.argv[2]==='probe'){
 const {config}=await import('dotenv');config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
 const {getWorkshop}=await import('../lib/workshops/service');const {createWorkshopPiTools}=await import('../lib/workshops/pi-domain-tools');
 const work=await getWorkshop('dcb1985e-3fe2-42fd-8978-7b04d1772850',id);if(!work)throw Error('Work unavailable');
 const tools=createWorkshopPiTools({workshop:work,workshopId:id,workDir:folder,allowedTools:['Read','Glob','Grep']});
 const find=(name:string)=>{const tool=tools.find(x=>x.name===name);if(!tool)throw Error('Missing tool: '+name);return tool;};
 const glob=await find('Glob').execute('owner-codebase-probe-glob',{pattern:'apps/web/lib/**/recorded-step.ts'});
 const grep=await find('Grep').execute('owner-codebase-probe-grep',{query:'applyRecordedStep',pattern:'apps/web/lib/**/*.ts',limit:100});
 const read=await find('Read').execute('owner-codebase-probe-read',{path:'repo/apps/web/lib/workshops/codebase-read.ts',limit:8});
 const data=(result:any)=>JSON.parse(result.content[0].text);const evidence={executor:'owner_engineering_probe_not_model_run',glob:data(glob),grep:data(grep),read:data(read)};
 writeFileSync(resolve(folder,'live-tool-probe.json'),JSON.stringify(evidence,null,2),'utf8');console.log(JSON.stringify({tools:tools.map(x=>x.name),paths:evidence.glob.paths,matches:evidence.grep.matches.length,searchTruncated:evidence.grep.truncated,readPath:evidence.read.path,sha256:evidence.read.sha256}));
 const {closePostgresDb}=await import('../lib/db/adapters/postgres');await closePostgresDb();
}else if(process.argv[2]==='start'||process.argv[2]==='retry'){
 const receipt=await api(`/api/workshops/${id}/loops/${loopId}/execute`,{commandId:process.argv[2]==='retry'?'researcher-full-codebase-profile-trial-20261002':'researcher-full-codebase-trial-20261002',mode:'native_agent',wait:false,createOutboxDrafts:false});writeFileSync(resolve(folder,'run-receipt.json'),JSON.stringify(receipt,null,2),'utf8');console.log(JSON.stringify(receipt));
}else{
 const detail=await api(`/api/workshops/${id}/loops/${loopId}/detail`);writeFileSync(resolve(folder,'run-detail.json'),JSON.stringify(detail,null,2),'utf8');const run=detail.loop?.latestRun;console.log(JSON.stringify({runId:run?.id,status:run?.status,error:run?.error,evidence:detail.events?.filter((x:any)=>x.metadata?.codebaseObservation).map((x:any)=>({tool:x.metadata.toolName,observation:x.metadata.codebaseObservation})),report:run?.outputSummary}));
}
