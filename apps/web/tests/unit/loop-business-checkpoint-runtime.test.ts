import { describe, expect, it, vi } from "vitest";
import { readBusinessCheckpointRunApplicability } from "@/lib/loops/business-checkpoint-runtime";
const input = { workshopId: "work", runId: "run", loopId: "loop", loopRunId: "run" };
const snapshot = (applicabilityHash: unknown) => ({ snapshot_json: { schemaVersion: "agent-runtime-run-snapshot.v1",
  extra: { workshopId: "work", workingMemoryPolicy: { applicabilityHash } } } });

describe("business checkpoint run snapshot applicability", () => {
  it("uses only the actual saved run binding, including explicit unbound, without consulting model reports or current Work config", async () => {
    const execute = vi.fn(async () => [snapshot("a".repeat(64))]);
    expect(await readBusinessCheckpointRunApplicability({ execute } as never, input))
      .toEqual({ status: "confirmed", applicabilityHash: "a".repeat(64) });
    expect(execute).toHaveBeenCalledOnce();
    expect(await readBusinessCheckpointRunApplicability({ execute: async () => [snapshot(null)] } as never, input))
      .toEqual({ status: "confirmed", applicabilityHash: null });
  });
  it.each([[], [snapshot(undefined)], [snapshot("model-asserted-project")],
    [snapshot("a".repeat(64)), snapshot("b".repeat(64))], Array.from({ length: 17 }, () => snapshot(null)),
    [{ snapshot_json: { schemaVersion: "agent-runtime-run-snapshot.v1", extra: { workshopId: "other-work", workingMemoryPolicy: { applicabilityHash: null } } } }],
  ])("omits saving when host proof is missing, malformed, foreign or ambiguous", async rows => {
    expect((await readBusinessCheckpointRunApplicability({ execute: async () => rows } as never, input)).status).toBe("unavailable");
  });
  it("reports database failure as unavailable rather than guessing the latest Work binding", async () => {
    expect(await readBusinessCheckpointRunApplicability({ execute: async () => { throw Error("db unavailable"); } } as never, input))
      .toEqual({ status: "unavailable", reason: "applicability_snapshot_unavailable" });
  });
});
