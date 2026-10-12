"use client";

import useSWR from "swr";
import { useRef } from "react";
import { presentAnswerEvidence, type AuditSummary } from "./answer-evidence-presentation";

async function readAudit(url: string): Promise<AuditSummary> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取本轮服务端核验记录");
  return response.json();
}

/** The message part carries only a reference; cached claims never grant a badge. */
export function AnswerEvidenceCard({ turnId, chatId, assistantMessageId, displayedText }: {
  turnId: string; chatId: string; assistantMessageId: string; displayedText: string;
}) {
  const valid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(turnId);
  const mirrorChecks = useRef({ turnId, remaining: 3 });
  if (mirrorChecks.current.turnId !== turnId) mirrorChecks.current = { turnId, remaining: 3 };
  const { data, error, mutate } = useSWR<AuditSummary>(valid ? `/api/native/answer-audits/${turnId}` : null, readAudit, {
    refreshInterval: latest => {
      if (latest?.status === "running") return 2000;
      if (latest?.bodyMirror?.state === "not_confirmed" && mirrorChecks.current.remaining > 0) {
        mirrorChecks.current.remaining--;
        return 1000;
      }
      return 0;
    },
    shouldRetryOnError: false,
    revalidateOnFocus: true,
  });
  const presentation = presentAnswerEvidence({ turnId, chatId, assistantMessageId, displayedText, valid, unavailable: !!error, summary: data });
  return (
    <section aria-label="回答核验状态" className="my-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium" role="status" aria-live="polite">{presentation.title}</span>
        <button type="button" onClick={() => void mutate()} className="rounded px-1 text-xs text-muted-foreground underline underline-offset-2 focus-visible:outline focus-visible:outline-2">刷新核验</button>
      </div>
      {presentation.runtimeNotice && <p className="mt-2 text-xs text-muted-foreground">{presentation.runtimeNotice}</p>}
      {presentation.rows.length > 0 && <dl className="mt-2 grid grid-cols-1 gap-2 text-xs text-muted-foreground">
        {presentation.rows.map((row, index) => <div key={index} className="flex gap-2">
          <dt className="shrink-0">{row.label}</dt><dd className="min-w-0 break-words">{row.value}{row.reason && <span className="mt-0.5 block">{row.reason}</span>}</dd>
        </div>)}
      </dl>}
      {presentation.platform && !presentation.shadow && presentation.total !== undefined && <p className="mt-2 text-xs text-muted-foreground">问项已核对：{presentation.checked}/{presentation.total}；证据缺口：{presentation.gaps}</p>}
      {presentation.progress && data?.status === "running" && <p className="mt-2 text-xs text-muted-foreground">已判断 {presentation.progress.resolvedRequirements}/{presentation.progress.totalRequirements} 个问项，等待本轮终态。最近记录：{presentation.progress.lastEventAt}</p>}
      {presentation.shadow && <p className="mt-2 text-xs text-muted-foreground">当前为影子对照：候选核验仅用于观察，显示正文仍是模型原答复。</p>}
      <p className="mt-2 text-xs text-muted-foreground">{presentation.bodyMirrorTitle}{presentation.bodyMirrorObservedAt && `；本次检查：${presentation.bodyMirrorObservedAt}`}。正文保存与事实、执行结果及业务效果分别判断。</p>
      {presentation.sources[0] && <p className="mt-2 break-words text-xs text-muted-foreground">观测时间：{presentation.sources[0].observedAt ?? "未记录"}；读取范围：{presentation.sources[0].scope ?? "未记录"}</p>}
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2">查看本轮记录</summary>
        <p className="mt-1 break-all">{turnId}</p>
        {presentation.sources.map((source, index) => <p key={index} className="mt-1 break-words">来源：{source.source ?? "未记录"}；时间：{source.observedAt ?? "未记录"}；范围：{source.scope ?? "未记录"}</p>)}
        <p className="mt-1">核验仅覆盖本轮实际读取并纳入回答的问项。保存状态、执行观测和业务效果分别判断，缺少证据时保持未知。</p>
      </details>
    </section>
  );
}
