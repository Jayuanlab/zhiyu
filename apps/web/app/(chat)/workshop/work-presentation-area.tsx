"use client";
import { useEffect, useState } from "react";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@openzhiyu/ui";
import { Markdown } from "@/components/markdown";
import type { WorkPresentationArtifact, WorkPresentationV1 } from "@/lib/workshops/work-presentation";

function formatDateTime(value: string | null) {
  if (!value) return "暂无安排";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无安排";
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function workPresentationStatusLabel(status: WorkPresentationV1["status"]) {
  switch (status) {
    case "queued": return "待运行";
    case "running": return "汇报准备中";
    case "completed": return "已完成";
    case "failed": return "运行失败";
    case "interrupted": return "已中断";
    case "cancelled": return "已取消";
    case "needs_review": return "待审核";
    default: return "状态待核实";
  }
}

type WorkArtifactPreviewKind = "markdown" | "text" | "json";
const WORK_ARTIFACT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

function workArtifactPreviewKind(artifact: WorkPresentationArtifact): WorkArtifactPreviewKind | null {
  if (!artifact.href) return null;
  const mime = artifact.mimeType.toLowerCase().split(";")[0]?.trim();
  const name = artifact.fileName.toLowerCase();
  if (name.endsWith(".md") || mime === "text/markdown") return "markdown";
  if (name.endsWith(".json") || mime === "application/json") return "json";
  if (name.endsWith(".txt") || mime === "text/plain") return "text";
  return null;
}

function formatWorkArtifactPreview(text: string, kind: WorkArtifactPreviewKind) {
  if (kind !== "json") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function readWorkArtifactPreview(href: string, signal: AbortSignal): Promise<string> {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin ||
      !/^\/api\/workshops\/[^/]+\/artifacts\/[^/]+\/[^/]+$/.test(url.pathname)) {
    throw new Error("附件地址不属于当前车间的受控产物接口。");
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
    headers: { Accept: "text/markdown, text/plain, application/json" },
  });
  if (!response.ok) {
    throw new Error("附件读取失败（HTTP " + response.status + "）。");
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "text/markdown" && contentType !== "text/plain" &&
      contentType !== "application/json") {
    throw new Error("附件返回的内容不是可预览文本。");
  }
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > WORK_ARTIFACT_PREVIEW_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("附件超过 2 MiB 预览上限，请使用附件链接获取原文件。");
  }
  if (!response.body) throw new Error("浏览器未提供附件数据流。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > WORK_ARTIFACT_PREVIEW_MAX_BYTES) {
        await reader.cancel();
        throw new Error("附件超过 2 MiB 预览上限，请使用附件链接获取原文件。");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

export function WorkPresentationArea({
  presentation,
  loading,
  error,
  onOpenWorkLog,
  mode = "summary",
}: {
  presentation: WorkPresentationV1 | null;
  loading: boolean;
  error: string | null;
  onOpenWorkLog: (runId: string | null) => void;
  mode?: "summary" | "conversation";
}) {
  const [open, setOpen] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<{
    runId: string;
    artifactId: string;
  } | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewResult, setPreviewResult] = useState<{
    key: string;
    status: "loading" | "ready" | "error";
    text?: string;
    error?: string;
  } | null>(null);
  const requestedArtifactId = presentation && previewSelection && previewSelection.runId === presentation.runId
    ? previewSelection.artifactId
    : null;
  const selectedPreviewArtifact = presentation && requestedArtifactId
    ? presentation.artifacts.find((artifact) => artifact.id === requestedArtifactId) ?? null
    : null;
  const previewKind = selectedPreviewArtifact
    ? workArtifactPreviewKind(selectedPreviewArtifact)
    : null;
  const previewHref = selectedPreviewArtifact?.href ?? null;
  const previewKey = selectedPreviewArtifact
    ? presentation?.runId + "/" + selectedPreviewArtifact.id
    : null;

  useEffect(() => {
    if (!open || !previewKey || !previewHref || !previewKind) return;
    const controller = new AbortController();
    setPreviewResult({ key: previewKey, status: "loading" });
    readWorkArtifactPreview(previewHref, controller.signal)
      .then((text) => {
        if (!controller.signal.aborted) {
          setPreviewResult({
            key: previewKey,
            status: "ready",
            text: formatWorkArtifactPreview(text, previewKind),
          });
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setPreviewResult({
            key: previewKey,
            status: "error",
            error: failure instanceof Error ? failure.message : String(failure),
          });
        }
      });
    return () => controller.abort();
  }, [open, previewKey, previewHref, previewKind, previewNonce]);

  const openArtifactPreview = (artifact: WorkPresentationArtifact) => {
    if (!presentation || !workArtifactPreviewKind(artifact)) return;
    setPreviewSelection({ runId: presentation.runId, artifactId: artifact.id });
    setOpen(true);
  };
  const closePresentation = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setPreviewSelection(null);
      setPreviewResult(null);
    }
  };
  const status = presentation?.status ?? "unknown";
  const statusTone = status === "completed"
    ? "bg-emerald-50 text-emerald-800"
    : status === "failed" || status === "interrupted"
      ? "bg-rose-50 text-rose-800"
      : "bg-amber-50 text-amber-800";
  const visibleArtifacts = presentation?.artifacts.slice(0, 3) ?? [];

  return (
    <>
      <section aria-label={mode === "conversation" ? "任务回复" : "工作汇报"} className={mode === "conversation" ? "min-w-0" : "mt-5 rounded-md border border-border bg-white px-4 py-4 sm:px-5"}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            {mode === "summary" ? <p className="text-xs font-medium text-violet-700">工作汇报</p> : null}
            <h2 className="mt-1 text-base font-semibold text-foreground">
              {presentation?.title ?? (loading ? "正在读取工作汇报" : "暂无工作汇报")}
            </h2>
          </div>
          {presentation && mode === "summary" ? (
            <Badge variant="secondary" className={statusTone}>
              {workPresentationStatusLabel(status)}
            </Badge>
          ) : null}
        </div>
        {presentation ? (
          <>
            {mode === "conversation" && presentation.reportMarkdown ? (
              <>
                {presentation.status !== "completed" ? <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">{presentation.summary}</p> : null}
                <article className="mt-3 max-h-[480px] overflow-auto text-sm leading-7 text-foreground [&_table]:min-w-[800px] [&_td]:min-w-24 [&_th]:min-w-24">
                  <Markdown>{presentation.reportMarkdown}</Markdown>
                </article>
              </>
            ) : (
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">
                {presentation.summary || "本轮尚无可展示的结论，请查看工作记录核对执行状态。"}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {presentation.presentedAt ? "最近更新 " + formatDateTime(presentation.presentedAt) : "更新时间待核实"}
              {presentation.runId ? " · 运行 " + presentation.runId.slice(0, 8) : ""}
              {loading ? " · 正在刷新" : ""}
            </p>
            {presentation.computerUse ? (
              <div className="mt-4 rounded-md border border-violet-200 bg-violet-50/40 p-3 text-sm">
                <p className="font-medium text-foreground">电脑执行 · {presentation.computerUse.backend === "python" ? "桌面" : "浏览器"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {presentation.computerUse.latestStep ?? "等待执行记录"}
                  {presentation.computerUse.latestStepAt ? ` · ${formatDateTime(presentation.computerUse.latestStepAt)}` : ""}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {presentation.computerUse.outcomeVerified ? "结果已核验" : "执行结束仍需根据目标状态核验结果"}
                </p>
                <a
                  href={`http://127.0.0.1:${presentation.computerUse.backend === "python" ? "3001" : "3000"}/?runId=${encodeURIComponent(presentation.computerUse.cuaRunId)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="mt-2 inline-block text-xs font-medium text-violet-700 underline underline-offset-2"
                >
                  查看完整执行控制台
                </a>
              </div>
            ) : null}
            {visibleArtifacts.length ? (
              <div className="mt-4 border-t border-border pt-3">
                <p className="text-xs font-medium text-muted-foreground">
                  本轮产物与附件 · {presentation.artifacts.length} 项
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {visibleArtifacts.map((artifact) => {
                    const kind = workArtifactPreviewKind(artifact);
                    if (kind) return (
                      <button key={artifact.id} type="button"
                        onClick={() => openArtifactPreview(artifact)}
                        className="max-w-full truncate rounded border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100">
                        {artifact.label} · 预览
                      </button>
                    );
                    if (artifact.href) return (
                      <a key={artifact.id} href={artifact.href} target="_blank" rel="noopener noreferrer"
                        className="max-w-full truncate rounded border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100">
                        {artifact.label}
                      </a>
                    );
                    return (
                      <span key={artifact.id}
                        className="max-w-full truncate rounded border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                        {artifact.label} · 暂不可打开
                      </span>
                    );
                  })}
                  {presentation.artifacts.length > visibleArtifacts.length ? (
                    <span className="px-1 py-1 text-xs text-muted-foreground">
                      另有 {presentation.artifacts.length - visibleArtifacts.length} 项
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
            {presentation.warnings.length ? (
              <output className="mt-3 block text-xs leading-5 text-amber-800">
                限制与异常：{presentation.warnings[0]}
                {presentation.warnings.length > 1 ? "；另有 " + (presentation.warnings.length - 1) + " 项" : ""}
              </output>
            ) : null}
            {error ? (
              <p className="mt-3 text-xs leading-5 text-rose-800" role="alert">
                汇报刷新失败：{error}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                setPreviewSelection(null);
                setOpen(true);
              }}>
                {mode === "conversation" ? "查看完整汇报与附件" : "查看完整汇报"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onOpenWorkLog(presentation.runId)}>
                查看本轮工作记录
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {error ? "汇报读取失败：" + error :
              loading ? "正在读取最近一轮的结论和成果。" :
                "智能体运行后，会在这里展示结论、成果、依据和下一步。"}
          </p>
        )}
      </section>

      <Dialog open={open && Boolean(presentation)} onOpenChange={closePresentation}>
        <DialogContent className="flex h-[90vh] !w-[min(92vw,1000px)] !max-w-[1000px] flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
            <DialogTitle className="text-base">工作汇报 · {presentation?.title ?? ""}</DialogTitle>
            <DialogDescription>
              {presentation?.presentedAt ? formatDateTime(presentation.presentedAt) : "时间待核实"}
              {presentation ? " · " + workPresentationStatusLabel(presentation.status) : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
            {presentation ? (
              <div className="mx-auto max-w-3xl space-y-7">
                <section>
                  <h3 className="text-sm font-semibold text-foreground">本轮结论</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-foreground">
                    {presentation.summary || "本轮尚无可展示的结论。"}
                  </p>
                </section>
                {presentation.artifacts.length ? (
                  <section>
                    <h3 className="text-sm font-semibold text-foreground">产物与附件</h3>
                    {selectedPreviewArtifact && previewKind ? (
                      <div aria-label="附件预览" className="mt-3 rounded-md border border-violet-200 bg-violet-50/30 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="break-all text-sm font-medium text-foreground">
                            预览 · {selectedPreviewArtifact.label}
                          </h4>
                          <div className="flex items-center gap-2 text-xs">
                            {previewHref ? (
                              <a href={previewHref} target="_blank" rel="noopener noreferrer"
                                className="text-violet-700 underline underline-offset-2">
                                原文件
                              </a>
                            ) : null}
                            <button type="button" onClick={() => setPreviewSelection(null)}
                              className="text-muted-foreground underline underline-offset-2">
                              关闭预览
                            </button>
                          </div>
                        </div>
                        {!previewResult || previewResult.key !== previewKey ||
                          previewResult.status === "loading" ? (
                          <output className="mt-3 block text-sm text-muted-foreground">
                            正在读取附件并核对文件完整性…
                          </output>
                        ) : previewResult.status === "error" ? (
                          <div className="mt-3 text-sm text-rose-800" role="alert">
                            <p>{previewResult.error ?? "附件预览失败。"}</p>
                            <button type="button" className="mt-2 underline underline-offset-2"
                              onClick={() => {
                                setPreviewResult({ key: previewKey, status: "loading" });
                                setPreviewNonce((nonce) => nonce + 1);
                              }}>
                              重试
                            </button>
                          </div>
                        ) : previewKind === "markdown" ? (
                          <article className="mt-3 max-h-[50vh] overflow-auto rounded border border-border bg-white p-3 text-sm leading-7 text-foreground [&_table]:min-w-full [&_td]:min-w-28 [&_td]:align-top [&_th]:min-w-28 [&_th]:align-top">
                            <Markdown>{previewResult.text ?? ""}</Markdown>
                          </article>
                        ) : (
                          <pre className="mt-3 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-white p-3 text-xs leading-6 text-foreground">
                            {previewResult.text ?? ""}
                          </pre>
                        )}
                        <p className="mt-2 text-xs text-muted-foreground">
                          仅预览 2 MiB 以内的文本附件；原文件由系统在读取时再次核验。
                        </p>
                      </div>
                    ) : null}
                    <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                      {presentation.artifacts.map((artifact) => {
                        const kind = workArtifactPreviewKind(artifact);
                        return (
                          <li key={artifact.id} className="rounded-md border border-border px-3 py-2">
                            {kind ? (
                              <button type="button" onClick={() => openArtifactPreview(artifact)}
                                className="break-all text-left text-sm font-medium text-violet-700 underline underline-offset-2">
                                预览 {artifact.label}
                              </button>
                            ) : artifact.href ? (
                              <a href={artifact.href} target="_blank" rel="noopener noreferrer"
                                className="break-all text-sm font-medium text-violet-700 underline underline-offset-2">
                                {artifact.label}
                              </a>
                            ) : (
                              <span className="break-all text-sm font-medium text-foreground">
                                {artifact.label} · 暂不可打开
                              </span>
                            )}
                            {artifact.mimeType ? (
                              <p className="mt-1 text-xs text-muted-foreground">{artifact.mimeType}</p>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
                <section>
                  <h3 className="text-sm font-semibold text-foreground">完整报告</h3>
                  <article className="mt-3 text-sm leading-7 text-foreground">
                    {presentation.reportMarkdown ? (
                      <Markdown>{presentation.reportMarkdown}</Markdown>
                    ) : (
                      <p className="text-muted-foreground">
                        本轮没有保存完整报告，可查看工作记录核对执行过程。
                      </p>
                    )}
                  </article>
                </section>
                {presentation.evidence.length ? (
                  <section>
                    <h3 className="text-sm font-semibold text-foreground">关键依据</h3>
                    <ul className="mt-2 space-y-1 text-sm leading-6 text-foreground">
                      {presentation.evidence.map((item) => (
                        <li key={item.eventId}>
                          {item.label}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {formatDateTime(item.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {presentation.warnings.length ? (
                  <section>
                    <h3 className="text-sm font-semibold text-amber-900">限制与异常</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-amber-900">
                      {presentation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                    </ul>
                  </section>
                ) : null}
                {presentation.nextSteps.length ? (
                  <section>
                    <h3 className="text-sm font-semibold text-foreground">下一步</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-foreground">
                      {presentation.nextSteps.map((step, index) => <li key={index}>{step}</li>)}
                    </ul>
                  </section>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => {
                  setOpen(false);
                  onOpenWorkLog(presentation.runId);
                }}>
                  查看本轮工作记录
                </Button>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
