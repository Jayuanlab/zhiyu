import { describe, expect, it } from "vitest";
import { checkEvidenceTime, inferEvidenceTimePolicy, recordObservation, type EvidenceTimePolicy } from "@/lib/brain/evidence-time";
const current: EvidenceTimePolicy = { mode: "current", now: "2026-09-23T02:00:00Z", maxAgeMs: 300000 };
describe("trusted evidence time", () => {
  it("compares actual instants including timezones, age and future observations", () => {
    expect(checkEvidenceTime("a", { kind: "live", observedAt: "2026-09-23T10:00:00+08:00" }, current).state).toBe("eligible");
    expect(checkEvidenceTime("a", { kind: "live", observedAt: "2026-09-23T01:54:59Z" }, current).state).toBe("stale");
    expect(checkEvidenceTime("a", { kind: "live", observedAt: "2026-09-23T02:00:01Z" }, current).state).toBe("future");
  });
  it("rejects invalid dates, missing timezone and summary updates as current observations", () => {
    for (const observedAt of ["2026-02-30T02:00:00Z", "2026-09-23T02:00:00", undefined]) {
      expect(checkEvidenceTime("a", { kind: "live", observedAt }, current).state).toBe("unknown");
    }
    expect(checkEvidenceTime("a", { kind: "memory", observedAt: current.now }, current).state).toBe("unknown");
    expect(checkEvidenceTime("a", recordObservation("brainStateSnapshots", { createdAt: current.now }, current.now), current).state).toBe("unknown");
    expect(checkEvidenceTime("a", recordObservation("brainMemories", { updatedAt: current.now }, current.now), current).state).toBe("unknown");
    expect(checkEvidenceTime("a", recordObservation("brainObservations", { observedAt: current.now }, current.now), current).state).toBe("unknown");
  });
  it("requires historical validity, never substitutes a current read or creation time", () => {
    const policy: EvidenceTimePolicy = { mode: "as_of", at: "2026-09-22T12:00:00Z" };
    expect(checkEvidenceTime("a", { kind: "live", observedAt: current.now }, policy).state).toBe("unknown");
    const interval = { kind: "snapshot" as const, validFrom: "2026-09-22T00:00:00Z", validTo: "2026-09-23T00:00:00Z" };
    expect(checkEvidenceTime("a", interval, policy).state).toBe("eligible");
    expect(checkEvidenceTime("a", interval, { mode: "as_of", at: interval.validTo }).state).toBe("wrong_time");
    expect(inferEvidenceTimePolicy("当时的状态是什么？").mode).toBe("unresolved");
  });
});
