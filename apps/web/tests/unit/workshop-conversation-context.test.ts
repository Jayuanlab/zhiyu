import { describe, expect, it } from "vitest";
import type { WorkshopRun } from "@/lib/db/schema";
import {
  buildWorkshopConversationContext,
  filterConversationRunEvents,
} from "@/lib/workshops/conversation-context";

const WORK = "11111111-1111-4111-8111-111111111111";
const ROOT = "22222222-2222-4222-8222-222222222222";
const FOLLOWUP = "33333333-3333-4333-8333-333333333333";
const SIBLING = "44444444-4444-4444-8444-444444444444";

function run(input: {
  id: string;
  workId?: string;
  content: string;
  parentRunId?: string | null;
  inputFiles?: string[];
  reply?: string;
  status?: string;
}): WorkshopRun {
  return {
    id: input.id,
    workshopId: input.workId ?? WORK,
    triggerReason: {
      type: "conversation", content: input.content,
      parentRunId: input.parentRunId ?? null,
      inputFiles: input.inputFiles ?? [],
    },
    outputSummary: input.reply ?? null,
    status: input.status ?? "completed",
    error: null,
    completionJson: null,
    inputSnapshot: null,
    ccSessionId: null,
    startedAt: new Date("2026-09-26T00:00:00Z"),
    completedAt: new Date("2026-09-26T00:01:00Z"),
    createdAt: new Date("2026-09-26T00:00:00Z"),
    updatedAt: new Date("2026-09-26T00:01:00Z"),
  } as WorkshopRun;
}

describe("Work conversation context", () => {
  it("keeps owner-only AI review advice out of the agent execution context", () => {
    const advice = { runId: null, type: "review_assistant_completed" };
    const observation = { runId: null, type: "source_checked" };
    expect(filterConversationRunEvents([advice, observation], [])).toEqual([observation]);
  });
  it("loads only the chosen ancestry at execution time while current files replace ancestor files", async () => {
    const root = run({ id: ROOT, content: "Read the first file", inputFiles: ["C:\\docs\\first.md"], reply: "First answer" });
    const sibling = run({ id: SIBLING, content: "Unrelated private task", parentRunId: ROOT, reply: "Sibling answer" });
    const current = run({ id: FOLLOWUP, content: "Continue with the second file", parentRunId: ROOT, inputFiles: ["C:\\docs\\second.md"] });
    const parents = new Map([[ROOT, root], [SIBLING, sibling]]);
    const context = await buildWorkshopConversationContext({ run: current, loadParent: async id => parents.get(id) ?? null });
    expect(context.history).toEqual([{ runId: ROOT, content: "Read the first file", reply: "First answer", status: "completed" }]);
    expect(context.inputFiles).toEqual(["C:\\docs\\second.md"]);
    expect(JSON.stringify(context)).not.toContain("Unrelated private task");

    const newThread = run({ id: SIBLING, content: "Start fresh", parentRunId: null });
    const fresh = await buildWorkshopConversationContext({ run: newThread, loadParent: async () => { throw Error("must not load a parent"); } });
    expect(fresh.history).toEqual([]);
    expect(fresh.inputFiles).toEqual([]);
  });

  it("rejects a parent from another Work instead of crossing ownership", async () => {
    const current = run({ id: FOLLOWUP, content: "Continue", parentRunId: ROOT });
    const otherWork = run({ id: ROOT, workId: "99999999-9999-4999-8999-999999999999", content: "Other Work" });
    await expect(buildWorkshopConversationContext({ run: current, loadParent: async () => otherWork }))
      .rejects.toThrow("不属于当前智能体空间");
  });

  it("A to question to B to follow-up inherits B alone and never reprocesses A", async () => {
    const questionId = "55555555-5555-4555-8555-555555555555";
    const bId = "66666666-6666-4666-8666-666666666666";
    const a = run({ id: ROOT, content: "Process A", inputFiles: ["C:\\docs\\A.md"], reply: "A done" });
    const question = run({ id: questionId, content: "What did A say?", parentRunId: ROOT, reply: "A summary" });
    const b = run({ id: bId, content: "Now process B", parentRunId: questionId, inputFiles: ["C:\\docs\\B.md"], reply: "B done" });
    const followup = run({ id: FOLLOWUP, content: "Continue with that file", parentRunId: bId });
    const parents = new Map([a, question, b].map(item => [item.id, item]));
    const loadParent = async (id: string) => parents.get(id) ?? null;

    expect((await buildWorkshopConversationContext({ run: question, loadParent })).inputFiles).toEqual(["C:\\docs\\A.md"]);
    expect((await buildWorkshopConversationContext({ run: b, loadParent })).inputFiles).toEqual(["C:\\docs\\B.md"]);
    const context = await buildWorkshopConversationContext({ run: followup, loadParent });
    expect(context.inputFiles).toEqual(["C:\\docs\\B.md"]);
    expect(context.history.map(item => item.runId)).toEqual([ROOT, questionId, bId]);
  });

  it("removes all conversation run events from persistent context regardless of event type", () => {
    const events = [
      { runId: ROOT, type: "document_converted" },
      { runId: SIBLING, type: "run_completed" },
      { runId: "55555555-5555-4555-8555-555555555555", type: "source_checked" },
      { runId: null, type: "system_notice" },
    ];
    expect(filterConversationRunEvents(events, [
      run({ id: ROOT, content: "Temporary" }),
      run({ id: SIBLING, content: "Also temporary" }),
    ])).toEqual(events.slice(2));
  });
});
