import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainMemory } from "@/lib/brain/types";
import type { DrizzleDB } from "@/lib/db/types";

const mocks = vi.hoisted(() => ({transaction: vi.fn(), getMemory: vi.fn()}));
vi.mock("@/lib/memory/revision/transaction", () => ({withBrainMemoryTransaction: mocks.transaction}));
vi.mock("@/lib/memory/adapters/postgres/memory-records", () => ({ getBrainMemoryById: mocks.getMemory }));
vi.mock("@/lib/memory/records/observations", () => ({ observationToInsertRow: (input: unknown) => input }));
vi.mock("@/lib/memory/records/memory-record", () => ({
  brainMemoryFromRow: (row: Record<string, unknown>) => ({...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt}),
  brainMemoryToInsertRow: (memory: unknown) => memory,
  brainMemoryReviewToInsertRow: (input: unknown) => input,
  brainAccessGrantFromRow: (input: unknown) => input,
}));

import { brainMemories, brainMemoryReviews, brainStateSnapshots } from "@/lib/db/schema";
import {
  getBrainMemoryForRevision, getBrainMemoryRevisionVersion, parseBrainMemoryRevisionRequest, reviseBrainMemory,
} from "@/lib/brain/memory-revision";
import { reviewBrainMemoryInTransaction, reviewBrainMemoryTransaction } from "@/lib/brain/memory-review";

const userId = "00000000-0000-4000-a000-000000000001";
const memoryId = "00000000-0000-4000-a000-000000000002";
const now = new Date("2026-10-02T08:00:00.000Z");
function fixture(overrides: Partial<BrainMemory> = {}): BrainMemory {
  return {id: memoryId, userId, scope: {type: "work", workId: "work-1"}, ownerType: "work", ownerId: "work-1",
    memoryType: "preference", subject: "Language", content: "Use English", status: "verified", confidence: 80,
    evidenceRefs: ["source-before"], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    metadata: {observationTime: "2026-08-01T00:00:00.000Z", canonicalGroupId: "language-current"}, ...overrides};
}
function body(memory: BrainMemory, overrides: Record<string, unknown> = {}) {
  return {commandId: "owner-command-1", expectedVersion: getBrainMemoryRevisionVersion(memory), operation: "correct",
    authority: "owner_statement", content: "Use Chinese", reason: "Owner corrected the preference", evidenceRefs: [], ...overrides};
}
function storeFixture(memory: BrainMemory) {
  const state = {memory: {...memory} as Record<string, unknown>, replacements: [] as Record<string, unknown>[],
    reviews: [] as Record<string, unknown>[], observations: [] as Record<string, unknown>[], snapshots: [] as Record<string, unknown>[], writes: [] as boolean[], failSnapshots: false};
  const store = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => ({from: (table: unknown) => {
      const rows = table === brainMemoryReviews ? state.reviews : table === brainMemories ? [state.memory] : [];
      const query = {where: () => query, for: async () => rows,
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject)};
      return query;
    }})),
    insert: vi.fn((table: unknown) => ({values: (row: Record<string, unknown>) => {
      let written = false;
      const execute = async () => {
        if (table === brainStateSnapshots && state.failSnapshots) throw new Error("dependency change storage unavailable");
        const stored = table === brainMemoryReviews ? { id: "00000000-0000-4000-a000-000000000009", ...row } : row;
        if (!written) (table === brainMemories ? state.replacements : table === brainMemoryReviews ? state.reviews : table === brainStateSnapshots ? state.snapshots : state.observations).push(stored);
        written = true; return [stored];
      };
      return {returning: execute,
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => execute().then(resolve, reject)};
    }})),
    update: vi.fn(() => ({set: (patch: Record<string, unknown>) => ({where: () => ({returning: async () => {
      state.memory = {...state.memory, ...patch}; return [state.memory];
    }})})})),
  };
  mocks.transaction.mockImplementation(async (_user: string, write: (db: unknown) => Promise<{result: unknown; written?: boolean}>) => {
    const before = structuredClone({ memory: state.memory, replacements: state.replacements, reviews: state.reviews,
      observations: state.observations, snapshots: state.snapshots });
    try {
      const outcome = await write(store); state.writes.push(outcome.written !== false); return outcome.result;
    } catch (error) {
      Object.assign(state, before); throw error;
    }
  });
  return Object.assign(state, {store});
}
const owner = {type: "chat" as const, userId, id: "owner"};

beforeEach(() => vi.clearAllMocks());

describe("memory revision versions and validation", () => {
  it("hashes state and metadata deterministically and ignores the presentation token", () => {
    const memory = fixture({metadata: {b: 2, a: {d: 4, c: 3}}});
    expect(getBrainMemoryRevisionVersion(memory)).toBe(getBrainMemoryRevisionVersion({...memory, metadata: {a: {c: 3, d: 4}, b: 2}}));
    expect(getBrainMemoryRevisionVersion({...memory, revisionVersion: "presentation"} as BrainMemory)).toBe(getBrainMemoryRevisionVersion(memory));
    for (const patch of [{content: "New"}, {status: "weakened" as const}, {evidenceRefs: ["new"]}, {metadata: {a: 1}}]) {
      expect(getBrainMemoryRevisionVersion({...memory, ...patch})).not.toBe(getBrainMemoryRevisionVersion(memory));
    }
  });
  it("rejects identity/status overrides and bounded invalid payloads", () => {
    for (const patch of [{ownerId: "other"}, {scope: {type: "global"}}, {status: "verified"}, {reason: " "},
      {content: "x".repeat(64_001)}, {evidenceRefs: Array(102).fill("source")}, {sourceObservedAt: "2026-10-02"}]) {
      expect(() => parseBrainMemoryRevisionRequest(body(fixture(), patch))).toThrow();
    }
    expect(() => parseBrainMemoryRevisionRequest(body(fixture(), {operation: "deactivate"}))).toThrow("does not accept");
    const request = body(fixture()); delete (request as Record<string, unknown>).evidenceRefs;
    expect(parseBrainMemoryRevisionRequest(request).evidenceRefs).toEqual([]);
  });
  it("reads the live user-scoped memory version", async () => {
    mocks.getMemory.mockResolvedValue(fixture());
    const result = await getBrainMemoryForRevision({userId, memoryId});
    expect(mocks.getMemory).toHaveBeenCalledWith({userId, memoryId});
    expect(result.expectedVersion).toBe(result.memory.revisionVersion);
  });
  it("returns owned history and exposes a warning instead of reading across owners", async () => {
    const previousId = "00000000-0000-4000-a000-000000000003";
    const forbiddenId = "00000000-0000-4000-a000-000000000004";
    const current = fixture({supersedes: [previousId]});
    const ancestor = fixture({id: previousId, content: "Earlier content", status: "superseded", supersedes: [forbiddenId],
      metadata: {revisionRetired: {reason: "Explicit correction"}}});
    mocks.getMemory.mockImplementation(async ({memoryId: requestedId}: {memoryId: string}) =>
      requestedId === memoryId ? current : requestedId === previousId ? ancestor : fixture({id: forbiddenId, ownerId: "foreign-work", content: "private"}));
    const result = await getBrainMemoryForRevision({userId, memoryId});
    expect(result.history).toHaveLength(1); expect(result.history[0]).toMatchObject({id: previousId, reason: "Explicit correction"});
    expect(result.historyWarning?.code).toBe("history_identity_mismatch");
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("keeps history bounded and reports a read failure", async () => {
    const current = fixture({supersedes: ["unavailable"]});
    mocks.getMemory.mockImplementation(async ({memoryId: requestedId}: {memoryId: string}) => {
      if (requestedId === memoryId) return current; throw new Error("offline");
    });
    const result = await getBrainMemoryForRevision({userId, memoryId});
    expect(result.history).toEqual([]); expect(result.historyWarning?.code).toBe("history_unavailable");
    const many = fixture({supersedes: Array.from({length: 10}, (_, i) => `history-${i}`)});
    mocks.getMemory.mockImplementation(async ({memoryId: requestedId}: {memoryId: string}) =>
      requestedId === memoryId ? many : fixture({id: requestedId, status: "superseded"}));
    const bounded = await getBrainMemoryForRevision({userId, memoryId});
    expect(bounded.history).toHaveLength(8); expect(bounded.historyTruncated).toBe(true); expect(bounded.historyLimit).toBe(8);
  });
});

describe("owner memory revision transaction", () => {
  it("creates a separate equal-rank replacement and retires the original without rewriting content", async () => {
    const original = fixture({status: "active"}); const state = storeFixture(original);
    const result = await reviseBrainMemory({requester: owner, memoryId, request: body(original), now});
    expect(result.oldMemory.content).toBe(original.content);
    expect(result.oldMemory.status).toBe("superseded");
    expect(result.newMemory?.content).toBe("Use Chinese");
    expect(result.newMemory?.status).toBe("active");
    expect(result.newMemory?.id).not.toBe(memoryId);
    expect(result.newMemory?.scope).toEqual(original.scope);
    expect(result.newMemory?.ownerId).toBe(original.ownerId);
    expect(result.newMemory?.supersedes).toEqual([memoryId]);
    expect(result.newMemory?.metadata?.observationTime).toBe(original.metadata?.observationTime);
    expect(result.receipt.effective).toBe(true);
    expect(state.reviews[0].decision).toBe("edited");
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0].snapshotType).toBe('memory_dependency_change');
    expect((state.observations[0].metadata as Record<string, unknown>).independentlyVerifiesBusinessFact).toBe(false);
    expect(result.newMemory?.evidenceRefs.some(ref => ref.startsWith("brain-observation:"))).toBe(true);
  });
  it.each(["fact", "boundary", "system"] as const)("keeps an owner-asserted %s pending independent verification", async memoryType => {
    const original = fixture({memoryType}); storeFixture(original);
    const result = await reviseBrainMemory({requester: owner, memoryId, request: body(original), now});
    expect(result.newMemory?.status).toBe("candidate");
    expect(result.oldMemory.status).toBe("superseded");
    expect(result.receipt).toMatchObject({status: "pending_verification", effective: false, verificationRequired: true});
  });
  it("does not promote an external claim about a preference", async () => {
    const original = fixture(); storeFixture(original);
    const result = await reviseBrainMemory({requester: owner, memoryId, request: body(original, {authority: "external_fact"}), now});
    expect(result.newMemory?.status).toBe("candidate");
  });
  it("keeps historical assertions in the version chain without growing current evidence forever", async () => {
    const original = fixture({evidenceRefs: ["source-before", "brain-observation:previous-owner-assertion"],
      metadata: {revision: {assertionEvidenceRefs: ["brain-observation:previous-owner-assertion"]}}});
    const state = storeFixture(original);
    const result = await reviseBrainMemory({requester: owner, memoryId,
      request: body(original, {evidenceRefs: [...original.evidenceRefs, "source-after"]}), now});
    expect(result.newMemory?.evidenceRefs).toHaveLength(3);
    expect(result.newMemory?.evidenceRefs).not.toContain("brain-observation:previous-owner-assertion");
    expect(result.oldMemory.evidenceRefs).toContain("brain-observation:previous-owner-assertion");
    expect(state.observations).toHaveLength(1);
    const saturated = fixture({evidenceRefs: Array.from({length: 100}, (_, i) => `source-${i}`)});
    storeFixture(saturated);
    const maximum = await reviseBrainMemory({requester: owner, memoryId, request: body(saturated), now});
    expect(maximum.newMemory?.evidenceRefs).toHaveLength(101);
    storeFixture(saturated);
    await expect(reviseBrainMemory({requester: owner, memoryId, request: body(saturated, {evidenceRefs: ["additional-source"]}), now}))
      .rejects.toMatchObject({code: "invalid_revision"});
  });
  it("does not invent a new observation time for an undated state change", async () => {
    const original = fixture(); storeFixture(original);
    const result = await reviseBrainMemory({requester: owner, memoryId, request: body(original, {operation: "state_change"}), now});
    expect(result.newMemory?.metadata).toMatchObject({observationTime: original.metadata?.observationTime, observationTimeUnknown: true});
    storeFixture(original);
    const dated = await reviseBrainMemory({requester: owner, memoryId,
      request: body(original, {operation: "state_change", sourceObservedAt: "2026-10-01T10:00:00+08:00"}), now});
    expect(dated.newMemory?.metadata).toMatchObject({observationTime: "2026-10-01T02:00:00.000Z", observationTimeUnknown: false});
  });
  it("deactivates with a preserved historical row and no replacement", async () => {
    const original = fixture(); const state = storeFixture(original);
    const request = body(original, {operation: "deactivate"}); delete (request as Record<string, unknown>).content;
    const result = await reviseBrainMemory({requester: owner, memoryId, request, now});
    expect(result.oldMemory).toMatchObject({content: original.content, status: "deleted"});
    expect(result.newMemory).toBeNull(); expect(state.replacements).toHaveLength(0);
    expect(result.receipt.effective).toBe(true);
  });
  it("restores only a deactivated current memory by creating another ID", async () => {
    const original = fixture({status: "deleted", metadata: {revisionRetired: {nextMemoryId: null}}}); storeFixture(original);
    const result = await reviseBrainMemory({requester: owner, memoryId, request: body(original, {operation: "restore"}), now});
    expect(result.newMemory?.id).not.toBe(memoryId); expect(result.newMemory?.status).toBe("active");
    expect(result.newMemory?.metadata).not.toHaveProperty("revisionRetired");
    expect(result.oldMemory.status).toBe("superseded");
    for (const inactive of [fixture({status: "deleted"}), fixture({status: "superseded", metadata: {revisionRetired: {nextMemoryId: null}}})]) {
      storeFixture(inactive);
      await expect(reviseBrainMemory({requester: owner, memoryId, request: body(inactive, {operation: "restore"}), now}))
        .rejects.toMatchObject({code: "memory_inactive"});
    }
  });
  it("rejects future observations and an invalid submission clock before writing", async () => {
    const original = fixture(); const state = storeFixture(original);
    await expect(reviseBrainMemory({requester: owner, memoryId,
      request: body(original, {operation: "state_change", sourceObservedAt: "2026-10-03T00:00:00Z"}), now}))
      .rejects.toMatchObject({code: "invalid_revision"});
    await expect(reviseBrainMemory({requester: owner, memoryId, request: body(original), now: new Date("invalid")}))
      .rejects.toMatchObject({code: "invalid_revision"});
    expect(state.observations).toHaveLength(0);
  });
  it("rejects a stale base before any observation, retirement or audit write", async () => {
    const original = fixture(); const state = storeFixture(original);
    await expect(reviseBrainMemory({requester: owner, memoryId, request: body(original, {expectedVersion: `bmrv1:${"0".repeat(64)}`}), now}))
      .rejects.toMatchObject({code: "version_conflict", status: 409});
    expect(state.reviews).toHaveLength(0); expect(state.observations).toHaveLength(0);
    expect(state.memory.status).toBe(original.status);
  });
  it("replays the durable receipt before checking the now-retired base and rejects payload changes", async () => {
    const original = fixture(); const state = storeFixture(original); const request = body(original);
    const first = await reviseBrainMemory({requester: owner, memoryId, request, now});
    const replay = await reviseBrainMemory({requester: owner, memoryId, request, now});
    expect(replay).toEqual({...first, replayed: true});
    expect(state.replacements).toHaveLength(1); expect(state.observations).toHaveLength(1); expect(state.reviews).toHaveLength(1); expect(state.snapshots).toHaveLength(1);
    expect(state.writes).toEqual([true, false]);
    await expect(reviseBrainMemory({requester: owner, memoryId, request: {...request, content: "Changed payload"}, now}))
      .rejects.toMatchObject({code: "command_conflict", status: 409});
  });
  it("rejects agent-originated revisions and retired rows without resurrection", async () => {
    const original = fixture(); storeFixture(original);
    await expect(reviseBrainMemory({requester: {...owner, type: "work"}, memoryId, request: body(original), now}))
      .rejects.toMatchObject({code: "owner_revision_required", status: 403});
    const retired = fixture({status: "superseded"}); const state = storeFixture(retired);
    await expect(reviseBrainMemory({requester: owner, memoryId, request: body(retired), now})).rejects.toMatchObject({code: "memory_inactive", status: 409});
    expect(state.observations).toHaveLength(0);
  });
});

describe("revision review retirement boundary", () => {
  it.each([
    ["active", "dismissed"], ["active", "rejected"], ["candidate", "dismissed"], ["candidate", "rejected"],
  ] as const)("rejects legacy %s -> %s retirement even with an owner's current version", async (status, decision) => {
    const original = fixture({status, metadata: {revision: {operation: "correct", previousMemoryId: "previous"}}});
    const state = storeFixture(original);
    await expect(reviewBrainMemoryInTransaction({requester: owner, memoryId, decision,
      expectedVersion: getBrainMemoryRevisionVersion(original), evidenceConfirmed: true, reason: "Explicit owner reason", now},
      state.store as unknown as DrizzleDB)).rejects.toMatchObject({code: "memory_revision_required", status: 409});
    expect(state.store.update).not.toHaveBeenCalled(); expect(state.reviews).toHaveLength(0);
    expect(state.memory.status).toBe(status);
  });
  it("preserves dismissal of an ordinary candidate without revision metadata", async () => {
    const original = fixture({status: "candidate", metadata: {}}); const state = storeFixture(original);
    const result = await reviewBrainMemoryInTransaction({requester: owner, memoryId, decision: "dismissed", reason: "Not relevant", now},
      state.store as unknown as DrizzleDB);
    expect(result.status).toBe("deleted"); expect(result.content).toBe(original.content);
    expect(state.reviews).toHaveLength(1); expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]).toMatchObject({ snapshotType: "memory_dependency_change",
      metadata: expect.objectContaining({ reviewId: state.reviews[0].id, commandId: `memory-review:${state.reviews[0].id}` }) });
  });
  it("rolls the status and review audit back when its dependency change cannot persist", async () => {
    const original = fixture({status: "candidate", metadata: {}}); const state = storeFixture(original);
    state.failSnapshots = true;
    await expect(reviewBrainMemoryTransaction({requester: owner, memoryId, decision: "confirmed", now}))
      .rejects.toThrow("dependency change storage unavailable");
    expect(state.memory.status).toBe("candidate"); expect(state.reviews).toHaveLength(0);
    expect(state.snapshots).toHaveLength(0); expect(state.writes).toHaveLength(0);
  });
});
