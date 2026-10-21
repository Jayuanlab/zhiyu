"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@openzhiyu/ui";
import { MemoryEvidenceViewer } from "@/components/memory-evidence-viewer";
import { MemoryCorrectionDraftControl } from "@/components/memory-correction-draft";
import {
  canSeedMemoryCorrection, clearPendingMemoryCorrection, MEMORY_CORRECTION_PENDING_EVENT,
  readPendingMemoryCorrection, type PendingMemoryCorrection,
} from "@/components/memory-correction-recovery";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  canEndMemoryReviewRecovery, clearPendingMemoryReview, clearPendingMemoryRevision, loadMemoryRevisionOwner, MEMORY_REVISION_PENDING_EVENT,
  persistPendingMemoryReview, persistPendingMemoryRevision, readPendingMemoryReview, readPendingMemoryRevision,
  type PendingMemoryReview, type PendingMemoryRevision, type RevisionAuthority, type RevisionOperation, type RevisionRequest,
} from "@/components/memory-revision-recovery";

type RevisionMemory = {
  id: string;
  subject: string;
  content: string;
  status: string;
  memoryType: string;
  scope: { type: string; [key: string]: unknown };
  evidenceRefs: string[];
  revisionVersion?: string;
  expiresAt?: string;
  metadata?: {
    revision?: { commandId?: string; previousMemoryId?: string };
    admission?: { requiresOwnerVerification?: boolean };
    updateProposal?: unknown;
    revisionRetired?: { nextMemoryId?: string | null; operation?: string };
  };
};
type MemorySnapshot = {
  memory: RevisionMemory;
  expectedVersion: string;
  history?: Array<Pick<RevisionMemory, "id" | "subject" | "content" | "status" | "evidenceRefs" | "expiresAt"> & { reason?: string | null; createdAt?: string }>;
  historyTruncated?: boolean;
  historyWarning?: { code: string; message: string };
};
type RevisionResult = {
  commandId: string;
  operation: RevisionOperation;
  oldMemory: RevisionMemory;
  newMemory: RevisionMemory | null;
  receipt: {
    id: string;
    commandId: string;
    status: "applied" | "pending_verification";
    effective: boolean;
    previousVersion: string;
    currentVersion: string;
    newVersion: string | null;
    oldMemoryId: string;
    newMemoryId: string | null;
    createdAt: string;
  };
};

const OPERATION_LABELS: Record<RevisionOperation, string> = {
  correct: "纠正内容",
  supplement: "补充内容",
  state_change: "状态变化",
  deactivate: "停用记忆",
  restore: "恢复为新版本",
};
const fieldClass = "w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
const OWNER_ACTIVE_TYPES = new Set(["preference", "relationship", "plan", "task", "insight"]);
const SCOPE_LABELS: Record<string, string> = { global: "全局", workspace: "工作区", workshop: "车间", work: "智能体" };
const TYPE_LABELS: Record<string, string> = {
  fact: "事实", preference: "偏好", plan: "计划", boundary: "边界", relationship: "关系", task: "任务", insight: "经验", system: "系统",
};

function formatRevisionDate(value?: string) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "时间未知";
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function isEffectiveMemory(memory: RevisionMemory) {
  return ["active", "verified", "weakened"].includes(memory.status) &&
    (!memory.expiresAt || new Date(memory.expiresAt).getTime() > Date.now());
}

function isRevisionCandidate(memory: RevisionMemory) {
  return memory.status === "candidate" && !memory.metadata?.updateProposal &&
    (!!memory.metadata?.revision || memory.metadata?.admission?.requiresOwnerVerification === true);
}

function hasPendingMemoryUpdate(memory: RevisionMemory) {
  const proposal = memory.metadata?.updateProposal;
  return !!proposal && typeof proposal === "object" && "status" in proposal && proposal.status === "pending";
}

function memoryStatusLabel(memory: Pick<RevisionMemory, "status" | "expiresAt">) {
  if (memory.expiresAt && new Date(memory.expiresAt).getTime() <= Date.now()) return "已过期，暂不参与正常召回";
  return ({candidate: "待核实", active: "有效记忆", verified: "已核实", weakened: "已降低可信程度", superseded: "已有替代版本", deleted: "已停用"} as Record<string, string>)[memory.status] ?? memory.status;
}

function revisionUrl(memoryId: string) {
  return `/api/memory/memories/${encodeURIComponent(memoryId)}/revision`;
}

async function readSnapshot(memoryId: string): Promise<MemorySnapshot> {
  const response = await fetch(revisionUrl(memoryId), { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404) throw new Error("未找到可纠错的统一记忆，请刷新列表或核对原始来源。");
    throw new Error(typeof body?.error === "string" ? body.error : "当前记忆读取失败，请重试。");
  }
  if (body?.memory?.id !== memoryId || typeof body.memory.content !== "string" ||
      !Array.isArray(body.memory.evidenceRefs) || typeof body.expectedVersion !== "string" || !body.expectedVersion) {
    throw new Error("未取得完整的当前版本，暂不能提交纠错。请重新读取。");
  }
  return body;
}

function validReceipt(body: any, request: RevisionRequest, memoryId: string): body is RevisionResult {
  const receipt = body?.receipt;
  if (body?.commandId !== request.commandId || body.operation !== request.operation ||
      body.oldMemory?.id !== memoryId || receipt?.commandId !== request.commandId ||
      receipt.oldMemoryId !== memoryId || typeof receipt.id !== "string" || !receipt.id ||
      receipt.previousVersion !== request.expectedVersion ||
      typeof body.oldMemory.revisionVersion !== "string" || !body.oldMemory.revisionVersion ||
      receipt.currentVersion !== body.oldMemory.revisionVersion ||
      body.oldMemory.status !== (request.operation === "deactivate" ? "deleted" : "superseded") ||
      typeof receipt.effective !== "boolean" || !["applied", "pending_verification"].includes(receipt.status)) return false;
  if (request.operation === "deactivate") return body.newMemory === null && receipt.newMemoryId === null &&
    receipt.newVersion === null && receipt.status === "applied";
  return typeof body.newMemory?.id === "string" && body.newMemory.content === request.content &&
    typeof body.newMemory.revisionVersion === "string" && !!body.newMemory.revisionVersion &&
    receipt.newVersion === body.newMemory.revisionVersion &&
    receipt.newMemoryId === body.newMemory.id &&
    (receipt.status === "pending_verification"
      ? body.newMemory.status === "candidate" && receipt.effective === false
      : ["active", "verified"].includes(body.newMemory.status));
}

export function MemoryRevisionControl({ memoryId, onSaved, pendingRecovery, pendingReviewRecovery, correctionRecovery, onDialogOpenChange, triggerLabel }: {
  memoryId: string;
  onSaved?: () => void | Promise<void>;
  pendingRecovery?: PendingMemoryRevision;
  pendingReviewRecovery?: PendingMemoryReview;
  correctionRecovery?: PendingMemoryCorrection;
  onDialogOpenChange?: (open: boolean) => void;
  triggerLabel?: string;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [activeMemoryId, setActiveMemoryId] = useState(memoryId);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [operation, setOperation] = useState<RevisionOperation>("correct");
  const [authority, setAuthority] = useState<RevisionAuthority | "">("external_fact");
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<RevisionRequest | null>(pendingRecovery?.request ?? null);
  const [result, setResult] = useState<RevisionResult | null>(null);
  const [newSnapshot, setNewSnapshot] = useState<MemorySnapshot | null>(null);
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
  const [reviewReason, setReviewReason] = useState("");
  const [reviewUnknown, setReviewUnknown] = useState(!!pendingRecovery?.reviewPending || !!pendingReviewRecovery);
  const [reviewSaved, setReviewSaved] = useState(false);
  const [reviewCanEnd, setReviewCanEnd] = useState(false);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const correctionBusyRef = useRef(false);
  const [correctionSeedVersion, setCorrectionSeedVersion] = useState<string | null>(null);
  const correctionSeed = useRef<PendingMemoryCorrection | null>(null);
  const completedRevision = useRef<{ memoryId: string; request: RevisionRequest } | null>(null);
  const inFlight = useRef(false);
  const requestRef = useRef<RevisionRequest | null>(pendingRecovery?.request ?? null);
  const requestMemoryId = useRef(memoryId);
  const ownerRef = useRef<string | null>(pendingRecovery?.ownerId ?? pendingReviewRecovery?.ownerId ?? null);
  const storedReviewRef = useRef<PendingMemoryReview | null>(pendingReviewRecovery ?? null);
  const storedCommandId = useRef<string | null>(pendingRecovery?.request.commandId ?? null);
  const savedRef = useRef(false);
  const loadGeneration = useRef(0);
  const locked = busy || correctionBusy || !!pending || !!result || reviewUnknown;

  function updateCorrectionBusy(value: boolean) {
    correctionBusyRef.current = value; setCorrectionBusy(value);
  }

  function clearCompletedCorrectionDraft() {
    const completed = completedRevision.current;
    if (completed && ownerRef.current) {
      const draft = readPendingMemoryCorrection(sessionStorage, ownerRef.current);
      if (draft?.memoryId === completed.memoryId && draft.request.expectedVersion === completed.request.expectedVersion &&
          draft.result && draft.result.draft.evidenceRefs.every(ref => completed.request.evidenceRefs.includes(ref))) {
        clearPendingMemoryCorrection(sessionStorage, draft);
      }
    }
    correctionSeed.current = null; setCorrectionSeedVersion(null); completedRevision.current = null;
  }

  async function loadCurrent(preserveDraft = false) {
    if (inFlight.current || requestRef.current) return;
    const generation = ++loadGeneration.current;
    setBusy(true);
    setSnapshot(null);
    setNotice(null);
    try {
      const [current, owner] = await Promise.all([readSnapshot(activeMemoryId), loadMemoryRevisionOwner()]);
      if (generation !== loadGeneration.current) return;
      ownerRef.current = owner;
      setSnapshot(current);
      const storedReview = readPendingMemoryReview(sessionStorage, owner);
      if (storedReview?.memoryId === current.memory.id) {
        storedReviewRef.current = storedReview;
        const original = readPendingMemoryRevision(sessionStorage, owner);
        if (original && original.request.commandId === current.memory.metadata?.revision?.commandId) {
          storedCommandId.current = original.request.commandId;
        }
        reconcileReviewSnapshot(current, storedReview);
      }
      const seeded = correctionSeed.current;
      if (seeded && (seeded.memoryId !== current.memory.id || seeded.request.expectedVersion !== current.expectedVersion)) {
        setConflict(true);
        setNotice("已读取当前版本；原纠错草稿仍绑定旧版本，未改用新的校验版本。请放弃原草稿后核对当前记忆再手填或重新生成。");
        return;
      }
      if (!preserveDraft && !seeded) {
        setAuthority(OWNER_ACTIVE_TYPES.has(current.memory.memoryType) ? "owner_statement" : "external_fact");
        setOperation(current.memory.status === "deleted" &&
          current.memory.metadata?.revisionRetired?.operation === "deactivate" &&
          current.memory.metadata.revisionRetired.nextMemoryId === null ? "restore" : "correct");
        setContent(current.memory.content);
        setEvidence(current.memory.evidenceRefs.join("\n"));
        setReason("");
        setObservedAt("");
      } else setNotice("已读取最新版本，原修改草稿已保留。请核对当前内容和来源后重新提交。");
      setConflict(false);
    } catch (error) {
      if (generation === loadGeneration.current) setNotice(error instanceof Error ? error.message : "读取失败。");
    } finally {
      if (generation === loadGeneration.current) setBusy(false);
    }
  }

  function clearStoredRequest() {
    if (!ownerRef.current || !storedCommandId.current) return;
    clearPendingMemoryRevision(sessionStorage, ownerRef.current, storedCommandId.current);
    storedCommandId.current = null;
    window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
  }

  function clearLegacyReviewMarker() {
    if (!ownerRef.current) return;
    const stored = readPendingMemoryRevision(sessionStorage, ownerRef.current);
    if (stored?.request.commandId !== storedCommandId.current || !stored.reviewPending) return;
    const { reviewPending: _review, ...withoutReview } = stored;
    persistPendingMemoryRevision(sessionStorage, withoutReview);
    window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
  }

  function clearStoredReviewMarker() {
    if (storedReviewRef.current) {
      clearPendingMemoryReview(sessionStorage, storedReviewRef.current);
      storedReviewRef.current = null;
    }
    clearLegacyReviewMarker();
    window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
  }

  function currentReviewTarget() {
    if (storedReviewRef.current) return storedReviewRef.current;
    if (!ownerRef.current) return null;
    const standalone = readPendingMemoryReview(sessionStorage, ownerRef.current);
    if (standalone) { storedReviewRef.current = standalone; return standalone; }
    const legacy = readPendingMemoryRevision(sessionStorage, ownerRef.current);
    return legacy?.request.commandId === storedCommandId.current ? legacy.reviewPending ?? null : null;
  }

  function reconcileReviewSnapshot(current: MemorySnapshot, target = currentReviewTarget()) {
    if (!target || target.memoryId !== current.memory.id) return;
    setReviewCanEnd(false);
    setEvidenceConfirmed(false);
    if (current.memory.status === "verified") {
      clearLegacyReviewMarker();
      setReviewUnknown(false); setReviewSaved(true); savedRef.current = true;
      setNotice(isEffectiveMemory(current.memory) ? "已核对当前版本，记忆已启用；下一轮实际使用情况尚待验证。" : "核实已保存；当前版本已过期，暂不参与正常召回。");
    } else if (isRevisionCandidate(current.memory) && target.expectedVersion === current.expectedVersion) {
      clearLegacyReviewMarker();
      setReviewUnknown(false); setReviewReason("");
      setNotice("当前仍待核实，可重新核对来源后提交；若原审核随后完成，版本校验会阻止重复。当前状态不代表原请求已经失败。");
    } else {
      setReviewUnknown(true);
      if (storedReviewRef.current) setReviewCanEnd(canEndMemoryReviewRecovery(storedReviewRef.current, {
        memoryId: current.memory.id, expectedVersion: current.expectedVersion, status: current.memory.status,
      }));
      setNotice("当前版本或状态已有变化，尚不能确认原审核结果。请按下方当前状态核对，保留原审核记录。");
    }
  }

  async function loadReplacement() {
    const nextId = snapshot?.memory.metadata?.revisionRetired?.nextMemoryId;
    if (!nextId || busy || requestRef.current) return;
    try {
      const draft = ownerRef.current ? readPendingMemoryCorrection(sessionStorage, ownerRef.current) : null;
      if (draft?.memoryId === snapshot.memory.id) {
        setNotice("原纠错草稿仍绑定这条旧记忆，请先核对并放弃草稿，再读取当前替代版本。不会把旧草稿直接转给新版本。"); return;
      }
    } catch { setNotice("纠错草稿暂存无法核对，请先通过恢复入口处理原草稿。"); return; }
    setBusy(true); setNotice(null);
    try {
      let current = await readSnapshot(nextId);
      const visited = new Set([snapshot.memory.id]);
      for (let hops = 0; current.memory.status === "superseded" && hops < 16; hops++) {
        const successor = current.memory.metadata?.revisionRetired?.nextMemoryId;
        if (!successor || visited.has(current.memory.id)) throw new Error("无法定位当前替代版本，请重新搜索统一记忆。");
        visited.add(current.memory.id);
        current = await readSnapshot(successor);
      }
      if (current.memory.status === "superseded") throw new Error("版本链尚未定位到有效条目，请重新搜索统一记忆。");
      setActiveMemoryId(current.memory.id); setSnapshot(current); setConflict(false);
      setNotice("已读取当前替代版本，原修改草稿已保留。请核对内容和来源后重新提交。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "替代版本读取失败。"); }
    finally { setBusy(false); }
  }

  function changeOpen(next: boolean) {
    if (inFlight.current) return;
    setOpen(next);
    onDialogOpenChange?.(next);
    if (next && !requestRef.current && !result) void loadCurrent();
    if (!next) {
      ++loadGeneration.current;
      setBusy(false);
      try {
        if (!reviewUnknown) clearStoredReviewMarker();
        if (savedRef.current && (!reviewUnknown || storedReviewRef.current)) clearStoredRequest();
        if (savedRef.current && completedRevision.current) clearCompletedCorrectionDraft();
      } catch { setNotice("保存状态已保留，但恢复记录未清除。请通过恢复入口继续核对。"); }
      window.dispatchEvent(new Event(MEMORY_CORRECTION_PENDING_EVENT));
      if (savedRef.current) {
        savedRef.current = false;
        Promise.resolve().then(() => onSaved?.()).catch(() => setNotice("记忆已保存，列表刷新失败。请手动刷新列表。"));
      }
    }
  }

  async function sendRevision(request: RevisionRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    requestRef.current = request;
    setPending(request);
    setBusy(true);
    setNotice(null);
    let prepared = false;
    try {
      const owner = await loadMemoryRevisionOwner();
      if (owner !== ownerRef.current) {
        requestRef.current = null; setPending(null); setSnapshot(null); setResult(null); setOpen(false);
        setNotice("当前登录身份已变化，原用户更新未发送。请刷新页面后重新核对。");
        window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
        return;
      }
      if (readPendingMemoryReview(sessionStorage, owner)) throw new Error("还有一条记忆核实等待结果核对，请先通过恢复入口处理。");
      const existingRecovery = readPendingMemoryRevision(sessionStorage, owner);
      const recovery: PendingMemoryRevision = { kind: "memory_revision_pending.v1", ownerId: owner,
        memoryId: requestMemoryId.current, request,
        ...(existingRecovery?.request.commandId === request.commandId && existingRecovery.reviewPending
          ? { reviewPending: existingRecovery.reviewPending } : {}) };
      if (recovery.reviewPending) setReviewUnknown(true);
      persistPendingMemoryRevision(sessionStorage, recovery);
      storedCommandId.current = request.commandId;
      prepared = true;
      window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
      const response = await fetch(revisionUrl(requestMemoryId.current), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          requestRef.current = null;
          setPending(null);
          clearStoredRequest();
          if (response.status === 409) {
            setConflict(true);
            setNotice("当前版本或提交记录已变化，未覆盖原内容。请刷新当前记忆，核对后重新提交。");
          } else setNotice(typeof body?.error === "string" ? body.error : "提交被拒绝，未收到保存回执。");
          return;
        }
        throw new Error("未取得保存回执。");
      }
      if (!validReceipt(body, request, requestMemoryId.current)) throw new Error("保存回执与本次提交不一致。");
      requestRef.current = null;
      setPending(null);
      setResult(body);
      completedRevision.current = { memoryId: requestMemoryId.current, request };
      savedRef.current = true;
    } catch (error) {
      if (!prepared) {
        requestRef.current = null; setPending(null);
        setNotice(error instanceof Error ? `${error.message} 本次更新未发送。` : "无法保存恢复记录，本次更新未发送。");
      } else setNotice("暂未确认是否保存。请重试原提交；内容与提交编号将保持一致，不会另建一条纠错。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || correctionBusyRef.current || !snapshot || locked || conflict) return;
    if (correctionSeed.current && (correctionSeed.current.memoryId !== snapshot.memory.id || correctionSeed.current.request.expectedVersion !== snapshot.expectedVersion)) {
      setNotice("原纠错草稿绑定的记忆版本已变化，请放弃草稿后核对当前版本；未发送更新。"); return;
    }
    if (authority !== "owner_statement" && authority !== "external_fact") { setNotice("请明确选择信息来源；草稿整理不代表来源已核实。"); return; }
    if (!reason.trim()) { setNotice("请填写修改理由。"); return; }
    if (operation !== "deactivate" && !content.trim()) { setNotice("请填写新版本的完整内容。"); return; }
    const evidenceRefs = [...new Set(evidence.split(/\r?\n/).map(ref => ref.trim()).filter(Boolean))];
    if (correctionSeed.current?.result?.draft.evidenceRefs.some(ref => !evidenceRefs.includes(ref))) {
      setNotice("采用纠错草稿时须保留系统记录的原话引用，以便追溯。请恢复该引用；其它来源可按预算核对。"); return;
    }
    if (evidenceRefs.length > 101 || evidenceRefs.some(ref => ref.length > 2048)) {
      setNotice("来源引用最多 101 条，每条不超过 2048 字符。"); return;
    }
    const sourceObservedAt = observedAt ? new Date(observedAt) : null;
    if (sourceObservedAt && !Number.isFinite(sourceObservedAt.getTime())) { setNotice("来源观测时间无效，请重新填写。"); return; }
    try { if (storedReviewRef.current) clearStoredReviewMarker(); }
    catch { setNotice("审核恢复记录未清除，本次更新未发送。请先核对原审核。"); return; }
    const request: RevisionRequest = {
      commandId: crypto.randomUUID(), expectedVersion: snapshot.expectedVersion,
      operation, authority, reason: reason.trim(),
      ...(operation !== "deactivate" ? { content: content.trim() } : {}),
      evidenceRefs,
      ...(operation === "state_change" && sourceObservedAt ? { sourceObservedAt: sourceObservedAt.toISOString() } : {}),
    };
    requestMemoryId.current = snapshot.memory.id;
    void sendRevision(request);
  }

  async function adoptCorrection(record: PendingMemoryCorrection) {
    if (inFlight.current || requestRef.current || result || reviewUnknown) throw new Error("请先完成原修订或审核的结果核对。");
    const generation = loadGeneration.current;
    const [current, owner] = await Promise.all([readSnapshot(record.memoryId), loadMemoryRevisionOwner()]);
    if (generation !== loadGeneration.current) throw new Error("窗口已关闭或当前读取已变化，未采用草稿。");
    if (owner !== ownerRef.current || owner !== record.ownerId) throw new Error("登录身份已变化，未采用原用户草稿。");
    if (readPendingMemoryRevision(sessionStorage, owner) || readPendingMemoryReview(sessionStorage, owner)) throw new Error("请先处理已有修订或核实恢复记录。");
    if (!canSeedMemoryCorrection(record, current.memory.id, current.expectedVersion) || hasPendingMemoryUpdate(current.memory)) {
      setSnapshot(current); setConflict(true);
      throw new Error("原草稿依据版本或状态已变化，未填入建议。请放弃草稿后核对当前版本再手填或重新生成。");
    }
    const draft = record.result!.draft;
    correctionSeed.current = record; setCorrectionSeedVersion(record.request.expectedVersion);
    setSnapshot(current); setConflict(false);
    setOperation(draft.operation!); setContent(draft.content ?? ""); setReason(draft.reason!);
    setAuthority(""); setObservedAt("");
    const refs = [...new Set([...current.memory.evidenceRefs, ...draft.evidenceRefs])];
    setEvidence(refs.join("\n"));
    setNotice(refs.length > 101
      ? "草稿已填入，但来源超过 101 条预算。请核对原引用，保留原话引用后再保存；尚未更新记忆。"
      : "草稿已填入；请核对完整正文、更新方式和理由，并明确选择信息来源后保存。尚未更新记忆。");
  }

  async function discardCorrection() {
    correctionSeed.current = null; setCorrectionSeedVersion(null); setConflict(false);
    await loadCurrent();
  }

  async function viewNewVersion() {
    const targetId = result?.newMemory?.id ?? storedReviewRef.current?.memoryId ?? snapshot?.memory.id;
    if (!targetId || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const current = await readSnapshot(targetId);
      if (result) setNewSnapshot(current); else setSnapshot(current);
      setEvidenceConfirmed(false);
      if (reviewUnknown) reconcileReviewSnapshot(current);
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "新版本读取失败。"); }
    finally { setBusy(false); }
  }

  function reviseCurrentVersion() {
    if (!newSnapshot || busy || reviewUnknown) return;
    try { clearStoredReviewMarker(); clearStoredRequest(); clearCompletedCorrectionDraft(); }
    catch { setNotice("恢复记录未清除，请先完成原回执核对。"); return; }
    setActiveMemoryId(newSnapshot.memory.id);
    setSnapshot(newSnapshot);
    setContent(newSnapshot.memory.content);
    setEvidence(newSnapshot.memory.evidenceRefs.join("\n"));
    setReason(""); setObservedAt(""); setNotice(null); setConflict(false);
    setResult(null); setNewSnapshot(null); setReviewSaved(false);
    setReviewReason(""); setEvidenceConfirmed(false);
  }

  async function restoreDeactivatedVersion() {
    if (!result || result.operation !== "deactivate" || busy) return;
    setBusy(true); setNotice(null);
    try {
      const current = await readSnapshot(result.oldMemory.id);
      if (current.memory.status !== "deleted" || current.memory.metadata?.revisionRetired?.operation !== "deactivate" ||
          current.memory.metadata.revisionRetired.nextMemoryId !== null) throw new Error("该历史版本已有后续变化，请核对当前版本。");
      clearStoredRequest();
      clearCompletedCorrectionDraft();
      setActiveMemoryId(current.memory.id); setSnapshot(current); setContent(current.memory.content);
      setEvidence(current.memory.evidenceRefs.join("\n")); setOperation("restore");
      setReason(""); setObservedAt(""); setResult(null); setNewSnapshot(null); setConflict(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : "当前版本读取失败。"); }
    finally { setBusy(false); }
  }

  async function confirmNewVersion() {
    const target = result ? newSnapshot : snapshot;
    if (!target || !isRevisionCandidate(target.memory) || !evidenceConfirmed ||
        !reviewReason.trim() || !target.memory.evidenceRefs.length || inFlight.current || reviewUnknown) return;
    inFlight.current = true;
    setBusy(true); setNotice(null);
    let prepared = false;
    try {
      const owner = await loadMemoryRevisionOwner();
      if (owner !== ownerRef.current) {
        setSnapshot(null); setResult(null); setNewSnapshot(null); setOpen(false);
        window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
        return;
      }
      const stored = readPendingMemoryRevision(sessionStorage, owner);
      if (stored && stored.request.commandId !== target.memory.metadata?.revision?.commandId) {
        throw new Error("还有一条更新等待回执，请先通过恢复入口处理原提交。");
      }
      if (stored) storedCommandId.current = stored.request.commandId;
      const reviewMarker: PendingMemoryReview = { kind: "memory_revision_review_pending.v1", ownerId: owner,
        memoryId: target.memory.id, expectedVersion: target.expectedVersion };
      persistPendingMemoryReview(sessionStorage, reviewMarker);
      storedReviewRef.current = reviewMarker;
      prepared = true;
      window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
      const response = await fetch(`/api/memory/candidates/${encodeURIComponent(target.memory.id)}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ decision: "confirmed", expectedVersion: target.expectedVersion,
          evidenceConfirmed: true, reason: reviewReason.trim() }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok && [400, 401, 403, 404, 409].includes(response.status)) {
        clearStoredReviewMarker();
        setEvidenceConfirmed(false);
        if (result) setNewSnapshot(null); else setSnapshot(null);
        setNotice(response.status === 409 ? "新版本已变化，未启用。请重新查看新版本并核对来源。" : typeof body?.error === "string" ? body.error : "启用被拒绝，请重新核对来源与当前版本。");
        return;
      }
      if (!response.ok || body?.memory?.id !== target.memory.id || body.memory.status !== "verified") throw new Error("审核结果未确认。");
      const current = await readSnapshot(target.memory.id);
      clearLegacyReviewMarker();
      if (result) setNewSnapshot(current); else setSnapshot(current);
      setEvidenceConfirmed(false);
      setReviewSaved(true); savedRef.current = true;
      setNotice(current.memory.status === "verified" && isEffectiveMemory(current.memory) ? "核实已保存，记忆已启用；下一轮实际使用情况尚待验证。" : "审核已保存，请按下方当前状态核对是否可正常召回。");
    } catch (error) {
      setEvidenceConfirmed(false);
      if (prepared) {
        setReviewUnknown(true);
        setNotice("暂未确认启用结果。请核对当前新版本，勿重复提交审核。");
      } else setNotice(error instanceof Error ? `${error.message} 审核未发送。` : "无法保存审核恢复记录，审核未发送。");
    } finally { inFlight.current = false; setBusy(false); }
  }

  async function endReviewRecovery() {
    const target = storedReviewRef.current;
    if (!target || !reviewUnknown || !reviewCanEnd || inFlight.current || busy) return;
    inFlight.current = true; setBusy(true); setNotice(null);
    try {
      const owner = await loadMemoryRevisionOwner();
      if (owner !== ownerRef.current || owner !== target.ownerId) {
        setSnapshot(null); setResult(null); setNewSnapshot(null); setOpen(false);
        setNotice("当前登录身份已变化，未清除原用户恢复记录。");
        window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
        return;
      }
      const current = await readSnapshot(target.memoryId);
      if (!canEndMemoryReviewRecovery(target, {
        memoryId: current.memory.id, expectedVersion: current.expectedVersion, status: current.memory.status,
      })) {
        if (result) setNewSnapshot(current); else setSnapshot(current);
        reconcileReviewSnapshot(current, target);
        return;
      }
      const stored = readPendingMemoryReview(sessionStorage, owner);
      if (!stored || stored.memoryId !== target.memoryId || stored.expectedVersion !== target.expectedVersion) {
        throw new Error("恢复记录已变化，未清除其他记忆的记录。请重新读取当前恢复入口。");
      }
      const original = readPendingMemoryRevision(sessionStorage, owner);
      const revisionOrigin = current.memory.metadata?.revision;
      if (original && original.request.commandId === storedCommandId.current &&
          revisionOrigin && original.request.commandId === revisionOrigin.commandId &&
          original.memoryId === revisionOrigin.previousMemoryId) {
        clearPendingMemoryRevision(sessionStorage, owner, original.request.commandId);
        if (readPendingMemoryRevision(sessionStorage, owner)?.request.commandId === original.request.commandId) {
          throw new Error("原更新暂存未清除，请保留恢复入口后重试。");
        }
        storedCommandId.current = null;
      }
      clearPendingMemoryReview(sessionStorage, stored);
      if (readPendingMemoryReview(sessionStorage, owner)) throw new Error("核实暂存未清除，请保留恢复入口后重试。");
      storedReviewRef.current = null;
      setOpen(false); ++loadGeneration.current;
      setReviewUnknown(false); setReviewCanEnd(false); savedRef.current = false;
      window.dispatchEvent(new Event(MEMORY_REVISION_PENDING_EVENT));
      Promise.resolve().then(() => onSaved?.()).catch(() => setNotice("恢复暂存已清除，但列表刷新失败。请手动刷新列表。"));
    } catch (error) { setNotice(error instanceof Error ? error.message : "恢复暂存清理失败，历史审核记录保留。"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  function endReviewControl() {
    if (!reviewUnknown || !reviewCanEnd) return null;
    return <div className="space-y-2 rounded-md border border-amber-500/40 p-3 text-sm leading-6">
      <p>已核对当前版本或状态发生变化，原审核版本已不能执行。可结束此次恢复，仅清理本地暂存；原审核的历史结果仍未知，审计记录保留。</p>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void endReviewRecovery()}>关闭并结束此次核实恢复</Button>
    </div>;
  }

  function reviewFields(target: MemorySnapshot) {
    return <div className="space-y-3 border-t pt-3">
      {target.memory.evidenceRefs.length ? <>
        <MemoryEvidenceViewer key={`${target.memory.id}:${target.expectedVersion}`} memoryId={target.memory.id} evidenceRefs={target.memory.evidenceRefs} />
        <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1" checked={evidenceConfirmed} disabled={busy} onChange={event => setEvidenceConfirmed(event.target.checked)} /><span>我已核对以上来源与新内容，确认可以启用</span></label>
        <p className="text-xs text-muted-foreground">请核对原始来源。主人修改记录只证明提交过意见，不单独证明外部事实真实。</p>
        <label htmlFor={`${fieldId}-review-reason`} className="block space-y-1"><span>核实依据与理由</span><textarea id={`${fieldId}-review-reason`} className={`${fieldClass} min-h-16 resize-y`} value={reviewReason} disabled={busy} maxLength={4000} onChange={event => setReviewReason(event.target.value)} /></label>
        <Button type="button" disabled={busy || !evidenceConfirmed || !reviewReason.trim()} onClick={() => void confirmNewVersion()}>核实后启用</Button>
      </> : <p className="text-xs text-muted-foreground">缺少可核对的来源引用，请先修订当前版本，补充来源后再审核。</p>}
    </div>;
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">{triggerLabel ?? (result ? "查看纠错回执" : "纠错与更新")}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" hideCloseButton={busy && inFlight.current}>
        <DialogHeader>
          <DialogTitle>记忆纠错与更新</DialogTitle>
          <DialogDescription>核对当前内容与来源，再保存一次更新。原始证据和历史版本保留。</DialogDescription>
        </DialogHeader>
        {notice ? <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6">{notice}</p> : null}
        {!snapshot && !result && !pending ? (
          <div className="space-y-3">
            <p role="status" className="text-sm text-muted-foreground">{busy ? "正在读取当前版本…" : "未取得可提交的当前版本。"}</p>
            {!busy ? <Button type="button" variant="outline" onClick={() => void loadCurrent()}>重新读取</Button> : null}
          </div>
        ) : null}
        {!snapshot && pending && !result ? <section className="space-y-3 rounded-md border p-3 text-sm">
          <p>原更新等待回执，请核对原提交内容后重试。</p>
          <p>{OPERATION_LABELS[pending.operation]} · {pending.authority === "owner_statement" ? "自身情况" : "外部事实"}</p>
          {pending.content ? <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words leading-6">{pending.content}</p> : null}
          <p className="whitespace-pre-wrap break-words text-muted-foreground">修改理由：{pending.reason}</p>
          <p className="break-all text-xs text-muted-foreground">原提交编号：{pending.commandId}</p>
          <Button type="button" disabled={busy} onClick={() => void sendRevision(pending)}>{busy ? "正在核对回执…" : "重试原提交"}</Button>
        </section> : null}
        {result ? (
          <div className="space-y-4">
            <div role="status" className="rounded-md border bg-muted/30 p-3 text-sm leading-6">
              <p className="font-medium">{result.operation === "deactivate" ? "记忆已停用。" : reviewSaved ? "新版本核实已保存。" : result.receipt.status === "pending_verification" ? "旧版本已停用；新版本已保存，待核实。" : result.receipt.effective ? "已保存，已更新有效记忆。" : "新版本已保存，当前暂不参与正常召回。"}</p>
              <p className="text-muted-foreground">{result.operation === "deactivate" ? "后续正常召回将跳过这条记忆，历史依据保留。" : !reviewSaved && result.receipt.status === "pending_verification" ? "新版本暂不参与正常召回，核实来源后才能启用。" : "下一轮实际使用情况尚待验证；回执记录保存当时的结果，当前状态请查看新版本。"}</p>
              <p className="mt-2 break-all text-xs text-muted-foreground">回执：{result.receipt.id}</p>
            </div>
            {result.newMemory ? <Button type="button" variant="outline" disabled={busy} onClick={() => void viewNewVersion()}>{busy ? "读取新版本…" : reviewUnknown ? "核对启用结果" : "查看新版本"}</Button> : null}
            {result.operation === "deactivate" ? <Button type="button" variant="outline" disabled={busy} onClick={() => void restoreDeactivatedVersion()}>恢复为新版本</Button> : null}
            {newSnapshot ? <section className="space-y-2 rounded-md border p-3 text-sm">
              <h3 className="font-medium">新版本 · {newSnapshot.memory.subject}</h3>
              <p className="whitespace-pre-wrap break-words leading-6">{newSnapshot.memory.content}</p>
              <p className="text-xs text-muted-foreground">{memoryStatusLabel(newSnapshot.memory)}</p>
              <details><summary className="cursor-pointer text-xs">查看来源依据</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{newSnapshot.memory.evidenceRefs.join("\n") || "尚无来源引用"}</pre></details>
              {isRevisionCandidate(newSnapshot.memory) && !reviewUnknown ? reviewFields(newSnapshot) : null}
              {["candidate", "active", "verified", "weakened"].includes(newSnapshot.memory.status) ? <Button type="button" variant="outline" disabled={busy || reviewUnknown} onClick={reviseCurrentVersion}>重新修订当前版本</Button> : null}
            </section> : null}
            {endReviewControl()}
            <Button type="button" disabled={busy} onClick={() => changeOpen(false)}>{reviewUnknown ? "关闭并保留待核对记录" : "完成并刷新列表"}</Button>
          </div>
        ) : snapshot ? (
          <form onSubmit={submit} className="space-y-4">
            <section className="space-y-2 rounded-md border bg-muted/20 p-3">
              <h3 className="text-sm font-medium">当前版本 · {snapshot.memory.subject}</h3>
              <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6">{snapshot.memory.content}</p>
              <p className="text-xs text-muted-foreground">范围：{SCOPE_LABELS[snapshot.memory.scope.type] ?? "指定范围"} · 类型：{TYPE_LABELS[snapshot.memory.memoryType] ?? "其他"} · 状态：{memoryStatusLabel(snapshot.memory)}</p>
              <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看来源与版本</summary><pre className="mt-2 whitespace-pre-wrap break-all">{`版本编号：${snapshot.memory.id}\n校验版本：${snapshot.expectedVersion}\n来源引用：\n${snapshot.memory.evidenceRefs.join("\n") || "尚无来源引用"}`}</pre></details>
              {snapshot.memory.metadata?.revisionRetired?.nextMemoryId ? <Button type="button" variant="outline" disabled={busy} onClick={() => void loadReplacement()}>读取当前替代版本</Button> : null}
            </section>
            {ownerRef.current && (correctionRecovery || correctionSeedVersion || !hasPendingMemoryUpdate(snapshot.memory) && !["deleted", "superseded"].includes(snapshot.memory.status)) ? <MemoryCorrectionDraftControl
              key={`${snapshot.memory.id}:${ownerRef.current}`} memoryId={snapshot.memory.id} expectedVersion={snapshot.expectedVersion}
              ownerId={ownerRef.current} disabled={busy || !!pending || !!result || reviewUnknown}
              allowNewDraft={!hasPendingMemoryUpdate(snapshot.memory) && !["deleted", "superseded"].includes(snapshot.memory.status)}
              pendingRecovery={correctionRecovery} onBusyChange={updateCorrectionBusy} onAdopt={adoptCorrection} onDiscard={discardCorrection} /> : null}
            {isRevisionCandidate(snapshot.memory) || reviewUnknown || reviewSaved ? <section aria-label="已有修订版本核实" className="space-y-3 rounded-md border p-3 text-sm">
              <h3 className="font-medium">核实已有修订版本</h3>
              <p className="text-xs text-muted-foreground">直接核实已保存的当前版本，不会另建一条记忆修订。</p>
              {reviewSaved ? <p role="status">核实状态已保存；下一轮实际使用情况尚待验证。</p> : null}
              {reviewUnknown ? <Button type="button" variant="outline" disabled={busy} onClick={() => void viewNewVersion()}>核对启用结果</Button> : isRevisionCandidate(snapshot.memory) ? reviewFields(snapshot) : null}
              {endReviewControl()}
              <Button type="button" disabled={busy} onClick={() => changeOpen(false)}>{reviewUnknown ? "关闭并保留待核对记录" : "完成并刷新列表"}</Button>
            </section> : null}
            {snapshot.history?.length || snapshot.historyWarning ? <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer">查看历史版本{snapshot.history?.length ? `（${snapshot.history.length} 条）` : ""}</summary>
              <div className="mt-3 space-y-3">
                {snapshot.historyWarning ? <p role="status" className="text-xs text-amber-700">部分历史版本无法核对，当前展示的历史可能不完整。</p> : null}
                {snapshot.history?.map(history => <section key={history.id} className="space-y-2 border-t pt-3">
                  <p className="text-xs text-muted-foreground">{formatRevisionDate(history.createdAt)} · {memoryStatusLabel(history)}{history.reason ? ` · ${history.reason}` : ""}</p>
                  <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words leading-6">{history.content}</p>
                  <Button type="button" variant="outline" size="sm" disabled={locked || snapshot.memory.status === "superseded"} onClick={() => {
                    setContent(history.content);
                    if (operation !== "restore") setOperation("correct");
                    setReason(`恢复采用历史版本 ${history.id} 的正文。`);
                    setEvidence([...new Set([...snapshot.memory.evidenceRefs, ...history.evidenceRefs])].join("\n"));
                    setNotice("已填入历史正文，仍会保存为新版本。请填写理由并核对来源，不会重新启用历史条目。");
                  }}>采用该历史正文</Button>
                </section>)}
                {snapshot.historyTruncated ? <p className="text-xs text-muted-foreground">当前仅展示最近可追溯的历史版本。</p> : null}
              </div>
            </details> : null}
            <div className="grid grid-cols-2 gap-3">
              <label htmlFor={`${fieldId}-operation`} className="space-y-1 text-sm"><span>更新方式</span><select id={`${fieldId}-operation`} aria-label="更新方式" className={fieldClass} value={operation} disabled={locked || operation === "restore"} onChange={event => setOperation(event.target.value as RevisionOperation)}>{Object.entries(OPERATION_LABELS).filter(([value]) => value !== "restore" || operation === "restore").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label htmlFor={`${fieldId}-authority`} className="space-y-1 text-sm"><span>信息来源</span><select id={`${fieldId}-authority`} aria-label="信息来源" className={fieldClass} value={authority} disabled={locked} required onChange={event => setAuthority(event.target.value as RevisionAuthority)}><option value="" disabled>请选择信息来源</option><option value="external_fact">外部事实，需要核实</option><option value="owner_statement">我自己的偏好或情况</option></select></label>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{authority === "" ? "请明确选择信息来源。草稿整理不代表主人已确认来源或外部事实已经核实。" : operation === "deactivate" ? "停用后不再参与正常召回。" : authority === "external_fact" || !OWNER_ACTIVE_TYPES.has(snapshot.memory.memoryType) ? "旧版本将退出正常召回，新版本保存为待核实。业务事实和边界需要来源确认。" : "明确的自身偏好可保存为有效记忆。保存结果以回执为准。"}</p>
            {operation !== "deactivate" ? <label htmlFor={`${fieldId}-content`} className="block space-y-1 text-sm"><span>{operation === "supplement" ? "补充后的完整内容" : "新版本完整内容"}</span><textarea id={`${fieldId}-content`} className={`${fieldClass} min-h-32 resize-y`} value={content} disabled={locked} required maxLength={64000} onChange={event => setContent(event.target.value)} /></label> : null}
            <label htmlFor={`${fieldId}-reason`} className="block space-y-1 text-sm"><span>修改理由</span><textarea id={`${fieldId}-reason`} className={`${fieldClass} min-h-16 resize-y`} value={reason} disabled={locked} required maxLength={4000} onChange={event => setReason(event.target.value)} /></label>
            <label htmlFor={`${fieldId}-evidence`} className="block space-y-1 text-sm"><span>来源引用，每行一条</span><textarea id={`${fieldId}-evidence`} className={`${fieldClass} min-h-16 resize-y`} value={evidence} disabled={locked} onChange={event => setEvidence(event.target.value)} /><span className="text-xs text-muted-foreground">已填入原版本引用，可沿用或补充新来源。引用本身不代表已核实。</span></label>
            {operation === "state_change" ? <label htmlFor={`${fieldId}-observed`} className="block space-y-1 text-sm"><span>来源观测时间（可选）</span><input id={`${fieldId}-observed`} type="datetime-local" className={fieldClass} value={observedAt} disabled={locked} onChange={event => setObservedAt(event.target.value)} /><span className="text-xs text-muted-foreground">未填写时保留原观测时间或未知；保存时间不作为事实发生时间。</span></label> : null}
            <div className="flex flex-wrap justify-end gap-2">
              {pending ? <Button type="button" disabled={busy} onClick={() => void sendRevision(pending)}>{busy ? "正在核对回执…" : "重试原提交"}</Button> : conflict ? <Button type="button" variant="outline" disabled={busy || correctionBusy} onClick={() => void loadCurrent(true)}>刷新当前记忆</Button> : <Button type="submit" disabled={locked || correctionSeedVersion !== null && correctionSeedVersion !== snapshot.expectedVersion || snapshot.memory.status === "superseded" || snapshot.memory.status === "deleted" && operation !== "restore"}>{busy ? "正在保存…" : operation === "deactivate" ? "保存并停用" : "保存更新"}</Button>}
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** A stable page-level recovery entry survives removal of the retired memory card. */
export function MemoryRevisionRecovery({ onSaved }: { onSaved?: () => void | Promise<void> }) {
  const [pending, setPending] = useState<PendingMemoryRevision | null>(null);
  const [pendingReview, setPendingReview] = useState<PendingMemoryReview | null>(null);
  const [correction, setCorrection] = useState<PendingMemoryCorrection | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const correctionOpenRef = useRef(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    let generation = 0;
    async function restore() {
      const current = ++generation;
      try {
        const owner = await loadMemoryRevisionOwner();
        const record = readPendingMemoryRevision(sessionStorage, owner);
        const reviewRecord = readPendingMemoryReview(sessionStorage, owner);
        let correctionRecord: PendingMemoryCorrection | null = null;
        let correctionFailure: string | null = null;
        try { correctionRecord = readPendingMemoryCorrection(sessionStorage, owner); }
        catch (failure) { correctionFailure = failure instanceof Error ? failure.message : "纠错草稿暂存读取失败。"; }
        if (live && current === generation) {
          setPending(record); setPendingReview(reviewRecord);
          setCorrection(previous => correctionRecord ?? (correctionOpenRef.current && previous?.ownerId === owner ? previous : null));
          setCorrectionError(correctionFailure); setError(null);
        }
      } catch (failure) {
        if (live && current === generation) { setPending(null); setPendingReview(null); setCorrection(null); setError(failure instanceof Error ? failure.message : "恢复记录读取失败。"); }
      }
    }
    const changed = () => void restore();
    void restore();
    window.addEventListener(MEMORY_REVISION_PENDING_EVENT, changed);
    window.addEventListener(MEMORY_CORRECTION_PENDING_EVENT, changed);
    return () => { live = false; window.removeEventListener(MEMORY_REVISION_PENDING_EVENT, changed); window.removeEventListener(MEMORY_CORRECTION_PENDING_EVENT, changed); };
  }, [reload]);
  if (error) return <div role="alert" className="space-y-2 rounded-md border p-3 text-sm"><p>无法读取记忆更新恢复记录：{error}</p><Button type="button" variant="outline" onClick={() => setReload(value => value + 1)}>重新读取恢复记录</Button></div>;
  if (!pending && !pendingReview && !correction && !correctionError) return null;
  return <div className="space-y-2">
    {pending ? <section aria-label="记忆更新恢复" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p>有一条记忆更新等待完成回执核对。即使原记忆已退出列表，也可恢复原提交。</p>
      <MemoryRevisionControl key={pending.request.commandId} memoryId={pending.memoryId}
        pendingRecovery={pending} triggerLabel="恢复记忆更新" onSaved={onSaved} />
    </section> : null}
    {correctionError ? <p role="alert" className="rounded-md border p-3 text-sm">纠错草稿暂存无法核对：{correctionError} 原修订与核实恢复仍优先处理。</p> : null}
    {correction && (correctionOpen || !pending && !pendingReview) ? <section aria-label="纠错草稿恢复" className="space-y-2 rounded-md border p-3 text-sm">
      <p>有一份纠错草稿等待核对，尚未改动记忆。重新读取原草稿与当前版本后，由主人选择是否采用。</p>
      <MemoryRevisionControl key={correction.request.commandId} memoryId={correction.memoryId} correctionRecovery={correction}
        triggerLabel="继续纠错草稿" onDialogOpenChange={value => { correctionOpenRef.current = value; setCorrectionOpen(value); }} onSaved={onSaved} />
    </section> : null}
    {pendingReview ? <section aria-label="记忆核实恢复" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p>有一条已有版本的核实记录等待核对或完成。重新读取当前状态，不会另建记忆修订。</p>
      <MemoryRevisionControl key={`${pendingReview.memoryId}:${pendingReview.expectedVersion}`} memoryId={pendingReview.memoryId}
        pendingReviewRecovery={pendingReview} triggerLabel="恢复记忆核实" onSaved={onSaved} />
    </section> : null}
  </div>;
}

type RevisionListProps = {
  workId?: string;
  onSaved?: () => void | Promise<void>;
};

export function MemoryRetiredRevisionList(props: RevisionListProps) {
  return <MemoryRevisionStatusList {...props} status="deleted" />;
}

export function MemoryPendingRevisionList(props: RevisionListProps) {
  return <MemoryRevisionStatusList {...props} status="candidate" />;
}

function MemoryRevisionStatusList({ workId, onSaved, status }: RevisionListProps & { status: "deleted" | "candidate" }) {
  const retired = status === "deleted";
  const [open, setOpen] = useState(false);
  const [memories, setMemories] = useState<RevisionMemory[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);

  async function load() {
    if (reading.current) return;
    reading.current = true; setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ statuses: status, limit: "20" });
      if (workId) { params.set("ownerType", "work"); params.set("ownerId", workId); }
      const response = await fetch(`/api/memory/memories?${params.toString()}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.memories)) throw new Error(retired ? "最近停用记忆读取失败，请重试。" : "待核实修订读取失败，请重试。");
      setMemories(body.memories.filter((memory: RevisionMemory & { ownerType?: string; ownerId?: string }) =>
        (retired ? memory.status === "deleted" && memory.metadata?.revisionRetired?.operation === "deactivate" &&
          memory.metadata.revisionRetired.nextMemoryId === null : isRevisionCandidate(memory)) &&
        (!workId || memory.ownerType === "work" && memory.ownerId === workId)));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "记忆列表读取失败。"); }
    finally { reading.current = false; setLoading(false); }
  }

  async function refreshAfterSaved() {
    const results = await Promise.allSettled([load(), Promise.resolve().then(() => onSaved?.())]);
    if (results[1].status === "rejected") setError("更新已保存，但当前记忆列表刷新失败。请手动刷新。");
  }

  return <section aria-label={retired ? "最近停用记忆列表" : "待核实修订列表"} className="rounded-md border p-3 text-sm">
    <button type="button" aria-expanded={open} className="w-full text-left font-medium" onClick={() => {
      const next = !open; setOpen(next);
      if (next && memories === null) void load();
    }}>{retired ? open ? "收起最近停用记忆" : "查看最近停用记忆" : open ? "收起待核实修订" : "查看待核实修订"}</button>
    {open ? <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{retired ? "仅检查最近 20 条停用记录中的可恢复记忆。恢复创建新版本，历史条目保留。" : "仅检查最近 20 条候选记录中需主人核实的记忆，包含修订版本和新的理解候选。待核实版本暂不参与正常召回，可直接核实已有版本。"}</p>
      {error ? <p role="alert" className="text-sm text-amber-700">{error}</p> : null}
      {loading ? <p role="status" className="text-sm text-muted-foreground">{retired ? "正在读取停用记忆…" : "正在读取待核实修订…"}</p> : null}
      <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>{retired ? "刷新停用记忆" : "刷新待核实修订"}</Button>
      {!loading && memories?.length === 0 ? <p className="text-sm text-muted-foreground">{retired ? "本页最近停用记录中没有可恢复记忆。" : "本页最近候选记录中没有需要核实的记忆。"}</p> : null}
      {memories?.map(memory => <article key={memory.id} data-memory-id={memory.id} className="space-y-2 border-t pt-3">
        <p className="font-medium">{memory.subject}</p>
        <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words leading-6">{memory.content}</p>
        <p className="text-xs text-muted-foreground">{retired ? `停用原因：${(memory.metadata?.revisionRetired as { reason?: string })?.reason ?? "未提供"}` : "待核实，暂不参与正常召回。"}</p>
        <MemoryRevisionControl memoryId={memory.id} triggerLabel={retired ? "恢复为新版本" : "核实已有版本"} onSaved={refreshAfterSaved} />
      </article>)}
    </div> : null}
  </section>;
}
