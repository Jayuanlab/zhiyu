"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { NativeConversationSourceMessage } from "@/lib/ai/chat/native-conversation";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const activeStatuses = new Set(["queued", "running", "cancel_requested"]);
const repeatableStatuses = new Set(["completed", "failed", "interrupted", "cancelled"]);
const statusLabels: Record<string, string> = {
  queued: "等待执行", running: "正在处理", completed: "已完成", failed: "处理失败",
  interrupted: "已中断", cancelled: "已停止", cancel_requested: "正在停止", needs_review: "待核对", paused: "已暂停",
};
const errors: Record<string, string> = {
  workshop_run_paused: "智能体已暂停，请到车间核对工作状态。本次没有排队，也没有恢复周期任务。",
  workshop_run_archived: "智能体已归档，本次没有排队。",
  workshop_run_busy: "智能体正在运行或有结果待核对，请先到车间核对。",
  not_found: "本轮或智能体已无法读取，请到车间核对；不会自动创建另一轮。",
  workshop_run_not_found: "本轮或智能体已无法读取，请到车间核对；不会自动创建另一轮。",
  workshop_run_message_stale: "聊天中的运行请求已变化，请刷新对话后核对。",
  workshop_run_version_changed: "智能体配置已变化，请刷新对话后核对。",
  Unauthorized: "登录状态已变化，请重新登录后核对本轮。",
};
export type ChatWorkshopTarget = { id: string; name: string; status: string };
type RunReceipt = Record<string, unknown> & { run: Record<string, unknown> & { id: string; status: string } };
type RunPointer = { requestId: string; runId?: string; sourceRunId?: string };
type Props = { chatId: string; workshop: ChatWorkshopTarget; initialReceipt?: unknown; disabled?: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function output(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    if (value.length > 256_000) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  const body = record(value);
  return body?.status === "success" ? record(body.result) : body;
}
function target(value: unknown): ChatWorkshopTarget | null {
  const item = record(value);
  return typeof item?.id === "string" && UUID.test(item.id) ? {
    id: item.id, name: typeof item.name === "string" ? item.name : "当前智能体",
    status: typeof item.status === "string" ? item.status : "unknown",
  } : null;
}
function runReceipt(value: unknown, workshopId: string, runId?: string): RunReceipt | null {
  const body = output(value), run = record(body?.run), work = record(body?.workshop);
  if (body?.ok !== true || !["run_accepted", "run_observed"].includes(String(body.status)) ||
    typeof run?.id !== "string" || !UUID.test(run.id) || (runId && run.id !== runId) ||
    typeof run.status !== "string" || !Object.hasOwn(statusLabels, run.status) ||
    run.workshopId !== workshopId || (body.workshopId !== undefined && body.workshopId !== workshopId) ||
    (work && work.id !== workshopId)) return null;
  return body as RunReceipt;
}
function pendingRunId(value: unknown, workshopId: string): string | null {
  const body = output(value);
  return body?.ok === false && body.status === "run_readback_pending" && body.workshopId === workshopId &&
    typeof body.runId === "string" && UUID.test(body.runId) ? body.runId : null;
}

/** Select only an actual host tool result in this chat, never prose or a draft. */
export function findLatestChatWorkshopRunSource(messages: readonly NativeConversationSourceMessage[], chatId: string) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || (message.chatId && message.chatId !== chatId)) continue;
    for (let partIndex = (message.parts?.length ?? 0) - 1; partIndex >= 0; partIndex--) {
      const part = record(message.parts![partIndex]);
      if (part?.type !== "tool-native" || !["applyWorkshopManifestYaml", "inspectWorkshopAgent", "runWorkshopOnce"].includes(String(part.toolName))) continue;
      const body = output(part.toolOutput);
      const pending = part.toolName === "runWorkshopOnce" && typeof body?.workshopId === "string" && pendingRunId(body, body.workshopId);
      if ((part.status !== "completed" || part.isError === true) && !(pending && part.status === "error")) return null;
      let workshop: ChatWorkshopTarget | null = null;
      if (part.toolName === "applyWorkshopManifestYaml" && body?.ok === true && body.status === "created_verified") workshop = target(body.workshop);
      if (part.toolName === "inspectWorkshopAgent" && body?.ok === true) workshop = target(body.target);
      if (part.toolName === "runWorkshopOnce") workshop = target(body?.workshop);
      if (pending && !workshop) workshop = target({ id: body?.workshopId });
      if (!workshop) return null;
      const receipt = part.toolName === "runWorkshopOnce" ? runReceipt(body, workshop.id) : null;
      if (part.toolName === "runWorkshopOnce" && !receipt && !pending) return null;
      return { assistantMessageId: message.id, toolUseId: typeof part.toolUseId === "string" ? part.toolUseId : null, workshop, receipt, initialReceipt: pending ? body : receipt };
    }
  }
  return null;
}

function pointer(value: unknown): RunPointer | null {
  const item = record(value);
  if (typeof item?.requestId !== "string" || !UUID.test(item.requestId) ||
    (item.runId !== undefined && (typeof item.runId !== "string" || !UUID.test(item.runId))) ||
    (item.sourceRunId !== undefined && (typeof item.sourceRunId !== "string" || !UUID.test(item.sourceRunId)))) return null;
  return { requestId: item.requestId, ...(typeof item.runId === "string" ? { runId: item.runId } : {}),
    ...(typeof item.sourceRunId === "string" ? { sourceRunId: item.sourceRunId } : {}) };
}
function errorText(value: unknown) {
  const body = record(value), code = typeof body?.error === "string" ? body.error : "";
  return errors[code] ?? (typeof body?.message === "string" && /[\u3400-\u9fff]/.test(body.message)
    ? body.message : "本次结果尚未确认，请核对同一个请求。");
}

/** Browser storage holds IDs only. Every status and report comes from owner-scoped observations. */
export function WorkshopRunReceipt({ chatId, workshop, initialReceipt, disabled = false }: Props) {
  const initialSourceRunId = runReceipt(initialReceipt, workshop.id)?.run.id ?? pendingRunId(initialReceipt, workshop.id);
  const [ignoreSeed, setIgnoreSeed] = useState(false);
  const seed = ignoreSeed ? null : runReceipt(initialReceipt, workshop.id);
  const [receipt, setReceipt] = useState<RunReceipt | null>(seed);
  const receiptRef = useRef(receipt);
  const [saved, setSaved] = useState<RunPointer | null>(null);
  const savedRef = useRef<RunPointer | null>(null);
  const [ready, setReady] = useState(false), [sending, setSending] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null), [readError, setReadError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const key = `zhiyu.chat-workshop-run.v1.${chatId}.${workshop.id}`;
  const runId = seed?.run.id ?? (!ignoreSeed ? pendingRunId(initialReceipt, workshop.id) : null) ?? saved?.runId ?? receipt?.run.id;
  const currentWorkStatus = target(receipt?.workshop)?.status ?? workshop.status;
  const canRun = currentWorkStatus === "active" || currentWorkStatus === "unknown";
  const href = `/workshop?workId=${encodeURIComponent(workshop.id)}&tab=run${runId ? `&runId=${encodeURIComponent(runId)}` : ""}`;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key), stored = raw ? pointer(JSON.parse(raw)) : null;
      if (raw && !stored) throw Error("invalid_pointer");
      // A newer Native run supersedes an older local pointer. A rerun made from
      // this same Native source must recover the new request, even after reload.
      const belongs = !initialSourceRunId || stored?.sourceRunId === initialSourceRunId || stored?.runId === initialSourceRunId;
      const current = belongs ? stored : null;
      savedRef.current = current; setSaved(current);
      if (current && initialSourceRunId && current.runId !== initialSourceRunId) {
        setIgnoreSeed(true); receiptRef.current = null; setReceipt(null);
      }
      setReady(true);
    } catch { setStorageError("无法读取本次运行指针，请保留浏览器数据并到车间核对。"); }
  }, [key, initialSourceRunId]);

  useEffect(() => {
    if (!runId) return;
    let stopped = false, sequence = 0, failures = 0, terminalRead = false;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const hidden = () => document.visibilityState === "hidden";
    async function read() {
      if (stopped || hidden()) return;
      const currentSequence = ++sequence; controller?.abort();
      controller = new AbortController(); const requestController = controller;
      const timeout = setTimeout(() => requestController.abort(), 15_000);
      setReading(true);
      try {
        const response = await fetch(`/api/workshops/${encodeURIComponent(workshop.id)}/runs/${encodeURIComponent(runId!)}`, {
          cache: "no-store", credentials: "same-origin", signal: requestController.signal,
        });
        const body: unknown = await response.json(), current = runReceipt(body, workshop.id, runId);
        if (!response.ok || !current) { terminalRead = response.status === 404 || response.status === 401; throw Error(response.ok ? "本轮状态响应不完整，请到车间核对。" : errorText(body)); }
        if (!stopped && sequence === currentSequence && !requestController.signal.aborted) { failures = 0; receiptRef.current = current; setReceipt(current); setReadError(null); }
      } catch (failure) {
        if (!stopped && sequence === currentSequence && !hidden()) { failures++; setReadError(failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message)
          ? failure.message : "本轮状态暂时无法读取，保留最近一次核对结果。"); }
      } finally {
        clearTimeout(timeout);
        if (!stopped && sequence === currentSequence) {
          setReading(false);
          if (!terminalRead && failures < 3 && !hidden() && (!receiptRef.current || activeStatuses.has(receiptRef.current.run.status))) timer = setTimeout(read, 3000);
        }
      }
    }
    function visibility() {
      if (timer) clearTimeout(timer);
      if (hidden()) { sequence++; controller?.abort(); setReading(false); }
      else void read();
    }
    void read(); document.addEventListener("visibilitychange", visibility);
    return () => { stopped = true; controller?.abort(); if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [chatId, workshop.id, runId, revision]);

  function persist(value: RunPointer) {
    window.localStorage.setItem(key, JSON.stringify(value)); savedRef.current = value; setSaved(value);
  }
  async function start(again = false) {
    if (inFlight.current || !ready || disabled || !canRun || (runId && !again) ||
      (again && (!receipt || !repeatableStatuses.has(receipt.run.status) || reading))) return;
    inFlight.current = true; setSending(true); setError(null);
    try {
      const fresh = () => ({ requestId: crypto.randomUUID(), ...(initialSourceRunId ? { sourceRunId: initialSourceRunId } : {}) });
      const current = again ? fresh() : savedRef.current ?? fresh();
      try { persist(current); } catch { throw Error("无法保存本次请求编号，本次尚未提交，请到车间核对。"); }
      if (again) { setIgnoreSeed(true); receiptRef.current = null; setReceipt(null); setReadError(null); }
      const response = await fetch("/api/workshops/run-from-chat", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ chatId, workshopId: workshop.id, requestId: current.requestId }),
      });
      const body: unknown = await response.json(), accepted = runReceipt(body, workshop.id), pending = record(body);
      const pendingId = response.ok && pending?.ok === false && pending.status === "run_readback_pending" &&
        pending.workshopId === workshop.id && typeof pending.runId === "string" && UUID.test(pending.runId) ? pending.runId : null;
      if (!response.ok || (!accepted && !pendingId)) throw Error(response.ok ? "运行回执不完整，重试会核对同一个请求。" : errorText(body));
      const acceptedPointer = { ...current, runId: accepted?.run.id ?? pendingId! };
      try { persist(acceptedPointer); } catch {
        savedRef.current = acceptedPointer; setSaved(acceptedPointer);
        setStorageError("运行已受理，但浏览器未保存运行指针。请保留请求并到车间核对。");
      }
      if (accepted) { receiptRef.current = accepted; setReceipt(accepted); }
    } catch (failure) {
      setError(failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message) ? failure.message : "提交结果暂未确认，重试会核对同一个请求。");
    } finally { inFlight.current = false; setSending(false); }
  }

  const presentation = record(receipt?.presentation);
  const summary = presentation && presentation.runId === runId && typeof presentation.summary === "string" && presentation.summary ? presentation.summary
    : typeof receipt?.run.outputSummary === "string" ? receipt.run.outputSummary : null;
  const warnings = [...new Set([...(Array.isArray(receipt?.warnings) ? receipt.warnings : []),
    ...(presentation && presentation.runId === runId && Array.isArray(presentation.warnings) ? presentation.warnings : [])]
    .filter((value): value is string => typeof value === "string"))].slice(0, 8);
  const observedAt = typeof receipt?.observedAt === "string" && !Number.isNaN(Date.parse(receipt.observedAt)) ? receipt.observedAt : null;
  const runError = typeof receipt?.run.error === "string" ? receipt.run.error : null;
  return <section aria-label="智能体单次运行" aria-busy={sending || reading} className="mt-2 space-y-2 rounded-md border border-border px-3 py-3 text-sm">
    <p className="font-medium">运行一次 · {workshop.name}</p>
    <p className="text-xs text-muted-foreground">只提交这一轮任务，周期任务保持当前设置。</p>
    {runId ? <>
      <p role="status">{receipt ? statusLabels[receipt.run.status] : "本轮已提交，状态待核对"}{reading ? " · 正在核对" : ""}</p>
      {observedAt ? <p className="text-xs text-muted-foreground">最近核对：{new Date(observedAt).toLocaleString("zh-CN", { hour12: false })}</p> : null}
      {summary ? <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words">{summary.slice(0, 4000)}{summary.length > 4000 ? "\n汇报较长，完整内容请查看本轮记录。" : ""}</p> : null}
      {!summary && receipt?.run.status === "completed" ? <p className="text-xs text-muted-foreground">本轮已完成，未保存可展示汇报，请查看本轮记录核对。</p> : null}
      {warnings.map((warning, index) => <p key={index} className="break-words text-xs text-amber-700">{warning.slice(0, 1000)}</p>)}
      {runError ? <p className="break-words text-xs text-destructive">{runError}</p> : null}
      {receipt?.run.status === "needs_review" ? <p className="text-xs text-amber-700">本轮结果需要主人核对，请到车间接管；不会自动重跑。</p> : null}
      <Button type="button" size="sm" variant="outline" disabled={reading} onClick={() => setRevision(value => value + 1)}>刷新本轮状态</Button>
      {receipt && repeatableStatuses.has(receipt.run.status) && canRun ? <Button type="button" size="sm" variant="outline"
        disabled={!ready || sending || reading || disabled || Boolean(storageError)} onClick={() => { void start(true); }}>再运行一次</Button> : null}
    </> : canRun ? <Button type="button" size="sm" variant="outline" disabled={!ready || sending || disabled || Boolean(storageError)} onClick={() => { void start(); }}>
      {sending ? "正在提交…" : saved ? "核对本次提交" : "运行一次"}
    </Button> : <p role="status">{currentWorkStatus === "paused" ? "智能体已暂停，本次没有排队，也没有恢复周期任务。" : "当前智能体不可运行，请到车间核对状态。"}</p>}
    <a className="inline-block underline underline-offset-2" href={href}>{runId ? "查看本轮 / 到车间接管" : "查看智能体"}</a>
    {storageError || error || readError ? <p role="alert" className="break-words text-xs text-destructive">{storageError ?? error ?? readError}</p> : null}
  </section>;
}
