import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getUserInsightSettingsMock,
  updateUserInsightSettingsMock,
  runInsightEmbeddingDreamMock,
  runWeeklyInsightMaintenanceMock,
} = vi.hoisted(() => ({
  getUserInsightSettingsMock: vi.fn(),
  updateUserInsightSettingsMock: vi.fn(),
  runInsightEmbeddingDreamMock: vi.fn(),
  runWeeklyInsightMaintenanceMock: vi.fn(),
}));

vi.mock("@/lib/db/insight-queries", () => ({
  getUserInsightSettings: getUserInsightSettingsMock,
  updateUserInsightSettings: updateUserInsightSettingsMock,
}));

vi.mock("@/lib/insights/maintenance", () => ({
  runWeeklyInsightMaintenance: runWeeklyInsightMaintenanceMock,
}));

vi.mock("@/lib/insights/dream", () => ({
  runInsightEmbeddingDream: runInsightEmbeddingDreamMock,
}));

import {
  runInsightEmbeddingDreamIfDue,
  runInsightMaintenanceIfDue,
  setLastInsightEmbeddingDreamRunAt,
  setLastInsightMaintenanceRunAt,
} from "@/lib/cron/insight-maintenance";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

describe("cron insight maintenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T02:17:00.000Z"));
    setLastInsightEmbeddingDreamRunAt(null);
    setLastInsightMaintenanceRunAt(null);
    getUserInsightSettingsMock.mockReset();
    updateUserInsightSettingsMock.mockReset();
    runInsightEmbeddingDreamMock.mockReset();
    runWeeklyInsightMaintenanceMock.mockReset();
    runInsightEmbeddingDreamMock.mockResolvedValue({
      scanned: 0,
      selected: 0,
      embedded: 0,
      dryRun: false,
      reasons: {
        missing: 0,
        model_changed: 0,
        content_changed: 0,
      },
    });
    runWeeklyInsightMaintenanceMock.mockResolvedValue({
      platform: "desktop",
      processedUserCount: 0,
      users: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs insight embedding dream once per local scheduler interval window", async () => {
    getUserInsightSettingsMock.mockResolvedValue({
      lastInsightEmbeddingDreamRunAt: null,
    });

    await runInsightEmbeddingDreamIfDue("user-1", "cloud-token");
    await runInsightEmbeddingDreamIfDue("user-1", "cloud-token");

    expect(runInsightEmbeddingDreamMock).toHaveBeenCalledTimes(1);
    expect(runInsightEmbeddingDreamMock).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 100,
      authToken: "cloud-token",
    });
    expect(updateUserInsightSettingsMock).toHaveBeenCalledWith("user-1", {
      lastInsightEmbeddingDreamRunAt: new Date("2026-05-09T02:17:00.000Z"),
    });

    vi.setSystemTime(new Date("2026-05-10T02:17:01.000Z"));
    await runInsightEmbeddingDreamIfDue("user-1", "cloud-token");

    expect(runInsightEmbeddingDreamMock).toHaveBeenCalledTimes(2);
  });

  it("skips insight embedding dream when persisted checkpoint is fresh", async () => {
    getUserInsightSettingsMock.mockResolvedValue({
      lastInsightEmbeddingDreamRunAt: new Date("2026-05-09T01:17:00.000Z"),
    });

    await runInsightEmbeddingDreamIfDue("user-1", "cloud-token");

    expect(runInsightEmbeddingDreamMock).not.toHaveBeenCalled();
    expect(updateUserInsightSettingsMock).not.toHaveBeenCalled();
  });

  it("runs weekly maintenance when persisted checkpoint is due", async () => {
    getUserInsightSettingsMock.mockResolvedValue({
      lastInsightMaintenanceRunAt: new Date("2026-05-01T02:17:00.000Z"),
    });

    await runInsightMaintenanceIfDue("user-1");

    expect(runWeeklyInsightMaintenanceMock).toHaveBeenCalledWith({
      platform: "desktop",
      userId: "user-1",
    });
    expect(updateUserInsightSettingsMock).toHaveBeenCalledWith("user-1", {
      lastInsightMaintenanceRunAt: new Date("2026-05-09T02:17:00.000Z"),
    });
  });

  it("skips maintenance without a scheduler user", async () => {
    await runInsightEmbeddingDreamIfDue(undefined);
    await runInsightMaintenanceIfDue(undefined);

    expect(runInsightEmbeddingDreamMock).not.toHaveBeenCalled();
    expect(runWeeklyInsightMaintenanceMock).not.toHaveBeenCalled();
  });

  it("reports source-required as blocked without a success checkpoint or repeated heartbeat work", async () => {
    getUserInsightSettingsMock.mockResolvedValue({ lastInsightMaintenanceRunAt: null });
    runWeeklyInsightMaintenanceMock.mockRejectedValue(new MemoryModuleError("memory_source_required", 422, "source withheld"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await runInsightMaintenanceIfDue("blocked-synthetic-owner")).toEqual({ status: "blocked", code: "memory_source_required", detail: "legacy_insight_source_unregistered" });
      expect(await runInsightMaintenanceIfDue("blocked-synthetic-owner")).toMatchObject({ status: "blocked" });
      expect(runWeeklyInsightMaintenanceMock).toHaveBeenCalledTimes(1);
      expect(updateUserInsightSettingsMock).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(1);
    } finally { warning.mockRestore(); }
  });
});
