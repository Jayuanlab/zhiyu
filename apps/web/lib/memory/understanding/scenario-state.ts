import { createHash } from "node:crypto";
import type { InteractionScenarioSnapshotDraft } from "./scenarios";
import { normalizeScenarioKey, ScenarioStateError } from "../kernel/scenario-identity";
export { ScenarioStateError } from "../kernel/scenario-identity";

export const SCENARIO_STATE_MERGE_VERSION = "interaction-scenario-incremental.v2";
export const normalizeInteractionScenarioKey = normalizeScenarioKey;
const closedStatuses = new Set(["done", "dismissed", "deleted"]);
type DraftContent = InteractionScenarioSnapshotDraft["content"];
export type ScenarioTaskState = DraftContent["openLoops"][number];
export type ScenarioStateContent = DraftContent & {
  stateVersion: typeof SCENARIO_STATE_MERGE_VERSION;
  authority: "model_estimate_unverified";
  verification: "business_state_not_verified";
  previousSnapshotId: string | null;
  revision: number;
  observedAt: string;
  taskUpdates: ScenarioTaskState[];
  closedLoops: ScenarioTaskState[];
  taskConflicts: Array<{ id: string; reason: string; previousStatus: string; incomingStatus: string;
    previousRevision?: number; incomingRevision?: number }>;
  sourceRange: { firstObservedAt: string; lastObservedAt: string; sourceEventIds: string[]; scope: "user_typed_scenario" };
};
export type PreviousScenarioState = {
  id: string;
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sourceMemoryIds?: string[];
};

const unique = (values: string[]) => [...new Set(values)].sort();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
function list<T extends { id: string }>(value: unknown, field: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || typeof item.id !== "string")) {
    throw new ScenarioStateError("scenario_state_invalid", `Invalid scenario ${field}`);
  }
  return value as T[];
}
function mergeById<T extends { id: string }>(before: T[], delta: T[]) {
  const values = new Map(before.map(item => [item.id, item]));
  const seen = new Map<string, string>();
  for (const item of delta) {
    const fingerprint = JSON.stringify(stable(item));
    if (seen.has(item.id) && seen.get(item.id) !== fingerprint) throw new ScenarioStateError("scenario_state_invalid", "Conflicting updates for the same scenario item");
    seen.set(item.id, fingerprint);
    values.set(item.id, item);
  }
  return [...values.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function businessRevision(task: ScenarioTaskState) {
  if (task.stateRevision === undefined) return undefined;
  if (task.stateAuthority !== "business_task_record" || !Number.isSafeInteger(task.stateRevision) || task.stateRevision < 0) {
    throw new ScenarioStateError("scenario_state_invalid", "A task revision requires host business authority and a nonnegative safe integer");
  }
  return task.stateRevision;
}
function taskValue(task: ScenarioTaskState) {
  return JSON.stringify(stable({ title: task.title, status: task.status, verificationStatus: task.verificationStatus,
    sourceEventIds: [...task.sourceEventIds].sort() }));
}
export function scenarioStateBatchHash(draft: InteractionScenarioSnapshotDraft) {
  return createHash("sha256").update(JSON.stringify(stable({
    scenarioType: draft.scenarioType, scenarioKey: normalizeInteractionScenarioKey(draft.scenarioKey), title: draft.title,
    notes: [...draft.content.notes].sort((a, b) => a.id.localeCompare(b.id)),
    memories: [...draft.content.memories].sort((a, b) => a.id.localeCompare(b.id)),
    taskUpdates: [...(draft.content.taskUpdates ?? draft.content.openLoops)].sort((a, b) => a.id.localeCompare(b.id)),
    sourceEventIds: unique(draft.sourceEventIds), sourceMemoryIds: unique(draft.sourceMemoryIds),
  }))).digest("hex");
}

/** Append-only projections are estimates. Task statuses here never change the business task. */
export function mergeInteractionScenarioState(input: { previous?: PreviousScenarioState | null; draft: InteractionScenarioSnapshotDraft }): {
  content: ScenarioStateContent; metadata: Record<string, unknown>; sourceMemoryIds: string[];
} {
  const { previous, draft } = input;
  const prior = previous?.content ?? {};
  if (draft.content.scenarioType !== draft.scenarioType || normalizeInteractionScenarioKey(draft.content.scenarioKey) !== normalizeInteractionScenarioKey(draft.scenarioKey)) {
    throw new ScenarioStateError("scenario_state_invalid", "Scenario draft identity does not match its content");
  }
  if (previous && (prior.scenarioType !== draft.scenarioType || typeof prior.scenarioKey !== "string" || normalizeInteractionScenarioKey(prior.scenarioKey) !== normalizeInteractionScenarioKey(draft.scenarioKey))) {
    throw new ScenarioStateError("scenario_state_invalid", "Previous scenario identity does not match");
  }
  const observedAt = draft.metadata.observedAt;
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) throw new ScenarioStateError("scenario_state_invalid", "Scenario observedAt is required");
  const previousRevision = previous ? prior.revision ?? previous.metadata.revision ?? 0 : 0;
  if (!Number.isSafeInteger(previousRevision) || Number(previousRevision) < 0) throw new ScenarioStateError("scenario_state_invalid", "Invalid previous scenario revision");
  if (Number(previousRevision) >= Number.MAX_SAFE_INTEGER) throw new ScenarioStateError("scenario_state_capacity_exceeded", "Scenario revision capacity exceeded");
  const deltaTasks = draft.content.taskUpdates ?? draft.content.openLoops;
  const visibleSources = [...draft.content.sourceEventIds, ...deltaTasks.flatMap(item => item.sourceEventIds),
    ...draft.content.notes.flatMap(item => item.sourceEventIds), ...draft.content.memories.flatMap(item => item.sourceEventIds)];
  if (visibleSources.some(id => !draft.sourceEventIds.includes(id))) throw new ScenarioStateError("scenario_state_invalid", "Scenario item references are outside the declared source range");
  const previousTasks = [
    ...list<ScenarioTaskState>(prior.openLoops, "openLoops"), ...list<ScenarioTaskState>(prior.closedLoops, "closedLoops"),
  ];
  const previousById = new Map(previousTasks.map(task => [task.id, task]));
  const taskConflicts = Array.isArray(prior.taskConflicts) ? [...prior.taskConflicts] as ScenarioStateContent["taskConflicts"] : [];
  const acceptedTasks = deltaTasks.filter(task => {
    const nextRevision = businessRevision(task);
    const before = previousById.get(task.id); if (!before) return true;
    const previousRevision = businessRevision(before);
    const conflict = (reason: string) => {
      if (taskValue(before) !== taskValue(task) || previousRevision !== nextRevision) taskConflicts.push({ id: task.id, reason,
        previousStatus: before.status, incomingStatus: task.status,
        ...(previousRevision !== undefined ? { previousRevision } : {}), ...(nextRevision !== undefined ? { incomingRevision: nextRevision } : {}) });
      return false;
    };
    if (before.stateAuthority === "business_task_record" && task.stateAuthority !== "business_task_record") {
      return conflict("business_task_record_precedes_model_estimate");
    }
    // Versions are the business order. Wall-clock timestamps may regress or tie.
    if (previousRevision !== undefined) {
      if (nextRevision === undefined) return conflict("business_task_revision_required");
      if (nextRevision < previousRevision) return conflict("late_business_task_revision");
      if (nextRevision === previousRevision) return conflict("same_business_task_revision_conflict");
      return true;
    }
    // A current host row establishes the first versioned baseline for legacy estimates.
    if (nextRevision !== undefined) return true;
    const beforeTime = Date.parse(before.stateAuthority === "business_task_record" ? before.stateObservedAt ?? "" : before.sourceObservedAt ?? "");
    const nextTime = Date.parse(task.stateAuthority === "business_task_record" ? task.stateObservedAt ?? "" : task.sourceObservedAt ?? "");
    const newerBusinessState = task.stateAuthority === "business_task_record" && Number.isFinite(nextTime)
      && (before.stateAuthority !== "business_task_record" || !Number.isFinite(beforeTime) || nextTime > beforeTime);
    const reason = Number.isFinite(beforeTime) && Number.isFinite(nextTime) && nextTime < beforeTime ? "late_source_update"
      : closedStatuses.has(before.status) && !closedStatuses.has(task.status) && !newerBusinessState ? "terminal_task_requires_newer_business_state" : null;
    if (!reason) return true;
    return conflict(reason);
  });
  // Validate ambiguous duplicate deltas before selectively accepting updates.
  mergeById([], deltaTasks);
  const tasks = mergeById(previousTasks, acceptedTasks);
  const notes = mergeById(list<DraftContent["notes"][number]>(prior.notes, "notes"), draft.content.notes);
  const memories = mergeById(list<DraftContent["memories"][number]>(prior.memories, "memories"), draft.content.memories);
  if (tasks.length + notes.length + memories.length > 5_000) throw new ScenarioStateError("scenario_state_capacity_exceeded", "Scenario state capacity exceeded; no history was truncated");
  const openLoops = tasks.filter(task => !closedStatuses.has(task.status));
  const priorSources = prior.sourceEventIds ?? [];
  if (!Array.isArray(priorSources) || priorSources.some(id => typeof id !== "string")) throw new ScenarioStateError("scenario_state_invalid", "Invalid prior source range");
  const sourceEventIds = unique([...priorSources as string[], ...draft.sourceEventIds]);
  const previousRange = record(prior.sourceRange);
  const firstObservedAt = typeof previousRange.firstObservedAt === "string" ? previousRange.firstObservedAt : typeof previous?.metadata.observedAt === "string" ? previous.metadata.observedAt : observedAt;
  const times = [firstObservedAt, observedAt, ...(typeof previousRange.lastObservedAt === "string" ? [previousRange.lastObservedAt] : [])];
  if (times.some(value => !Number.isFinite(Date.parse(value)))) throw new ScenarioStateError("scenario_state_invalid", "Invalid scenario time range");
  const summary = [notes.at(-1)?.content, openLoops.length ? `Open follow-ups: ${openLoops.map(item => item.title).join("; ")}` : "",
    memories.length ? `Durable context: ${memories.map(item => item.content).join("; ")}` : ""].filter(Boolean).join(" ").slice(0, 1_080);
  const content: ScenarioStateContent = {
    ...draft.content, scenarioKey: normalizeInteractionScenarioKey(draft.scenarioKey), stateVersion: SCENARIO_STATE_MERGE_VERSION, authority: "model_estimate_unverified", verification: "business_state_not_verified",
    previousSnapshotId: previous?.id ?? null, revision: Number(previousRevision) + 1, observedAt, summary, currentState: summary,
    openLoops, closedLoops: tasks.filter(task => closedStatuses.has(task.status)), taskUpdates: deltaTasks,
    taskConflicts: [...new Map(taskConflicts.map(item => [JSON.stringify(stable(item)), item])).values()], notes, memories, sourceEventIds,
    sourceRange: { firstObservedAt: [...times].sort((a, b) => Date.parse(a) - Date.parse(b))[0],
      lastObservedAt: [...times].sort((a, b) => Date.parse(b) - Date.parse(a))[0], sourceEventIds, scope: "user_typed_scenario" },
  };
  if (JSON.stringify(content).length > 2_000_000) throw new ScenarioStateError("scenario_state_capacity_exceeded", "Scenario state exceeds storage budget; no history was truncated");
  const previousMemoryIds = previous?.sourceMemoryIds ?? previous?.metadata.sourceMemoryIds ?? [];
  if (!Array.isArray(previousMemoryIds) || previousMemoryIds.some(id => typeof id !== "string")) throw new ScenarioStateError("scenario_state_invalid", "Invalid prior memory references");
  const sourceMemoryIds = unique([...previousMemoryIds as string[], ...draft.sourceMemoryIds]);
  return { content, sourceMemoryIds, metadata: { ...draft.metadata, stateMergeVersion: SCENARIO_STATE_MERGE_VERSION,
    scenarioType: draft.scenarioType, scenarioKey: normalizeInteractionScenarioKey(draft.scenarioKey),
    previousSnapshotId: content.previousSnapshotId, revision: content.revision, batchHash: scenarioStateBatchHash(draft), sourceMemoryIds,
    authority: content.authority, verification: content.verification, timeSemantics: "processing_observation_time_not_source_event_time",
    coverage: previous ? "previous_snapshot_plus_batch" : "observed_batch_only",
    historicalCoverage: !previous ? "no_prior_snapshot" : previous.metadata.stateMergeVersion === SCENARIO_STATE_MERGE_VERSION
      ? previous.metadata.historicalCoverage ?? "observed_lineage_only" : "legacy_snapshot_coverage_unknown",
    sourceRange: content.sourceRange } };
}
