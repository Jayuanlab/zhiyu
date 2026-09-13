"use client";

import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';

type Decision='unknown'|'sent'|'not_sent';
type State={attemptId:string;status:string;contentHash:string;updatedAt:string;resolution:null|{command_id:string;status:string;decision:Decision;evidence:string};recovery:null|{last_checked_at:string|null;next_check_at:string|null;detail:string|null;failures:number}};
async function readState(url:string,signal?:AbortSignal):Promise<State>{
  const response=await fetch(url,{signal});const data=await response.json();
  if(!response.ok)throw Error(data.error??'无法读取核实状态');return data;
}

export function OutboxResolutionPanel({workId,outboxId,onChanged}:{workId:string;outboxId:string;onChanged:(notice?:string)=>Promise<unknown>}){
  const url=`/api/workshops/${workId}/outbox/${outboxId}/resolve`;
  const [state,setState]=useState<State|null>(null);
  const [decision,setDecision]=useState<Decision>('unknown');
  const [evidence,setEvidence]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const command=useRef<{key:string;id:string}|null>(null);
  const onChangedRef=useRef(onChanged);
  useEffect(()=>{onChangedRef.current=onChanged;},[onChanged]);
  useEffect(()=>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{
      try{
        const current=await readState(url,controller.signal);setState(current);
        if(current.status==='sent'||current.status==='failed'){await onChangedRef.current();return;}
      }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:String(error));}
      if(!controller.signal.aborted)timer=setTimeout(poll,15000);
    };
    void poll();
    return ()=>{controller.abort();if(timer)clearTimeout(timer);};
  },[url]);
  const pending=state?.resolution?.status==='pending'?state.resolution:null;
  async function submit(){
    if(!state)return;
    const currentDecision=pending?.decision??decision,currentEvidence=pending?.evidence??evidence.trim();
    const key=JSON.stringify([state.attemptId,currentDecision,currentEvidence]);
    if(command.current?.key!==key)command.current={key,id:crypto.randomUUID()};
    setBusy(true);setError(null);
    try{
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({attemptId:state.attemptId,expectedContentHash:state.contentHash,commandId:pending?.command_id??command.current.id,decision:currentDecision,evidence:currentEvidence})});
      const result=await response.json();if(!response.ok)throw Error(result.error??'核实未完成');
      setState(await readState(url));await onChanged(result.decisionMismatch?'服务端已有最终结果，本次核实未覆盖原记录，请查看更新后的发送状态。':undefined);
      command.current=null;
    }catch(error){
      setError(error instanceof Error?error.message:String(error));
      await readState(url).then(async current=>{
        setState(current);
        if(current.resolution?.status==='completed')await onChanged();
      }).catch(()=>{});
    }finally{setBusy(false);}
  }
  return <section className="mt-3 space-y-3 rounded-md border border-amber-300 bg-amber-50/30 p-3 text-sm" aria-label="人工核实发送结果">
    <p className="font-medium">人工核实发送结果</p>
    <p className="text-xs text-muted-foreground">请先核对微信会话及收件人。核实未发送会永久关闭旧命令并生成新草稿，新草稿必须重新预览审核。</p>
    {state?<p className="text-xs text-muted-foreground">最近尝试更新：{new Date(state.updatedAt).toLocaleString('zh-CN')}</p>:<p>正在读取核实状态…</p>}
    {state?.recovery?<details className="text-xs text-muted-foreground"><summary>自动核对记录</summary><p>最近核对：{state.recovery.last_checked_at?new Date(state.recovery.last_checked_at).toLocaleString('zh-CN'):'尚未完成'}</p><p>最早下次核对：{state.recovery.next_check_at?new Date(state.recovery.next_check_at).toLocaleString('zh-CN'):'已结束'}</p><p>{state.recovery.detail??'等待服务结果'}</p></details>:null}
    <label className="block space-y-1"><span>核实决定</span><select className="block w-full rounded border bg-background p-2" value={pending?.decision??decision} disabled={busy||!!pending} onChange={event=>setDecision(event.target.value as Decision)}>
      <option value="unknown">继续保留未知</option><option value="sent">已核实发送</option><option value="not_sent">已核实未发送，重新审核</option>
    </select></label>
    <label className="block space-y-1"><span>核实依据</span><textarea className="block min-h-20 w-full rounded border bg-background p-2" maxLength={4000} value={pending?.evidence??evidence} disabled={busy||!!pending} onChange={event=>setEvidence(event.target.value)} placeholder="记录核对的会话、时间和证据（至少 8 个字符）" /></label>
    {pending?<p>上次核实尚未完成。继续操作会复用同一请求，不会再次发送消息。</p>:null}
    {error?<p role="alert" className="text-destructive">{error}</p>:null}
    <Button size="sm" variant="outline" disabled={busy||!state||(!pending&&evidence.trim().length<8)} onClick={submit}>{busy?'核实中…':pending?'继续上次核实':'提交核实决定'}</Button>
  </section>;
}
