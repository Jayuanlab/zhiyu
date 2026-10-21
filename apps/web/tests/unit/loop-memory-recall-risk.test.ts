import { describe, expect, it } from "vitest";
import { resolveLoopMemoryRecallRiskLevel } from "@/lib/loops/memory-recall-risk";

describe("Loop recall risk from effective action grants", () => {
  it("does not treat blocked or ungranted financial/external names as high-risk permissions", () => {
    expect(resolveLoopMemoryRecallRiskLevel({ allowed: ["webReadPage", "workingMemory", "workshopReadMemory"],
      denied: ["wechatSendMessage", "quantPaperPlaceOrder", "paymentTransfer", "Bash"],
      requiresApproval: ["realBrokerPlaceOrder"] })).toBe("normal");
    expect(resolveLoopMemoryRecallRiskLevel({ allowed: [], denied: [], requiresApproval: ["wechatSendMessage"] })).toBe("normal");
  });
  it("normalizes MCP leaf names and denies before considering grants", () => {
    expect(resolveLoopMemoryRecallRiskLevel({ allowed: ["mcp__business_tools__WeChatSendMessage", "mcp__tools__quantPaperPlaceOrder", "webReadPage"],
      denied: ["wechat-send-message", "MCP__other__QUANTPAPERPLACEORDER"] })).toBe("normal");
    expect(resolveLoopMemoryRecallRiskLevel({ allowed: ["paymentTransfer"], denied: ["*"] })).toBe("normal");
  });
  it.each(["wechatSendMessage", "mcp__business__quantPaperPlaceOrder", "quantPaperCancelOrder", "realBrokerPlaceOrder", "paymentTransfer", "sendEmail"])("keeps a granted %s capability high-risk", name => {
    expect(resolveLoopMemoryRecallRiskLevel({ allowed: [name], denied: ["unrelatedTool"] })).toBe("high");
  });
  it("accepts normalized action-policy aliases without changing the policy", () => {
    const policy = { allowedTools: ["mcp__business__quantPaperPlaceOrder", "webReadPage"], deniedTools: ["quantPaperPlaceOrder"] };
    const original = structuredClone(policy);
    expect(resolveLoopMemoryRecallRiskLevel(policy)).toBe("normal");
    expect(policy).toEqual(original);
  });
});
