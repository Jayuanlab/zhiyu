import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

type Row = Record<string, unknown>;
type Condition = { op: "eq"; key: string; value: unknown } | { op: "null"; key: string }
  | { op: "and" | "or"; values: Array<Condition | undefined> };
const f = vi.hoisted(() => ({ transaction: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/memory/revision/transaction", () => ({ withBrainMemoryTransaction: f.transaction,
  BrainMemoryIdentityConflict: class extends Error {} }));
vi.mock("@/lib/memory/adapters/postgres/memory-records", () => ({ getBrainMemoryById: f.read }));
vi.mock("drizzle-orm", async original => {
  const actual = await original<typeof import("drizzle-orm")>();
  const key = (column: { name: string }) => column.name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return { ...actual,
    eq: (column: { name: string }, value: unknown): Condition => ({ op: "eq", key: key(column), value }),
    isNull: (column: { name: string }): Condition => ({ op: "null", key: key(column) }),
    and: (...values: Array<Condition | undefined>): Condition => ({ op: "and", values }),
    or: (...values: Array<Condition | undefined>): Condition => ({ op: "or", values }),
  };
});

import { brainAccessGrants, brainMemories, brainMemoryReviews, brainObservations, brainStateSnapshots } from "@/lib/db/schema";
import { brainMemoryFromRow, brainMemoryToInsertRow } from "@/lib/memory/records/memory-record";
import { admitOrdinaryBrainMemory } from "@/lib/memory/revision/admission";
import { admitOrdinaryBrainMemory as legacyAdmission } from "@/lib/brain/memory-update-admission";
import { decideBrainMemoryUpdate, parseBrainMemoryUpdateRequest, proposeBrainMemoryUpdate } from "@/lib/memory/revision/proposals";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";

const userId = "00000000-0000-4000-a000-000000000001";
const memoryId = "00000000-0000-4000-a000-000000000002";
const now = new Date("2026-10-20T08:00:00Z");
const owner = { type: "chat" as const, userId, id: "owner" };
const work = { type: "work" as const, userId, id: "work-1" };
function memory(patch: Partial<BrainMemory> = {}): BrainMemory {
  return { id: memoryId, userId, scope: { type: "work", workId: "work-1" }, ownerType: "work", ownerId: "work-1",
    memoryType: "preference", subject: "Language", content: "Use English", status: "active", confidence: 80,
    evidenceRefs: ["source-before"], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    metadata: { canonicalGroupId: "language-current" }, ...patch };
}
function fixture(initial: BrainMemory[] = []) {
  const tables = new Map<unknown, string>([[brainMemories, "memories"], [brainMemoryReviews, "reviews"],
    [brainObservations, "observations"], [brainStateSnapshots, "snapshots"], [brainAccessGrants, "grants"]]);
  const state = { rows: { memories: initial.map(item => ({ ...brainMemoryToInsertRow(item) })), reviews: [], observations: [], snapshots: [], grants: [] } as Record<string, Row[]>,
    failTable: "", commits: 0, next: 10 };
  function matches(row: Row, condition?: Condition): boolean {
    if (!condition) return true;
    if (condition.op === "eq") return row[condition.key] === condition.value;
    if (condition.op === "null") return row[condition.key] == null;
    return condition.op === "and" ? condition.values.every(value => matches(row, value)) : condition.values.some(value => matches(row, value));
  }
  function tableName(table: unknown) { const name = tables.get(table); if (!name) throw new Error("Unexpected fixture table"); return name; }
  const store = {
    execute: vi.fn(async () => []),
    select: () => ({ from: (table: unknown) => {
      let condition: Condition | undefined;
      let limit = Infinity;
      const read = () => state.rows[tableName(table)].filter(row => matches(row, condition)).slice(0, limit);
      const query = { where: (value: Condition) => { condition = value; return query; },
        orderBy: () => query, for: async () => read(), limit: async (count: number) => { limit = count; return read(); },
        then: (resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(read()).then(resolve, reject) };
      return query;
    } }),
    insert: (table: unknown) => ({ values: (value: Row) => ({ returning: async () => {
      const name = tableName(table);
      if (state.failTable === name) throw new Error(`${name} unavailable`);
      const row = { id: `00000000-0000-4000-a000-${String(state.next++).padStart(12, "0")}`, ...value };
      state.rows[name].push(row); return [row];
    } }) }),
    update: (table: unknown) => ({ set: (patch: Row) => ({ where: (condition: Condition) => ({ returning: async () => {
      const name = tableName(table); const updated: Row[] = [];
      state.rows[name] = state.rows[name].map(row => { if (!matches(row, condition)) return row; const value = { ...row, ...patch }; updated.push(value); return value; });
      return updated;
    } }) }) }),
  };
  f.transaction.mockImplementation(async (_user: string, write: (database: typeof store) => Promise<{ result: unknown; written?: boolean }>) => {
    const before = structuredClone(state.rows);
    try { const outcome = await write(store); state.commits += 1; return outcome.result; }
    catch (error) { state.rows = before; throw error; }
  });
  const readMemory = (id: string) => {
    const row = state.rows.memories.find(item => item.id === id);
    if (!row) throw new Error("Missing fixture memory");
    return brainMemoryFromRow(row as Parameters<typeof brainMemoryFromRow>[0]);
  };
  return { state, readMemory };
}
beforeEach(() => vi.clearAllMocks());

describe("Memory revision domain after extraction", () => {
  it("preserves the previously issued bmrv1 token byte for byte", () => {
    expect(getBrainMemoryRevisionVersion(memory())).toBe("bmrv1:2bbbc9a31b518e784f7cac355468978f450d77e35b5730334e33238ae0532789");
  });

  it("rechecks actual write authorization before ordinary admission creates any record", async () => {
    const { state } = fixture();
    await expect(admitOrdinaryBrainMemory({ requester: { ...owner, type: "work", id: "other-work" }, memory: memory(), now }))
      .rejects.toMatchObject({ code: "update_not_allowed", status: 403 });
    expect(Object.values(state.rows).flat()).toHaveLength(0); expect(state.commits).toBe(0);
  });

  it("rejects a different user even when the requester has the same Work ID", async () => {
    const { state } = fixture();
    await expect(admitOrdinaryBrainMemory({ requester: work,
      memory: memory({ userId: "00000000-0000-4000-a000-000000000099" }), now }))
      .rejects.toMatchObject({ code: "update_not_allowed", status: 403 });
    expect(f.transaction).not.toHaveBeenCalled(); expect(Object.values(state.rows).flat()).toHaveLength(0);
  });

  it("keeps the legacy admission entry as the same implementation and owner identity", async () => {
    expect(legacyAdmission).toBe(admitOrdinaryBrainMemory);
    const { readMemory } = fixture();
    const result = await legacyAdmission({ requester: work, memory: memory({ status: "candidate" }), now });
    expect(result).toMatchObject({ userId, ownerType: "work", ownerId: "work-1", scope: { type: "work", workId: "work-1" } });
    expect(readMemory(memoryId).userId).toBe(userId);
  });

  it("admits an initial memory once and returns persisted current state on a durable replay", async () => {
    const { state } = fixture(); const incoming = memory({ status: "candidate" });
    await admitOrdinaryBrainMemory({ requester: work, memory: incoming, now });
    const replay = await admitOrdinaryBrainMemory({ requester: work, memory: incoming, now });
    expect(replay).toMatchObject({ id: memoryId, status: "candidate", content: "Use English" });
    expect(state.rows.memories).toHaveLength(1); expect(state.rows.reviews).toHaveLength(1);
  });

  it("keeps a differing ordinary understanding pending and preserves the active base", async () => {
    const { state, readMemory } = fixture([memory()]);
    const result = await admitOrdinaryBrainMemory({ requester: work, memory: memory({ content: "Use Chinese", status: "candidate" }), now });
    expect(result.status).toBe("candidate"); expect(result.metadata?.updateProposal).toMatchObject({ status: "pending", targetMemoryId: memoryId });
    expect(readMemory(memoryId)).toMatchObject({ status: "active", content: "Use English" });
    expect(state.rows.observations).toHaveLength(1); expect(state.rows.reviews).toHaveLength(1);
  });

  it("rejects identity and metadata overrides through the real proposal parser", () => {
    const request = { targetMemoryId: memoryId, expectedVersion: getBrainMemoryRevisionVersion(memory()), commandId: "proposal-command",
      content: "Use Chinese", reason: "New source", evidenceRefs: [] };
    for (const patch of [{ ownerId: "other-work" }, { status: "active" }, { metadata: { authority: "owner" } }]) {
      expect(() => parseBrainMemoryUpdateRequest({ ...request, ...patch })).toThrow("Update cannot change identity");
    }
  });

  it("requires an owner decision and checked evidence before retiring a proposal base", async () => {
    const { state, readMemory } = fixture([memory()]);
    const proposed = await proposeBrainMemoryUpdate({ requester: owner, now, request: { targetMemoryId: memoryId,
      expectedVersion: getBrainMemoryRevisionVersion(readMemory(memoryId)), commandId: "proposal-command", content: "Use Chinese", reason: "New source", evidenceRefs: [] } });
    const request = { action: "accept", commandId: "accept-command", expectedVersion: proposed.proposalVersion,
      expectedBaseVersion: proposed.baseVersion, reason: "Owner checked the source", evidenceConfirmed: true };
    await expect(decideBrainMemoryUpdate({ requester: { ...owner, type: "work" }, proposalId: proposed.candidate.id, request, now }))
      .rejects.toMatchObject({ code: "owner_decision_required", status: 403 });
    await expect(decideBrainMemoryUpdate({ requester: owner, proposalId: proposed.candidate.id, request: { ...request, evidenceConfirmed: false }, now }))
      .rejects.toMatchObject({ code: "evidence_verification_required", status: 400 });
    expect(readMemory(memoryId).status).toBe("active"); expect(state.rows.snapshots).toHaveLength(0);
    const result = await decideBrainMemoryUpdate({ requester: owner, proposalId: proposed.candidate.id, request, now });
    expect(result.receipt.effective).toBe(true); expect(readMemory(memoryId).status).toBe("superseded");
    expect(readMemory(proposed.candidate.id)).toMatchObject({ status: "active", content: "Use Chinese" });
    expect(state.rows.snapshots).toHaveLength(1); expect(state.rows.snapshots[0].snapshotType).toBe("memory_dependency_change");
  });
});
