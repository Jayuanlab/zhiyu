"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

type SourceItem = {
  id: string; status: "resolved" | "unresolved"; source: string; title: string | null;
  content: string | null; createdAt: string | null; metadata: Record<string, unknown>;
  truncated: boolean; warning: string | null;
};
type SourceEnvelope = {
  proposalId: string; sources: SourceItem[]; requestedCount: number;
  returnedCount: number; truncated: boolean; warning: string | null;
};
const sourceLabel: Record<string, string> = {
  workshop_event: "车间原始事件", interaction_event: "沟通原始事件", raw_message: "原始消息",
  brain_observation: "原始观测", unknown: "来源类型未知",
};
const displayDate = (value: string | null) => value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleString("zh-CN") : "时间未知";

/** Read only the server-authorized references already attached to this saved memory. */
export function MemoryEvidenceViewer({ memoryId, evidenceRefs, baseEvidenceRefs }: {
  memoryId: string; evidenceRefs: string[]; baseEvidenceRefs?: string[];
}) {
  const [sources, setSources] = useState<SourceEnvelope | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function load() {
    if (reading.current) return;
    reading.current = true; setLoading(true); setError(null);
    const current = ++generation.current;
    try {
      const response = await fetch(`/api/brain/memory-updates/evidence?proposalId=${encodeURIComponent(memoryId)}`,
        { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => null) as SourceEnvelope | null;
      if (!response.ok) throw new Error((body as unknown as { error?: string })?.error ?? "原始证据读取失败。");
      const allowedRefs = new Set([...evidenceRefs, ...(baseEvidenceRefs ?? [])]);
      if (!body || body.proposalId !== memoryId || !Array.isArray(body.sources) || body.sources.length > 40 ||
          typeof body.truncated !== "boolean" || body.returnedCount !== body.sources.length ||
          !Number.isInteger(body.requestedCount) || body.requestedCount < body.returnedCount ||
          new Set(body.sources.map(source => source?.id)).size !== body.sources.length ||
          body.sources.some(source => !source || typeof source.id !== "string" || !allowedRefs.has(source.id) || !["resolved", "unresolved"].includes(source.status) ||
            (source.title !== null && typeof source.title !== "string") || typeof source.source !== "string" || typeof source.truncated !== "boolean" ||
            (source.content !== null && typeof source.content !== "string"))) throw new Error("来源读取结果不完整或与当前记忆引用不匹配，请刷新记忆与提案，未标记任何来源为已核实。");
      if (current === generation.current) setSources(body);
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : "来源读取失败。"); }
    finally { if (current === generation.current) { reading.current = false; setLoading(false); } }
  }
  return <details className="rounded-md border p-3 text-sm" onToggle={event => {
    if (event.currentTarget.open && sources === null && !loading) void load();
  }}>
    <summary className="cursor-pointer font-medium">查看原始证据</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">来源是原始观测，引用和模型评分本身不代表真实。无法解析的内容不会显示为已核实。</p>
      <details className="text-xs"><summary className="cursor-pointer">查看原引用</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all">{baseEvidenceRefs
          ? `当前记忆引用：\n${baseEvidenceRefs.join("\n") || "无"}\n\n提案引用：\n${evidenceRefs.join("\n") || "无"}`
          : evidenceRefs.join("\n") || "尚无来源引用"}</pre>
      </details>
      {loading ? <p role="status">正在读取原始证据…</p> : null}
      {error ? <p role="alert" className="text-amber-700">{error}</p> : null}
      <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>重新读取证据</Button>
      {sources?.warning || sources?.truncated ? <p role="status" className="text-amber-700">{sources.warning || "来源数量或正文已截断，请核对完整来源后再决定。"}</p> : null}
      {sources?.sources.map(source => <article key={source.id} data-source-ref={source.id} className="space-y-2 border-t pt-3">
        <p className="font-medium">{source.title || source.id} · {source.status === "resolved" ? "已读取原文，待人工核对" : "无法解析来源"}</p>
        <p className="text-xs text-muted-foreground">{sourceLabel[source.source] ?? "来源类型未知"} · 来源时间：{displayDate(source.createdAt)}</p>
        {source.content !== null ? <p className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words leading-6">{source.content}</p> : <p className="text-muted-foreground">原文暂不可用。</p>}
        {source.warning || source.truncated ? <p className="text-xs text-amber-700">{source.warning || "正文已截断。"}</p> : null}
        <details className="text-xs"><summary className="cursor-pointer">来源编号与说明</summary><pre className="mt-2 whitespace-pre-wrap break-all">{`${source.id}\n${JSON.stringify(source.metadata, null, 2)}`}</pre></details>
      </article>)}
      {sources?.sources.length === 0 ? <p className="text-muted-foreground">没有可读取的来源。请保留未知状态，先补充或核对原始来源。</p> : null}
    </div>
  </details>;
}
