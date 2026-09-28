"use client";

import {useSearchParams} from 'next/navigation';
import {useCallback,useEffect,useRef,type SetStateAction} from 'react';

export const WORKSHOP_TABS=['run','attention','loops','memory','sources','review','outbox','collaboration','evolution'] as const;
export type WorkshopTab=(typeof WORKSHOP_TABS)[number];
const aliases:Record<string,WorkshopTab>={work:'loops',tools:'loops',boundary:'loops',interactions:'sources'};
const readTab=(value:string|null):WorkshopTab=>WORKSHOP_TABS.includes(value as WorkshopTab)?value as WorkshopTab:value&&Object.hasOwn(aliases,value)?aliases[value]:'run';
export const WORKSHOP_MANAGEMENT_VIEWS=['tasks','model','tools','boundary'] as const;
export type WorkshopManagementView=(typeof WORKSHOP_MANAGEMENT_VIEWS)[number];
const legacyManagementViews:Record<string,WorkshopManagementView>={work:'model',tools:'tools',boundary:'boundary'};
const readManagementView=(tab:string|null,config:string|null):WorkshopManagementView=>
  tab&&Object.hasOwn(legacyManagementViews,tab)?legacyManagementViews[tab]:
  WORKSHOP_MANAGEMENT_VIEWS.includes(config as WorkshopManagementView)?config as WorkshopManagementView:'tasks';

/** URL locates only workshops already returned by the owner-scoped list. */
export function useWorkshopLocation(ids:string[],ready:boolean,preferredId:string|null){
  const search=useSearchParams();
  const query=search.toString();
  const requested=search.get('workId');
  const selectedId=ready?(ids.includes(requested??'')?requested:ids.includes(preferredId??'')?preferredId:ids[0]??null):null;
  const requestedTab=search.get('tab');
  const activeSideTab=readTab(requestedTab ?? (search.has('reviewId')?'review':null));
  const managementView=activeSideTab==='loops'?readManagementView(requestedTab,search.get('config')):'tasks';
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
    if(isDetailsPanelOpen&&activeSideTab==='loops')url.searchParams.set('config',managementView);
    else url.searchParams.delete('config');
    if(requested!==selectedId){
      url.searchParams.delete('runId');
      url.searchParams.delete('reviewId');
      if(requested!==null)url.searchParams.delete('config');
    }
    if(url.searchParams.toString()!==query)window.history.replaceState(null,'',url);
  },[query,ready,selectedId,requested,activeSideTab,managementView,isDetailsPanelOpen]);

  const setSelectedId=useCallback((action:SetStateAction<string|null>)=>{
    const current=latest.current.selectedId;
    const next=typeof action==='function'?action(current):action;
    if(next===current)return;
    const url=new URL(window.location.href);
    if(next)url.searchParams.set('workId',next);else url.searchParams.delete('workId');
    url.searchParams.delete('runId');url.searchParams.delete('reviewId');url.searchParams.delete('config');
    window.history.pushState(null,'',url);
  },[]);

  const setActiveSideTab=useCallback((tab:WorkshopTab)=>{
    const url=new URL(window.location.href);
    url.searchParams.set('tab',tab);
    if(tab!=='review')url.searchParams.delete('reviewId');
    if(tab==='loops')url.searchParams.set('config',readManagementView(null,url.searchParams.get('config')));
    else url.searchParams.delete('config');
    if(url.href!==window.location.href)window.history.pushState(null,'',url);
  },[]);

  const setManagementView=useCallback((view:WorkshopManagementView)=>{
    const url=new URL(window.location.href);
    url.searchParams.set('tab','loops');
    url.searchParams.set('config',view);
    url.searchParams.delete('reviewId');
    if(url.href!==window.location.href)window.history.pushState(null,'',url);
  },[]);

  const setIsDetailsPanelOpen=useCallback((action:SetStateAction<boolean>)=>{
    const url=new URL(window.location.href);
    const current=url.searchParams.has('tab')||url.searchParams.has('reviewId');
    const next=typeof action==='function'?action(current):action;
    if(next===current&&(next||!url.searchParams.has('config')))return;
    if(next)url.searchParams.set('tab',latest.current.activeSideTab);
    else {url.searchParams.delete('tab');url.searchParams.delete('reviewId');url.searchParams.delete('config');}
    if(url.href!==window.location.href)window.history.pushState(null,'',url);
  },[]);

  const setSelectedRunId=useCallback((runId:string|null)=>{
    const url=new URL(window.location.href);
    if(runId)url.searchParams.set('runId',runId);else url.searchParams.delete('runId');
    if(url.href!==window.location.href)window.history.pushState(null,'',url);
  },[]);
  const setSelectedReviewId=useCallback((reviewId:string|null)=>{
    const url=new URL(window.location.href);
    if(reviewId){url.searchParams.set('reviewId',reviewId);url.searchParams.set('tab','review');url.searchParams.delete('runId');url.searchParams.delete('config');}
    else url.searchParams.delete('reviewId');
    if(url.href!==window.location.href)window.history.pushState(null,'',url);
  },[]);
  return {selectedId,setSelectedId,activeSideTab,setActiveSideTab,managementView,setManagementView,isDetailsPanelOpen,setIsDetailsPanelOpen,selectedRunId,setSelectedRunId,selectedReviewId,setSelectedReviewId};
}
