import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDB } from "@/lib/db/types";
import type { BrainMemory, BrainRequester } from "@/lib/memory/kernel/memory-types";
const mocks = vi.hoisted(() => ({ entity: vi.fn(), registry: vi.fn(), grants: vi.fn(), memory: vi.fn(), pending: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (work: (store: object) => unknown) => work({}) } }));
vi.mock("@/lib/memory/revision/locks", () => ({ acquireBrainWriteAdvisoryLock: mocks.lock }));
vi.mock("@/lib/memory/adapters/postgres/dependency-entities", () => ({ readMemoryDependencyEntity: mocks.entity }));
vi.mock("@/lib/memory/adapters/postgres/dependencies", () => ({ latestRegistry: mocks.registry, grantsFor: mocks.grants,
  readMemory: mocks.memory, hasPendingDependencyUpdate: mocks.pending }));
import { assertMemoryDependenciesCurrentInTransaction, getMemoryDependencies, getMemoryDependencySummariesForEntities } from "@/lib/memory/revision/dependency-check";
import { MemoryDependencyError } from "@/lib/memory/revision/dependencies-common";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { MemoryWriteBusy } from "@/lib/memory/kernel/reference-errors";

const owner = "00000000-0000-4000-8000-000000000001", target = "00000000-0000-4000-8000-000000000002";
const sourceId = "00000000-0000-4000-8000-000000000003", workId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-10-20T03:00:00Z"), entityVersion = `bmde1:${"e".repeat(64)}`;
const store = {} as DrizzleDB;
const source: BrainMemory = { id: sourceId, userId: owner, scope: { type: "global" }, ownerType: "chat", ownerId: owner,
  memoryType: "insight", subject: "Synthetic source", content: "Synthetic assertion", status: "active", confidence: 80,
  evidenceRefs: ["fixture:raw"], createdAt: now.toISOString(), updatedAt: now.toISOString() };
const sourceVersion = getBrainMemoryRevisionVersion(source);
const requester = { type: "chat" as const, userId: owner, id: "human" };
function entity() { return { entity: { kind: "interaction_task", id: target, title: "Synthetic task", content: "Synthetic body",
  contentTruncated: false, status: "candidate", version: entityVersion, workId: null }, row: { id: target, userId: owner } }; }
function registry() { return { id: "00000000-0000-4000-8000-000000000005", content: { entityKind: "interaction_task", entityId: target,
  entityVersion, sources: [{ memoryId: sourceId, expectedVersion: sourceVersion }], sequence: 1 },
  metadata: { requester, consumerRequester: requester as BrainRequester, reason: "Synthetic owner review" }, createdAt: now }; }
const gate = () => assertMemoryDependenciesCurrentInTransaction(store, { userId: owner, entityKind: "interaction_task", entityId: target, now });
beforeEach(() => {
  vi.clearAllMocks(); mocks.entity.mockResolvedValue(entity()); mocks.registry.mockResolvedValue(registry());
  mocks.memory.mockResolvedValue(source); mocks.grants.mockResolvedValue([]); mocks.pending.mockResolvedValue(false); mocks.lock.mockResolvedValue(undefined);
});
describe("Memory dependency read and transaction gate", () => {
  it("keeps legacy unknown explicit without inventing verified dependencies", async () => {
    mocks.registry.mockResolvedValue(null);
    await expect(gate()).resolves.toMatchObject({ coverage: "unknown", assessment: "unknown", verified: false, dependencyVersion: "bmdd1:initial" });
    expect(mocks.memory).not.toHaveBeenCalled(); expect(mocks.grants).not.toHaveBeenCalled();
  });
  it("checks the exact entity and source under the caller transaction", async () => {
    await expect(gate()).resolves.toMatchObject({ coverage: "recorded", assessment: "current", verified: true, entityVersion });
    expect(mocks.entity).toHaveBeenCalledWith(store, { userId: owner, entityKind: "interaction_task", entityId: target }, "share");
    expect(mocks.memory).toHaveBeenCalledWith(store, owner, sourceId, true);
    expect(mocks.lock).toHaveBeenCalledWith(store, JSON.stringify(["brain-memory-dependencies.v1", "target", owner, "interaction_task", target]));
  });
  it.each(["changed_entity", "changed_source", "pending", "expired"])("blocks recorded %s before a business write", async mode => {
    if (mode === "changed_entity") mocks.entity.mockResolvedValue({ ...entity(), entity: { ...entity().entity, version: `bmde1:${"f".repeat(64)}` } });
    if (mode === "changed_source") mocks.memory.mockResolvedValue({ ...source, content: "Changed actual source" });
    if (mode === "pending") mocks.pending.mockResolvedValue(true);
    if (mode === "expired") mocks.memory.mockResolvedValue({ ...source, expiresAt: now.toISOString() });
    await expect(gate()).rejects.toMatchObject({ code: "memory_dependency_stale", status: 409 });
  });
  it("does not let owner inspection restore a revoked consumer permission or disclose its source", async () => {
    const registered = registry(); registered.metadata.consumerRequester = { type: "work", userId: owner, id: workId };
    mocks.registry.mockResolvedValue(registered);
    const result = await getMemoryDependencies({ requester, entityKind: "interaction_task", entityId: target, now });
    expect(result.assessment).toBe("denied"); expect(result.sources[0]).toEqual({ memoryId: sourceId,
      expectedVersion: sourceVersion, assessment: "denied", reason: "source_unavailable_or_denied" });
    await expect(gate()).rejects.toBeInstanceOf(MemoryDependencyError);
  });
  it("keeps denial above an entity version mismatch in bounded model summaries", async () => {
    mocks.memory.mockResolvedValue(null);
    const result = await getMemoryDependencySummariesForEntities({ requester, entities: [{ entityKind: "interaction_task", entityId: target,
      expectedEntityVersion: `bmde1:${"a".repeat(64)}` }], now });
    expect(result[`interaction_task:${target}`]).toMatchObject({ coverage: "recorded", assessment: "denied" });
    expect(JSON.stringify(result)).not.toContain(sourceId); expect(JSON.stringify(result)).not.toContain(source.content);
  });
  it("rejects a locked target explicitly rather than returning stale success", async () => {
    mocks.entity.mockRejectedValue({ cause: { code: "55P03" } });
    await expect(gate()).rejects.toBeInstanceOf(MemoryWriteBusy);
  });
  it("does not silently replace a missing target with legacy unknown", async () => {
    mocks.entity.mockResolvedValue(null);
    await expect(gate()).rejects.toMatchObject({ code: "dependency_target_not_found", status: 404 });
  });
});
