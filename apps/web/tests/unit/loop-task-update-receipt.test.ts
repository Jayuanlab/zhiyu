import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

const getLoop = vi.hoisted(() => vi.fn());
const updateLoop = vi.hoisted(() => vi.fn());
const updateWorkLoop = vi.hoisted(() => vi.fn());
const getLoopState = vi.hoisted(() => vi.fn());
const upsertLoopState = vi.hoisted(() => vi.fn());
const computeNextLoopRun = vi.hoisted(() => vi.fn());
const draftLoopFromNaturalLanguage = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _description: string, _schema: unknown, execute: unknown) => ({ name, execute }),
}));
vi.mock("@/lib/loops", () => ({ getLoop, updateLoop, getLoopState, upsertLoopState, computeNextLoopRun }));
vi.mock("@/lib/work-runtime", () => ({ updateWorkLoop }));
vi.mock("@/lib/loops/natural-language", () => ({ draftLoopFromNaturalLanguage }));
vi.mock("@/lib/ai/loop-task-read-tools", () => ({ listLoopTasksForUser: vi.fn(), summarizeLoopTask: (loop: unknown) => loop }));

import { createLoopTaskTools } from "@/lib/ai/mcp/tools/loop-tasks";
import { loopUpdateReceiptSemantics } from "@/lib/work-runtime/loop-update-receipt";

const session = { user: { id: "owner-1" } } as Session;
async function execute(name: string, params: Record<string, unknown>) {
  const definition = createLoopTaskTools(session).find(tool => tool.name === name) as unknown as {
    execute: (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  };
  const result = await definition.execute(params);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

describe("MCP Loop update receipt boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLoopState.mockResolvedValue({ stateJson: { ownerNote: "keep" } });
    computeNextLoopRun.mockReturnValue(null);
  });

  it.each([null, "work-1"])("does not claim future admission for a status-only %s Loop", async workshopId => {
    updateLoop.mockResolvedValue({ id: "loop-1", workshopId, status: "paused", name: "Loop" });
    const result = await execute("setLoopTaskStatus", { loopId: "loop-1", status: "paused" });
    expect(updateLoop).toHaveBeenCalledWith("owner-1", "loop-1", { status: "paused" });
    expect(result).not.toHaveProperty("nextScheduledRunAt");
    expect(result.receiptSemantics.scheduleUpdate).toEqual({ status: "not_recomputed" });
    expect(result.receiptSemantics.futureAdmissionObservation).toBe("not_observed_by_this_command");
    expect(result.receiptSemantics.inFlightCancellation).toBe("not_requested_by_this_command");
    expect(upsertLoopState).not.toHaveBeenCalled();
    expect(updateWorkLoop).not.toHaveBeenCalled();
  });

  it.each([null, "work-1"])("keeps genuine trigger-to-null recomputation for a %s Loop", async workshopId => {
    const loop = { id: "loop-1", workshopId, status: "active", name: "Loop", triggerConfig: { type: "interval", minutes: 10 } };
    getLoop.mockResolvedValue(loop); updateLoop.mockResolvedValue(loop);
    draftLoopFromNaturalLanguage.mockResolvedValue({ extracted: { missingFields: [] }, spec: { trigger: { type: "manual" } } });
    updateWorkLoop.mockResolvedValue({ loop, nextScheduledRunAt: null, receiptSemantics: loopUpdateReceiptSemantics({ status: "recomputed", nextScheduledRunAt: null }) });
    const result = await execute("updateLoopTask", { loopId: "loop-1", intent: "Change this Loop to manual scheduling" });
    expect(result).toHaveProperty("nextScheduledRunAt", null);
    expect(result.receiptSemantics.scheduleUpdate).toEqual({ status: "recomputed", nextScheduledRunAt: null });
    expect(result.receiptSemantics.futureAdmissionObservation).toBe("not_observed_by_this_command");
    if (workshopId) {
      expect(updateWorkLoop).toHaveBeenCalledOnce();
      expect(upsertLoopState).not.toHaveBeenCalled();
      expect(computeNextLoopRun).not.toHaveBeenCalled();
    } else {
      expect(updateWorkLoop).not.toHaveBeenCalled();
      expect(upsertLoopState.mock.calls[0][1].stateJson).toMatchObject({ nextScheduledRunAt: null, ownerNote: "keep" });
    }
  });

  it.each([null, "work-1"])("omits an uncomputed schedule for a rename-only %s Loop", async workshopId => {
    const loop = { id: "loop-1", workshopId, name: "Old name", status: "active" };
    getLoop.mockResolvedValue(loop); updateLoop.mockResolvedValue({ ...loop, name: "New name" });
    draftLoopFromNaturalLanguage.mockResolvedValue({ name: "New name", extracted: { missingFields: [] }, spec: {} });
    updateWorkLoop.mockResolvedValue({ loop: { ...loop, name: "New name" }, receiptSemantics: loopUpdateReceiptSemantics({ status: "not_recomputed" }) });
    const result = await execute("updateLoopTask", { loopId: "loop-1", intent: "Rename this Loop to New name" });
    expect(result).not.toHaveProperty("nextScheduledRunAt");
    expect(result.receiptSemantics.scheduleUpdate).toEqual({ status: "not_recomputed" });
    expect(computeNextLoopRun).not.toHaveBeenCalled();
    expect(upsertLoopState).not.toHaveBeenCalled();
  });
});
