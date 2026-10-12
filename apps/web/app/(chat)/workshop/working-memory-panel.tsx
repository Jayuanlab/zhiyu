"use client";

import type { WorkshopEvent } from "@/lib/workshops/run-history-types";
import { buildWorkingMemoryView, type WorkingMemoryEntryView, type WorkingMemoryRecordView } from "@/lib/workshops/working-memory-view";

function recordedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "记录时间未知" : date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
  });
}

function EntryList({ title, items }: { title: string; items: WorkingMemoryEntryView[] }) {
  return <div>
    <h5 className="text-xs font-medium text-muted-foreground">{title}</h5>
    {items.length ? <ul className="mt-1 space-y-2 text-sm leading-6">
      {items.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">
        {item.text}
        {item.evidenceRefs.length ? <div className="break-all text-xs text-muted-foreground">工具回执引用：{item.evidenceRefs.join("、")}</div> :
          <div className="text-xs text-amber-700">这条摘要未附工具回执引用。</div>}
      </li>)}
    </ul> : <p className="mt-1 text-xs text-muted-foreground">未记录</p>}
  </div>;
}

function MemoryContent({ record }: { record: WorkingMemoryRecordView }) {
  return <div className="grid gap-4 xl:grid-cols-2">
    <EntryList title="事实摘要（智能体整理，需核对来源）" items={record.facts} />
    <EntryList title="待验证的假设" items={record.hypotheses} />
    <div>
      <h5 className="text-xs font-medium text-muted-foreground">尚未解决的问题</h5>
      {record.openQuestions.length ? <ul className="mt-1 space-y-1 text-sm leading-6">
        {record.openQuestions.map((item) => <li key={item} className="whitespace-pre-wrap break-words">{item}</li>)}
      </ul> : <p className="mt-1 text-xs text-muted-foreground">未记录；不能据此认定没有缺口。</p>}
    </div>
    <div>
      <h5 className="text-xs font-medium text-muted-foreground">整理时的下一步</h5>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{record.nextAction ?? "未记录下一步。"}</p>
      {record.nextActionEvidenceRefs.length ? <p className="break-all text-xs text-muted-foreground">工具回执引用：{record.nextActionEvidenceRefs.join("、")}</p> : null}
    </div>
  </div>;
}

function RecordReferences({ record }: { record: WorkingMemoryRecordView }) {
  return <div className="space-y-1 break-all text-xs leading-5 text-muted-foreground">
    <p>整理事件：{record.id}{record.commandId ? ` · 整理指令：${record.commandId}` : ""}</p>
    {record.reason && record.reason !== record.reasonLabel ? <p>诊断代码：{record.reason}</p> : null}
    {record.prunedToolCallIds.length ? <p>{record.mode === "shadow" ? "候选移出的工具回执（本轮未生效）" : "累计移出本轮上下文的工具回执"}：{record.prunedToolCallIds.join("、")}</p> : null}
    {record.restoredToolCallIds.length ? <p>恢复的工具回执：{record.restoredToolCallIds.join("、")}</p> : null}
    {record.evidenceRefs.length ? <p>保留的工具回执引用：{record.evidenceRefs.join("、")}</p> : null}
  </div>;
}

function ProjectionObservation({ record }: { record: WorkingMemoryRecordView }) {
  if (!record.projection) return null;
  const stats = record.projection;
  return <div className="space-y-1 text-xs leading-5 text-muted-foreground">
    <p>模型请求上下文：{stats.originalChars.toLocaleString("zh-CN")} → {stats.projectedChars.toLocaleString("zh-CN")} 字符{stats.originalMessageCount !== null && stats.projectedMessageCount !== null ? ` · ${stats.originalMessageCount} → ${stats.projectedMessageCount} 条消息` : ""}</p>
    <p>这是发往模型的请求准备记录，字符量并非 token 用量，也不表示模型已理解摘要或完成任务。</p>
  </div>;
}

/** Uses the run's existing event read, retaining its refresh and owner controls. */
export function WorkingMemoryPanel({ events }: { events: WorkshopEvent[] }) {
  const view = buildWorkingMemoryView(events);
  if (!view) return null;
  const { latest, checkpoint, projection } = view;
  return <section aria-label="本轮工作记忆" className="mt-5 space-y-4 rounded-md border border-border bg-muted/20 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h4 className="text-sm font-semibold text-foreground">本轮工作记忆</h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">供本轮继续执行的状态摘要。事实与假设均由智能体整理，未独立验证；原始事件仍保留在运行记录中。</p>
      </div>
      <span className="shrink-0 rounded border border-border bg-background px-2 py-1 text-xs">{latest.statusLabel}</span>
    </div>
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>最近动作：{recordedAt(latest.createdAt)} · {latest.modeLabel}{latest.version ? ` · 版本 ${latest.version}` : " · 版本未记录"}</p>
      {latest.reasonLabel ? <p className="whitespace-pre-wrap break-words">原因：{latest.reasonLabel}</p> : null}
      {latest.persistenceError ? <p role="alert" className="break-words text-destructive">保存异常：{latest.persistenceError}</p> : null}
      {latest.warnings.map((warning) => <p key={warning} role="status" className="text-amber-700">{warning}</p>)}
    </div>
    {projection ? <div className="space-y-1 border-t border-border pt-3">
      <p className="text-xs font-medium">最近请求准备记录 · 版本 {projection.version ?? "未知"}{checkpoint && projection.version !== checkpoint.version ? "（与最近保存的摘要版本不同）" : ""}</p>
      <ProjectionObservation record={projection} />
    </div> : checkpoint?.mode === "apply" ? <p role="status" className="text-xs text-amber-700">还没有读取到采用该摘要的模型请求记录，不能据此认定已发往模型。</p> : null}
    {checkpoint?.type === "working_memory_restored" ? <p className="text-sm leading-6">本轮整理状态已清空；本次恢复供后续模型调用使用。可在下方查看恢复集合中的工具回执。</p> : checkpoint ? <div className="space-y-3 border-t border-border pt-3">
      <p className="text-xs font-medium text-muted-foreground">{checkpoint.mode === "shadow" ? "最近保存的候选摘要（本轮上下文未裁剪）" : "最近保存的保留摘要"}{checkpoint.version ? ` · 版本 ${checkpoint.version}` : ""} · {recordedAt(checkpoint.createdAt)}</p>
      <MemoryContent record={checkpoint} />
    </div> : <p className="text-sm text-muted-foreground">当前记录没有可读取的保留摘要；请结合原始事件核对。</p>}
    <details className="rounded border border-border bg-background p-3">
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">整理历史与来源 · {view.records.length} 条记录</summary>
      <ol className="mt-3 space-y-4">
        {view.records.map((record) => <li key={record.id} className="space-y-2 border-t border-border pt-3 first:border-0 first:pt-0">
          <p className="text-xs font-medium">{record.statusLabel} · {recordedAt(record.createdAt)} · {record.modeLabel}{record.version ? ` · 版本 ${record.version}` : ""}</p>
          {record.reasonLabel ? <p className="whitespace-pre-wrap break-words text-sm">原因：{record.reasonLabel}</p> : null}
          {record.persistenceError ? <p className="break-words text-xs text-destructive">保存异常：{record.persistenceError}</p> : null}
          {record.warnings.map((warning) => <p key={warning} className="text-xs text-amber-700">{warning}</p>)}
          {record !== checkpoint && (record.facts.length || record.hypotheses.length || record.openQuestions.length || record.nextAction) ? <MemoryContent record={record} /> : null}
          <ProjectionObservation record={record} />
          <RecordReferences record={record} />
        </li>)}
      </ol>
    </details>
  </section>;
}
