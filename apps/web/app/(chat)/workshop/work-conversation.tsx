"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import { Badge, Button, Textarea } from "@openzhiyu/ui";
import type { WorkConversationResponse, WorkConversationTurn } from "@/lib/workshops/work-conversation";
import { workPresentationErrorText } from "@/lib/workshops/work-presentation";
import { WorkPresentationArea } from "./work-presentation-area";

type Props = {
  workId: string;
  workName: string;
  workStatus: string;
  onOpenWorkLog: (runId: string | null) => void;
};
type PendingTurn = { commandId: string; content: string; parentRunId: string | null };
type PendingCancel = { commandId: string; runId: string };
type SavedDraft = {
  version: 1;
  content: string;
  parentRunId?: string | null;
  pending: PendingTurn | null;
  cancellation: PendingCancel | null;
};

const ACTIVE_STATUSES = new Set(["queued", "running", "cancel_requested"]);
const STATUS_LABELS: Record<string, string> = {
  queued: "等待执行", running: "正在处理", completed: "已完成", failed: "处理失败",
  interrupted: "已中断", cancelled: "已停止", cancel_requested: "正在停止", needs_review: "待核对",
};
const ERROR_LABELS: Record<string, string> = {
  invalid_command: "任务内容或提交信息无效，请检查后重新发送。",
  not_found: "智能体或接续的任务不存在，请刷新页面核对。",
  target_busy: "智能体当前无法接收此任务，请核对工作状态后重试。",
  actor_changed: "登录身份已变化，请刷新页面后核对原任务。",
  payload_conflict: "本次请求与已保存的任务不一致，请查看工作记录核对。",
  version_conflict: "工作状态刚刚变化，请重新发送这次任务。",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFINITE_REJECTIONS = new Set(["invalid_command", "not_found", "target_busy", "version_conflict"]);

function definitelyRejected(status: number, code: string) {
  return [400, 401, 403, 404].includes(status) || (status === 409 && DEFINITE_REJECTIONS.has(code));
}

function isPendingTurn(value: unknown): value is PendingTurn {
  if (!value || typeof value !== "object") return false;
  const item = value as PendingTurn;
  return UUID.test(item.commandId) && typeof item.content === "string" &&
    item.content.trim().length > 0 && item.content.length <= 12000 &&
    (item.parentRunId === null || UUID.test(item.parentRunId));
}

function readDraft(key: string): SavedDraft {
  const raw = window.sessionStorage.getItem(key);
  if (!raw) return { version: 1, content: "", pending: null, cancellation: null };
  const value = JSON.parse(raw) as SavedDraft;
  if (value.version !== 1 || typeof value.content !== "string" || value.content.length > 12000 ||
    (value.parentRunId !== undefined && value.parentRunId !== null && !UUID.test(value.parentRunId)) ||
    (value.pending !== null && !isPendingTurn(value.pending)) ||
    (value.cancellation !== null && (!value.cancellation || !UUID.test(value.cancellation.commandId) || !UUID.test(value.cancellation.runId)))) {
    throw new Error("上次对话草稿无法读取，请保留浏览器数据并核对工作记录。");
  }
  return value;
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待核实" : date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function responseError(payload: unknown, status: number) {
  const item = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const code = typeof item.code === "string" ? item.code : typeof item.error === "string" ? item.error : "";
  return { code, message: ERROR_LABELS[code] ?? (code || `请求失败（HTTP ${status}）。`) };
}

async function readConversation(url: string): Promise<WorkConversationResponse> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(responseError(payload, response.status).message);
  if (payload?.version !== 1 || !Array.isArray(payload.turns)) throw new Error("对话返回内容不完整。");
  return payload;
}

export function WorkConversation(props: Props) {
  const { data: session, status } = useSession();
  const actorId = session?.user?.id;
  if (!actorId) return (
    <section aria-label="智能体对话" className="border border-border bg-white p-4">
      <h2 className="text-base font-semibold">对话 · {props.workName}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{status === "loading" ? "正在确认当前身份…" : "请登录后向当前智能体交代任务。"}</p>
    </section>
  );
  return <WorkConversationSession key={`${actorId}:${props.workId}`} {...props} actorId={actorId} />;
}

function WorkConversationSession({ workId, workName, workStatus, onOpenWorkLog, actorId }: Props & { actorId: string }) {
  const storageKey = `zhiyu.work-conversation.v1.${actorId}.${workId}`;
  const url = `/api/workshops/${encodeURIComponent(workId)}/conversation`;
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const { data, error: readError, isLoading, isValidating, mutate } = useSWR<WorkConversationResponse>(
    [url, actorId], ([requestUrl]: [string, string]) => readConversation(requestUrl), {
      refreshInterval: (current) => current?.turns.some((turn) => ACTIVE_STATUSES.has(turn.status)) ? 3000 : 0,
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      errorRetryCount: 3,
      errorRetryInterval: 5000,
      onSuccess: () => setLastCheckedAt(new Date().toISOString()),
    },
  );
  const [draft, setDraft] = useState<SavedDraft>({ version: 1, content: "", pending: null, cancellation: null });
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const turns = data?.turns ?? [];
  const lastTurn = turns.at(-1);
  const parentRunId = draft.parentRunId === undefined ? lastTurn?.id ?? null : draft.parentRunId;
  const parent = parentRunId ? turns.find((turn) => turn.id === parentRunId) : null;
  const disabled = !ready || !data || workStatus !== "active" || Boolean(draft.pending);

  useEffect(() => {
    mountedRef.current = true;
    try {
      const saved = readDraft(storageKey);
      draftRef.current = saved;
      setDraft(saved);
      setReady(true);
    } catch (failure) {
      setStorageError(failure instanceof Error ? failure.message : "浏览器无法保存对话草稿，请检查浏览器存储。");
    }
    return () => { mountedRef.current = false; };
  }, [storageKey]);

  useEffect(() => {
    if (shouldFollowRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastTurn?.id, lastTurn?.updatedAt, lastTurn?.status]);

  function save(next: SavedDraft) {
    // Save before sending. An uncertain network result must retain its original UUID.
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { throw new Error("无法保存本次提交状态，请检查浏览器存储后重试。"); }
    draftRef.current = next;
    if (mountedRef.current) { setDraft(next); setStorageError(null); }
  }

  function edit(update: Partial<SavedDraft>) {
    try { save({ ...draftRef.current, ...update }); }
    catch (failure) { setStorageError(failure instanceof Error ? failure.message : String(failure)); }
  }

  function acceptTurn(turn: WorkConversationTurn, request: PendingTurn) {
    const current = draftRef.current;
    save({ ...current, pending: null, parentRunId: turn.id,
      content: current.content.trim() === request.content ? "" : current.content });
    if (!mountedRef.current) return;
    shouldFollowRef.current = true;
    setError(null);
    setNotice("任务已收到，处理进度和结果会回复在这里。");
    void mutate((previous) => ({ version: 1, workId, hasMore: previous?.hasMore ?? false,
      turns: [...(previous?.turns ?? []).filter((item) => item.id !== turn.id), turn]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    }), { revalidate: true });
  }

  async function sendTask() {
    if (busyRef.current || !ready || (!draftRef.current.pending && workStatus !== "active")) return;
    const pending = draftRef.current.pending;
    const content = draftRef.current.content.trim();
    if (!pending && !content) return;
    busyRef.current = true;
    setSending(true);
    setError(null);
    setNotice(null);
    let accepted = false;
    try {
      const request = pending ?? { commandId: crypto.randomUUID(), content, parentRunId };
      if (!pending) save({ ...draftRef.current, pending: request });
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Work-Actor": actorId,
          "Idempotency-Key": request.commandId }, body: JSON.stringify(request), signal: AbortSignal.timeout(25000),
      });
      const payload = await response.json();
      if (!response.ok) {
        const failure = responseError(payload, response.status);
        if (definitelyRejected(response.status, failure.code)) {
          save({ ...draftRef.current, pending: null });
        }
        throw new Error(failure.message);
      }
      if (payload?.turn?.commandId !== request.commandId || !UUID.test(payload?.turn?.id)) {
        throw new Error("提交响应不完整，请核对本次提交。");
      }
      accepted = true;
      acceptTurn(payload.turn, request);
    } catch (failure) {
      if (mountedRef.current) setError(accepted ? "任务已收到，但本地提交状态未能更新。请刷新后核对。" :
        failure instanceof Error ? failure.message : String(failure));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSending(false);
    }
  }

  async function cancelTask(runId: string) {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setCancelling(true);
    setError(null);
    setNotice(null);
    try {
      const cancellation = draftRef.current.cancellation ?? { commandId: crypto.randomUUID(), runId };
      save({ ...draftRef.current, cancellation });
      const response = await fetch(`/api/workshops/${encodeURIComponent(workId)}/runs/${cancellation.runId}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Work-Actor": actorId },
        body: JSON.stringify({ commandId: cancellation.commandId }), signal: AbortSignal.timeout(25000),
      });
      const payload = await response.json();
      if (!response.ok) {
        const failure = responseError(payload, response.status);
        if (definitelyRejected(response.status, failure.code)) {
          save({ ...draftRef.current, cancellation: null });
        }
        throw new Error(failure.message);
      }
      if (payload?.runId !== cancellation.runId || typeof payload.status !== "string") throw new Error("停止结果尚未确认，请核对停止请求。");
      save({ ...draftRef.current, cancellation: null });
      if (mountedRef.current) {
        setNotice(payload.status === "needs_review" ? "已停止继续执行，已有动作需要在工作记录中核对。" : "本次任务已停止。");
        await mutate();
      }
    } catch (failure) {
      if (mountedRef.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCancelling(false);
    }
  }

  return (
    <section aria-label="智能体对话" className="min-w-0 border border-border bg-white">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">对话 · {workName}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">在当前智能体空间里临时交代任务、追问进度和查看成果。</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button type="button" size="sm" variant="ghost" disabled={isValidating}
            onClick={() => void mutate().catch(() => {})}>刷新对话</Button>
          {lastCheckedAt ? <span className="text-[11px] text-muted-foreground">核对于 {timeLabel(lastCheckedAt)}</span> : null}
        </div>
      </header>
      {readError ? <div role="alert" className="px-4 py-3 text-sm text-rose-800">对话刷新失败{data ? "，以下为上次读取的状态" : ""}：{readError instanceof Error ? readError.message : String(readError)}。可点击“刷新对话”重新核对。</div> : null}
      <div ref={scrollRef} onScroll={() => {
        const element = scrollRef.current;
        if (element) shouldFollowRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }} className="max-h-[620px] min-h-24 space-y-6 overflow-y-auto px-4 py-5 sm:px-5">
        {isLoading ? <p role="status" className="text-sm text-muted-foreground">正在读取对话…</p> : null}
        {!isLoading && !readError && !turns.length ? <div className="py-3 text-sm leading-7 text-muted-foreground">
          <p>直接告诉 {workName} 这次要做什么。</p>
          <p>需要处理文件时，把执行机器上的文件绝对路径写在消息里；含空格的路径请用引号包起来。</p>
        </div> : null}
        {data?.hasMore ? <p className="text-center text-xs text-muted-foreground">这里展示最近 30 次交代；更早的执行可在工作记录中查看。</p> : null}
        {turns.map((turn) => {
          const active = ACTIVE_STATUSES.has(turn.status);
          const showReply = turn.presentation && (!active || turn.presentation.reportMarkdown || turn.presentation.artifacts.length > 0);
          const inputPaths = [...new Set([...turn.inputFiles, ...turn.receipts.map((receipt) => receipt.path)])];
          return (
            <article key={turn.id} aria-label={`临时任务 ${timeLabel(turn.createdAt)}`} className="min-w-0 space-y-3">
              <div className="ml-auto max-w-[92%] rounded-md border border-violet-100 bg-violet-50/60 px-4 py-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>你 · {turn.parentRunId ? "接着交代" : "新任务"}</span><time dateTime={turn.createdAt}>{timeLabel(turn.createdAt)}</time>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{turn.content}</p>
                {inputPaths.length ? <ul aria-label="本次文件使用状态" className="mt-3 space-y-2 border-t border-violet-100 pt-3 text-xs leading-5">
                  {inputPaths.map((path) => {
                    const receipt = turn.receipts.find((item) => item.path === path);
                    const label = receipt?.status === "used" ? "已用于本次处理" : receipt?.status === "staged" ? "已读取并暂存" :
                      receipt?.status === "failed" ? "读取或处理失败" : active ? "尚未确认读取" : "未确认读取";
                    return <li key={path} className="break-all">
                      <span className={receipt?.status === "failed" ? "text-rose-800" : "text-muted-foreground"}>{label} · </span>
                      <span>{path}</span>
                      {receipt?.detail ? <p className="mt-1 text-muted-foreground">{receipt.detail}</p> : null}
                    </li>;
      })}
                </ul> : null}
              </div>
              <div className="min-w-0 rounded-md border border-border px-4 py-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-foreground">{workName}</span>
                    <Badge variant="secondary" className={turn.status === "failed" || turn.status === "interrupted" ? "bg-rose-50 text-rose-800" : turn.status === "completed" ? "bg-emerald-50 text-emerald-800" : ""}>
                      {STATUS_LABELS[turn.status] ?? "状态待核实"}
                    </Badge>
                  </div>
                  {turn.status === "queued" || turn.status === "running" ? <Button type="button" size="sm" variant="ghost"
                    disabled={sending || cancelling || Boolean(draft.cancellation)} onClick={() => void cancelTask(turn.id)}>停止本次</Button> : null}
                </div>
                {showReply ? <WorkPresentationArea presentation={turn.presentation} loading={false} error={null}
                  mode="conversation" onOpenWorkLog={onOpenWorkLog} /> : <p className="text-sm leading-6 text-muted-foreground">
                  {turn.status === "queued" ? "已收到，等待当前智能体开始处理。" : turn.status === "running" ? "正在执行这次交代，文件回执和成果会在这里更新。" :
                    turn.status === "cancel_requested" ? "正在停止本次执行。" : "本次没有保存可展示的回复，可查看工作记录核对。"}
                </p>}
                {turn.error && !turn.presentation?.warnings.includes(workPresentationErrorText(turn.error)) ? <p role="status" className="mt-2 break-words text-xs leading-5 text-rose-800">{workPresentationErrorText(turn.error)}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="ghost" disabled={Boolean(draft.pending) || sending}
                    onClick={() => { edit({ parentRunId: turn.id }); inputRef.current?.focus(); }}>接着交代</Button>
                  {!showReply ? <Button type="button" size="sm" variant="ghost" onClick={() => onOpenWorkLog(turn.id)}>查看本轮工作记录</Button> : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <div className="border-t border-border p-4 sm:p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted-foreground">{parentRunId ? `接着${parent ? "这次任务" : "此前任务"}交代${parent ? ` · ${timeLabel(parent.createdAt)}` : ""}` : "交代一项新任务"}</p>
          <Button type="button" size="sm" variant="ghost" disabled={!ready || Boolean(draft.pending) || sending}
            onClick={() => { edit({ parentRunId: null }); inputRef.current?.focus(); }}>新任务</Button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void sendTask(); }}>
          <label htmlFor={`work-conversation-${workId}`} className="sr-only">交代临时任务</label>
          <Textarea ref={inputRef} id={`work-conversation-${workId}`} name="work-conversation" value={draft.content}
            disabled={disabled} maxLength={12000} className="min-h-28 resize-y text-sm leading-6"
            onChange={(event) => edit({ content: event.target.value })}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault(); void sendTask();
              }
            }} placeholder={`告诉 ${workName} 这次需要做什么，也可以直接写文件绝对路径。`} />
          <div className="mt-3 flex items-start justify-between gap-3">
            <p className="max-w-xl text-xs leading-5 text-muted-foreground">文件仅用于这次对话，不会自动加入常驻资料。对话和执行回执保留在这里。Ctrl / ⌘ + Enter 发送。</p>
            <Button type="submit" className="shrink-0" disabled={disabled || sending || cancelling || !draft.content.trim()}>{sending ? "正在发送…" : "发送任务"}</Button>
          </div>
        </form>
        {workStatus !== "active" ? <p role="status" className="mt-3 text-xs text-amber-800">当前智能体已暂停或归档；恢复运行后可发送新任务。</p> : null}
        {draft.pending ? <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-xs text-amber-900">
          <span>这次提交尚未确认，原消息已保留；核对时会复用同一次请求。</span>
          <Button type="button" size="sm" variant="outline" disabled={sending || cancelling} onClick={() => void sendTask()}>核对本次提交</Button>
        </div> : null}
        {draft.cancellation ? <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-xs text-amber-900">
          <span>停止结果尚未确认。</span><Button type="button" size="sm" variant="outline" disabled={sending || cancelling}
            onClick={() => void cancelTask(draft.cancellation!.runId)}>核对停止请求</Button>
        </div> : null}
        {storageError || error ? <p role="alert" className="mt-3 break-words text-sm leading-6 text-rose-800">{storageError ?? error}</p> : null}
        {notice ? <p role="status" className="mt-3 text-xs leading-5 text-muted-foreground">{notice}</p> : null}
      </div>
    </section>
  );
}
