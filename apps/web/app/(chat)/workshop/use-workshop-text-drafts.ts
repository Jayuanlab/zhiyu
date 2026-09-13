"use client";
import {useCallback,useEffect,useMemo,useSyncExternalStore} from 'react';
import {useSession} from 'next-auth/react';
import {createWorkshopTextDraftStore,emptyTextDraftSnapshot,type DraftField} from '@/lib/workshops/text-drafts';

export function useWorkshopTextDrafts(workId:string|null){
  const {data:session}=useSession();
  const owner=session?.user?.id??null;
  const store=useMemo(()=>{
    let storage:Storage|undefined;
    try{if(typeof window!=='undefined')storage=window.sessionStorage;}catch{}
    return createWorkshopTextDraftStore(owner,storage);
  },[owner]);
  const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,()=>emptyTextDraftSnapshot);
  const edit=useCallback((field:DraftField,value:string)=>{if(workId)store.edit(workId,field,value);},[store,workId]);
  useEffect(()=>{
    if(!snapshot.warning||Object.keys(snapshot.rows).length===0)return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[snapshot]);
  return {
    directive:workId?snapshot.rows[workId]?.directive??'':'',
    loopIntent:workId?snapshot.rows[workId]?.loopIntent??'':'',
    setDirective:(value:string)=>edit('directive',value),
    setLoopIntent:(value:string)=>edit('loopIntent',value),
    acknowledgeDraft:store.acknowledge,
    draftWarning:snapshot.warning,
    draftsReady:!!owner,
  };
}
