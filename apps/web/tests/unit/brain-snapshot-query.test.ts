import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const capture = vi.hoisted(() => ({ where: vi.fn(), limit: vi.fn(async (): Promise<any[]> => []) }));
vi.mock("@/lib/db/client", () => ({ db: { select: () => ({ from: () => ({ where: (condition: unknown) => {
  capture.where(condition); return { orderBy: () => ({ limit: capture.limit }), groupBy: () => ({ orderBy: () => ({ limit: capture.limit }) }) };
} }) }) } }));
import { listBrainStateSnapshots, catalogBrainStateSnapshots } from "@/lib/brain/repository";

describe("snapshot database scope", () => {
  it("uses keyset predicates without rounding the database timestamp", async () => {
    await listBrainStateSnapshots({ userId: "u", workId: "w", contentQuery: "needle", pageAfter: { id: "id", time: "2026-01-01 00:00:00.123456+00" } });
    const query = new PgDialect().sqlToQuery(capture.where.mock.calls[0][0]);
    expect(query.sql).toContain('"created_at" <');
    expect(query.sql).toContain('"id" <');
    expect(query.params).toEqual(["u", "work", "workshop", "w", "2026-01-01 00:00:00.123456+00", "2026-01-01 00:00:00.123456+00", "id", "%needle%"]);
  });
  it("parameterizes and escapes literal content patterns without expanding scope", async () => {
    await listBrainStateSnapshots({ userId: "u", workId: "w", contentQuery: "50%_!'quote" });
    const query = new PgDialect().sqlToQuery(capture.where.mock.calls[0][0]);
    expect(query.sql).toContain('"content" as text');
    expect(query.sql).toContain("escape '!'");
    expect(query.sql).not.toContain("quote");
    expect(query.params).toEqual(["u", "work", "workshop", "w", "%50!%!_!!'quote%"]);
  });
  beforeEach(() => { vi.clearAllMocks(); capture.limit.mockResolvedValue([]); });
  it("aggregates only the authorized scope and explicitly marks type truncation", async () => {
    capture.limit.mockResolvedValue(Array.from({ length: 101 }, (_, i) => ({ snapshotType: `t${i}`, count: "3" })));
    const result = await catalogBrainStateSnapshots({ userId: "u", workId: "w", snapshotTypes: ["t"], recordedBefore: "2026-01-01T00:00:00Z" });
    const query = new PgDialect().sqlToQuery(capture.where.mock.calls[0][0]);
    expect(query.params).toEqual(["u", "work", "workshop", "w", "2026-01-01T00:00:00.000Z", "t"]);
    expect(query.sql).not.toMatch(/\bor\b/i);
    expect(result.types).toHaveLength(100);
    expect(result.types[0].count).toBe(3);
    expect(result.hasMoreTypes).toBe(true);
    expect(capture.limit).toHaveBeenCalledWith(101);
  });
  it("combines owner, legacy/current Work scope, exact ID and recording cutoff with AND", async () => {
    await listBrainStateSnapshots({ userId: "owner", workId: "work-a", snapshotId: "snapshot-a", recordedBefore: "2026-01-01T00:00:00Z", limit: 1 });
    const query = new PgDialect().sqlToQuery(capture.where.mock.calls[0][0]);
    expect(query.sql).toContain('"user_id" =');
    expect(query.sql).toContain('"scope_type" in');
    expect(query.sql).toContain('"scope_id" =');
    expect(query.sql).toContain('"id" =');
    expect(query.sql).toContain('"created_at" <=');
    expect(query.sql).not.toMatch(/\bor\b/i);
    expect(query.params).toEqual(["owner", "work", "workshop", "work-a", "snapshot-a", "2026-01-01T00:00:00.000Z"]);
    expect(capture.limit).toHaveBeenCalledWith(1);
  });
});
