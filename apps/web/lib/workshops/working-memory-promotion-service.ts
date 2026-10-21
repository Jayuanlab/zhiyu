import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import { createWorkshopBrainRequester } from "@/lib/memory/records/workshop-memory";
import { canonicalCommandJson } from "@/lib/work-runtime/command-payload";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import type { readOwnerWorkshopRun } from "@/lib/ai/chat/native-workshop-run";
import type { readOwnerLoopRun } from "@/lib/loops/owner-loop-run";
import type { createMemoryCandidate as createBrainMemoryCandidate } from "@/lib/memory/revision/writes";
import type { getMemoryById as getBrainMemory } from "@/lib/memory/adapters/postgres/memory-records";
import type { getWorkshop, listWorkshopEvents } from "./service";
import type { appendOwnerWorkingMemoryPromotion } from "./working-memory-promotion-receipt";
import { parseWorkingMemoryPromotionCommand, resolveWorkingMemoryPromotion, WorkingMemoryPromotionError,
  WORKING_MEMORY_PROMOTION_EVENT_LIMIT, WORKING_MEMORY_PROMOTION_SOURCE } from "./working-memory-promotion";

export type WorkingMemoryPromotionDependencies = {
  getWorkshop: typeof getWorkshop;
  listWorkshopEvents: typeof listWorkshopEvents;
  appendPromotionReceipt: typeof appendOwnerWorkingMemoryPromotion;
  readOwnerWorkshopRun: typeof readOwnerWorkshopRun;
  readOwnerLoopRun: typeof readOwnerLoopRun;
  getBrainMemory: typeof getBrainMemory;
  createBrainMemoryCandidate: typeof createBrainMemoryCandidate;
};
const defaults: WorkingMemoryPromotionDependencies = {
  getWorkshop: async (...args) => (await import("./service")).getWorkshop(...args),
  listWorkshopEvents: async (...args) => (await import("./service")).listWorkshopEvents(...args),
  appendPromotionReceipt: async (...args) => (await import("./working-memory-promotion-receipt")).appendOwnerWorkingMemoryPromotion(...args),
  readOwnerWorkshopRun: async (...args) => (await import("@/lib/ai/chat/native-workshop-run")).readOwnerWorkshopRun(...args),
  readOwnerLoopRun: async (...args) => (await import("@/lib/loops/owner-loop-run")).readOwnerLoopRun(...args),
  getBrainMemory: async (...args) => (await import("@/lib/memory/adapters/postgres/memory-records")).getMemoryById(...args),
  createBrainMemoryCandidate: async (...args) => (await import("@/lib/memory/revision/writes")).createMemoryCandidate(...args),
};

/** Server-owned admission entry point shared by the owner API and controlled evaluations. */
export async function promoteWorkingMemory(input: { userId: string; workshopId: string; command: unknown }, deps = defaults) {
  if (resolveExecutionLease()) throw new WorkingMemoryPromotionError("owner_promotion_required", "运行中的智能体不能代替主人提交长期记忆候选。");
  const { userId, workshopId } = input;
  const command = parseWorkingMemoryPromotionCommand(input.command);
  const workshop = await deps.getWorkshop(userId, workshopId);
  if (!workshop || workshop.id !== workshopId || workshop.userId !== userId)
    throw new WorkingMemoryPromotionError("workshop_not_found", "没有找到当前用户的车间。", 404);
  const terminalRun = async () => {
    if (command.runKind === "loop") {
      const owned = await deps.readOwnerLoopRun({ ownerId: userId, workshopId, loopId: command.loopId, runId: command.runId });
      if (!["success", "failed", "cancelled", "blocked"].includes(owned.run.status) || !owned.run.completedAt ||
        !Number.isFinite(new Date(owned.run.completedAt).getTime()))
        throw new WorkingMemoryPromotionError("working_memory_run_not_terminal", "这轮 Loop 仍在执行或等待审核；请等运行结束后再送交长期记忆审核。");
    } else {
      const owned = await deps.readOwnerWorkshopRun({ ownerId: userId, workshopId, runId: command.runId });
      if (!["completed", "failed", "interrupted", "cancelled"].includes(owned.run.status))
        throw new WorkingMemoryPromotionError("working_memory_run_not_terminal", "这轮运行尚未结束；请等运行结束后再送交长期记忆审核。");
    }
  };
  await terminalRun();
  const read = () => deps.listWorkshopEvents(workshopId, {
    ...(command.runKind === "loop" ? { loopRunId: command.runId } : { runId: command.runId }),
    order: "asc", limit: WORKING_MEMORY_PROMOTION_EVENT_LIMIT + 1,
  });
  const resolved = resolveWorkingMemoryPromotion({ userId, workshopId, command, events: await read() });
  // Recheck persisted receipts and terminal ownership before admission. No URL or latest-event fallback.
  const checked = resolveWorkingMemoryPromotion({ userId, workshopId, command, events: await read() });
  await terminalRun();
  if (resolved.candidateId !== checked.candidateId || resolved.checkpointEventId !== checked.checkpointEventId || resolved.projectionEventId !== checked.projectionEventId)
    throw new WorkingMemoryPromotionError("working_memory_version_conflict", "运行记忆在提交期间变化，请刷新后重试。");
  const validateCandidate = (memory: BrainMemory) => {
    if (memory.status !== "candidate") throw new WorkingMemoryPromotionError("promotion_candidate_retired", "该条目已被审核或撤销，不能当作新候选重新提交。");
    const saved = memory.metadata?.workingMemoryPromotion;
    const promotion = saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
    let exactSources = false, exactRun = false;
    try {
      exactSources = canonicalCommandJson(promotion.sources) === canonicalCommandJson(checked.sources);
      exactRun = canonicalCommandJson(promotion.runIdentity) === canonicalCommandJson(checked.runIdentity);
    } catch { /* Incomplete records cannot act as a replay. */ }
    if (memory.id !== checked.candidateId || memory.userId !== userId || memory.ownerType !== "work" || memory.ownerId !== workshopId ||
      memory.scope.type !== "work" || memory.scope.workId !== workshopId || memory.content !== checked.content ||
      memory.memoryType !== (checked.category === "fact" ? "fact" : "insight") || promotion.source !== WORKING_MEMORY_PROMOTION_SOURCE ||
      promotion.category !== checked.category || promotion.authority !== "model-authored-unverified" || !exactSources || !exactRun ||
      JSON.stringify([...memory.evidenceRefs].sort()) !== JSON.stringify([...checked.evidenceRefs].sort()))
      throw new WorkingMemoryPromotionError("promotion_candidate_identity_conflict", "长期候选身份与选中的工作笔记不一致，请在记忆审核页核对。");
  };
  if (checked.replayEvent) {
    const prior = await deps.getBrainMemory({ userId, memoryId: checked.candidateId });
    if (!prior) throw new WorkingMemoryPromotionError("promotion_candidate_retired", "该候选已被撤销或暂不可读取，请在长期记忆审核页查看当前结果。");
    validateCandidate(prior);
    return { candidateId: prior.id, status: "candidate" as const, replayed: true };
  }
  const previousCandidate = await deps.getBrainMemory({ userId, memoryId: checked.candidateId });
  if (previousCandidate) validateCandidate(previousCandidate);
  const memory = await deps.createBrainMemoryCandidate({
    requester: createWorkshopBrainRequester(workshop), scope: { type: "work", workId: workshopId }, ownerType: "work", ownerId: workshopId,
    id: checked.candidateId, canonicalGroupId: `working-note:${checked.candidateId}`, memoryType: checked.category === "fact" ? "fact" : "insight",
    subject: `${workshop.name} / ${command.noteKey}`, content: checked.content, confidence: checked.category === "fact" ? 50 : 25,
    evidenceRefs: checked.evidenceRefs, tags: ["working_memory", checked.category],
    facets: { sourceKind: "workshop_tool", workshopId, runKind: command.runKind, runId: command.runId,
      ...(command.runKind === "loop" ? { loopId: command.loopId } : {}), notebookKey: command.noteKey, category: checked.category },
    metadata: { workingMemoryPromotion: { source: WORKING_MEMORY_PROMOTION_SOURCE, authority: "model-authored-unverified", status: "pending_owner_review",
      category: checked.category, runIdentity: checked.runIdentity,
      commandId: command.commandId, requestHash: checked.requestHash, expectedVersion: command.expectedVersion,
      checkpointEventId: checked.checkpointEventId, projectionEventId: checked.projectionEventId, policyIdentity: checked.policyIdentity, sources: checked.sources } },
  });
  validateCandidate(memory);
  await deps.appendPromotionReceipt({ userId, workshopId, command, event: { workshopId, runId: checked.runId, loopId: checked.loopId, loopRunId: checked.loopRunId,
    type: "working_memory_promoted", title: "工作笔记已送交长期记忆审核（未生效）",
    metadata: { source: WORKING_MEMORY_PROMOTION_SOURCE, receiptAuthority: "runtime", commandId: command.commandId, requestHash: checked.requestHash,
      runIdentity: checked.runIdentity, candidateId: memory.id, status: "candidate", noteKey: command.noteKey, version: command.expectedVersion,
      checkpointEventId: checked.checkpointEventId, projectionEventId: checked.projectionEventId, sourceEventIds: checked.evidenceRefs },
  } });
  return { candidateId: memory.id, status: "candidate" as const, replayed: !!previousCandidate };
}
