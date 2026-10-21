import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "@/lib/db/types";
import { assertMemoryReferenceIds, MemoryReferenceError } from "../kernel/reference-errors";
import { normalizeScenarioIdentity } from "../records/scenario-record";
import { readCurrentScenarioInTransaction, lockScenarioLineage, scenarioBatchExists, readScenarioSourceTimes,
  readOwnedScenarioMemoryIds, appendScenarioSnapshot } from "../records/scenarios";
import type { InteractionScenarioSnapshotDraft } from "./scenarios";
import { mergeInteractionScenarioState, scenarioStateBatchHash } from "./scenario-state";

/** Called only by trusted domain handlers inside their authorized transaction.
 * It does not acquire an owner capability, start a transaction or grant access. */
export async function persistScenarioStateInTransaction(store: DrizzleDB, input: { userId: string; draft: InteractionScenarioSnapshotDraft }) {
  const { draft } = input;
  const identity = normalizeScenarioIdentity({ userId: input.userId, scenarioType: draft.scenarioType, scenarioKey: draft.scenarioKey });
  const userId = identity.userId;
  assertMemoryReferenceIds([userId, ...draft.sourceEventIds, ...draft.sourceMemoryIds]);
  await lockScenarioLineage(store, identity);
  const latest = await readCurrentScenarioInTransaction(store, identity);
  const batchHash = scenarioStateBatchHash(draft);
  if (await scenarioBatchExists(store, identity, batchHash) && latest) return { id: latest.id, result: latest, written: false };
  const sourceTimes = await readScenarioSourceTimes(store, userId, draft.sourceEventIds);
  const taskUpdates = (draft.content.taskUpdates ?? draft.content.openLoops).map(task => {
    const times = task.sourceEventIds.map(id => sourceTimes.get(id)).filter((time): time is string => !!time).sort();
    return times.length ? { ...task, sourceObservedAt: times.at(-1) } : task;
  });
  const merged = mergeInteractionScenarioState({ draft: { ...draft, content: { ...draft.content, taskUpdates } }, previous: latest });
  merged.metadata.batchHash = batchHash;
  const ownedMemoryIds = await readOwnedScenarioMemoryIds(store, userId, merged.sourceMemoryIds);
  if (draft.sourceMemoryIds.some(id => !ownedMemoryIds.has(id))) throw new MemoryReferenceError();
  const unresolvedHistoricalMemoryIds = merged.sourceMemoryIds.filter(id => !ownedMemoryIds.has(id));
  merged.sourceMemoryIds = merged.sourceMemoryIds.filter(id => ownedMemoryIds.has(id));
  merged.metadata = { ...merged.metadata, sourceMemoryIds: merged.sourceMemoryIds, unresolvedHistoricalMemoryIds,
    memoryReferenceSemantics: "historical_estimates_not_current_business_state" };
  const created = await appendScenarioSnapshot(store, { id: randomUUID(), userId, content: merged.content,
    sourceMemoryIds: merged.sourceMemoryIds, metadata: merged.metadata, createdAt: new Date() });
  return { id: created.id, result: created };
}
