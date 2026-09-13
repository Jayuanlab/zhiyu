"use client";

import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import type {ClientWorkRequest} from '@/lib/work-runtime/client-command';

type Item={id:string;error:string|null;created_at:string};
type View={runId:string;status:string;reviewable:boolean;error:string|null;expectedVersion:number;expectedLeaseToken:number|null;
  pendingOutbox:Array<{id:string;status:string}>;hasMorePendingOutbox:boolean;lastReview:null|{evidence:string;createdAt:string}};
type Props={workId:string;revision?:number;pending:boolean;submit:(request:ClientWorkRequest)=>Promise<unknown>;onChanged:()=>Promise<unknown>};
async function read<T>(url:string,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{cache:'no-store',signal});const value=await response.json();
  if(!response.ok)throw Error(value.error??'无法读取运行核对状态');return value;
}

export function RunReviewPanel({workId,revision,pending,submit,onChanged}:Props){
  const [items,setItems]=useState<Item[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null),[cursor,setCursor]=useState('');
  const [view,setView]=useState<View|null>(null),[baseline,setBaseline]=useState<View|null>(null);
  const [outcome,setOutcome]=useState('unknown'),[evidence,setEvidence]=useState(''),[stopped,setStopped]=useState(false);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const alive=useRef(true),selection=useRef(0);
  const base=`/api/workshops/${workId}/runs`,url=view?`${base}/${view.runId}/review`:null;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;selection.current++;};},[]);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{
      try{
        const list=await read<{runs:Item[];nextCursor:string|null}>(`${base}/review${cursor?`?cursor=${cursor}`:''}`,controller.signal);
        if(!controller.signal.aborted){setItems(list.runs);setNextCursor(list.nextCursor);setLoading(false);}
      }catch(error){if(!controller.signal.aborted){setError(error instanceof Error?error.message:String(error));setLoading(false);}}
      if(!controller.signal.aborted)timer=setTimeout(poll,15000);
    };
    void poll();return()=>{controller.abort();if(timer)clearTimeout(timer);};
  },[base,cursor,revision]);
  // Refresh observations after global command recovery without replacing the
  // baseline of an in-progress owner decision.
  useEffect(()=>{
    if(!url)return;const controller=new AbortController();
    void read<View>(url,controller.signal).then(value=>{if(!controller.signal.aborted)setView(value);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[url,revision]);
  async function open(runId:string){
    const selected=++selection.current;setBusy(true);setError(null);setNotice(null);
    try{const value=await read<View>(`${base}/${runId}/review`);if(alive.current&&selected===selection.current){setView(value);setBaseline(value);setEvidence('');setOutcome('unknown');setStopped(false);}}
    catch(error){if(alive.current)setError(error instanceof Error?error.message:String(error));}
    finally{if(alive.current&&selected===selection.current)setBusy(false);}
  }
  async function refreshBaseline(){
    if(!url)return;setBusy(true);
    try{const value=await read<View>(url);if(alive.current){setView(value);setBaseline(value);setStopped(false);setError(null);}}
    catch(error){if(alive.current)setError(error instanceof Error?error.message:String(error));}
    finally{if(alive.current)setBusy(false);}
  }
  async function decide(){
    if(!url||!baseline||baseline.expectedLeaseToken===null)return;setBusy(true);setError(null);
    try{
      await submit({url,method:'POST',expectedVersion:baseline.expectedVersion,body:{expectedLeaseToken:baseline.expectedLeaseToken,outcome,evidence:evidence.trim(),executorStopped:stopped}});
      if(!alive.current)return;
      setNotice(outcome==='unknown'?'核对依据已记录，本轮继续保留待核对。':'本轮已关闭，车间已暂停。请审核剩余任务后再决定是否恢复车间。');
      setEvidence('');setStopped(false);
      const value=await read<View>(url);if(!alive.current)return;setView(value);setBaseline(value);
      await onChanged();
    }catch(error){if(alive.current)setError(error instanceof Error?error.message:String(error));}
    finally{if(alive.current)setBusy(false);}
  }
  const disabled=busy||pending;
  if(!loading&&!items.length&&!view&&!error&&!cursor)return null;
  return <section className="space-y-3 rounded border border-amber-300 bg-amber-50/30 p-4 text-sm" aria-label="运行结果核对">
    <h2 className="font-semibold">运行结果待核对</h2>
    <p className="text-muted-foreground">请先确认执行器已停止，并核对本轮消息、订单等外部动作。关闭本轮会暂停车间，不会重跑或撤销已经发生的动作。</p>
    {loading?<p>正在读取待核对运行…</p>:null}
    {items.map(item=><div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background p-2"><div><p>{new Date(item.created_at).toLocaleString('zh-CN')} 的运行</p><p className="break-all text-xs text-muted-foreground">{item.error??'执行结果未知'}</p></div><Button size="sm" variant="outline" disabled={disabled||!!evidence.trim()} onClick={()=>void open(item.id)}>核对本轮</Button></div>)}
    {cursor||nextCursor?<div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled||!cursor} onClick={()=>setCursor('')}>返回首页</Button><Button size="sm" variant="outline" disabled={disabled||!nextCursor} onClick={()=>setCursor(nextCursor!)}>下一页</Button></div>:null}
    {view?<div className="space-y-3 border-t pt-3">
      <p className="text-xs text-muted-foreground">当前核对运行：{view.runId}</p>
      {view.lastReview?<p className="whitespace-pre-wrap break-words">最近核对依据：{view.lastReview.evidence}</p>:null}
      {!view.reviewable?<p role="status">{view.status==='cancelled'?'本轮已关闭。':'本轮暂不可通过此入口处理，请查看运行诊断。'}</p>:<>
        {view.pendingOutbox.length?<p role="status">仍有发送中或结果未知的消息，请先在发信面板核实。{view.hasMorePendingOutbox?'待核实消息超过 20 条。':`当前显示 ${view.pendingOutbox.length} 条待核实消息。`}</p>:null}
        <label className="block space-y-1"><span>核对结论</span><select className="block w-full rounded border bg-background p-2" value={outcome} disabled={disabled} onChange={event=>{setOutcome(event.target.value);setStopped(false);}}><option value="unknown">仍不确定，保留待核对</option><option value="no_effect">已核实，没有发生外部动作</option><option value="effects_recorded">外部动作已发生，结果已核实</option></select></label>
        <label className="block space-y-1"><span>核对依据</span><textarea className="block min-h-24 w-full rounded border bg-background p-2" maxLength={8000} value={evidence} disabled={disabled} onChange={event=>setEvidence(event.target.value)} placeholder="记录核实的时间、执行器状态和外部动作证据（至少 10 个字符）"/></label>
        {outcome!=='unknown'?<label className="flex items-start gap-2"><input type="checkbox" checked={stopped} disabled={disabled} onChange={event=>setStopped(event.target.checked)}/><span>我已确认执行器停止，并核实了本轮全部外部动作；关闭后暂停车间。</span></label>:null}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled||evidence.trim().length<10||(outcome!=='unknown'&&(!stopped||view.pendingOutbox.length>0))} onClick={()=>void decide()}>{busy?'处理中…':outcome==='unknown'?'记录依据，继续待核对':'关闭本轮并暂停车间'}</Button><Button size="sm" variant="outline" disabled={disabled} onClick={()=>void refreshBaseline()}>重新读取核对状态</Button></div>
      </>}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={()=>{setEvidence('');setView(null);setBaseline(null);}}>收起并丢弃未提交内容</Button>
    </div>:null}
    {pending?<p role="status">有提交结果尚未确认，请使用页面上方的“核对上次提交”。</p>:null}
    {notice?<p role="status">{notice}</p>:null}{error?<p role="alert" className="text-destructive">{error}</p>:null}
  </section>;
}
