import type { DrizzleDB } from "@/lib/db/types";
import { isMemoryApplicabilityHash } from "../kernel/runtime-applicability";
import { readBusinessCheckpointRuntimeRows } from "../adapters/postgres/runtime-snapshots";
import { isContinuityRuntimeBinding, type ContinuityRuntimeBinding } from "./runtime-binding";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export type CheckpointRunSnapshotInput = { workshopId: string; runId: string; loopId: string; loopRunId: string; requireRuntimeBinding?: boolean };
/** Only the actual saved run snapshot can bind persisted progress. Configuration
 * edited after the run and model-authored checkpoint fields are not substitutes. */
export async function readBusinessCheckpointRunApplicability(store: Pick<DrizzleDB, "execute">, input: CheckpointRunSnapshotInput)
  : Promise<{ status: "confirmed"; applicabilityHash: string | null; runtimeBinding?: ContinuityRuntimeBinding }
    | { status: "unavailable"; reason: string }> {
  try {
    const rows = await readBusinessCheckpointRuntimeRows(store, input);
    if (!rows.length || rows.length > 16) return { status: "unavailable", reason: "applicability_snapshot_unavailable" };
    const hashes: Array<string | null> = [], bindings: ContinuityRuntimeBinding[] = [];
    for (const row of rows) {
      const saved = object(row.snapshot_json), extra = object(saved.extra), policy = object(extra.workingMemoryPolicy);
      if (saved.schemaVersion !== "agent-runtime-run-snapshot.v1" || extra.workshopId !== input.workshopId
        || !Object.hasOwn(policy, "applicabilityHash") || !isMemoryApplicabilityHash(policy.applicabilityHash)) {
        return { status: "unavailable", reason: "applicability_snapshot_unavailable" };
      }
      hashes.push(policy.applicabilityHash);
      if (extra.continuityBinding !== undefined) {
        const binding = extra.continuityBinding;
        if (!isContinuityRuntimeBinding(binding) || binding.workshopId !== input.workshopId
          || binding.runId !== input.loopRunId || binding.loopId !== input.loopId) {
          return { status: "unavailable", reason: "continuity_binding_unavailable" };
        }
        bindings.push(binding);
      }
    }
    if (new Set(hashes).size !== 1) return { status: "unavailable", reason: "applicability_snapshot_conflict" };
    if (input.requireRuntimeBinding && bindings.length !== rows.length) return { status: "unavailable", reason: "continuity_binding_unavailable" };
    if (bindings.length && (bindings.length !== rows.length || new Set(bindings.map(value => JSON.stringify(value))).size !== 1)) {
      return { status: "unavailable", reason: "continuity_binding_conflict" };
    }
    return { status: "confirmed", applicabilityHash: hashes[0], ...(bindings[0] ? { runtimeBinding: bindings[0] } : {}) };
  } catch { return { status: "unavailable", reason: "applicability_snapshot_unavailable" }; }
}
