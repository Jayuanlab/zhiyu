"use client";
import { useState } from "react";
type Source = { id: string; subject: string; content: string; status: string; revisionVersion: string; expiresAt?: string;
  intake?: boolean; intakeSourceMissing?: boolean; lifecycle?: { reviewBy?: string };
  extractionSpans?: Array<{offset: number; quote: string}>; extractionSourceProblem?: string | null;
  extraction?: { sourceMemoryId: string; sourceVersion: string; quote: string; conditions: string; counterexample: string; recheckWhen: string } | null };
export function lifecycleError(code: string | undefined, status: number) {
  if (code === "extract_lesson_required") return "整篇运行记录不能直接变为长期记忆，请单独提炼有来源的结论。";
  if (code === "protected_boundary") return "边界记忆不能改为运行或验收记录；请通过审核与纠错处理内容。";
  if (code === "volatile_lesson") return "请提炼独立、可复用的结论，不要复制整篇日报或写入当前价格、账户和持仓状态。";
  if (code === "source_span_conflict") return "摘录与原文不一致，请重新选择原文中的完整片段。";
  if (code === "lesson_source_changed_or_expired") return "来源已变化或候选已到复查期限，请基于当前原文重新提炼并审核。";
  if (code === "intake_source_required") return "缺少可核原始证据或已到复查期限，请通过纠错补充当前来源后重新审核。";
  return status === 409 ? "记录或来源已变化，请刷新核对；本次没有覆盖新版本。" : "操作尚未确认成功，请重试同一操作或刷新核对。";
}
export function MemoryLessonExtraction({ source, onSaved }: { source: Source; onSaved: () => Promise<void> }) {
  const [quote, setQuote] = useState(source.extractionSpans?.[0]?.quote ?? ""), [conclusion, setConclusion] = useState(""), [conditions, setConditions] = useState(""),
    [counterexample, setCounterexample] = useState(""), [recheckWhen, setRecheckWhen] = useState(""), [days, setDays] = useState(30), [pending, setPending] = useState<Record<string, unknown> | null>(null),
    [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState("");
  async function submit() {
    if (busy) return;
    const command = pending ?? { sourceMemoryId: source.id, expectedVersion: source.revisionVersion, commandId: crypto.randomUUID(),
      offset: source.content.indexOf(quote), quote, conclusion, conditions, counterexample, recheckWhen, validityDays: days };
    if (Number(command.offset) < 0) { setError("请摘录原文中实际存在的文字。"); return; }
    setPending(command); setBusy(true); setError("");
    try {
      const response = await fetch("/api/memory/extractions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      const body = await response.json();
      if (!response.ok) { if ([400,403,404,409].includes(response.status)) setPending(null); throw new Error(lifecycleError(body.code, response.status)); }
      setPending(null); setResult(`已保存待审核候选 ${body.candidateId}。原报告仍是运行记录；请在“提炼与审核”中核对来源。`); await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "暂时无法确认提炼结果。"); } finally { setBusy(false); }
  }
  return <details className="mt-3 rounded border p-3"><summary className="cursor-pointer text-sm font-medium">从原文提炼长期记忆候选</summary>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">只有独立结论进入候选。原报告不改写，摘录必须与原文完全一致；候选默认 30 天复查，来源变化即停止使用。</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} className="mt-3 grid gap-3">
      {source.extractionSpans?.length ? <label className="grid gap-1 text-sm">原文中的经验片段<select aria-label="原文中的经验片段" disabled={busy || Boolean(pending)} onChange={event => setQuote(source.extractionSpans![Number(event.target.value)].quote)} className="min-w-0 rounded border bg-background p-2">{source.extractionSpans.map((span, index) => <option key={span.offset} value={index}>片段 {index + 1} · {span.quote.slice(0,45)}</option>)}</select></label> : null}
      <label className="grid gap-1 text-sm">原文摘录<textarea required minLength={10} maxLength={2000} value={quote} disabled={busy || Boolean(pending)} onChange={event => setQuote(event.target.value)} className="min-h-24 rounded border bg-background p-2" /></label>
      <label className="grid gap-1 text-sm">独立结论<textarea required maxLength={2000} value={conclusion} disabled={busy || Boolean(pending)} onChange={event => setConclusion(event.target.value)} className="rounded border bg-background p-2" /></label>
      <label className="grid gap-1 text-sm">适用条件<textarea required maxLength={1200} value={conditions} disabled={busy || Boolean(pending)} onChange={event => setConditions(event.target.value)} className="rounded border bg-background p-2" /></label>
      <label className="grid gap-1 text-sm">反例与限制<textarea required maxLength={1200} value={counterexample} disabled={busy || Boolean(pending)} onChange={event => setCounterexample(event.target.value)} className="rounded border bg-background p-2" /></label>
      <label className="grid gap-1 text-sm">复查触发<textarea required maxLength={1200} value={recheckWhen} disabled={busy || Boolean(pending)} onChange={event => setRecheckWhen(event.target.value)} className="rounded border bg-background p-2" /></label>
      <label className="text-sm">复查期限（天）<input type="number" min={1} max={90} required value={days} disabled={busy || Boolean(pending)} onChange={event => setDays(Number(event.target.value))} className="ml-2 w-20 rounded border bg-background p-2" /></label>
      <button disabled={busy} className="justify-self-start rounded border px-3 py-2 text-sm disabled:opacity-50">{busy ? "正在核对来源…" : pending ? "重试同一提炼操作" : "保存提炼候选"}</button>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{result ? <p role="status" className="break-words text-sm">{result}</p> : null}
    </form></details>;
}
export function MemoryExtractedLessonReview({ source, onSaved }: { source: Source; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""),
    [original, setOriginal] = useState<{subject:string;content:string;changed:boolean} | null>(null);
  const deadline = source.expiresAt ?? source.lifecycle?.reviewBy;
  const expired = Boolean(deadline && Date.parse(deadline) <= Date.now()), unavailable = Boolean(source.extractionSourceProblem) || expired || Boolean(source.intake && source.intakeSourceMissing);
  async function readOriginal() {
    try { const response = await fetch(`/api/memory/lifecycle?memoryId=${source.extraction!.sourceMemoryId}`, { cache: "no-store" });
      if (!response.ok) throw Error("原文读取失败，请重试。"); const body = await response.json(), row = body.records?.[0];
      if (row?.id !== source.extraction!.sourceMemoryId || typeof row.content !== "string") throw Error("当前原文不可用，请停止采用该候选。");
      setOriginal({ subject:row.subject,content:row.content,changed:row.revisionVersion!==source.extraction!.sourceVersion });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "原文读取失败。"); }
  }
  async function review(decision: "confirmed" | "rejected") {
    if (busy || !reason.trim()) return;
    setBusy(true); setError("");
    try { const response = await fetch(`/api/memory/candidates/${source.id}/review`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, expectedVersion: source.revisionVersion, evidenceConfirmed: confirmed, reason }) });
      if (!response.ok) { const body = await response.json(); throw new Error(lifecycleError(body.code, response.status)); } await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "审核未确认，请刷新核对。"); } finally { setBusy(false); }
  }
  return <div className="mt-3 grid gap-2 rounded border p-3 text-sm">
    <p className="break-words text-xs text-muted-foreground">{source.intake ? "历史理解重新准入，仍需核对原始证据。" : `原运行记录：${source.extraction?.sourceMemoryId}。`}{deadline ? `复查截止：${new Date(deadline).toLocaleString("zh-CN")}` : ""}</p>
    {source.extraction ? <><blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3 text-xs leading-5 text-muted-foreground">{source.extraction.quote}</blockquote><button type="button" onClick={() => void readOriginal()} className="justify-self-start rounded border px-3 py-2">查看当前原文</button></> : null}
    {original ? <details open className="min-w-0 rounded border p-3"><summary className="cursor-pointer">{original.subject} · {original.changed ? "来源版本已变化，不能沿用旧候选" : "原文版本匹配，内容仍需核验"}</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5">{original.content}</p></details> : null}
    {unavailable ? <p role="status" className="text-destructive">{source.intake && source.intakeSourceMissing ? "缺少可核原始证据，请通过纠错补充来源，当前不进入长期召回。" : "来源已变化、无法核验或已到复查期限，当前停止召回；请从当前来源重新整理。"}</p> : <p className="text-xs text-muted-foreground">版本匹配只证明内容未变化，不证明结论正确。审核前请核对原文、适用条件和反例。</p>}
    {source.status === "candidate" ? <><label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对原文、适用条件、反例与当前来源</label>
      <label className="grid gap-1">审核原因<input value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} className="rounded border bg-background p-2" /></label>
      <div className="flex gap-2"><button disabled={busy || unavailable || !confirmed || !reason.trim()} onClick={() => void review("confirmed")} className="rounded border px-3 py-2 disabled:opacity-50">确认长期候选</button><button disabled={busy || !reason.trim()} onClick={() => void review("rejected")} className="rounded border px-3 py-2 disabled:opacity-50">不采纳候选</button></div></> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </div>;
}
