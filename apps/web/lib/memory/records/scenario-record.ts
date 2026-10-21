import type { BrainStateSnapshot, InsertBrainStateSnapshot } from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import { normalizeScenarioKey, ScenarioStateError, type ScenarioType } from "../kernel/scenario-identity";
import { assertMemoryReferenceIds } from "../kernel/reference-errors";

export type ScenarioIdentity = { userId: string; scenarioType: ScenarioType; scenarioKey: string };
export type ScenarioSnapshotRecord = {
  id: string; userId: string; scope: { type: "global" }; snapshotType: string;
  content: Record<string, unknown>; sourceMemoryIds: string[];
  metadata: Record<string, unknown>; createdAt: string;
};

export function normalizeScenarioIdentity(input: ScenarioIdentity): ScenarioIdentity {
  assertMemoryReferenceIds([input.userId]);
  const scenarioKey = typeof input.scenarioKey === "string" ? normalizeScenarioKey(input.scenarioKey) : "";
  if (!["person", "group", "project", "topic", "transaction", "family", "work"].includes(input.scenarioType) || !scenarioKey || scenarioKey.length > 2048) {
    throw new ScenarioStateError("scenario_state_invalid", "A typed scenario identity is required");
  }
  return { ...input, userId: input.userId.toLowerCase(), scenarioKey };
}

export function scenarioSnapshotFromRow(row: BrainStateSnapshot): ScenarioSnapshotRecord {
  const sourceMemoryIds = deserializeJson(row.sourceMemoryIds);
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new ScenarioStateError("scenario_state_invalid", "Invalid stored scenario timestamp");
  return { id: row.id, userId: row.userId, scope: { type: "global" }, snapshotType: row.snapshotType,
    content: deserializeJson(row.content) as Record<string, unknown>,
    sourceMemoryIds: Array.isArray(sourceMemoryIds) ? sourceMemoryIds.filter((value): value is string => typeof value === "string") : [],
    metadata: deserializeJson(row.metadata) as Record<string, unknown>, createdAt: createdAt.toISOString() };
}

export function scenarioSnapshotToInsertRow(input: {
  id: string; userId: string; content: Record<string, unknown>; sourceMemoryIds: string[];
  metadata: Record<string, unknown>; createdAt: Date;
}): InsertBrainStateSnapshot {
  return { ...input, scopeType: "global", scopeId: null, snapshotType: "wechat_scenario_state",
    content: serializeJson(input.content), sourceMemoryIds: serializeJson(input.sourceMemoryIds), metadata: serializeJson(input.metadata) } as InsertBrainStateSnapshot;
}
