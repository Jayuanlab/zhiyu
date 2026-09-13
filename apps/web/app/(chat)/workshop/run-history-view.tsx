'use client';

import type {ReactNode,MouseEvent} from 'react';
import {Badge,Button,Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@openzhiyu/ui';
import {PanelState} from '@/components/workbench/panel-state';

export type RunHistoryItem = {
  id:string; eventCount:number; recordedAt:string; canLocate:boolean; content:ReactNode;
};
type HistoryStatus = {
  busy:boolean; error:string|null; hasMore:boolean; lastSuccess:number|null;
  refresh:()=>void; retry:()=>void; loadMore:()=>void;
};

/** Presentation only: receives interpreted records and exposes navigation/read actions. */
export function RunHistoryView({location,items,status,open,onOpenChange,onSelectRun,latestRecordedAt}:{
  location:{workshopId:string|null;runId:string|null};items:RunHistoryItem[];status:HistoryStatus;
  open:boolean;onOpenChange:(open:boolean)=>void;onSelectRun:(runId:string|null)=>void;latestRecordedAt:string|null;
}) {
  const {workshopId,runId}=location;
  const select=(event:MouseEvent<HTMLAnchorElement>,id:string)=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();onSelectRun(id);
  };
  const href=(id:string)=>`?workId=${encodeURIComponent(workshopId??'')}&runId=${encodeURIComponent(id)}`;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[92vh] !w-[92vw] !max-w-[92vw] flex-col overflow-hidden p-0">
      <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-4 pr-8">
          <div><DialogTitle className="text-base">智能体工作记录</DialogTitle>
            <DialogDescription className="mt-1">按一次运行整理目标、验证过程、判断、动作和证据；每页最多读取 2000 条事件，可继续加载更早记录。</DialogDescription></div>
          <Badge variant="secondary" className="shrink-0">{items.length} 次运行</Badge>
        </div>
        {runId?<div className="mt-2 flex flex-wrap items-center gap-2"><span className="break-all text-xs">定位运行：{runId}</span><Button size="sm" variant="outline" onClick={()=>onSelectRun(null)}>返回运行列表</Button></div>:null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={status.busy} onClick={status.error?status.retry:status.refresh}>{status.error?'重试读取运行记录':'刷新运行记录'}</Button>
          {status.lastSuccess?<span className="text-xs text-muted-foreground">最近读取成功：{new Date(status.lastSuccess).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</span>:null}
          {status.hasMore?<><span className="text-xs">尚有更早事件；当前记录可能不完整。</span><Button size="sm" variant="outline" disabled={status.busy} onClick={status.loadMore}>加载更早记录</Button></>:null}
        </div>
        {status.busy||status.error?<PanelState state={status.busy?'refreshing':'error'} title={status.busy?'运行记录加载中':'运行记录加载失败'} description={status.busy?'已有记录可继续查看，本次查询完成后将更新。':'已有记录仍可查看，本次查询暂时不可用。'} detail={status.error} className="mt-3"/>:null}
      </DialogHeader>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,70vw)_minmax(180px,1fr)]">
        <div className="min-h-0 overflow-y-auto px-4 py-4 lg:px-5">
          {items.length===0?<div className="w-full rounded-lg border border-dashed border-border bg-background px-5 py-10 text-center text-sm text-muted-foreground">{status.busy?'正在读取运行记录…':status.error?'运行记录读取失败，请重试。':runId?'未找到可访问的运行记录，请检查链接或返回运行列表。':'当前范围内没有工作记录。'}</div>:
            <div className="w-full space-y-7">{items.map(item=><section key={item.id} id={`work-log-${item.id}`} className="scroll-mt-6">{item.content}{item.canLocate?<a className="mt-2 inline-block text-sm underline" href={href(item.id)} onClick={event=>select(event,item.id)}>定位此运行</a>:null}</section>)}</div>}
        </div>
        <aside className="hidden min-h-0 border-l border-border bg-muted/30 lg:flex lg:flex-col">
          <div className="shrink-0 border-b border-border px-4 py-3"><div className="text-xs font-medium text-muted-foreground">运行索引</div>{latestRecordedAt?<div className="mt-1 truncate text-xs text-muted-foreground">最新：{latestRecordedAt}</div>:null}</div>
          <nav aria-label="运行索引" className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">{items.map(item=><a key={item.id} href={item.canLocate?href(item.id):`#work-log-${item.id}`} onClick={event=>{if(item.canLocate)select(event,item.id);}} className="block rounded-md px-3 py-2 text-xs hover:bg-background"><Badge variant="outline" className="h-5 px-1.5 text-[10px]">{item.eventCount}</Badge><div className="mt-1 text-foreground">{item.recordedAt}</div></a>)}</nav>
        </aside>
      </div>
    </DialogContent>
  </Dialog>;
}
