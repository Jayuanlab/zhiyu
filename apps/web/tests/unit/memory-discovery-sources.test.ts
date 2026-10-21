import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { interactionMemories, memoryGraphEntities, memoryGraphRelations, memoryGraphEvidence } from "@/lib/db/schema";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

const io = vi.hoisted(() => ({ select: vi.fn(), candidates: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: io.select } }));
vi.mock("@/lib/memory/retrieval/candidates", () => ({ listBrainMemoriesForUser: io.candidates }));
import { searchInteractionMemories } from "@/lib/memory/adapters/postgres/interaction-discovery";
import { searchInteractionGraph } from "@/lib/memory/adapters/postgres/interaction-graph-discovery";

const userId = "00000000-0000-4000-8000-000000000001";
const time = new Date("2026-10-20T00:00:00Z");
function canonical(): BrainMemory {
  return { id: "00000000-0000-4000-8000-000000000002", userId, ownerType: "chat", ownerId: userId,
    scope: { type: "global" }, memoryType: "fact", status: "verified", subject: "Alpha", content: "Alpha owner",
    confidence: 70, evidenceRefs: ["event"], createdAt: time.toISOString(), updatedAt: time.toISOString() };
}
type Captured = { table: unknown; condition?: SQL; limit?: number };
const rows = new Map<unknown, object[]>();
const queries: Captured[] = [];
function installReadStore() {
  io.select.mockImplementation(() => {
    const query: Captured = { table: undefined };
    const builder = {
      from(table: unknown) { query.table = table; return builder; },
      where(condition: SQL) { query.condition = condition; return builder; },
      orderBy() { return builder; },
      async limit(limit: number) { query.limit = limit; queries.push(query); return rows.get(query.table) ?? []; },
    };
    return builder;
  });
}
function compiled(query: Captured) {
  if (!query.condition) throw Error("missing owner predicate");
  return new PgDialect().sqlToQuery(query.condition);
}

describe("Memory discovery source adapters", () => {
  beforeEach(() => { rows.clear(); queries.length = 0; io.select.mockReset(); io.candidates.mockReset().mockResolvedValue([]);
    vi.stubEnv("BRAIN_MEMORY_MODE", "brain_first"); installReadStore(); });
  afterEach(() => vi.unstubAllEnvs());

  it("uses canonical confirmed owner records without reading a legacy write service", async () => {
    io.candidates.mockResolvedValue([canonical()]);
    const result = await searchInteractionMemories({ userId, query: "Alpha", limit: 3 });
    expect(io.candidates).toHaveBeenCalledExactlyOnceWith({ userId, ownerType: "chat", ownerId: userId,
      statuses: ["active", "verified"], limit: 150 });
    expect(result).toMatchObject([{ memory: { id: canonical().id, status: "confirmed", sourceEventIds: ["event"] }, score: 0.99 }]);
    expect(io.select).not.toHaveBeenCalled();
  });

  it("keeps legacy discovery owner/status filters and normalization when its mode permits fallback", async () => {
    rows.set(interactionMemories, [{ id: "legacy", userId, memoryType: "fact", subject: "Alpha", content: "Alpha owner",
      status: "confirmed", tags: ["alpha"], sourceEventIds: ["event"], metadata: {}, updatedAt: time, createdAt: time }]);
    const result = await searchInteractionMemories({ userId, query: "Alpha", limit: 3 });
    expect(result).toMatchObject([{ memory: { id: "legacy", tags: ["alpha"], sourceEventIds: ["event"] } }]);
    const query = compiled(queries[0]);
    expect(query.params).toEqual([userId, "confirmed"]);
    expect(query.sql).toContain('"user_id"');
    expect(queries[0].limit).toBe(15);
  });

  it("does not enable legacy reads when canonical-only discovery is empty", async () => {
    vi.stubEnv("BRAIN_MEMORY_MODE", "brain_only");
    expect(await searchInteractionMemories({ userId, query: "Alpha" })).toEqual([]);
    expect(io.select).not.toHaveBeenCalled();
  });

  it("reads graph entities, active relations and evidence with the same owner predicate", async () => {
    rows.set(memoryGraphEntities, [{ id: "subject", name: "Alpha", entityType: "project", aliases: '[]', metadata: '{}' },
      { id: "object", name: "Owner", entityType: "person", aliases: '[]', metadata: '{}' }]);
    rows.set(memoryGraphRelations, [{ id: "relation", subjectEntityId: "subject", objectEntityId: "object", relationType: "owned_by",
      claim: "Alpha owner", confidence: 90, status: "active", metadata: '{}', updatedAt: time }]);
    rows.set(memoryGraphEvidence, [{ id: "evidence", relationId: "relation", sourceType: "interaction_event", sourceId: "event", metadata: '{}' }]);
    const result = await searchInteractionGraph({ userId, query: "Alpha", limit: 2 });
    expect(result).toMatchObject([{ relation: { id: "relation" }, subject: { aliases: [] }, evidence: [{ sourceId: "event", metadata: {} }] }]);
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(compiled(query).params).toContain(userId);
      expect(compiled(query).sql).toContain('"user_id"');
    }
    expect(compiled(queries.find(query => query.table === memoryGraphRelations)!).params).toContain("active");
    const evidenceQuery = queries.find(query => query.table === memoryGraphEvidence)!;
    expect(getTableName(memoryGraphEvidence)).toBeTruthy();
    expect(compiled(evidenceQuery).params).toEqual([userId, "relation"]);
  });
});
