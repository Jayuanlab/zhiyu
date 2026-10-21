import { createHash, randomUUID } from "node:crypto";
import type { InteractionTask, InsertInteractionTask } from "@/lib/db/schema";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { assertMemoryDependenciesCurrentInTransaction } from "@/lib/memory/revision/dependencies";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { withExecutionBusinessWrite, ExecutionLeaseError } from "@/lib/work-runtime/execution-lease";
import { withExecutionWriteContext } from "@/lib/work-runtime/execution-write-context";
import { lockTaskCommand, readTaskInTransaction, replaceTaskRecord, replayTaskCommand, taskRevision,
  TaskRecordConflict, TaskRecordInputError, type TaskCommand } from "@/lib/memory/records/tasks";
import { projectInteractionTaskScenariosInTransaction } from "./scenario-task-projection";

export type TaskAction = "confirmEvidence" | "completeTask" | "dismiss" | "snooze" | "correctTime";
export { TaskRecordConflict as TaskActionConflict, TaskRecordInputError as TaskActionInputError } from "@/lib/memory/records/tasks";
const closed = new Set(["done", "dismissed", "deleted"]);
export const taskCommandHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Date)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");
export function validateTaskCommand(commandId: string, expectedVersion?: number) {
  if (typeof commandId !== "string" || !commandId.trim() || commandId.length > 200
    || expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))
    throw new TaskRecordInputError("Invalid task command/version");
}

export async function withInteractionTaskTransaction<T>(userId: string, write: (store: DrizzleDB) => Promise<T>): Promise<T> {
  const lease = resolveExecutionLease();
  if (!lease) return withDatabaseTransaction(() => write(db));
  if (lease.userId !== userId) throw new ExecutionLeaseError("invalid_lease");
  return withExecutionBusinessWrite(lease, context => withExecutionWriteContext(lease, context, () => write(context.db)));
}

export function taskState(task: Pick<InteractionTask, "status" | "metadata" | "dueAt" | "title"> & { revision?: number; sourceObservedAt?: Date | string | null }) {
  const stored = (task.metadata?.taskState ?? {}) as Record<string, unknown>;
  // Legacy display payloads may lack the database revision; writers never use
  // that fallback. After migration the database token is the single clock.
  const version = task.revision ?? Number(stored.version ?? 0);
  const verificationStatus = stored.verificationStatus ?? (task.status === "confirmed" ? "confirmed" : "unverified");
  const taskStatus = closed.has(task.status) ? task.status : "open";
  let dueAt = task.dueAt ? new Date(task.dueAt).toISOString() : null;
  let dueAtConfidence = stored.dueAtConfidence === "confirmed" ? "confirmed" : dueAt ? "proposed" : "unknown";
  if (!dueAt && task.sourceObservedAt) {
    const matches = ["今天", "明天", "后天"].filter(word => task.title.includes(word));
    const zoned = task.sourceObservedAt instanceof Date || /(?:Z|[+-]\d{2}:\d{2})$/i.test(task.sourceObservedAt);
    const sourceTime = zoned ? new Date(task.sourceObservedAt).getTime() : NaN;
    if (matches.length === 1 && Number.isFinite(sourceTime)) {
      const local = new Date(sourceTime + 8 * 3600_000);
      local.setUTCDate(local.getUTCDate() + ({今天: 0, 明天: 1, 后天: 2}[matches[0]] ?? 0));
      local.setUTCHours(23, 59, 59, 999);
      dueAt = new Date(local.getTime() - 8 * 3600_000).toISOString(); dueAtConfidence = "inferred";
    }
  }
  return { version, verificationStatus, taskStatus, dueAt, dueAtConfidence,
    needsTimeReview: dueAtConfidence !== "confirmed", resolvedAt: stored.resolvedAt ?? null, snoozedUntil: stored.snoozedUntil ?? null };
}

/** All task writers share this domain transition. Memory stores the revision;
 * the host commits its scenario projection in the same transaction. */
export async function transitionInteractionTaskInTransaction(store: DrizzleDB, input: {
  userId: string; id: string; commandId: string; expectedVersion?: number;
  action: TaskAction | "setStatus" | "delete"; status?: string; at?: string | null; reason?: string; clearScope?: string;
}) {
  validateTaskCommand(input.commandId, input.expectedVersion);
  if (!["confirmEvidence", "completeTask", "dismiss", "snooze", "correctTime", "setStatus", "delete"].includes(input.action)) throw new TaskRecordInputError("Invalid task action");
  if (input.action === "setStatus" && !["candidate", "confirmed", "done", "dismissed", "deleted"].includes(input.status ?? "")) throw new TaskRecordInputError("Invalid task status");
  if (input.action === "snooze" || input.action === "correctTime") {
    if (input.at !== null && (typeof input.at !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.at) || !Number.isFinite(Date.parse(input.at)))) throw new TaskRecordInputError("An absolute time with timezone is required");
  }
  const command: TaskCommand = { commandId: input.commandId, action: input.action,
    requestHash: taskCommandHash({ id: input.id, action: input.action, status: input.status ?? null, at: input.at ?? null,
      expectedVersion: input.expectedVersion ?? null, reason: input.reason ?? null, clearScope: input.clearScope ?? null }) };
  await lockTaskCommand(store, input.userId, input.commandId);
  const replay = await replayTaskCommand(store, input.userId, command, input.id);
  if (replay) return { ...replay, resultSemantics: "command_result_at_revision" as const };
  const task = await readTaskInTransaction(store, input.userId, input.id, true);
  if (!task) throw new TaskRecordConflict("Task unavailable");
  const revision = taskRevision(task);
  const metadata = task.metadata ?? {};
  const history = Array.isArray(metadata.taskActions) ? metadata.taskActions as Array<Record<string, unknown>> : [];
  const legacy = history.find(action => action.commandId === input.commandId);
  if (legacy) {
    // Legacy JSON is not an immutable command receipt. It may have come from
    // model metadata; never turn it into proof that a mutation succeeded.
    throw new TaskRecordConflict("Legacy command has no verifiable receipt; refresh and issue a new command");
  }
  if (input.expectedVersion !== undefined && revision !== input.expectedVersion) throw new TaskRecordConflict("Task changed; refresh before acting");
  const now = new Date();
  if (input.action === "snooze" && (!input.at || Date.parse(input.at) <= now.getTime())) throw new TaskRecordInputError("Snooze time must be in the future");
  const next = { ...taskState(task), version: revision + 1 };
  const status = input.action === "setStatus" ? input.status! : input.action === "delete" ? "deleted"
    : input.action === "completeTask" ? "done" : input.action === "dismiss" ? "dismissed" : task.status;
  if (closed.has(task.status) && status !== task.status && status !== "deleted") throw new TaskRecordConflict("A closed task requires an explicit reviewed reopening workflow");
  if (task.status === "deleted" && input.action !== "delete" && !(input.action === "setStatus" && status === "deleted")) throw new TaskRecordConflict("Deleted task is unavailable for changes");
  if (((status === "confirmed" || status === "done") && status !== task.status) || input.action === "confirmEvidence")
    await assertMemoryDependenciesCurrentInTransaction(store, { userId: input.userId, entityKind: "interaction_task", entityId: input.id });
  if (input.action === "confirmEvidence" || status === "confirmed") next.verificationStatus = "confirmed";
  if (input.action === "setStatus" && status === "candidate") next.verificationStatus = "unverified";
  if (closed.has(status)) { next.taskStatus = status; next.resolvedAt = now.toISOString(); }
  let dueAt = task.dueAt;
  if (input.action === "snooze") next.snoozedUntil = input.at!;
  if (input.action === "correctTime") {
    dueAt = input.at ? new Date(input.at) : null; next.dueAt = dueAt?.toISOString() ?? null;
    next.dueAtConfidence = "confirmed"; next.needsTimeReview = false;
  }
  const patch: Partial<InsertInteractionTask> = { status, dueAt, updatedAt: now, metadata: { ...metadata,
    ...(status === "deleted" ? { previousStatus: task.status, deletedAt: now.toISOString(), deletedReason: input.reason ?? "user_deleted", deletedBy: "user", ...(input.clearScope ? { clearScope: input.clearScope } : {}) } : {}),
    taskState: next,
  } };
  const result = await replaceTaskRecord(store, task, patch, command);
  await projectInteractionTaskScenariosInTransaction(store, result.task, now);
  return { ...result, resultSemantics: "command_result_at_revision" as const };
}

export async function actOnInteractionTask(input: { userId: string; id: string; commandId: string; expectedVersion: number; action: TaskAction; at?: string | null }) {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new TaskRecordInputError("A current task version is required");
  return withInteractionTaskTransaction(input.userId, store => transitionInteractionTaskInTransaction(store, input));
}
export async function setInteractionTaskStatus(input: { userId: string; id: string; status: string; commandId?: string; expectedVersion?: number }) {
  return withInteractionTaskTransaction(input.userId, async store => {
    const result = await transitionInteractionTaskInTransaction(store, { ...input, commandId: input.commandId ?? randomUUID(), action: "setStatus" });
    return await readTaskInTransaction(store, input.userId, input.id) ?? result.task;
  });
}
