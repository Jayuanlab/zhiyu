"use client";
import {useEffect,useState} from 'react';

export function useWorkshopReviewLocation<Item,Event>(workId:string|null,reviewId:string|null,revision:unknown) {
  const [retry,setRetry]=useState(0);
  const [snapshot,setSnapshot]=useState<{key:string;data:{item:Item;sourceEvent:Event|null}|null;error:string|null;loading:boolean}|null>(null);
  const key=`${workId}:${reviewId}`;
  useEffect(()=>{
    if(!workId||!reviewId)return;
    const controller=new AbortController();
    setSnapshot({key,data:null,error:null,loading:true});
    void (async()=>{
      try {
        const response=await fetch(`/api/workshops/${workId}/review-items?reviewId=${encodeURIComponent(reviewId)}`,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error(response.status===404?'未找到可访问的审核记录。':response.status===400?'审核链接格式不正确。':'审核记录读取失败，请重试。');
        const data=await response.json();
        if(!controller.signal.aborted)setSnapshot({key,data,error:null,loading:false});
      } catch(error) {if(!controller.signal.aborted)setSnapshot({key,data:null,error:error instanceof Error?error.message:String(error),loading:false});}
    })();
    return()=>controller.abort();
  },[workId,reviewId,key,revision,retry]);
  const current=snapshot?.key===key?snapshot:null;
  return {data:current?.data??null,error:current?.error??null,loading:!!reviewId&&(current?.loading??true),refresh:()=>setRetry(value=>value+1)};
}
