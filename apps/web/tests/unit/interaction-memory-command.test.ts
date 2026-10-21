import { beforeEach, describe, expect, it, vi } from "vitest";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import { currentExecutionWriteContext } from "@/lib/work-runtime/execution-write-context";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const fake = vi.hoisted(() => {
  type Data = { legacy: any[]; brain: any[]; sources: any[]; audits: any[]; notes: any[]; tasks: any[]; taskHistory: any[] };
  const state = { data: { legacy: [], brain: [], sources: [], audits: [], notes: [], tasks: [], taskHistory: [] } as Data, pending: null as Data | null,
    failCreate: false, failReview: false, failLegacyUpdate: false, leaseValid: true, expireAfterWrite: false };
  const data = () => state.pending ?? state.data;
  const name = (table: any) => table[Symbol.for("drizzle:Name")];
  const rows = (table: any): any[] => name(table) === "interaction_events" ? data().sources
    : name(table) === "interaction_memories" ? data().legacy : name(table) === "brain_memories" ? data().brain
      : name(table) === "interaction_notes" ? data().notes : name(table) === "interaction_tasks" ? data().tasks
        : name(table) === "interaction_task_revisions" ? data().taskHistory : [];
  const select = vi.fn(() => {
    let table: any, limit = Infinity, condition: SQL | undefined;
    const query: any = { from(value: any) { table = value; return query; }, where(value: SQL) { condition = value; return query; }, orderBy: () => query,
      limit(value: number) { limit = value; return query; }, for: () => query,
      then(resolve: any, reject: any) {
        let result = rows(table);
        if (name(table) === "interaction_task_revisions" && condition) {
          const params = new PgDialect().sqlToQuery(condition).params;
          result = result.filter(row => row.userId === params[0] && row.commandId === params[1]);
        }
        // Database result rows are value snapshots, not aliases into the mutable fixture.
        return Promise.resolve(structuredClone(result.slice(0, limit))).then(resolve, reject);
      } };
    return query;
  });
  const insert = vi.fn((table: any) => ({ values: (value: any) => ({ returning: async () => {
    rows(table).push(structuredClone(value)); return [structuredClone(value)];
  } }) }));
  const update = vi.fn((table: any) => ({ set: (patch: any) => ({ where: () => ({ returning: async () => {
    if (state.failLegacyUpdate) throw new Error("legacy update failed");
    const row = rows(table)[0]; if (!row) return [];
    Object.assign(row, structuredClone(patch)); return [structuredClone(row)];
  } }) }) }));
  const transaction = vi.fn(async (work: () => Promise<any>) => {
    if (state.pending) return work();
    state.pending = structuredClone(state.data);
    try { const result = await work(); state.data = state.pending; return result; }
    finally { state.pending = null; }
  });
  const execute = vi.fn(async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    if (query.sql.includes("pg_advisory_xact_lock")) return [];
    throw new Error(`Unexpected transaction fixture SQL: ${query.sql}`);
  });
  const db: any = { select, insert, update, execute, transaction: (work: (store: any) => Promise<any>) => transaction(() => work(db)) };
  return { state, data, db, transaction, execute, insert, create: vi.fn(), review: vi.fn(), fence: vi.fn(), legacyUpsert: vi.fn(), project: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ db: fake.db, withDatabaseTransaction: fake.transaction }));
vi.mock("@/lib/memory/revision/writes", async original => ({
  ...await original<typeof import("@/lib/memory/revision/writes")>(), createMemoryCandidate: fake.create, reviewMemory: fake.review,
}));
vi.mock("@/lib/brain/repository", async original => ({
  ...await original<typeof import("@/lib/brain/repository")>(), upsertBrainMemory: fake.legacyUpsert,
}));
vi.mock("@/lib/interactions/scenario-task-projection", () => ({ projectInteractionTaskScenariosInTransaction: fake.project }));
vi.mock("@/lib/work-runtime/execution-lease", async original => ({
  ...await original<typeof import("@/lib/work-runtime/execution-lease")>(), withExecutionBusinessWrite: fake.fence,
}));

import { clearInteractionMemories, clearInteractionWikiItems, createInteractionMemoryCandidate, deleteInteractionWikiItem,
  promoteInteractionMemoryCandidates, updateInteractionMemoryStatus } from "@/lib/interactions/service";
import { brainMemoryFromRow } from "@/lib/brain/repository";
import { getBrainMemoryCanonicalMetadata } from "@/lib/brain/canonical";
import { reviewOwnerContextCandidate } from "@/lib/owner-context/service";

const userId = "11111111-1111-4111-a111-111111111111", eventId = "22222222-2222-4222-a222-222222222222";
const memoryId = "33333333-3333-4333-a333-333333333333";
const lease = { userId, workshopId: "44444444-4444-4444-a444-444444444444", runId: "55555555-5555-4555-a555-555555555555", workerId: "worker", token: 1 };
const input = { userId, memoryType: "preference", subject: "Owner preference", content: "Prefers concise source-backed updates.",
  confidence: 95, sourceEventIds: [eventId], expiresAt: new Date("2099-01-01T00:00:00Z") };
function paired() {
  fake.state.data.legacy = [{ id: memoryId, ...input, status: "candidate", tags: [],
    metadata: { brainMemoryId: memoryId, brainMemoryAlias: `legacy-interaction-memory:${memoryId}` },
    lastVerifiedAt: null, createdAt: new Date(), updatedAt: new Date() }];
  fake.state.data.brain = [{ id: memoryId, userId, scopeType: "global", scopeId: null, ownerType: "chat", ownerId: userId,
    memoryType: "preference", subject: input.subject, content: input.content, status: "candidate", confidence: 95,
    evidenceRefs: [eventId], tags: [], createdAt: new Date(), updatedAt: new Date(),
    metadata: { facets: { sourceKind: "interaction_memory" },
      derivedRefs: [{ source: "interaction_memory", id: memoryId, relation: "mirrors" }] } }];
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.state.data = { legacy: [], brain: [], sources: [{ id: eventId }], audits: [], notes: [], tasks: [], taskHistory: [] };
  fake.state.pending = null; fake.state.failCreate = false; fake.state.failReview = false;
  fake.state.failLegacyUpdate = false; fake.state.leaseValid = true; fake.state.expireAfterWrite = false;
  fake.create.mockImplementation(async (request: any) => {
    if (!/^[a-f0-9-]{36}$/i.test(request.id)) throw new Error("invalid input syntax for type uuid");
    expect(fake.state.pending).not.toBeNull();
    const row = { ...request, userId: request.requester.userId, scopeType: request.scope.type, scopeId: null, status: "candidate",
      createdAt: request.now, updatedAt: request.now, metadata: { ...request.metadata, facets: request.facets, derivedRefs: request.derivedRefs } };
    fake.data().brain.push(row); fake.data().audits.push({ kind: "created", id: row.id });
    if (fake.state.failCreate) throw new Error("canonical write failed");
    return brainMemoryFromRow(row);
  });
  fake.review.mockImplementation(async (request: any) => {
    expect(fake.state.pending).not.toBeNull();
    const row = fake.data().brain.find(item => item.id === request.memoryId);
    if (!row) throw new Error("canonical target missing");
    row.status = request.decision === "confirmed" ? "verified" : request.decision === "weakened" ? "weakened" : "deleted";
    fake.data().audits.push({ kind: "reviewed", id: row.id });
    if (fake.state.failReview) throw new Error("canonical review failed");
    return brainMemoryFromRow(row);
  });
  fake.fence.mockImplementation(async (_lease: unknown, write: (context: any) => Promise<unknown>) => fake.transaction(async () => {
    if (!fake.state.leaseValid) throw Object.assign(new Error("lease_lost"), { code: "lease_lost" });
    const result = await write({ db: fake.db, append: async (event: unknown) => { fake.data().audits.push(event); } });
    if (fake.state.expireAfterWrite) throw Object.assign(new Error("lease_lost"), { code: "lease_lost" });
    return result;
  }));
  fake.project.mockResolvedValue({ status: "not_applicable", scenarioCount: 0 });
});

describe("atomic legacy interaction memory commands", () => {
  it("creates the legacy record and exact UUID Brain candidate together without approving either", async () => {
    const memory = await createInteractionMemoryCandidate({ ...input, status: "confirmed" });
    expect(memory.status).toBe("candidate");
    expect(fake.state.data.legacy).toHaveLength(1); expect(fake.state.data.brain).toHaveLength(1);
    const canonical = brainMemoryFromRow(fake.state.data.brain[0]);
    expect(canonical.id).toBe(memory.id); expect(canonical.status).toBe("candidate");
    expect(canonical.expiresAt).toBe(input.expiresAt.toISOString());
    expect(getBrainMemoryCanonicalMetadata(canonical).derivedRefs).toContainEqual({ source: "interaction_memory", id: memory.id, relation: "mirrors" });
    expect(memory.metadata).toMatchObject({ brainMemoryId: memory.id, brainMemoryAlias: `legacy-interaction-memory:${memory.id}` });
    expect(fake.review).not.toHaveBeenCalled();
  });

  it("rolls back both records and audit when canonical creation fails instead of reporting legacy success", async () => {
    fake.state.failCreate = true;
    await expect(createInteractionMemoryCandidate(input)).rejects.toThrow("canonical write failed");
    expect(fake.state.data).toMatchObject({ legacy: [], brain: [], audits: [] });
  });

  it("rejects missing or inaccessible raw sources before either write", async () => {
    fake.state.data.sources = [];
    await expect(createInteractionMemoryCandidate(input)).rejects.toThrow("missing or not accessible");
    expect(fake.state.data.legacy).toEqual([]); expect(fake.create).not.toHaveBeenCalled();
  });

  it("shares the fenced execution transaction with the canonical service", async () => {
    fake.create.mockImplementationOnce(async (request: any) => {
      expect(currentExecutionWriteContext(lease)?.db).toBe(fake.db);
      expect(fake.state.pending).not.toBeNull();
      return { id: request.id, status: "candidate" };
    });
    await withExecutionContext(lease, () => createInteractionMemoryCandidate(input));
    expect(fake.fence).toHaveBeenCalledOnce();
  });

  it.each(["wrong_user", "expired", "expires_after_write"])("does not commit through a %s execution lease", async mode => {
    fake.state.leaseValid = mode !== "expired"; fake.state.expireAfterWrite = mode === "expires_after_write";
    const activeLease = mode === "wrong_user" ? { ...lease, userId: "another-user" } : lease;
    await expect(withExecutionContext(activeLease, () => createInteractionMemoryCandidate(input))).rejects.toThrow(/invalid_lease|lease_lost/);
    expect(fake.state.data).toMatchObject({ legacy: [], brain: [], audits: [] });
  });

  it("reviews the linked UUID through an old typed alias and commits both states", async () => {
    paired();
    const result = await updateInteractionMemoryStatus({ userId, id: `legacy-interaction-memory:${memoryId}`, status: "confirmed" });
    expect(result.status).toBe("confirmed"); expect(fake.state.data.brain[0].status).toBe("verified");
    expect(result.metadata).toMatchObject({ source: "brain", brainMemoryId: memoryId, brainReviewApplied: true });
    expect(fake.review).toHaveBeenCalledWith(expect.objectContaining({ memoryId, decision: "confirmed" }));
  });

  it("does not repeat a completed canonical review through the owner-context legacy upsert path", async () => {
    paired();
    const result = await reviewOwnerContextCandidate({ userId, kind: "memory", id: memoryId, decision: "confirmed" });
    expect(result.item.state).toBe("confirmed"); expect(fake.review).toHaveBeenCalledOnce();
    expect(fake.legacyUpsert).not.toHaveBeenCalled();
  });

  it("can review a canonical-only interaction memory through its actual raw-event linkage", async () => {
    paired(); fake.state.data.legacy = [];
    fake.state.data.brain[0].metadata.derivedRefs = [{ source: "interaction_event", id: eventId, relation: "derived_from" }];
    const result = await updateInteractionMemoryStatus({ userId, id: memoryId, status: "confirmed" });
    expect(result.status).toBe("confirmed"); expect(result.metadata).toMatchObject({ source: "brain" });
    expect(fake.state.data.brain[0].status).toBe("verified");
  });

  it("does not treat a source-kind label alone as an interaction source link", async () => {
    paired(); fake.state.data.legacy = []; fake.state.data.brain[0].metadata.derivedRefs = [];
    fake.state.data.brain[0].metadata.facets.sourceKind = "wechat";
    await expect(updateInteractionMemoryStatus({ userId, id: memoryId, status: "confirmed" })).rejects.toThrow("source linkage");
    expect(fake.review).not.toHaveBeenCalled();
  });

  it.each(["canonical", "legacy"])("rolls back both review states when the %s write fails", async failure => {
    paired(); fake.state.failReview = failure === "canonical"; fake.state.failLegacyUpdate = failure === "legacy";
    await expect(updateInteractionMemoryStatus({ userId, id: memoryId, status: "confirmed" })).rejects.toThrow(/review failed|update failed/);
    expect(fake.state.data.legacy[0].status).toBe("candidate"); expect(fake.state.data.brain[0].status).toBe("candidate");
    expect(fake.state.data.audits).toEqual([]);
  });

  it.each(["foreign_owner", "missing_link", "foreign_source"])("does not review a UUID with %s", async mismatch => {
    paired();
    if (mismatch === "foreign_owner") fake.state.data.brain[0].ownerId = "another-owner";
    if (mismatch === "missing_link") fake.state.data.brain[0].metadata.derivedRefs = [];
    if (mismatch === "foreign_source") fake.state.data.sources = [];
    await expect(updateInteractionMemoryStatus({ userId, id: memoryId, status: "confirmed" })).rejects.toThrow();
    expect(fake.review).not.toHaveBeenCalled(); expect(fake.state.data.legacy[0].status).toBe("candidate");
  });

  it("does not silently confirm a legacy-only record that has no canonical mirror", async () => {
    paired(); fake.state.data.brain = [];
    await expect(updateInteractionMemoryStatus({ userId, id: memoryId, status: "confirmed" })).rejects.toThrow("unavailable");
    expect(fake.state.data.legacy[0].status).toBe("candidate");
  });

  it("allows an owner to dismiss a linked memory even when its raw source is no longer available", async () => {
    paired(); fake.state.data.sources = [];
    const result = await updateInteractionMemoryStatus({ userId, id: memoryId, status: "dismissed" });
    expect(result.status).toBe("dismissed"); expect(fake.state.data.brain[0].status).toBe("deleted");
  });

  it("archives an effective mirror by weakening it and never activates an archived pending candidate", async () => {
    paired(); fake.state.data.brain[0].status = "verified";
    expect((await updateInteractionMemoryStatus({ userId, id: memoryId, status: "archived" })).status).toBe("archived");
    expect(fake.state.data.brain[0].status).toBe("weakened");
    paired();
    await updateInteractionMemoryStatus({ userId, id: memoryId, status: "archived" });
    expect(fake.state.data.brain[0].status).toBe("deleted");
  });

  it("keeps an already pending record pending but does not revive an effective record through candidate status", async () => {
    paired();
    expect((await updateInteractionMemoryStatus({ userId, id: memoryId, status: "candidate" })).status).toBe("candidate");
    expect(fake.review).not.toHaveBeenCalled();
    fake.state.data.brain[0].status = "verified";
    await expect(updateInteractionMemoryStatus({ userId, id: memoryId, status: "candidate" })).rejects.toThrow("versioned revision workflow");
  });

  it("keeps policy promotion atomic and does not rewrite the requested target as a prefixed UUID", async () => {
    paired();
    const result = await promoteInteractionMemoryCandidates({ userId });
    expect(result.promotedCount).toBe(1); expect(fake.state.data.legacy[0].status).toBe("confirmed");
    expect(fake.state.data.brain[0].status).toBe("verified");
    expect(fake.review).toHaveBeenCalledWith(expect.objectContaining({ memoryId, requester: expect.objectContaining({ id: "interaction-memory-auto-promotion" }) }));
  });

  it("leaves policy candidates pending when canonical review rejects promotion", async () => {
    paired(); fake.state.failReview = true;
    await expect(promoteInteractionMemoryCandidates({ userId })).rejects.toThrow("canonical review failed");
    expect(fake.state.data.legacy[0].status).toBe("candidate"); expect(fake.state.data.brain[0].status).toBe("candidate");
  });

  it("retains dry-run eligibility without calling review or changing either record", async () => {
    paired();
    expect((await promoteInteractionMemoryCandidates({ userId, dryRun: true })).promotedCount).toBe(1);
    expect(fake.review).not.toHaveBeenCalled();
    expect(fake.state.data.legacy[0].status).toBe("candidate"); expect(fake.state.data.brain[0].status).toBe("candidate");
  });

  it("deletes an exact legacy alias and its linked canonical memory in one command", async () => {
    paired();
    const result = await deleteInteractionWikiItem({ userId, kind: "memory", id: `legacy-interaction-memory:${memoryId}` });
    if (!("memory" in result)) throw new Error("Expected a memory deletion result");
    expect(result.memory?.status).toBe("deleted"); expect(fake.state.data.brain[0].status).toBe("deleted");
    expect(fake.state.data.legacy[0].metadata).toMatchObject({ brainMemoryId: memoryId, deletedBy: "user" });
    expect(fake.review).toHaveBeenCalledOnce();
  });

  it.each(["canonical", "legacy"])("rolls back an exact delete when the %s operation fails", async failure => {
    paired(); fake.state.failReview = failure === "canonical"; fake.state.failLegacyUpdate = failure === "legacy";
    await expect(deleteInteractionWikiItem({ userId, kind: "memory", id: memoryId })).rejects.toThrow();
    expect(fake.state.data.legacy[0].status).toBe("candidate"); expect(fake.state.data.brain[0].status).toBe("candidate");
    expect(fake.state.data.audits).toEqual([]);
  });

  it("rejects an unrelated or foreign canonical UUID before deleting the legacy item", async () => {
    paired(); fake.state.data.brain[0].ownerId = "foreign-owner";
    await expect(deleteInteractionWikiItem({ userId, kind: "memory", id: memoryId })).rejects.toThrow("source linkage");
    expect(fake.state.data.legacy[0].status).toBe("candidate"); expect(fake.review).not.toHaveBeenCalled();
  });

  it("counts one logical mirror once and leaves unrelated owner Brain memories untouched", async () => {
    paired();
    const unrelated = { ...structuredClone(fake.state.data.brain[0]), id: "66666666-6666-4666-a666-666666666666", metadata: {} };
    fake.state.data.brain.push(unrelated);
    expect(await clearInteractionMemories({ userId })).toEqual({ deletedCount: 1 });
    expect(fake.state.data.legacy[0].status).toBe("deleted");
    expect(fake.state.data.brain.find(row => row.id === unrelated.id)?.status).toBe("candidate");
    expect(fake.review).toHaveBeenCalledOnce();
  });

  it("preserves a selected alias in both stores and preserves task/note selections", async () => {
    paired();
    fake.state.data.notes = [{ id: "note", userId, metadata: {} }];
    fake.state.data.tasks = [{ id: "task", userId, status: "confirmed", metadata: {} }];
    expect(await clearInteractionWikiItems({ userId, preserve: { memoryIds: [`legacy-interaction-memory:${memoryId}`],
      noteIds: ["note"], taskIds: ["task"] } })).toEqual({ deletedNotes: 0, deletedTasks: 0, deletedMemories: 0, deletedCount: 0 });
    expect(fake.state.data.legacy[0].status).toBe("candidate"); expect(fake.state.data.brain[0].status).toBe("candidate");
    expect(fake.review).not.toHaveBeenCalled(); expect(fake.project).not.toHaveBeenCalled();
  });

  it("rolls back notes, tasks and both memories when a clear command cannot complete canonical dismissal", async () => {
    paired(); fake.state.failReview = true;
    fake.state.data.notes = [{ id: "note", userId, metadata: { retained: true } }];
    fake.state.data.tasks = [{ id: "task", userId, status: "confirmed", metadata: {} }];
    await expect(clearInteractionWikiItems({ userId })).rejects.toThrow("canonical review failed");
    expect(fake.state.data.notes[0].metadata).toEqual({ retained: true });
    expect(fake.state.data.tasks[0].status).toBe("confirmed"); expect(fake.state.data.legacy[0].status).toBe("candidate");
  });

  it("rolls back the clear command if a deleted task cannot update its scenario projection", async () => {
    paired();
    fake.project.mockImplementation(async (_store: unknown, task: { revision: number; status: string }) => {
      expect(task).toMatchObject({ revision: 1, status: "deleted" });
      expect(fake.data().taskHistory).toHaveLength(1);
      expect(fake.data().taskHistory[0]).toMatchObject({ revision: 1, action: "delete", snapshot: { fromVersion: 0 } });
      throw new Error("scenario projection failed");
    });
    fake.state.data.tasks = [{ id: "66666666-6666-4666-a666-666666666666", userId, status: "confirmed", revision: 0,
      title: "Check delivery", dueAt: null, metadata: { taskState: { version: 0, verificationStatus: "confirmed" } } }];
    await expect(clearInteractionWikiItems({ userId })).rejects.toThrow("scenario projection failed");
    expect(fake.execute).toHaveBeenCalled(); expect(fake.project).toHaveBeenCalledOnce();
    expect(fake.state.data.tasks[0]).toMatchObject({ status: "confirmed", revision: 0 });
    expect(fake.state.data.taskHistory).toEqual([]); expect(fake.state.data.legacy[0].status).toBe("candidate");
    expect(fake.state.data.brain[0].status).toBe("candidate"); expect(fake.state.data.audits).toEqual([]);
  });

  it("keeps cleanup inside the execution fence and rolls it back on late lease expiry", async () => {
    paired(); fake.state.expireAfterWrite = true;
    await expect(withExecutionContext(lease, () => clearInteractionMemories({ userId }))).rejects.toThrow("lease_lost");
    expect(fake.state.data.legacy[0].status).toBe("candidate"); expect(fake.state.data.brain[0].status).toBe("candidate");
  });
});
