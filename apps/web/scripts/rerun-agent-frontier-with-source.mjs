import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const base='http://127.0.0.1:3515', workId='cec5143f-567b-453d-9d18-4ad90d193572';
const folder=resolve('.tmp/agent-frontier-rir-source-20261002');
mkdirSync(folder,{recursive:true});
const endpoint=`${base}/api/workshops/${workId}/conversation`;
const files=['docs/architecture/engineering-cybernetics-guiding-principles.md','docs/architecture/zhiyu-control-architecture-contract.md','apps/web/lib/work-runtime/execution-lease.ts','apps/web/lib/work-runtime/loop-execution.ts','apps/web/lib/work-runtime/loop-consumer.ts','apps/web/lib/work-runtime/loop-control-state.ts','apps/web/lib/loops/native-executor.ts','apps/web/lib/workshops/pi-local-tools.ts'];
if(process.argv[2]==='start' || process.argv[2]==='retry') {
 const retry=process.argv[2]==='retry';
 const index=retry?JSON.parse(readFileSync('C:/Users/96012/.openzhiyu/sessions/workshops/'+workId+'/269c179f-57cd-8a3f-a90a-a44bfe1575ac/inputs/index.json','utf8')):null;
 const content=`主人要求：能读取源码再跑一遍。请重新完成 RIR 与知遇恢复机制对比，必须先实际读取输入源码，再形成结论。这是同一研究员的一次临时研究任务。
本次获准输入文件（由系统提供只读副本）：
${files.map(p=>'"D:\\zhiyu\\'+p.replaceAll('/','\\')+'"').join('\n')}
请实际调用 Read 读取全部 8 份文件，重点查阅执行租约、Loop 消费与失败恢复、控制状态、native executor、文件工具权限。长文件按需要分页，不能只凭前几行推测实现。只读系统准备的副本，并引用实际读取的函数、行号和系统提供的 SHA-256；未覆盖范围明确写未知。
请实际读取 RIR 论文 https://arxiv.org/html/2609.18304v3 （必要时检查 https://arxiv.org/abs/2609.18304），以论文原文核对 When/Where/What 三决策；区分论文作者声称、代码直接证据、你的推断和未经运行验证的结论。聚焦这一篇与项目落地，不扩展泛泛前沿清单。
报告需包含：1.读取范围与源码版本证据；2.When/Where/What 对照表，逐项给出已实现/部分对应/在本次范围未发现/未知，列出代码路径、函数或行号与原因；3.租约过期重试、断点恢复、环境回滚、反思知识保留之间的区别，不能把重新执行等同完整恢复；4.最值得补齐的一项，给出小规模验证方案、基线、观测指标、停止条件与回滚边界；5.相较上一轮未读源码的报告，哪些结论现在得到证据、哪些仍不确定。
这次只研究与提出建议，不修改源码或配置，不执行命令，不发送外部消息。不得伪造源码读取、运行测试或已部署效果。最终中文报告约 1800 至 2800 字，保留完整正文、论文链接和关键源码引用，不将正文截断成摘要。若任务环境不支持写记忆，直接给完整报告，不把未写入记忆说成已保存。`;
 const correction=retry?`\n\n读取方式纠正（必须执行）：上一轮误把车间目录当成本轮目录，漏掉 runId，导致读取全部失败。本轮请首先调用 Read，参数 path="inputs/index.json"。这是相对于工具自身本轮工作目录的路径，不要拼接绝对路径，不要读 D: 原始路径。随后使用下列相对路径逐一 Read（文件名应以本轮 index.json 为准）：\n${index.staged.map(f=>'inputs/'+f.runPath.split('\\').at(-1)).join('\n')}\n请先完成读取再研究；遇到路径错误请回到相对 inputs/index.json，不要重复失败绝对路径。`:'';
 const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({commandId:retry?'0218c388-254c-4c9f-b5e0-c7d573c38dab':'94c6b131-9d05-41a0-9915-adc6febae04f',content:content+correction})});
 const result=await r.json();writeFileSync(resolve(folder,'start.json'),JSON.stringify(result,null,2),'utf8');
 if(!r.ok)throw Error(JSON.stringify(result));
 console.log(JSON.stringify({httpStatus:r.status,turn:result.turn},null,2));
}else{
 const started=JSON.parse(readFileSync(resolve(folder,'start.json'),'utf8'));
 const r=await fetch(endpoint);const result=await r.json();
 writeFileSync(resolve(folder,'conversation.json'),JSON.stringify(result,null,2),'utf8');
 const turn=result.turns.find(t=>t.id===started.turn.id);
 const w=await fetch(`${base}/api/workshops/${workId}`);const work=await w.json();
 writeFileSync(resolve(folder,'work.json'),JSON.stringify(work,null,2),'utf8');
 const run=work.runs?.find(r=>r.id===turn?.id);
 const events=work.events?.filter(e=>e.runId===turn?.id || e.payload?.runId===turn?.id);
 const calls=events?.filter(e=>e.type==='tool_call')??[];
 const reads=calls.filter(e=>e.metadata?.toolName==='Read');
 const readResults=events?.filter(e=>e.type==='tool_result'&&e.title==='Read')??[];
 const errors=events?.filter(e=>e.type==='tool_error')??[];
 const audit={id:turn?.id,status:turn?.status,error:turn?.error,readCalls:reads.length,readResults:readResults.length,toolErrors:errors.length,readPaths:reads.map(e=>{try{return JSON.parse(e.body)}catch{return e.body}}),webSources:events?.filter(e=>e.type==='source_checked'&&e.metadata?.url).map(e=>e.metadata)};
 writeFileSync(resolve(folder,'audit.json'),JSON.stringify(audit,null,2),'utf8');
 if(turn?.status==='completed'){
  const out=resolve('../../.runtime/agent-frontier-rir-source-2026-10-02');mkdirSync(out,{recursive:true});
  writeFileSync(resolve(out,'research-report.md'),turn.presentation?.reportMarkdown??'No reportMarkdown returned.','utf8');
  writeFileSync(resolve(out,'conversation.json'),JSON.stringify(result,null,2),'utf8');
  writeFileSync(resolve(out,'events.json'),JSON.stringify(events,null,2),'utf8');
  writeFileSync(resolve(out,'audit.json'),JSON.stringify(audit,null,2),'utf8');
 }
 console.log(JSON.stringify({...audit,readPaths:undefined,webSources:undefined,report:turn?.status==='completed'?turn.presentation:undefined},null,2));
}
