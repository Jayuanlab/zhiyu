import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { interactionTasks } from "@/lib/db/schema";
import type { InteractionTask } from "@/lib/db/schema";
import { assertMemoryDependenciesCurrentInTransaction } from "@/lib/brain/memory-dependencies";

export type TaskAction = "confirmEvidence" | "completeTask" | "dismiss" | "snooze" | "correctTime";
export class TaskActionConflict extends Error {}
export class TaskActionInputError extends Error {}

export function taskState(task: Pick<InteractionTask, "status" | "metadata" | "dueAt" | "title"> & {sourceObservedAt?: Date | string | null}) {
  const stored = (task.metadata?.taskState ?? {}) as Record<string, unknown>;
  const verificationStatus = stored.verificationStatus ?? (task.status === "confirmed" ? "confirmed" : "unverified");
  const taskStatus = stored.taskStatus ?? (task.status === "done" ? "done" : task.status === "dismissed" ? "dismissed" : "open");
  let dueAt = task.dueAt ? new Date(task.dueAt).toISOString() : null;
  let dueAtConfidence = stored.dueAtConfidence === "confirmed" ? "confirmed" : dueAt ? "proposed" : "unknown";
  // Relative text stays untouched. A date candidate is anchored only to the source event.
  if (!dueAt && task.sourceObservedAt) {
    const matches = ["今天", "明天", "后天"].filter(word => task.title.includes(word));
    const zoned = task.sourceObservedAt instanceof Date || /(?:Z|[+-]\d{2}:\d{2})$/i.test(task.sourceObservedAt);
    const sourceTime = zoned ? new Date(task.sourceObservedAt).getTime() : NaN;
    if (matches.length === 1 && Number.isFinite(sourceTime)) {
      const local = new Date(sourceTime + 8 * 3600_000);
      local.setUTCDate(local.getUTCDate() + ({今天: 0, 明天: 1, 后天: 2}[matches[0]] ?? 0));
      local.setUTCHours(23, 59, 59, 999);
      dueAt = new Date(local.getTime() - 8 * 3600_000).toISOString();
      dueAtConfidence = "inferred";
    }
  }
  return {version: Number(stored.version ?? 0), verificationStatus, taskStatus, dueAt, dueAtConfidence,
    needsTimeReview: dueAtConfidence !== "confirmed", resolvedAt: stored.resolvedAt ?? null,
    snoozedUntil: stored.snoozedUntil ?? null};
}

export async function actOnInteractionTask(input: {
  userId: string; id: string; commandId: string; expectedVersion: number; action: TaskAction; at?: string | null;
}) {
  if (!input.commandId || input.commandId.length > 100 || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new TaskActionInputError("Invalid task command/version");
  if (!["confirmEvidence", "completeTask", "dismiss", "snooze", "correctTime"].includes(input.action)) throw new TaskActionInputError("Invalid task action");
  if (input.action === "snooze" || input.action === "correctTime") {
    if (input.at !== null && (typeof input.at !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.at) || !Number.isFinite(Date.parse(input.at)))) throw new TaskActionInputError("An absolute time with timezone is required");
    if (input.action === "snooze" && (!input.at || Date.parse(input.at) <= Date.now())) throw new TaskActionInputError("Snooze time must be in the future");
  }
  const hash = createHash("sha256").update(JSON.stringify({action: input.action, at: input.at ?? null})).digest("hex");
  return db.transaction(async (tx: any) => {
    const [task] = await tx.select().from(interactionTasks)
      .where(and(eq(interactionTasks.userId, input.userId), eq(interactionTasks.id, input.id))).for("update");
    if (!task) throw new TaskActionConflict("Task unavailable");
    const metadata = task.metadata as Record<string, unknown>;
    const history = Array.isArray(metadata.taskActions) ? metadata.taskActions as Array<Record<string, unknown>> : [];
    const existing = history.find(action => action.commandId === input.commandId);
    if (existing) {
      if (existing.hash !== hash) throw new TaskActionConflict("Command reused with different input");
      return {task, replayed: true};
    }
    const state = taskState(task);
    if (state.version !== input.expectedVersion) throw new TaskActionConflict("Task changed; refresh before acting");
    if (input.action === "confirmEvidence" || input.action === "completeTask") {
      await assertMemoryDependenciesCurrentInTransaction(tx, { userId: input.userId, entityKind: "interaction_task", entityId: input.id });
    }
    const now = new Date();
    const next = {...state, version: state.version + 1};
    let status = task.status;
    let dueAt = task.dueAt;
    if (input.action === "confirmEvidence") next.verificationStatus = "confirmed";
    if (input.action === "completeTask" || input.action === "dismiss") {
      next.taskStatus = input.action === "completeTask" ? "done" : "dismissed";
      next.resolvedAt = now.toISOString();
      status = next.taskStatus;
    }
    if (input.action === "snooze") next.snoozedUntil = input.at!;
    if (input.action === "correctTime") {
      dueAt = input.at ? new Date(input.at) : null;
      next.dueAt = dueAt?.toISOString() ?? null;
      next.dueAtConfidence = "confirmed";
      next.needsTimeReview = false;
    }
    const [updated] = await tx.update(interactionTasks).set({status, dueAt, updatedAt: now,
      metadata: {...metadata, taskState: next, taskActions: [...history, {
        commandId: input.commandId, action: input.action, hash, at: input.at ?? null,
        actor: input.userId, occurredAt: now.toISOString(), fromVersion: state.version, toVersion: next.version,
      }]},
    }).where(and(eq(interactionTasks.id, input.id), eq(interactionTasks.userId, input.userId))).returning();
    return {task: updated, replayed: false};
  });
}
