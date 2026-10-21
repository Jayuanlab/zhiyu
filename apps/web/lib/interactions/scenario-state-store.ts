import { withBrainRecordWrite } from "@/lib/memory/revision/transaction";
import { persistScenarioStateInTransaction } from "@/lib/memory/understanding/scenario-persistence";
import type { InteractionScenarioSnapshotDraft } from "@/lib/memory/understanding/scenarios";

// The old host retains its existing business dependency/fencing gate. Memory's
// implementation only accepts an already authorized transaction; no reverse import.
export async function persistInteractionScenarioState(input: { userId: string; draft: InteractionScenarioSnapshotDraft }) {
  return withBrainRecordWrite(input.userId, "snapshot", store => persistScenarioStateInTransaction(store, input));
}
export { persistScenarioStateInTransaction as persistInteractionScenarioStateInTransaction } from "@/lib/memory/understanding/scenario-persistence";
