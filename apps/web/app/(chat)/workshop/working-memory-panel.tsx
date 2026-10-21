"use client";

import { useRef, useState } from "react";
import type { WorkshopEvent } from "@/lib/workshops/run-history-types";
import type { WorkingMemoryPromotionRunIdentity } from "@/lib/workshops/working-memory-promotion";
import { buildWorkingMemoryView, type WorkingMemoryEntryView, type WorkingMemoryRecordView, type WorkingMemoryView } from "@/lib/workshops/working-memory-view";

export type WorkingMemoryPromotionInput = WorkingMemoryPromotionRunIdentity & { noteKey: string; expectedVersion: number; commandId: string };
export type WorkingMemoryPromotionAction = (input: WorkingMemoryPromotionInput) => Promise<{ candidateId: string; status: string; replayed?: boolean }>;
type PromotionState = { status: "pending" | "submitted" | "error"; message: string };
type NotePromotion = { select: (note: WorkingMemoryEntryView) => void; stateFor: (note: WorkingMemoryEntryView) => PromotionState | undefined; reasonFor: (note: WorkingMemoryEntryView) => string | null; enabled: boolean };

function recordedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "记录时间未知" : date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
  });
}

function EntryList({ title, items, promotion }: { title: string; items: WorkingMemoryEntryView[]; promotion?: NotePromotion }) {
  return <div>
    <h5 className="text-xs font-medium text-muted-foreground">{title}</h5>
    {items.length ? <ul className="mt-1 space-y-2 text-sm leading-6">
      {items.map((item, index) => <li key={item.key ?? index} className="whitespace-pre-wrap break-words">
        {item.text}
        {item.key ? <div className="break-all text-xs text-muted-foreground">笔记键：{item.key}</div> : null}
        {item.evidenceRefs.length ? <div className="break-all text-xs text-muted-foreground">工具回执引用：{item.evidenceRefs.join("、")}</div> :
          <div className="text-xs text-amber-700">这条摘要未附工具回执引用。</div>}
        {promotion && item.key ? <div className="mt-1 space-y-1">
          <button type="button" disabled={!promotion.enabled || !!promotion.reasonFor(item) || promotion.stateFor(item)?.status === "pending" || promotion.stateFor(item)?.status === "submitted"}
            onClick={() => promotion.select(item)}
            className="rounded border border-border bg-background px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            {promotion.stateFor(item)?.status === "pending" ? "正在核对来源并提交…" : promotion.stateFor(item)?.status === "submitted" ? "已送交长期记忆审核" : "送交长期记忆审核"}
          </button>
          {promotion.reasonFor(item) ? <p className="text-xs text-muted-foreground">{promotion.reasonFor(item)}</p> : null}
          {promotion.stateFor(item) ? <p role={promotion.stateFor(item)?.status === "error" ? "alert" : "status"}
            className={promotion.stateFor(item)?.status === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{promotion.stateFor(item)?.message}</p> : null}
        </div> : null}
      </li>)}
    </ul> : <p className="mt-1 text-xs text-muted-foreground">未记录</p>}
  </div>;
}

function MemoryContent({ record, promotion }: { record: WorkingMemoryRecordView; promotion?: NotePromotion }) {
  return <div className="grid gap-4 xl:grid-cols-2">
    <EntryList title="事实摘要（智能体整理，需核对来源）" items={record.facts} promotion={promotion} />
    <EntryList title="待验证的假设" items={record.hypotheses} promotion={promotion} />
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

function PolicyObservation({ record }: { record: WorkingMemoryRecordView }) {
  const count = (value: number | null) => value === null ? "未记录" : String(value);
  return <div className="space-y-1 break-all text-xs leading-5 text-muted-foreground">
    <p>记忆策略：{record.policy?.version ?? "版本未记录"}{record.policy?.hash ? ` · hash ${record.policy.hash}` : " · hash 未记录"}</p>
    <p>最近记忆阶段记录：{record.phase === "LOG" ? "LOG · 整理本轮观测，按笔记键修订状态" : record.phase === "PLAN" ? "PLAN · 读取当前状态，为后续动作准备依据" : record.phase ? `未知阶段（${record.phase}）` : "未记录"}。阶段记录不表示已完成业务动作。</p>
    {record.readCount !== null || record.logCount !== null || record.planCount !== null ? <p>宿主阶段计数：读取 {count(record.readCount)} 次 · LOG {count(record.logCount)} 次 · PLAN {count(record.planCount)} 次。</p> : null}
  </div>;
}

function CatalogObservation({ record }: { record: WorkingMemoryRecordView }) {
  const catalog = record.catalog;
  if (!catalog) return null;
  const count = (value: number | null) => value === null ? "未记录" : value.toLocaleString("zh-CN");
  return <div className="space-y-2 text-xs leading-5">
    <p className="font-medium">来源目录：观测 {count(catalog.evidenceCount)} 条 · 可引用 {count(catalog.referenceEligibleCount)} 条 · 可投影正文 {count(catalog.projectionCandidateCount)} 条 · 正文保留 {count(catalog.blockedCount)} 条</p>
    <p className="text-muted-foreground">可引用的来源与可移出正文分别核对。投影保留工具调用、配对回执和助手思考；恢复会重新提供原正文，不重跑工具。</p>
    {catalog.evidenceCount === 0 ? <p className="text-muted-foreground">此时尚无可识别的工具观测；目录为空不表示整理已成功。</p> : catalog.projectionCandidateCount === 0 ? <p className="text-amber-700">已有来源，但此时没有可移出的正文；请查看保留原因与来源警告。</p> : null}
    {catalog.truncated ? <p role="status" className="text-amber-700">来源详情达到展示上限；以下条目不能代表全部观测。</p> : null}
    {catalog.blockedReasons.length ? <ul className="space-y-1 text-amber-700">
      {catalog.blockedReasons.map(reason => <li key={reason.code}>{reason.label} · {reason.count} 条{reason.code !== reason.label ? `（${reason.code}）` : ""}</li>)}
    </ul> : null}
    {catalog.sources.length ? <details className="rounded border border-border bg-background p-3">
      <summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">来源身份与警告 · {catalog.sources.length} 条</summary>
      <ul className="mt-3 space-y-3">
        {catalog.sources.map(source => <li key={source.toolCallId} className="space-y-1 border-t border-border pt-2 first:border-0 first:pt-0">
          <p className="break-all">{source.toolName ?? "工具未记录"} · {source.toolCallId}</p>
          <p>引用：{source.referenceEligible === null ? "未记录" : source.referenceEligible ? "允许" : "不可引用"} · 正文投影：{source.projectionEligible === null ? "未记录" : source.projectionEligible ? "候选" : "保留"}</p>
          {source.sourceIdentityStatus ? <p className={source.sourceIdentityStatus === "conflicting" ? "text-amber-700" : "text-muted-foreground"}>来源身份：{source.sourceIdentityStatus === "reported" ? "已报告，仍需按片段核对" : source.sourceIdentityStatus === "missing" ? "未报告，不能替代原始来源核验" : source.sourceIdentityStatus === "conflicting" ? "字段冲突，请核对原回执" : source.sourceIdentityStatus}</p> : null}
          {source.provider || source.detail ? <p className="break-words text-muted-foreground">来源提供方：{source.provider ?? "未记录"}{source.detail ? ` · ${source.detail}` : ""}</p> : null}
          {source.contentHash ? <p className="break-all text-muted-foreground">原回执 hash：{source.contentHash}</p> : null}
          {source.sourceIdentity.map(identity => <p key={identity.label} className="break-all text-muted-foreground">{identity.label}：{identity.value}</p>)}
          {source.blockedReasons.length ? <p className="break-words text-amber-700">正文保留原因：{source.blockedReasons.join("、")}</p> : null}
          {source.warningCodes.length ? <p className="break-words text-amber-700">来源警告代码：{source.warningCodes.join("、")}</p> : null}
          {source.warningTexts.map(warning => <p key={warning} className="whitespace-pre-wrap break-words text-amber-700">来源警告：{warning}</p>)}
        </li>)}
      </ul>
    </details> : null}
  </div>;
}

function UsageObservation({ usage }: { usage: WorkingMemoryView["usage"] }) {
  const tokens = (value: { known: number | null; missing: number }) => value.known === null ? "未记录" :
    `${value.known.toLocaleString("zh-CN")}${value.missing ? `（另 ${value.missing} 次未记录）` : ""}`;
  return <div className="space-y-1 text-xs leading-5 text-muted-foreground">
    <p>SDK 用量回执：{usage.records} 次 · 输入 {tokens(usage.inputTokens)} · 输出 {tokens(usage.outputTokens)} · 总 token {tokens(usage.totalTokens)}</p>
    {usage.records ? <p>缓存读取 {tokens(usage.cacheReadTokens)} · 缓存写入 {tokens(usage.cacheWriteTokens)}。未知用量保留为未记录；累计值只覆盖当前读取到的用量回执。</p> : <p>尚无 SDK 用量回执，无法证明 token 成本变化。</p>}
  </div>;
}

function RecordReferences({ record }: { record: WorkingMemoryRecordView }) {
  return <div className="space-y-1 break-all text-xs leading-5 text-muted-foreground">
    <p>整理事件：{record.id}{record.commandId ? ` · 整理指令：${record.commandId}` : ""}</p>
    {record.reason && record.reason !== record.reasonLabel ? <p>诊断代码：{record.reason}</p> : null}
    {record.prunedToolCallIds.length ? <p>{record.mode === "shadow" ? "候选移出的工具回执（本轮未生效）" : record.type === "working_memory_projected" ? "本次请求选择投影的工具正文" : "累计选择投影的工具正文（待模型调用采用）"}：{record.prunedToolCallIds.join("、")}</p> : null}
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
    {stats.originalChars === stats.projectedChars ? <p>本次请求字符量未减少；不能据此认定发生了正文投影。</p> : null}
  </div>;
}

function InvocationUsage({ record }: { record: WorkingMemoryRecordView }) {
  const usage = record.usage;
  if (!usage) return null;
  const tokens = (value: number | null) => value === null ? "未记录" : value.toLocaleString("zh-CN");
  return <div className="space-y-1 break-words text-xs leading-5 text-muted-foreground">
    <p>模型用量回执：调用 {usage.invocation ?? "编号未记录"} · {usage.provider ?? "提供方未记录"} / {usage.model ?? "模型未记录"}{usage.elapsedMs !== null ? ` · ${usage.elapsedMs.toLocaleString("zh-CN")} 毫秒` : ""}</p>
    <p>SDK 输入 {tokens(usage.inputTokens)} · 输出 {tokens(usage.outputTokens)} · 总 token {tokens(usage.totalTokens)} · 用量状态 {usage.status === "reported" ? "已报告" : usage.status === "partial" ? "部分报告" : usage.status === "unknown" ? "未知" : usage.status ?? "未记录"}</p>
  </div>;
}

function ContinuityObservation({ continuity }: { continuity: WorkingMemoryView["continuity"] }) {
  if (!continuity) return null;
  const reasons: Record<string, string> = {
    no_scoped_predecessor: "当前任务范围内还没有上一轮记录。",
    no_audited_checkpoint: "上一轮没有可接续的已审计工作状态。",
    no_safe_historical_notes: "上一轮没有通过来源检查的历史笔记。",
    source_run_not_terminal: "上一轮尚未结束。",
    latest_run_unsuccessful: "最近一轮未成功结束，本轮不沿用它的判断。",
    latest_checkpoint_cleared: "最近一次操作已清空工作笔记。",
    checkpoint_expired: "历史工作状态已过期，需要重新观察。",
    memory_policy_changed: "记忆策略已变化，旧工作状态暂不接续。",
    correction_invalidated_history: "当前纠正已使旧判断失效，本轮需要重新核对。",
    source_history_truncated: "历史事件不完整，无法核对全部来源。",
    source_catalog_incomplete: "历史来源目录不完整。",
    continuity_read_failed: "历史状态读取失败；请核对运行记录后重试。",
    scope_not_owned: "历史任务归属无法核对。",
    continuity_chain_limit: "连续接续次数已到上限，需要重新观察。",
    continuity_ancestor_unavailable: "接续链中的原始运行暂不可核对。",
    continuity_chain_checkpoint_mismatch: "接续链与原始检查点不一致。",
  };
  return <div className="space-y-1 rounded border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
    {continuity.status === "inherited" ? <>
      <p className="font-medium text-foreground">已为本轮输入准备历史工作状态</p>
      <p>历史笔记 {continuity.historicalNoteCount} 条 · 未解决问题 {continuity.openQuestionsCount} 项。历史内容仍须核实；本次接续不会恢复原会话或回放旧工具。</p>
      {continuity.suppressedHistoricalClaims ? <p className="text-amber-700">已优先采用当前纠正，旧事实、假设和行动建议未带入本轮。</p> : null}
      {continuity.sourceRunId ? <p className="break-all">来源运行：{continuity.sourceRunId}</p> : null}
      {continuity.checkpointEventId ? <p className="break-all">原检查点：{continuity.checkpointEventId}</p> : null}
      {continuity.expiresAt ? <p>有效期至：{recordedAt(continuity.expiresAt)}</p> : null}
    </> : <>
      <p className="font-medium text-foreground">本轮未接续历史工作状态</p>
      <p>{reasons[continuity.reason] ?? `历史状态未通过接续核对，原因：${continuity.reason}。`}</p>
      <p>未接续不表示从未保存历史；本轮仍可按权限召回长期记忆。</p>
    </>}
    {continuity.warnings.map((warning, index) => <p key={`${index}:${warning}`} className="break-words">接续提示：{warning}</p>)}
  </div>;
}

/** Uses the run's existing event read, retaining its refresh and owner controls. */
export function WorkingMemoryPanel({ events, onPromote, runStatus, runIdentity }: {
  events: WorkshopEvent[]; onPromote?: WorkingMemoryPromotionAction; runStatus?: string; runIdentity?: WorkingMemoryPromotionRunIdentity;
}) {
  const [promotions, setPromotions] = useState<Record<string, PromotionState>>({});
  const submissions = useRef(new Map<string, { commandId: string; pending: boolean; submitted: boolean }>());
  const view = buildWorkingMemoryView(events);
  if (!view) return null;
  const { latest, checkpoint, projection, catalog, counts } = view;
  const version = checkpoint?.version === null || checkpoint?.version === undefined ? null : Number(checkpoint.version);
  const terminal = (runIdentity?.runKind === "loop" ? ["success", "failed", "cancelled", "blocked"] : ["completed", "failed", "interrupted", "cancelled"]).includes(runStatus ?? "");
  const identityMatches = !!runIdentity && !!checkpoint && events.some(event => event.id === checkpoint.id &&
    (runIdentity.runKind === "loop" ? event.loopRunId === runIdentity.runId && event.loopId === runIdentity.loopId : event.runId === runIdentity.runId && !event.loopRunId && !event.loopId));
  const selectionPrefix = runIdentity ? `${runIdentity.runKind}:${runIdentity.runKind === "loop" ? runIdentity.loopId : ""}:${runIdentity.runId}` : "unknown";
  const promoted = onPromote && checkpoint?.type === "working_memory_updated" ? {
    enabled: terminal && identityMatches && checkpoint.mode === "apply" && version !== null && Number.isSafeInteger(version) && version > 0 &&
      projection?.mode === "apply" && projection.version === checkpoint.version && projection.seq > checkpoint.seq,
    stateFor: (note: WorkingMemoryEntryView) => promotions[`${selectionPrefix}:${checkpoint.version}:${note.key}`],
    reasonFor: (note: WorkingMemoryEntryView) => {
      if (!terminal) return runStatus ? "这轮运行尚未结束，请等运行结束后再送审。" : "运行结束状态尚未读取，暂不能送审。";
      if (!identityMatches) return "运行类型或持续任务身份无法核对，请刷新完整运行记录。";
      if (checkpoint.mode !== "apply") return "这是试运行候选，尚未应用到本轮上下文，不能送交长期记忆审核。";
      if (!runIdentity || version === null || !Number.isSafeInteger(version) || version < 1) return "当前笔记的运行或版本无法核对，请刷新完整运行记录。";
      if (checkpoint.warnings.length) return "当前整理记录存在完整性警告，请先核对并重新读取完整记录。";
      if (projection?.mode !== "apply" || projection.version !== checkpoint.version || projection.seq <= checkpoint.seq)
        return "这版笔记尚无后续模型请求准备回执；仅保存摘要不能证明请求已准备。";
      if (!note.evidenceRefs.length) return "该笔记未附精确来源，不能晋升为长期候选。";
      if (note.evidenceRefs.some(id => !checkpoint.catalog?.sources.some(source => source.toolCallId === id && source.referenceEligible === true && source.sourceIdentityStatus === "reported" && source.durableEventId)))
        return "该笔记的来源尚无精确持久事件映射；本地读取不能直接晋升。";
      return null;
    },
    select: async (note: WorkingMemoryEntryView) => {
      if (!note.key || !runIdentity || !identityMatches || !terminal || version === null || !Number.isSafeInteger(version) || version < 1 || checkpoint.mode !== "apply") return;
      const selection = `${selectionPrefix}:${checkpoint.version}:${note.key}`;
      const prior = submissions.current.get(selection);
      if (prior?.pending || prior?.submitted) return;
      const submission = prior ?? { commandId: crypto.randomUUID(), pending: false, submitted: false };
      submissions.current.set(selection, submission);
      submission.pending = true;
      setPromotions(current => ({ ...current, [selection]: { status: "pending", message: "正在核对已保存的笔记、运行状态和精确来源。" } }));
      try {
        const result = await onPromote({ ...runIdentity, noteKey: note.key, expectedVersion: version, commandId: submission.commandId });
        if (result.status !== "candidate" || !result.candidateId) throw Error("提交结果无法核对，请到长期记忆审核页查看。");
        submission.submitted = true;
        setPromotions(current => ({ ...current, [selection]: { status: "submitted", message: "已保存为待审核候选，尚未生效；请在车间记忆中核对来源并审核。" } }));
      } catch (error) {
        setPromotions(current => ({ ...current, [selection]: { status: "error", message: error instanceof Error ? error.message : "提交未确认，请重试同一指令或到记忆审核页核对。" } }));
      } finally { submission.pending = false; }
    },
  } : undefined;
  return <section aria-label="本轮工作记忆" className="mt-5 space-y-4 rounded-md border border-border bg-muted/20 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h4 className="text-sm font-semibold text-foreground">本轮工作记忆</h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">供本轮继续执行的状态摘要。事实与假设均由智能体整理，未独立验证；原始事件仍保留在运行记录中。</p>
      </div>
      <span className="shrink-0 rounded border border-border bg-background px-2 py-1 text-xs">{latest.statusLabel}</span>
    </div>
    <ContinuityObservation continuity={view.continuity} />
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>最近动作：{recordedAt(latest.createdAt)} · {latest.modeLabel}{latest.version ? ` · 版本 ${latest.version}` : " · 版本未记录"}</p>
      {latest.reasonLabel ? <p className="whitespace-pre-wrap break-words">原因：{latest.reasonLabel}</p> : null}
      {latest.persistenceError ? <p role="alert" className="break-words text-destructive">保存异常：{latest.persistenceError}</p> : null}
      {latest.warnings.map((warning) => <p key={warning} role="status" className="text-amber-700">{warning}</p>)}
      <PolicyObservation record={view.protocol ?? latest} />
      <p>当前读取记录：已保存更新 {counts.updated} 次 · 请求准备 {counts.projected} 次 · 实际字符减少 {counts.reduced} 次 · 恢复 {counts.restored} 次 · 拒绝 {counts.rejected} 次。</p>
      {counts.updated === 0 ? <p role="status" className="text-amber-700">当前记录尚无已保存的整理更新；有来源目录或请求记录不表示记忆整理已发生。</p> : null}
    </div>
    {catalog ? <div className="border-t border-border pt-3"><CatalogObservation record={catalog} /></div> : <p className="text-xs text-muted-foreground">当前记录没有来源目录观测，无法判断可引用或可投影正文是否为空。</p>}
    <UsageObservation usage={view.usage} />
    {projection ? <div className="space-y-1 border-t border-border pt-3">
      <p className="text-xs font-medium">最近请求准备记录 · 版本 {projection.version ?? "未知"}{checkpoint && projection.version !== checkpoint.version ? "（与最近保存的摘要版本不同）" : ""}</p>
      <ProjectionObservation record={projection} />
    </div> : checkpoint?.mode === "apply" ? <p role="status" className="text-xs text-amber-700">还没有读取到采用该摘要的模型请求记录，不能据此认定已发往模型。</p> : null}
    {checkpoint?.type === "working_memory_restored" ? <p className="text-sm leading-6">本轮整理状态已清空；本次恢复供后续模型调用使用。可在下方查看恢复集合中的工具回执。</p> : checkpoint ? <div className="space-y-3 border-t border-border pt-3">
      <p className="text-xs font-medium text-muted-foreground">{checkpoint.mode === "shadow" ? "最近保存的候选摘要（本轮上下文未裁剪）" : "最近保存的保留摘要"}{checkpoint.version ? ` · 版本 ${checkpoint.version}` : ""} · {recordedAt(checkpoint.createdAt)}</p>
      <MemoryContent record={checkpoint} promotion={promoted} />
      {onPromote ? <p className="text-xs leading-5 text-muted-foreground">仅能把已结束运行中的当前笔记送交审核；宿主核对精确来源、版本与请求准备回执（不证明模型已接收或理解）后保存候选。无持久来源的本地读取不能晋升，长期记忆仍须主人核验。</p> : null}
    </div> : <p className="text-sm text-muted-foreground">当前记录没有可读取的保留摘要；请结合原始事件核对。</p>}
    <details className="rounded border border-border bg-background p-3">
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">整理历史与来源 · {view.records.length} 条记录</summary>
      <ol className="mt-3 space-y-4">
        {view.records.map((record) => <li key={record.id} className="space-y-2 border-t border-border pt-3 first:border-0 first:pt-0">
          <p className="text-xs font-medium">{record.statusLabel} · {recordedAt(record.createdAt)} · {record.modeLabel}{record.version ? ` · 版本 ${record.version}` : ""}</p>
          {record.reasonLabel ? <p className="whitespace-pre-wrap break-words text-sm">原因：{record.reasonLabel}</p> : null}
          {record.persistenceError ? <p className="break-words text-xs text-destructive">保存异常：{record.persistenceError}</p> : null}
          {record.warnings.map((warning) => <p key={warning} className="text-xs text-amber-700">{warning}</p>)}
          <PolicyObservation record={record} />
          {record !== checkpoint && (record.facts.length || record.hypotheses.length || record.openQuestions.length || record.nextAction) ? <MemoryContent record={record} /> : null}
          <ProjectionObservation record={record} />
          <InvocationUsage record={record} />
          <RecordReferences record={record} />
        </li>)}
      </ol>
    </details>
  </section>;
}
