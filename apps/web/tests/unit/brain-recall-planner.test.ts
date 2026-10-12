import { describe, expect, it } from "vitest";
import { buildRuleBasedBrainRecallPlan } from "@/lib/brain/recall-planner";
import type { BrainRequester } from "@/lib/brain/types";

const requester: BrainRequester = {
  type: "work",
  userId: "user-1",
  id: "paper-trader",
  workId: "paper-trader",
};

describe("brain recall planner", () => {
  it("builds a conservative rules plan for high-risk actions", () => {
    const plan = buildRuleBasedBrainRecallPlan({
      requester,
      taskIntent: "Check whether the current paper account can place an order",
      platformState: {
        platform: "workshop",
        phase: "intraday_check",
        riskLevel: "high",
        highRiskAction: true,
      },
      action: {
        kind: "trade",
        description: "Decide whether trading is allowed.",
      },
    });

    expect(plan.mode).toBe("rules");
    expect(plan.statuses).toEqual(["active", "verified", "weakened"]);
    expect(plan.memoryTypes).toContain("boundary");
    expect(plan.canonicalKinds).toContain("boundary");
    expect(plan.scopes).toEqual([{ type: "work", workId: "paper-trader" }]);
    expect(plan.minConfidence).toBe(60);
    expect(plan.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: "brain_memory",
          purpose: "canonical",
          enabled: true,
        }),
        expect.objectContaining({
          route: "evidence_read",
          purpose: "evidence",
          enabled: true,
        }),
      ]),
    );
  });

  it("includes candidates only for review/write-memory tasks", () => {
    const normal = buildRuleBasedBrainRecallPlan({
      requester,
      taskIntent: "Summarize stable project preferences",
      action: { kind: "answer" },
    });
    const review = buildRuleBasedBrainRecallPlan({
      requester,
      taskIntent: "Review memory candidates",
      action: { kind: "review" },
    });

    expect(normal.includeCandidates).toBe(false);
    expect(normal.statuses).not.toContain("candidate");
    expect(review.includeCandidates).toBe(true);
    expect(review.statuses).toContain("candidate");
  });

  it("adds planner-controlled knowledge and graph routes when task intent needs them", () => {
    const plan = buildRuleBasedBrainRecallPlan({
      requester,
      taskIntent:
        "Use project documents and relationship graph to explain the owner context",
      action: { kind: "answer" },
    });

    expect(plan.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: "knowledge_store",
          purpose: "evidence",
          enabled: true,
        }),
        expect.objectContaining({
          route: "memory_graph",
          purpose: "derived_index",
          enabled: true,
        }),
      ]),
    );
  });
});
