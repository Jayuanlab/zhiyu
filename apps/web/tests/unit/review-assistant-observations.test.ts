import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("@/lib/db/client", () => ({ db: { execute: vi.fn() } }));
import { db } from "@/lib/db/client";
import { loadReviewWorkObservations } from "@/lib/workshops/review-assistant-observations";

const workId = "22222222-2222-4222-8222-222222222222";
function row(id: string, trace: Record<string, unknown> = {}, created_at = "2026-09-26T00:00:00.000Z") {
  return { id, created_at, trace: {
    interfaceVersion: "brain-context-trace.v1", warnings: [], selected: [], omitted: [], ...trace,
  } };
}

describe("review assistant Work observation sample", () => {
  beforeEach(() => vi.resetAllMocks());

  it("restricts its read to this Work, a seven-day trace window and fifty events", async () => {
    vi.mocked(db.execute).mockResolvedValue([] as never);
    const observed = await loadReviewWorkObservations(workId);
    const query = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0][0]);
    expect(query.params).toEqual([workId]);
    expect(query.sql).toMatch(/workshop_id = \$1::uuid/);
    expect(query.sql).toContain("created_at >= now() - interval '7 days'");
    expect(query.sql).toContain("created_at <= now()");
    expect(query.sql).toContain("'{memoryRecall,contextPack,interfaceVersion}'");
    expect(query.sql).toContain("'{contextPack,interfaceVersion}'");
    expect(query.sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(query.sql).toContain("LIMIT 50");
    expect(observed).toEqual({ windowDays: 7, sampleCount: 0, eventIds: [], firstEventAt: null,
      lastEventAt: null, warningCount: null, noEvidenceSelectedCount: null, duplicateOmittedCount: null });
  });

  it("counts trace observations without disclosing memory contents or warnings", async () => {
    vi.mocked(db.execute).mockResolvedValue([
      row("event-new", { warnings: [{ message: "private warning" }],
        selected: [{ id: "private-memory", contentPreview: "private content", evidenceRefCount: 0 }],
        omitted: [{ id: "private-omitted", reason: "duplicate_canonical_group" }] }),
      row("event-old", { selected: [{ evidenceRefCount: 0 }, { evidenceRefCount: 2 }] }, "2026-09-25T00:00:00.000Z"),
    ] as never);
    const observed = await loadReviewWorkObservations(workId);
    expect(observed).toEqual({ windowDays: 7, sampleCount: 2, eventIds: ["event-new", "event-old"],
      firstEventAt: "2026-09-25T00:00:00.000Z", lastEventAt: "2026-09-26T00:00:00.000Z",
      warningCount: 1, noEvidenceSelectedCount: 2, duplicateOmittedCount: 1 });
    expect(JSON.stringify(observed)).not.toContain("private");
  });

  it("keeps unknown metrics separate from observed zeroes", async () => {
    vi.mocked(db.execute).mockResolvedValue([
      row("event-a", { selected: [{ subject: "legacy item without evidence count" }], omitted: undefined }),
    ] as never);
    expect(await loadReviewWorkObservations(workId)).toMatchObject({ sampleCount: 1,
      warningCount: 0, noEvidenceSelectedCount: null, duplicateOmittedCount: null });
    vi.mocked(db.execute).mockResolvedValue([row("event-a", { warnings: undefined })] as never);
    expect(await loadReviewWorkObservations(workId)).toMatchObject({
      warningCount: null, noEvidenceSelectedCount: 0, duplicateOmittedCount: 0 });
  });

  it("does not lose duplicate counts when other omission reasons fill the top-eight list", async () => {
    const omitted = Array.from({ length: 9 }, (_, index) => [
      { reason: `reason-${index}` }, { reason: `reason-${index}` },
    ]).flat();
    omitted.push({ reason: "duplicate_canonical_group" });
    vi.mocked(db.execute).mockResolvedValue([row("event-a", { omitted })] as never);
    expect(await loadReviewWorkObservations(workId)).toMatchObject({ duplicateOmittedCount: 1 });
  });

  it("does not turn malformed trace values into confident counts", async () => {
    vi.mocked(db.execute).mockResolvedValue([row("event-a", {
      warnings: [null], selected: [{ evidenceRefCount: -1 }], omitted: [{ id: "no-reason" }],
    })] as never);
    expect(await loadReviewWorkObservations(workId)).toMatchObject({
      sampleCount: 1, warningCount: null, noEvidenceSelectedCount: null, duplicateOmittedCount: null });
  });

  it("lets the caller expose a database failure instead of returning an empty success", async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error("database unavailable"));
    await expect(loadReviewWorkObservations(workId)).rejects.toThrow("database unavailable");
  });
});
