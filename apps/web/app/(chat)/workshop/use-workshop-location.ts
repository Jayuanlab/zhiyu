"use client";

import {useSearchParams} from 'next/navigation';
import {useCallback,useEffect,useRef,type SetStateAction} from 'react';

export const WORKSHOP_TABS=['run','attention','loops','memory','sources','review','outbox','evolution'] as const;
export type WorkshopTab=(typeof WORKSHOP_TABS)[number];
const aliases:Record<string,WorkshopTab>={work:'loops',tools:'loops',boundary:'loops',interactions:'sources'};
const readTab=(value:string|null):WorkshopTab=>WORKSHOP_TABS.includes(value as WorkshopTab)?value as WorkshopTab:value&&Object.hasOwn(aliases,value)?aliases[value]:'run';

/** URL locates only workshops already returned by the owner-scoped list. */
export function useWorkshopLocation(ids:string[],ready:boolean,preferredId:string|null){
  const search=useSearchParams();
  const query=search.toString();
  const requested=search.get('workId');
  const selectedId=ready?(ids.includes(requested??'')?requested:ids.includes(preferredId??'')?preferredId:ids[0]??null):null;
  const activeSideTab=readTab(search.get('tab') ?? (search.has('reviewId')?'review':null));
  const isDetailsPanelOpen=search.has('tab') || search.has('reviewId');
  const selectedRunId=ready&&requested===selectedId?search.get('runId'):null;
  const selectedReviewId=ready&&requested===selectedId?search.get('reviewId'):null;
  const latest=useRef({selectedId,activeSideTab,isDetailsPanelOpen});
  latest.current={selectedId,activeSideTab,isDetailsPanelOpen};

  useEffect(()=>{
    if(!ready)return;
    // A click may have updated history before this render's effect runs.
    if(new URLSearchParams(window.location.search).toString()!==query)return;
    const url=new URL(window.location.href);
    if(selectedId)url.searchParams.set('workId',selectedId);else url.searchParams.delete('workId');
    if(isDetailsPanelOpen)url.searchParams.set('tab',activeSideTab);
    if(requested!==selectedId){url.searchParams.delete('runId');url.searchParams.delete('reviewId');}
    if(url.searchParams.toString()!==query)window.history.replaceState(null,'',url);
  },[query,ready,selectedId,requested,activeSideTab,isDetailsPanelOpen]);

  const setSelectedId=useCallback((action:SetStateAction<string|null>)=>{
    const current=latest.current.selectedId;
    const next=typeof action==='function'?action(current):action;
    if(next===current)return;
    const url=new URL(window.location.href);
    if(next)url.searchParams.set('workId',next);else url.searchParams.delete('workId');
    url.searchParams.delete('runId');url.searchParams.delete('reviewId');
    window.history.pushState(null,'',url);
  },[]);

  const setActiveSideTab=useCallback((tab:WorkshopTab)=>{
    const url=new URL(window.location.href);
    url.searchParams.set('tab',tab);
    if(tab!=='review')url.searchParams.delete('reviewId');
    if(url.href!==window.location.href)window.history.pushState(null,'',url);
  },[]);

  const setIsDetailsPanelOpen=useCallback((action:SetStateAction<boolean>)=>{
    const url=new URL(window.location.href);
    const current=url.searchParams.has('tab');
    const next=typeof action==='function'?action(current):action;
    if(next===current)return;
    if(next)url.searchParams.set('tab',latest.current.activeSideTab);else {url.searchParams.delete('tab');url.searchParams.delete('reviewId');}
    window.history.pushState(null,'',url);
  },[]);

  const setSelectedRunId=useCallback((runId:string|null)=>{
    const url=new URL(window.location.href);
    if(runId)url.searchParams.set('runId',runId);else url.searchParams.delete('runId');
    if(url.href!==window.location.href)window.history.pushState(null,'',url);
  },[]);
  const setSelectedReviewId=useCallback((reviewId:string|null)=>{
    const url=new URL(window.location.href);
    if(reviewId){url.searchParams.set('reviewId',reviewId);url.searchParams.set('tab','review');url.searchParams.delete('runId');}
    else url.searchParams.delete('reviewId');
    if(url.href!==window.location.href)window.history.pushState(null,'',url);
  },[]);
  return {selectedId,setSelectedId,activeSideTab,setActiveSideTab,isDetailsPanelOpen,setIsDetailsPanelOpen,selectedRunId,setSelectedRunId,selectedReviewId,setSelectedReviewId};
}
