import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const base='http://127.0.0.1:3515';
const dir=resolve('.tmp/agent-frontier-trial');mkdirSync(dir,{recursive:true});
async function api(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json','Origin':base},body:JSON.stringify(body)}:undefined);const data=await r.json();if(!r.ok)throw Error(JSON.stringify({status:r.status,data}));return data;}
const phase=process.argv[2];
if(phase==='import'){
 const inventory=await api('/api/workshops');
 let work=inventory.workshops.find(w=>w.modelConfig?.manifestName==='agent-frontier-researcher'||w.name==='智能体技术研究员');
 if(!work){const imported=await api('/api/workshops',{manifestYaml:readFileSync(resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml'),'utf8'),commandId:'owner-agent-frontier-import-20261001'});work=imported.workshop;}
 if(!work?.id)throw Error('Missing work id');
 const detail=await api(`/api/workshops/${work.id}`);
 writeFileSync(resolve(dir,'import.json'),JSON.stringify(detail,null,2),'utf8');
 writeFileSync(resolve(dir,'identity.json'),JSON.stringify({workId:work.id}),'utf8');
 console.log(JSON.stringify({workId:work.id,status:work.status,detailKeys:Object.keys(detail),loops:detail.loops?.map(l=>({id:l.id,name:l.name,status:l.status}))},null,2));
}
if(phase==='run'){
 const {workId}=JSON.parse(readFileSync(resolve(dir,'identity.json'),'utf8'));
 const detail=await api(`/api/workshops/${workId}`);
 const loopList=await api(`/api/workshops/${workId}/loops`);
 const loops=loopList.loops??[];
 const loop=loops.find(l=>l.name==='智能体前沿技术研究');if(!loop)throw Error('Research loop missing');
 console.log(JSON.stringify({phase:'running',workId,loopId:loop.id}));
 const result=await api(`/api/workshops/${workId}/commands`,{command:'runWorkLoop',loopId:loop.id,commandId:'owner-agent-frontier-first-trial-20261001',mode:'native_agent',createOutboxDrafts:false,reason:'主人授权导入研究员并运行一次查看真实效果。'});
 writeFileSync(resolve(dir,'run.json'),JSON.stringify(result,null,2),'utf8');
 console.log(JSON.stringify({status:result.result?.status,loopRunId:result.loopRunId,duration:result.result?.duration}));
}
if(phase==='inspect'){
 const {workId}=JSON.parse(readFileSync(resolve(dir,'identity.json'),'utf8'));
 const detail=await api(`/api/workshops/${workId}`);
 writeFileSync(resolve(dir,'after.json'),JSON.stringify(detail,null,2),'utf8');
 const {loops}=await api(`/api/workshops/${workId}/loops`);
 const loop=loops.find(l=>l.name==='智能体前沿技术研究');
 const ld=await api(`/api/workshops/${workId}/loops/${loop.id}/detail`);
 writeFileSync(resolve(dir,'loop-after.json'),JSON.stringify(ld,null,2),'utf8');
 const latest=ld.loop.latestRun;
 console.log(JSON.stringify({phase:ld.loop.currentPhase,latest:{id:latest?.id,status:latest?.status,verificationPassed:latest?.verificationPassed,durationMs:latest?.executionTrace?.durationMs},memories:detail.memories?.length,events:ld.events?.slice(0,5).map(e=>({type:e.type,title:e.title,body:e.body?.slice(0,140),tool:e.metadata?.toolName}))},null,2));
}
if(phase==='export'){
 const data=JSON.parse(readFileSync(resolve(dir,'run.json'),'utf8'));
 const target=resolve('../../.runtime/agent-frontier-trial-2026-10-01');mkdirSync(target,{recursive:true});
 const original=data.result.output;
 if(typeof original!=='string'||original.length<1000||/\uFFFD|\?{3}/u.test(original))throw Error('Missing or corrupted original report');
 writeFileSync(resolve(target,'research-report.md'),'# 研究员首轮原始报告\n\n> 运行 c3ceef8c-948a-8da3-ad76-bca027581629；程序验收通过，人工验收发现结构化字段补齐与汇报摘要缺陷。以下保留原始正文，包含模型的英文过渡句；论文结果均未独立复现，项目适用性待核实。\n\n'+original,'utf8');
 writeFileSync(resolve(target,'run.json'),JSON.stringify(data,null,2),'utf8');
 const reread=readFileSync(resolve(target,'research-report.md'),'utf8');
 if(!reread.includes(original)||/\uFFFD|\?{3}/u.test(reread))throw Error('Readback failed');
 console.log(JSON.stringify({reportPath:resolve(target,'research-report.md'),originalChars:original.length,status:data.result.status,durationMs:data.result.duration,reportReadback:true}));
}
