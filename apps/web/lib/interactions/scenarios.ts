// Compatibility entry: implementations live in the matching Memory capabilities.
export { buildInteractionScenarioSnapshots } from "@/lib/memory/understanding/scenarios";
export type { InteractionScenarioHint, InteractionScenarioSourceItem, InteractionScenarioTaskState,
  InteractionScenarioSnapshotDraft } from "@/lib/memory/understanding/scenarios";
import type { InteractionScenarioSnapshotDraft } from "@/lib/memory/understanding/scenarios";
import { persistInteractionScenarioState } from "./scenario-state-store";

/** Preserve the existing trusted host gate for standalone legacy callers. */
export async function createInteractionScenarioSnapshots(input: { userId: string; drafts: InteractionScenarioSnapshotDraft[] }) {
  const snapshots = [];
  for (const draft of input.drafts) snapshots.push(await persistInteractionScenarioState({ userId: input.userId, draft }));
  return snapshots;
}
