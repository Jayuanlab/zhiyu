import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db/client";
import { ensureWorkshopMemoryMirrorInTransaction } from "@/lib/memory/revision/workshop-mirror";
import { insertMissingWorkshopMirrorRow, readWorkshopMirrorForUpdate } from "@/lib/memory/adapters/postgres/workshop-mirror";
import { acquireMemoryWriteAdvisoryLock } from "@/lib/memory/kernel/locks";
import { MemoryIdentityConflict } from "@/lib/memory/kernel/reference-errors";
import type { Workshop, WorkshopMemory, BrainMemoryRow } from "@/lib/db/schema";
import { brainMemoryToInsertRow } from "@/lib/memory/records/memory-record";
import { workshopMemoryToBrainMemory } from "@/lib/memory/records/workshop-memory";
vi.mock("@/lib/memory/adapters/postgres/workshop-mirror", () => ({ insertMissingWorkshopMirrorRow: vi.fn(), readWorkshopMirrorForUpdate: vi.fn() }));
vi.mock("@/lib/memory/kernel/locks", () => ({ acquireMemoryWriteAdvisoryLock: vi.fn(async () => undefined) }));
const at = new Date("2026-10-20T00:00:00Z"), userId = "11111111-1111-4111-8111-111111111111", workId = "22222222-2222-4222-8222-222222222222";
const workshop: Workshop = { id: workId, userId, name: "Synthetic Work", mission: "Synthetic", status: "active", autonomyLevel: "auto", boundaryPolicy: {}, modelConfig: {}, createdAt: at, updatedAt: at };
const memory: WorkshopMemory = { id: "33333333-3333-4333-8333-333333333333", workshopId: workId, kind: "finding", content: "Unverified old mirror",
  confidence: 70, tags: [], sourceEventIds: [], expiresAt: null, createdAt: at, updatedAt: at };
function stored(): BrainMemoryRow {
  const row = brainMemoryToInsertRow(workshopMemoryToBrainMemory({ workshop, memory }));
  return { id: memory.id, userId, scopeType: "workshop", scopeId: workId, ownerType: "work", ownerId: workId,
    memoryType: row.memoryType, subject: row.subject, content: "OWNER_RETIRED_BODY", status: "superseded", confidence: 70,
    canonicalKind: row.canonicalKind ?? null, canonicalGroupId: row.canonicalGroupId ?? null,
    evidenceRefs: [], tags: [], metadata: { revisionRetired: { source: "synthetic_owner" } }, supersedes: [], expiresAt: null, createdAt: at, updatedAt: at };
}
describe("Authorized Work mirror insertion", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(readWorkshopMirrorForUpdate).mockResolvedValue(stored()); });
  it("reuses the exact host transaction, serializes canonical identity and never overwrites an existing retired row", async () => {
    const row = stored(), before = structuredClone(row); vi.mocked(readWorkshopMirrorForUpdate).mockResolvedValue(row);
    await ensureWorkshopMemoryMirrorInTransaction(db, { workshop, memory });
    expect(vi.mocked(acquireMemoryWriteAdvisoryLock).mock.calls[0][0]).toBe(db);
    expect(vi.mocked(acquireMemoryWriteAdvisoryLock).mock.calls[0][1]).toContain(userId);
    expect(vi.mocked(insertMissingWorkshopMirrorRow).mock.calls[0][0]).toBe(db);
    expect(vi.mocked(insertMissingWorkshopMirrorRow).mock.calls[0][1]).toMatchObject({ id: memory.id });
    expect(vi.mocked(readWorkshopMirrorForUpdate).mock.calls[0][0]).toBe(db);
    expect(vi.mocked(readWorkshopMirrorForUpdate).mock.calls[0].slice(1)).toEqual([memory.id, undefined]); expect(row).toEqual(before);
  });
  it("does not reuse another scope's physical ID even when owner and Work strings coincide", async () => {
    vi.mocked(readWorkshopMirrorForUpdate).mockResolvedValue({ ...stored(), scopeType: "global", scopeId: null });
    await expect(ensureWorkshopMemoryMirrorInTransaction(db, { workshop, memory })).rejects.toBeInstanceOf(MemoryIdentityConflict);
  });
});
