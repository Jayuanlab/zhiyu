import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {config} from 'dotenv';
config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
const base='http://127.0.0.1:3515',id='cec5143f-567b-453d-9d18-4ad90d193572',loopId='2cf7ef58-3349-4e6c-b54f-80d91b107d70';
const folder=resolve('.tmp/agent-frontier-role-20261002');mkdirSync(folder,{recursive:true});
async function api(path:string,body?:unknown){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)}:undefined);const d=await r.json();if(!r.ok)throw Error(JSON.stringify({status:r.status,data:d}));return d;}
if(process.argv[2]==='start'){
 const commandId='project-researcher-native-worker-trial-ready-20261002';
 const queued=await api(`/api/workshops/${id}/loops/${loopId}/execute`,{commandId,mode:'native_agent',wait:false,createOutboxDrafts:false});
 const runId=queued.runId;
 await api(`/api/workshops/${id}/commands`,{command:'addWorkDirective',commandId:'project-researcher-native-trial-focus-ready-20261002',content:'本轮是角色更新后的原生工作器验收。请首先 Read inputs/index.json，核对新登记项目来源；实际读取 execution-lease.ts、loop-execution.ts、recorded-step.ts 三份源码，绑定本轮哈希，核对同一 runId 接管和步骤复用。再实际读取 RIR 论文原文 https://arxiv.org/html/2609.18304v3 的方法部分（不用泛搜索新论文），给主人一个项目判断：现有能力与完整环境恢复的区别、现在最小值得核实的一步。正文约 500–800 字，完整输出，experimentProposal 无完整方案为 null。保存有来源的认知与检查点，避免重复已驳回建议；不要把前轮搜索摘要/CVE线索当已证实事实。此指令只影响本次验收，不覆盖长期每日选题。',scope:'current_run',runId,triggerRun:false,reason:'主人授权的项目内原生研究员行为验收，聚焦读源码和有价值判断。'});
 writeFileSync(resolve(folder,'native-queue.json'),JSON.stringify(queued,null,2),'utf8');console.log(JSON.stringify(queued));
}else{
 const d=await api(`/api/workshops/${id}/loops/${loopId}/detail`);writeFileSync(resolve(folder,'native-detail.json'),JSON.stringify(d,null,2),'utf8');
 const run=d.loop.latestRun,es=d.events.filter((e:any)=>e.runId===run.id||e.loopRunId===run.id);
 const staged=es.find((e:any)=>e.title==='Pi Loop file sources staged')?.metadata?.stagedFiles;
 const calls=es.filter((e:any)=>e.type==='tool_call');
 const summary={id:run.id,status:run.status,verificationPassed:run.verificationPassed,nextRun:d.loop.nextScheduledRunAt,sourceCount:staged?.staged?.length,warnings:staged?.warnings,tools:calls.map((e:any)=>e.metadata?.toolName??e.title),memoryEvents:es.filter((e:any)=>e.type==='memory_written').map((e:any)=>({id:e.id,body:e.body,metadata:e.metadata})),errors:es.filter((e:any)=>e.type==='tool_error'),report:run.outputSummary};
 writeFileSync(resolve(folder,'native-summary.json'),JSON.stringify(summary,null,2),'utf8');
 if(['success','error','failed','blocked'].includes(run.status)){
  const out=resolve('../../.runtime/agent-frontier-project-role-2026-10-02');mkdirSync(out,{recursive:true});
  writeFileSync(resolve(out,'native-report.md'),run.outputSummary??'No output summary returned.','utf8');
  writeFileSync(resolve(out,'native-detail.json'),JSON.stringify(d,null,2),'utf8');
  writeFileSync(resolve(out,'native-summary.json'),JSON.stringify(summary,null,2),'utf8');
 }
 console.log(JSON.stringify({...summary,report:run.status==='running'?null:summary.report,memoryEvents:summary.memoryEvents.map((e:any)=>e.id)},null,2));
}
