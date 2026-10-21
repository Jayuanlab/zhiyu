"use client";
import {useEffect,useState} from 'react';
type Connection={mode:string;status:string;code?:string};
export function MemoryConnectionStatus(){
 const [connection,setConnection]=useState<Connection|null>(null);
 const [pending,setPending]=useState(false);
 async function refresh(signal?:AbortSignal){setPending(true);try{const r=await fetch('/api/memory/connection',{signal,cache:'no-store'});setConnection(await r.json());}catch{if(!signal?.aborted)setConnection({mode:'unknown',status:'unavailable'});}finally{if(!signal?.aborted)setPending(false);}}
 useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[]);
 return <section aria-label="记忆服务连接" className="rounded-xl border border-border bg-muted/20 p-4 text-sm">
  <div className="flex items-center justify-between gap-4"><p className="font-medium">{connection?.mode==='remote'?'独立记忆服务 · 远程接入':connection?.mode==='local'?'记忆服务 · 本地模式':'正在检查记忆服务'}</p><button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={pending} onClick={()=>void refresh()}>检查连接</button></div>
  <p className="mt-2 text-muted-foreground">{!connection?'正在核对服务状态…':connection.status==='ready'?connection.mode==='remote'?'远程服务可用，历史记录与审核依据保持一致。本地回退已保留。':'当前通过本地适配层读取同一套记录。':'远程服务暂不可用，操作已阻断。请检查服务或由本机管理员切换本地模式；写入结果未知时先核对原命令回执。'}</p>
  {connection?.code&&<p className="mt-1 font-mono text-xs">{connection.code}</p>}
 </section>;
}
