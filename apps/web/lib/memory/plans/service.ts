import { createHash, randomUUID } from "node:crypto";
import type { TaskPlan } from "@openzhiyu/ai/agent/types";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { MemoryModuleError } from "../kernel/errors";
import { insertObservationInTransaction } from "../adapters/postgres/observations";
import { appendMemoryPlan, latestMemoryPlan, legacyMemoryPlan, lockMemoryPlan, lockPlanCommand, lockPlanOwner,
  readMemoryPlanRecord, readPlanCommand, recordPlanCommand, finishPlanCommand, latestPlanExecution } from "../adapters/postgres/plans";
import { admitExactUse, admitPersistedExactUse, preparePersistedExactUse, type ExactUseProof } from "../context/exact-use-admission";
import { captureMemoryDispatchSources, exactUseRegistrationRequired, registerExactUseForDispatch } from "../context/dispatch";
import { executePlanSchema, legacyRebaseSchema, planDigest, planPayloadSchema, revokePlanSchema, stablePlanCommand,
  toTaskPlan, type PlanRecord } from "./contracts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unavailable = () => new MemoryModuleError("memory_plan_unavailable", 404, "Plan unavailable; generate or explicitly review a fresh plan");
const conflict = () => new MemoryModuleError("memory_plan_revision_conflict", 409, "Plan or command changed; inspect the current revision before approval");
function owner(userId: string) {
  if (!uuid.test(userId) || resolveExecutionLease()) throw new MemoryModuleError("memory_plan_owner_required", 403, "Plan review requires its owner");
}
function planKey(planId: string) { if (!planId || planId.length > 200) throw unavailable(); }
function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new MemoryModuleError("memory_plan_invalid_request", 400, "Invalid plan command");
  return result.data;
}
function assertCurrent(record: PlanRecord, input?: { taskId?: string | null; workDir?: string | null }) {
  if (record.state === "revoked" || Date.parse(record.expiresAt) <= Date.now()) throw unavailable();
  if (input && (record.taskId !== (input.taskId ?? null) || record.workDir !== (input.workDir ?? null))) throw conflict();
}
function publicRecord(record: PlanRecord, replayed = false) {
  return { plan: toTaskPlan(record.plan), version: record.version, revision: record.revision, state: record.state,
    origin: record.origin, receiptId: record.id, sourceReceiptIds: record.sourceReceiptIds,
    sourceCount: record.sourceReceiptIds.length, inputObservationId: record.inputObservationId,
    taskId: record.taskId, workDir: record.workDir, expiresAt: record.expiresAt, replayed,
    historicalSources: record.origin === "owner_rebased_legacy" ? "unknown_owner_rebased" as const : "captured_at_generation" as const };
}
async function commandResult(userId: string, commandId: string, action: string, requestHash: string) {
  const command = await readPlanCommand(db, userId, commandId);
  if (!command) return null;
  if (command.action !== action || command.requestHash !== requestHash) throw conflict();
  const result = await readMemoryPlanRecord(db, userId, command.resultRecordId); if (!result) throw unavailable();
  return result;
}
async function inputReceipt(userId: string, planId: string, commandId: string, inputPrompt: string, origin: PlanRecord["origin"]) {
  const { observation } = await insertObservationInTransaction(db, { id: randomUUID(), userId,
    sourceType: "memory_plan_input", sourceId: `${planId}:${commandId}:input`, observedAt: new Date(), content: inputPrompt,
    contentHash: createHash("sha256").update(inputPrompt).digest("hex"), trustLevel: "owner_control_input",
    metadata: { schemaVersion: "memory-plan-input.v1", planId, commandId, origin, semantics: "owner_control_input" } }, true);
  const proof = await admitExactUse({ requester: { type: "chat", userId }, accessMode: "owner_override", purpose: "plan_input",
    publishedRecords: [{ source: "brainObservations", id: observation.id, fields: { id: observation.id,
      content: observation.content, sourceType: observation.sourceType, sourceId: observation.sourceId } }] });
  return { observationId: observation.id, proof };
}
type GeneratedInput = { userId: string; commandId?: string; plan: TaskPlan; renderedPrompt: string; inputPrompt: string;
  taskId?: string | null; workDir?: string | null };
export async function saveGeneratedMemoryPlan(input: GeneratedInput) {
  owner(input.userId);
  input = { ...input, userId: input.userId.toLowerCase(), taskId: input.taskId?.toLowerCase() ?? null };
  const plan = parsed(planPayloadSchema.safeParse(input.plan));
  if (!input.inputPrompt || input.inputPrompt.length > 262144 || input.renderedPrompt.length > 1048576
    || input.taskId && !uuid.test(input.taskId) || input.workDir && input.workDir.length > 4096) throw unavailable();
  const commandId = (input.commandId ?? stablePlanCommand(input.userId, plan.id)).toLowerCase(); if (!uuid.test(commandId)) throw conflict();
  const sources = await captureMemoryDispatchSources(input.userId);
  const requestHash = planDigest({ plan, renderedPrompt: input.renderedPrompt, inputPrompt: input.inputPrompt,
    taskId: input.taskId ?? null, workDir: input.workDir ?? null, signature: sources.signature });
  return withDatabaseTransaction(async () => {
    await lockPlanCommand(db, input.userId, commandId); await lockMemoryPlan(db, input.userId, plan.id, "update");
    await lockPlanOwner(db, input.userId, input.taskId);
    const replay = await commandResult(input.userId, commandId, "generated", requestHash); if (replay) return publicRecord(replay, true);
    if (await latestMemoryPlan(db, input.userId, plan.id)) throw conflict();
    const raw = await inputReceipt(input.userId, plan.id, commandId, input.inputPrompt, "generated");
    const now = new Date();
    const record = await appendMemoryPlan(db, { id: randomUUID(), userId: input.userId, planId: plan.id, revision: 1, state: "ready",
      origin: "generated", plan, promptSnapshot: input.renderedPrompt, inputObservationId: raw.observationId,
      sourceReceiptIds: [...sources.receiptIds, raw.proof.receiptId], parentVersion: null, legacyVersion: null,
      taskId: input.taskId ?? null, workDir: input.workDir ?? null, expiresAt: new Date(now.getTime() + 7200000).toISOString(), createdAt: now.toISOString() });
    await recordPlanCommand(db, { id: randomUUID(), userId: input.userId, commandId, planId: plan.id, action: "generated", requestHash, recordId: record.id });
    return publicRecord(record);
  });
}

type ExecutionInput = { userId: string; planId: string; expectedVersion: string; commandId: string; taskId?: string | null; workDir?: string | null };
function executionInput(input: ExecutionInput) { owner(input.userId); const { userId: _, ...request } = input; return parsed(executePlanSchema.safeParse(request)); }
async function executionRecord(input: ExecutionInput) {
  const request = executionInput(input);
  const record = await latestMemoryPlan(db, input.userId, request.planId); if (!record) throw unavailable();
  assertCurrent(record, request);
  if (record.version !== request.expectedVersion) {
    const command = await readPlanCommand(db, input.userId, request.commandId);
    if (record.state !== "approved" || command?.action !== "approve" || command.resultRecordId !== record.id
      || command.requestHash !== planDigest(request)) throw conflict();
  }
  return record;
}
/** HTTP preflight is metadata only. Execution still prepares and admits the
 * actual current sources inside the model run before constructing execute. */
export async function getMemoryPlanForExecution(input: ExecutionInput) {
  executionInput(input);
  input = { ...input, userId: input.userId.toLowerCase() };
  return withDatabaseTransaction(async () => {
    await lockMemoryPlan(db, input.userId, input.planId, "share"); await lockPlanOwner(db, input.userId, input.taskId);
    return publicRecord(await executionRecord(input));
  });
}
export async function prepareMemoryPlanExecution(input: ExecutionInput) {
  owner(input.userId); input = { ...input, userId: input.userId.toLowerCase() };
  const request = executionInput(input);
  if (!exactUseRegistrationRequired()) throw new MemoryModuleError("memory_plan_dispatch_required", 503, "Plan execution requires an active guarded dispatch scope");
  const preview = await withDatabaseTransaction(async () => {
    await lockMemoryPlan(db, input.userId, input.planId, "share"); return executionRecord(input);
  });
  const tickets = await Promise.all(preview.sourceReceiptIds.map(id => preparePersistedExactUse(input.userId, id)));
  const result = await withDatabaseTransaction(async () => {
    await lockPlanCommand(db, input.userId, request.commandId); await lockMemoryPlan(db, input.userId, request.planId, "update");
    await lockPlanOwner(db, input.userId, request.taskId);
    const current = await executionRecord(input); if (current.version !== preview.version) throw conflict();
    const proofs: ExactUseProof[] = [];
    for (const ticket of tickets) proofs.push(await admitPersistedExactUse(ticket));
    const requestHash = planDigest(request);
    let approved = await commandResult(input.userId, request.commandId, "approve", requestHash);
    if (approved) throw new MemoryModuleError("memory_plan_execution_already_started", 409,
      "This approval already started an execution. Inspect its recorded state; generate a new plan before another execution");
    if (!approved) {
      if (current.version !== request.expectedVersion || current.state !== "ready") throw conflict();
      approved = await appendMemoryPlan(db, { ...current, id: randomUUID(), revision: current.revision + 1, state: "approved",
        parentVersion: current.version, createdAt: new Date().toISOString() });
      await recordPlanCommand(db, { id: randomUUID(), userId: input.userId, commandId: request.commandId, planId: request.planId,
        action: "approve", requestHash, recordId: approved.id });
    }
    const planProof = await admitExactUse({ requester: { type: "chat", userId: input.userId }, accessMode: "owner_override",
      purpose: "approved_plan_execution", plans: [{ id: approved.id, revision: approved.version }] });
    // Registry limits and conflicting transcript versions are part of approval
    // admission. A failure here rolls back the claim and all receipt writes.
    [...proofs, planProof].forEach(registerExactUseForDispatch);
    return { approved };
  });
  return { ...publicRecord(result.approved), originalPrompt: result.approved.promptSnapshot };
}

function legacyVersion(row: NonNullable<Awaited<ReturnType<typeof legacyMemoryPlan>>>) { return `legacyplan1:${planDigest(row)}`; }
export async function inspectMemoryPlan(userId: string, planId: string) {
  owner(userId); userId = userId.toLowerCase(); planKey(planId);
  return withDatabaseTransaction(async () => {
    await lockPlanOwner(db, userId); await lockMemoryPlan(db, userId, planId, "share");
    const record = await latestMemoryPlan(db, userId, planId);
    if (record) return { kind: "memory_plan" as const, ...publicRecord(record), execution: await latestPlanExecution(db, userId, planId),
      available: record.state !== "revoked" && Date.parse(record.expiresAt) > Date.now() };
    const legacy = await legacyMemoryPlan(db, userId, planId); if (!legacy) throw unavailable();
    return { kind: "legacy_unverified" as const, plan: toTaskPlan(parsed(planPayloadSchema.safeParse(legacy.planJson))),
      legacyVersion: legacyVersion(legacy), historicalSources: "unknown" as const, requiresOwnerRebase: true as const,
      taskId: legacy.taskId && uuid.test(legacy.taskId) ? legacy.taskId : null, workDir: legacy.workDir,
      warning: "Historical source receipts were not recorded. Review the proposal with a fresh input and authorized source reads." };
  });
}
export async function rebaseLegacyMemoryPlan(userId: string, planId: string, unknown: unknown) {
  owner(userId); userId = userId.toLowerCase(); planKey(planId); const request = parsed(legacyRebaseSchema.safeParse(unknown));
  const tickets = await Promise.all([...new Set(request.sourceReceiptIds)].map(id => preparePersistedExactUse(userId, id)));
  const requestHash = planDigest({ planId, ...request });
  return withDatabaseTransaction(async () => {
    await lockPlanCommand(db, userId, request.commandId); await lockMemoryPlan(db, userId, planId, "update"); await lockPlanOwner(db, userId);
    const replay = await commandResult(userId, request.commandId, "legacy_rebase", requestHash); if (replay) return publicRecord(replay, true);
    // A known plan with invalid sources cannot discard its dependencies through
    // the legacy recovery path. It needs a fresh generation and review.
    if (await latestMemoryPlan(db, userId, planId)) throw conflict();
    const legacy = await legacyMemoryPlan(db, userId, planId); if (!legacy || legacyVersion(legacy) !== request.expectedLegacyVersion) throw conflict();
    const plan = parsed(planPayloadSchema.safeParse(legacy.planJson));
    const taskId = legacy.taskId && uuid.test(legacy.taskId) ? legacy.taskId : null; await lockPlanOwner(db, userId, taskId);
    const proofs: ExactUseProof[] = []; for (const ticket of tickets) proofs.push(await admitPersistedExactUse(ticket));
    const raw = await inputReceipt(userId, planId, request.commandId, request.inputPrompt, "owner_rebased_legacy");
    const now = new Date();
    const record = await appendMemoryPlan(db, { id: randomUUID(), userId, planId, revision: 1, state: "ready", origin: "owner_rebased_legacy", plan,
      promptSnapshot: `Owner reviewed control proposal. Historical sources are unknown; the proposal is not a verified fact.\nCurrent owner input:\n${request.inputPrompt}\nReviewed proposal:\n${JSON.stringify(plan)}`,
      inputObservationId: raw.observationId, sourceReceiptIds: [...proofs.map(proof => proof.receiptId), raw.proof.receiptId],
      parentVersion: null, legacyVersion: request.expectedLegacyVersion, taskId, workDir: legacy.workDir,
      expiresAt: new Date(now.getTime() + 7200000).toISOString(), createdAt: now.toISOString() });
    await recordPlanCommand(db, { id: randomUUID(), userId, commandId: request.commandId, planId, action: "legacy_rebase", requestHash, recordId: record.id });
    return publicRecord(record);
  });
}
export async function revokeMemoryPlan(userId: string, planId: string, unknown: unknown) {
  owner(userId); userId = userId.toLowerCase(); planKey(planId); const request = parsed(revokePlanSchema.safeParse(unknown)); const requestHash = planDigest({ planId, ...request });
  return withDatabaseTransaction(async () => {
    await lockPlanCommand(db, userId, request.commandId); await lockMemoryPlan(db, userId, planId, "update"); await lockPlanOwner(db, userId);
    const replay = await commandResult(userId, request.commandId, "revoke", requestHash); if (replay) return publicRecord(replay, true);
    const current = await latestMemoryPlan(db, userId, planId); if (!current || current.version !== request.expectedVersion) throw conflict();
    const record = await appendMemoryPlan(db, { ...current, id: randomUUID(), revision: current.revision + 1, state: "revoked",
      parentVersion: current.version, createdAt: new Date().toISOString() });
    await recordPlanCommand(db, { id: randomUUID(), userId, commandId: request.commandId, planId, action: "revoke", requestHash, recordId: record.id });
    return publicRecord(record);
  });
}
export async function finishMemoryPlanExecution(input: { userId: string; commandId: string; status: "completed" | "failed" | "interrupted" }) {
  owner(input.userId); if (!uuid.test(input.commandId) || !["completed", "failed", "interrupted"].includes(input.status)) throw conflict();
  input = { ...input, userId: input.userId.toLowerCase(), commandId: input.commandId.toLowerCase() };
  return withDatabaseTransaction(async () => {
    await lockPlanCommand(db, input.userId, input.commandId); await lockPlanOwner(db, input.userId);
    const command = await readPlanCommand(db, input.userId, input.commandId);
    if (!command || command.action !== "approve" || command.executionState !== "running" && command.executionState !== input.status) throw conflict();
    await finishPlanCommand(db, input.userId, input.commandId, input.status); return { recorded: true as const, state: input.status };
  });
}
