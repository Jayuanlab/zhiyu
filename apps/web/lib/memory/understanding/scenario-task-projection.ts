import type { InteractionTask } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { deserializeJson } from "@/lib/db/serialization";
import { buildInteractionScenarioSnapshots } from "./scenarios";
import { persistScenarioStateInTransaction } from "./scenario-persistence";

/** The task remains authoritative. Its L2 estimate commits or rolls back with it. */
export async function projectInteractionTaskScenariosInTransaction(store: DrizzleDB, task: InteractionTask & { revision: number }, observedAt: Date) {
  if (!Number.isSafeInteger(task.revision) || task.revision < 0) throw new Error("A host task revision is required");
  const sources = deserializeJson(task.sourceEventIds as any);
  const metadata = deserializeJson(task.metadata as any);
  if (!Array.isArray(sources) || sources.some(value => typeof value !== "string")) throw new Error("Invalid interaction task source references");
  const drafts = buildInteractionScenarioSnapshots({ observedAt, processingMode: "task_state_projection", items: [{
    id: task.id, kind: "task", title: task.title, content: task.description ?? task.title, status: task.status,
    sourceEventIds: sources, metadata,
  }] });
  for (const draft of drafts.sort((a, b) => `${a.scenarioType}:${a.scenarioKey}`.localeCompare(`${b.scenarioType}:${b.scenarioKey}`))) {
    const stateObservedAt = task.updatedAt instanceof Date ? task.updatedAt.toISOString() : String(task.updatedAt);
    const verificationStatus = metadata?.taskState && typeof metadata.taskState === "object"
      ? (metadata.taskState as Record<string, unknown>).verificationStatus : undefined;
    draft.content.taskUpdates = draft.content.taskUpdates?.map(item => ({ ...item, stateAuthority: "business_task_record", stateObservedAt,
      stateRevision: task.revision, ...(typeof verificationStatus === "string" ? { verificationStatus } : {}) }));
    draft.metadata = { ...draft.metadata, projectionOrigin: "interaction_task_state_transition",
      taskAuthorityRef: { entityType: "interaction_task", id: task.id, observedAt: observedAt.toISOString(),
        revision: task.revision, status: task.status, updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : String(task.updatedAt) } };
    await persistScenarioStateInTransaction(store, { userId: task.userId, draft });
  }
  return { status: drafts.length ? "projected" as const : "not_applicable" as const, scenarioCount: drafts.length };
}
