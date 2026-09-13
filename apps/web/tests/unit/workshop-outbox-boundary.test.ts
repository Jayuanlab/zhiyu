import { describe, expect, it } from "vitest";
import type { Workshop, WorkshopOutboxItem } from "@/lib/db/schema";
import {
  evaluateWorkshopOutboxBoundary,
  workshopAllowsSuggestedActionOutbox,
} from "@/lib/workshops/outbox-boundary";

describe("workshop suggested-action outbox boundary", () => {
  it("blocks post-run drafts when external messages are blocked", () => {
    expect(
      workshopAllowsSuggestedActionOutbox({
        boundaryPolicy: { externalMessages: "blocked" },
        modelConfig: {},
        actionPolicy: {},
      }),
    ).toBe(false);
  });

  it("blocks post-run drafts when the outbox tool is denied", () => {
    expect(
      workshopAllowsSuggestedActionOutbox({
        boundaryPolicy: {},
        modelConfig: { disallowedTools: ["workshopCreateOutboxDraft"] },
        actionPolicy: {},
      }),
    ).toBe(false);
  });

  it("keeps legacy draft behavior when no boundary blocks it", () => {
    expect(
      workshopAllowsSuggestedActionOutbox({
        boundaryPolicy: {},
        modelConfig: {},
        actionPolicy: {},
      }),
    ).toBe(true);
  });
});

describe("workshop outbox send boundary", () => {
  const workshop = {
    autonomyLevel: "auto",
    boundaryPolicy: {
      mode: "auto",
      externalMessages: "auto",
      allowWechatPreview: true,
      allowedRecipients: ["\u7238"],
      requireSourcesForOutbox: true,
      minConfidenceToDraft: 60,
      minConfidenceToSend: 75,
    },
  } as unknown as Workshop;

  const baseOutbox = {
    channel: "wechat_desktop",
    recipientName: "\u7238",
    confidence: 85,
    riskLevel: "medium",
    sourceEventIds: ["source-1"],
  } as WorkshopOutboxItem;

  it("auto-sends ETF timing reports that mention all-in conditions without order instructions", () => {
    const result = evaluateWorkshopOutboxBoundary({
      workshop,
      action: "send",
      outbox: {
        ...baseOutbox,
        message:
          "515980 \u5de1\u68c0\uff1a\u5168\u4ed3\u4e70\u5165\u6761\u4ef6\u4e0d\u6ee1\u8db3\uff0c\u5168\u4ed3\u5356\u51fa\u4e0d\u9002\u7528\u3002\u6570\u636e\u6765\u6e90\uff1aaStockQuote\u3002",
      } as WorkshopOutboxItem,
    });

    expect(result.violations).toEqual([]);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("blocks direct all-in trading commands", () => {
    const result = evaluateWorkshopOutboxBoundary({
      workshop,
      action: "send",
      outbox: {
        ...baseOutbox,
        message:
          "\u8bf7\u9a6c\u4e0a\u5168\u4ed3\u4e70\u5165 515980 \u5e76\u4e0b\u5355",
      } as WorkshopOutboxItem,
    });

    expect(result.allowed).toBe(false);
    expect(result.violations).toContain(
      "Trading order instructions cannot be sent through WeChat.",
    );
  });
});
