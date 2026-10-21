import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import { memoryStateReadReceipts } from "@/lib/db/schema.pg";
import { memoryInvalid, MemoryModuleError } from "../../kernel/errors";
import { normalizeScenarioIdentity } from "../../records/scenario-record";
import { stableJson } from "../../records/observations";
import { readCurrentScenarioInTransaction } from "./scenarios";
import { readTaskInTransaction, taskRevision } from "./tasks";
import type { CurrentStateReadResult, StateRecordRef, StateVersionRef } from "../../contracts";

function parseRef(value: unknown, userId: string): StateRecordRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) memoryInvalid("A typed current reference is required");
  const ref = value as Record<string, unknown>;
  if (ref.kind === "interaction_task") {
    if (Object.keys(ref).some(key => !["kind", "id"].includes(key)) || typeof ref.id !== "string"
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ref.id)) memoryInvalid("Invalid task reference");
    return { kind: "interaction_task", id: ref.id.toLowerCase() };
  }
  if (ref.kind !== "scenario_state" || Object.keys(ref).some(key => !["kind", "scenarioType", "scenarioKey"].includes(key))) memoryInvalid("Invalid current reference");
  try {
    const identity = normalizeScenarioIdentity({ userId, scenarioType: ref.scenarioType, scenarioKey: ref.scenarioKey } as Parameters<typeof normalizeScenarioIdentity>[0]);
    return { kind: "scenario_state", scenarioType: identity.scenarioType, scenarioKey: identity.scenarioKey };
  } catch { return memoryInvalid("A valid typed scenario key is required"); }
}

/** Owner authority is checked by the public client before entering this reader.
 * A receipt names exactly the state version selected, not a search result. */
export async function readCurrentState(userId: string, value: unknown): Promise<CurrentStateReadResult> {
  const target = parseRef(value, userId);
  const meta = { traceId: randomUUID(), contractVersion: "memory-state.v1" as const, implementationVersion: "memory-t2.v1" as const,
    provider: "postgres" as const, detail: "exact_current_state", warnings: [] as string[] };
  return db.transaction(async store => {
    const [principal] = await store.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("share");
    if (!principal) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity is no longer available");
    const record = target.kind === "interaction_task" ? await readTaskInTransaction(store, userId, target.id, "share")
      : await readCurrentScenarioInTransaction(store, { userId, scenarioType: target.scenarioType, scenarioKey: target.scenarioKey });
    if (!record) return { status: "not_found", code: "state_record_not_found", meta };
    // FK cleanup may change linkage outside the task lifecycle. The opaque read
    // token hashes the complete returned row; expectedVersion remains its domain
    // revision column. JSON round-trip normalizes Dates before canonical hashing.
    const revision = target.kind === "interaction_task" ? `task:${taskRevision(record as import("@/lib/db/schema").InteractionTask)}:${createHash("sha256").update(stableJson(JSON.parse(JSON.stringify(record)))).digest("hex")}`
      : `scenario:${record.id}:${String((record as import("../../records/scenario-record").ScenarioSnapshotRecord).metadata.revision ?? (record as import("../../records/scenario-record").ScenarioSnapshotRecord).content.revision ?? 0)}`;
    const ref: StateVersionRef = { record: target, revision };
    const [saved] = await store.insert(memoryStateReadReceipts).values({ id: randomUUID(), userId, target, revision,
      locator: { kind: target.kind, id: record.id }, traceId: meta.traceId, contractVersion: meta.contractVersion, implementationVersion: meta.implementationVersion }).returning();
    if (!saved) throw new Error("State read receipt was not persisted");
    if (target.kind === "scenario_state") meta.warnings.push("Scenario state is an estimate of observed lineage; it is not confirmation of every business fact");
    return { status: "ok", record, ref, receipt: { id: saved.id, purpose: "current", ref, createdAt: saved.createdAt.toISOString() }, meta };
  });
}
export async function explainCurrentStateRead(userId: string, receiptId: string) {
  const [read] = await db.select().from(memoryStateReadReceipts)
    .where(and(eq(memoryStateReadReceipts.userId, userId), eq(memoryStateReadReceipts.id, receiptId))).limit(1);
  return read ? { status: "ok" as const, type: "state_read" as const, historical: true,
    implementation: { traceId: read.traceId, contractVersion: read.contractVersion, implementationVersion: read.implementationVersion },
    receipt: { id: read.id, purpose: "current", ref: { record: read.target, revision: read.revision }, locator: read.locator, createdAt: read.createdAt.toISOString() },
    detail: "Historical read metadata; use current to load present state" } : { status: "not_found" as const };
}
