'use client';
import {useState} from 'react';
import {Button} from '@openzhiyu/ui';
export type LegacyExecution={id:string;status:string;startedAt:string;completedAt:string|null;output:string|null;error:string|null;snapshotHash:string;reviewed:boolean;review?:{outcome:string;evidence:string;reviewedAt:string}|null};
function displayTime(value:string){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(date):'时间待核对';}
export type LegacyReviewDecision={executionId:string;expectedSnapshotHash:string;controllersStopped:true;outcome:'no_effect'|'effects_verified';evidence:string};
export function LegacyExecutionReviewPanel({execution,disabled,onReview}:{execution:LegacyExecution;disabled:boolean;onReview:(decision:LegacyReviewDecision)=>void}){
  const [outcome,setOutcome]=useState(''),[evidence,setEvidence]=useState(''),[stopped,setStopped]=useState(false);
  const eligible=['needs_review','unknown'].includes(execution.status);
  return <section aria-label="旧执行结果核对" className="min-w-0 space-y-3 rounded border p-3">
    <h4 className="font-medium">{execution.reviewed?'已核对旧执行':'核对旧执行结果'}</h4>
    <p className="text-sm">开始于 {displayTime(execution.startedAt)}。原执行记录保持不变；核对只用于解除迁移阻塞，不会重新执行。</p>
    {execution.review&&<div className="space-y-1 text-sm"><p>主人核对于 {displayTime(execution.review.reviewedAt)}：{execution.review.outcome==='no_effect'?'确认未产生外部动作':'已逐项核对并处理外部动作'}。</p><p className="whitespace-pre-wrap break-words">{execution.review.evidence}</p></div>}
    <details><summary>查看原执行输出与诊断</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{execution.output||'没有保存输出'}{'\n'}{execution.error||'没有保存诊断'}</pre></details>
    {!execution.reviewed&&(eligible?<fieldset disabled={disabled} className="space-y-3">
      <label className="block">核对结论<select aria-label="核对结论" value={outcome} onChange={event=>{setOutcome(event.target.value);setStopped(false);}} className="block w-full min-w-0 rounded border bg-background p-2"><option value="">请选择实际核对结果</option><option value="no_effect">确认未产生外部动作</option><option value="effects_verified">已逐项核对并处理外部动作</option></select></label>
      <label className="block">核对依据<textarea aria-label="核对依据" value={evidence} maxLength={8000} onChange={event=>{setEvidence(event.target.value);setStopped(false);}} className="block w-full min-w-0 rounded border bg-background p-2" placeholder="记录检查了哪些外部系统、记录或凭证；仍无法确认时请保持待核对。" /></label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={stopped} onChange={event=>setStopped(event.target.checked)} />我已停止旧执行器，并完成上述结果核对</label>
      <Button disabled={!outcome||!evidence.trim()||!stopped} onClick={()=>onReview({executionId:execution.id,expectedSnapshotHash:execution.snapshotHash,controllersStopped:true,outcome:outcome as LegacyReviewDecision['outcome'],evidence})}>保存核对并停用旧任务</Button>
    </fieldset>:<p role="status">旧执行尚未进入待核对状态，请先停止旧执行器并等待状态核实。</p>)}
  </section>;
}
