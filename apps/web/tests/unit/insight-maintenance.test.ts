import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ select: vi.fn(), compaction: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/insights/compaction", () => ({ runInsightCompaction: mocks.compaction }));
import { runWeeklyInsightMaintenance } from "@/lib/insights/maintenance";

describe("weekly insight maintenance source boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["web", "desktop"] as const)("blocks %s before owner enumeration, compaction or fake success", async platform => {
    await expect(runWeeklyInsightMaintenance({ platform })).rejects.toMatchObject({ code: "memory_source_required", status: 422 });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.compaction).not.toHaveBeenCalled();
  });
  it("does not treat an explicit owner id as a registered model source", async () => {
    await expect(runWeeklyInsightMaintenance({ userId: "synthetic-owner", platform: "web" })).rejects.toMatchObject({ code: "memory_source_required" });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.compaction).not.toHaveBeenCalled();
  });
});
