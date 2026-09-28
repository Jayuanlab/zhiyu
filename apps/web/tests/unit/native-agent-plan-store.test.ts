import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskPlan } from "@openzhiyu/ai/agent/types";

const dbMock = vi.hoisted(() => ({
  insert: vi.fn(),
  delete: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  db: dbMock,
}));

import {
  clearNativeAgentPlanStoreForTests,
  lookupNativeAgentPlan,
  lookupStoredNativeAgentPlan,
  saveNativeAgentPlan,
  storeNativeAgentPlan,
} from "@/lib/ai/native-agent-plan-store";

function plan(id = "plan-1"): TaskPlan {
  return {
    id,
    goal: "Migrate runtime",
    steps: [
      {
        id: "step-1",
        description: "Check runtime",
        status: "pending",
      },
    ],
    createdAt: new Date("2026-09-14T00:00:00.000Z"),
  };
}

describe("native agent plan store", () => {
  beforeEach(() => {
    clearNativeAgentPlanStoreForTests();
    vi.clearAllMocks();
  });

  it("stores plans by owner and plan id", () => {
    const stored = storeNativeAgentPlan({
      ownerId: "owner-1",
      plan: plan(),
      originalPrompt: "plan this",
      workDir: "D:/zhiyu",
      taskId: "task-1",
      now: 1000,
      ttlMs: 5000,
    });

    expect(stored.expiresAt).toBe(6000);
    expect(
      lookupNativeAgentPlan({
        ownerId: "owner-1",
        planId: "plan-1",
        workDir: "D:/zhiyu",
        now: 2000,
      }),
    ).toMatchObject({
      state: "found",
      record: {
        originalPrompt: "plan this",
        taskId: "task-1",
      },
    });
  });

  it("rejects owner and workdir mismatches", () => {
    storeNativeAgentPlan({
      ownerId: "owner-1",
      plan: plan(),
      originalPrompt: "plan this",
      workDir: "D:/zhiyu",
      now: 1000,
      ttlMs: 5000,
    });

    expect(
      lookupNativeAgentPlan({
        ownerId: "owner-2",
        planId: "plan-1",
        workDir: "D:/zhiyu",
        now: 2000,
      }),
    ).toEqual({ state: "owner_mismatch" });
    expect(
      lookupNativeAgentPlan({
        ownerId: "owner-1",
        planId: "plan-1",
        workDir: "D:/other",
        now: 2000,
      }),
    ).toEqual({
      state: "workdir_mismatch",
      expected: "D:/zhiyu",
      actual: "D:/other",
    });
  });

  it("expires stale plans", () => {
    storeNativeAgentPlan({
      ownerId: "owner-1",
      plan: plan(),
      originalPrompt: "plan this",
      now: 1000,
      ttlMs: 500,
    });

    expect(
      lookupNativeAgentPlan({
        ownerId: "owner-1",
        planId: "plan-1",
        now: 1500,
      }),
    ).toEqual({ state: "expired" });
    expect(
      lookupNativeAgentPlan({
        ownerId: "owner-1",
        planId: "plan-1",
        now: 1501,
      }),
    ).toEqual({ state: "missing" });
  });

  it("falls back to memory when persistent writes fail", async () => {
    dbMock.insert.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stored = await saveNativeAgentPlan({
      ownerId: "owner-1",
      plan: plan(),
      originalPrompt: "plan this",
      workDir: "D:/zhiyu",
      now: 1000,
      ttlMs: 5000,
    });

    expect(stored.expiresAt).toBe(6000);
    expect(
      lookupNativeAgentPlan({
        ownerId: "owner-1",
        planId: "plan-1",
        workDir: "D:/zhiyu",
        now: 2000,
      }),
    ).toMatchObject({ state: "found" });

    warnSpy.mockRestore();
  });

  it("falls back to memory when persistent reads fail", async () => {
    storeNativeAgentPlan({
      ownerId: "owner-1",
      plan: plan(),
      originalPrompt: "plan this",
      workDir: "D:/zhiyu",
      now: 1000,
      ttlMs: 5000,
    });
    dbMock.delete.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      lookupStoredNativeAgentPlan({
        ownerId: "owner-1",
        planId: "plan-1",
        workDir: "D:/zhiyu",
        now: 2000,
      }),
    ).resolves.toMatchObject({ state: "found" });

    warnSpy.mockRestore();
  });
});
