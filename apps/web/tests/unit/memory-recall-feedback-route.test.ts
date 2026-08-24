import { beforeEach, describe, expect, it, vi } from "vitest";

const saveFeedbackMock = vi.hoisted(() => vi.fn());
const query = "\u76d8\u4e2d\u4ea4\u6613";

vi.mock("@/app/(auth)/auth", () => ({
  auth: vi.fn(async () => ({
    user: {
      id: "user-1",
      email: "user-1@example.com",
    },
  })),
}));

vi.mock("@/lib/db/queries", () => ({
  saveFeedback: saveFeedbackMock,
}));

import { POST } from "@/app/api/memory/recall-feedback/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/memory/recall-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("memory recall feedback route", () => {
  beforeEach(() => {
    saveFeedbackMock.mockReset();
    saveFeedbackMock.mockResolvedValue({ id: "feedback-1" });
  });

  it("records recall feedback as append-only platform feedback", async () => {
    const response = await POST(
      request({
        query,
        outcome: "irrelevant",
        reason: "The recall mixed unrelated source memories.",
        sources: ["memory", "graph"],
        contextLogId: "context-log-1",
        memoryIds: ["memory-1"],
        selectedMemoryIds: ["memory-1"],
        omittedMemoryIds: ["memory-2"],
        deniedMemoryIds: ["memory-3"],
      }) as never,
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ ok: true, feedbackId: "feedback-1" });
    expect(saveFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        contactEmail: "user-1@example.com",
        source: "memory_recall",
        type: "improvement",
        title: "Memory recall irrelevant",
        systemInfo: expect.objectContaining({
          kind: "memory_recall_feedback",
          query,
          outcome: "irrelevant",
          contextLogId: "context-log-1",
          memoryIds: ["memory-1"],
          selectedMemoryIds: ["memory-1"],
          omittedMemoryIds: ["memory-2"],
          deniedMemoryIds: ["memory-3"],
          sources: ["memory", "graph"],
          automaticPolicyChange: false,
        }),
      }),
    );
  });

  it("rejects unsupported recall feedback outcomes", async () => {
    const response = await POST(
      request({
        query,
        outcome: "rewrite_policy",
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(saveFeedbackMock).not.toHaveBeenCalled();
  });
});
