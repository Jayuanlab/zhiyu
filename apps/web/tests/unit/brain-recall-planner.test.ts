import { describe, expect, it } from "vitest";
import { buildRuleBasedBrainRecallPlan, sanitizeBrainRecallPlan } from "@/lib/brain/recall-planner";
import type { BrainRequester } from "@/lib/brain/types";
import { buildBrainContextPack } from "@/lib/brain/context";
import type { BrainMemory } from "@/lib/brain/types";

const requester: BrainRequester = {
  type: "work",
  userId: "user-1",
  id: "paper-trader",
  workId: "paper-trader",
};

describe("brain recall planner", () => {
  it("keeps caller budgets and candidate admission authoritative over model parameters", () => {
    const request = { requester, taskIntent: "Inspect current state", maxItems: 2, memoryLimit: 7, action: { kind: "answer" as const } };
    const malicious = { maxItems: 24, memoryLimit: 500, includeCandidates: true, statuses: ["candidate", "verified"] as const };
    const plan = sanitizeBrainRecallPlan(request, { ...malicious, statuses: [...malicious.statuses] });
    expect(plan).toMatchObject({ maxItems: 2, memoryLimit: 7, includeCandidates: false, statuses: ["verified"] });
    expect(buildRuleBasedBrainRecallPlan(request)).toMatchObject({ maxItems: 2, memoryLimit: 7 });
    expect(sanitizeBrainRecallPlan({ ...request, action: { kind: "review" } }, { includeCandidates: true }).includeCandidates).toBe(true);
  });
  it.each(["Recall the current memory", "Use previous experience", "Inspect the current hypothesis", "Read the earlier proposal", "Find the latest policy",
    "Recall memories", "Inspect hypotheses", "Read policies", "读取经验和记忆", "检查假设和提案"])("keeps reviewed insights in fallback routing for %s", taskIntent => {
    const plan = buildRuleBasedBrainRecallPlan({ requester, taskIntent, platformState: { riskLevel: "normal" }, action: { kind: "execute" } }, "planner timeout");
    expect(plan.mode).toBe("fallback_rules");
    expect(plan.memoryTypes).toContain("insight");
    expect(plan.canonicalKinds).toContain("lesson");
    expect(plan.minConfidence).toBeUndefined();
    expect(plan.statuses).not.toContain("candidate");
    expect(plan.includeCandidates).toBe(false);
  });

  it("keeps an ordinary reviewed experience eligible while excluding pending and foreign records", () => {
    const taskIntent = "Recall the current policy from reviewed experience";
    const plan = buildRuleBasedBrainRecallPlan({ requester, taskIntent, platformState: { riskLevel: "normal" }, action: { kind: "execute" } }, "planner unavailable");
    const reviewed: BrainMemory = { id: "reviewed-insight", userId: requester.userId, ownerType: "work", ownerId: requester.workId!,
      scope: { type: "work", workId: requester.workId! }, memoryType: "insight", subject: "Reviewed policy proposal",
      content: "A reviewed experience policy with a bounded application condition.", status: "verified", confidence: 25,
      evidenceRefs: ["source-1"], createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z",
      metadata: { canonicalKind: "lesson", canonicalGroupId: "reviewed-policy" } };
    expect(plan.memoryTypes).toContain(reviewed.memoryType);
    expect(plan.canonicalKinds).toContain("lesson");
    expect(plan.statuses).toContain(reviewed.status);
    expect(plan.minConfidence === undefined || reviewed.confidence >= plan.minConfidence).toBe(true);
    const pack = buildBrainContextPack({ requester, taskIntent, now: new Date("2026-10-16T01:00:00.000Z"), includeCandidates: plan.includeCandidates,
      memories: [reviewed, { ...reviewed, id: "pending", status: "candidate" }, { ...reviewed, id: "foreign", userId: "another-user" }] });
    expect(pack.items.map(item => item.id)).toEqual([reviewed.id]);
    expect(pack.omitted).toContainEqual({ id: "pending", reason: "candidate_requires_review" });
    expect(pack.denied).toContainEqual({ id: "foreign", reason: "wrong_user" });
    expect(reviewed.confidence).toBe(25);
  });

  it("keeps the high-risk confidence threshold when experience routing is needed", () => {
    const plan = buildRuleBasedBrainRecallPlan({ requester, taskIntent: "Recall current policy and previous experience before an order",
      platformState: { riskLevel: "high" }, action: { kind: "trade" } }, "planner unavailable");
    expect(plan.memoryTypes).toEqual(expect.arrayContaining(["boundary", "fact", "insight"]));
    expect(plan.canonicalKinds).toEqual(expect.arrayContaining(["boundary", "state", "lesson"]));
    expect(plan.minConfidence).toBe(60);
    expect(plan.includeCandidates).toBe(false);
    expect(plan.statuses).not.toContain("candidate");
  });
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
