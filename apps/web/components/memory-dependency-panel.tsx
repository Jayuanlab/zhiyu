"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  clearPendingMemoryDependency, hasAcknowledgedMemoryDependency, isMemoryDependencyTargetUnavailable, loadMemoryDependencyOwner,
  MEMORY_DEPENDENCY_PENDING_EVENT, normalizeDependencySources, parseDependencyMemory,
  parseMemoryDependencyReceipt, parseMemoryDependencySnapshot, persistPendingMemoryDependency,
  readPendingMemoryDependency, restoreMemoryDependencyCommandState, type DependencyMemory, type MemoryDependencyCommandState, type MemoryDependencyEntityKind,
  type MemoryDependencySnapshot, type MemoryDependencySourceRef,
  type PendingMemoryDependency,
} from "./memory-dependency-recovery";

type SavedCallback = () => void | Promise<void>;
const fieldClass = "w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
const postingOwners = new Set<string>();
const announce = (acknowledged?: PendingMemoryDependency) => window.dispatchEvent(new CustomEvent(MEMORY_DEPENDENCY_PENDING_EVENT, { detail: { acknowledged } }));
const failureText = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
const kindLabel = { wiki_note: "知识摘要", interaction_task: "交互待办", loop: "持续任务" };
const stateLabel = { unknown: "依据未登记", current: "已登记依据版本当前有效", stale: "依据待复核", denied: "来源访问受限，无法核对" };
const reasonLabels: Record<string, string> = {
  dependency_coverage_unknown: "尚未登记记忆依据，其他依赖仍未知。", entity_unavailable: "关联成果已不可用。", entity_version_changed: "成果正文或定义已变化，请重新核对。",
  source_unavailable_or_denied: "来源不可用或访问受限。", source_history_cycle: "来源版本链异常，无法采用。", source_inactive_or_expired: "来源已停用、过期或仍待核实。",
  source_replaced: "来源已有新版本，请核对实际后继。", source_version_changed: "来源版本已变化，请重新核对。", source_current: "登记版本与当前有效记忆一致。",
  source_successor_unavailable: "来源后继未能读取，无法采用。", source_history_limit: "来源版本链超出核对范围。", source_update_pending: "来源已有待审更新提案，请先接受或拒绝该提案。",
  invalid_dependency: "登记命令不完整。", dependency_evidence_confirmation_required: "需要明确核对成果与来源。", dependency_owner_review_required: "需要主人审核。",
  dependency_not_allowed: "无权核对这项成果。", dependency_target_not_found: "关联成果已不可用。", dependency_target_unavailable: "关联成果已停用或归档。",
  dependency_entity_conflict: "成果版本已变化，请重新核对。", dependency_version_conflict: "依据登记已变化，请重新读取。", dependency_already_registered: "成果已有登记，请读取后重新核对。",
  dependency_not_registered: "成果尚未登记，请先登记实际依据。", dependency_source_denied: "来源不可用或访问受限。", dependency_source_conflict: "来源已变化、过期或有待审提案，请先处理来源。",
  dependency_command_conflict: "原命令编号已关联其他内容，不能覆盖。",
  memory_write_busy: "记忆正在被另一项修改占用，请重新读取后用原命令重试。",
};
const reasonLabel = (code: string) => reasonLabels[code] ?? "依据状态需要进一步核对。";
const memoryStatusLabel: Record<string, string> = { active: "有效", verified: "已核实", weakened: "已降权", candidate: "待核实", superseded: "已替代", deleted: "已停用" };
const dateLabel = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "时间未知";
const pathFor = (kind: MemoryDependencyEntityKind, id: string) => `/api/brain/memory-dependencies/${kind}/${encodeURIComponent(id)}`;
const memoryUsable = (memory: DependencyMemory | null | undefined) => !!memory && ["active", "verified"].includes(memory.status) &&
  (!memory.expiresAt || Date.parse(memory.expiresAt) > Date.now());

class DependencyReadError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    const code = (body as { code?: unknown } | null)?.code;
    super(typeof code === "string" ? reasonLabel(code) : "读取失败，请重新读取。");
  }
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new DependencyReadError(response.status, body);
  return body;
}
const readSnapshot = async (kind: MemoryDependencyEntityKind, id: string) => parseMemoryDependencySnapshot(await readJson(pathFor(kind, id)), kind, id);

function useDependencyCommand(initial?: PendingMemoryDependency) {
  const [state, setState] = useState<MemoryDependencyCommandState>({ pending: initial ?? null, outcome: initial ? "unknown" : "idle", result: null, blockedCode: null });
  const stateRef = useRef(state);
  const { pending, outcome, result, blockedCode } = state;
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ownerRef = useRef<string | null>(initial?.ownerId ?? null);
  const inFlight = useRef(false);
  function updateState(next: MemoryDependencyCommandState) { stateRef.current = next; setState(next); }
  useEffect(() => {
    const synchronized = (event: Event) => {
      const record = stateRef.current.pending;
      if (!record || inFlight.current || ownerRef.current !== record.ownerId ||
          !hasAcknowledgedMemoryDependency(sessionStorage, record, (event as CustomEvent<{ acknowledged?: PendingMemoryDependency }>).detail?.acknowledged)) return;
      updateState({ pending: null, outcome: "idle", result: null, blockedCode: null }); setNotice(null);
    };
    window.addEventListener(MEMORY_DEPENDENCY_PENDING_EVENT, synchronized);
    return () => window.removeEventListener(MEMORY_DEPENDENCY_PENDING_EVENT, synchronized);
  }, []);
  function bindOwner(owner: string) {
    if (ownerRef.current && ownerRef.current !== owner) throw new Error("登录身份已变化，未发送操作。请刷新页面，以当前身份重新打开。");
    ownerRef.current = owner;
  }
  function restore(record: PendingMemoryDependency) {
    bindOwner(record.ownerId);
    const next = restoreMemoryDependencyCommandState(stateRef.current, record);
    if (next === stateRef.current) return false;
    updateState(next); return true;
  }
  async function send(record: PendingMemoryDependency): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setNotice(null);
    let posted = false;
    let flightOwner: string | null = null;
    try {
      const owner = await loadMemoryDependencyOwner(); bindOwner(owner);
      if (owner !== record.ownerId) throw new Error("登录身份已变化，未发送原主人的命令。");
      if (postingOwners.has(owner)) throw new Error("原登记仍在等待响应，请稍后通过恢复入口核对。");
      postingOwners.add(owner); flightOwner = owner;
      const normalized = persistPendingMemoryDependency(sessionStorage, record);
      updateState({ pending: normalized, outcome: "unknown", result: null, blockedCode: null }); announce();
      posted = true;
      const response = await fetch(pathFor(normalized.entityKind, normalized.entityId), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalized.request), signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if ([400, 403, 404, 409].includes(response.status) && typeof body?.code === "string" && Object.hasOwn(reasonLabels, body.code)) {
          updateState({ pending: normalized, outcome: "blocked", result: null, blockedCode: body.code }); setNotice(`服务器拒绝了当前尝试：${reasonLabel(body.code)}原命令与理由已保留；若此前响应丢失，历史结果仍需核对，不能据此断言未保存。`); return false;
        }
        throw new Error(body?.error ?? "未取得有效登记回执。");
      }
      const receipt = parseMemoryDependencyReceipt(body, normalized);
      updateState({ pending: normalized, outcome: "saved", result: receipt, blockedCode: null }); setNotice("依据登记已保存。回执描述当时结果，请读取当前状态核对；正文、待办完成状态和任务授权未由此操作改变。");
      return true;
    } catch (failure) {
      if (posted) { updateState({ ...stateRef.current, outcome: "unknown", result: null, blockedCode: null }); setNotice(`登记结果尚未确认：${failureText(failure, "连接中断。")}。这不表示未保存；关闭或重载会保留原命令。`); }
      else setNotice(failureText(failure, "未发送操作，请重试。"));
      return false;
    } finally { if (flightOwner) postingOwners.delete(flightOwner); inFlight.current = false; setBusy(false); }
  }
  async function acknowledge(beforeClear: () => void, onSaved?: SavedCallback) {
    if (inFlight.current || !stateRef.current.pending) return;
    inFlight.current = true; setBusy(true);
    let refresh = false;
    try {
      const record = stateRef.current.pending;
      const owner = await loadMemoryDependencyOwner(); bindOwner(owner);
      if (owner !== record.ownerId) throw new Error("登录身份已变化，未清除原主人的恢复记录。");
      if (postingOwners.has(owner)) throw new Error("原登记仍在等待响应，请等待响应后再结束恢复记录。");
      clearPendingMemoryDependency(sessionStorage, record);
      updateState({ pending: null, outcome: "idle", result: null, blockedCode: null }); beforeClear(); announce(record); refresh = true;
    } catch (failure) { setNotice(failureText(failure, "恢复记录未能结束，请重试。")); }
    finally { inFlight.current = false; setBusy(false); }
    if (refresh) { try { await onSaved?.(); } catch (failure) { setNotice(`本地恢复记录已结束，但列表刷新失败：${failureText(failure, "请手动刷新。")}`); } }
  }
  return { pending, outcome, notice, result, blockedCode, busy, inFlight, ownerRef, bindOwner, restore, send, acknowledge, setNotice, currentState: () => stateRef.current };
}

function MemoryText({ memory, label }: { memory: DependencyMemory; label: string }) {
  return <section aria-label={label} className="space-y-2 rounded-md border p-3 text-sm">
    <p className="font-medium">{label} · {memoryStatusLabel[memory.status] ?? memory.status}</p>
    <p>{memory.subject}</p><p className="whitespace-pre-wrap break-words leading-6">{memory.content}</p>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">记忆编号、版本与来源引用</summary>
      <pre className="mt-2 whitespace-pre-wrap break-all">{`${memory.id}\n${memory.revisionVersion}\n${memory.evidenceRefs.join("\n") || "尚无来源引用"}`}</pre></details>
  </section>;
}

function DependencySnapshotView({ snapshot }: { snapshot: MemoryDependencySnapshot }) {
  return <div className="space-y-3">
    <p role={snapshot.assessment === "current" ? "status" : "alert"} className="text-sm font-medium">{stateLabel[snapshot.assessment]}</p>
    <p className="text-xs text-muted-foreground">仅检查已登记的记忆依据；其他依赖仍未知。引用或记忆正文可读取，不代表原始业务事实已独立核实。</p>
    <section aria-label="关联成果正文" className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">当前成果正文或任务定义</p><p className="whitespace-pre-wrap break-words leading-6">{snapshot.entity.content || "暂无正文"}</p>
      {snapshot.entity.contentTruncated ? <p role="alert" className="text-amber-700">这里的正文已截断。请先在{snapshot.entity.kind === "loop" ? "车间的持续任务详情" : "知识库或原待办详情"}读取完整原文，再核对依据；这里没有展示完整内容。</p> : null}
    </section>
    {snapshot.registry ? <p className="text-xs text-muted-foreground">登记于 {dateLabel(snapshot.registry.createdAt)} · 理由：{snapshot.registry.reason}</p> : null}
    {snapshot.reasons.length ? <ul className="list-disc pl-4 text-sm">{snapshot.reasons.map((reason, index) => <li key={index} className="break-words">{reasonLabel(reason)}</li>)}</ul> : null}
    {snapshot.sources.map(source => <article key={source.memoryId} data-dependency-memory-id={source.memoryId} className="space-y-2 border-t pt-3">
      <p className="text-sm">{stateLabel[source.assessment]} · {source.assessment === "denied" ? "无权读取来源正文" : reasonLabel(source.reason)}</p>
      {source.assessment !== "denied" ? <div className="grid gap-3 md:grid-cols-2">
        {source.oldMemory ? <MemoryText memory={source.oldMemory} label="原登记指向的记忆" /> : <p className="text-sm text-muted-foreground">原依据正文未能读取。</p>}
        {source.currentMemory ? <MemoryText memory={source.currentMemory} label="当前实际依据" /> : <p className="text-sm text-muted-foreground">尚无可核对的当前依据。</p>}
      </div> : null}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">登记的依据编号与版本</summary><pre className="mt-2 whitespace-pre-wrap break-all">{`${source.memoryId}\n${source.expectedVersion}`}</pre></details>
    </article>)}
    {snapshot.sources.length ? <p className="text-xs text-muted-foreground">原始来源正文未在此展开，请通过原有来源入口或原始资料另行核对；无法读取的来源不能视作已核实。</p> : null}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看成果与登记版本</summary><pre className="mt-2 whitespace-pre-wrap break-all">{`${snapshot.entity.id}\n${snapshot.entity.version}\n${snapshot.dependencyVersion}\n${snapshot.registry?.snapshotId ?? "尚未登记"}\n${[...new Set([...snapshot.reasons, ...snapshot.sources.map(source => source.reason)])].join("\n")}`}</pre></details>
  </div>;
}

function MemoryDependencyControl({ entityKind, entityId, onSaved, pendingRecovery, triggerLabel = "查看记忆依据" }: {
  entityKind: MemoryDependencyEntityKind; entityId: string; onSaved?: SavedCallback; pendingRecovery?: PendingMemoryDependency; triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<MemoryDependencySnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reason, setReason] = useState(pendingRecovery?.request.reason ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [memoryIdInput, setMemoryIdInput] = useState("");
  const [selectedMemories, setSelectedMemories] = useState<DependencyMemory[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [refreshedBlocked, setRefreshedBlocked] = useState(false);
  const [missingTargetCommand, setMissingTargetCommand] = useState<string | null>(null);
  const command = useDependencyCommand(pendingRecovery);
  const fieldId = useId();
  const generation = useRef(0);
  const readFlight = useRef(false);
  const lookupFlight = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (command.outcome === "blocked") setRefreshedBlocked(false); }, [command.outcome]);
  async function load() {
    if (readFlight.current || command.inFlight.current) return;
    readFlight.current = true; setReading(true); setReadError(null); setConfirmed(false); setMissingTargetCommand(null);
    const current = ++generation.current;
    try {
      const [observation, owner] = await Promise.all([readSnapshot(entityKind, entityId).then(next => ({ next }), failure => ({ failure })), loadMemoryDependencyOwner()]);
      if (current !== generation.current) return;
      command.bindOwner(owner);
      const stored = readPendingMemoryDependency(sessionStorage, owner);
      const matching = stored?.entityKind === entityKind && stored.entityId === entityId ? stored : null;
      if (matching && command.restore(matching)) setReason(matching.request.reason);
      const live = command.currentState();
      if ("failure" in observation) {
        const record = live.pending ?? matching;
        if (record?.ownerId === owner && observation.failure instanceof DependencyReadError && isMemoryDependencyTargetUnavailable(observation.failure.status, observation.failure.body)) {
          setMissingTargetCommand(record.request.commandId); setSnapshot(null);
        }
        throw observation.failure;
      }
      setSnapshot(observation.next); if (live.outcome === "blocked") setRefreshedBlocked(true);
    } catch (failure) { if (current === generation.current) setReadError(failureText(failure, "依据读取失败。")); }
    finally { if (current === generation.current) { readFlight.current = false; setReading(false); } }
  }
  async function lookupMemory() {
    if (lookupFlight.current || command.inFlight.current || command.pending || reading) return;
    const id = memoryIdInput.trim().toLowerCase();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) { setLookupError("请填写已有记忆的完整编号。"); return; }
    if (selectedMemories.length >= 20) { setLookupError("最多登记 20 条记忆依据。"); return; }
    lookupFlight.current = true; setLookingUp(true); setLookupError(null);
    const current = generation.current;
    try {
      const [raw, owner] = await Promise.all([readJson(`/api/brain/memories/${id}/revision`), loadMemoryDependencyOwner()]); command.bindOwner(owner);
      const body = raw as { memory?: unknown; expectedVersion?: unknown };
      const memory = parseDependencyMemory(body?.memory);
      if (memory.id !== id || body.expectedVersion !== memory.revisionVersion || !memoryUsable(memory)) throw new Error("只可登记已保存、当前有效且未过期的记忆，请先核对或修订记忆。");
      if (current === generation.current) { setSelectedMemories(previous => [...previous.filter(item => item.id !== id), memory]); setMemoryIdInput(""); setConfirmed(false); }
    } catch (failure) { if (current === generation.current) setLookupError(failureText(failure, "记忆读取失败，请重试。")); }
    finally { lookupFlight.current = false; setLookingUp(false); }
  }
  const currentSources = snapshot?.sources.map(source => source.assessment !== "denied" && source.reason !== "source_update_pending" && memoryUsable(source.currentMemory) && source.currentVersion
    ? { memoryId: source.currentMemory!.id, expectedVersion: source.currentVersion } : null) ?? [];
  const canRebind = !!snapshot?.registry && currentSources.length > 0 && currentSources.every((source): source is MemoryDependencySourceRef => !!source);
  const entityUnavailable = !!snapshot && ["deleted", "archived"].includes(snapshot.entity.status);
  const originalNoLongerExecutable = !!command.pending && !!snapshot && (command.pending.request.expectedEntityVersion !== snapshot.entity.version ||
    command.pending.request.expectedDependencyVersion !== snapshot.dependencyVersion);
  const targetUnavailableConfirmed = !!command.pending && missingTargetCommand === command.pending.request.commandId;
  const retryableBusy = command.outcome === "blocked" && command.blockedCode === "memory_write_busy";
  async function submit(action: "register" | "rebind") {
    if (command.inFlight.current || command.pending || !snapshot || reading || lookingUp || readError) return;
    if (entityUnavailable) { command.setNotice("关联成果已停用或归档，不能登记或重新核对依据。"); return; }
    if (!confirmed || !reason.trim() || reason.length > 2000) { command.setNotice("请核对成果正文与来源，并填写不超过 2000 字符的理由。"); return; }
    let sources: MemoryDependencySourceRef[];
    try {
      if (action === "rebind" && !canRebind) throw new Error("所有已登记依据都需有可核对的当前版本；无法读取或待核实的来源不能直接重新登记。");
      sources = normalizeDependencySources(action === "register" ? selectedMemories.map(memory => ({ memoryId: memory.id, expectedVersion: memory.revisionVersion })) : currentSources);
    } catch (failure) { command.setNotice(failureText(failure, "依据不完整。")); return; }
    const owner = command.ownerRef.current;
    if (!owner) { command.setNotice("尚未确认登录身份，请读取当前状态。"); return; }
    if (await command.send({ kind: "memory_dependency_pending.v1", ownerId: owner, entityKind, entityId, request: {
      commandId: crypto.randomUUID(), action, expectedDependencyVersion: snapshot.dependencyVersion, expectedEntityVersion: snapshot.entity.version,
      sources, reason: reason.trim(), evidenceConfirmed: true } })) await load();
  }
  async function retryOriginal() {
    const current = command.currentState();
    if (!current.pending || readFlight.current || command.inFlight.current ||
        !(current.outcome === "unknown" || current.outcome === "blocked" && current.blockedCode === "memory_write_busy" && refreshedBlocked)) return;
    setRefreshedBlocked(false);
    if (await command.send(current.pending)) await load();
  }
  async function endObsoleteRecovery() {
    const pending = command.pending;
    if (!pending || command.inFlight.current || readFlight.current) return;
    readFlight.current = true; setReading(true); setReadError(null);
    try {
      const [observation, owner] = await Promise.all([readSnapshot(entityKind, entityId).then(next => ({ next }), failure => ({ failure })), loadMemoryDependencyOwner()]);
      command.bindOwner(owner);
      if (owner !== pending.ownerId) throw new Error("登录身份已变化，原主人的恢复记录仍保留。");
      if ("failure" in observation) {
        if (observation.failure instanceof DependencyReadError && isMemoryDependencyTargetUnavailable(observation.failure.status, observation.failure.body)) {
          setMissingTargetCommand(pending.request.commandId); setSnapshot(null);
          await command.acknowledge(() => setOpen(false)); return;
        }
        throw observation.failure;
      }
      const current = observation.next; setSnapshot(current); setMissingTargetCommand(null);
      if (current.entity.version === pending.request.expectedEntityVersion && current.dependencyVersion === pending.request.expectedDependencyVersion) {
        command.setNotice("成果与登记版本仍相同，请核对当前状态或重试原命令；恢复记录仍保留。"); return;
      }
      await command.acknowledge(() => setOpen(false));
    } catch (failure) { setReadError(failureText(failure, "无法确认版本变化，原命令已保留。")); }
    finally { readFlight.current = false; setReading(false); }
  }
  return <section aria-label="记忆依据入口" data-dependency-entity-kind={entityKind} data-dependency-entity-id={entityId}>
    <Button type="button" variant="outline" size="sm" onClick={() => { setOpen(true); void load(); }}>{triggerLabel}</Button>
    <Dialog open={open} onOpenChange={next => { if (!next && command.inFlight.current) return; setOpen(next); if (next) void load(); }}>
      <DialogContent className="z-[151] max-h-[90vh] overflow-y-auto sm:max-w-3xl" overlayClassName="z-[150]" hideCloseButton>
        <DialogHeader><DialogTitle>记忆依据核对</DialogTitle><DialogDescription>登记或重新核对这项成果使用的记忆版本。只保存依据及人工决定，正文、待办完成状态和任务授权由原流程管理。</DialogDescription></DialogHeader>
        <div className="flex justify-end"><Button type="button" variant="ghost" disabled={command.busy} onClick={() => setOpen(false)}>关闭</Button></div>
        <p className="text-sm font-medium">{kindLabel[entityKind]} · {snapshot?.entity.title ?? "正在读取成果"}</p>
        {reading ? <p role="status">正在读取成果与记忆依据…</p> : null}
        {readError ? <p role="alert" className="text-sm text-amber-700">{readError}</p> : null}
        {snapshot ? <DependencySnapshotView snapshot={snapshot} /> : null}
        {command.notice ? <p role={command.outcome === "saved" ? "status" : "alert"} className="text-sm whitespace-pre-wrap break-words">{command.notice}</p> : null}
        {command.pending ? <section aria-label="依据登记提交状态" className="space-y-3 rounded-md border p-3 text-sm">
          <p>{command.outcome === "saved" ? "已取得原命令回执；历史回执不能单独证明当前依据仍有效。" : command.outcome === "blocked" ? retryableBusy ? "记忆正在被另一项修改占用，请重新读取后用原命令重试。本次尝试被拒绝，不能据此断言历史请求未保存。" : "本次登记尝试被拒绝，请读取当前状态后结束此提交；此前响应丢失的历史结果仍需核对。" : "原登记结果尚未确认。关闭和同标签页重载会保留原命令，不会生成另一条登记。"}</p>
          <details className="text-xs"><summary className="cursor-pointer">查看原登记命令</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(command.pending.request, null, 2)}</pre></details>
          {command.result ? <details className="text-xs"><summary className="cursor-pointer">查看登记回执</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(command.result.receipt, null, 2)}</pre></details> : null}
          <div className="flex flex-wrap gap-2">
            {command.outcome === "unknown" || retryableBusy ? <Button type="button" disabled={command.busy || reading || retryableBusy && !refreshedBlocked} onClick={() => void retryOriginal()}>重试原登记</Button> : null}
            <Button type="button" variant="outline" disabled={command.busy || reading} onClick={() => void load()}>重新读取依据状态</Button>
            {command.outcome === "saved" || command.outcome === "blocked" ? <Button type="button" disabled={command.busy || reading || command.outcome === "blocked" && !refreshedBlocked} onClick={() => void command.acknowledge(() => setOpen(false), onSaved)}>完成并刷新依据状态</Button> : null}
          </div>
          {(command.outcome === "unknown" && originalNoLongerExecutable || targetUnavailableConfirmed) ? <div className="space-y-2">
            <p>{targetUnavailableConfirmed ? "目标已不可用，可仅结束本地恢复；历史可能已保存，审计保留。" : "当前成果或登记版本已变化，原版本不能再执行。可仅结束本地恢复；原请求历史结果仍未知，历史审计保留。"}</p>
            <Button type="button" variant="outline" disabled={command.busy || reading} onClick={() => void endObsoleteRecovery()}>关闭并结束此次依据恢复</Button>
          </div> : null}
        </section> : snapshot ? <section aria-label="记忆依据登记操作" className="space-y-3 rounded-md border p-3 text-sm">
          {!snapshot.registry ? <div className="space-y-2">
            <label htmlFor={`${fieldId}-memory`} className="block space-y-1"><span>已有记忆编号</span><input id={`${fieldId}-memory`} className={fieldClass} value={memoryIdInput} disabled={command.busy || lookingUp || reading} onChange={event => setMemoryIdInput(event.target.value)} placeholder="从记忆详情复制完整编号" /></label>
            <Button type="button" variant="outline" disabled={command.busy || lookingUp || reading || !memoryIdInput.trim()} onClick={() => void lookupMemory()}>读取实际版本并加入</Button>
            {lookingUp ? <p role="status">正在核对已有记忆…</p> : null}{lookupError ? <p role="alert">{lookupError}</p> : null}
            {selectedMemories.map(memory => <div key={memory.id} data-selected-dependency-memory={memory.id} className="space-y-2 rounded-md border p-2">
              <MemoryText memory={memory} label="拟登记依据" /><Button type="button" variant="ghost" disabled={command.busy || reading || lookingUp} onClick={() => { setSelectedMemories(previous => previous.filter(item => item.id !== memory.id)); setConfirmed(false); }}>移除此条依据</Button>
            </div>)}
          </div> : <p>重新登记将完整采用上方已登记各条依据的当前实际版本；不会重新启用旧记忆或删除其它登记来源。</p>}
          <label htmlFor={`${fieldId}-reason`} className="block space-y-1"><span>依据核对理由</span><textarea id={`${fieldId}-reason`} className={`${fieldClass} min-h-20 resize-y`} maxLength={2000} value={reason} disabled={command.busy || reading || lookingUp} onChange={event => setReason(event.target.value)} /></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={command.busy || reading || lookingUp} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对成果正文与来源，确认所列记忆版本适用</span></label>
          <Button type="button" disabled={command.busy || reading || lookingUp || !!readError || entityUnavailable || !confirmed || !reason.trim() || (snapshot.registry ? !canRebind : selectedMemories.length === 0)} onClick={() => void submit(snapshot.registry ? "rebind" : "register")}>{snapshot.registry ? "确认采用当前依据版本" : "登记所选记忆依据"}</Button>
          {entityUnavailable ? <p className="text-amber-700">关联成果已停用或归档，不能登记或重新核对依据；这里只保留正文与历史状态供核对。</p> : null}
          {snapshot.registry && !canRebind ? <p className="text-amber-700">当前依据未能完整核对，请先修复访问权限或核实记忆；这里不能绕过受限、停用或待核实来源。</p> : null}
          {snapshot.sources.some(source => source.reason === "source_update_pending") ? <p className="text-amber-700">来源有待审的记忆更新提案，请先在“查看记忆更新提案”中接受或拒绝，再重新读取依据。</p> : null}
        </section> : null}
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={command.busy || reading} onClick={() => void load()}>读取当前依据</Button><Button type="button" variant="outline" disabled={command.busy} onClick={() => setOpen(false)}>关闭依据核对</Button></div>
      </DialogContent>
    </Dialog>
  </section>;
}

export function MemoryDependencyPanel(props: { entityKind: MemoryDependencyEntityKind; entityId: string; onSaved?: SavedCallback }) {
  return <MemoryDependencyControl key={`${props.entityKind}:${props.entityId}`} {...props} />;
}

export function MemoryDependencyRecovery({ onSaved }: { onSaved?: SavedCallback }) {
  const [pending, setPending] = useState<PendingMemoryDependency | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const restore = async () => {
      const current = ++generation;
      try { const owner = await loadMemoryDependencyOwner(); const record = readPendingMemoryDependency(sessionStorage, owner);
        if (live && current === generation) { setPending(record); setError(null); } }
      catch (failure) { if (live && current === generation) { setPending(null); setError(failureText(failure, "依据恢复记录读取失败。")); } }
    };
    const changed = () => void restore();
    void restore(); window.addEventListener(MEMORY_DEPENDENCY_PENDING_EVENT, changed);
    return () => { live = false; window.removeEventListener(MEMORY_DEPENDENCY_PENDING_EVENT, changed); };
  }, [reload]);
  if (error) return <section role="alert" aria-label="依据恢复读取错误" className="space-y-2 rounded-md border p-3 text-sm"><p>{error}</p><Button type="button" variant="outline" onClick={() => setReload(value => value + 1)}>重新读取依据恢复记录</Button></section>;
  if (!pending) return null;
  return <section aria-label="记忆依据登记恢复" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
    <p>有一条记忆依据登记等待回执核对；即使原成果退出列表，仍可核对原命令。</p>
    <MemoryDependencyControl key={pending.request.commandId} entityKind={pending.entityKind} entityId={pending.entityId} pendingRecovery={pending} triggerLabel="恢复依据登记" onSaved={onSaved} />
  </section>;
}

export function MemoryDependencyImpactList({ sourceMemoryId, workId, onSaved, showRecovery = true }: { sourceMemoryId?: string; workId?: string; onSaved?: SavedCallback; showRecovery?: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MemoryDependencySnapshot["entity"][] | null>(null);
  const [assessments, setAssessments] = useState<Record<string, MemoryDependencySnapshot["assessment"]>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readFlight = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function load(nextCursor?: string) {
    if (readFlight.current) return;
    readFlight.current = true; setLoading(true); setError(null);
    const current = ++generation.current;
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (sourceMemoryId) params.set("sourceMemoryId", sourceMemoryId);
      if (workId) params.set("workId", workId);
      if (nextCursor) params.set("cursor", nextCursor);
      const body = await readJson(`/api/brain/memory-dependencies?${params}`) as { items?: unknown[]; nextCursor?: unknown; hasMore?: unknown; coverage?: unknown; truncated?: unknown };
      if (!Array.isArray(body?.items) || body.items.length > 20 || body.coverage !== "recorded" || typeof body.hasMore !== "boolean" || typeof body.truncated !== "boolean" ||
          body.nextCursor !== null && typeof body.nextCursor !== "string" || body.hasMore && !body.nextCursor) throw new Error("影响列表覆盖信息不完整，请重新读取。");
      const entities: MemoryDependencySnapshot["entity"][] = [];
      const states: Record<string, MemoryDependencySnapshot["assessment"]> = {};
      for (const item of body.items) {
        const value = item as { entity?: MemoryDependencySnapshot["entity"]; assessment?: MemoryDependencySnapshot["assessment"] };
        if (!value?.entity || !["wiki_note", "interaction_task", "loop"].includes(value.entity.kind) || !/^[a-f0-9-]{36}$/i.test(value.entity.id) ||
            typeof value.entity.title !== "string" || !["unknown", "current", "stale", "denied"].includes(value.assessment ?? "")) throw new Error("关联成果信息不完整，请重新读取。");
        entities.push(value.entity); states[`${value.entity.kind}:${value.entity.id}`] = value.assessment!;
      }
      if (current === generation.current) {
        setItems(previous => nextCursor ? [...new Map([...(previous ?? []), ...entities].map(entity => [`${entity.kind}:${entity.id}`, entity])).values()] : entities);
        setAssessments(previous => nextCursor ? { ...previous, ...states } : states); setCursor(body.nextCursor as string | null); setHasMore(body.hasMore);
      }
    } catch (failure) { if (current === generation.current) setError(failureText(failure, "影响列表读取失败。")); }
    finally { if (current === generation.current) { readFlight.current = false; setLoading(false); } }
  }
  async function afterSaved() { await load(); await onSaved?.(); }
  return <div className="space-y-3">
    {showRecovery ? <MemoryDependencyRecovery onSaved={afterSaved} /> : null}
    <section aria-label="记忆更新影响列表" className="rounded-md border p-3 text-sm">
      <button type="button" aria-expanded={open} className="w-full text-left font-medium" onClick={() => { const next = !open; setOpen(next); if (next && items === null) void load(); }}>{open ? "收起记忆更新影响" : "查看记忆更新影响"}</button>
      {open ? <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">这里只展示已登记的依赖关系，每次读取最多 20 项；没有登记的历史成果仍未知，列表不能代表完整影响范围。</p>
        {loading ? <p role="status">正在读取已登记的记忆影响…</p> : null}{error ? <p role="alert" className="text-amber-700">{error}</p> : null}
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>刷新记忆更新影响</Button>
        {!loading && items?.length === 0 ? <p>尚无已登记的关联成果；无法据此断言没有影响。</p> : null}
        {items?.map(entity => <article key={`${entity.kind}:${entity.id}`} data-dependency-impact-kind={entity.kind} data-dependency-impact-id={entity.id} className="space-y-2 border-t pt-3">
          <p className="font-medium">{kindLabel[entity.kind]} · {entity.title}</p><p>{stateLabel[assessments[`${entity.kind}:${entity.id}`]]}</p>
          <MemoryDependencyPanel entityKind={entity.kind} entityId={entity.id} onSaved={afterSaved} />
        </article>)}
        {hasMore && cursor ? <Button type="button" variant="outline" disabled={loading} onClick={() => void load(cursor)}>加载更多已登记关系</Button> : null}
      </div> : null}
    </section>
  </div>;
}
