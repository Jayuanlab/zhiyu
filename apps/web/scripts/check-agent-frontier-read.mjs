import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const base='http://127.0.0.1:3515',workId='cec5143f-567b-453d-9d18-4ad90d193572';
const folder=resolve('.tmp/agent-frontier-read-20261002');mkdirSync(folder,{recursive:true});
const path=`/api/workshops/${workId}/conversation`;
if(process.argv[2]==='start'){
 const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({commandId:'6518cb7b-ff9c-43ce-a073-e8810078247f',content:'这是主人授权 Read 后的短读取验收，不做前沿检索或完整研究。本次输入文件：\n"D:\\zhiyu\\apps\\web\\lib\\work-runtime\\execution-lease.ts"\n"D:\\zhiyu\\apps\\web\\lib\\work-runtime\\loop-control-state.ts"\n请实际调用 Read，读取这两份系统准备的副本，各取前 80 行即可。用中文报告两份文件的函数名及职责，列出实际副本路径和系统提供的 SHA-256；不得仅凭文件名推断。不要调用搜索、记忆写入、代码修改或命令工具。输出不超过 300 字，明确没有完成 RIR 全面对比。'})});
 const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));writeFileSync(resolve(folder,'smoke-start.json'),JSON.stringify(data,null,2),'utf8');console.log(JSON.stringify(data,null,2));
}else if(process.argv[2]==='cancel'){
 const r=await fetch(`${base}/api/workshops/${workId}/runs/e8dda4ea-c076-8d02-a854-022589d2ae93/cancel`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({commandId:'agent-frontier-read-empty-input-cancel',reason:'读取验收发现临时对话没有输入文件；停止空输入尝试，以显式获准文件重新核验。'})});
 const data=await r.json();writeFileSync(resolve(folder,'empty-input-cancel.json'),JSON.stringify(data,null,2),'utf8');console.log(JSON.stringify({status:r.status,data}));
}else{
 const r=await fetch(base+path);const data=await r.json();writeFileSync(resolve(folder,'smoke-after.json'),JSON.stringify(data,null,2),'utf8');
 console.log(JSON.stringify(data,null,2));
}
