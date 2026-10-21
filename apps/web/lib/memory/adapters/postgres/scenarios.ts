import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { brainMemories, brainStateSnapshots, interactionEvents, type BrainStateSnapshot } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { acquireMemoryWriteAdvisoryLock } from "../../kernel/locks";
import { assertMemoryReferenceIds, MemoryReferenceError } from "../../kernel/reference-errors";
import { normalizeScenarioIdentity, scenarioSnapshotFromRow, scenarioSnapshotToInsertRow, type ScenarioIdentity } from "../../records/scenario-record";

function identityCondition(input: ScenarioIdentity) {
  const identity = normalizeScenarioIdentity(input);
  assertMemoryReferenceIds([identity.userId]);
  return and(eq(brainStateSnapshots.userId, identity.userId), eq(brainStateSnapshots.scopeType, "global"), isNull(brainStateSnapshots.scopeId),
    eq(brainStateSnapshots.snapshotType, "wechat_scenario_state"),
    sql`${brainStateSnapshots.metadata}->>'scenarioType' = ${identity.scenarioType}`,
    sql`lower(normalize(btrim(${brainStateSnapshots.metadata}->>'scenarioKey'), NFKC)) = ${identity.scenarioKey}`);
}

export async function lockScenarioLineage(store: DrizzleDB, input: ScenarioIdentity) {
  const identity = normalizeScenarioIdentity(input);
  assertMemoryReferenceIds([identity.userId]);
  await acquireMemoryWriteAdvisoryLock(store, JSON.stringify(["interaction-scenario-state.v1", identity.userId, identity.scenarioType, identity.scenarioKey]));
}

export async function readCurrentScenarioInTransaction(store: DrizzleDB, input: ScenarioIdentity) {
  const [latest] = await store.select().from(brainStateSnapshots).where(identityCondition(input))
    .orderBy(desc(sql`case when ${brainStateSnapshots.metadata}->>'revision' ~ '^[0-9]+$' then (${brainStateSnapshots.metadata}->>'revision')::bigint else 0 end`),
      desc(brainStateSnapshots.createdAt), desc(brainStateSnapshots.id)).limit(1);
  return latest ? scenarioSnapshotFromRow(latest as BrainStateSnapshot) : null;
}

/** One exact owner + scenario type + normalized key query, never a recent-list scan. */
export async function readCurrentScenario(input: ScenarioIdentity) {
  return readCurrentScenarioInTransaction(db, input);
}

export async function scenarioBatchExists(store: DrizzleDB, input: ScenarioIdentity, batchHash: string) {
  const [replayed] = await store.select({ id: brainStateSnapshots.id }).from(brainStateSnapshots)
    .where(and(identityCondition(input), sql`${brainStateSnapshots.metadata}->>'batchHash' = ${batchHash}`)).limit(1);
  return !!replayed;
}

export async function readScenarioSourceTimes(store: DrizzleDB, userId: string, ids: string[]) {
  const sourceEventIds = [...new Set(ids)];
  assertMemoryReferenceIds([userId, ...sourceEventIds]);
  if (!sourceEventIds.length) return new Map<string, string>();
  const events = await store.select({ id: interactionEvents.id, messageTime: interactionEvents.messageTime }).from(interactionEvents)
    .where(and(eq(interactionEvents.userId, userId), inArray(interactionEvents.id, sourceEventIds))).for("share");
  if (events.length !== sourceEventIds.length) throw new MemoryReferenceError();
  return new Map<string, string>(events.map((event: { id: string; messageTime: Date | string }) => [event.id, new Date(event.messageTime).toISOString()]));
}

export async function readOwnedScenarioMemoryIds(store: DrizzleDB, userId: string, ids: string[]) {
  assertMemoryReferenceIds([userId, ...ids]);
  const rows = ids.length ? await store.select({ id: brainMemories.id }).from(brainMemories)
    .where(and(eq(brainMemories.userId, userId), inArray(brainMemories.id, ids))).for("share") : [];
  return new Set<string>(rows.map((row: { id: string }) => row.id));
}

export async function appendScenarioSnapshot(store: DrizzleDB, input: Parameters<typeof scenarioSnapshotToInsertRow>[0]) {
  const [created] = await store.insert(brainStateSnapshots).values(scenarioSnapshotToInsertRow(input)).returning();
  if (!created) throw new Error("Scenario snapshot was not persisted");
  return scenarioSnapshotFromRow(created as BrainStateSnapshot);
}
