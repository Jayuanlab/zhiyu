import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { BrainAccessGrant, BrainMemory } from "@/lib/brain/types";
import type { Workshop } from "@/lib/db/schema";

const mocks = vi.hoisted(() => ({ legacy: vi.fn(), memory: vi.fn(), grants: vi.fn(), evidence: vi.fn(), event: vi.fn(), interactions: vi.fn(), work: vi.fn() }));
vi.mock("@/lib/workshops/service", async original => ({ ...await original<typeof import("@/lib/workshops/service")>(),
  getWorkshopMemory: mocks.legacy, getWorkshopEvent: mocks.event, getWorkshop: mocks.work }));
vi.mock("@/lib/memory/adapters/postgres/memory-records", async original => ({ ...await original<typeof import("@/lib/memory/adapters/postgres/memory-records")>(),
  getBrainMemoryById: mocks.memory, listBrainAccessGrantsForUser: mocks.grants }));
vi.mock("@/lib/memory/evidence/reader", () => ({ resolveEvidenceRefs: mocks.evidence }));
vi.mock("@/lib/interactions/service", async original => ({ ...await original<typeof import("@/lib/interactions/service")>(),
  getInteractionEventsByIds: mocks.interactions }));

import { readWorkshopMemoryEvidence } from "@/lib/workshops/memory-evidence-reader";
import { createWorkshopToolDefinitions } from "@/lib/workshops/mcp-tools";
import { getBrainMemoryRevisionVersion } from "@/lib/brain/memory-revision-version";

const workId = "11111111-1111-4111-a111-111111111111", memoryId = "22222222-2222-4222-a222-222222222222";
const userId = "33333333-3333-4333-a333-333333333333", observationId = "44444444-4444-4444-a444-444444444444";
const previousId = "55555555-5555-4555-a555-555555555555", foreignWorkId = "66666666-6666-4666-a666-666666666666";
const eventId = "77777777-7777-4777-a777-777777777777", interactionId = "88888888-8888-4888-a888-888888888888";
const ref = `brain-observation:${observationId}`;
const body = "The owner corrected the local decision rule. ".repeat(200) + "EXACT END OF CURRENT MEMORY";
const workshop: Workshop = { id: workId, userId, name: "Research", mission: "Read evidence", status: "active", autonomyLevel: "draft",
  modelConfig: { allowedTools: ["workshopGetMemoryEvidence"] }, boundaryPolicy: {}, createdAt: new Date(), updatedAt: new Date() };
function memory(overrides: Partial<BrainMemory> = {}): BrainMemory {
  return { id: memoryId, userId, ownerType: "work", ownerId: workId, scope: { type: "workshop", workshopId: workId },
    memoryType: "insight", subject: "Experience", content: body, status: "verified", confidence: 25, evidenceRefs: [ref],
    supersedes: [previousId], createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T01:00:00.000Z",
    metadata: { revision: { observationId, previousMemoryId: previousId, authority: "owner_statement",
      assertionEvidenceRefs: [ref], independentlyVerifiesBusinessFact: false } }, ...overrides };
}
function observation(provenance: Record<string, unknown> = { memoryId: previousId, provesOwnerSubmissionOnly: true, independentlyVerifiesBusinessFact: false }) {
  const content = JSON.stringify({ memoryId: previousId, request: { authority: "owner_statement", content: body } });
  return { id: ref, status: "resolved", source: "brain_observation", sourceSemantics: "evidence_source", ownerHints: [],
    title: "owner-correction-command", content, createdAt: "2026-10-16T01:00:00.000Z",
    metadata: { sourceType: "owner_memory_revision", sourceId: "owner-correction-command", trustLevel: "owner_assertion",
      contentHash: createHash("sha256").update(content).digest("hex"), provenance } };
}
function grant(scopeWorkId: string, overrides: Partial<BrainAccessGrant> = {}): BrainAccessGrant {
  return { id: "grant", userId, subjectType: "work", subjectId: workId, scope: { type: "workshop", workshopId: scopeWorkId },
    permissions: ["reference"], ...overrides };
}
const read = (maxEvents?: number) => readWorkshopMemoryEvidence({ workshop, memoryId, maxEvents });
function invoke() {
  return createWorkshopToolDefinitions({ runtime: "pi", workshop, workshopId: workId, runId: eventId })
    .find(tool => tool.name === "workshopGetMemoryEvidence")!.handler;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.legacy.mockResolvedValue(null);
  mocks.memory.mockImplementation(async ({ memoryId: id }) => id === memoryId ? memory() : id === previousId
    ? memory({ id: previousId, status: "superseded", evidenceRefs: [], supersedes: [] }) : null);
  mocks.grants.mockResolvedValue([]);
  mocks.evidence.mockResolvedValue([observation()]);
  mocks.event.mockResolvedValue(null);
  mocks.interactions.mockResolvedValue([]);
  mocks.work.mockResolvedValue(workshop);
});

describe("authorized workshop memory evidence expansion", () => {
  it("returns the full current memory/version and the genuine separately authorized owner correction observation through the actual tool", async () => {
    const result = await invoke()({ memoryId, maxEvents: 10 }, {});
    expect(result).not.toHaveProperty("isError", true);
    expect(result.data).toMatchObject({ status: "read", provider: "workshop_memory_evidence", memoryBackend: "brain",
      memory: { id: memoryId, content: body, revisionVersion: getBrainMemoryRevisionVersion(memory()), supersedes: [previousId],
        revision: { authority: "owner_statement", observationId, independentlyVerifiesBusinessFact: false } },
      resolvedCount: 1, unresolvedCount: 0, evidenceResolution: [{ id: ref, status: "resolved", provider: "brain_observation" }],
      brainEvidence: [{ id: ref, content: observation().content, metadata: { trustLevel: "owner_assertion", provenance: {
        memoryId: previousId, provesOwnerSubmissionOnly: true, independentlyVerifiesBusinessFact: false } } }] });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.memory.content).toBe(body);
    expect(parsed.memory.expectedVersion).toBe(parsed.memory.revisionVersion);
    expect(mocks.memory).toHaveBeenCalledWith({ userId, memoryId: previousId });
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.interactions).not.toHaveBeenCalled();
  });

  it("denies another work's canonical memory before reading any evidence", async () => {
    mocks.memory.mockResolvedValue(memory({ ownerId: foreignWorkId, scope: { type: "workshop", workshopId: foreignWorkId } }));
    const result = await read();
    expect(result).toMatchObject({ status: "unavailable", warnings: ["memory_access_denied"] });
    expect(result).not.toHaveProperty("memory");
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.grants).toHaveBeenCalledWith({ userId });
  });

  it("still honors a current explicit tool denial before reading memory", async () => {
    const handler = invoke();
    mocks.work.mockResolvedValue({ ...workshop, modelConfig: { allowedTools: ["workshopGetMemoryEvidence"], disallowedTools: ["workshopGetMemoryEvidence"] } });
    await expect(handler({ memoryId, maxEvents: 10 }, {})).rejects.toThrow("Tool denied");
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.memory).not.toHaveBeenCalled();
  });

  it.each([
    { permissions: ["read"] },
    { subjectId: foreignWorkId },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
  ] as Partial<BrainAccessGrant>[])("does not widen grant semantics for a work requester: %j", async overrides => {
    mocks.memory.mockResolvedValue(memory({ ownerId: foreignWorkId, scope: { type: "workshop", workshopId: foreignWorkId } }));
    mocks.grants.mockResolvedValue([grant(foreignWorkId, overrides)]);
    expect(await read()).toMatchObject({ status: "unavailable", warnings: ["memory_access_denied"] });
    expect(mocks.evidence).not.toHaveBeenCalled();
  });

  it.each([
    { userId: "another-user" },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
  ])("denies wrong-user or expired canonical memory without granting owner override: %j", async overrides => {
    mocks.memory.mockResolvedValue(memory(overrides));
    expect(await read()).toMatchObject({ status: "unavailable", warnings: ["memory_access_denied"] });
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.grants).not.toHaveBeenCalled();
  });

  it("cannot use a readable memory to disclose a foreign work's raw observation", async () => {
    mocks.memory.mockImplementation(async ({ memoryId: id }) => id === memoryId ? memory()
      : memory({ id: previousId, ownerId: foreignWorkId, scope: { type: "workshop", workshopId: foreignWorkId } }));
    const result = await read();
    expect(result).toMatchObject({ status: "read", memory: { content: body }, brainEvidence: [], resolvedCount: 0, unresolvedCount: 1,
      evidenceResolution: [{ id: ref, status: "unresolved", provider: "brain_observation", warning: "observation_access_denied" }] });
    expect(JSON.stringify(result)).not.toContain("owner-correction-command");
  });

  it("honors a real reference grant for each independently authorized canonical target", async () => {
    mocks.memory.mockImplementation(async ({ memoryId: id }) => memory({ id, ownerId: foreignWorkId, scope: { type: "workshop", workshopId: foreignWorkId } }));
    mocks.grants.mockResolvedValue([grant(foreignWorkId)]);
    expect(await read()).toMatchObject({ status: "read", resolvedCount: 1, brainEvidence: [{ id: ref, status: "resolved" }] });
    expect(mocks.grants).toHaveBeenCalledOnce();
    expect(mocks.evidence.mock.calls[0][0].ownerHintsByRef.get(ref)).toEqual([{ ownerType: "work", ownerId: foreignWorkId }]);
  });

  it("a grant on the readable memory does not grant unrelated observation scope", async () => {
    const thirdWork = interactionId;
    mocks.memory.mockImplementation(async ({ memoryId: id }) => memory({ id, ownerId: id === memoryId ? foreignWorkId : thirdWork,
      scope: { type: "workshop", workshopId: id === memoryId ? foreignWorkId : thirdWork } }));
    mocks.grants.mockResolvedValue([grant(foreignWorkId)]);
    expect(await read()).toMatchObject({ status: "read", memory: { content: body }, brainEvidence: [], unresolvedCount: 1 });
  });

  it.each(["brain-observation:../../secret", "not-a-uuid", "'::uuid;select secret", "brain-memory:22222222-2222-4222-a222-222222222222"])("rejects malformed memory ID without a database read: %s", async invalid => {
    expect(await readWorkshopMemoryEvidence({ workshop, memoryId: invalid })).toMatchObject({ status: "unavailable", warnings: ["invalid_memory_id"] });
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.memory).not.toHaveBeenCalled();
  });

  it("keeps malformed/unknown refs unresolved and sends only exact UUIDs to legacy source queries", async () => {
    const invalid = "brain-observation:not-a-uuid", unsupported = "raw-message:42";
    mocks.memory.mockResolvedValue(memory({ evidenceRefs: [invalid, unsupported, eventId, interactionId] }));
    mocks.event.mockImplementation(async (_work, id) => id === eventId ? { id, workshopId: workId, body: "Exact workshop event" } : null);
    mocks.interactions.mockResolvedValue([{ id: interactionId, userId, messageText: "Exact owner interaction" }, { id: eventId, userId: "foreign", messageText: "secret" }]);
    expect(await read()).toMatchObject({ resolvedCount: 2, unresolvedCount: 2, unresolvedSourceEventIds: [invalid, unsupported],
      workshopEvents: [{ id: eventId }], interactionEvents: [{ id: interactionId }] });
    expect(mocks.event.mock.calls.map(call => call.slice(0, 2))).toEqual([[workId, eventId], [workId, interactionId]]);
    expect(mocks.interactions).toHaveBeenCalledWith({ userId, ids: [eventId, interactionId] });
    expect(mocks.evidence).not.toHaveBeenCalled();
  });

  it("returns complete memory with explicit unresolved evidence on a reader failure and never exposes SQL", async () => {
    mocks.evidence.mockRejectedValue(Error("select * from private_table where secret='bad' invalid uuid"));
    const result = await invoke()({ memoryId, maxEvents: 10 }, {});
    expect(result).not.toHaveProperty("isError", true);
    expect(result.data).toMatchObject({ status: "read", memory: { content: body, revisionVersion: getBrainMemoryRevisionVersion(memory()) },
      resolvedCount: 0, unresolvedCount: 1, warnings: ["brain_evidence_reader_unavailable", "some_memory_evidence_unresolved"] });
    expect(JSON.stringify(result)).not.toContain("private_table");
    expect(JSON.stringify(result)).not.toContain("secret=");
  });

  it("does not disclose an observation whose independent scope is missing or unavailable", async () => {
    mocks.evidence.mockResolvedValue([observation({})]);
    expect(await read()).toMatchObject({ status: "read", brainEvidence: [], evidenceResolution: [{ warning: "observation_scope_unavailable" }] });
    mocks.evidence.mockResolvedValue([observation()]);
    mocks.memory.mockImplementation(async ({ memoryId: id }) => { if (id === previousId) throw Error("private SQL"); return memory(); });
    const failed = await read();
    expect(failed).toMatchObject({ status: "read", memory: { content: body }, brainEvidence: [], unresolvedCount: 1,
      warnings: ["observation_access_reader_unavailable", "some_memory_evidence_unresolved"] });
    expect(JSON.stringify(failed)).not.toContain("private SQL");
  });

  it("retains exact UUID legacy workshop and interaction expansion", async () => {
    mocks.legacy.mockResolvedValue({ id: memoryId, workshopId: workId, content: body, sourceEventIds: [eventId, interactionId] });
    mocks.event.mockImplementation(async (_work, id) => id === eventId ? { id, workshopId: workId } : null);
    mocks.interactions.mockResolvedValue([{ id: interactionId, userId }]);
    expect(await read()).toMatchObject({ memoryBackend: "legacy", memory: { content: body }, resolvedCount: 2, unresolvedCount: 0 });
    expect(mocks.memory).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();
  });

  it("does not silently count references beyond the requested window as resolved", async () => {
    mocks.memory.mockResolvedValue(memory({ evidenceRefs: ["unsupported:first", ref] }));
    expect(await read(1)).toMatchObject({ resolvedCount: 0, unresolvedCount: 1,
      evidenceCoverage: { totalRefs: 2, requested: 1, notChecked: 1 }, warnings: ["some_memory_evidence_unresolved", "memory_evidence_limit_reached"] });
    expect(mocks.evidence).not.toHaveBeenCalled();
  });

  it("fails closed when a required grant lookup is unavailable", async () => {
    mocks.memory.mockResolvedValue(memory({ ownerId: foreignWorkId }));
    mocks.grants.mockRejectedValue(Error("sensitive backend error"));
    const result = await read();
    expect(result).toMatchObject({ status: "unavailable", warnings: ["brain_access_reader_unavailable"] });
    expect(result).not.toHaveProperty("memory");
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
});
