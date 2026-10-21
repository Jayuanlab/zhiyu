import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { interactionTasks, interactionEvents, interactionThreads, type InteractionTask, type InsertInteractionTask } from "@/lib/db/schema";
import { interactionTaskRevisions } from "@/lib/db/schema.pg";
import type { DrizzleDB } from "@/lib/db/types";
import { MemoryModuleError } from "../../kernel/errors";
import { acquireMemoryWriteAdvisoryLock } from "../../kernel/locks";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";

export type TaskWriteReceipt = { id: string; commandId: string; fromVersion: number | null; toVersion: number };
export type TaskCommit = { task: InteractionTask; replayed: boolean; receipt: TaskWriteReceipt };
export type TaskCommand = { commandId: string; requestHash: string; action: string };
export class TaskRecordConflict extends Error {}
export class TaskRecordInputError extends Error {}
export function taskRevision(task: Pick<InteractionTask, "revision">) {
  if (!Number.isSafeInteger(task.revision) || task.revision < 0)
    throw new TaskRecordConflict("Task revision is unavailable or exhausted");
  return task.revision;
}
function postgresOnly() {
  if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true")
    throw new MemoryModuleError("unsupported_memory_storage", 422, "Versioned interaction task storage requires PostgreSQL");
}
export async function lockTaskCommand(store: DrizzleDB, userId: string, commandId: string) {
  postgresOnly();
  // The owner command namespace serializes retries before allocating a task ID.
  await acquireMemoryWriteAdvisoryLock(store, JSON.stringify(["interaction-task-command.v1", userId, commandId]));
}
export async function readTaskInTransaction(store: DrizzleDB, userId: string, id: string, lock: boolean | "share" = false): Promise<InteractionTask | null> {
  postgresOnly();
  const query = store.select().from(interactionTasks).where(and(eq(interactionTasks.userId, userId), eq(interactionTasks.id, id)));
  const [row] = await (lock ? query.for(lock === "share" ? "share" : "update") : query);
  return row ?? null;
}
export async function replayTaskCommand(store: DrizzleDB, userId: string, command: TaskCommand, taskId?: string): Promise<TaskCommit | null> {
  const [prior] = await store.select().from(interactionTaskRevisions)
    .where(and(eq(interactionTaskRevisions.userId, userId), eq(interactionTaskRevisions.commandId, command.commandId))).limit(1);
  if (!prior) return null;
  if (prior.requestHash !== command.requestHash || taskId && prior.taskId !== taskId) throw new TaskRecordConflict("Command reused with different task input");
  const stored = prior.snapshot as { task: InteractionTask; fromVersion: number | null };
  if (!stored.task || stored.task.id !== prior.taskId) throw new TaskRecordConflict("Historical task command result is unavailable");
  const task = { ...stored.task, createdAt: new Date(stored.task.createdAt), updatedAt: new Date(stored.task.updatedAt),
    dueAt: stored.task.dueAt ? new Date(stored.task.dueAt) : null };
  return { task, replayed: true, receipt: { id: prior.id, commandId: prior.commandId, fromVersion: stored.fromVersion, toVersion: prior.revision } };
}
export async function assertTaskSources(store: DrizzleDB, input: { userId: string; sourceEventIds: string[]; eventId?: string | null; threadId?: string | null }) {
  const ids = [...new Set(input.sourceEventIds)];
  if (!ids.length || ids.some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) throw new TaskRecordInputError("Exact raw event sources are required");
  const events = await store.select({ id: interactionEvents.id }).from(interactionEvents)
    .where(and(eq(interactionEvents.userId, input.userId), inArray(interactionEvents.id, ids))).for("share");
  if (events.length !== ids.length || input.eventId && !ids.includes(input.eventId)) throw new TaskRecordInputError("Task sources are unavailable or outside the declared range");
  if (input.threadId) {
    const [thread] = await store.select({ id: interactionThreads.id }).from(interactionThreads)
      .where(and(eq(interactionThreads.userId, input.userId), eq(interactionThreads.id, input.threadId))).for("share");
    if (!thread) throw new TaskRecordInputError("Task thread is unavailable");
  }
}
async function audit(store: DrizzleDB, task: InteractionTask, fromVersion: number | null, command: TaskCommand): Promise<TaskCommit> {
  const lease = resolveExecutionLease();
  const [row] = await store.insert(interactionTaskRevisions).values({ id: randomUUID(), userId: task.userId, taskId: task.id,
    revision: task.revision, commandId: command.commandId, requestHash: command.requestHash, action: command.action,
    snapshot: JSON.parse(JSON.stringify({ task, fromVersion, actor: task.userId,
      execution: lease ? { workshopId: lease.workshopId, runId: lease.runId, workerId: lease.workerId, token: lease.token } : null,
      authority: "interaction_task_domain", historyCoverage: "versioned_command" })) }).returning();
  if (!row) throw new Error("Task revision audit was not persisted");
  return { task, replayed: false, receipt: { id: row.id, commandId: row.commandId, fromVersion, toVersion: task.revision } };
}
export async function insertTaskRecord(store: DrizzleDB, input: InsertInteractionTask, command: TaskCommand) {
  const [task] = await store.insert(interactionTasks).values(input).returning();
  if (!task) throw new Error("Task was not persisted");
  return audit(store, task, null, command);
}
export async function replaceTaskRecord(store: DrizzleDB, before: InteractionTask, patch: Partial<InsertInteractionTask>, command: TaskCommand) {
  const revision = taskRevision(before) + 1;
  if (!Number.isSafeInteger(revision)) throw new TaskRecordConflict("Task revision is exhausted");
  const [task] = await store.update(interactionTasks).set({ ...patch, revision })
    .where(and(eq(interactionTasks.userId, before.userId), eq(interactionTasks.id, before.id), eq(interactionTasks.revision, before.revision))).returning();
  if (!task) throw new TaskRecordConflict("Task changed; refresh before acting");
  return audit(store, task, before.revision, command);
}
