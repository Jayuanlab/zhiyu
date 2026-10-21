import { beforeEach, describe, expect, it, vi } from "vitest";
import { groupResolvedEvidenceRoots, type ResolvedEvidenceIdentity } from "@/lib/brain/evidence-lineage";
const mocks = vi.hoisted(() => ({ rows: new Map<unknown, unknown[]>(), select: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: (...args: unknown[]) => { mocks.select(...args); return {
  from: (table: unknown) => ({ where: async () => mocks.rows.get(table) ?? [] }),
}; } } }));
import { brainObservations, interactionEvents, rawMessages } from "@/lib/db/schema";
import { resolveBrainEvidenceRefs } from "@/lib/brain/evidence-reader";
const item = (id: string, identity: ResolvedEvidenceIdentity) => ({ id, status: "resolved" as const, source: identity.source, resolvedIdentity: identity });
const observationId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";

describe("resolved evidence roots", () => {
  beforeEach(() => { mocks.rows.clear(); mocks.select.mockClear(); });
  it("groups an observation with its explicit, already resolved source event", () => {
    const result = groupResolvedEvidenceRoots([item("observation", { source: "brain_observation", sourceId: observationId, sourceEventId: eventId }),
      item(eventId, { source: "interaction_event", sourceId: eventId })]);
    expect(result).toMatchObject({ resolvedRootGroups: 1, overlappingResolvedRefs: 1, unresolvedSourceLinks: 0 });
    expect(result.groups[0].refs).toEqual([eventId, "observation"].sort());
  });
  it("does not resolve or infer a missing target and never matches equal text", () => {
    const result = groupResolvedEvidenceRoots([item("observation", { source: "brain_observation", sourceId: observationId, sourceEventId: eventId }),
      item("other", { source: "brain_observation", sourceId: "other" }), { id: eventId, status: "unresolved", source: "unknown" }]);
    expect(result).toMatchObject({ resolvedRootGroups: 2, overlappingResolvedRefs: 0, unresolvedSourceLinks: 1 });
  });
  it("leaves an ambiguous UUID used by two source types unmerged", () => {
    const result = groupResolvedEvidenceRoots([item("observation", { source: "brain_observation", sourceId: observationId, sourceEventId: eventId }),
      item("interaction", { source: "interaction_event", sourceId: eventId }), item("workshop", { source: "workshop_event", sourceId: eventId })]);
    expect(result).toMatchObject({ resolvedRootGroups: 3, unresolvedSourceLinks: 1 });
  });
  it("groups raw aliases by the actual reader row, without another database query", async () => {
    mocks.rows.set(rawMessages, [{ id: 42, messageId: "message-42", content: "same source", timestamp: Date.now() }]);
    const evidence = await resolveBrainEvidenceRefs({ userId: "fixture-owner", evidenceRefs: ["raw-message:42", "legacy-raw-message:message-42", "raw_message:42"] });
    expect(evidence).toHaveLength(3); expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(groupResolvedEvidenceRoots(evidence)).toMatchObject({ resolvedRootGroups: 1, overlappingResolvedRefs: 2 });
  });
  it("leaves a numeric alias unresolved when it matches two different rows", async () => {
    mocks.rows.set(rawMessages, [{ id: 42, messageId: "message-42", content: "first body" },
      { id: 43, messageId: "42", content: "second body" }]);
    const evidence = await resolveBrainEvidenceRefs({ userId: "fixture-owner", evidenceRefs: ["raw-message:42", "raw-message:message-42"] });
    expect(evidence[0]).toMatchObject({ status: "unresolved", content: null, metadata: { reason: "ambiguous_reference" } });
    expect(evidence[0].resolvedIdentity).toBeUndefined();
    expect(evidence[1]).toMatchObject({ status: "resolved", content: "first body" });
    expect(groupResolvedEvidenceRoots(evidence)).toMatchObject({ resolvedRootGroups: 1, overlappingResolvedRefs: 0 });
  });
  it("keeps a ref resolved when both lookup fields match the same row", async () => {
    mocks.rows.set(rawMessages, [{ id: 42, messageId: "42", content: "one body" }]);
    const evidence = await resolveBrainEvidenceRefs({ userId: "fixture-owner", evidenceRefs: ["raw-message:42"] });
    expect(evidence[0]).toMatchObject({ status: "resolved", content: "one body", resolvedIdentity: { sourceId: "42" } });
  });
  it("uses only the observation row association and this batch's authorized event results", async () => {
    mocks.rows.set(brainObservations, [{ id: observationId, sourceEventId: eventId, sourceId: "source", sourceType: "interaction_event",
      content: "derived representation", observedAt: new Date(), metadata: {} }]);
    mocks.rows.set(interactionEvents, [{ id: eventId, contentPreview: "raw observation", messageTime: new Date() }]);
    const evidence = await resolveBrainEvidenceRefs({ userId: "fixture-owner", evidenceRefs: [`brain-observation:${observationId}`, eventId],
      ownerHintsByRef: new Map([[eventId, [{ ownerType: "chat", ownerId: "fixture-owner" }]]]) });
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(groupResolvedEvidenceRoots(evidence)).toMatchObject({ resolvedRootGroups: 1, overlappingResolvedRefs: 1 });
    mocks.rows.get(brainObservations)![0] = { id: observationId, sourceId: eventId, sourceType: "interaction_event", content: "raw observation", metadata: { sourceEventId: eventId } };
    const unlinked = await resolveBrainEvidenceRefs({ userId: "fixture-owner", evidenceRefs: [`brain-observation:${observationId}`, eventId],
      ownerHintsByRef: new Map([[eventId, [{ ownerType: "chat", ownerId: "fixture-owner" }]]]) });
    expect(groupResolvedEvidenceRoots(unlinked)).toMatchObject({ resolvedRootGroups: 2, overlappingResolvedRefs: 0 });
  });
});
