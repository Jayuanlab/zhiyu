import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DrizzleDB } from "@/lib/db/types";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import type { AppendWorkshopEventInput } from "@/lib/workshops/types";
import type { WorkshopEvent } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";

type Append = (event: AppendWorkshopEventInput) => Promise<WorkshopEvent>;
const mocks = vi.hoisted(() => ({
  store: null as DrizzleDB | null, append: null as Append | null,
  transactions: vi.fn(), workshopTransactions: vi.fn(), dependencies: vi.fn(),
  commit: null as (() => void) | null, rollback: null as (() => void) | null,
}));
vi.mock("@/lib/db/client", () => ({ db: {
  async transaction<T>(write: (store: DrizzleDB) => Promise<T>): Promise<T> {
    mocks.transactions();
    if (!mocks.store) throw new Error("Fixture store not initialized");
    try { const result = await write(mocks.store); mocks.commit?.(); return result; }
    catch (error) { mocks.rollback?.(); throw error; }
  },
} }));
vi.mock("@/lib/workshops/event-write", () => ({
  async withWorkshopEventTransaction<T>(write: (store: DrizzleDB, append: Append) => Promise<T>): Promise<T> {
    mocks.workshopTransactions();
    if (!mocks.store || !mocks.append) throw new Error("Fixture transaction not initialized");
    try { const result = await write(mocks.store, mocks.append); mocks.commit?.(); return result; }
    catch (error) { mocks.rollback?.(); throw error; }
  },
}));
vi.mock("@/lib/memory/revision/dependency-check", () => ({ assertMemoryDependenciesCurrentInTransaction: mocks.dependencies }));

import {
  withMemoryTransaction, withMemoryRecordWrite, withMemoryWrite, rethrowMemoryWriteError, MemoryIdentityConflict,
} from "@/lib/memory/revision/transaction";
import * as legacy from "@/lib/brain/write-guard";
import { MemoryWriteBusy } from "@/lib/memory/kernel/reference-errors";
import { BrainMemoryWriteBusy } from "@/lib/brain/write-errors";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import { withExecutionWriteContext } from "@/lib/work-runtime/execution-write-context";
import { ExecutionLeaseError } from "@/lib/work-runtime/execution-errors";

const lease = { userId: "11111111-1111-4111-a111-111111111111", workshopId: "22222222-2222-4222-a222-222222222222",
  runId: "33333333-3333-4333-a333-333333333333", workerId: "worker-a", token: 4 };
const loopId = "44444444-4444-4444-a444-444444444444";
const memory: BrainMemory = { id: "55555555-5555-4555-a555-555555555555", userId: lease.userId,
  scope: { type: "work", workId: lease.workshopId }, ownerType: "work", ownerId: lease.workshopId,
  memoryType: "boundary", subject: "Boundary", content: "Use approved sources.", status: "active", confidence: 90,
  evidenceRefs: ["source-1"], createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" };
const dialect = new PgDialect();

function fixture() {
  const state = { linked: true, expired: false, validAtEnd: true, runStatus: "running", token: lease.token,
    pending: [] as string[], committed: [] as string[], events: [] as AppendWorkshopEventInput[],
    committedEvents: [] as AppendWorkshopEventInput[], queries: [] as string[] };
  const execute = vi.fn(async (statement: SQL): Promise<Record<string, unknown>[]> => {
    const query = dialect.sqlToQuery(statement).sql;
    state.queries.push(query);
    if (query.includes("FROM workshops ")) return [{ status: "active" }];
    if (query.includes("FROM workshop_execution_leases ")) return [{ token: state.token, run_id: lease.runId,
      worker_id: lease.workerId, phase: "running", expired: state.expired, lease_until: new Date("2099-01-01T00:00:00Z") }];
    if (query.includes("FROM workshop_runs ")) return [{ status: state.runStatus }];
    if (query.includes("FROM workshop_loop_executions ")) return state.linked ? [{ loop_id: loopId }] : [];
    if (query.includes(" AS valid")) return [{ valid: state.validAtEnd }];
    if (query.includes("INSERT INTO fixture_memory")) { state.pending.push("written"); return []; }
    throw new Error(`Unexpected fixture SQL: ${query}`);
  });
  const unexpected = (): never => { throw new Error("Unexpected fixture database operation"); };
  const store: DrizzleDB = { ...schema, execute, select: unexpected, insert: unexpected, update: unexpected, delete: unexpected,
    transaction: async <T>(): Promise<T> => unexpected(), query: { findMany: unexpected, findFirst: unexpected } };
  const append: Append = vi.fn(async event => {
    state.events.push(event);
    return { id: "66666666-6666-4666-a666-666666666666", workshopId: event.workshopId,
      runId: event.runId ?? null, loopId: event.loopId ?? null, loopRunId: event.loopRunId ?? null,
      seq: state.events.length, type: event.type, title: event.title, body: event.body ?? null,
      metadata: event.metadata ?? {}, visibility: event.visibility ?? "user", createdAt: new Date() };
  });
  mocks.store = store; mocks.append = append;
  mocks.commit = () => { state.committed = [...state.pending]; state.committedEvents = [...state.events]; };
  mocks.rollback = () => { state.pending = [...state.committed]; state.events = [...state.committedEvents]; };
  return { state, store, append };
}

beforeEach(() => { vi.clearAllMocks(); mocks.dependencies.mockResolvedValue(undefined); });

describe("Memory revision transaction ownership and business fence", () => {
  it("keeps old entry functions and identity errors as exact aliases", () => {
    expect(legacy.withBrainMemoryTransaction).toBe(withMemoryTransaction);
    expect(legacy.withBrainMemoryWrite).toBe(withMemoryWrite);
    expect(legacy.withBrainRecordWrite).toBe(withMemoryRecordWrite);
    expect(legacy.rethrowBrainMemoryWriteError).toBe(rethrowMemoryWriteError);
    expect(legacy.BrainMemoryIdentityConflict).toBe(MemoryIdentityConflict);
  });

  it("uses a plain transaction outside an execution capability", async () => {
    const f = fixture();
    expect(await withMemoryWrite(memory, async store => {
      expect(store).toBe(f.store); await store.execute(sql`INSERT INTO fixture_memory`); return "saved";
    })).toBe("saved");
    expect(mocks.transactions).toHaveBeenCalledOnce();
    expect(mocks.workshopTransactions).not.toHaveBeenCalled();
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(f.state.committed).toEqual(["written"]);
    expect(f.state.events).toEqual([]);
  });

  it("checks the linked Loop before writing and commits its actual execution audit together", async () => {
    const f = fixture();
    const write = vi.fn(async (store: DrizzleDB) => {
      expect(mocks.dependencies).toHaveBeenCalledWith(f.store, { userId: lease.userId, entityKind: "loop", entityId: loopId });
      await store.execute(sql`INSERT INTO fixture_memory`); return { memory, result: "saved" };
    });
    expect(await withExecutionContext(lease, () => withMemoryTransaction(lease.userId, write))).toBe("saved");
    expect(mocks.workshopTransactions).toHaveBeenCalledOnce();
    expect(f.state.committed).toEqual(["written"]);
    expect(f.state.committedEvents).toEqual([expect.objectContaining({ type: "brain_memory_written",
      workshopId: lease.workshopId, runId: lease.runId, metadata: expect.objectContaining({ actorId: lease.userId,
        memoryId: memory.id, execution: { workerId: lease.workerId, token: lease.token } }) })]);
    expect(f.state.queries.at(-1)).toContain("clock_timestamp()");
  });

  it("does not invent a dependency target for an unlinked Work run", async () => {
    const f = fixture(); f.state.linked = false;
    await withExecutionContext(lease, () => withMemoryTransaction(lease.userId, async () => ({ memory, result: null })));
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(f.state.committedEvents).toHaveLength(1);
  });

  it("rejects stale dependencies before the database callback", async () => {
    const f = fixture(), error = new Error("memory_dependency_stale"), write = vi.fn();
    mocks.dependencies.mockRejectedValueOnce(error);
    await expect(withExecutionContext(lease, () => withMemoryTransaction(lease.userId, write))).rejects.toBe(error);
    expect(write).not.toHaveBeenCalled();
    expect(f.state.committed).toEqual([]); expect(f.state.committedEvents).toEqual([]);
  });

  it.each(["expired", "stale_token", "finished_run"])("rejects a %s lease before dependency checks or writes", async mode => {
    const f = fixture(), write = vi.fn();
    if (mode === "expired") f.state.expired = true;
    if (mode === "stale_token") f.state.token++;
    if (mode === "finished_run") f.state.runStatus = "completed";
    await expect(withExecutionContext(lease, () => withMemoryTransaction(lease.userId, write))).rejects.toMatchObject({ code: "lease_lost" });
    expect(write).not.toHaveBeenCalled(); expect(mocks.dependencies).not.toHaveBeenCalled();
  });

  it("rolls back state and event if the database lease expires during the callback", async () => {
    const f = fixture(); f.state.validAtEnd = false;
    await expect(withExecutionContext(lease, () => withMemoryTransaction(lease.userId, async store => {
      await store.execute(sql`INSERT INTO fixture_memory`); return { memory, result: "saved" };
    }))).rejects.toBeInstanceOf(ExecutionLeaseError);
    expect(f.state.committed).toEqual([]); expect(f.state.committedEvents).toEqual([]);
  });

  it("rejects a different owner before opening a transaction, or returned foreign state before commit", async () => {
    const f = fixture(), write = vi.fn();
    await expect(withExecutionContext(lease, () => withMemoryTransaction("foreign-owner", write))).rejects.toMatchObject({ code: "invalid_lease" });
    expect(mocks.workshopTransactions).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    await expect(withExecutionContext(lease, () => withMemoryTransaction(lease.userId, async store => {
      await store.execute(sql`INSERT INTO fixture_memory`); return { memory: { ...memory, userId: "foreign-owner" }, result: null };
    }))).rejects.toMatchObject({ code: "invalid_lease" });
    expect(f.state.committed).toEqual([]); expect(f.state.committedEvents).toEqual([]);
  });

  it.each(["observation", "context_log", "review"] as const)("keeps %s recording available when business dependencies are stale", async kind => {
    const f = fixture(); mocks.dependencies.mockRejectedValue(new Error("memory_dependency_stale"));
    await withExecutionContext(lease, () => withMemoryRecordWrite(lease.userId, kind, async store => {
      await store.execute(sql`INSERT INTO fixture_memory`); return { id: "record-1", result: null };
    }));
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(f.state.queries.some(query => query.includes("workshop_loop_executions"))).toBe(false);
    expect(f.state.committedEvents[0]).toMatchObject({ type: "brain_record_written", metadata: { recordType: kind, recordId: "record-1" } });
  });

  it("checks snapshot dependencies but emits no duplicate event for an unchanged replay", async () => {
    const f = fixture();
    await withExecutionContext(lease, () => withMemoryRecordWrite(lease.userId, "snapshot", async () => ({ id: "record-1", result: null, written: false })));
    expect(mocks.dependencies).toHaveBeenCalledOnce(); expect(f.state.committedEvents).toEqual([]);
    await withExecutionContext(lease, () => withMemoryTransaction(lease.userId, async () => ({ memory, result: null, written: false })));
    expect(f.state.committedEvents).toEqual([]);
  });

  it("reuses the active host transaction while rechecking its fence and dependencies", async () => {
    const f = fixture();
    await withExecutionWriteContext(lease, { db: f.store, append: f.append }, () =>
      withMemoryTransaction(lease.userId, async store => { expect(store).toBe(f.store); return { memory, result: null }; }));
    expect(mocks.transactions).not.toHaveBeenCalled(); expect(mocks.workshopTransactions).not.toHaveBeenCalled();
    expect(mocks.dependencies).toHaveBeenCalledOnce(); expect(f.state.events).toHaveLength(1);
    expect(f.state.queries.at(-1)).toContain("clock_timestamp()");
  });

  it("preserves wrapped lock failure classification and legacy constructor identity", async () => {
    fixture();
    const error = { cause: { cause: { code: "55P03" } } };
    const failure = await withExecutionContext(lease, () => withMemoryTransaction(lease.userId, async () => { throw error; })).catch(value => value);
    expect(failure).toBeInstanceOf(MemoryWriteBusy); expect(failure).toBeInstanceOf(BrainMemoryWriteBusy);
    expect(() => rethrowMemoryWriteError(error)).toThrowError();
  });
});
