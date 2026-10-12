import {readFileSync,writeFileSync} from 'node:fs';
const base='http://127.0.0.1:3515',id='cec5143f-567b-453d-9d18-4ad90d193572';
const folder='.tmp/agent-frontier-role-20261002';
const d=JSON.parse(readFileSync(folder+'/native-detail.json','utf8'));
const evidence=d.events.find(e=>e.runId==='373cc40d-364a-8857-a814-fca200b9f05d'&&e.type==='memory_written');
const content='研究验收修正（2026-10-02，关联研究记忆 4d3bf850）：本轮 373cc40d-364a-8857-a814-fca200b9f05d 是页面接口手动排队验收，不是 cron 实际触发。实际读取地图、RIR 纠错、recorded-step.ts、loop-execution.ts 四份文件，未读 execution-lease.ts；不得把旧证据当本轮读取。applyRecordedStep 缓存命中不执行 apply 回调，是局部结果复用，不证明整个运行不进入模型、不证明全部外部副作用恰好一次。ACRFence 只有非一手线索，不得据此判断知遇存在漏洞；Resume Means Resume 只读了前 15000 字符，不宣称全实验已核验。后续优先核查 recorded-step 覆盖的实际工具链路，再决定需要做的最小验证。每日运行已改为知遇项目原生 Loop 09:00 Asia/Shanghai，Codex 定时已删除；实际下一轮是否运行以项目回执为准。';
const r=await fetch(`${base}/api/workshops/${id}/memories`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({kind:'mistake',content,confidence:90,tags:['project-research','evidence-correction','research-checkpoint'],sourceEventIds:evidence?[evidence.id]:[],status:'active'})});
const result=await r.json();
if(!r.ok){
 writeFileSync(folder+'/correction-memory-rejected.json',JSON.stringify({status:r.status,result},null,2),'utf8');
 if(!String(result.error).includes('write_requires_owner_or_grant'))throw Error(JSON.stringify(result));
 const c=await fetch(`${base}/api/workshops/${id}/commands`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({command:'addWorkDirective',commandId:'project-researcher-evidence-correction-20261002',content,scope:'persistent',triggerRun:false,reason:'主人授权的新角色验收中发现的证据范围修正；记忆接口拒绝，保留明确控制指令，不绕过记忆权限。'})});
 const receipt=await c.json();writeFileSync(folder+'/correction-directive-receipt.json',JSON.stringify(receipt,null,2),'utf8');if(!c.ok)throw Error(JSON.stringify(receipt));
 console.log(JSON.stringify({memorySaved:false,correctionDirectiveSaved:true,receipt}));
 process.exit(0);
}
writeFileSync(folder+'/correction-receipt.json',JSON.stringify(result,null,2),'utf8');
const readback=await(await fetch(`${base}/api/workshops/${id}/memories`)).json();
const memory=readback.memories.find(m=>m.id===result.memory.id);
if(memory?.content!==content||/\uFFFD|\?{3}/u.test(memory.content))throw Error('Correction readback mismatch');
console.log(JSON.stringify({id:memory.id,status:memory.status,readback:true}));
