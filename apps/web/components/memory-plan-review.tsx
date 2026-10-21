"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { streamNativeAgentResponse } from "@/lib/ai/router/index";
import { getPiNativeModelConfig, useModelPreference } from "@/components/agent/model-selector";

type Proposal = { id: string; goal: string; steps: Array<{ id: string; description: string; status: string }>; notes?: string };
type Common = { plan: Proposal; taskId: string | null; workDir: string | null; historicalSources: string };
type Legacy = Common & { kind: "legacy_unverified"; legacyVersion: string; requiresOwnerRebase: true };
type Current = Common & { kind: "memory_plan"; version: string; revision: number; state: "ready" | "approved" | "revoked";
  available: boolean; sourceCount: number; sourceReceiptIds: string[]; origin: string; expiresAt: string;
  execution?: { state: string; startedAt?: string | null; finishedAt?: string | null } | null };
type View = Legacy | Current;
type Pending = { action: "rebase" | "revoke"; body: Record<string, unknown> };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const version = /^mplan1:[a-f0-9]{64}$/;
const button = "rounded border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50";
const executionNames: Record<string, string> = { running: "运行中", completed: "执行流已结束", failed: "执行失败", interrupted: "执行中断", not_started: "尚未开始" };
const failures: Record<string, string> = {
  memory_plan_unavailable: "计划已过期、已撤销或当前账号无法读取。请生成新计划或核对原任务。",
  memory_plan_revision_conflict: "计划版本或操作已变化。请刷新状态并重新审核当前版本。",
  memory_plan_invalid_request: "恢复输入或来源回执格式无效，请核对后重试。",
  memory_plan_dispatch_required: "执行保护尚未就绪，未将计划标记为已执行。",
  memory_plan_execution_already_started: "该版本已开始执行，不能再次启动。请查看运行结果，必要时创建新计划。",
};
async function responseBody(response: Response): Promise<unknown> {
  const body = await response.json();
  if (!response.ok) throw new Error(failures[body?.code] ?? `操作结果尚未确认（${response.status}），请重试读取当前状态。`);
  return body;
}
function isView(body: unknown): body is View {
  if (!body || typeof body !== "object" || !("plan" in body) || !body.plan || typeof body.plan !== "object") return false;
  if (!("goal" in body.plan) || typeof body.plan.goal !== "string" || !("steps" in body.plan) || !Array.isArray(body.plan.steps)) return false;
  if (!body.plan.steps.every(step => step && typeof step.id === "string" && typeof step.description === "string")) return false;
  return "kind" in body && (body.kind === "legacy_unverified" && "legacyVersion" in body && typeof body.legacyVersion === "string"
    || body.kind === "memory_plan" && "version" in body && typeof body.version === "string" && version.test(body.version));
}
export function MemoryPlanReview({ ownerId, planId }: { ownerId: string | null; planId: string }) {
  return <OwnerPlanReview key={JSON.stringify([ownerId, planId])} ownerId={ownerId} planId={planId} />;
}
function OwnerPlanReview({ ownerId, planId }: { ownerId: string | null; planId: string }) {
  const [selectedModel] = useModelPreference();
  const [view, setView] = useState<View | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [input, setInput] = useState(""), [receipts, setReceipts] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null), [notice, setNotice] = useState("");
  const [run, setRun] = useState<"idle" | "running" | "ended" | "failed" | "stopped">("idle"), [result, setResult] = useState("");
  const generation = useRef(0), request = useRef<AbortController | null>(null), abortRun = useRef<(() => void) | null>(null);
  const commands = useRef(new Map<string, string>()), runFailed = useRef(false), live = useRef(true);
  const endpoint = `/api/memory/plans/${encodeURIComponent(planId)}`;
  const sourceIds = [...new Set(receipts.split(/[\s,，]+/).filter(Boolean))];
  const validSources = sourceIds.length <= 62 && sourceIds.every(id => uuid.test(id));
  function commandId(key: string) { let id = commands.current.get(key); if (!id) { id = crypto.randomUUID(); commands.current.set(key, id); } return id; }
  async function reload() {
    request.current?.abort(); const controller = new AbortController(), attempt = ++generation.current; request.current = controller;
    setView(null); setBusy(true); setError("");
    try {
      const body = await responseBody(await fetch(endpoint, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) }));
      if (!live.current || generation.current !== attempt) return;
      if (!isView(body)) throw new Error("未取得可审核的计划版本，请重试。");
      setView(body);
    } catch (failure) { if (!controller.signal.aborted && live.current && generation.current === attempt) setError(failure instanceof Error ? failure.message : "计划尚未读取。"); }
    finally { if (live.current && generation.current === attempt) setBusy(false); }
  }
  useEffect(() => {
    live.current = true; if (ownerId) void reload();
    return () => { live.current = false; generation.current++; request.current?.abort(); abortRun.current?.(); };
    // Owner and plan changes remount this component and close all old callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function submit(command: Pending) {
    request.current?.abort(); const controller = new AbortController(), attempt = ++generation.current; request.current = controller;
    setBusy(true); setError(""); setNotice(""); setPending(command);
    try {
      await responseBody(await fetch(`${endpoint}/${command.action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command.body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) }));
      if (!live.current || generation.current !== attempt) return;
      setPending(null); setConfirmed(false); setNotice(command.action === "rebase" ? "恢复请求已保存。历史来源仍未补证；请审核当前版本再决定是否执行。" : "撤销请求已保存，请核对当前状态。已发出的动作不能由撤销计划撤回。");
      await reload();
    } catch (failure) {
      if (!controller.signal.aborted && live.current && generation.current === attempt) { setView(null); setError(failure instanceof Error ? failure.message : "操作结果尚未确认。"); setBusy(false); }
    }
  }
  function rebase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (view?.kind !== "legacy_unverified" || !confirmed || !input.trim() || !validSources || busy) return;
    const body = { expectedLegacyVersion: view.legacyVersion, inputPrompt: input.trim(), sourceReceiptIds: sourceIds, confirmed: true };
    void submit({ action: "rebase", body: { ...body, commandId: commandId(JSON.stringify(["rebase", body])) } });
  }
  function revoke() {
    if (view?.kind !== "memory_plan" || view.state === "revoked" || busy || run === "running") return;
    void submit({ action: "revoke", body: { expectedVersion: view.version, commandId: commandId(JSON.stringify(["revoke", view.version])) } });
  }
  async function execute() {
    if (view?.kind !== "memory_plan" || view.state !== "ready" || !view.available || !view.taskId || !uuid.test(view.taskId) || busy || run === "running") return;
    const current = view, attempt = ++generation.current;
    runFailed.current = false; setRun("running"); setResult(""); setError(""); setNotice("");
    const failed = (message: string) => { if (!live.current || generation.current !== attempt) return; runFailed.current = true; setRun("failed"); setView(null); setError(message || "执行未完成，请重新读取计划状态和任务运行记录。"); };
    try {
      const abort = await streamNativeAgentResponse(`Execute approved plan ${planId}`, {
        provider: "pi", phase: "execute", planId, planVersion: current.version,
        planCommandId: commandId(JSON.stringify(["execute", current.version])), chatId: current.taskId!, taskId: current.taskId!,
        ...(current.workDir !== null ? { workDir: current.workDir } : {}), modelConfig: getPiNativeModelConfig(selectedModel),
        onAbortFnReady: abort => { if (live.current && generation.current === attempt) abortRun.current = abort; else abort(); },
        onUpdate: event => {
          if (!live.current || generation.current !== attempt) return;
          if (event?.type === "error") failed(typeof event.message === "string" ? event.message : "执行发生错误，未标记为完成。");
          else if (event?.type === "text" && typeof event.content === "string") setResult(previous => previous + event.content);
        },
        onError: failure => failed(failure.message),
        onDone: () => { if (!live.current || generation.current !== attempt || runFailed.current) return; abortRun.current = null; setRun("ended"); void reload(); },
      });
      if (!live.current || generation.current !== attempt) abort(); else if (!runFailed.current) abortRun.current = abort;
    } catch (failure) { failed(failure instanceof Error ? failure.message : "执行尚未确认。"); }
  }
  function stop() { generation.current++; runFailed.current = true; abortRun.current?.(); abortRun.current = null; setRun("stopped"); setView(null); setError("已请求停止本页执行流。已发出的动作可能仍在完成，请核对任务记录后再决定下一步。"); }
  async function copyVersion() {
    if (!view) return;
    try { await navigator.clipboard.writeText(view.kind === "memory_plan" ? view.version : view.legacyVersion); if (live.current) setNotice("当前版本已复制。"); }
    catch { if (live.current) setError("剪贴板不可用，请从版本栏手动复制。"); }
  }
  return <main className="h-full overflow-auto bg-background p-5 lg:p-8"><section aria-label="计划审核与恢复" className="mx-auto grid max-w-4xl gap-5">
    <header><a href="/memory" className="text-sm underline">返回记忆</a><h1 className="mt-3 text-xl font-semibold">计划审核与恢复</h1><p className="mt-2 text-sm text-muted-foreground">计划是待审核的控制提案。保存、批准和实际动作结果分别核对。</p></header>
    {!ownerId ? <p role="alert">请先登录后查看自己的计划。</p> : <>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || run === "running"} onClick={() => void reload()}>刷新计划状态</button>
        <button type="button" className={button} disabled={!view || busy || run === "running"} onClick={() => void copyVersion()}>复制当前版本</button></div>
      {busy ? <p role="status">正在核对计划和回执…</p> : null}{error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      {pending && !busy ? <button type="button" className={button + " w-fit"} onClick={() => void submit(pending)}>重试原操作</button> : null}
      {view ? <article className="grid min-w-0 gap-4 rounded-lg border bg-card p-5">
        <div><h2 className="font-semibold">{view.plan.goal}</h2><p className="mt-2 break-all text-xs text-muted-foreground">计划 ID：{planId}</p></div>
        <dl className="grid gap-2 text-sm"><div><dt className="inline font-medium">当前状态：</dt><dd className="inline">{view.kind === "legacy_unverified" ? "旧计划，来源待核对" : !view.available && view.state !== "revoked" ? "已过期或不可执行" : ({ ready: "待主人批准", approved: "已批准，结果须查看运行记录", revoked: "已撤销" }[view.state])}</dd></div>
          <div><dt className="inline font-medium">修订 / 来源数：</dt><dd className="inline">{view.kind === "legacy_unverified" ? "历史修订与来源数未知" : `${view.revision} / ${view.sourceCount} 条绑定来源回执`}</dd></div>
          <div><dt className="font-medium">当前版本：</dt><dd className="break-all font-mono text-xs" aria-label="当前计划版本">{view.kind === "memory_plan" ? view.version : view.legacyVersion}</dd></div>
          {view.kind === "memory_plan" ? <div><dt className="inline font-medium">有效期：</dt><dd className="inline">{new Date(view.expiresAt).toLocaleString()}</dd></div> : null}</dl>
        {view.kind === "memory_plan" && view.execution ? <div aria-label="已保存的计划执行状态" className="grid gap-1 rounded bg-muted p-3 text-sm">
          <p>执行记录：{executionNames[view.execution.state] ?? "状态待核对"}</p>
          {view.execution.startedAt ? <p>开始：{new Date(view.execution.startedAt).toLocaleString()}</p> : null}
          {view.execution.finishedAt ? <p>结束：{new Date(view.execution.finishedAt).toLocaleString()}</p> : null}
          {view.state === "approved" ? <p>已批准的版本不能再次启动；如需继续，请审核并生成新计划。</p> : null}
        </div> : null}
        {view.historicalSources !== "captured_at_generation" ? <p className="rounded border p-3 text-sm">历史来源未知，尚未补证。恢复只登记你现在审核的提案、新输入及当前来源回执，不能把旧断言当作已验证事实。</p> : null}
        <ol className="list-decimal space-y-2 pl-5 text-sm">{view.plan.steps.map((step, index) => <li key={`${step.id}:${index}`} className="whitespace-pre-wrap break-words">{step.description}</li>)}</ol>
        {view.plan.notes ? <p className="whitespace-pre-wrap break-words text-sm">{view.plan.notes}</p> : null}
        {view.kind === "legacy_unverified" ? <form onSubmit={rebase} className="grid gap-3 border-t pt-4">
          <label className="grid gap-1 text-sm">当前输入<textarea aria-label="当前输入" className="min-h-28 rounded border bg-background p-2" value={input} maxLength={262144} disabled={busy} onChange={event => { setInput(event.target.value); setPending(null); }} required /></label>
          <label className="grid gap-1 text-sm">当前来源回执 ID<textarea aria-label="当前来源回执 ID" className="min-h-20 rounded border bg-background p-2 font-mono text-xs" value={receipts} disabled={busy} onChange={event => { setReceipts(event.target.value); setPending(null); }} placeholder="每行一个 UUID，也可用逗号分隔" /></label>
          <p className="text-xs text-muted-foreground">在<a href="/memory" className="underline">来源精确读取</a>取得当前回执。可留空，届时仅使用新输入，不补证历史事实。最多 62 条。</p>
          {!validSources ? <p role="alert" className="text-sm text-destructive">来源回执须为 UUID，且最多 62 条。</p> : null}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我已审核这份提案，理解历史来源仍未补证</label>
          <button type="submit" className={button + " w-fit"} disabled={busy || !confirmed || !input.trim() || !validSources}>确认恢复为待批准计划</button>
        </form> : <div className="grid gap-3 border-t pt-4">
          {view.state === "ready" ? <button type="button" className={button + " w-fit"} disabled={busy || run === "running" || !view.available || !view.taskId} onClick={() => void execute()}>批准当前版本并执行</button> : null}
          {!view.taskId ? <p className="text-sm text-muted-foreground">该计划没有可绑定的原任务，不能从此页执行。请回聊天创建新计划。</p> : <a href={`/?page=chat&chatId=${encodeURIComponent(view.taskId)}`} className="w-fit text-sm underline">查看原聊天与任务记录</a>}
          {view.state !== "revoked" ? <button type="button" className={button + " w-fit"} disabled={busy || run === "running"} onClick={revoke}>撤销当前版本</button> : null}
          <p className="text-xs text-muted-foreground">回执记录读取时的版本；批准和每次模型出站前会重新核验。页面展示回执不表示来源现在仍然有效。</p>
          <details className="min-w-0 text-xs"><summary className="cursor-pointer">当前来源回执</summary><pre className="whitespace-pre-wrap break-all">{view.sourceReceiptIds.join("\n")}</pre></details>
        </div>}
      </article> : null}
      {run !== "idle" ? <section aria-label="本页计划执行" className="grid gap-3 rounded border p-4"><p role="status">{run === "running" ? "正在执行当前批准版本…" : run === "ended" ? "本次执行流已结束；具体动作结果请核对正文和任务记录。" : run === "stopped" ? "执行流已请求停止，结果尚未确认。" : "执行未完成，没有标记为成功。"}</p>
        {run === "running" ? <button type="button" className={button + " w-fit"} onClick={stop}>停止本页执行流</button> : null}
        {result ? <pre className="whitespace-pre-wrap break-words text-sm" aria-label="计划执行结果">{result}</pre> : null}
      </section> : null}
    </>}
  </section></main>;
}
