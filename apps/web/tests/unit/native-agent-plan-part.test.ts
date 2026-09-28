import { describe, expect, it } from "vitest";
import type { TaskPlan } from "@openzhiyu/ai/agent/types";
import { nativeAgentPlanToPart } from "@/lib/ai/native-agent-plan-part";

describe("native agent plan message part", () => {
  it("maps a TaskPlan into the existing agent plan card part shape", () => {
    const plan: TaskPlan = {
      id: "plan-1",
      goal: "Explain migration status",
      steps: [
        {
          id: "understand",
          description: "Review current migration state",
          status: "pending",
        },
        {
          id: "respond",
          description: "Summarize next action",
          status: "pending",
        },
      ],
      notes: "Text-only Pi plan.",
      createdAt: new Date("2026-09-14T00:00:00.000Z"),
    };

    expect(nativeAgentPlanToPart(plan)).toEqual({
      type: "data-agentPlan",
      data: {
        id: "plan-1",
        thought: "Explain migration status",
        plan: [
          {
            step: 1,
            action: "Review current migration state",
            tool: null,
          },
          {
            step: 2,
            action: "Summarize next action",
            tool: null,
          },
        ],
        currentStep: 0,
        approvalStatus: "pending_approval",
        requiresApproval: true,
        notes: "Text-only Pi plan.",
      },
    });
  });
});
