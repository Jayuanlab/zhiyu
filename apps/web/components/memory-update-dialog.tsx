"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { MemoryEvidenceViewer } from "./memory-evidence-viewer";
import {
  clearPendingMemoryUpdate, hasAcknowledgedMemoryUpdate, isMemoryUpdateMemory, loadMemoryUpdateOwner, MEMORY_UPDATE_PENDING_EVENT,
  parseMemoryUpdateDecisionResult, parseMemoryUpdatePolicyResult, parseMemoryUpdatePolicySnapshot,
  parseMemoryUpdateSnapshot, persistPendingMemoryUpdate, readPendingMemoryUpdate,
  type MemoryUpdateDecisionResult, type MemoryUpdateMemory, type MemoryUpdatePolicyResult,
  type MemoryUpdatePolicySnapshot, type MemoryUpdateSnapshot, type PendingMemoryUpdate,
} from "./memory-update-recovery";

type DecisionPending = Extract<PendingMemoryUpdate, { actionKind: "decision" }>;
type PolicyPending = Extract<PendingMemoryUpdate, { actionKind: "policy" }>;
type SavedResult = MemoryUpdateDecisionResult | MemoryUpdatePolicyResult;
type SavedCallback = () => void | Promise<void>;
const fieldClass = "w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
// A stable recovery control and the original dialog may coexist. They share one local flight per owner.
const postingOwners = new Set<string>();
const announcePending = (acknowledged?: PendingMemoryUpdate) => window.dispatchEvent(new CustomEvent(MEMORY_UPDATE_PENDING_EVENT, { detail: { acknowledged } }));
const failureText = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
const displayDate = (value: string | null | undefined) => value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleString("zh-CN") : "时间未知";
const statusLabel: Record<string, string> = { candidate: "待审核", active: "有效", verified: "已核实", weakened: "已降权", superseded: "已替代", deleted: "已停用" };

class UpdateApiError extends Error {
  constructor(message: string, public status: number, public code: string | null) { super(message); }
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new UpdateApiError(body?.error ?? "读取失败，请重试。", response.status, body?.code ?? null);
  return body;
}
const readProposal = async (id: string) => parseMemoryUpdateSnapshot(await readJson(`/api/brain/memory-updates/${encodeURIComponent(id)}`), id);
const readPolicy = async () => parseMemoryUpdatePolicySnapshot(await readJson("/api/brain/memory-updates/policy"));

/** Mutations never begin before identity and durable storage have both been checked. */
function useUpdateCommand(initial?: PendingMemoryUpdate) {
  const [pending, setPending] = useState<PendingMemoryUpdate | null>(initial ?? null);
  const [outcome, setOutcome] = useState<"idle" | "unknown" | "saved" | "blocked">(initial ? "unknown" : "idle");
  const [result, setResult] = useState<SavedResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const ownerRef = useRef<string | null>(initial?.ownerId ?? null);
  const pendingRef = useRef<PendingMemoryUpdate | null>(initial ?? null);

  useEffect(() => {
    const synchronize = (event: Event) => {
      const record = pendingRef.current;
      if (!record || inFlight.current || ownerRef.current !== record.ownerId ||
          !hasAcknowledgedMemoryUpdate(sessionStorage, record, (event as CustomEvent<{ acknowledged?: PendingMemoryUpdate }>).detail?.acknowledged)) return;
      pendingRef.current = null; setPending(null); setOutcome("idle"); setResult(null); setNotice(null);
    };
    window.addEventListener(MEMORY_UPDATE_PENDING_EVENT, synchronize);
    return () => window.removeEventListener(MEMORY_UPDATE_PENDING_EVENT, synchronize);
  }, []);

  function bindOwner(owner: string) {
    if (ownerRef.current && ownerRef.current !== owner) throw new Error("登录身份已变化，未发送操作。请刷新页面，以当前身份重新打开。");
    ownerRef.current = owner;
  }
  function restore(record: PendingMemoryUpdate) {
    bindOwner(record.ownerId);
    pendingRef.current = record; setPending(record); setOutcome("unknown"); setResult(null);
  }

  async function send(record: PendingMemoryUpdate) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNotice(null);
    let posted = false;
    let flightOwner: string | null = null;
    try {
      const owner = await loadMemoryUpdateOwner();
      bindOwner(owner);
      if (owner !== record.ownerId) throw new Error("登录身份已变化，未发送原主人的操作。");
      if (postingOwners.has(owner)) throw new Error("原操作仍在等待响应，请等待或稍后通过恢复入口核对。");
      postingOwners.add(owner); flightOwner = owner;
      persistPendingMemoryUpdate(sessionStorage, record);
      pendingRef.current = record; setPending(record); setOutcome("unknown"); setResult(null); announcePending();
      const url = record.actionKind === "decision"
        ? `/api/brain/memory-updates/${encodeURIComponent(record.candidateId)}/decision` : "/api/brain/memory-updates/policy";
      posted = true;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record.request), signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // A structured validation/version refusal is definitive for this command. Keep it until acknowledged.
        if ([400, 409].includes(response.status) && typeof body?.code === "string") {
          setOutcome("blocked");
          setNotice(`服务器未接受本次提交：${body.error ?? body.code}。原命令与理由已保留，请重新读取当前状态。`);
          return;
        }
        throw new Error(body?.error ?? "未取得有效操作回执。");
      }
      const saved = record.actionKind === "decision"
        ? parseMemoryUpdateDecisionResult(body, record) : parseMemoryUpdatePolicyResult(body, record);
      setResult(saved); setOutcome("saved");
      setNotice(record.actionKind === "decision" ? (saved as MemoryUpdateDecisionResult).receipt.status === "accepted"
        ? "提案已接受：旧版本已退出有效召回，新版本已保存为有效记忆。下一轮实际使用仍需验证。"
        : "提案已拒绝，当前记忆未被此操作替换。"
        : record.request.enabled ? "已保存恢复自动生效的设置。" : "已保存暂停自动生效的设置；仍可收集证据、生成待审提案及手动审核。");
    } catch (failure) {
      if (posted) {
        setOutcome("unknown");
        setNotice(`提交结果尚未确认：${failureText(failure, "连接中断。")}。这不表示未保存；请核对当前状态或重试原命令。`);
      } else setNotice(failureText(failure, "未发送操作，请重试。"));
    } finally {
      if (flightOwner) postingOwners.delete(flightOwner);
      inFlight.current = false; setBusy(false);
    }
  }

  async function acknowledge(beforeClear: () => void, onSaved?: SavedCallback) {
    if (inFlight.current || !pendingRef.current) return;
    inFlight.current = true; setBusy(true);
    let refresh = false;
    try {
      const record = pendingRef.current;
      const owner = await loadMemoryUpdateOwner();
      bindOwner(owner);
      if (owner !== record.ownerId) throw new Error("登录身份已变化，未清除原主人的恢复记录。");
      if (postingOwners.has(owner)) throw new Error("原操作仍在等待响应，请等待响应后再结束恢复记录。");
      clearPendingMemoryUpdate(sessionStorage, record);
      pendingRef.current = null; setPending(null);
      beforeClear(); // Close the portal before the stable recovery entry can unmount it.
      announcePending(record);
      refresh = true;
    } catch (failure) { setNotice(failureText(failure, "恢复记录未能结束，请重试。")); }
    finally { inFlight.current = false; setBusy(false); }
    if (refresh) {
      try { await onSaved?.(); }
      catch (failure) { setNotice(`操作已保存，但列表刷新失败：${failureText(failure, "请手动刷新。")}`); }
    }
  }

  return { pending, outcome, result, notice, busy, inFlight, ownerRef, setNotice, bindOwner, restore, send, acknowledge };
}

function ProposalComparison({ snapshot }: { snapshot: MemoryUpdateSnapshot }) {
  const changed = snapshot.baseVersion !== snapshot.proposal.expectedBaseVersion;
  return <div className="space-y-3">
    <div className="grid gap-3 md:grid-cols-2">
      <section aria-label="当前记忆内容" className="space-y-2 rounded-md border p-3 text-sm">
        <p className="font-medium">关联记忆 · {statusLabel[snapshot.base.status] ?? snapshot.base.status}</p>
        <p className="text-xs text-muted-foreground">更新于 {displayDate(snapshot.base.updatedAt)}</p>
        <p className="whitespace-pre-wrap break-words leading-6">{snapshot.base.content}</p>
      </section>
      <section aria-label="提案内容" className="space-y-2 rounded-md border p-3 text-sm">
        <p className="font-medium">建议更新 · {snapshot.proposal.status === "pending" ? snapshot.candidate.status === "candidate" ? "尚未采用" : "已退出审核" : snapshot.proposal.status === "accepted" ? "已接受" : "已拒绝"}</p>
        <p className="text-xs text-muted-foreground">提案保存于 {displayDate(snapshot.proposal.createdAt)}</p>
        <p className="whitespace-pre-wrap break-words leading-6">{snapshot.candidate.content}</p>
      </section>
    </div>
    <p className="text-sm whitespace-pre-wrap break-words">更新依据：{snapshot.proposal.reason}</p>
    {changed && snapshot.proposal.status === "pending" ? <p role="alert" className="text-sm text-amber-700">提案依据的关联记忆版本或状态已变化，当前显示的是该关联记忆的最新记录；此提案不能直接替换它。请核对变化并重新生成提案，或拒绝当前提案。</p> : null}
    <MemoryEvidenceViewer key={`${snapshot.candidate.id}:${snapshot.proposalVersion}:${snapshot.baseVersion}`} memoryId={snapshot.candidate.id}
      evidenceRefs={snapshot.candidate.evidenceRefs} baseEvidenceRefs={snapshot.base.evidenceRefs} />
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看关联版本</summary>
      <pre className="mt-2 whitespace-pre-wrap break-all">{`提案编号：${snapshot.candidate.id}\n提案版本：${snapshot.proposalVersion}\n当前记忆编号：${snapshot.base.id}\n当前记忆版本：${snapshot.baseVersion}\n提案依据版本：${snapshot.proposal.expectedBaseVersion}`}</pre>
    </details>
  </div>;
}

export function MemoryUpdateDecisionControl({ candidateId, pendingRecovery, onSaved, triggerLabel = "审核更新提案" }: {
  candidateId: string; pendingRecovery?: DecisionPending; onSaved?: SavedCallback; triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<MemoryUpdateSnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reason, setReason] = useState(pendingRecovery?.request.reason ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [refreshedBlocked, setRefreshedBlocked] = useState(false);
  const command = useUpdateCommand(pendingRecovery);
  const fieldId = useId();
  const generation = useRef(0);
  const readFlight = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (command.outcome === "blocked") setRefreshedBlocked(false); }, [command.outcome]);

  async function load() {
    if (readFlight.current || command.inFlight.current) return;
    readFlight.current = true; setReading(true); setReadError(null); setConfirmed(false);
    const current = ++generation.current;
    try {
      const [next, owner] = await Promise.all([readProposal(candidateId), loadMemoryUpdateOwner()]);
      command.bindOwner(owner);
      const stored = readPendingMemoryUpdate(sessionStorage, owner);
      if (stored?.actionKind === "decision" && stored.candidateId === candidateId && !command.pending) {
        command.restore(stored); setReason(stored.request.reason);
      }
      if (current === generation.current) { setSnapshot(next); if (command.outcome === "blocked") setRefreshedBlocked(true); }
    } catch (failure) { if (current === generation.current) setReadError(failureText(failure, "提案读取失败。")); }
    finally { if (current === generation.current) { readFlight.current = false; setReading(false); } }
  }

  async function decide(action: "accept" | "reject") {
    if (command.inFlight.current || command.pending || !snapshot || reading || readError) return;
    if (snapshot.proposal.status !== "pending" || snapshot.candidate.status !== "candidate") { command.setNotice("提案已经结束或退出审核，请重新读取当前状态。"); return; }
    if (!reason.trim() || reason.length > 2000) { command.setNotice("请填写不超过 2000 字符的审核理由。"); return; }
    if (action === "accept" && (!confirmed || snapshot.baseVersion !== snapshot.proposal.expectedBaseVersion ||
        !["active", "verified", "weakened"].includes(snapshot.base.status) || snapshot.candidate.evidenceRefs.length === 0)) {
      command.setNotice("请核对来源及当前基准版本；发生基准变化或缺少来源的提案不能直接采用。"); return;
    }
    const owner = command.ownerRef.current;
    if (!owner) { command.setNotice("尚未确认登录身份，请重新读取提案。"); return; }
    await command.send({ kind: "memory_update_pending.v1", ownerId: owner, actionKind: "decision",
      candidateId, baseMemoryId: snapshot.base.id, request: { action, commandId: crypto.randomUUID(),
        expectedVersion: snapshot.proposalVersion, expectedBaseVersion: snapshot.baseVersion, reason: reason.trim(),
        ...(action === "accept" ? { evidenceConfirmed: true } : {}) } });
  }

  const pending = command.pending?.actionKind === "decision" ? command.pending : null;
  const endedVersion = !!pending && !!snapshot && (snapshot.proposalVersion !== pending.request.expectedVersion ||
    snapshot.baseVersion !== pending.request.expectedBaseVersion || snapshot.proposal.status !== "pending" || snapshot.candidate.status !== "candidate");
  const canAccept = !!snapshot && !readError && snapshot.proposal.status === "pending" && snapshot.candidate.status === "candidate" && snapshot.baseVersion === snapshot.proposal.expectedBaseVersion &&
    ["active", "verified", "weakened"].includes(snapshot.base.status) && snapshot.candidate.evidenceRefs.length > 0;

  async function endObsoleteRecovery() {
    if (!pending || command.inFlight.current || readFlight.current) return;
    readFlight.current = true; setReading(true);
    setReadError(null);
    try {
      const current = await readProposal(candidateId);
      setSnapshot(current);
      if (current.proposalVersion === pending.request.expectedVersion && current.baseVersion === pending.request.expectedBaseVersion && current.proposal.status === "pending" && current.candidate.status === "candidate") {
        command.setNotice("提案和基准版本仍可执行原命令，请重试原审核；未结束恢复记录。"); return;
      }
      await command.acknowledge(() => setOpen(false));
    } catch (failure) { setReadError(failureText(failure, "无法确认版本变化，恢复记录已保留。")); }
    finally { readFlight.current = false; setReading(false); }
  }

  return <Dialog open={open} onOpenChange={next => {
    if (!next && command.inFlight.current) { command.setNotice("正在等待审核回执；请求超时后可通过原命令恢复。"); return; }
    setOpen(next); if (next) void load();
  }}>
    <Button type="button" variant="outline" size="sm" onClick={() => { setOpen(true); void load(); }}>{triggerLabel}</Button>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" hideCloseButton>
      <DialogHeader><DialogTitle>记忆更新提案审核</DialogTitle><DialogDescription>审核前保留当前记忆。接受时检查提案与当前记忆两个版本，再同时替换；拒绝保留当前记忆。</DialogDescription></DialogHeader>
      <div className="flex justify-end"><Button type="button" variant="ghost" disabled={command.busy} onClick={() => setOpen(false)}>关闭</Button></div>
      {reading ? <p role="status" className="text-sm">正在读取提案与当前记忆…</p> : null}
      {readError ? <p role="alert" className="text-sm text-amber-700">{readError}</p> : null}
      {snapshot ? <ProposalComparison snapshot={snapshot} /> : null}
      {command.notice ? <p role={command.outcome === "saved" ? "status" : "alert"} className="text-sm whitespace-pre-wrap break-words">{command.notice}</p> : null}
      {command.result && command.outcome === "saved" ? <details className="text-xs"><summary className="cursor-pointer">查看审核回执</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(command.result.receipt, null, 2)}</pre></details> : null}
      {pending ? <section aria-label="提案审核提交状态" className="space-y-3 rounded-md border p-3 text-sm">
        <p>{command.outcome === "saved" ? "已取得原命令回执。重放回执描述当时结果，重新读取可查看当前版本。" : command.outcome === "blocked"
          ? "原提交被版本或输入校验拒绝，理由仍保留。请读取当前状态后结束此提交，再重新审核。"
          : "原审核结果尚未确认。关闭或刷新页面会保留原命令，不会生成另一条审核。"}</p>
        <details className="text-xs"><summary className="cursor-pointer">原审核编号与理由</summary><pre className="mt-2 whitespace-pre-wrap break-all">{`${pending.request.commandId}\n${pending.request.reason}`}</pre></details>
        <div className="flex flex-wrap gap-2">
          {command.outcome === "unknown" ? <Button type="button" disabled={command.busy || reading} onClick={() => void command.send(pending)}>重试原审核</Button> : null}
          <Button type="button" variant="outline" disabled={command.busy || reading} onClick={() => void load()}>重新读取提案状态</Button>
          {command.outcome === "saved" || command.outcome === "blocked" ? <Button type="button" disabled={command.busy || reading || command.outcome === "blocked" && !refreshedBlocked} onClick={() => void command.acknowledge(() => setOpen(false), onSaved)}>完成并刷新提案列表</Button> : null}
        </div>
        {command.outcome === "unknown" && endedVersion ? <div className="space-y-2">
          <p>当前版本或提案状态已变化，原版本不能再执行。可以仅清除本地暂存；原审核历史结果仍未知，已保存的历史审计保留。</p>
          <Button type="button" variant="outline" disabled={command.busy || reading} onClick={() => void endObsoleteRecovery()}>关闭并结束此次提案审核恢复</Button>
        </div> : null}
      </section> : snapshot?.proposal.status === "pending" && snapshot.candidate.status === "candidate" ? <section aria-label="提案审核操作" className="space-y-3 rounded-md border p-3">
        <label htmlFor={`${fieldId}-reason`} className="block space-y-1 text-sm"><span>审核理由</span><textarea id={`${fieldId}-reason`} className={`${fieldClass} min-h-20 resize-y`} maxLength={2000} value={reason} disabled={command.busy || reading} onChange={event => setReason(event.target.value)} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={!canAccept || command.busy || reading} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对原始来源，确认可以采用提案</span></label>
        <p className="text-xs text-muted-foreground">无法解析或截断的证据需要另行核对，界面不会把引用自动视作已核实。拒绝只结束该提案。</p>
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={!canAccept || !confirmed || !reason.trim() || command.busy || reading} onClick={() => void decide("accept")}>接受提案</Button><Button type="button" variant="outline" disabled={!reason.trim() || command.busy || reading || !!readError} onClick={() => void decide("reject")}>拒绝提案</Button></div>
      </section> : null}
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={command.busy || reading} onClick={() => void load()}>刷新提案与基准</Button><Button type="button" variant="outline" disabled={command.busy} onClick={() => setOpen(false)}>关闭提案审核</Button></div>
    </DialogContent>
  </Dialog>;
}

function MemoryUpdatePolicyControl({ pendingRecovery, onSaved }: { pendingRecovery?: PolicyPending; onSaved?: SavedCallback }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<MemoryUpdatePolicySnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reason, setReason] = useState(pendingRecovery?.request.reason ?? "");
  const [refreshedBlocked, setRefreshedBlocked] = useState(false);
  const command = useUpdateCommand(pendingRecovery);
  const fieldId = useId();
  const generation = useRef(0);
  const readFlight = useRef(false);
  useEffect(() => { if (command.outcome === "blocked") setRefreshedBlocked(false); }, [command.outcome]);

  async function load() {
    if (readFlight.current || command.inFlight.current) return;
    readFlight.current = true; setReading(true); setReadError(null);
    const current = ++generation.current;
    try {
      const [next, owner] = await Promise.all([readPolicy(), loadMemoryUpdateOwner()]);
      command.bindOwner(owner);
      const stored = readPendingMemoryUpdate(sessionStorage, owner);
      if (stored?.actionKind === "policy" && !command.pending) { command.restore(stored); setReason(stored.request.reason); }
      if (current === generation.current) { setSnapshot(next); if (command.outcome === "blocked") setRefreshedBlocked(true); }
    } catch (failure) { if (current === generation.current) setReadError(failureText(failure, "自动生效设置读取失败。")); }
    finally { if (current === generation.current) { readFlight.current = false; setReading(false); } }
  }
  useEffect(() => { void load(); return () => { generation.current++; readFlight.current = false; }; }, []);

  async function changePolicy() {
    if (command.inFlight.current || command.pending || !snapshot || reading || readError) return;
    if (!reason.trim() || reason.length > 2000) { command.setNotice("请填写不超过 2000 字符的设置理由。"); return; }
    const owner = command.ownerRef.current;
    if (!owner) { command.setNotice("尚未确认登录身份，请重新读取设置。"); return; }
    await command.send({ kind: "memory_update_pending.v1", ownerId: owner, actionKind: "policy", request: {
      commandId: crypto.randomUUID(), expectedVersion: snapshot.version, enabled: !snapshot.enabled, reason: reason.trim() } });
  }
  const pending = command.pending?.actionKind === "policy" ? command.pending : null;
  const changedVersion = !!pending && !!snapshot && snapshot.version !== pending.request.expectedVersion;
  async function endObsoleteRecovery() {
    if (!pending || command.inFlight.current || readFlight.current) return;
    readFlight.current = true; setReading(true);
    try {
      const current = await readPolicy(); setSnapshot(current);
      if (current.version === pending.request.expectedVersion) { command.setNotice("设置版本仍相同，请重试原设置，未结束恢复记录。"); return; }
      await command.acknowledge(() => setOpen(false));
    } catch (failure) { setReadError(failureText(failure, "无法确认设置版本变化，恢复记录已保留。")); }
    finally { readFlight.current = false; setReading(false); }
  }

  return <section aria-label={pendingRecovery ? "自动生效设置恢复操作" : "记忆自动生效政策"} className="space-y-2 rounded-md border p-3 text-sm">
    <p className="font-medium">记忆自动生效 · {snapshot ? snapshot.enabled ? "已开启" : "已暂停" : "状态尚未读取"}</p>
    <p className="text-xs text-muted-foreground">当前自动范围仅为持久文件转换的格式、哈希和分片数；文档观点与模型修正需审核。暂停仍收集证据、生成待审核提案，并保留手动审核；任务调度与权限不受此开关控制。</p>
    {readError && !open ? <p role="alert" className="text-amber-700">{readError}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={reading || command.busy} onClick={() => { setOpen(true); void load(); }}>{pendingRecovery || pending ? "恢复自动生效设置" : snapshot?.enabled === false ? "恢复自动生效" : "暂停自动生效"}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={reading || command.busy} onClick={() => void load()}>读取当前政策</Button>
    </div>
    <Dialog open={open} onOpenChange={next => { if (!next && command.inFlight.current) return; setOpen(next); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" hideCloseButton>
        <DialogHeader><DialogTitle>记忆自动生效设置</DialogTitle><DialogDescription>这是全局自动生效开关。当前自动范围仅为持久文件转换的格式、哈希和分片数；文档观点与模型修正需审核。暂停仍收集证据、生成待审核提案，保留手动审核；任务调度与权限不受此开关控制。</DialogDescription></DialogHeader>
        <div className="flex justify-end"><Button type="button" variant="ghost" disabled={command.busy} onClick={() => setOpen(false)}>关闭</Button></div>
        {reading ? <p role="status">正在读取设置…</p> : null}
        {readError ? <p role="alert" className="text-sm text-amber-700">{readError}</p> : null}
        {snapshot ? <p className="text-sm">当前自动生效：{snapshot.enabled ? "开启" : "暂停"}</p> : null}
        {command.notice ? <p role={command.outcome === "saved" ? "status" : "alert"} className="text-sm whitespace-pre-wrap break-words">{command.notice}</p> : null}
        {pending ? <section aria-label="政策提交状态" className="space-y-3 rounded-md border p-3 text-sm">
          <p>{command.outcome === "saved" ? "已取得原设置回执，当前实际政策可重新读取。" : command.outcome === "blocked" ? "服务器未接受原设置，请读取当前版本后结束此提交。" : "原设置结果未知，已保留原命令；当前开关值不能单独证明原请求的历史结果。"}</p>
          <details className="text-xs"><summary className="cursor-pointer">查看原设置命令</summary><pre className="mt-2 whitespace-pre-wrap break-all">{`${pending.request.commandId}\n${pending.request.enabled ? "恢复自动生效" : "暂停自动生效"}\n${pending.request.reason}`}</pre></details>
          {command.result && command.outcome === "saved" ? <details className="text-xs"><summary className="cursor-pointer">查看设置回执</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(command.result.receipt, null, 2)}</pre></details> : null}
          <div className="flex flex-wrap gap-2">
            {command.outcome === "unknown" ? <Button type="button" disabled={command.busy || reading} onClick={() => void command.send(pending)}>重试原政策设置</Button> : null}
            <Button type="button" variant="outline" disabled={command.busy || reading} onClick={() => void load()}>重新读取当前政策</Button>
            {command.outcome === "saved" || command.outcome === "blocked" ? <Button type="button" disabled={command.busy || reading || command.outcome === "blocked" && !refreshedBlocked} onClick={() => void command.acknowledge(() => setOpen(false), async () => { await load(); await onSaved?.(); })}>完成政策核对</Button> : null}
          </div>
          {command.outcome === "unknown" && changedVersion ? <div className="space-y-2"><p>政策版本已变化，可以仅清本地暂存；原设置请求的历史结果仍未知，历史审计保留。</p><Button type="button" variant="outline" disabled={command.busy || reading} onClick={() => void endObsoleteRecovery()}>关闭并结束此次政策恢复</Button></div> : null}
        </section> : snapshot ? <div className="space-y-3">
          <label htmlFor={`${fieldId}-policy-reason`} className="block space-y-1 text-sm"><span>设置理由</span><textarea id={`${fieldId}-policy-reason`} className={`${fieldClass} min-h-20 resize-y`} maxLength={2000} value={reason} disabled={command.busy || reading} onChange={event => setReason(event.target.value)} /></label>
          <Button type="button" disabled={command.busy || reading || !reason.trim() || !!readError} onClick={() => void changePolicy()}>{snapshot.enabled ? "保存暂停自动生效" : "保存恢复自动生效"}</Button>
        </div> : null}
        {snapshot ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看政策版本</summary><pre className="mt-2 whitespace-pre-wrap break-all">{`${snapshot.version}\n${snapshot.snapshotId ?? "尚未设置，使用默认政策"}`}</pre></details> : null}
        <Button type="button" variant="outline" disabled={command.busy} onClick={() => setOpen(false)}>关闭政策设置</Button>
      </DialogContent>
    </Dialog>
  </section>;
}

export function MemoryUpdateRecovery({ onSaved }: { onSaved?: SavedCallback }) {
  const [pending, setPending] = useState<PendingMemoryUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    let generation = 0;
    async function restore() {
      const current = ++generation;
      try {
        const owner = await loadMemoryUpdateOwner();
        const record = readPendingMemoryUpdate(sessionStorage, owner);
        if (live && current === generation) { setPending(record); setError(null); }
      } catch (failure) { if (live && current === generation) { setPending(null); setError(failureText(failure, "恢复记录读取失败。")); } }
    }
    const changed = () => void restore();
    void restore(); window.addEventListener(MEMORY_UPDATE_PENDING_EVENT, changed);
    return () => { live = false; window.removeEventListener(MEMORY_UPDATE_PENDING_EVENT, changed); };
  }, [reload]);
  if (error) return <section aria-label="记忆提案恢复读取错误" role="alert" className="space-y-2 rounded-md border p-3 text-sm"><p>{error}</p><Button type="button" variant="outline" onClick={() => setReload(value => value + 1)}>重新读取提案恢复记录</Button></section>;
  if (!pending) return null;
  return <section aria-label={pending.actionKind === "decision" ? "记忆提案审核恢复" : "记忆自动生效设置恢复"} className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
    <p>有一条{pending.actionKind === "decision" ? "提案审核" : "自动生效设置"}等待回执核对；即使提案退出列表，仍可恢复原命令。</p>
    {pending.actionKind === "decision" ? <MemoryUpdateDecisionControl key={pending.request.commandId} candidateId={pending.candidateId} pendingRecovery={pending} triggerLabel="恢复提案审核" onSaved={onSaved} />
      : <MemoryUpdatePolicyControl key={pending.request.commandId} pendingRecovery={pending} onSaved={onSaved} />}
  </section>;
}

function MemoryUpdateProposalList({ workId, onSaved }: { workId?: string; onSaved?: SavedCallback }) {
  const [open, setOpen] = useState(false);
  const [proposals, setProposals] = useState<MemoryUpdateMemory[] | null>(null);
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
      const params = new URLSearchParams({ limit: "20" });
      if (workId) { params.set("ownerType", "work"); params.set("ownerId", workId); }
      const body = await readJson(`/api/brain/memory-updates?${params}`) as { proposals?: unknown[] };
      if (!Array.isArray(body?.proposals) || body.proposals.length > 20 || body.proposals.some(memory => !isMemoryUpdateMemory(memory) || memory.status !== "candidate" ||
          (memory.metadata?.updateProposal as { status?: string } | undefined)?.status !== "pending" ||
          (workId && (memory.ownerType !== "work" || memory.ownerId !== workId)))) throw new Error("提案列表信息不完整，请重新读取。");
      if (current === generation.current) setProposals(body.proposals as MemoryUpdateMemory[]);
    } catch (failure) { if (current === generation.current) setError(failureText(failure, "提案列表读取失败。")); }
    finally { if (current === generation.current) { reading.current = false; setLoading(false); } }
  }
  async function afterSaved() {
    const results = await Promise.allSettled([load(), Promise.resolve().then(() => onSaved?.())]);
    if (results[1].status === "rejected") setError("审核已保存，但记忆列表刷新失败，请手动刷新。");
  }
  return <section aria-label="记忆更新提案列表" className="rounded-md border p-3 text-sm">
    <button type="button" aria-expanded={open} className="w-full text-left font-medium" onClick={() => { const next = !open; setOpen(next); if (next && proposals === null) void load(); }}>{open ? "收起记忆更新提案" : "查看记忆更新提案"}</button>
    {open ? <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">仅显示最近 20 条待审核更新提案。提案不会在审核前替换当前记忆；与主人已提交的待核实修订分别展示。</p>
      {loading ? <p role="status">正在读取记忆更新提案…</p> : null}
      {error ? <p role="alert" className="text-amber-700">{error}</p> : null}
      <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>刷新记忆更新提案</Button>
      {!loading && proposals?.length === 0 ? <p className="text-muted-foreground">没有待审核的记忆更新提案。</p> : null}
      {proposals?.map(proposal => <article key={proposal.id} data-proposal-id={proposal.id} className="space-y-2 border-t pt-3">
        <p className="font-medium">{proposal.subject}</p><p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words leading-6">{proposal.content}</p>
        <p className="text-xs text-muted-foreground">保存于 {displayDate(proposal.createdAt)} · 待审核，当前记忆仍保留。</p>
        <MemoryUpdateDecisionControl candidateId={proposal.id} onSaved={afterSaved} />
      </article>)}
    </div> : null}
  </section>;
}

/** The two desktop entry points use the same policy, list and stable recovery controls. */
export function MemoryUpdatesPanel({ workId, onSaved }: { workId?: string; onSaved?: SavedCallback }) {
  return <div className="space-y-3"><MemoryUpdateRecovery onSaved={onSaved} /><MemoryUpdatePolicyControl />
    <MemoryUpdateProposalList key={workId ?? "all-owned"} workId={workId} onSaved={onSaved} /></div>;
}
