import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectInteractionTaskScenariosInTransaction } from "@/lib/memory/understanding/scenario-task-projection";
import type { InteractionTask } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";

const save = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/memory/understanding/scenario-persistence", () => ({ persistScenarioStateInTransaction: save }));

const observedAt = new Date("2026-10-20T03:00:00.000Z");
function task(): InteractionTask & { revision: number } {
  return { id: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
    eventId: null, threadId: null, title: "Confirm delivery", description: "Check the official record", status: "confirmed", revision: 0,
    sourceEventIds: ["33333333-3333-4333-8333-333333333333"],
    metadata: { taskState: { version: 0, verificationStatus: "unverified" },
      scenarioHints: [{ type: "project", key: " ＡLPHA ", title: "Alpha" }] },
    updatedAt: observedAt, createdAt: observedAt, dueAt: null, confidence: 80,
    assigneeName: null, requesterName: null };
}
const store = {} as DrizzleDB;
beforeEach(() => vi.clearAllMocks());

describe("host task state projection through Memory", () => {
  it("keeps confirmed task status separate from evidence verification and projects revision zero", async () => {
    const value = task();
    await expect(projectInteractionTaskScenariosInTransaction(store, value, observedAt))
      .resolves.toEqual({ status: "projected", scenarioCount: 1 });
    expect(save).toHaveBeenCalledWith(store, expect.objectContaining({ userId: value.userId, draft: expect.objectContaining({
      scenarioType: "project", scenarioKey: "alpha", content: expect.objectContaining({ taskUpdates: [expect.objectContaining({
        id: value.id, status: "confirmed", stateAuthority: "business_task_record", stateRevision: 0, verificationStatus: "unverified",
      })] }), metadata: expect.objectContaining({ taskAuthorityRef: expect.objectContaining({ id: value.id, revision: 0 }) }),
    }) }));
  });
  it("projects closed task updates while keeping the source task unchanged", async () => {
    const value = task(); value.status = "done"; value.revision = 3;
    const before = structuredClone(value);
    await projectInteractionTaskScenariosInTransaction(store, value, observedAt);
    expect(value).toEqual(before);
    expect(save).toHaveBeenCalledWith(store, expect.objectContaining({ draft: expect.objectContaining({
      content: expect.objectContaining({ openLoops: [], taskUpdates: [expect.objectContaining({ status: "done", stateRevision: 3 })] }),
    }) }));
  });
  it("rejects missing/invalid host revisions before persistence", async () => {
    const value = task(); value.revision = -1;
    await expect(projectInteractionTaskScenariosInTransaction(store, value, observedAt)).rejects.toThrow(/host task revision/);
    expect(save).not.toHaveBeenCalled();
  });
  it("retains the original transaction and exposes persistence failure", async () => {
    const failure = new Error("scenario append failed"); save.mockRejectedValueOnce(failure);
    await expect(projectInteractionTaskScenariosInTransaction(store, task(), observedAt)).rejects.toBe(failure);
  });
});
