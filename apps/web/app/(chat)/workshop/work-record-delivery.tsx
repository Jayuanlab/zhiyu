'use client';

import {Markdown} from '@/components/markdown';
import type {WorkRecordDeliveryView} from '@/lib/workshops/work-record-delivery';

export const workRecordStatusLabel=(delivery:WorkRecordDeliveryView)=>({
 completed:delivery.processErrorCount?'已完成 · 有过程异常':'已完成',failed:'未完成',interrupted:'已中断',cancelled:'已取消',
 needs_review:'等待核对',running:'进行中',queued:'排队中',unknown:'状态待核对',
})[delivery.status];

export function WorkRecordDelivery({delivery}:{delivery:WorkRecordDeliveryView}){
 return <section aria-label="本次工作与交付" className="mt-4 space-y-5">
  <div><h4 className="text-sm font-semibold">本次工作</h4><p className="mt-2 text-sm leading-7">{delivery.goal??'这批记录未包含当时的任务说明，可查看原始记录核对。'}</p></div>
  {delivery.summary?<div><h4 className="text-sm font-semibold">工作摘要</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-7">{delivery.summary}</p></div>:null}
  {delivery.recommendationsMarkdown?<div><h4 className="text-sm font-semibold">报告中的建议</h4>
   <p className="mt-1 text-xs leading-6 text-muted-foreground">以下是原报告摘录，不代表已经实施或独立验证。</p>
   <div className="mt-3 break-words text-sm leading-7"><Markdown>{delivery.recommendationsMarkdown}</Markdown></div></div>:null}
  {delivery.reportMarkdown?<details className="rounded-md border border-border p-4" open={!delivery.recommendationsMarkdown}>
   <summary className="cursor-pointer text-sm font-medium">完整报告 · {delivery.reportMarkdown.length.toLocaleString('zh-CN')} 字符</summary>
   <p className="mt-2 text-xs leading-6 text-muted-foreground">展示本轮实际保存的报告。运行完成不等于报告中的判断已经核实。</p>
   <div className="mt-4 min-w-0 break-words text-sm leading-7"><Markdown>{delivery.reportMarkdown}</Markdown></div>
  </details>:<p className="text-sm text-muted-foreground">{delivery.status==='running'?'工作仍在进行，尚无最终交付。':'本轮没有可作为已完成交付展示的报告。'}</p>}
  {delivery.nextStepsMarkdown?<div><h4 className="text-sm font-semibold">报告中的后续安排</h4><div className="mt-2 break-words text-sm leading-7"><Markdown>{delivery.nextStepsMarkdown}</Markdown></div></div>:null}
  {delivery.failureReason?<div role="alert" aria-label="本轮未完成原因" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm leading-7">
   <p className="font-medium">本轮未完成原因</p><p className="break-words">{delivery.failureReason}</p></div>:null}
  {delivery.diagnosticMarkdown?<details className="rounded-md border border-border p-4"><summary className="cursor-pointer text-sm font-medium">未通过的输出 · 仅供排查</summary>
   <p className="mt-2 text-xs text-muted-foreground">以下内容不是已完成的交付。</p><div className="mt-3 break-words text-sm leading-7"><Markdown>{delivery.diagnosticMarkdown}</Markdown></div></details>:null}
 </section>;
}
