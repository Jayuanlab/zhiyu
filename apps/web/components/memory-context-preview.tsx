"use client";

import { useEffect, useRef, useState } from "react";
import type { ContextEntry, MemoryContextPack, ContextRecallReadResult } from "@/lib/memory/query-contracts";

export function MemoryContextPreview({ taskIntent, onFeedback, feedbackDisabled }: {
  taskIntent: string; onFeedback: (contextLogId: string, query: string, outcome: "used" | "missing") => void; feedbackDisabled: boolean;
}) {
  const [pack, setPack] = useState<MemoryContextPack | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const generation = useRef(0), requests = useRef(new Set<AbortController>());
  useEffect(() => {
    generation.current++; for (const request of requests.current) request.abort(); requests.current.clear();
    setPack(null); setEvidence({}); setError(""); setPending(false);
    return () => { for (const request of requests.current) request.abort(); };
  }, [taskIntent]);
  async function recall() {
    const attempt = ++generation.current, controller = new AbortController(); requests.current.add(controller);
    setPending(true); setError(""); setPack(null); setEvidence({});
    try {
      const response = await fetch("/api/memory/read", { method: "POST", headers: { "Content-Type": "application/json" },
        signal: controller.signal, body: JSON.stringify({ purpose: "recall", taskIntent, maxTokens: 8192 }) });
      const result: ContextRecallReadResult = await response.json();
      if (generation.current !== attempt) return;
      if (!response.ok) throw Error("任务召回暂不可用，请重试。");
      if (result.status === "unavailable") throw Error(result.code === "memory_context_budget_insufficient"
        ? "本次完整安全约束超出上下文预算，请缩小任务范围后重试。" : "当前来源尚不可用，请刷新后重试。");
      setPack(result.pack);
    } catch (failure) { if (!controller.signal.aborted && generation.current === attempt) setError(failure instanceof Error ? failure.message : "召回失败，请重试。"); }
    finally { requests.current.delete(controller); if (generation.current === attempt) setPending(false); }
  }
  async function expand(item: ContextEntry) {
    if (item.ref.record.kind !== "observation") return;
    const key = item.ref.record.id, attempt = generation.current, controller = new AbortController(); requests.current.add(controller);
    setEvidence(previous => ({ ...previous, [key]: "正在读取固定版本原文…" }));
    try {
      const response = await fetch("/api/memory/read", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ purpose: "evidence", ref: item.ref, range: { start: 0, end: 8192 } }) });
      const result = await response.json();
      if (generation.current !== attempt) return;
      setEvidence(previous => ({ ...previous, [key]: response.ok && result.status === "ok"
        ? `${result.content}\n\n已读范围：${result.receipt.actualRange.start}–${result.receipt.actualRange.end} / ${result.receipt.totalLength}`
        : "该固定版本原文暂不可用；未将它标记为已核实。" }));
    } catch { if (!controller.signal.aborted && generation.current === attempt) setEvidence(previous => ({ ...previous, [key]: "原文读取失败，可重新展开。" })); }
    finally { requests.current.delete(controller); }
  }
  const groups = pack ? [["constraints", "约束"], ["currentStates", "当前主记录与场景估计"], ["historicalEvidence", "原始证据"], ["interpretations", "理解与经验"]] as const : [];
  return <section aria-label="按任务召回" className="grid min-w-0 gap-3 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-semibold">按任务召回</h2><p className="text-sm text-muted-foreground">根据当前任务重新检查权限、版本和适用性。发现结果不会自动成为任务上下文。</p></div>
      <button type="button" onClick={() => void recall()} disabled={pending || !taskIntent.trim()} className="rounded-md border bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{pending ? "正在召回…" : "按任务召回"}</button>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {pack ? <>
      <p role="status" className="text-sm text-muted-foreground">已取得本次任务的记忆上下文。记忆解释与来源记录均不授予动作权限；判断业务完成仍需核对当前主记录。</p>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={feedbackDisabled} onClick={() => onFeedback(pack.contextLogId, taskIntent, "used")} className="rounded border px-3 py-1 text-sm disabled:opacity-50">反馈有用</button>
        <button type="button" disabled={feedbackDisabled} onClick={() => onFeedback(pack.contextLogId, taskIntent, "missing")} className="rounded border px-3 py-1 text-sm disabled:opacity-50">反馈缺失</button></div>
      {groups.map(([key, label]) => <section key={key} aria-label={label} className="grid min-w-0 gap-2"><h3 className="text-sm font-medium">{label}（{pack[key].length}）</h3>
        {pack[key].length ? pack[key].map((item, index) => <article key={`${item.ref.revision}:${index}`} className="min-w-0 space-y-2 rounded border p-3 text-sm">
          <h4 className="break-words font-medium">{item.subject}</h4><p className="whitespace-pre-wrap break-words">{item.content}</p>
          {item.truncated ? <p className="text-xs text-muted-foreground">已按预算或读取窗口保留部分正文；完整内容需按固定引用展开。</p> : null}
          {item.ref.record.kind === "observation" ? <><button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => void expand(item)}>展开固定原文</button>
            {evidence[item.ref.record.id] ? <p aria-label="固定原文正文" className="whitespace-pre-wrap break-words rounded bg-muted p-2">{evidence[item.ref.record.id]}</p> : null}</> : null}
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">版本与读取回执</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify({ ref: item.ref, freshness: item.freshness, receipt: item.receipt }, null, 2)}</pre></details>
        </article>) : <p className="text-xs text-muted-foreground">本次未装载此类内容；不代表系统中不存在。</p>}
      </section>)}
      <section aria-label="信息缺口"><h3 className="text-sm font-medium">信息缺口</h3>{pack.openQuestions.length ? <ul className="list-disc pl-5 text-sm text-muted-foreground">{pack.openQuestions.map((item, index) => <li key={index}>{item.detail}</li>)}</ul> : <p className="text-xs text-muted-foreground">没有额外记录的缺口；召回范围仍为有界样本。</p>}</section>
      <p className="text-xs text-muted-foreground">上下文预算：{pack.budget.usedUpperBound} / {pack.budget.maxTokens}（保守估计）{pack.budget.truncated ? "；部分正文已裁剪" : ""}</p>
    </> : null}
  </section>;
}
