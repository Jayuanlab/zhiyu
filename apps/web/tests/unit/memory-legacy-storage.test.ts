import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import type { BrainMemoryRow } from "@/lib/db/schema";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

const mocks = vi.hoisted(() => ({ store: null as DrizzleDB | null, changes: vi.fn(),
  commit: null as (() => void) | null, rollback: null as (() => void) | null }));
vi.mock("@/lib/db/client", () => ({ db: {
  async transaction<T>(write: (store: DrizzleDB) => Promise<T>): Promise<T> {
    if (!mocks.store) throw new Error("Fixture not initialized");
    try { const result = await write(mocks.store); mocks.commit?.(); return result; }
    catch (error) { mocks.rollback?.(); throw error; }
  },
} }));
vi.mock("@/lib/memory/revision/dependencies", () => ({ recordMemoryChangeInTransaction: mocks.changes }));
vi.mock("@/lib/memory/revision/dependency-check", () => ({ assertMemoryDependenciesCurrentInTransaction: vi.fn() }));

import { brainMemories, brainMemoryReviews } from "@/lib/db/schema";
import { insertBrainMemory, upsertBrainMemory, insertBrainMemoryReview } from "@/lib/memory/revision/legacy-storage";
import { BrainMemoryRevisionProtected } from "@/lib/brain/write-errors";
import { MemoryRevisionProtected } from "@/lib/memory/revision/legacy-errors";
import { MemoryIdentityConflict } from "@/lib/memory/revision/transaction";
import { memoryFromRow, memoryToInsertRow } from "@/lib/memory/records/memory-record";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";

const userId = "11111111-1111-4111-a111-111111111111", memoryId = "22222222-2222-4222-a222-222222222222";
const memory: BrainMemory = { id: memoryId, userId, scope: { type: "global" }, ownerType: "chat", ownerId: userId,
  memoryType: "preference", subject: "Style", content: "Short summaries", status: "active", confidence: 80,
  evidenceRefs: ["event-a"], createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", metadata: {} };
function materialized(input: BrainMemory): BrainMemoryRow {
  const value = memoryToInsertRow(input);
  return { id: input.id, userId: input.userId, scopeType: value.scopeType, scopeId: value.scopeId ?? null,
    ownerType: input.ownerType, ownerId: input.ownerId, memoryType: input.memoryType, subject: input.subject, content: input.content,
    status: input.status, confidence: input.confidence, canonicalKind: value.canonicalKind ?? null, canonicalGroupId: value.canonicalGroupId ?? null,
    evidenceRefs: input.evidenceRefs, tags: input.tags ?? [], metadata: input.metadata ?? {}, expiresAt: null,
    supersedes: input.supersedes ?? [], createdAt: new Date(input.createdAt), updatedAt: new Date(input.updatedAt) };
}
const dialect = new PgDialect();
function fixture(initial: BrainMemoryRow | null = materialized(memory)) {
  const state = { row: initial ? structuredClone(initial) : null, committed: initial ? structuredClone(initial) : null,
    reviews: [] as Array<Record<string, unknown>>, committedReviews: [] as Array<Record<string, unknown>>, order: [] as string[] };
  class Select {
    condition: SQL | undefined;
    from(table: unknown) { expect(table).toBe(brainMemories); return this; }
    where(condition: SQL) { this.condition = condition; return this; }
    rows() {
      if (!state.row || !this.condition) return [];
      const query = dialect.sqlToQuery(this.condition);
      if (query.sql.includes("->> 'revision'")) return ["revision", "revisionRetired", "updateProposal", "documentProgramUpdate"]
        .some(key => state.row?.metadata[key] != null) ? [{ id: state.row.id }] : [];
      return query.params[0] === state.row.userId && query.params[1] === state.row.id ? [structuredClone(state.row)] : [];
    }
    async for(mode: string) { state.order.push(`row:${mode}`); return this.rows(); }
    async limit(_count: number) { return this.rows(); }
  }
  const insert = (table: unknown) => ({ values: (input: Record<string, unknown>) => {
    let patch: Record<string, unknown> | undefined;
    const builder = {
      onConflictDoUpdate(config: { set: Record<string, unknown>; setWhere: SQL }) { patch = config.set; return builder; },
      async returning() {
        if (table === brainMemoryReviews) { const saved = { ...input, id: "review-a", createdAt: new Date() }; state.reviews.push(saved); return [saved]; }
        expect(table).toBe(brainMemories);
        if (state.row) {
          if (!patch) throw new Error("duplicate memory");
          if (["userId", "scopeType", "scopeId", "ownerType", "ownerId"].some(key =>
            input[key] !== state.row?.[key as keyof BrainMemoryRow])) return [];
          state.row = { ...state.row, ...patch } as BrainMemoryRow;
        } else state.row = { ...materialized(memory), ...input } as BrainMemoryRow;
        state.order.push("memory-write"); return [structuredClone(state.row)];
      },
    };
    return builder;
  } });
  const store = { select: () => new Select(), insert,
    execute: async (statement: SQL) => { expect(dialect.sqlToQuery(statement).sql).toContain("pg_advisory_xact_lock"); state.order.push("canonical-lock"); return []; },
  } as DrizzleDB;
  mocks.store = store;
  mocks.commit = () => { state.committed = state.row ? structuredClone(state.row) : null; state.committedReviews = [...state.reviews]; };
  mocks.rollback = () => { state.row = state.committed ? structuredClone(state.committed) : null; state.reviews = [...state.committedReviews]; };
  mocks.changes.mockImplementation(async (value: DrizzleDB) => { expect(value).toBe(store); state.order.push("change-ledger"); return { id: "change-a", written: true }; });
  return { state, store };
}
beforeEach(() => { vi.clearAllMocks(); mocks.changes.mockReset(); });

describe("Memory legacy storage compatibility commands", () => {
  it("writes a source-version change and its deterministic ledger command in the same transaction", async () => {
    const f = fixture(), before = memoryFromRow(f.state.row!);
    const after = await upsertBrainMemory({ ...memory, content: "Detailed summaries", updatedAt: "2026-10-20T00:01:00Z" });
    expect(f.state.committed?.content).toBe("Detailed summaries");
    expect(mocks.changes).toHaveBeenCalledExactlyOnceWith(f.store, expect.objectContaining({ beforeMemory: before, afterMemory: after,
      commandId: `legacy-upsert:${after.id}:${getBrainMemoryRevisionVersion(after)}`, now: new Date(after.updatedAt) }));
    expect(f.state.order).toEqual(["canonical-lock", "row:update", "memory-write", "change-ledger"]);
  });

  it("does not manufacture a change when the full persisted version is unchanged", async () => {
    const f = fixture(), same = memoryFromRow(f.state.row!);
    await upsertBrainMemory(same);
    expect(mocks.changes).not.toHaveBeenCalled();
    expect(getBrainMemoryRevisionVersion(memoryFromRow(f.state.committed!))).toBe(getBrainMemoryRevisionVersion(same));
  });

  it("rolls back the source mutation when change-ledger persistence fails", async () => {
    const f = fixture(), failure = new Error("ledger unavailable");
    mocks.changes.mockRejectedValueOnce(failure);
    await expect(upsertBrainMemory({ ...memory, content: "Uncommitted replacement" })).rejects.toBe(failure);
    expect(f.state.row?.content).toBe(memory.content); expect(f.state.committed?.content).toBe(memory.content);
  });

  it.each(["revision", "revisionRetired", "updateProposal", "documentProgramUpdate"])("preserves %s protection and the legacy error constructor", async field => {
    const f = fixture(materialized({ ...memory, metadata: { [field]: {} } }));
    await expect(upsertBrainMemory({ ...memory, content: "Must not replace versioned source" })).rejects.toBeInstanceOf(BrainMemoryRevisionProtected);
    expect(BrainMemoryRevisionProtected).toBe(MemoryRevisionProtected);
    expect(f.state.committed?.content).toBe(memory.content); expect(mocks.changes).not.toHaveBeenCalled();
  });

  it.each([{ userId: "33333333-3333-4333-a333-333333333333" }, { ownerId: "other-owner" },
    { scope: { type: "work" as const, workId: "other-work" } }])("rejects a changed source identity: %j", async override => {
    const f = fixture();
    await expect(upsertBrainMemory({ ...memory, ...override, content: "Foreign replacement" })).rejects.toBeInstanceOf(MemoryIdentityConflict);
    expect(f.state.committed?.content).toBe(memory.content); expect(mocks.changes).not.toHaveBeenCalled();
  });

  it("keeps first insert and review append separate from source changes", async () => {
    const f = fixture(null);
    await insertBrainMemory(memory);
    const version = getBrainMemoryRevisionVersion(memoryFromRow(f.state.committed!));
    await insertBrainMemoryReview({ userId, memoryId, reviewerType: "chat", reviewerId: userId, decision: "confirmed",
      evidenceRefs: ["event-a"], reason: "Owner note" });
    expect(f.state.committedReviews).toHaveLength(1);
    expect(getBrainMemoryRevisionVersion(memoryFromRow(f.state.committed!))).toBe(version);
    expect(mocks.changes).not.toHaveBeenCalled();
  });
});
