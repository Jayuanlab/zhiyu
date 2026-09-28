import { describe, expect, it, vi } from "vitest";
import {
  listBrainCandidatesForUser,
  listBrainGrantsForUser,
  listBrainMemoriesForUser,
  listBrainSnapshotsForUser,
} from "@/lib/ai/brain-read-tools";
import { encodeSnapshotSearchCursor } from "@/lib/ai/snapshot-search-cursor";

describe("Brain read tool adapters", () => {
  it("returns bounded content matches with exact-reading provenance instead of inferring from type", async () => {
    const listSnapshots = vi.fn(async () => Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, snapshotType: "unrelated_type",
      content: { text: "x".repeat(3000) + "context window" + "y".repeat(2000) }, scope: { type: "work", workId: "w" }, createdAt: "2026-01-01T00:00:00Z", paginationTime: "2026-01-01 00:00:00.000001+00" })));
    const result = await listBrainSnapshotsForUser({ userId: "u", workId: "w", view: "search", contentQuery: "context window", limit: 2, listSnapshots: listSnapshots as never });
    expect(listSnapshots).toHaveBeenCalledWith({ userId: "u", workId: "w", snapshotTypes: undefined, contentQuery: "context window", limit: 3, recordedBefore: expect.any(String), includePagePosition: true });
    const data = JSON.parse(result.text);
    expect(data.hasMoreMatches).toBe(true);
    expect(data.matches).toHaveLength(2);
    expect(data.matches[0]).toMatchObject({ snapshotId: "s0", matchLocatedInExcerpt: true, excerptTruncated: true });
    expect(data.matches[0].excerpt).toContain("context window");
    expect(data.matches[0].excerpt.length).toBeLessThanOrEqual(1200);
    expect(data.matches[0].snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("walks distinct search pages with a fixed cutoff and full-precision position", async () => {
    const rows = [3, 2, 1].map(i => ({ id: `00000000-0000-4000-8000-00000000000${i}`, content: { text: "needle" },
      createdAt: "2026-01-01T00:00:00.000Z", paginationTime: `2026-01-01 00:00:00.00000${i}+00`, snapshotType: "work_state" }));
    const source = vi.fn(async (input: any) => rows.slice(input.pageAfter ? rows.findIndex(r => r.id === input.pageAfter.id) + 1 : 0, input.pageAfter ? undefined : 2).slice(0, input.limit));
    const input = { userId: "u", workId: "w", view: "search" as const, contentQuery: "needle", limit: 1, listSnapshots: source as never };
    const ids: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const result = await listBrainSnapshotsForUser({ ...input, cursor });
      expect(result.ok).toBe(true);
      const page = JSON.parse(result.text);
      ids.push(...page.matches.map((m: any) => m.snapshotId));
      cursor = page.nextCursor ?? undefined;
    }
    expect(ids).toEqual(rows.map(r => r.id));
    expect(cursor).toBeUndefined();
    expect(source.mock.calls[1][0].pageAfter.time).toBe("2026-01-01 00:00:00.000003+00");
    expect(new Set(source.mock.calls.map(([q]) => q.recordedBefore)).size).toBe(1);
  });
  it("refuses cursor query/scope changes or a widened time boundary before querying", async () => {
    const source = vi.fn();
    const scope = { userId: "u", workId: "w", query: "needle", recordedBefore: "2026-01-02T00:00:00Z" };
    const after = { id: "00000000-0000-4000-8000-000000000001", time: "2026-01-01 00:00:00.123456+00" };
    const cursor = encodeSnapshotSearchCursor(scope, scope.recordedBefore, after);
    const input = { userId: "u", workId: "w", view: "search" as const, contentQuery: "needle", recordedBefore: scope.recordedBefore, listSnapshots: source };
    expect((await listBrainSnapshotsForUser({ ...input, workId: "other", cursor })).ok).toBe(false);
    expect((await listBrainSnapshotsForUser({ ...input, contentQuery: "different", cursor })).ok).toBe(false);
    expect((await listBrainSnapshotsForUser({ ...input, cursor: encodeSnapshotSearchCursor(scope, "2026-01-03T00:00:00Z", after) })).ok).toBe(false);
    expect((await listBrainSnapshotsForUser({ ...input, cursor: "broken" })).ok).toBe(false);
    expect(source).not.toHaveBeenCalled();
  });
  it("keeps zero literal hits and failed search distinct, rejecting invalid search modes", async () => {
    const listSnapshots = vi.fn(async () => []);
    const empty = await listBrainSnapshotsForUser({ userId: "u", view: "search", contentQuery: "missing", listSnapshots });
    expect(empty).toMatchObject({ ok: true, data: { matches: [], hasMoreMatches: false } });
    expect(empty.text).toContain("NOT absence of the fact");
    const invalid = await listBrainSnapshotsForUser({ userId: "u", view: "catalog", contentQuery: "missing", listSnapshots });
    expect(invalid.ok).toBe(false);
    const failed = await listBrainSnapshotsForUser({ userId: "u", view: "search", contentQuery: "missing", listSnapshots: vi.fn(async () => { throw Error("offline"); }) });
    expect(failed).toMatchObject({ ok: false, isError: true });
  });
  it("exposes scoped type counts without implying fact coverage or platform limits", async () => {
    const catalogSnapshots = vi.fn(async () => ({ types: [{ snapshotType: "work_state", count: 12 }], hasMoreTypes: false }));
    const result = await listBrainSnapshotsForUser({ userId: "u", workId: "w", view: "catalog", recordedBefore: "2026-01-01T00:00:00Z", catalogSnapshots: catalogSnapshots as never });
    expect(catalogSnapshots).toHaveBeenCalledWith({ userId: "u", workId: "w", recordedBefore: "2026-01-01T00:00:00Z" });
    expect(result).toMatchObject({ ok: true, data: { status: "catalog", coverage: { completeness: "complete_type_catalog_in_query_scope" } } });
    expect(result.text).toContain("does not measure platform capability");
    expect(result.data?.contentCoverage).toMatchObject({ level: "type_metadata_only", snapshotContentsRead: 0,
      unsupportedClaims: expect.arrayContaining(["a_type_cannot_contain_the_requested_fact"]) });
  });
  it("distinguishes empty catalog, truncated catalog and failed catalog", async () => {
    const empty = await listBrainSnapshotsForUser({ userId: "u", view: "catalog", catalogSnapshots: vi.fn(async () => ({ types: [], hasMoreTypes: false })) });
    expect(empty).toMatchObject({ ok: true, data: { types: [] } });
    const partial = await listBrainSnapshotsForUser({ userId: "u", view: "catalog", catalogSnapshots: vi.fn(async () => ({ types: [], hasMoreTypes: true })) });
    expect(partial.data?.coverage).toMatchObject({ completeness: "truncated_type_catalog" });
    const failed = await listBrainSnapshotsForUser({ userId: "u", view: "catalog", catalogSnapshots: vi.fn(async () => { throw Error("offline"); }) });
    expect(failed).toMatchObject({ ok: false, isError: true });
    expect(failed.data).toBeUndefined();
  });
  it("reads an exact historical snapshot within the trusted Work scope with versioned continuation", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const snapshot = { id, createdAt: "2026-01-01T00:00:00Z", content: { text: "x".repeat(9000) } };
    const listSnapshots = vi.fn(async () => [snapshot]);
    const result = await listBrainSnapshotsForUser({ userId: "u", workId: "w", snapshotId: id,
      recordedBefore: "2026-02-01T00:00:00Z", listSnapshots: listSnapshots as never });
    expect(listSnapshots).toHaveBeenCalledWith({ userId: "u", workId: "w", snapshotId: id,
      recordedBefore: "2026-02-01T00:00:00Z", limit: 1, snapshotTypes: undefined });
    const page = JSON.parse(result.text);
    expect(page).toMatchObject({ status: "read", nextOffset: 8000, coverage: { scope: "current_work_snapshots" } });
    const next = await listBrainSnapshotsForUser({ userId: "u", snapshotId: id, offset: page.nextOffset, expectedHash: page.contentHash, listSnapshots: listSnapshots as never });
    expect(page.content + JSON.parse(next.text).content).toBe(JSON.stringify(snapshot));
    expect(page.coverage.warning).toContain("NOT a fact validity interval");
  });
  it("returns scoped absence and version mismatch without substituting live state", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const missing = await listBrainSnapshotsForUser({ userId: "u", snapshotId: id, listSnapshots: vi.fn(async () => []) as never });
    expect(missing).toMatchObject({ ok: false, data: { status: "not_found_in_scope" } });
    const changed = await listBrainSnapshotsForUser({ userId: "u", snapshotId: id, expectedHash: "a".repeat(64), listSnapshots: vi.fn(async () => [{ id }]) as never });
    expect(changed).toMatchObject({ ok: false, data: { status: "version_changed", content: "" } });
  });
  it("rejects ambiguous time and invalid filters before reading", async () => {
    const listSnapshots = vi.fn();
    for (const filters of [{ recordedBefore: "yesterday" }, { recordedBefore: "2026-02-30T00:00:00Z" }, { snapshotId: "bad" }, { offset: 1 }, { snapshotTypes: [] }]) {
      expect((await listBrainSnapshotsForUser({ userId: "u", ...filters, listSnapshots })).ok).toBe(false);
    }
    expect(listSnapshots).not.toHaveBeenCalled();
  });
  it("lists owner Brain memories with safe filters", async () => {
    const listMemories = vi.fn(async () => [
      {
        id: "memory-1",
        subject: "Project boundary",
      },
    ]);

    const result = await listBrainMemoriesForUser({
      userId: "user-1",
      limit: 999,
      statuses: ["active", "invalid"],
      memoryTypes: ["boundary", "invalid"],
      ownerType: "work",
      ownerId: "work-1",
      listMemories: listMemories as never,
    });

    expect(listMemories).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 100,
      statuses: ["active"],
      memoryTypes: ["boundary"],
      ownerType: "work",
      ownerId: "work-1",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        coverage: { totalMatching: null, completeness: "not_established", returnedCount: 1 },
        memories: [
          {
            id: "memory-1",
            subject: "Project boundary",
          },
        ],
      },
    });
  });

  it("lists owner Brain candidates without reviewing them", async () => {
    const listCandidates = vi.fn(async () => [
      {
        id: "candidate-1",
        status: "candidate",
      },
    ]);

    const result = await listBrainCandidatesForUser({
      userId: "user-1",
      limit: 2,
      ownerType: "chat",
      ownerId: "chat-1",
      listCandidates: listCandidates as never,
    });

    expect(listCandidates).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 2,
      ownerType: "chat",
      ownerId: "chat-1",
    });
    expect(result.text).toContain("candidate-1");
  });

  it("lists owner Brain snapshots with string snapshot type filters", async () => {
    const listSnapshots = vi.fn(async () => [
      {
        id: "snapshot-1",
        snapshotType: "work_state",
      },
    ]);

    const result = await listBrainSnapshotsForUser({
      userId: "user-1",
      limit: -5,
      snapshotTypes: ["work_state", 42],
      listSnapshots: listSnapshots as never,
    });

    expect(listSnapshots).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 1,
      snapshotTypes: ["work_state"],
    });
    expect(result.data?.snapshots).toEqual([
      {
        id: "snapshot-1",
        snapshotType: "work_state",
      },
    ]);
  });

  it("lists owner Brain grants without creating or revoking access", async () => {
    const listGrants = vi.fn(async () => [
      {
        id: "grant-1",
        subjectType: "work",
        subjectId: "work-1",
      },
    ]);

    const result = await listBrainGrantsForUser({
      userId: "user-1",
      limit: 300,
      subjectType: "work",
      subjectId: "work-1",
      listGrants: listGrants as never,
    });

    expect(listGrants).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 100,
      subjectType: "work",
      subjectId: "work-1",
    });
    expect(result.data?.grants).toEqual([
      {
        id: "grant-1",
        subjectType: "work",
        subjectId: "work-1",
      },
    ]);
  });
});
