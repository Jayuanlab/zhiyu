import { describe, expect, it, vi } from "vitest";
import { readLoopRunTimelineForOwner } from "@/lib/ai/loop-run-timeline-reader";

const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
const ids = ["ac8466bc-213d-8042-a70c-0e7241117ae1", "ac8466bc-213d-8042-a70c-0e7241117ae2",
  "ac8466bc-213d-8042-a70c-0e7241117ae3", "ac8466bc-213d-8042-a70c-0e7241117ae4"];
const rows = ids.map((id, index) => ({ id, loopId, status: index === 0 ? "blocked" : index === 3 ? "completed" : "failed",
  createdAt: new Date(index === 2 ? "2026-09-19T02:00:10.000Z" : index < 2 ? "2026-09-19T02:00:09.000Z" : "2026-09-20T02:00:00.000Z"),
  startedAt: new Date("2026-09-19T02:00:10.000Z"), completedAt: null, error: null }));
function source(owned = true) {
  return { ownsLoop: vi.fn(async () => owned), getRun: vi.fn(async (_loopId: string, id: string) => rows.find(row => row.id === id) ?? null),
    listAfter: vi.fn(async (_loopId: string, position: { createdAt: Date; id: string }, limit: number) => rows.filter(row =>
      row.createdAt > position.createdAt || row.createdAt.getTime() === position.createdAt.getTime() && row.id > position.id).slice(0, limit)) };
}
describe("owner-scoped Loop run timeline", () => {
  it("checks ownership before looking up runs", async () => {
    const readers = source(false);
    const result = await readLoopRunTimelineForOwner({ userId: "other", loopId, afterRunId: ids[0] }, readers);
    expect(result).toMatchObject({ status: "loop_not_found_in_scope" });
    expect(readers.getRun).not.toHaveBeenCalled();
    expect(readers.listAfter).not.toHaveBeenCalled();
  });
  it("paginates by creation time and ID without calling a completed status recovery", async () => {
    const readers = source();
    const first = await readLoopRunTimelineForOwner({ userId: "owner", loopId, afterRunId: ids[0], limit: 2 }, readers);
    expect(first).toMatchObject({ status: "read", completionGate: "timeline_continuation_required",
      runs: [{ id: ids[1] }, { id: ids[2] }], coverage: { hasMore: true, nextCursorRunId: ids[2] } });
    if (first.status !== "read") throw Error("missing first page");
    const second = await readLoopRunTimelineForOwner({ userId: "owner", loopId, afterRunId: ids[0], cursorRunId: first.coverage.nextCursorRunId!, limit: 2 }, readers);
    expect(second).toMatchObject({ status: "read", completionGate: "timeline_window_complete",
      runs: [{ id: ids[3], status: "completed" }], coverage: { hasMore: false, nextCursorRunId: null } });
    expect(second.warning).toContain("does not by itself prove");
    expect(readers.ownsLoop).toHaveBeenCalledWith("owner", loopId);
  });
  it("rejects missing anchors, backward cursors and malformed IDs", async () => {
    const readers = source();
    expect(await readLoopRunTimelineForOwner({ userId: "owner", loopId, afterRunId: "ac8466bc-213d-8042-a70c-0e7241117aff" }, readers))
      .toMatchObject({ status: "anchor_not_found_in_scope" });
    expect(await readLoopRunTimelineForOwner({ userId: "owner", loopId, afterRunId: ids[1], cursorRunId: ids[0] }, readers))
      .toMatchObject({ status: "invalid_timeline_cursor" });
    await expect(readLoopRunTimelineForOwner({ userId: "owner", loopId: "invalid", afterRunId: ids[0] }, readers)).rejects.toThrow("Invalid");
  });
  it("fails closed if a source includes the baseline in the successor page", async () => {
    const readers = source();
    readers.listAfter.mockImplementation(async () => [rows[0], rows[1]]);
    const result = await readLoopRunTimelineForOwner({ userId: "owner", loopId, afterRunId: ids[0] }, readers);
    expect(result).toMatchObject({ status: "invalid_timeline_page" });
  });
});
