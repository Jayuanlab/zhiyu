import { withMemoryRecordWrite } from "../revision/transaction";
import { BrainMemoryUpdateError } from "../kernel/reference-errors";
import { catalogBrainStateSnapshots, insertStateSnapshotInTransaction, listBrainStateSnapshots } from "../adapters/postgres/state-snapshots";
import type { StateSnapshotRecord, SnapshotQuery } from "../records/state-snapshots";
import type { brainStateSnapshotToInsertRow } from "../records/state-snapshots";

export type StateSnapshotInput = Parameters<typeof brainStateSnapshotToInsertRow>[0];
/** Generic history cannot manufacture records governed by typed domain commands.
 * Error constructor identity is shared with the former Brain facade. */
export function assertGenericSnapshotType(snapshotType: string): void {
  if (snapshotType === "memory_auto_update_policy") throw new BrainMemoryUpdateError("reserved_policy_snapshot", 400, "Use the versioned automatic memory policy command");
  if (["memory_dependency_registry", "memory_dependency_change"].includes(snapshotType)) {
    throw new BrainMemoryUpdateError("reserved_dependency_snapshot", 400, "Use the versioned memory dependency command");
  }
  if (snapshotType === "memory_correction_draft") throw new BrainMemoryUpdateError("reserved_correction_snapshot", 400, "Use the owner correction draft command");
  if (snapshotType === "wechat_scenario_state") throw new BrainMemoryUpdateError("reserved_scenario_snapshot", 400, "Scenario state requires the authorized Interaction projection transaction");
}
export async function insertBrainStateSnapshot(input: StateSnapshotInput): Promise<StateSnapshotRecord> {
  assertGenericSnapshotType(input.snapshotType);
  return withMemoryRecordWrite(input.userId, "snapshot", async store => {
    const result = await insertStateSnapshotInTransaction(store, input);
    return { id: result.id, result };
  });
}
export async function createBrainStateSnapshot(input: StateSnapshotInput): Promise<StateSnapshotRecord> {
  return insertBrainStateSnapshot(input);
}
export async function listBrainSnapshots(input: SnapshotQuery) { return listBrainStateSnapshots(input); }
export async function catalogBrainSnapshots(input: SnapshotQuery) { return catalogBrainStateSnapshots(input); }
export { createBrainStateSnapshot as createStateSnapshot, listBrainSnapshots as listStateSnapshots, catalogBrainSnapshots as catalogStateSnapshots };
