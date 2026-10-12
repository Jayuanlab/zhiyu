import { describe, expect, it } from "vitest";
import type { Workshop } from "@/lib/db/schema";
import { evaluateLoopActionGuard, decideLoopToolPermission } from "@/lib/loops";
import { getWorkshopBoundaryPolicy, serializeWorkshopBoundaryPolicy, workshopBoundaryToLoopPolicies } from "@/lib/workshops/boundary-policy";

const now = new Date("2026-07-06T00:00:00.000Z");

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "Boundary workshop",
    mission: "Run bounded automation.",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: {
      externalMessages: "draft",
      allowWechatPreview: true,
      requireSourcesForOutbox: true,
      allowedRecipients: ["Alice"],
      minConfidenceToDraft: 60,
      minConfidenceToSend: 75,
      maxMessageLength: 2000,
    },
    modelConfig: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

describe("workshop boundary to loop policy bridge", () => {
  it("keeps authorized code observation tools available when external writes are blocked", () => {
    const tools = ["Read", "Glob", "Grep", "mcp__workshop-tools__Grep"];
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop({ autonomyLevel: "observe", boundaryPolicy: { externalMessages: "blocked" } }),
      actionPolicy: { allowed: tools, requiresApproval: [], denied: [] },
      approvalPolicy: { defaultMode: "allow", externalWrites: "deny" },
    });

    expect(bridge.actionPolicy.allowed).toEqual(["Read", "Glob", "Grep"]);
    expect(bridge.metadata.movedAllowedExternalActions).toEqual([]);
    for (const toolName of tools) {
      expect(bridge.metadata.hardDeniedActions).not.toContain(toolName);
      expect(decideLoopToolPermission({
        toolName, actionPolicy: bridge.actionPolicy, approvalPolicy: bridge.approvalPolicy,
      })).toMatchObject({ decision: "allow", behavior: "allow" });
    }
  });

  it("preserves explicit code observation denials despite an allowed entry", () => {
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop({ autonomyLevel: "observe", boundaryPolicy: { externalMessages: "blocked" } }),
      actionPolicy: {
        allowed: ["Read", "Glob", "Grep"],
        requiresApproval: ["Grep"],
        denied: ["mcp__workshop-tools__Glob", "grep"],
      },
      approvalPolicy: { defaultMode: "allow", externalWrites: "deny" },
    });

    expect(bridge.actionPolicy.allowed).toEqual(["Read"]);
    expect(bridge.actionPolicy.requiresApproval).toEqual([]);
    for (const toolName of ["Glob", "Grep"]) {
      expect(decideLoopToolPermission({
        toolName, actionPolicy: bridge.actionPolicy, approvalPolicy: bridge.approvalPolicy,
      })).toMatchObject({ decision: "deny", behavior: "deny" });
    }
  });

  it("continues moving unknown tools behind the external write boundary", () => {
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop(),
      actionPolicy: { allowed: ["Glob", "unclassifiedTool", "grepAndSend"], denied: [] },
      approvalPolicy: { defaultMode: "allow", externalWrites: "allow" },
    });

    expect(bridge.actionPolicy.allowed).toEqual(["Glob"]);
    expect(bridge.actionPolicy.requiresApproval).toEqual(["unclassifiedTool", "grepAndSend"]);
    expect(bridge.metadata.movedAllowedExternalActions).toEqual(["unclassifiedTool", "grepAndSend"]);
    for (const toolName of ["unclassifiedTool", "grepAndSend"]) {
      expect(decideLoopToolPermission({
        toolName, actionPolicy: bridge.actionPolicy, approvalPolicy: bridge.approvalPolicy,
      })).toMatchObject({ decision: "require_approval" });
    }
  });

  it("retains explicit hard denials through a boundary edit", () => {
    const current = getWorkshopBoundaryPolicy(workshop({ boundaryPolicy: {
      mode: "auto", externalMessages: "blocked", hardDeniedActions: ["quantPaperPlaceOrder"],
      deniedPrecedence: true,
    } }));
    const saved = serializeWorkshopBoundaryPolicy({ ...current, maxMessageLength: 1000 });
    expect(saved.hardDeniedActions).toEqual(["quantPaperPlaceOrder"]);
    expect(saved.deniedPrecedence).toBe(true);
    expect(saved.maxMessageLength).toBe(1000);
  });
  it("denies external writes when the workshop blocks external messages", () => {
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop({
        autonomyLevel: "observe",
        boundaryPolicy: {
          externalMessages: "blocked",
        },
      }),
      actionPolicy: {
        allowed: ["chatInsight", "wechatDesktopSendMessage"],
        requiresApproval: [],
        denied: [],
      },
      approvalPolicy: {
        defaultMode: "allow",
        externalWrites: "allow",
      },
    });

    expect(bridge.approvalPolicy).toMatchObject({
      externalWrites: "deny",
    });
    expect(bridge.actionPolicy).toMatchObject({
      allowed: ["chatInsight"],
    });

    const decision = decideLoopToolPermission({
      toolName: "wechatDesktopSendMessage",
      actionPolicy: bridge.actionPolicy,
      approvalPolicy: bridge.approvalPolicy,
    });

    expect(decision).toMatchObject({
      decision: "deny",
      behavior: "deny",
    });
  });

  it("downgrades explicitly allowed external writes to approval-required drafts", () => {
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop(),
      actionPolicy: {
        allowed: ["chatInsight", "wechatDesktopSendMessage"],
        requiresApproval: [],
        denied: [],
      },
      approvalPolicy: {
        defaultMode: "allow",
        externalWrites: "allow",
      },
    });

    expect(bridge.approvalPolicy).toMatchObject({
      externalWrites: "require_approval",
    });
    expect(bridge.actionPolicy).toMatchObject({
      allowed: ["chatInsight"],
      requiresApproval: ["wechatDesktopSendMessage"],
    });

    const guard = evaluateLoopActionGuard({
      mode: "enforce",
      actionNames: ["wechatDesktopSendMessage"],
      actionPolicy: bridge.actionPolicy,
      approvalPolicy: bridge.approvalPolicy,
    });

    expect(guard).toMatchObject({
      blocked: true,
      requiresApproval: true,
    });
  });

  it("allows explicitly configured external writes when the workshop is auto-send capable", () => {
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop({
        autonomyLevel: "auto",
        boundaryPolicy: {
          externalMessages: "auto",
        },
      }),
      actionPolicy: {
        allowed: ["chatInsight", "workshopCreateOutboxDraft"],
        requiresApproval: [],
        denied: [],
      },
      approvalPolicy: {
        defaultMode: "allow",
        externalWrites: "allow",
      },
    });

    expect(bridge.approvalPolicy).toMatchObject({
      externalWrites: "allow",
    });
    expect(bridge.actionPolicy).toMatchObject({
      allowed: ["chatInsight", "workshopCreateOutboxDraft"],
      requiresApproval: [],
    });

    const decision = decideLoopToolPermission({
      toolName: "workshopCreateOutboxDraft",
      actionPolicy: bridge.actionPolicy,
      approvalPolicy: bridge.approvalPolicy,
    });

    expect(decision).toMatchObject({
      decision: "allow",
      behavior: "allow",
    });
  });

  it("hard-denies dangerous financial or destructive actions", () => {
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop({
        autonomyLevel: "auto",
        boundaryPolicy: {
          externalMessages: "auto",
        },
      }),
      actionPolicy: {
        allowed: ["placeOrder", "makePayment", "deleteRecord"],
        requiresApproval: [],
        denied: [],
      },
      approvalPolicy: {
        defaultMode: "allow",
        externalWrites: "allow",
      },
    });

    expect(bridge.actionPolicy.denied).toEqual(
      expect.arrayContaining(["placeOrder", "makePayment", "deleteRecord"]),
    );
    expect(bridge.actionPolicy.allowed).toEqual([]);
  });

  it("keeps paper trading tools available while still blocking real orders", () => {
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop({
        autonomyLevel: "auto",
        boundaryPolicy: {
          externalMessages: "blocked",
        },
      }),
      actionPolicy: {
        allowed: [
          "quantPaperGetAccount",
          "quantPaperGetWatchlist",
          "quantPaperPlaceOrder",
          "aStockQuote",
          "placeOrder",
        ],
        requiresApproval: [],
        denied: [],
      },
      approvalPolicy: {
        defaultMode: "allow",
        externalWrites: "deny",
      },
    });

    expect(bridge.actionPolicy.allowed).toEqual(
      expect.arrayContaining([
        "quantPaperGetAccount",
        "quantPaperGetWatchlist",
        "quantPaperPlaceOrder",
        "aStockQuote",
      ]),
    );
    expect(bridge.actionPolicy.denied).toEqual(
      expect.arrayContaining(["placeOrder"]),
    );
    expect(bridge.actionPolicy.denied).not.toEqual(
      expect.arrayContaining(["quantPaperPlaceOrder"]),
    );
  });

  it("keeps ETF timing read sources available under blocked external messages", () => {
    const bridge = workshopBoundaryToLoopPolicies({
      workshop: workshop({
        autonomyLevel: "auto",
        boundaryPolicy: {
          externalMessages: "blocked",
        },
      }),
      actionPolicy: {
        allowed: [
          "quantTradePlanList",
          "aStockTrendSystem",
          "aStockTrendStateHistory",
          "aStockEtfHoldings",
          "aStockQuote",
          "quantRuleEvaluate",
        ],
        requiresApproval: [],
        denied: [],
      },
      approvalPolicy: {
        defaultMode: "allow",
        externalWrites: "deny",
      },
    });

    expect(bridge.actionPolicy.allowed).toEqual(
      expect.arrayContaining([
        "quantTradePlanList",
        "aStockTrendSystem",
        "aStockTrendStateHistory",
        "aStockEtfHoldings",
        "aStockQuote",
        "quantRuleEvaluate",
      ]),
    );
    expect(bridge.actionPolicy.denied).not.toEqual(
      expect.arrayContaining([
        "quantTradePlanList",
        "aStockTrendSystem",
        "aStockTrendStateHistory",
        "aStockEtfHoldings",
      ]),
    );
    expect(bridge.metadata.movedAllowedExternalActions).toEqual([]);
  });
});
