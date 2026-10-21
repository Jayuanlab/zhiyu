import { describe, expect, it } from "vitest";
import { buildBrainContextPack, summarizeBrainContextPackForTrace } from "@/lib/brain/context";
import {
  buildBrainMemoryMetadata,
  buildInteractionScenarioApplicabilityFacets,
  getBrainMemoryScenarioApplicability,
  matchBrainMemoryScenarioApplicability,
  normalizeBrainScenarioKeys,
} from "@/lib/brain/canonical";
import type { BrainMemory, BrainRequester } from "@/lib/brain/types";

const now = new Date("2026-10-20T00:00:00.000Z");
const requester = (id: string): BrainRequester => ({ type: "work", userId: "owner", id });
const grant = (id: string) => ({ id: `grant-${id}`, userId: "owner", subjectType: "work" as const,
  subjectId: id, scope: { type: "global" as const }, permissions: ["reference" as const] });
function memory(overrides: Partial<BrainMemory> = {}): BrainMemory {
  return { id: "memory", userId: "owner", scope: { type: "global" }, ownerType: "chat", ownerId: "owner",
    memoryType: "preference", subject: "Proposal format", content: "Use a detailed proposal for Alpha.",
    status: "active", confidence: 90, evidenceRefs: ["event-alpha"], createdAt: now.toISOString(), updatedAt: now.toISOString(),
    metadata: { facets: { scenarioKeys: ["project:alpha", "person:alice"] } }, ...overrides };
}
function pack(memories: BrainMemory[], scenarioKeys?: string[], workId = "work-a", authorized = true) {
  return buildBrainContextPack({ memories, requester: requester(workId), grants: authorized ? [grant(workId)] : [],
    taskIntent: "Proposal format", now, sourceFilters: scenarioKeys ? { scenarioKeys } : undefined });
}

describe("scenario applicability independent of access scope", () => {
  it("shares one project's memory across separately authorized Works without changing its scope", () => {
    const stored = memory();
    for (const workId of ["work-a", "work-b"]) {
      const result = pack([stored], ["project:alpha"], workId);
      expect(result.items.map(item => item.id)).toEqual(["memory"]);
      expect(result.items[0]?.scenarioApplicability).toMatchObject({ status: "scoped", basis: "typed_scenario_keys" });
    }
    expect(stored.scope).toEqual({ type: "global" });
    expect(stored.ownerId).toBe("owner");
  });

  it("does not leak a project preference through a shared person or an untyped alias", () => {
    expect(pack([memory()], ["project:beta", "person:alice"]).omitted).toContainEqual({ id: "memory", reason: "source_filter:scenario_key" });
    expect(pack([memory()], ["alpha"]).items).toEqual([]);
    expect(pack([memory()], ["person:alpha"]).items).toEqual([]);
  });

  it("requires scenario context for ordinary project facts, even when permission scope is global", () => {
    expect(pack([memory()]).omitted).toEqual([{ id: "memory", reason: "scenario_context_required" }]);
  });

  it("retains restrictions when the scenario is unspecified, with no assertion of global applicability", () => {
    const boundary = memory({ memoryType: "boundary" });
    const result = pack([boundary]);
    expect(result.items[0]?.warnings).toContain("scenario_context_required");
    expect(result.items[0]?.scenarioApplicability?.status).toBe("scoped");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "scenario_context_required", memoryIds: ["memory"] }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ requiresScopeConfirmation: true, requiresCurrentObservation: false }));
    expect(pack([boundary], ["project:beta"]).items).toEqual([]);
  });

  it("preserves a current owner correction as a restriction when no scenario is bound", () => {
    const corrected = memory({ metadata: { facets: { scenarioKeys: ["project:alpha"] }, revision: {
      operation: "correct", authority: "owner_statement", reviewStatus: "applied",
    } } });
    expect(pack([corrected]).items[0]?.warnings).toContain("scenario_context_required");
  });

  it("retains explicitly owner-confirmed global preferences in project and unscoped requests", () => {
    const globalPreference = memory({ metadata: { facets: { scenarioApplicability: "global",
      scenarioApplicabilityAuthority: "owner_confirmed", scenarioApplicabilityEvidenceRefs: ["event-alpha"] } } });
    for (const keys of [undefined, ["project:alpha"], ["project:beta"]]) {
      expect(pack([globalPreference], keys).items[0]?.scenarioApplicability).toEqual({ status: "global", scenarioKeys: [], basis: "owner_confirmed" });
    }
  });

  it("does not recognize self-declared global status or an unrelated confirmation ref", () => {
    for (const facets of [
      { scenarioApplicability: "global" },
      { scenarioApplicability: "global", scenarioApplicabilityAuthority: "owner_confirmed", scenarioApplicabilityEvidenceRefs: ["other-event"] },
    ]) {
      const result = pack([memory({ metadata: { facets } })], ["project:beta"]);
      expect(result.items[0]?.scenarioApplicability).toMatchObject({ status: "unknown", basis: "unconfirmed_global" });
      expect(result.items[0]?.warnings).toContain("scenario_applicability_unknown");
    }
  });

  it("does not broaden an explicit scenario with conflicting global metadata", () => {
    const stored = memory({ metadata: { facets: { scenarioKeys: ["project:alpha"], scenarioApplicability: "global",
      scenarioApplicabilityAuthority: "owner_confirmed", scenarioApplicabilityEvidenceRefs: ["event-alpha"] } } });
    expect(getBrainMemoryScenarioApplicability(stored).status).toBe("scoped");
    expect(pack([stored], ["project:beta"]).items).toEqual([]);
  });

  it("keeps historical approved memories explicitly unknown without mutating or inventing project ownership", () => {
    const stored = memory({ metadata: undefined, status: "verified" });
    const result = pack([stored], ["project:alpha"]);
    expect(result.items[0]?.scenarioApplicability).toEqual({ status: "unknown", scenarioKeys: [], basis: "legacy_unknown" });
    expect(result.items[0]?.warnings).toContain("scenario_applicability_unknown");
    expect(stored.metadata).toBeUndefined();
    expect(stored.scope).toEqual({ type: "global" });
  });

  it("does not turn an own-Work legacy applicability note into a request for a new observation", () => {
    const stored = memory({ ownerType: "work", ownerId: "work-a", scope: { type: "work", workId: "work-a" }, metadata: undefined });
    const result = pack([stored]);
    expect(result.items[0]?.scenarioApplicability?.status).toBe("unknown");
    expect(result.items[0]?.warnings).toContain("scenario_applicability_unknown");
    expect(result.warnings).toEqual([]);
    const globalUnknown = pack([memory({ metadata: undefined })], ["project:alpha"]);
    expect(globalUnknown.warnings).toContainEqual(expect.objectContaining({ code: "scenario_applicability_unknown",
      requiresScopeConfirmation: true, requiresCurrentObservation: false }));
  });

  it("checks permission and candidate status before applicability and never exposes denied content", () => {
    const result = pack([memory({ content: "private project text" })], ["project:alpha"], "ungranted", false);
    expect(result.denied).toEqual([{ id: "memory", reason: "no_matching_grant" }]);
    expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private project text");
    expect(pack([memory({ status: "candidate" })], ["project:alpha"]).omitted).toEqual([{ id: "memory", reason: "candidate_requires_review" }]);
  });

  it("derives typed local applicability from interaction hints, without promoting an unhinted preference to global", () => {
    expect(buildInteractionScenarioApplicabilityFacets([{ type: "project", key: " Alpha " }, { key: "alpha" }]))
      .toEqual({ scenarioApplicability: "scoped", scenarioKeys: ["project:alpha"] });
    expect(buildInteractionScenarioApplicabilityFacets(undefined)).toEqual({ scenarioApplicability: "unknown", scenarioKeys: [] });
    expect(normalizeBrainScenarioKeys(["alpha", "invalid:alpha", "PROJECT: Alpha ", "person:alpha", "project:alpha"]))
      .toEqual(["project:alpha", "person:alpha"]);
  });

  it("reads historical scenario hints and exposes normalized applicability without changing canonical identity", () => {
    const stored = memory({ metadata: { scenarioHints: [{ type: "project", key: "alpha" }] } });
    expect(matchBrainMemoryScenarioApplicability(stored, { scenarioKeys: ["project:alpha"] }).matched).toBe(true);
    const metadata = buildBrainMemoryMetadata(stored);
    expect(metadata.facets).toMatchObject({ scenarioApplicability: "scoped", scenarioKeys: ["project:alpha"], scopeType: "global" });
    expect(metadata.canonicalGroupId).toMatch(/^evidence:preference:/);
  });

  it("lets the owner discover project records while marking every result as discovery only", () => {
    const result = buildBrainContextPack({ memories: [memory()], requester: { type: "chat", userId: "owner" },
      accessMode: "owner_override", applicabilityMode: "discovery", taskIntent: "Find stored proposals", now,
      sourceFilters: { scenarioKeys: ["project:beta"] } });
    expect(result.applicabilityMode).toBe("discovery");
    expect(result.items[0]).toMatchObject({ id: "memory", applicabilityUse: "discovery_only",
      scenarioApplicability: { status: "scoped", scenarioKeys: ["project:alpha", "person:alice"] } });
    expect(result.items[0]?.warnings).toContain("discovery_only");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "discovery_only", requiresScopeConfirmation: true }));
    expect(summarizeBrainContextPackForTrace(result)).toMatchObject({ applicabilityMode: "discovery",
      selected: [expect.objectContaining({ applicabilityUse: "discovery_only" })] });
  });

  it("does not let a Work turn owner discovery into scenario bypass even with a valid read grant", () => {
    const result = buildBrainContextPack({ memories: [memory()], requester: requester("work-a"), grants: [grant("work-a")],
      accessMode: "owner_override", applicabilityMode: "discovery", taskIntent: "Find proposals", now,
      sourceFilters: { scenarioKeys: ["project:beta"] } });
    expect(result.applicabilityMode).toBe("task");
    expect(result.items).toEqual([]);
    expect(result.omitted).toContainEqual({ id: "memory", reason: "source_filter:scenario_key" });
    const noGrant = buildBrainContextPack({ memories: [memory()], requester: requester("work-a"),
      applicabilityMode: "discovery", taskIntent: "Find proposals", now, sourceFilters: { scenarioKeys: ["project:alpha"] } });
    expect(noGrant.denied).toEqual([{ id: "memory", reason: "no_matching_grant" }]);
  });

  it("keeps user isolation and strict chat matching in owner discovery requests", () => {
    const denied = buildBrainContextPack({ memories: [memory()], requester: { type: "chat", userId: "other-owner" },
      accessMode: "owner_override", applicabilityMode: "discovery", taskIntent: "Find proposals", now });
    expect(denied.items).toEqual([]);
    expect(denied.denied).toEqual([{ id: "memory", reason: "wrong_user" }]);
    const strict = buildBrainContextPack({ memories: [memory()], requester: { type: "chat", userId: "owner" },
      accessMode: "strict", applicabilityMode: "discovery", taskIntent: "Find proposals", now,
      grants: [{ id: "chat-grant", userId: "owner", subjectType: "chat", scope: { type: "global" }, permissions: ["read"] }] });
    expect(strict.applicabilityMode).toBe("task");
    expect(strict.items).toEqual([]);
    expect(strict.omitted).toContainEqual({ id: "memory", reason: "scenario_context_required" });
  });
});
