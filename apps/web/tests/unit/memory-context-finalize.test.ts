import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import type { BrainMemoryRow, BrainAccessGrantRow } from "@/lib/db/schema";
import type { BrainMemory, BrainRequester } from "@/lib/memory/kernel/memory-types";

const mocks = vi.hoisted(() => ({ store: null as DrizzleDB | null, transactions: vi.fn(),
  commit: null as (() => void) | null, rollback: null as (() => void) | null }));
vi.mock("@/lib/db/client", () => ({ db: {
  async transaction<T>(write: (store: DrizzleDB) => Promise<T>): Promise<T> {
    mocks.transactions(); if (!mocks.store) throw new Error("Fixture unavailable");
    try { const result = await write(mocks.store); mocks.commit?.(); return result; }
    catch (error) { mocks.rollback?.(); throw error; }
  },
} }));

import { brainMemories, brainAccessGrants, brainContextLogs, user } from "@/lib/db/schema";
import { buildBrainContextPack, type BrainContextPack } from "@/lib/memory/context/pack";
import { finalizeContextPack } from "@/lib/memory/context/finalize";
import { memoryToInsertRow, memoryFromRow } from "@/lib/memory/records/memory-record";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

const owner = "11111111-1111-4111-a111-111111111111", workId = "22222222-2222-4222-a222-222222222222";
const id = (n: number) => `33333333-3333-4333-a333-${String(n).padStart(12, "0")}`;
const requester: BrainRequester = { type: "work", userId: owner, id: workId, workshopId: workId };
const now = new Date("2026-10-20T00:00:00Z"), dialect = new PgDialect();
function memory(n = 1, patch: Partial<BrainMemory> = {}): BrainMemory {
  return { id: id(n), userId: owner, scope: { type: "work", workId }, ownerType: "work", ownerId: workId,
    memoryType: "preference", subject: `Summary style ${n}`, content: `Use concise summaries ${n}. 😀 Original trailing content.`,
    status: "active", confidence: 80, evidenceRefs: [`source-${n}`], createdAt: now.toISOString(), updatedAt: now.toISOString(),
    metadata: { canonicalKind: "preference", canonicalGroupId: `canonical-${n}`, facets: { scenarioKeys: ["project:alpha"] } }, ...patch };
}
function row(value: BrainMemory): BrainMemoryRow {
  return { ...memoryToInsertRow(value), id: value.id, userId: value.userId, scopeType: value.scope.type,
    scopeId: value.scope.type === "work" ? value.scope.workId : null, ownerType: value.ownerType, ownerId: value.ownerId,
    memoryType: value.memoryType, subject: value.subject, content: value.content, status: value.status,
    confidence: value.confidence, evidenceRefs: value.evidenceRefs, tags: value.tags ?? [], metadata: value.metadata ?? {},
    canonicalKind: "preference", canonicalGroupId: `canonical-${value.id}`, expiresAt: value.expiresAt ? new Date(value.expiresAt) : null,
    supersedes: value.supersedes ?? [], createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) };
}
function fixture(memories = [memory()]) {
  const state = { active: false, rows: memories.map(row), grants: [] as BrainAccessGrantRow[],
    pending: [] as Array<{ metadata: Record<string, unknown> }>, logs: [] as Array<Record<string, unknown>>, committed: [] as Array<Record<string, unknown>>,
    locks: [] as Array<{ table: unknown; mode: string }>, failRead: false, failAudit: false,
    afterLock: null as ((table: unknown) => void) | null };
  class Select {
    table: unknown; condition: SQL | undefined; columns: unknown;
    constructor(columns: unknown) { this.columns = columns; }
    from(table: unknown) { this.table = table; return this; }
    where(condition: SQL) { this.condition = condition; return this; }
    orderBy() { return this; }
    async for(mode: string) {
      expect(state.active).toBe(true); state.locks.push({ table: this.table, mode });
      state.afterLock?.(this.table);
      if (state.failRead) throw new Error("private database detail");
      const params = this.condition ? dialect.sqlToQuery(this.condition).params : [];
      if (this.table === user) return [{ id: owner }];
      if (this.table === brainAccessGrants) return state.grants;
      if (this.table === brainMemories && this.columns) return state.pending;
      if (this.table === brainMemories) return state.rows.filter(saved => saved.userId === params[0] && params.slice(1).includes(saved.id));
      throw new Error("Unexpected fixture table");
    }
  }
  const store = { select: (columns?: unknown) => new Select(columns), insert: (table: unknown) => ({ values: (input: Record<string, unknown>) => ({ returning: async () => {
    expect(table).toBe(brainContextLogs); expect(state.active).toBe(true);
    if (state.failAudit) throw new Error("private audit failure");
    const log = { ...input, id: id(50 + state.logs.length), createdAt: now }; state.logs.push(log); return [log];
  } }) }) } as DrizzleDB;
  mocks.store = store; mocks.transactions.mockImplementation(() => { state.active = true; });
  mocks.commit = () => { state.committed = [...state.logs]; state.active = false; };
  mocks.rollback = () => { state.logs = [...state.committed]; state.active = false; };
  const pack = buildBrainContextPack({ memories: memories.map(value => memoryFromRow(row(value))), requester,
    taskIntent: "Summary style", sourceFilters: { scenarioKeys: ["project:alpha"] }, now });
  return { state, store, pack };
}
const finish = (pack: BrainContextPack, patch: Partial<Parameters<typeof finalizeContextPack>[0]> = {}) => finalizeContextPack({
  requester, pack, taskIntent: "Summary style", sourceFilters: { scenarioKeys: ["project:alpha"] }, now, ...patch,
});
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe("final ContextPack admission", () => {
  it("uses the clock after row and authority lock waits when checking expiry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const f = fixture([memory(1, { expiresAt: new Date(now.getTime() + 1000).toISOString() })]);
    f.state.afterLock = () => { vi.setSystemTime(now.getTime() + 2000); };
    const result = await finish(f.pack, { now: undefined });
    expect(result.items).toEqual([]);
    expect(result.denied).toContainEqual({ id: id(1), reason: "expired" });
  });

  it("holds current rows/grants through a new final audit and keeps legal Unicode prefix clipping", async () => {
    const f = fixture(), full = f.pack.items[0].content;
    const prefix = Array.from(full).slice(0, 28).join("");
    f.pack.items[0].content = prefix; f.pack.items[0].reasons.push("budget_truncated");
    const result = await finish(f.pack);
    expect(result.items[0].content).toBe(prefix); expect(result.items[0].content).not.toBe(full);
    expect(result.items[0].reasons).toContain("budget_truncated");
    expect(result.items[0].ref).toEqual({ record: { kind: "memory", id: id(1) }, revision: result.items[0].revisionVersion });
    expect(result.items[0].receipt).toEqual({ id: result.contextLogId });
    expect(f.state.locks).toEqual([{ table: user, mode: "share" }, { table: brainMemories, mode: "share" },
      { table: brainAccessGrants, mode: "share" }, { table: brainMemories, mode: "share" }]);
    expect(f.state.active).toBe(false); expect(f.state.committed).toHaveLength(1);
    expect(f.state.committed[0]).toMatchObject({ selectedMemoryIds: [id(1)], metadata: {
      selectedMemoryVersions: [{ memoryId: id(1), revisionVersion: result.items[0].revisionVersion }] } });
    expect(JSON.stringify(f.state.committed)).not.toContain(full);
  });

  it("audits the actual union of two attempts while discarding every attempt extension", async () => {
    const f = fixture([memory(1), memory(2)]);
    const result = await finish({ ...f.pack, contextLogId: "attempt-second", routeResults: [{ content: "PRIVATE_ATTEMPT_BODY" }],
      recallPlan: { arbitrary: "PRIVATE_PLAN" } } as BrainContextPack);
    expect(result.items.map(item => item.id)).toEqual(f.pack.items.map(item => item.id));
    expect(result.contextLogId).not.toBe("attempt-second"); expect(result).not.toHaveProperty("routeResults"); expect(result).not.toHaveProperty("recallPlan");
    expect(f.state.committed[0]).toMatchObject({ selectedMemoryIds: result.items.map(item => item.id), metadata: {
      selectedMemoryVersions: result.items.map(item => ({ memoryId: item.id, revisionVersion: item.revisionVersion })),
      admission: { previousContextLogId: "attempt-second" } } });
  });

  it.each(["body", "metadata", "deleted", "superseded", "expired", "foreign", "missing"])("removes a %s source without returning stale bodies", async mode => {
    const f = fixture();
    if (mode === "body") f.state.rows[0].content = "changed body with unchanged timestamp";
    if (mode === "metadata") f.state.rows[0].metadata = { changed: true };
    if (mode === "deleted" || mode === "superseded") f.state.rows[0].status = mode;
    if (mode === "expired") f.state.rows[0].expiresAt = new Date("2000-01-01T00:00:00Z");
    if (mode === "foreign") f.state.rows[0].userId = id(90);
    if (mode === "missing") f.state.rows = [];
    f.pack.warnings = [{ code: "potential_state_conflict", memoryIds: [id(1)], message: "old source warning", requiresCurrentObservation: true }];
    const result = await finish(f.pack);
    expect(result.items).toEqual([]); expect(JSON.stringify(result)).not.toContain("Original trailing content");
    expect(result.warnings?.every(warning => warning.memoryIds.length === 0)).toBe(true);
    expect(f.state.committed[0]).toMatchObject({ selectedMemoryIds: [], metadata: { selectedMemoryVersions: [] } });
    if (mode === "deleted" || mode === "superseded") expect(result.omitted).toContainEqual({ id: id(1), reason: mode });
  });

  it("rechecks actual grants and never makes discovery bypass a Work's permissions", async () => {
    const source = memory(1, { scope: { type: "global" }, ownerType: "chat", ownerId: owner });
    const f = fixture([source]);
    const grant = { id: id(80), userId: owner, subjectType: "work", subjectId: workId, scopeType: "global", scopeId: null,
      permissions: ["reference"], memoryTypes: ["preference"], expiresAt: null, reason: null, createdAt: now, updatedAt: now };
    f.pack = buildBrainContextPack({ memories: f.state.rows.map(memoryFromRow), requester,
      grants: [{ id: grant.id, userId: owner, subjectType: "work", subjectId: workId, scope: { type: "global" }, permissions: ["reference"] }],
      taskIntent: "Summary", sourceFilters: { scenarioKeys: ["project:alpha"] }, now });
    f.state.grants = [grant]; expect((await finish(f.pack)).items).toHaveLength(1);
    f.state.grants = [];
    const revoked = await finish(f.pack, { applicabilityMode: "discovery" });
    expect(revoked.items).toEqual([]); expect(revoked.denied).toContainEqual({ id: id(1), reason: "no_matching_grant" });
  });

  it("rechecks scenario binding and retains an authorized boundary only as an explicit scope-confirmation constraint", async () => {
    const f = fixture();
    expect((await finish(f.pack, { sourceFilters: { scenarioKeys: ["project:beta"] } })).items).toEqual([]);
    const boundary = memory(1, { memoryType: "boundary", metadata: { canonicalKind: "boundary", canonicalGroupId: "boundary-a", facets: { scenarioKeys: ["project:alpha"] } } });
    f.state.rows = [row(boundary)];
    const pack = buildBrainContextPack({ memories: f.state.rows.map(memoryFromRow), requester, taskIntent: "Respect constraints", sourceFilters: { scenarioKeys: ["project:alpha"] }, now });
    const retained = await finish(pack, { sourceFilters: undefined });
    expect(retained.items).toHaveLength(1); expect(retained.items[0].warnings).toContain("scenario_context_required");
    expect((await finish(pack, { sourceFilters: { scenarioKeys: ["project:beta"] } })).items).toEqual([]);
  });

  it.each(["forged_body", "forged_ref", "forged_evidence", "missing_token", "half_surrogate"])("rejects a %s projection despite an otherwise matching physical row", async mode => {
    const f = fixture(), item = f.pack.items[0];
    if (mode === "forged_body") item.content = "Made-up current fact";
    if (mode === "forged_ref") item.ref = { record: { kind: "memory", id: id(99) }, revision: item.revisionVersion! };
    if (mode === "forged_evidence") item.evidenceRefs.push("invented-source");
    if (mode === "missing_token") delete item.revisionVersion;
    if (mode === "half_surrogate") item.content = item.content.slice(0, item.content.indexOf("😀") + 1);
    expect((await finish(f.pack)).items).toEqual([]);
  });

  it("refreshes pending proposal warning without changing the persisted memory token", async () => {
    const f = fixture(), version = getBrainMemoryRevisionVersion(memoryFromRow(f.state.rows[0]));
    f.state.pending = [{ metadata: { updateProposal: { targetMemoryId: id(1), expectedBaseVersion: version } } }];
    const result = await finish(f.pack);
    expect(result.items[0].revisionVersion).toBe(version); expect(result.items[0].warnings).toContain("memory_update_pending");
  });

  it("never projects an unvalidated duplicate body through a later valid occurrence of its ID", async () => {
    const f = fixture(), valid = structuredClone(f.pack.items[0]);
    f.pack.items = [{ ...valid, content: "UNVALIDATED_DUPLICATE_BODY", revisionVersion: `bmrv1:${"f".repeat(64)}` }, valid];
    const result = await finish(f.pack);
    expect(result.items).toHaveLength(1); expect(result.items[0].content).toBe(valid.content);
    expect(JSON.stringify(result)).not.toContain("UNVALIDATED_DUPLICATE_BODY");
  });

  it("preserves a prior global source-gap warning across a second budget/outbound admission", async () => {
    const f = fixture([memory(1), memory(2)]); f.state.rows = [f.state.rows[0]];
    const first = await finish(f.pack);
    expect(first.warnings?.some(warning => warning.code === "evidence_unavailable" && warning.memoryIds.length === 0)).toBe(true);
    const second = await finish(first);
    expect(second.warnings?.some(warning => warning.code === "evidence_unavailable" && warning.memoryIds.length === 0)).toBe(true);
  });

  it.each(["read", "audit"])("fails closed on %s failure without successful admission or private error details", async mode => {
    const f = fixture(); if (mode === "read") f.state.failRead = true; else f.state.failAudit = true;
    const result = await finish(f.pack).catch(error => error);
    expect(result).toBeInstanceOf(MemoryModuleError); expect(result).toMatchObject({ code: "memory_context_unavailable", status: 503 });
    expect(result.message).not.toContain("private"); expect(f.state.committed).toEqual([]);
  });
});
