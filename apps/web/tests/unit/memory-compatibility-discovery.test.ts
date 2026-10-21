import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import type { UnifiedMemorySearchOutput, UnifiedMemorySearchResult } from "@/lib/memory/unified-search";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), read: vi.fn(), receipt: vi.fn() }));
vi.mock("@/lib/memory/adapters/postgres/revision-state", () => ({ withRevisionStateRead: mocks.transaction, readRevisionMemoryForShare: mocks.read }));
vi.mock("@/lib/memory/adapters/postgres/query-receipts", () => ({ appendQueryReceipt: mocks.receipt }));
import { finalizeOwnerDiscovery } from "@/lib/memory/retrieval/compatibility-discovery";

const owner = "00000000-0000-4000-8000-000000000010", foreign = "00000000-0000-4000-8000-000000000020";
const firstId = "00000000-0000-4000-8000-000000000001", secondId = "00000000-0000-4000-8000-000000000002";
const store = Object.freeze({ fixture: "mocked_sql_transaction" });
const receipt = { id: "00000000-0000-4000-8000-000000000030", purpose: "discover", createdAt: "2026-10-20T00:00:00Z" };
function memory(id = firstId, patch: Partial<BrainMemory> = {}): BrainMemory {
  return { id, userId: owner, scope: { type: "global" }, ownerType: "chat", ownerId: owner, memoryType: "insight",
    subject: "Synthetic subject", content: "SYNTHETIC_CANONICAL_BODY", status: "verified", confidence: 80,
    evidenceRefs: ["brain-observation:00000000-0000-4000-8000-000000000099"],
    createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z", ...patch };
}
function item(value: BrainMemory, patch: Partial<UnifiedMemorySearchResult> = {}): UnifiedMemorySearchResult {
  return { id: value.id, type: "memory", content: `${value.subject}: ${value.content}`, similarity: 0.9,
    metadata: { source: "brain_memory", revisionVersion: getBrainMemoryRevisionVersion(value) }, ...patch };
}
function result(items: UnifiedMemorySearchResult[]): UnifiedMemorySearchOutput {
  return { query: "synthetic discovery", sources: ["memory"], resultKind: "canonical_context", count: items.length,
    results: items, warnings: [], sourceSemantics: { memory: "canonical_context_candidate", insights: "legacy_discovery",
      knowledge: "evidence_source", interactions: "legacy_discovery", graph: "derived_index" },
    sourceStatuses: [{ source: "memory", status: "ok", elapsedMs: 1, resultCount: items.length, warningCount: 0, semantics: "canonical_context_candidate" }],
    contextTrace: { interfaceVersion: "brain-context-trace.v1", contextLogId: "SYNTHETIC_PRELIMINARY_TRACE_MUST_NOT_RETURN",
      selection: { selectedCount: items.length, deniedCount: 0, omittedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} },
      selected: [], omitted: [], denied: [], warnings: [] } };
}
describe("compatibility owner discovery final admission", () => {
  const rows = new Map<string, BrainMemory>();
  beforeEach(() => {
    vi.clearAllMocks(); rows.clear(); vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-20T00:00:00Z"));
    mocks.transaction.mockImplementation(async (_owner, read) => read(store));
    mocks.read.mockImplementation(async (_store, userId, id) => { const row = rows.get(id); return row?.userId === userId ? row : null; });
    mocks.receipt.mockResolvedValue(receipt);
  });
  afterEach(() => vi.restoreAllMocks());
  it("locks every distinct canonical row before evaluating a clock that crossed the first row TTL", async () => {
    const first = memory(firstId, { expiresAt: "2026-10-20T00:00:01Z" }), second = memory(secondId);
    rows.set(first.id, first); rows.set(second.id, second);
    mocks.read.mockImplementation(async (_store, userId, id) => {
      if (id === secondId) vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-20T00:00:02Z"));
      const row = rows.get(id); return row?.userId === userId ? row : null;
    });
    const output = await finalizeOwnerDiscovery(owner, result([item(first), item(second), item(second)]));
    expect(mocks.read.mock.calls.map(call => call.slice(1))).toEqual([[owner, firstId], [owner, secondId]]);
    expect(output.results.map(value => value.id)).toEqual([secondId, secondId]);
    expect(JSON.stringify(output)).not.toContain(firstId);
    expect(mocks.receipt.mock.calls[0][1].refs.every((ref: { record: { id: string } }) => ref.record.id === secondId)).toBe(true);
    expect(output.warnings).toContainEqual(expect.objectContaining({ code: "discovery_versions_changed" }));
  });
  it.each(["stale_version", "forged_body", "expired", "foreign", "deleted"] as const)("withholds %s canonical content and references", async failure => {
    const original = memory(); let current = original; let selected = item(original);
    if (failure === "stale_version") current = { ...original, content: "SYNTHETIC_CHANGED_ROW" };
    if (failure === "forged_body") selected = { ...selected, content: "FORGED_BODY_MUST_NOT_RETURN" };
    if (failure === "expired") { current = { ...original, expiresAt: "2026-10-19T23:59:59Z" }; selected = item(current); }
    if (failure === "foreign") { current = { ...original, userId: foreign, content: "FOREIGN_BODY_MUST_NOT_RETURN" }; selected = item(current); }
    if (failure === "deleted") { current = { ...original, status: "deleted" }; selected = item(current); }
    rows.set(current.id, current); const output = await finalizeOwnerDiscovery(owner, result([selected]));
    expect(mocks.read).toHaveBeenCalledWith(store, owner, current.id); expect(output.results).toEqual([]); expect(output.count).toBe(0);
    expect(mocks.receipt.mock.calls[0][1].refs).toEqual([]);
    expect(JSON.stringify(output)).not.toContain(selected.content); expect(output.resultKind).toBe("empty");
  });
  it("receipts only actual canonical versions and strips the automatic context trace", async () => {
    const saved = memory(); rows.set(saved.id, saved);
    const auxiliary: UnifiedMemorySearchResult = { id: "auxiliary", type: "graph", content: "SYNTHETIC_DERIVED_INDEX", similarity: 0.2,
      metadata: { sourceSemantics: "derived_index" } };
    const output = await finalizeOwnerDiscovery(owner, result([item(saved), auxiliary]));
    expect(output.purpose).toBe("discover"); expect(output.contextTrace).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("SYNTHETIC_PRELIMINARY_TRACE"); expect(output.resultKind).toBe("legacy_discovery");
    expect(output.results[0].metadata).toMatchObject({ applicabilityUse: "discovery_only", readReceipt: receipt });
    expect(output.results[1]).toEqual(auxiliary);
    expect(mocks.receipt).toHaveBeenCalledWith(store, expect.objectContaining({ userId: owner, purpose: "discover",
      refs: [{ record: { kind: "memory", id: saved.id }, revision: getBrainMemoryRevisionVersion(saved) }],
      coverage: expect.objectContaining({ auxiliaryIndexes: "discovery_only_without_fixed_source_verification", complete: false }) }));
  });
  it("does not return a successful result when the durable receipt fails", async () => {
    const saved = memory(); rows.set(saved.id, saved); mocks.receipt.mockRejectedValue(new Error("Synthetic receipt failure"));
    await expect(finalizeOwnerDiscovery(owner, result([item(saved)]))).rejects.toThrow("Synthetic receipt failure");
  });
  it("rejects a real Work execution capability before opening owner discovery", async () => {
    await expect(withExecutionContext({ userId: owner, workshopId: secondId, runId: firstId, workerId: "synthetic-worker", token: 7 },
      () => finalizeOwnerDiscovery(owner, result([])))).rejects.toMatchObject({ code: "memory_owner_context_required", status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.receipt).not.toHaveBeenCalled();
  });
});
