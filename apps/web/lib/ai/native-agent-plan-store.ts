import type { TaskPlan } from "@openzhiyu/ai/agent/types";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { nativeAgentPlans } from "@/lib/db/schema";

export interface NativeAgentStoredPlan {
  ownerId: string;
  plan: TaskPlan;
  originalPrompt: string;
  workDir?: string | null;
  taskId?: string | null;
  createdAt: number;
  expiresAt: number;
}

export type NativeAgentPlanLookupResult =
  | { state: "found"; record: NativeAgentStoredPlan }
  | { state: "missing" }
  | { state: "expired" }
  | { state: "owner_mismatch" }
  | { state: "workdir_mismatch"; expected: string | null; actual: string | null };

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const plans = new Map<string, NativeAgentStoredPlan>();

function key(ownerId: string, planId: string) {
  return `${ownerId}:${planId}`;
}

function normalizeOptionalPath(value: string | undefined | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function storeNativeAgentPlan(input: {
  ownerId: string;
  plan: TaskPlan;
  originalPrompt: string;
  workDir?: string | null;
  taskId?: string | null;
  now?: number;
  ttlMs?: number;
}) {
  const now = input.now ?? Date.now();
  const record: NativeAgentStoredPlan = {
    ownerId: input.ownerId,
    plan: input.plan,
    originalPrompt: input.originalPrompt,
    workDir: normalizeOptionalPath(input.workDir),
    taskId: input.taskId ?? null,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
  };
  plans.set(key(input.ownerId, input.plan.id), record);
  return record;
}

export function lookupNativeAgentPlan(input: {
  ownerId: string;
  planId: string;
  workDir?: string | null;
  now?: number;
}): NativeAgentPlanLookupResult {
  const now = input.now ?? Date.now();
  const record = plans.get(key(input.ownerId, input.planId));
  if (!record) {
    const anyOwnerRecord = Array.from(plans.values()).find(
      (candidate) => candidate.plan.id === input.planId,
    );
    return anyOwnerRecord ? { state: "owner_mismatch" } : { state: "missing" };
  }
  if (record.expiresAt <= now) {
    plans.delete(key(input.ownerId, input.planId));
    return { state: "expired" };
  }
  const expected = normalizeOptionalPath(record.workDir);
  const actual = normalizeOptionalPath(input.workDir);
  if (expected !== actual) {
    return {
      state: "workdir_mismatch",
      expected,
      actual,
    };
  }
  return { state: "found", record };
}

export function clearNativeAgentPlanStoreForTests() {
  plans.clear();
}

function toStoredRecord(input: {
  ownerId: string;
  plan: TaskPlan;
  originalPrompt: string;
  workDir?: string | null;
  taskId?: string | null;
  createdAt: Date;
  expiresAt: Date;
}): NativeAgentStoredPlan {
  return {
    ownerId: input.ownerId,
    plan: input.plan,
    originalPrompt: input.originalPrompt,
    workDir: normalizeOptionalPath(input.workDir),
    taskId: input.taskId ?? null,
    createdAt: input.createdAt.getTime(),
    expiresAt: input.expiresAt.getTime(),
  };
}

function fromPlanRow(row: {
  ownerId: string;
  planJson: TaskPlan;
  originalPrompt: string;
  workDir: string | null;
  taskId: string | null;
  createdAt: Date;
  expiresAt: Date;
}): NativeAgentStoredPlan {
  return {
    ownerId: row.ownerId,
    plan: row.planJson,
    originalPrompt: row.originalPrompt,
    workDir: normalizeOptionalPath(row.workDir),
    taskId: row.taskId ?? null,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

export async function saveNativeAgentPlan(input: {
  ownerId: string;
  plan: TaskPlan;
  originalPrompt: string;
  workDir?: string | null;
  taskId?: string | null;
  now?: number;
  ttlMs?: number;
}) {
  const memoryRecord = storeNativeAgentPlan(input);
  const now = input.now ?? Date.now();
  const createdAt = new Date(now);
  const expiresAt = new Date(now + (input.ttlMs ?? DEFAULT_TTL_MS));
  const persistentRecord = toStoredRecord({
    ownerId: input.ownerId,
    plan: input.plan,
    originalPrompt: input.originalPrompt,
    workDir: input.workDir,
    taskId: input.taskId,
    createdAt,
    expiresAt,
  });

  try {
    await db
      .insert(nativeAgentPlans)
      .values({
        ownerId: persistentRecord.ownerId,
        planId: persistentRecord.plan.id,
        planJson: persistentRecord.plan,
        originalPrompt: persistentRecord.originalPrompt,
        workDir: persistentRecord.workDir,
        taskId: persistentRecord.taskId,
        createdAt,
        expiresAt,
        updatedAt: createdAt,
      })
      .onConflictDoUpdate({
        target: [nativeAgentPlans.ownerId, nativeAgentPlans.planId],
        set: {
          planJson: persistentRecord.plan,
          originalPrompt: persistentRecord.originalPrompt,
          workDir: persistentRecord.workDir,
          taskId: persistentRecord.taskId,
          createdAt,
          expiresAt,
          updatedAt: createdAt,
        },
      });
    return persistentRecord;
  } catch (error) {
    console.warn("[NativeAgentPlanStore] Failed to persist plan; using memory fallback", {
      ownerId: input.ownerId,
      planId: input.plan.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return memoryRecord;
  }
}

export async function lookupStoredNativeAgentPlan(input: {
  ownerId: string;
  planId: string;
  workDir?: string | null;
  now?: number;
}): Promise<NativeAgentPlanLookupResult> {
  const now = input.now ?? Date.now();
  const nowDate = new Date(now);

  try {
    await db
      .delete(nativeAgentPlans)
      .where(lt(nativeAgentPlans.expiresAt, nowDate));

    const [row] = await db
      .select()
      .from(nativeAgentPlans)
      .where(
        and(
          eq(nativeAgentPlans.ownerId, input.ownerId),
          eq(nativeAgentPlans.planId, input.planId),
        ),
      )
      .limit(1);

    if (row) {
      if (row.expiresAt.getTime() <= now) {
        await db
          .delete(nativeAgentPlans)
          .where(
            and(
              eq(nativeAgentPlans.ownerId, input.ownerId),
              eq(nativeAgentPlans.planId, input.planId),
            ),
          );
        return { state: "expired" };
      }

      const record = fromPlanRow(row);
      const expected = normalizeOptionalPath(record.workDir);
      const actual = normalizeOptionalPath(input.workDir);
      if (expected !== actual) {
        return { state: "workdir_mismatch", expected, actual };
      }
      return { state: "found", record };
    }

    const [otherOwnerRow] = await db
      .select({ ownerId: nativeAgentPlans.ownerId })
      .from(nativeAgentPlans)
      .where(eq(nativeAgentPlans.planId, input.planId))
      .limit(1);

    return otherOwnerRow ? { state: "owner_mismatch" } : { state: "missing" };
  } catch (error) {
    console.warn("[NativeAgentPlanStore] Failed to read persistent plan; using memory fallback", {
      ownerId: input.ownerId,
      planId: input.planId,
      error: error instanceof Error ? error.message : String(error),
    });
    return lookupNativeAgentPlan(input);
  }
}
