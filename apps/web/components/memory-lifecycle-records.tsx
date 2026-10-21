"use client";
import { useState } from "react";
import useSWR from "swr";
import { MemoryLessonExtraction, MemoryExtractedLessonReview, lifecycleError } from "./memory-lesson-extraction";
import { MemoryRevisionControl } from "./memory-revision-dialog";
type Kind = "long_term" | "run_record" | "acceptance_record";
type Row = { id: string; subject: string; content: string; status: string; createdAt: string; expiresAt?: string; revisionVersion: string; restoreReceiptId: string | null;
  operational?: { category: string } | null; extractionSpans?: Array<{offset: number; quote: string}>; extractionSourceProblem?: string | null;
  intake?: boolean; intakeSourceMissing?: boolean;
  extraction?: { sourceMemoryId: string; sourceVersion: string; quote: string; conditions: string; counterexample: string; recheckWhen: string } | null;
  lifecycle: { recordClass: Kind; reason: string; phase: string; usableUntil: string | null; recallEligible: boolean; reviewBy?: string } };
const labels: Record<Kind, string> = { long_term: "长期记忆", run_record: "运行记录", acceptance_record: "验收记录" };
const statuses: Record<string, string> = { candidate: "待审核", active: "已保存", verified: "已审核", weakened: "已弱化", superseded: "已被替代", deleted: "已停用" };
const phases: Record<string, string> = { review_expired: "已到复查期限，停止召回", source_changed: "来源变化或无法核验，停止召回", classification_unavailable: "分类信息异常，已停止召回", review_governed: "仍受审核与时效约束", audit_only: "仅保留验收证据", archived: "使用窗口已结束，保留原文", continuity_window: "使用窗口内，仍需独立校验" };
const categories: Record<string, string> = { market_snapshot: "行情快照", daily_report: "运行日报", mixed_content: "混合内容，经验需单独提炼" };
const reasons: Record<string, string> = { authored_operational_checkpoint: "原记录明确标记为运行检查点，保留执行过程与后续问题。", scoped_continuity_acceptance_fixture: "演练标题、正文标记与原提升命令共同指向验收样本。",
  operational_market_snapshot: "包含具体时点的行情、持仓或市场状态，不作为当前事实。", operational_daily_report: "记录本轮执行、巡检、自检或数据源状态。", operational_mixed_content: "执行过程和经验混在同一原文中，需另行提炼独立候选。", historical_long_term_intake: "可复用知识与规则需核对来源，旧的未审核理解重新进入候选。", extracted_lesson_requires_review: "已保留原文摘录、适用条件、反例和复查触发，等待独立审核。" };
async function load(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("记录读取失败，请重试。");
  const body = await response.json();
  if (!Array.isArray(body.records) || body.records.length > 100 || typeof body.truncated !== "boolean" || body.records.some((row: Row) =>
    !row || typeof row.id !== "string" || typeof row.content !== "string" || typeof row.subject !== "string" || typeof row.revisionVersion !== "string"
    || !statuses[row.status] || !Number.isFinite(Date.parse(row.createdAt)) || !row.lifecycle || !labels[row.lifecycle.recordClass] || !phases[row.lifecycle.phase]))
    throw new Error("记录信息不完整，请刷新核对；未将异常当作空列表。");
  return body as { records: Row[]; truncated: boolean; nextCursor?: string | null };
}
export function MemoryLifecycleRecords({ ownerId, onSaved }: { ownerId: string | null; onSaved?: () => void | Promise<void> }) {
  const [kind, setKind] = useState<Kind | "extractions">("run_record"), [pages, setPages] = useState<string[]>([""]);
  const cursor = pages.at(-1)!;
  const endpoint = `/api/memory/lifecycle?recordClass=${kind === "extractions" ? "long_term&extractionsOnly=true" : kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR(ownerId ? [endpoint, ownerId] : null,
    ([url]: [string, string]) => load(url), { revalidateOnFocus: false, shouldRetryOnError: false });
  return <section aria-label="记录分类与生命周期" className="min-w-0 rounded-lg border bg-card p-5">
    <h2 className="font-semibold">长期记忆与运行记录分开保存</h2>
    <p className="mt-2 text-sm leading-6 text-muted-foreground">行情快照和普通日报的使用窗口为创建后 24 小时，检查点为 7 天；窗口内也不能替代当前观测和经过校验的任务接续。混合内容保留整篇原文，只将独立结论提炼为待审核候选。候选需核对来源、条件和反例，默认 30 天复查；来源变化或到期即停止使用。运行与验收记录不进入长期召回，原文不会自动删除。</p>
    <div className="my-4 flex flex-wrap items-center gap-2"><label className="text-sm">记录用途 <select aria-label="记录用途" value={kind} onChange={event => { setKind(event.target.value as Kind | "extractions"); setPages([""]); }} className="ml-2 rounded border bg-background px-3 py-2">{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="extractions">提炼与审核</option></select></label>
      <button type="button" onClick={() => void mutate()} disabled={isLoading} className="rounded border px-3 py-2 text-sm disabled:opacity-50">刷新记录</button></div>
    {isLoading ? <p role="status">正在读取记录…</p> : null}{error ? <p role="alert">{error.message}</p> : null}
    {!error && data ? <><p className="mb-3 text-xs text-muted-foreground">本次读取 {data.records.length} 条{data.truncated ? "，还有更早记录未展示" : ""}。分类不等于内容已核实。</p>
      {data.records.map(row => <LifecycleRow key={`${ownerId}:${row.id}:${row.revisionVersion}`} row={row} onSaved={async () => { await mutate(); await onSaved?.(); }} />)}
      {!data.records.length ? <p className="text-sm text-muted-foreground">本类暂无记录。</p> : null}</> : null}
    {!error && data ? <div className="mt-4 flex items-center gap-3 text-sm"><button type="button" disabled={isLoading || pages.length <= 1} onClick={() => setPages(values => values.slice(0,-1))} className="rounded border px-3 py-2 disabled:opacity-50">上一页</button><span>第 {pages.length} 页</span><button type="button" disabled={isLoading || !data.nextCursor} onClick={() => setPages(values => [...values, data.nextCursor!])} className="rounded border px-3 py-2 disabled:opacity-50">下一页</button></div> : null}
  </section>;
}
function LifecycleRow({ row, onSaved }: { row: Row; onSaved: () => Promise<void> }) {
  const [kind, setKind] = useState<Kind>(row.lifecycle.recordClass), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  async function submit(action: "classify" | "rollback") {
    if (busy) return;
    const command = pending ?? { memoryId: row.id, expectedVersion: row.revisionVersion, commandId: crypto.randomUUID(), action,
      ...(action === "classify" ? { recordClass: kind } : { restoreReceiptId: row.restoreReceiptId }), reason };
    setPending(command); setBusy(true); setError("");
    try {
      const response = await fetch("/api/memory/lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      if (!response.ok) { const body = await response.json(); if ([400, 403, 404, 409].includes(response.status)) setPending(null); throw new Error(lifecycleError(body.code, response.status)); }
      setPending(null); await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "暂时无法确认分类结果，请刷新核对。"); }
    finally { setBusy(false); }
  }
  return <details className="min-w-0 border-t py-3"><summary className="cursor-pointer text-sm leading-6"><span className="font-medium">{row.subject}</span><span className="ml-2 text-xs text-muted-foreground">{labels[row.lifecycle.recordClass]} · {phases[row.lifecycle.phase]} · 原状态：{statuses[row.status]} · 创建于 {new Date(row.createdAt).toLocaleDateString("zh-CN")}</span></summary>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{row.content}</p>
    {row.lifecycle.usableUntil ? <p className="mt-2 text-xs text-muted-foreground">接续窗口截止：{new Date(row.lifecycle.usableUntil).toLocaleString("zh-CN")}；此日期不代表来源仍然有效。</p> : null}
    {row.operational ? <p className="mt-2 text-xs font-medium">{categories[row.operational.category]}</p> : null}
    <p className="mt-2 text-xs text-muted-foreground">分类依据：{reasons[row.lifecycle.reason.replace(/^Historical lifecycle governance: /, "")] ?? row.lifecycle.reason}</p>
    {row.lifecycle.recordClass === "run_record" && !["deleted", "superseded"].includes(row.status) ? <MemoryLessonExtraction source={row} onSaved={onSaved} /> : null}
    {row.extraction || row.intake ? <><MemoryExtractedLessonReview source={row} onSaved={onSaved} /><div className="mt-3"><MemoryRevisionControl memoryId={row.id} onSaved={onSaved} /></div></> : null}
    <form onSubmit={event => { event.preventDefault(); void submit("classify"); }} className="mt-3 grid gap-2 rounded border p-3">
      <label className="text-sm">更正用途 <select aria-label={`更正 ${row.subject} 的用途`} value={kind} disabled={busy || Boolean(pending)} onChange={event => setKind(event.target.value as Kind)} className="ml-2 rounded border bg-background p-2">{Object.entries(labels).map(([value, label]) => <option key={value} value={value} disabled={value === "long_term" && row.lifecycle.recordClass === "run_record"}>{label}</option>)}</select></label>
      <label className="grid gap-1 text-sm">更正原因<input required maxLength={2000} value={reason} disabled={busy || Boolean(pending)} onChange={event => setReason(event.target.value)} className="rounded border bg-background p-2" /></label>
      <p className="text-xs leading-5 text-muted-foreground">整篇运行记录不直接提升为长期记忆。需要提炼经验时，只保存有来源、条件与复查期限的独立候选。</p>
      <div className="flex gap-2"><button disabled={busy || !reason.trim()} className="rounded border px-3 py-2 text-sm disabled:opacity-50">{busy ? "正在核对并保存…" : pending ? "重试同一操作" : "保存用途分类"}</button>
        {row.restoreReceiptId && !pending ? <button type="button" disabled={busy || !reason.trim()} onClick={() => void submit("rollback")} className="rounded border px-3 py-2 text-sm disabled:opacity-50">撤回上次分类</button> : null}</div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </form>
  </details>;
}
