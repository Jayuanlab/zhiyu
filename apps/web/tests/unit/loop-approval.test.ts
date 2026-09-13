import { describe, expect, it } from "vitest";
import {
  classifyLoopAction,
  decideLoopActionApproval,
  evaluateLoopApprovals,
  extractActionNamesFromJobResult,
} from "@/lib/loops";

describe("loop approval policy", () => {
  it("classifies common action names", () => {
    expect(classifyLoopAction("searchUnifiedMemory")).toBe("read");
    expect(classifyLoopAction("modifyInsight")).toBe("write_internal");
    expect(classifyLoopAction("sendMessage")).toBe("write_external");
    expect(classifyLoopAction("Bash")).toBe("dangerous");
  });

  it("classifies paper trading tools as simulator-scoped capabilities", () => {
    expect(classifyLoopAction("quantPaperGetAccount")).toBe("read");
    expect(classifyLoopAction("quantRuleEvaluate")).toBe("read");
    expect(classifyLoopAction("quantTradePlanList")).toBe("read");
    expect(classifyLoopAction("mcp__workshop-tools__quantRuleEvaluate")).toBe(
      "read",
    );
    expect(classifyLoopAction("mcp__workshop-tools__quantPaperGetWatchlist")).toBe(
      "read",
    );
    expect(classifyLoopAction("aStockQuote")).toBe("read");
    expect(classifyLoopAction("aStockTrendSystem")).toBe("read");
    expect(classifyLoopAction("aStockTrendStateHistory")).toBe("read");
    expect(classifyLoopAction("aStockEtfHoldings")).toBe("read");
    expect(classifyLoopAction("quantPaperPlaceOrder")).toBe("write_internal");
    expect(classifyLoopAction("quantTradePlanUpsert")).toBe("write_internal");
    expect(classifyLoopAction("quantTradePlanReview")).toBe("write_internal");
    expect(classifyLoopAction("mcp__workshop-tools__quantPaperCancelOrder")).toBe(
      "write_internal",
    );
  });

  it("classifies owner context tools as internal knowledge operations", () => {
    expect(classifyLoopAction("ownerContextListCandidates")).toBe("read");
    expect(classifyLoopAction("mcp__workshop-tools__ownerContextGetEvidence")).toBe(
      "read",
    );
    expect(classifyLoopAction("ownerContextProcessRecordedMessages")).toBe(
      "write_internal",
    );
    expect(
      classifyLoopAction("mcp__workshop-tools__ownerContextReviewCandidate"),
    ).toBe("write_internal");
  });

  it("classifies Douyin publisher tools by external visibility", () => {
    expect(classifyLoopAction("douyinCheckAccount")).toBe("read");
    expect(classifyLoopAction("douyinCreatePublishDraft")).toBe(
      "write_internal",
    );
    expect(classifyLoopAction("douyinPrepareUpload")).toBe("write_external");
    expect(
      classifyLoopAction("mcp__workshop-tools__douyinPublishApprovedDraft"),
    ).toBe("write_external");
  });

  it("classifies video generation as an internal artifact write", () => {
    expect(classifyLoopAction("videoRenderInvestmentBrief")).toBe(
      "write_internal",
    );
    expect(
      classifyLoopAction("mcp__workshop-tools__videoRenderInvestmentBrief"),
    ).toBe("write_internal");
    expect(classifyLoopAction("videoGenerateInvestmentBrief")).toBe(
      "write_internal",
    );
    expect(
      classifyLoopAction("mcp__workshop-tools__videoGenerateInvestmentBrief"),
    ).toBe("write_internal");
  });

  it("classifies workshop tools by internal workshop boundary", () => {
    expect(classifyLoopAction("workshopReadLinkedWorkshopEvents")).toBe("read");
    expect(classifyLoopAction("mcp__workshop-tools__workshopSearchMemory")).toBe(
      "read",
    );
    expect(classifyLoopAction("workshopLogEvent")).toBe("write_internal");
    expect(classifyLoopAction("workshopWriteMemory")).toBe("write_internal");
    expect(classifyLoopAction("workshopCreateOutboxDraft")).toBe(
      "write_external",
    );
  });

  it("requires approval for external writes by default", () => {
    const decision = decideLoopActionApproval({
      actionName: "sendEmail",
      actionPolicy: {},
      approvalPolicy: {},
    });

    expect(decision).toMatchObject({
      capability: "write_external",
      decision: "require_approval",
    });
  });

  it("honors explicit allowed, requires approval, and denied action lists", () => {
    expect(
      decideLoopActionApproval({
        actionName: "sendMessage",
        actionPolicy: { allowed: ["sendMessage"] },
        approvalPolicy: { externalWrites: "require_approval" },
      }).decision,
    ).toBe("allow");

    expect(
      decideLoopActionApproval({
        actionName: "mcp__workshop-tools__quantRuleEvaluate",
        actionPolicy: { allowed: ["quantRuleEvaluate"] },
        approvalPolicy: { defaultMode: "allow" },
      }).decision,
    ).toBe("allow");

    expect(
      decideLoopActionApproval({
        actionName: "modifyInsight",
        actionPolicy: { requiresApproval: ["modifyInsight"] },
        approvalPolicy: { defaultMode: "allow" },
      }).decision,
    ).toBe("require_approval");

    expect(
      decideLoopActionApproval({
        actionName: "deleteInsight",
        actionPolicy: { denied: ["deleteInsight"] },
        approvalPolicy: { defaultMode: "allow" },
      }).decision,
    ).toBe("deny");
  });

  it("denies dangerous actions even when default mode allows", () => {
    const decision = decideLoopActionApproval({
      actionName: "sudo rm -rf",
      actionPolicy: {},
      approvalPolicy: { defaultMode: "allow", externalWrites: "allow" },
    });

    expect(decision).toMatchObject({
      capability: "dangerous",
      decision: "deny",
    });
  });

  it("extracts external suggested action names from structured job results", () => {
    const actions = extractActionNamesFromJobResult({
      status: "success",
      duration: 1,
      result: {
        structuredReport: {
          suggestedActions: [
            { type: "send_message", label: "Send Slack update" },
            { type: "create_task", label: "Create Jira follow-up" },
          ],
        },
      },
    });

    expect(actions).toEqual(["Send Slack update", "send_message"]);
  });

  it("summarizes loop approval evaluation", () => {
    const evaluation = evaluateLoopApprovals({
      actionNames: ["searchUnifiedMemory", "sendMessage", "Bash"],
      actionPolicy: {},
      approvalPolicy: {},
    });

    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.denied).toBe(true);
    expect(evaluation.decisions.map((decision) => decision.decision)).toEqual([
      "allow",
      "require_approval",
      "deny",
    ]);
  });
});
