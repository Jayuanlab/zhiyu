import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DrizzleDB } from "@/lib/db/types";
import type { BrainMemoryRow } from "@/lib/db/schema";
import type { MemoryDependencySnapshot } from "@/lib/memory/revision/dependency-check";

const mocks = vi.hoisted(() => ({ store: null as DrizzleDB | null, transaction: vi.fn(), select: vi.fn(), insert: vi.fn(),
  dependencies: vi.fn(), commit: null as (() => void) | null, rollback: null as (() => void) | null }));
vi.mock("@/lib/db/client", () => ({ db: {
  select: mocks.select, insert: mocks.insert,
  async transaction<T>(write: (store: DrizzleDB) => Promise<T>): Promise<T> {
    mocks.transaction();
    if (!mocks.store) throw new Error("Fixture not initialized");
    try { const result = await write(mocks.store); mocks.commit?.(); return result; }
    catch (error) { mocks.rollback?.(); throw error; }
  },
} }));
vi.mock("@/lib/memory/revision/dependency-check", () => ({ getMemoryDependenciesInTransaction: mocks.dependencies }));

import { brainMemories, user } from "@/lib/db/schema";
import { memoryStateReadReceipts } from "@/lib/db/schema.pg";
import { createOwnerMemoryClient } from "@/lib/memory/client";
import { readOwnerRevisionState } from "@/lib/memory/revision/owner-read";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { memoryFromRow } from "@/lib/memory/records/memory-record";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

const owner = "11111111-1111-4111-a111-111111111111";
const foreign = "22222222-2222-4222-a222-222222222222";
const id = (index: number) => `33333333-3333-4333-a333-${String(index).padStart(12, "0")}`;
const now = new Date("2026-10-20T00:00:00Z");
function row(index = 0, overrides: Partial<BrainMemoryRow> = {}): BrainMemoryRow {
  return { id: id(index), userId: owner, scopeType: "global", scopeId: null, ownerType: "chat", ownerId: owner,
    memoryType: "preference", subject: "Summary style", content: `owner-content-${index}`, status: "active", confidence: 80,
    canonicalKind: "preference", canonicalGroupId: "canonical-a", evidenceRefs: ["event-a"], tags: [], metadata: {},
    expiresAt: null, supersedes: [], createdAt: now, updatedAt: now, ...overrides };
}
const dialect = new PgDialect();

function fixture() {
  const state = { principal: true, active: false, receiptFailure: false, rows: new Map<string, BrainMemoryRow>(),
    receipts: [] as Array<Record<string, unknown>>, committed: [] as Array<Record<string, unknown>>,
    locks: [] as Array<{ table: unknown; mode: string; params: unknown[] }> };
  class Select {
    table: unknown; condition: SQL | undefined;
    from(table: unknown) { this.table = table; return this; }
    where(condition: SQL) { this.condition = condition; return this; }
    results() {
      const params = this.condition ? dialect.sqlToQuery(this.condition).params : [];
      if (this.table === user) return state.principal && params[0] === owner ? [{ id: owner }] : [];
      if (this.table === brainMemories) {
        const saved = state.rows.get(String(params[1]));
        return saved && saved.userId === params[0] ? [saved] : [];
      }
      if (this.table === memoryStateReadReceipts) return state.receipts.filter(receipt => receipt.userId === params[0] && receipt.id === params[1]);
      return [];
    }
    async for(mode: string) {
      expect(state.active).toBe(true);
      state.locks.push({ table: this.table, mode, params: this.condition ? dialect.sqlToQuery(this.condition).params : [] });
      return this.results();
    }
    async limit(_count: number) { return this.results(); }
  }
  const select = () => new Select();
  const insert = (table: unknown) => ({ values: (input: Record<string, unknown>) => ({ returning: async () => {
    expect(table).toBe(memoryStateReadReceipts); expect(state.active).toBe(true);
    if (state.receiptFailure) throw new Error("receipt storage failure");
    const receipt = { ...input, createdAt: now }; state.receipts.push(receipt); return [receipt];
  } }) });
  const store = { select, insert } as DrizzleDB;
  mocks.store = store; mocks.select.mockImplementation(select); mocks.insert.mockImplementation(insert);
  mocks.transaction.mockImplementation(() => { state.active = true; });
  mocks.commit = () => { state.committed = [...state.receipts]; state.active = false; };
  mocks.rollback = () => { state.receipts = [...state.committed]; state.active = false; };
  return { state, store };
}
function dependencies(overrides: Partial<MemoryDependencySnapshot> = {}): MemoryDependencySnapshot {
  return { entity: { kind: "interaction_task", id: id(20), title: "Task", content: "domain body", contentTruncated: false,
    status: "confirmed", version: `bmde1:${"a".repeat(64)}`, workId: null }, coverage: "unknown", dependencyVersion: "bmdd1:initial",
    registry: null, assessment: "unknown", reasons: ["dependency_coverage_unknown"], sources: [], ...overrides };
}

beforeEach(() => { vi.clearAllMocks(); mocks.dependencies.mockReset(); });

describe("owner Memory current revision entry", () => {
  it("follows a retired logical root, holds owner/row SHARE locks through receipt commit, and explains that receipt", async () => {
    const f = fixture();
    f.state.rows.set(id(0), row(0, { status: "superseded", metadata: { revisionRetired: { nextMemoryId: id(1) } } }));
    f.state.rows.set(id(1), row(1));
    const client = createOwnerMemoryClient(owner);
    const result = await client.read({ purpose: "current", ref: { kind: "memory", id: id(0).toUpperCase() } });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !("record" in result) || !("revisionVersion" in result.record)) throw new Error("Expected memory record");
    const version = getBrainMemoryRevisionVersion(memoryFromRow(row(1)));
    expect(result.record.id).toBe(id(1)); expect(result.record.revisionVersion).toBe(version);
    expect(result.ref).toEqual({ record: { kind: "memory", id: id(0) }, revision: version });
    expect(result.meta).toMatchObject({ contractVersion: "memory-revision.v1", implementationVersion: "memory-t3.v1", provider: "postgres" });
    expect(f.state.locks).toEqual([{ table: user, mode: "share", params: [owner] },
      { table: brainMemories, mode: "share", params: [owner, id(0)] }, { table: brainMemories, mode: "share", params: [owner, id(1)] }]);
    expect(f.state.committed).toHaveLength(1); expect(f.state.active).toBe(false);
    expect(f.state.committed[0]).toMatchObject({ target: { kind: "memory", id: id(0) }, revision: version, locator: { id: id(1), rootId: id(0) } });
    expect(await client.explain({ receiptId: result.receipt.id })).toMatchObject({ status: "ok", type: "state_read", historical: true,
      receipt: { ref: result.ref, locator: { id: id(1), rootId: id(0) } } });
  });

  it("versions the complete returned memory rather than trusting caller or metadata versions", async () => {
    const f = fixture(); f.state.rows.set(id(0), row());
    const first = await readOwnerRevisionState(owner, { kind: "memory", id: id(0) });
    f.state.rows.set(id(0), row(0, { content: "changed body", metadata: { revisionVersion: "forged" } }));
    const second = await readOwnerRevisionState(owner, { kind: "memory", id: id(0) });
    if (first.status !== "ok" || second.status !== "ok") throw new Error("Expected current records");
    expect(second.ref.revision).not.toBe(first.ref.revision); expect(second.ref.revision).toMatch(/^bmrv1:[a-f0-9]{64}$/);
  });

  it.each(["missing", "foreign", "scope", "owner", "canonical", "cycle", "malformed", "expired"])("withholds all bodies for an unavailable %s history", async mode => {
    const f = fixture();
    f.state.rows.set(id(0), row(0, { status: "superseded", metadata: { revisionRetired: { nextMemoryId: id(1) } } }));
    const successor = row(1);
    if (mode === "foreign") successor.userId = foreign;
    if (mode === "scope") { successor.scopeType = "work"; successor.scopeId = "work-b"; }
    if (mode === "owner") successor.ownerId = "different-owner";
    if (mode === "canonical") successor.canonicalGroupId = "different-group";
    if (mode === "cycle") { successor.status = "superseded"; successor.metadata = { revisionRetired: { nextMemoryId: id(0) } }; }
    if (mode === "malformed") { successor.status = "superseded"; successor.metadata = { revisionRetired: { nextMemoryId: "invalid" } }; }
    if (mode === "expired") successor.expiresAt = new Date("2020-01-01T00:00:00Z");
    if (mode !== "missing") f.state.rows.set(id(1), successor);
    const result = await createOwnerMemoryClient(owner).read({ purpose: "current", ref: { kind: "memory", id: id(0) } });
    expect(result.status).toBe("unavailable"); expect(result).not.toHaveProperty("record");
    expect(JSON.stringify(result)).not.toContain("owner-content"); expect(f.state.committed).toEqual([]);
  });

  it("allows eight replacement hops but rejects a ninth without presenting a partial current record", async () => {
    const f = fixture();
    for (let index = 0; index <= 8; index++) f.state.rows.set(id(index), row(index, index === 8 ? {} : {
      status: "superseded", metadata: { revisionRetired: { nextMemoryId: id(index + 1) } } }));
    const allowed = await readOwnerRevisionState(owner, { kind: "memory", id: id(0) });
    expect(allowed).toMatchObject({ status: "ok", record: { id: id(8) } });
    f.state.rows.set(id(8), row(8, { status: "superseded", metadata: { revisionRetired: { nextMemoryId: id(9) } } }));
    f.state.rows.set(id(9), row(9));
    const blocked = await readOwnerRevisionState(owner, { kind: "memory", id: id(0) });
    expect(blocked).toMatchObject({ status: "unavailable", code: "memory_history_unavailable" });
    expect(blocked).not.toHaveProperty("record");
  });

  it("keeps an unreviewed candidate visible with explicit semantics instead of treating it as verified", async () => {
    const f = fixture(); f.state.rows.set(id(0), row(0, { status: "candidate" }));
    const result = await readOwnerRevisionState(owner, { kind: "memory", id: id(0) });
    expect(result).toMatchObject({ status: "ok", record: { status: "candidate" } });
    expect(result.meta.warnings.join(" ")).toContain("not an effective verified fact");
  });

  it("reads dependencies in the receipt transaction and preserves unknown coverage without verification", async () => {
    const f = fixture();
    mocks.dependencies.mockImplementation(async (store: DrizzleDB) => { expect(store).toBe(f.store); expect(f.state.active).toBe(true); return dependencies(); });
    const result = await createOwnerMemoryClient(owner).read({ purpose: "current", ref: { kind: "memory_dependencies", entityKind: "interaction_task", entityId: id(20) } });
    expect(result).toMatchObject({ status: "ok", record: { id: `interaction_task:${id(20)}`, coverage: "unknown", assessment: "unknown", verified: false } });
    expect(mocks.transaction).toHaveBeenCalledOnce(); expect(f.state.committed).toHaveLength(1);
    expect(result.meta.warnings.join(" ")).toContain("unknown");
  });

  it("redacts entity, registry and all source bodies when denial wins", async () => {
    const f = fixture(), body = { ...memoryFromRow(row()), revisionVersion: `bmrv1:${"b".repeat(64)}` };
    mocks.dependencies.mockResolvedValue(dependencies({ coverage: "recorded", assessment: "denied",
      registry: { snapshotId: id(30), sequence: 1, createdAt: now.toISOString(), reason: "SECRET_REGISTRY_BODY" },
      entity: { ...dependencies().entity, title: "SECRET_ENTITY_TITLE", content: "SECRET_ENTITY_BODY" },
      sources: [{ memoryId: id(0), expectedVersion: body.revisionVersion, assessment: "denied", reason: "source_unavailable_or_denied", oldMemory: body, currentMemory: body },
        { memoryId: id(1), expectedVersion: body.revisionVersion, assessment: "current", reason: "source_current", oldMemory: body, currentMemory: body }] }));
    const result = await readOwnerRevisionState(owner, { kind: "memory_dependencies", entityKind: "interaction_task", entityId: id(20) });
    expect(result).toMatchObject({ status: "ok", record: { assessment: "denied", verified: false, entity: { title: "", content: "" }, registry: { reason: "" } } });
    expect(JSON.stringify(result)).not.toContain("SECRET"); expect(JSON.stringify(result)).not.toContain("owner-content");
    expect(f.state.committed).toHaveLength(1);
  });

  it("changes dependency read tokens when returned entity state changes even with the same registry version", async () => {
    fixture(); mocks.dependencies.mockResolvedValue(dependencies());
    const first = await readOwnerRevisionState(owner, { kind: "memory_dependencies", entityKind: "interaction_task", entityId: id(20) });
    mocks.dependencies.mockResolvedValue(dependencies({ entity: { ...dependencies().entity, content: "changed domain body" } }));
    const second = await readOwnerRevisionState(owner, { kind: "memory_dependencies", entityKind: "interaction_task", entityId: id(20) });
    if (first.status !== "ok" || second.status !== "ok") throw new Error("Expected dependency records");
    expect(first.ref.revision).toMatch(/^mdeprv1:[a-f0-9]{64}$/); expect(second.ref.revision).not.toBe(first.ref.revision);
  });

  it("rolls back read receipts on storage failure and denies deleted principals before reading", async () => {
    const f = fixture(); f.state.rows.set(id(0), row()); f.state.receiptFailure = true;
    await expect(readOwnerRevisionState(owner, { kind: "memory", id: id(0) })).rejects.toThrow("receipt storage failure");
    expect(f.state.committed).toEqual([]);
    f.state.principal = false;
    await expect(readOwnerRevisionState(owner, { kind: "memory", id: id(0) })).rejects.toMatchObject({ code: "memory_access_denied", status: 403 });
  });

  it.each([{ kind: "memory", id: "invalid" }, { kind: "memory", id: id(0), ownerId: foreign },
    { kind: "memory", id: id(0), expectedVersion: "forged" }, { kind: "memory_dependencies", entityKind: "project", entityId: id(20) },
    { kind: "memory_dependencies", entityKind: ["loop"], entityId: id(20) },
    { kind: "memory_dependencies", entityKind: "loop", entityId: id(20), limit: 100 },
    { kind: "memory_dependencies", entityKind: "loop", entityId: "a".repeat(1000) }])("rejects strict reference fields before storage: %j", async ref => {
    fixture();
    await expect(createOwnerMemoryClient(owner).read({ purpose: "current", ref })).rejects.toBeInstanceOf(MemoryModuleError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a Work capability before dispatching either new current reader", async () => {
    fixture();
    const lease = { userId: owner, workshopId: foreign, runId: id(40), workerId: "worker-a", token: 1 };
    for (const ref of [{ kind: "memory", id: id(0) }, { kind: "memory_dependencies", entityKind: "loop", entityId: id(20) }]) {
      await expect(withExecutionContext(lease, () => createOwnerMemoryClient(owner).read({ purpose: "current", ref })))
        .rejects.toMatchObject({ code: "memory_owner_context_required", status: 403 });
    }
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.dependencies).not.toHaveBeenCalled();
  });
});
