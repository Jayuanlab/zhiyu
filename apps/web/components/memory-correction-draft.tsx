"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@openzhiyu/ui";
import { loadMemoryRevisionOwner, readPendingMemoryReview, readPendingMemoryRevision } from "./memory-revision-recovery";
import {
  canSeedMemoryCorrection, clearPendingMemoryCorrection, MEMORY_CORRECTION_PENDING_EVENT,
  parseMemoryCorrectionResponse, persistPendingMemoryCorrection, readPendingMemoryCorrection,
  type PendingMemoryCorrection,
} from "./memory-correction-recovery";

type Props = {
  memoryId: string; expectedVersion: string; ownerId: string; disabled: boolean; allowNewDraft: boolean;
  pendingRecovery?: PendingMemoryCorrection;
  onBusyChange: (busy: boolean) => void;
  onAdopt: (record: PendingMemoryCorrection) => Promise<void>;
  onDiscard: () => void | Promise<void>;
};
const url = (memoryId: string) => `/api/memory/memories/${encodeURIComponent(memoryId)}/correction-draft`;
const DETAIL_LABELS: Record<string, string> = {
  invalid_intent: "原话内容需要补充",
  ambiguous_or_quoted_intent: "表达含疑问、引用或假设，需主人澄清",
  explicit_deactivate: "已识别明确停用请求",
  explicit_complete_correct: "已提取明确更正的完整正文",
  explicit_complete_supplement: "已提取补充后的完整正文",
  explicit_complete_state_change: "已提取状态变化后的完整正文",
  unchanged_content: "所提供正文与当前内容相同",
  explicit_full_content_required: "需要明确的新版本完整正文或停用请求",
};
const WARNING_LABELS: Record<string, string> = {
  owner_review_required: "仍需主人核对并确认，草稿尚未生效。",
  proves_owner_expression_only: "原话记录只证明主人提出过更正，不证明外部事实真实。",
  semantic_quality_not_evaluated: "有限规则未判断语义质量；请自行核对全文，含糊表达可手填。",
};

/** A draft is an owner-visible interpretation, never a replacement or a source-verification decision. */
export function MemoryCorrectionDraftControl(props: Props) {
  const fieldId = useId();
  const [expanded, setExpanded] = useState(!!props.pendingRecovery);
  const [intent, setIntent] = useState(props.pendingRecovery?.request.intent ?? "");
  const [pending, setPending] = useState<PendingMemoryCorrection | null>(props.pendingRecovery ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef<PendingMemoryCorrection | null>(props.pendingRecovery ?? null);
  const running = useRef(false);
  const live = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    live.current = true;
    try {
      const stored = readPendingMemoryCorrection(sessionStorage, props.ownerId);
      if (stored?.memoryId === props.memoryId) {
        pendingRef.current = stored; setPending(stored); setIntent(stored.request.intent); setExpanded(true);
      } else {
        pendingRef.current = null; setPending(null);
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "草稿暂存读取失败，请先核对恢复记录。"); }
    return () => { live.current = false; controller.current?.abort(); callbacks.current.onBusyChange(false); };
  }, [props.memoryId, props.ownerId]);

  async function checkOwner() {
    const owner = await loadMemoryRevisionOwner();
    if (owner !== props.ownerId) throw new Error("登录身份已变化，未发送或采用原用户草稿。请刷新页面。");
    if (readPendingMemoryRevision(sessionStorage, owner) || readPendingMemoryReview(sessionStorage, owner)) {
      throw new Error("还有记忆修订或核实等待结果核对，请优先通过原恢复入口处理。");
    }
    return owner;
  }

  function setRecord(record: PendingMemoryCorrection) {
    pendingRef.current = record;
    if (live.current) { setPending(record); setIntent(record.request.intent); }
    window.dispatchEvent(new Event(MEMORY_CORRECTION_PENDING_EVENT));
  }

  async function requestDraft(method: "GET" | "POST", record: PendingMemoryCorrection) {
    if (running.current || props.disabled) return;
    running.current = true; setBusy(true); props.onBusyChange(true); setNotice(null);
    let prepared = method === "GET";
    const abort = new AbortController(); controller.current = abort;
    try {
      await checkOwner();
      if (!live.current) return;
      if (method === "POST") {
        persistPendingMemoryCorrection(sessionStorage, record);
        prepared = true; setRecord(record);
      }
      const response = await fetch(method === "GET" ? `${url(record.memoryId)}?commandId=${encodeURIComponent(record.request.commandId)}` : url(record.memoryId), {
        method, cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(record.request) } : {}),
      });
      const body = await response.json().catch(() => null);
      if (!live.current) return;
      await checkOwner();
      if (!live.current) return;
      if (!response.ok) {
        if ([400, 403, 404, 409].includes(response.status) && typeof body?.code === "string") {
          setNotice(body.code === "memory_write_busy"
            ? "记忆暂时忙，草稿请求结果仍待核对。请稍后重新读取或重试原草稿请求；原编号和原话保留。"
            : method === "GET" && response.status === 404
            ? "当前未查到这份草稿回执，历史请求结果仍未确认；可重试原草稿请求，也可放弃本地草稿后手填。"
            : response.status === 409 ? "原草稿依据版本或提交记录已变化。没有改动记忆；请核对原记录，或放弃草稿后手填。"
            : "本次草稿读取或生成被拒绝，没有改动记忆。原请求的历史结果仍需核对。");
          return;
        }
        throw new Error("未取得可核对的草稿回执。");
      }
      const result = parseMemoryCorrectionResponse(body, record);
      const updated = { ...record, result };
      persistPendingMemoryCorrection(sessionStorage, updated);
      setRecord(updated);
      setNotice(!result.current.canSeed
        ? "原话和纠错草稿已保存为历史记录。当前依据版本或状态已变化，不能直接采用；可核对历史或明确放弃本地草稿。"
        : result.draft.outcome === "ready" ? "纠错草稿已保存，记忆仍未更新。请核对建议后明确采用。" : "原话已记录，但还不能整理成明确更正。可按提示重新描述，或放弃草稿后手填。");
    } catch (error) {
      if (live.current) setNotice(prepared
        ? "暂未取得可核对的草稿回执。记忆没有因此更新；可重新读取或重试原草稿请求，编号和原话保持不变。"
        : `${error instanceof Error ? error.message : "无法保存恢复记录。"} 本次草稿请求未发送。`);
    } finally {
      running.current = false; controller.current = null;
      if (live.current) setBusy(false);
      callbacks.current.onBusyChange(false);
    }
  }

  async function generate() {
    if (running.current || props.disabled || !props.allowNewDraft || pendingRef.current) return;
    if (!intent.trim()) { setNotice("请描述哪里记错，以及希望保留的完整内容。"); return; }
    const record: PendingMemoryCorrection = { kind: "memory_correction_draft_pending.v1", ownerId: props.ownerId,
      memoryId: props.memoryId, request: { commandId: crypto.randomUUID(), expectedVersion: props.expectedVersion, intent }, result: null };
    await requestDraft("POST", record);
  }

  async function adopt() {
    const record = pendingRef.current;
    if (running.current || props.disabled || !record || !canSeedMemoryCorrection(record, props.memoryId, props.expectedVersion)) return;
    running.current = true; setBusy(true); props.onBusyChange(true); setNotice(null);
    try {
      await checkOwner();
      if (!live.current) return;
      const response = await fetch(`${url(record.memoryId)}?commandId=${encodeURIComponent(record.request.commandId)}`, {
        cache: "no-store", signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error("未取得当前草稿和依据状态，请重新读取后再采用。");
      const updated = { ...record, result: parseMemoryCorrectionResponse(body, record) };
      await checkOwner();
      if (!live.current) return;
      persistPendingMemoryCorrection(sessionStorage, updated); setRecord(updated);
      if (!canSeedMemoryCorrection(updated, props.memoryId, props.expectedVersion)) throw new Error("原草稿依据版本或状态已变化，未填入建议。请核对当前版本后手填或重新生成。");
      await props.onAdopt(updated);
      if (live.current) setNotice("已将草稿填入下方表单，尚未更新记忆。请核对完整正文、更新方式、理由，并选择信息来源后保存。");
    } catch (error) { if (live.current) setNotice(error instanceof Error ? error.message : "未采用草稿，请重新核对当前版本。"); }
    finally { running.current = false; if (live.current) setBusy(false); callbacks.current.onBusyChange(false); }
  }

  async function discard() {
    const record = pendingRef.current;
    if (running.current || props.disabled || !record) return;
    running.current = true; setBusy(true); props.onBusyChange(true);
    try {
      await checkOwner();
      if (!live.current) return;
      clearPendingMemoryCorrection(sessionStorage, record);
      pendingRef.current = null; setPending(null);
      // The parent keeps its dialog mounted until the user closes it. A stable recovery entry
      // must not disappear midway through switching from the draft to manual fields.
      await props.onDiscard();
      if (live.current) setNotice("已放弃本地草稿。已保存的原话和草稿审计仍保留，记忆没有因此更新；可手填或重新描述。");
    } catch (error) { if (live.current) setNotice(error instanceof Error ? error.message : "草稿暂存未清除，请重新读取。"); }
    finally { running.current = false; if (live.current) setBusy(false); callbacks.current.onBusyChange(false); }
  }

  const result = pending?.result;
  const versionChanged = !!pending && pending.request.expectedVersion !== props.expectedVersion;
  return <section aria-label="一句话纠错草稿" className="space-y-3 rounded-md border p-3 text-sm">
    <Button type="button" variant="outline" disabled={busy} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>用一句话整理纠错草稿</Button>
    {expanded ? <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">仅整理这条记忆的纠错草稿，不会自动改动记忆或暂停任务。当前使用有限规则：完整改为、完整补充为、状态变化后的完整内容、停用这条记忆；含糊表达需澄清，也可直接手填下方表单。</p>
      {!props.allowNewDraft ? <p role="status">当前条目已停用、已有替代版本或需要先审核更新提案，不能生成新草稿。可核对并放弃本地旧草稿，历史原话仍保留。</p> : null}
      <label htmlFor={`${fieldId}-intent`} className="block space-y-1"><span>哪里记错，希望如何更正</span><textarea id={`${fieldId}-intent`} aria-label="哪里记错，希望如何更正" className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2" maxLength={4000} value={intent} disabled={busy || props.disabled || !!pending} onChange={event => setIntent(event.target.value)} placeholder="例如：完整改为：我现在喜欢喝茶。" /></label>
      {notice ? <p role="status" className="whitespace-pre-wrap break-words">{notice}</p> : null}
      {versionChanged ? <p role="alert" className="text-amber-700">当前记忆版本已变化。原草稿仍绑定生成时的版本，不能直接用新的校验版本保存；请放弃原草稿后核对当前版本再手填或重新生成。</p> : null}
      {result ? <section aria-label="纠错草稿建议" className="space-y-2 rounded-md bg-muted/30 p-3">
        <p className="font-medium">{result.draft.outcome === "ready" ? "建议已整理，尚未生效" : "需要澄清，尚未形成更正正文"}</p>
        {result.draft.content !== null ? <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words leading-6">{result.draft.content}</p> : null}
        {result.draft.operation === "deactivate" ? <p>建议停用本条记忆，仍需主人在下方表单确认保存。</p> : null}
        {result.draft.reason ? <p className="whitespace-pre-wrap break-words text-xs">修改理由建议：{result.draft.reason}</p> : null}
        {result.draft.questions.map((question, index) => <p key={index} className="whitespace-pre-wrap break-words">{question}</p>)}
        <p className="text-xs text-muted-foreground">整理方式：有限规则 · {DETAIL_LABELS[result.draft.detail] ?? "来源返回了补充说明，请查看草稿详情"}</p>
        {result.draft.warnings.map((warning, index) => <p key={index} role="status" className="whitespace-pre-wrap break-words text-xs text-amber-700">{WARNING_LABELS[warning] ?? "来源返回了补充警告，请查看草稿详情。"}</p>)}
        <details className="text-xs"><summary className="cursor-pointer">查看草稿原话与版本</summary><p className="mt-2 whitespace-pre-wrap break-words">{result.draft.intent}</p><pre className="mt-2 whitespace-pre-wrap break-all">{`原版本：${result.draft.expectedVersion}\n草稿编号：${result.draft.id}\n原话引用：${result.draft.evidenceRefs.join("\n")}\n整理来源：${result.draft.provider}\n整理结果：${result.draft.detail}\n原始提示：${result.draft.warnings.join("、")}`}</pre></details>
        {!result.current.canSeed ? <p role="status" className="text-amber-700">当前版本或状态不再允许采用这份草稿，请核对当前记忆。历史草稿不是当前可执行命令。</p> : null}
      </section> : null}
      <div className="flex flex-wrap gap-2">
        {!pending ? <Button type="button" disabled={busy || props.disabled || !props.allowNewDraft} onClick={() => void generate()}>生成纠错草稿</Button> : <>
          <Button type="button" variant="outline" disabled={busy || props.disabled} onClick={() => void requestDraft("GET", pending)}>重新读取草稿结果</Button>
          {!pending.result ? <Button type="button" disabled={busy || props.disabled} onClick={() => void requestDraft("POST", pending)}>重试原草稿请求</Button> : null}
          {result?.draft.outcome === "ready" ? <Button type="button" disabled={busy || props.disabled || !canSeedMemoryCorrection(pending, props.memoryId, props.expectedVersion)} onClick={() => void adopt()}>采用这份草稿</Button> : null}
          <Button type="button" variant="outline" disabled={busy || props.disabled} onClick={() => void discard()}>放弃草稿，改为手填</Button>
        </>}
      </div>
    </div> : null}
  </section>;
}
