import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { user, brainMemories, brainAccessGrants, brainObservations, brainContextLogs, type BrainMemoryRow } from "@/lib/db/schema";
import { memoryReadReceipts, memoryQueryReadReceipts } from "@/lib/db/schema.pg";
import { createOwnerMemoryClient } from "@/lib/memory/client";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { buildBrainContextPack } from "@/lib/memory/context/pack";
import { memoryToInsertRow, memoryFromRow } from "@/lib/memory/records/memory-record";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

const io = vi.hoisted(() => ({ recall: vi.fn(), db: { select: vi.fn(), insert: vi.fn(), transaction: vi.fn() } }));
vi.mock("@/lib/db/client", () => ({ db: io.db, withDatabaseTransaction: async (work: () => Promise<unknown>) => work() }));
// The provider/planning boundary is controlled. Owner authorization, strict
// query parsing, final admission, policy, mappers and receipt adapters stay real.
vi.mock("@/lib/memory/retrieval/recall", () => ({ buildBrainContextFromMemoryRequest: io.recall }));
vi.mock("@/lib/memory/revision/transaction", () => ({
  withMemoryRecordWrite: async (_userId: string, _kind: string, work: (store: object) => Promise<{ result: unknown }>) => (await work(io.db)).result,
}));

const owner = "00000000-0000-4000-8000-000000000001";
const memoryId = "00000000-0000-4000-8000-000000000002";
const observationId = "00000000-0000-4000-8000-000000000003";
const time = new Date("2026-10-20T00:00:00.000Z");
const providerFailure = new MemoryModuleError("fixture_provider_unavailable", 503, "Provider fixture stopped before storage");
const principal = { exists: true };
const memoryRows: object[] = [], observationRows: object[] = [], pendingRows: object[] = [];
const writes: Array<{ table: unknown; value: Record<string, unknown> }> = [];
const reads: Array<{ table: unknown; sql: string; params: unknown[] }> = [];
function savedMemory(overrides: Partial<BrainMemory> = {}): BrainMemory {
  return { id: memoryId, userId: owner, ownerType: "chat", ownerId: owner, scope: { type: "global" },
    memoryType: "fact", status: "verified", subject: "Owner source", content: "Saved interpretation", confidence: 80,
    evidenceRefs: [], createdAt: time.toISOString(), updatedAt: time.toISOString(), ...overrides };
}
function prepare(memory: BrainMemory) {
  const row = memoryToInsertRow(memory), stored = memoryFromRow(row as BrainMemoryRow);
  memoryRows.push(row);
  io.recall.mockResolvedValue({ ...buildBrainContextPack({ requester: { type: "chat", userId: owner, id: "memory-owner-query" },
    accessMode: "owner_override", taskIntent: "source evidence", memories: [stored] }),
    contextLogId: "00000000-0000-4000-8000-000000000004", recallPlan: { warnings: [] } });
  return stored;
}
function installStore() {
  io.db.select.mockImplementation(() => {
    let table: unknown, condition: SQL | undefined;
    const builder = {
      from(value: unknown) { table = value; return builder; },
      where(value: SQL) { condition = value; return builder; },
      orderBy() { return builder; }, limit() { return builder; },
      async for() {
        if (!condition) throw Error("Owner-scoped read must provide a condition");
        const query = new PgDialect().sqlToQuery(condition);
        reads.push({ table, ...query });
        if (!query.params.includes(owner)) throw Error("Unscoped fixture read");
        if (table === user) return principal.exists ? [{ id: owner }] : [];
        if (table === brainMemories) return query.sql.includes("updateProposal") ? pendingRows : memoryRows;
        if (table === brainAccessGrants) return [];
        if (table === brainObservations) return observationRows;
        throw Error("Unexpected storage source");
      },
    };
    return builder;
  });
  io.db.insert.mockImplementation(table => ({ values(value: Record<string, unknown>) {
    writes.push({ table, value });
    return { returning: async () => [{ ...value, id: value.id ?? "00000000-0000-4000-8000-000000000005", createdAt: time }] };
  } }));
  io.db.transaction.mockImplementation(async (work: (store: object) => Promise<unknown>) => work(io.db));
}
const read = (query: unknown) => createOwnerMemoryClient(owner).read(query);

beforeEach(() => {
  vi.clearAllMocks(); io.recall.mockReset().mockRejectedValue(providerFailure);
  memoryRows.length = 0; observationRows.length = 0; pendingRows.length = 0; writes.length = 0; reads.length = 0;
  principal.exists = true; vi.stubEnv("TAURI_MODE", "false"); vi.stubEnv("IS_TAURI", "false"); installStore();
});
afterEach(() => vi.unstubAllEnvs());

describe("public Memory owner query input and dispatch", () => {
  it.each(["requester", "userId", "ownerId", "workId", "sourceFilters", "accessMode", "discoverySources", "includeCandidates", "plannerMode", "planningMode"])
    ("refuses caller-supplied authority or routing field %s before provider/storage", async field => {
      for (const query of [{ purpose: "discover", query: "source" }, { purpose: "recall", taskIntent: "source" }]) {
        await expect(read({ ...query, [field]: field === "accessMode" ? "owner_override" : {} }))
          .rejects.toMatchObject({ code: "invalid_memory_request", status: 400 });
      }
      expect(io.recall).not.toHaveBeenCalled(); expect(io.db.select).not.toHaveBeenCalled();
    });

  it.each([0, -1, 1023, 8193, Number.NaN, Number.POSITIVE_INFINITY, 2048.5, "4096"])
    ("rejects a non-public recall budget %s", async maxTokens => {
      await expect(read({ purpose: "recall", taskIntent: "source", maxTokens })).rejects.toMatchObject({ code: "invalid_memory_request" });
      expect(io.recall).not.toHaveBeenCalled(); expect(io.db.select).not.toHaveBeenCalled();
    });

  it.each([
    { purpose: "discover", query: "source", limit: 101 }, { purpose: "discover", query: "source", filters: { scope: "global" } },
    { purpose: "discover", query: "source", filters: { statuses: ["untrusted-status"] } },
    { purpose: "recall", taskIntent: "source", needs: [{ id: "n", category: "knowledge", question: "source", required: "true" }] },
    { purpose: "recall", taskIntent: "source", needs: [{ id: "n", category: "knowledge", question: "source", required: true, maxAgeHours: -1 }] },
    { purpose: "recall", taskIntent: "source", currentRefs: [{ kind: "interaction_task", id: memoryId, userId: owner }] },
    { purpose: "recall", taskIntent: "source", currentRefs: [{ kind: "scenario_state", scenarioType: "", scenarioKey: "source" }] },
    { purpose: "recall", taskIntent: "source", currentRefs: [{ kind: "observation", id: observationId }] },
  ])("rejects malformed nested filters, needs and exact refs before side effects: %j", async query => {
    await expect(read(query)).rejects.toMatchObject({ code: "invalid_memory_request", status: 400 });
    expect(io.recall).not.toHaveBeenCalled(); expect(io.db.select).not.toHaveBeenCalled();
  });

  it("requires an owner identity and refuses inherited Work capabilities through the real ALS guard", async () => {
    expect(() => createOwnerMemoryClient("forged-owner")).toThrow();
    await expect(withExecutionContext({ userId: owner, workshopId: memoryId, runId: observationId, workerId: "worker", token: 1 },
      () => read({ purpose: "recall", taskIntent: "source" }))).rejects.toMatchObject({ code: "memory_owner_context_required", status: 403 });
    expect(io.recall).not.toHaveBeenCalled(); expect(io.db.select).not.toHaveBeenCalled();
  });

  it("constructs a closed owner recall request without granting auxiliary discovery scope", async () => {
    await expect(read({ purpose: "recall", taskIntent: "  source evidence  ", maxTokens: 4096 })).rejects.toBe(providerFailure);
    expect(io.recall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requester: { type: "chat", userId: owner, id: "memory-owner-query" },
      accessMode: "owner_override", taskIntent: "source evidence", discoverySources: [], maxItems: 24, memoryLimit: 200,
      action: { kind: "answer" }, planningMode: "rules" }));
    expect(io.recall.mock.calls[0][0]).not.toHaveProperty("sourceFilters");
    expect(io.db.select).not.toHaveBeenCalled();
  });

  it("does not convert a missing owner row into a successful empty discovery", async () => {
    principal.exists = false;
    await expect(read({ purpose: "discover", query: "source" })).rejects.toMatchObject({ code: "memory_access_denied", status: 403 });
    expect(io.db.insert).not.toHaveBeenCalled(); expect(io.recall).not.toHaveBeenCalled();
  });

  it("returns owner discovery records with bounded coverage and a persisted query receipt", async () => {
    memoryRows.push(memoryToInsertRow(savedMemory()));
    const result = await read({ purpose: "discover", query: "source", limit: 1 });
    expect(result).toMatchObject({ status: "ok", purpose: "discover", coverage: { complete: false, limit: 1 },
      items: [{ id: memoryId, useSemantics: "discovery_only", ref: { record: { kind: "memory", id: memoryId } } }] });
    expect(writes.filter(write => write.table === memoryQueryReadReceipts)).toHaveLength(1);
    expect(reads.every(query => query.params.includes(owner))).toBe(true);
    expect(io.recall).not.toHaveBeenCalled();
  });

  it("uses actual final permission checks when a prepared record belongs to another owner", async () => {
    prepare(savedMemory());
    memoryRows.splice(0, memoryRows.length, memoryToInsertRow(savedMemory({ userId: "00000000-0000-4000-8000-000000000099", content: "foreign-body-sentinel" })));
    const result = await read({ purpose: "recall", taskIntent: "source evidence", maxTokens: 8192 });
    expect(result).toMatchObject({ status: "empty", purpose: "recall", pack: { constraints: [], interpretations: [] } });
    expect(JSON.stringify(result)).not.toContain("foreign-body-sentinel");
    const audit = writes.find(write => write.table === brainContextLogs)!;
    expect(audit.value.denied).toEqual([{ id: memoryId, reason: "wrong_user" }]);
  });

  it("persists the final clipped observation prefix range rather than the original requested window", async () => {
    const sourceRef = `brain-observation:${observationId}`;
    prepare(savedMemory({ memoryType: "boundary", subject: "Owner approval boundary", content: "External messages require approval", evidenceRefs: [sourceRef] }));
    const source = "🧠中".repeat(700);
    observationRows.push({ id: observationId, userId: owner, sourceType: "manual", sourceId: "raw-source", observedAt: time,
      content: source, contentHash: "legacy-hash", trustLevel: "raw", metadata: {}, createdAt: time });
    const result = await read({ purpose: "recall", taskIntent: "source evidence", maxTokens: 2500 });
    expect(result.status).toBe("ok");
    if (!("purpose" in result) || result.purpose !== "recall" || result.status === "unavailable") throw Error("Expected admitted context");
    const item = result.pack.historicalEvidence[0];
    expect(item).toBeDefined();
    expect(item.content.isWellFormed()).toBe(true);
    expect(Array.from(item.content).length).toBeLessThan(512);
    expect(Array.from(source).slice(0, Array.from(item.content).length).join("")).toBe(item.content);
    const saved = writes.find(write => write.table === memoryReadReceipts)!;
    expect(saved.value).toMatchObject({ userId: owner, observationId,
      actualRange: { start: 0, end: Array.from(item.content).length, unit: "unicode_code_points" }, totalLength: Array.from(source).length,
      revision: item.ref.revision });
    expect(item.receipt.id).toBe(saved.value.id);
    expect(result.pack.budget.usedUpperBound).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(result.pack), "utf8"));
    expect(result.pack.budget.usedUpperBound).toBeLessThanOrEqual(2500);
  });

  it("preserves a late pending-update warning found by actual final admission", async () => {
    const memory = prepare(savedMemory());
    pendingRows.push({ metadata: { updateProposal: { targetMemoryId: memoryId, expectedBaseVersion: getBrainMemoryRevisionVersion(memory), status: "pending" } } });
    const result = await read({ purpose: "recall", taskIntent: "source evidence", maxTokens: 8192 });
    if (!("purpose" in result) || result.purpose !== "recall" || result.status === "unavailable") throw Error("Expected admitted context");
    expect(result.pack.openQuestions.some(question => question.code === "memory_update_pending")).toBe(true);
  });
});
