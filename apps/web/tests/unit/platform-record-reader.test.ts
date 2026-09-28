import { describe, expect, it, vi } from "vitest";
import { readPlatformRecordsForOwner, readPlatformRecordForOwner, projectPlatformRecords, platformRecordIds } from "@/lib/ai/platform-record-reader";

const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
const parent = "44861dfc-916f-431f-899b-364ca54f0aa1";
describe("owner platform records", () => {
  it("keeps oversized exact records discoverable and expands a matching version with owner scope", async () => {
    const fields = { id, loopId: parent, status: "failed", error: "context limit", triggerReason: { text: "x".repeat(24000) } };
    const query = vi.fn(async (source, ids, userId) => {
      expect(userId).toBe("owner");
      return source[0] === "loopRuns" && ids.includes(id) ? [fields] : [];
    });
    const discovered = await readPlatformRecordsForOwner({ userId: "owner", question: id }, query);
    const compact = projectPlatformRecords(discovered);
    const record = compact.records.find(row => row.source === "loopRuns")! as any;
    expect(JSON.stringify(compact).length).toBeLessThan(8000);
    expect(record.fields).toMatchObject({ id, status: "failed", error: "context limit" });
    expect(record.fields).not.toHaveProperty("triggerReason");
    expect(record.fieldAvailability).toMatchObject({ triggerReason: "present_unread", status: "shown" });
    expect(compact.pendingExactReads).toEqual([expect.objectContaining({ source: "loopRuns", id, expectedHash: record.contentHash })]);
    const first = await readPlatformRecordForOwner({ userId: "owner", ...record.read }, query);
    expect(first).toMatchObject({ status: "read", contentHash: record.contentHash, nextOffset: 8000 });
    const next = await readPlatformRecordForOwner({ userId: "owner", ...record.read, offset: 8000 }, query);
    expect(next).toMatchObject({ status: "read", contentHash: record.contentHash });
    const changed = await readPlatformRecordForOwner({ userId: "owner", ...record.read }, vi.fn(async () => [{ ...fields, status: "updated" }]));
    expect(changed).toMatchObject({ status: "version_changed", content: "" });
    expect(query).toHaveBeenCalledWith(expect.arrayContaining(["loopRuns"]), [id], "owner");
  });
  it("never lets a cursor or source name escape the fixed owner-checked catalog", async () => {
    const query = vi.fn(async () => []);
    await expect(readPlatformRecordForOwner({ userId: "owner", source: "unknown", id }, query)).rejects.toThrow("Unsupported");
    expect(query).not.toHaveBeenCalled();
    expect(await readPlatformRecordForOwner({ userId: "owner", source: "loopRuns", id }, query)).toMatchObject({ status: "not_found_in_scope" });
    expect(query).toHaveBeenCalledWith(expect.arrayContaining(["loopRuns"]), [id], "owner");
  });
  it("keeps persisted-state time semantics on an exact loopStates read", async () => {
    const updatedAt = new Date("2026-09-19T02:02:18.594Z");
    const query = vi.fn(async () => [{ loopId: id, currentPhase: "error", updatedAt }] as Record<string, unknown>[]);
    const result = await readPlatformRecordForOwner({ userId: "owner", source: "loopStates", id }, query);
    expect(result).toMatchObject({ status: "read", temporalScope: { kind: "last_persisted_state",
      lastRecordedAt: updatedAt, currentRuntimeVerified: false } });
    expect(query).toHaveBeenCalledWith(expect.arrayContaining(["loopStates"]), [id], "owner");
  });
  it("supports named entities without requiring users to know record IDs", async () => {
    const query = vi.fn(async (source, ids, userId, names) => source[0] === "loops" && names.includes("Daily review")
      ? [{ id, name: "Daily review", status: "paused" }] : []);
    const result = await readPlatformRecordsForOwner({ userId: "owner", question: 'Is "Daily review" running?' }, query);
    expect(result.records).toHaveLength(1);
    expect(result.requestedNames).toEqual(["Daily review"]);
  });
  it("reads exact records outside list windows and expands owner-checked provenance", async () => {
    const query = vi.fn(async (source, ids, userId) => {
      expect(userId).toBe("owner");
      if (source[0] === "loops" && ids.includes(id)) return [{ id, workshopId: parent, status: "paused", triggerConfig: { cron: "10 16 * * 1-5" } }];
      if (source[0] === "loopStates" && ids.includes(id)) return [{ loopId: id, currentPhase: "error", blockedReason: "context limit", openQuestions: [], nextAction: null }];
      if (source[0] === "workshops" && ids.includes(parent)) return [{ id: parent, mission: "Research" }];
      return [];
    });
    const result = await readPlatformRecordsForOwner({ userId: "owner", question: id }, query);
    expect(result.missingIds).toEqual([]);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "loopStates", fields: expect.objectContaining({ currentPhase: "error", nextAction: null, openQuestions: [] }) }),
      expect.objectContaining({ source: "workshops", id: parent }),
    ]));
    expect(result.failedSources).toEqual([]);
    const state = projectPlatformRecords(result).records.find(record => record.source === "loopStates") as any;
    expect(state.temporalScope).toMatchObject({ kind: "last_persisted_state", currentRuntimeVerified: false });
  });
  it("distinguishes source failure from absent records and never queries without identifiers", async () => {
    const query = vi.fn(async () => { throw Error("unavailable"); });
    expect((await readPlatformRecordsForOwner({ userId: "owner", question: "general architecture" }, query)).records).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    const result = await readPlatformRecordsForOwner({ userId: "owner", question: id }, query);
    expect(result.failedSources).toContain("loops");
    expect(result.missingIds).toEqual([id]);
    expect(platformRecordIds(`${id} ${id}`)).toEqual([id]);
  });
});
