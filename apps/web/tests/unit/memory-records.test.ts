import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { BrainAccessGrantRow, BrainMemoryRow } from "@/lib/db/schema";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));

import { brainMemories, brainAccessGrants } from "@/lib/db/schema";
import * as legacy from "@/lib/brain/repository";
import * as records from "@/lib/memory/records/memory-record";
import { getMemoryById, listAccessGrantsForUser } from "@/lib/memory/adapters/postgres/memory-records";
import * as canonical from "@/lib/memory/revision/canonical";
import * as canonicalKernel from "@/lib/memory/kernel/memory-canonical";
import * as oldCanonical from "@/lib/brain/canonical";
import * as policy from "@/lib/memory/revision/policy";
import * as oldPolicy from "@/lib/brain/policy";

const now = new Date("2026-10-20T00:00:00Z");
const memory: BrainMemory = { id: "memory-a", userId: "owner-a", scope: { type: "work", workId: "work-a" },
  ownerType: "work", ownerId: "work-a", memoryType: "preference", subject: "Style", content: "Use concise summaries.",
  status: "active", confidence: 80, evidenceRefs: ["event-a"], createdAt: now.toISOString(), updatedAt: now.toISOString(),
  metadata: { facets: { scenarioKeys: ["project:alpha"] } } };
const memoryRow: BrainMemoryRow = { id: memory.id, userId: memory.userId, scopeType: "work", scopeId: "work-a",
  ownerType: memory.ownerType, ownerId: memory.ownerId, memoryType: memory.memoryType, subject: memory.subject,
  content: memory.content, status: memory.status, confidence: memory.confidence, canonicalKind: "preference",
  canonicalGroupId: "canonical-a", evidenceRefs: memory.evidenceRefs, tags: [], metadata: memory.metadata ?? {},
  expiresAt: null, supersedes: [], createdAt: now, updatedAt: now };
const grantRow: BrainAccessGrantRow = { id: "grant-a", userId: "owner-a", subjectType: "work", subjectId: "work-b",
  scopeType: "work", scopeId: "work-a", permissions: ["reference"], memoryTypes: ["preference"], reason: null,
  expiresAt: null, createdAt: now, updatedAt: now };
const dialect = new PgDialect();

class Query {
  table: unknown;
  condition: SQL | undefined;
  order: unknown;
  count: number | undefined;
  from(table: unknown) { this.table = table; return this; }
  where(condition: SQL) { this.condition = condition; return this; }
  orderBy(order: unknown) { this.order = order; return this; }
  async limit(count: number) {
    this.count = count;
    if (!this.condition) throw new Error("Owner condition is required");
    const { params } = dialect.sqlToQuery(this.condition);
    if (this.table === brainMemories) return params[0] === memoryRow.userId && params[1] === memoryRow.id ? [memoryRow] : [];
    if (this.table === brainAccessGrants) return params[0] === grantRow.userId
      && (params[1] === undefined || params[1] === grantRow.subjectType)
      && (params[2] === undefined || params[2] === grantRow.subjectId) ? [grantRow] : [];
    throw new Error("Unexpected table");
  }
}

beforeEach(() => { vi.clearAllMocks(); mocks.select.mockImplementation(() => new Query()); });

describe("Memory record seams", () => {
  it("keeps legacy canonical, policy, mapper and read exports as actual aliases", () => {
    expect(legacy.brainMemoryToInsertRow).toBe(records.memoryToInsertRow);
    expect(legacy.brainMemoryFromRow).toBe(records.memoryFromRow);
    expect(legacy.brainAccessGrantToInsertRow).toBe(records.accessGrantToInsertRow);
    expect(legacy.brainAccessGrantFromRow).toBe(records.accessGrantFromRow);
    expect(legacy.brainMemoryReviewToInsertRow).toBe(records.memoryReviewToInsertRow);
    expect(legacy.getBrainMemoryById).toBe(getMemoryById);
    expect(legacy.listBrainAccessGrantsForUser).toBe(listAccessGrantsForUser);
    expect(oldCanonical.buildBrainMemoryMetadata).toBe(canonical.buildBrainMemoryMetadata);
    expect(canonical.buildBrainMemoryMetadata).toBe(canonicalKernel.buildBrainMemoryMetadata);
    expect(canonical.getBrainMemoryCanonicalMetadata).toBe(canonicalKernel.getBrainMemoryCanonicalMetadata);
    expect(oldCanonical.matchBrainMemoryScenarioApplicability).toBe(canonical.matchBrainMemoryScenarioApplicability);
    expect(oldPolicy.canReadMemory).toBe(policy.canReadMemory);
    expect(oldPolicy.validateMemoryWrite).toBe(policy.validateMemoryWrite);
  });

  it("preserves canonical columns, explicit applicability and source references through row conversion", () => {
    const stored = records.memoryToInsertRow(memory);
    expect(stored).toMatchObject({ scopeType: "work", scopeId: "work-a", canonicalKind: "preference",
      evidenceRefs: ["event-a"], metadata: memory.metadata });
    const read = records.memoryFromRow(memoryRow);
    expect(read).toMatchObject({ scope: memory.scope, evidenceRefs: ["event-a"],
      metadata: { canonicalKind: "preference", canonicalGroupId: "canonical-a" } });
    expect(canonical.getBrainMemoryScenarioApplicability(read)).toEqual({ status: "scoped", scenarioKeys: ["project:alpha"], basis: "typed_scenario_keys" });
    expect(canonical.matchBrainMemoryScenarioApplicability(read, { scenarioKeys: ["project:beta"] }).matched).toBe(false);
  });

  it("reads one exact memory using owner plus record identity", async () => {
    expect(await getMemoryById({ userId: "owner-a", memoryId: "memory-a" })).toMatchObject({ id: "memory-a" });
    const query = mocks.select.mock.results[0].value as Query;
    expect(dialect.sqlToQuery(query.condition!).params).toEqual(["owner-a", "memory-a"]);
    expect(query.count).toBe(1);
    expect(await getMemoryById({ userId: "owner-b", memoryId: "memory-a" })).toBeNull();
    expect(await getMemoryById({ userId: "owner-a", memoryId: "memory-b" })).toBeNull();
  });

  it("retains explicit subject filters and caller limit when listing owner grants", async () => {
    expect(await listAccessGrantsForUser({ userId: "owner-a", subjectType: "work", subjectId: "work-b", limit: 7 }))
      .toEqual([expect.objectContaining({ id: "grant-a", scope: { type: "work", workId: "work-a" }, permissions: ["reference"] })]);
    const query = mocks.select.mock.results[0].value as Query;
    expect(dialect.sqlToQuery(query.condition!).params).toEqual(["owner-a", "work", "work-b"]);
    expect(query.order).toBeDefined(); expect(query.count).toBe(7);
    expect(await listAccessGrantsForUser({ userId: "owner-b" })).toEqual([]);
  });
});
