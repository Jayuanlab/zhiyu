'use client';

import {useEffect,useRef,useState} from 'react';
import type {WorkshopEvent} from '@/lib/workshops/run-history-types';
import {createWorkshopReadClient} from '@/lib/workshops/read-client';
const emptyEvents: WorkshopEvent[] = [];

async function readHistory<T>(url:string):Promise<T> {
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok)throw Object.assign(new Error('运行记录暂时不可用，请重试。'),{status:response.status});
  return response.json();
}

/** Owns run-history requests; view/projection logic stays outside this hook. */
export function useWorkshopRunHistory(workshopId:string|null,runId:string|null,open:boolean){
  const client=useRef<ReturnType<typeof createWorkshopReadClient>|null>(null);
  if(!client.current)client.current=createWorkshopReadClient(readHistory);
  const key=workshopId?`/api/workshops/${encodeURIComponent(workshopId)}/events?limit=2000${runId?`&runId=${encodeURIComponent(runId)}`:''}&pagination=history`:null;
  const [snapshot,setSnapshot]=useState<{key:string;events:WorkshopEvent[];lastSuccess:number;hasMore:boolean;nextBefore:number|null}|null>(null);
  const [request,setRequest]=useState<{key:string;busy:boolean;error:string|null}|null>(null);
  const [action,setAction]=useState<{key:string|null;before:number|null;revision:number}>({key:null,before:null,revision:0});
  const before=action.key===key?action.before:null;
  useEffect(()=>{
    if(!open||!key||!workshopId)return;
    let active=true;
    setRequest({key,busy:true,error:null});
    queueMicrotask(()=>{
      if(!active)return;
      void client.current!.read<{events:WorkshopEvent[];hasMore:boolean;nextBefore:number|null}>(key+(before!==null?`&before=${before}`:'')).then(data=>{
        if(!active)return;
        if(!Array.isArray(data.events)||typeof data.hasMore!=='boolean'||(data.hasMore&&(!Number.isSafeInteger(data.nextBefore)||Number(data.nextBefore)<=0)))throw Error('运行记录响应无效，请重试。');
        const events=data.events.filter(event=>event.workshopId===workshopId&&(!runId||event.runId===runId||event.loopRunId===runId));
        setSnapshot(previous=>{
          const merged=new Map<string,WorkshopEvent>();
          if(before!==null&&previous?.key===key)for(const event of previous.events)merged.set(event.id,event);
          for(const event of events)merged.set(event.id,event);
          return {key,events:[...merged.values()],lastSuccess:Date.now(),hasMore:data.hasMore,nextBefore:data.nextBefore};
        });setRequest({key,busy:false,error:null});
      }).catch(error=>{
        if(!active)return;
        if([401,403].includes(error?.status))setSnapshot(null);
        setRequest({key,busy:false,error:error instanceof Error?error.message:'运行记录读取失败。'});
      });
    });
    return()=>{active=false;};
  },[key,workshopId,runId,open,before,action.revision]);
  const current=snapshot?.key===key?snapshot:null;
  const state=request?.key===key?request:null;
  return {events:current?.events??emptyEvents,lastSuccess:current?.lastSuccess??null,
    busy:open&&Boolean(key)&&(state?.busy??true),error:state?.error??null,
    hasMore:current?.hasMore??false,
    refresh:()=>setAction(value=>({key,before:null,revision:value.revision+1})),
    retry:()=>setAction(value=>({...value,revision:value.revision+1})),
    loadMore:()=>{if(current?.hasMore)setAction(value=>({key,before:current.nextBefore,revision:value.revision+1}));}};
}
