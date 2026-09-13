'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
export type WorkspacePageFile={taskId:string;path:string;name:string;type?:string;isDirectory?:boolean};
export function usePagedWorkspaceFiles(taskId?:string,enabled=true){
  const [files,setFiles]=useState<WorkspacePageFile[]>([]),[busy,setBusy]=useState(true),[hasMore,setHasMore]=useState(true);
  const [error,setError]=useState<{message:string;reset:boolean}|null>(null);
  const cursor=useRef<string|null>(null),generation=useRef(0),locked=useRef(false);
  const load=useCallback(async(reset=false)=>{
    if(!enabled||locked.current)return;locked.current=true;setBusy(true);setError(null);
    const current=generation.current;
    try{
      const query=new URLSearchParams({pagination:'bounded',pageSize:'50'});
      if(taskId)query.set('taskId',taskId);
      if(!reset&&cursor.current)query.set('cursor',cursor.current);
      const response=await fetch(`/api/workspace/files?${query}`,{cache:'no-store'});
      if(current!==generation.current)return;
      if(!response.ok){
        if([401,403].includes(response.status))setFiles([]);
        setError({message:[401,403,410,422].includes(response.status)?'权限或扫描游标已变化，请重新扫描。':'读取失败，请重试；已加载文件仍保留。',reset:reset||[401,403,410,422].includes(response.status)});return;
      }
      const data=await response.json();if(current!==generation.current)return;
      if(!Array.isArray(data.files)||typeof data.hasMore!=='boolean'||data.hasMore&&typeof data.nextCursor!=='string')throw Error('Invalid page');
      setFiles(previous=>{
        const items=new Map<string,WorkspacePageFile>();
        for(const file of reset?[]:previous)items.set(`${file.taskId}:${file.path}`,file);
        for(const file of data.files)items.set(`${file.taskId}:${file.path}`,file);
        return [...items.values()];
      });
      cursor.current=data.nextCursor??null;setHasMore(data.hasMore);
    }catch{if(current===generation.current)setError({message:'连接中断或响应无效，请重试。',reset});}
    finally{if(current===generation.current){locked.current=false;setBusy(false);}}
  },[taskId,enabled]);
  useEffect(()=>{
    generation.current++;locked.current=false;cursor.current=null;setFiles([]);setHasMore(true);
    if(!enabled){setBusy(false);setError(null);return;}
    const current=generation.current;
    queueMicrotask(()=>{if(current===generation.current)void load(true);});
    return()=>{generation.current++;locked.current=false;};
  },[load,enabled]);
  return {files,busy,hasMore,error,load};
}
