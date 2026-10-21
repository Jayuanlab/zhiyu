import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
type Row = Record<string, unknown>;
type Condition = { op: "eq"; key: string; value: unknown } | { op: "and"; values: Condition[] };
const ownerId = "00000000-0000-4000-a000-000000000001";
const memoryId = "00000000-0000-4000-a000-000000000002";
const f = vi.hoisted(() => ({ rows: {} as Record<string, Row[]>, writes: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: async () => ({ user: { id: "00000000-0000-4000-a000-000000000001" } }) }));
vi.mock("drizzle-orm", async original => ({ ...await original<typeof import("drizzle-orm")>(),
  eq: (column: { name: string }, value: unknown): Condition => ({ op: "eq", key: column.name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value }),
  and: (...values: Condition[]): Condition => ({ op: "and", values }),
}));
vi.mock("@/lib/db/client", () => {
  const matches = (row: Row, condition?: Condition): boolean => !condition || (condition.op === "and"
    ? condition.values.every(value => matches(row, value)) : row[condition.key] === condition.value);
  const store = {
    execute: async () => [],
    select: () => ({ from: (table: Record<symbol, string>) => {
      let condition: Condition | undefined;
      const read = () => (f.rows[table[Symbol.for("drizzle:Name")]] ?? []).filter(row => matches(row, condition));
      const query = { where: (value: Condition) => { condition = value; return query; }, for: async () => read(),
        limit: async (count: number) => read().slice(0, count),
        then: (resolve: (value: Row[]) => unknown) => Promise.resolve(read()).then(resolve) };
      return query;
    } }),
    insert: () => { f.writes(); throw new Error("Unavailable memory must not be written"); },
    update: () => { f.writes(); throw new Error("Unavailable memory must not be written"); },
  };
  return { db: { ...store, transaction: async <T>(work: (database: typeof store) => Promise<T>) => work(store) },
    withDatabaseTransaction: async <T>(work: () => Promise<T>) => work() };
});

// Both routes run actual owner/domain guards and the migrated review implementation.
import { POST as ownerCommand } from "@/app/api/memory/commands/route";
import { POST as legacyReview } from "@/app/api/brain/candidates/[id]/review/route";
beforeEach(() => { vi.clearAllMocks(); f.rows = { User: [{ id: ownerId }], brain_memories: [] }; });

describe("unavailable memory review HTTP semantics", () => {
  it.each(["missing", "foreign"])("returns the same safe 404 for %s memories through the new and legacy entry", async source => {
    if (source === "foreign") f.rows.brain_memories.push({ id: memoryId, userId: "00000000-0000-4000-a000-000000000099", content: "foreign-secret" });
    const body = { memoryId, expectedVersion: `bmrv1:${"a".repeat(64)}`, decision: "confirmed", reason: "Owner review", evidenceConfirmed: true };
    const request = (value: unknown) => new NextRequest("http://localhost/api/memory/commands", { method: "POST", body: JSON.stringify(value) });
    const response = await ownerCommand(request({ ...body, kind: "memory.review", commandId: `review-${source}` }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "memory_not_found", error: "Memory unavailable" });
    const legacyBody = { expectedVersion: body.expectedVersion, decision: body.decision, reason: body.reason, evidenceConfirmed: body.evidenceConfirmed };
    const legacy = await legacyReview(request(legacyBody), { params: Promise.resolve({ id: memoryId }) });
    expect(legacy.status).toBe(404);
    expect(await legacy.json()).toEqual({ code: "memory_not_found", error: "Memory unavailable" });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it("rejects body-supplied identity through the historical review route", async () => {
    const response = await legacyReview(new NextRequest("http://localhost/api/memory/candidates/ignored/review", {
      method: "POST", body: JSON.stringify({ memoryId, decision: "confirmed" }),
    }), { params: Promise.resolve({ id: memoryId }) });
    expect(response.status).toBe(400);
    expect(f.writes).not.toHaveBeenCalled();
  });
});
