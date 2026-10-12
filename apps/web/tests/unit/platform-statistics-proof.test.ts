import { describe, expect, it } from "vitest";
import { canonicalPlatformStatisticSource, createFrozenPlatformStatisticsProof, createLivePlatformStatisticsProof, validatePlatformStatisticsProof } from "@/lib/ai/platform-statistics-proof";

const input = { ownerId: "owner-a", source: "interactionProcessingJobs.status", total: 7,
  groups: [{ value: "completed", count: 5 }, { value: "running", count: 2 }], observedAt: "2026-10-04T02:00:00.000Z" };
const query = 'SELECT s."status" AS value, count(*)::int AS count FROM "interaction_processing_jobs" s WHERE s.user_id = $1 GROUP BY s."status" ORDER BY s."status" NULLS FIRST';
const frozen = { ...input, query, parameters: [input.ownerId], captureHash: "a".repeat(64) };

describe("registered statistics scope proofs", () => {
  it("accepts fixed live queries, aliases and exact captured query receipts", () => {
    expect(canonicalPlatformStatisticSource("modelConfiguration.enabled")).toBe("user_llm_api_settings.enabled");
    const live = createLivePlatformStatisticsProof(input)!;
    const capture = createFrozenPlatformStatisticsProof(frozen)!;
    expect(validatePlatformStatisticsProof(live, input)).toMatchObject({ valid: true });
    expect(validatePlatformStatisticsProof(capture, { ...input, source: "interaction_processing_jobs.status" })).toMatchObject({ valid: true });
    expect(capture.observation.kind).toBe("snapshot");
  });
  it("rejects narrow queries even when they contain an owner predicate and GROUP BY", () => {
    for (const changed of [query + " LIMIT 5", query.replace("GROUP BY", "AND s.status = 'running' GROUP BY"),
      query.replace("s.user_id = $1", "s.user_id = $1 OR 1=1"), query.replace("s.user_id = $1", "s.user_id != $1")]) {
      expect(createFrozenPlatformStatisticsProof({ ...frozen, query: changed })).toBeUndefined();
    }
  });
  it("requires exactly the matching owner parameter and a real capture hash", () => {
    for (const changed of [{ parameters: ["owner-b"] }, { parameters: [input.ownerId, 5] },
      { parameters: [] }, { captureHash: "unknown" }]) expect(createFrozenPlatformStatisticsProof({ ...frozen, ...changed })).toBeUndefined();
  });
  it("does not accept the old completeness boolean as proof", () => {
    expect(validatePlatformStatisticsProof({ fullOwnerGroupQuery: true }, input).valid).toBe(false);
  });
  it("binds counts, owner, source and delivery coverage", () => {
    const proof = createLivePlatformStatisticsProof(input)!;
    expect(validatePlatformStatisticsProof(proof, { ...input, ownerId: "owner-b" }).valid).toBe(false);
    expect(validatePlatformStatisticsProof(proof, { ...input, source: "loops.status" }).valid).toBe(false);
    expect(validatePlatformStatisticsProof(proof, { ...input, groups: [{ value: "completed", count: 7 }] }).reason).toBe("metric_result_mismatch");
    expect(validatePlatformStatisticsProof({ ...proof, deliveryCoverage: "partial" }, input).valid).toBe(false);
    expect(validatePlatformStatisticsProof({ ...proof, observation: { kind: "live", observedAt: "unknown" } }, input).valid).toBe(false);
  });
  it("requires unique typed groups, safe nonnegative counts and a matching total", () => {
    for (const changed of [{ total: 8 }, { total: "7" }, { total: -1 },
      { groups: [{ value: "completed", count: 7 }, { value: "completed", count: 0 }] },
      { groups: [{ value: null, count: Number.MAX_SAFE_INTEGER }, { value: false, count: 1 }], total: Number.MAX_SAFE_INTEGER + 1 },
      { groups: [{ value: {}, count: 7 }] }, { groups: [{ count: 7 }] }]) {
      expect(createLivePlatformStatisticsProof({ ...input, ...changed })).toBeUndefined();
    }
  });
  it("preserves unknown labels, NULL and type differences instead of inventing business classes", () => {
    const typed = { ...input, total: 3, groups: [{ value: null, count: 1 }, { value: false, count: 1 }, { value: "false", count: 1 }] };
    expect(validatePlatformStatisticsProof(createLivePlatformStatisticsProof(typed), typed).valid).toBe(true);
  });
  it("supports complete empty groups and explicit count-only captures without inferring missing groups", () => {
    const empty = { ...input, total: 0, groups: [] };
    expect(validatePlatformStatisticsProof(createLivePlatformStatisticsProof(empty), empty).valid).toBe(true);
    const count = { ...input, source: "workshop_heartbeats.count", total: 0, groups: undefined };
    const capture = createFrozenPlatformStatisticsProof({ ...count, query: 'SELECT count(*)::int AS total FROM "workshop_heartbeats" s WHERE s.workshop_id IN (SELECT id FROM workshops WHERE user_id = $1)', parameters: [input.ownerId], captureHash: "a".repeat(64) });
    expect(validatePlatformStatisticsProof(capture, count).valid).toBe(true);
    expect(createLivePlatformStatisticsProof({ ...input, groups: undefined })).toBeUndefined();
  });
});
