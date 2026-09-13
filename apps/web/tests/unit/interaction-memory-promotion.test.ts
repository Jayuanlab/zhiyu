import { describe, expect, it } from "vitest";
import {
  evaluateInteractionMemoryPromotion,
  INTERACTION_MEMORY_AUTO_PROMOTION_POLICY_VERSION,
} from "@/lib/interactions/memory-promotion";

describe("interaction memory auto promotion", () => {
  it("promotes low-risk high-confidence memories with evidence", () => {
    const decision = evaluateInteractionMemoryPromotion({
      memoryType: "preference",
      subject: "Alice",
      content: "Alice prefers structured proposals before Friday reviews.",
      status: "candidate",
      confidence: 90,
      tags: ["preference"],
      sourceEventIds: ["event-1"],
    });

    expect(INTERACTION_MEMORY_AUTO_PROMOTION_POLICY_VERSION).toBe(
      "wechat-atom-promotion.v1",
    );
    expect(decision).toEqual({
      decision: "promote",
      riskLevel: "low",
      reasons: [
        "low_risk_memory_type",
        "confidence_at_least_85",
        "source_evidence_present",
      ],
    });
  });

  it("keeps financial and trading-like memories in review", () => {
    const decision = evaluateInteractionMemoryPromotion({
      memoryType: "project",
      subject: "模拟盘",
      content: "用户准备买入浪潮信息并加仓，需要后续交易执行。",
      status: "candidate",
      confidence: 96,
      tags: ["股票", "交易"],
      sourceEventIds: ["event-1", "event-2"],
    });

    expect(decision.decision).toBe("review");
    expect(decision.riskLevel).toBe("high");
    expect(decision.reasons).toContain("contains_high_risk_terms");
  });

  it("keeps sensitive psychological observations in review", () => {
    const decision = evaluateInteractionMemoryPromotion({
      memoryType: "relationship",
      subject: "Alice",
      content: "Alice has social anxiety and avoids highly visible roles.",
      status: "candidate",
      confidence: 95,
      tags: ["心理状态", "边界"],
      sourceEventIds: ["event-1", "event-2"],
    });

    expect(decision.decision).toBe("review");
    expect(decision.riskLevel).toBe("high");
    expect(decision.reasons).toContain("contains_high_risk_terms");
  });

  it("requires stronger evidence for project and relationship memories", () => {
    const weakProject = evaluateInteractionMemoryPromotion({
      memoryType: "project",
      subject: "Owner Context",
      content: "WeChat messages should become reusable workspace context.",
      status: "candidate",
      confidence: 86,
      tags: ["product"],
      sourceEventIds: ["event-1"],
    });

    const repeatedProject = evaluateInteractionMemoryPromotion({
      memoryType: "project",
      subject: "Owner Context",
      content: "WeChat messages should become reusable workspace context.",
      status: "candidate",
      confidence: 86,
      tags: ["product"],
      sourceEventIds: ["event-1", "event-2"],
    });

    expect(weakProject.decision).toBe("review");
    expect(weakProject.reasons).toContain("confidence_below_90");
    expect(repeatedProject.decision).toBe("promote");
    expect(repeatedProject.reasons).toContain("confidence_at_least_85");
  });

  it("does not promote memories without source evidence", () => {
    const decision = evaluateInteractionMemoryPromotion({
      memoryType: "person",
      subject: "Alice",
      content: "Alice is a product collaborator.",
      status: "candidate",
      confidence: 95,
      tags: ["person"],
      sourceEventIds: [],
    });

    expect(decision.decision).toBe("review");
    expect(decision.reasons).toContain("missing_source_evidence");
  });

  it("keeps actionable WeChat atoms in review even with high confidence", () => {
    const decision = evaluateInteractionMemoryPromotion({
      memoryType: "preference",
      atomType: "commitment",
      subject: "合同跟进",
      content: "用户答应明天前确认合同条款。",
      status: "candidate",
      confidence: 95,
      tags: ["承诺"],
      sourceEventIds: ["event-1"],
    });

    expect(decision.decision).toBe("review");
    expect(decision.riskLevel).toBe("high");
    expect(decision.reasons).toContain(
      "atom_type_commitment_requires_review",
    );
  });

  it("keeps private or source-limited memories in review", () => {
    const privateDecision = evaluateInteractionMemoryPromotion({
      memoryType: "relationship",
      subject: "Alice",
      content: "Alice prefers discussing personal matters privately.",
      status: "candidate",
      confidence: 96,
      privacyClass: "private",
      tags: ["relationship"],
      sourceEventIds: ["event-1", "event-2"],
    });
    const mentionOnlyDecision = evaluateInteractionMemoryPromotion({
      memoryType: "preference",
      subject: "项目群",
      content: "项目群只在明确 @ 用户时进入完整处理。",
      status: "candidate",
      confidence: 96,
      sourcePolicy: "mention_only",
      tags: ["source_policy"],
      sourceEventIds: ["event-1"],
    });

    expect(privateDecision.decision).toBe("review");
    expect(privateDecision.reasons).toContain(
      "privacy_class_private_requires_review",
    );
    expect(mentionOnlyDecision.decision).toBe("review");
    expect(mentionOnlyDecision.reasons).toContain(
      "source_policy_mention_only_requires_review",
    );
  });

  it("honors metadata facets when direct promotion fields are absent", () => {
    const decision = evaluateInteractionMemoryPromotion({
      memoryType: "preference",
      subject: "报价",
      content: "用户偏好报价相关事项先人工确认。",
      status: "candidate",
      confidence: 96,
      tags: ["报价"],
      sourceEventIds: ["event-1"],
      metadata: {
        facets: {
          atomType: "decision",
          privacyClass: "normal",
          riskLevel: "medium",
        },
      },
    });

    expect(decision.decision).toBe("review");
    expect(decision.reasons).toContain("atom_type_decision_requires_review");
    expect(decision.reasons).toContain("risk_level_medium_requires_review");
  });
});
