"use client";
import useSWR from 'swr';
import {useEffect,useState} from 'react';
import Link from 'next/link';
type Job={id:string;attempts:number;updated_at:string;reason:string;status:string};
type Decision={jobId:string;attempt:number;commandId:string;acknowledgedUnknown:true;decision?:'keep_results_end'|'resume_plan';planHash?:string};
type Plan={hash:string;resumable:boolean;payload:{mode:string;analysis?:{summary:string};plan?:{notes:Array<{title:string;body:string}>;tasks:Array<{title:string;description?:string}>;memories:Array<{subject:string;content:string}>}}};
type Detail={job:Job;plan?:Plan|null;decisions:Array<{decision:string;decided_at:string;command_id:string}>;events:Array<{id:string;conversation_name:string;content:string;content_preview:string;truncated:boolean}>;results:Array<{id:string;kind:string;title:string;content:string;truncated:boolean}>;truncated:boolean};
const jobLabel=(job:Job)=>({review_closed:'已保留结果并结束处理',resume_pending:'已排队，等待按原计划恢复',running:'正在按原计划恢复',applying:'正在写入原计划结果',completed:'原计划处理已完成'}[job.status]??(job.reason==='source_context_changed'?'来源权限或消息内容已变化，恢复已暂停':job.reason==='host_lost'?'后台中断，结果待确认':'部分结果待确认'));
const pendingKey='interaction-review-pending-v1';
const read=async(url:string)=>{const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('review_unavailable');return r.json();};
export default function InteractionReviewsPage(){
  const [selected,setSelected]=useState<string|null>(null);
  const [history,setHistory]=useState(false),[ack,setAck]=useState(false),[pending,setPending]=useState<Decision|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{try{const saved=localStorage.getItem(pendingKey);if(saved){const value=JSON.parse(saved);if(typeof value.jobId==='string'&&typeof value.commandId==='string'&&Number.isSafeInteger(value.attempt)&&value.acknowledgedUnknown===true){setPending(value);setSelected(value.jobId);setNotice('上次提交尚待确认，请核对提交结果。');}}}catch{setNotice('无法读取上次提交凭据，请检查浏览器存储。');}},[]);
  const {data,error,isValidating,mutate}=useSWR<{jobs:Job[];truncated:boolean}>(`/api/interactions/processing-reviews${history?'?history=1':''}`,read,{refreshInterval:15000,refreshWhenHidden:false});
  const {data:detail,error:detailError,mutate:refreshDetail}=useSWR<Detail>(selected?`/api/interactions/processing-reviews?jobId=${selected}`:null,read,{refreshInterval:value=>value&&['resume_pending','running','applying'].includes(value.job.status)?5000:0,refreshWhenHidden:false});
  const visibleNotice=notice.startsWith('已提交按原计划恢复')&&detail?.job.status==='completed'?'原计划处理已完成，结果已保存。':notice.startsWith('已提交按原计划恢复')&&detail?.job.status==='needs_review'?'恢复未完成，请查看当前任务的核对说明。':notice;
  async function submit(action:Decision['decision']='keep_results_end'){
    if(busy||(!pending&&(!ack||!detail||detail.job.status!=='needs_review')))return;
    if(!pending&&action==='resume_plan'&&!detail?.plan?.resumable)return;
    const command=pending??{jobId:detail!.job.id,attempt:detail!.job.attempts,commandId:crypto.randomUUID(),acknowledgedUnknown:true as const,...(action==='resume_plan'?{decision:action,planHash:detail!.plan!.hash}:{})};
    try{localStorage.setItem(pendingKey,JSON.stringify(command));}catch{setNotice('无法保存提交凭据，请检查浏览器存储后重试。');return;}
    setPending(command);setBusy(true);setNotice('正在确认处置结果…');
    try{
      const response=await fetch('/api/interactions/processing-reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(15000)});
      if(response.status===409){localStorage.removeItem(pendingKey);setPending(null);setAck(false);setNotice('任务状态已变化，请刷新详情后重新核对。');await refreshDetail().catch(()=>{});return;}
      if(!response.ok)throw Error('unconfirmed');
      const result=await response.json();
      if(result.decision?.job_id!==command.jobId||result.decision?.command_id!==command.commandId)throw Error('unconfirmed');
      localStorage.removeItem(pendingKey);setPending(null);setAck(false);setNotice(command.decision==='resume_plan'?'已提交按原计划恢复，等待后台领取；尚未完成。可在已处置记录中查看进度。':'已保留现有结果并结束本次处理。未重跑、删除或确认生成内容正确。');
      await Promise.allSettled([mutate(),refreshDetail()]);
    }catch{setNotice('提交结果尚未确认，原提交凭据已保留。请核对提交结果，不要另建请求。');}
    finally{setBusy(false);}
  }
  return <main className="h-full overflow-y-auto p-4 sm:p-6 [overflow-wrap:anywhere]">
    <div className="mx-auto max-w-5xl space-y-4">
      <Link href="/workshop" className="underline">返回车间</Link>
      <h1 className="text-2xl font-semibold">消息理解待核对</h1>
      <p>这些任务可能已经写入部分结果，系统已暂停自动重试。先查看原始消息与已关联结果。</p>
      <button className="rounded border px-3 py-2" disabled={isValidating} onClick={()=>void mutate().catch(()=>{})}>刷新待核对任务</button>
      <button className="ml-2 rounded border px-3 py-2" disabled={busy} onClick={()=>setHistory(!history)}>{history?'查看待核对':'查看已处置记录'}</button>
      {visibleNotice&&<p role="status">{visibleNotice}</p>}
      {pending&&<button className="rounded border px-3 py-2" disabled={busy} onClick={()=>void submit()}>核对提交结果</button>}
      {error?<p role="alert">读取失败，请刷新重试。当前任务状态尚未确认。</p>:!data?<p role="status">正在读取…</p>:<>
        {!data.jobs.length&&<p>{history?'暂无已处置记录。':'暂无待核对任务。'}</p>}
        {data.truncated&&<p>仅显示最近 100 项，尚有其他待核对任务。</p>}
        <div className="grid gap-2 sm:grid-cols-2">{data.jobs.map(job=><button key={job.id} disabled={busy||!!pending} className="min-w-0 rounded border p-3 text-left" aria-pressed={selected===job.id} onClick={()=>{setSelected(job.id);setAck(false);setNotice('');}}>
          <strong>{jobLabel(job)}</strong><p>第 {job.attempts} 次处理 · {new Date(job.updated_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p><p className="text-xs text-muted-foreground">任务 {job.id}</p>
        </button>)}</div>
      </>}
      {selected&&<section aria-label="理解任务核对详情" className="space-y-3 rounded border p-4">
        <h2 className="text-lg font-medium">原始消息与已关联结果</h2>
        <p className="text-amber-700">这里只列出明确关联到本次处理的笔记、待办和记忆。没有记录不代表从未写入，旧数据和其他派生结果可能尚未关联。结束处理会保留现有内容，不代表确认这些内容正确。</p>
        {detailError?<p role="alert">详情不可用，任务可能已发生变化，请刷新列表。</p>:!detail?<p>正在读取详情…</p>:<>
          {detail.truncated&&<p>条目超过显示上限，当前不是完整清单。</p>}
          {detail.job.reason==='source_context_changed'&&<p className="text-amber-700">来源权限或消息内容已变化，恢复没有写入结果。请先核对来源设置与原始消息；不能用旧计划绕过当前权限。</p>}
          {detail.plan&&<details className="rounded border p-3"><summary className="cursor-pointer">查看保存的理解计划</summary>
            <p className="my-2">恢复会复用这份计划，不重新请求模型。执行前仍检查来源权限，整批数据库写入成功后才标记完成。</p>
            {detail.plan.payload.mode==='fallback_summary'?<p>基于原始消息生成摘要，不创建待办或记忆。</p>:<>
              {detail.plan.payload.analysis&&<p>{detail.plan.payload.analysis.summary}</p>}
              {detail.plan.payload.plan?.notes.map((item,index)=><article key={`note:${index}`} className="mt-2"><strong>计划笔记 · {item.title}</strong><p className="whitespace-pre-wrap">{item.body}</p></article>)}
              {detail.plan.payload.plan?.tasks.map((item,index)=><article key={`task:${index}`} className="mt-2"><strong>计划待办 · {item.title}</strong><p className="whitespace-pre-wrap">{item.description}</p></article>)}
              {detail.plan.payload.plan?.memories.map((item,index)=><article key={`memory:${index}`} className="mt-2"><strong>计划记忆 · {item.subject}</strong><p className="whitespace-pre-wrap">{item.content}</p></article>)}
            </>}
          </details>}
          <h3 className="font-medium">原始消息（{detail.events.length}）</h3>
          {detail.events.map(event=><article key={event.id} className="rounded border p-3"><strong>{event.conversation_name}</strong><p className="whitespace-pre-wrap">{event.content??event.content_preview}</p>{event.truncated&&<p>正文已截断</p>}</article>)}
          <h3 className="font-medium">已关联结果（{detail.results.length}）</h3>
          {detail.results.map(result=><article key={`${result.kind}:${result.id}`} className="rounded border p-3"><strong>{({note:'笔记',task:'待办',memory:'记忆'} as Record<string,string>)[result.kind]} · {result.title}</strong><p className="whitespace-pre-wrap">{result.content}</p>{result.truncated&&<p>正文已截断</p>}</article>)}
          {detail.job.status==='needs_review'?<div className="space-y-3 border-t pt-3">
            <label className="flex items-start gap-2"><input type="checkbox" checked={ack} disabled={busy||!!pending} onChange={event=>setAck(event.target.checked)}/>我已核对现有结果，理解内容可能不完整，并确认下方选择的处置方式。</label>
            <button className="rounded border px-3 py-2 disabled:opacity-50" disabled={!ack||busy||!!pending} onClick={()=>void submit()}>保留结果并结束处理</button>
            {detail.plan?.resumable?<button className="ml-2 rounded border px-3 py-2 disabled:opacity-50" disabled={!ack||busy||!!pending} onClick={()=>void submit('resume_plan')}>按原计划恢复</button>:<p>没有可验证的原子写入计划，不能自动恢复此旧任务。</p>}
          </div>:<p role="status">{jobLabel(detail.job)}。处置时间：{detail.decisions[0]?.decided_at?new Date(detail.decisions[0].decided_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'待查询'}</p>}
        </>}
      </section>}
    </div>
  </main>;
}
