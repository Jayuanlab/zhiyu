import { describe, expect, it } from "vitest";
import {
  buildWorkshopRuntimeToolPolicy,
  classifyWorkshopRuntimeTool,
  summarizeWorkshopRuntimeToolClassifications,
} from "@/lib/workshops/tool-classification";
import { resolveWorkshopRuntimeWithPiGreyDefault } from "@/lib/workshops/pi-runtime-readiness";

describe("workshop runtime tool classification", () => {
  it("allows read-only observation tools including MCP aliases", () => {
    expect(classifyWorkshopRuntimeTool("aStockQuote")).toMatchObject({
      leafName: "astockquote",
      risk: "read",
      defaultDecision: "allow",
    });
    expect(classifyWorkshopRuntimeTool("quantMarketDiscoverCandidates")).toMatchObject({
      leafName: "quantmarketdiscovercandidates",
      risk: "read",
      defaultDecision: "allow",
    });
    expect(
      classifyWorkshopRuntimeTool("mcp__workshop-tools__workshopReadMemory"),
    ).toMatchObject({
      leafName: "workshopreadmemory",
      risk: "read",
      defaultDecision: "allow",
    });
  });

  it("keeps proposals and internal writes behind approval", () => {
    expect(classifyWorkshopRuntimeTool("workshopProposeAgentChange")).toMatchObject({
      risk: "proposal",
      defaultDecision: "require_approval",
    });
    expect(classifyWorkshopRuntimeTool("workshopWriteMemory")).toMatchObject({
      risk: "internal_write",
      defaultDecision: "require_approval",
    });
  });

  it("separates external effects from high-risk trading controls", () => {
    expect(classifyWorkshopRuntimeTool("workshopCreateOutboxDraft")).toMatchObject({
      risk: "external_effect",
      defaultDecision: "require_approval",
    });
    expect(classifyWorkshopRuntimeTool("wechatCreateReplyDraft")).toMatchObject({
      risk: "external_effect",
      defaultDecision: "require_approval",
    });
    expect(classifyWorkshopRuntimeTool("videoGenerateInvestmentBrief")).toMatchObject({
      risk: "external_effect",
      defaultDecision: "require_approval",
    });
    expect(classifyWorkshopRuntimeTool("douyinPublishApprovedDraft")).toMatchObject({
      risk: "external_effect",
      defaultDecision: "require_approval",
    });
    expect(classifyWorkshopRuntimeTool("quantPaperPlaceOrder")).toMatchObject({
      risk: "high_risk",
      defaultDecision: "deny",
    });
  });

  it("denies unclassified tools by default and builds guard policy buckets", () => {
    expect(classifyWorkshopRuntimeTool("unknownDangerTool")).toMatchObject({
      risk: "high_risk",
      defaultDecision: "deny",
    });
    expect(
      buildWorkshopRuntimeToolPolicy([
        "aStockQuote",
        "workshopWriteMemory",
        "quantPaperPlaceOrder",
      ]),
    ).toEqual({
      allowedTools: ["aStockQuote"],
      requiresApprovalTools: ["workshopWriteMemory"],
      deniedTools: ["quantPaperPlaceOrder"],
      defaultDecision: "deny",
    });
    expect(
      summarizeWorkshopRuntimeToolClassifications([
        "aStockQuote",
        "workshopWriteMemory",
        "quantPaperPlaceOrder",
      ]),
    ).toMatchObject({
      schemaVersion: "workshop-runtime-tool-classification.v1",
      total: 3,
      counts: {
        read: 1,
        internal_write: 1,
        high_risk: 1,
      },
      decisions: {
        allow: 1,
        require_approval: 1,
        deny: 1,
      },
    });
  });

  it("promotes default Work runtime to Pi only for eligible grey tool sets", () => {
    expect(
      resolveWorkshopRuntimeWithPiGreyDefault({
        runtimeSelection: { engine: "claude", source: "default" },
        tools: [
          "quantMarketDiscoverCandidates",
          "quantPaperGetWatchlist",
          "quantPaperProposeWatchlistChange",
          "workshopLogEvent",
        ],
      }),
    ).toMatchObject({
      runtimeSelection: { engine: "pi", source: "default" },
      defaultPiSelected: true,
      piGreyReadiness: {
        requested: true,
        eligible: true,
        status: "eligible",
      },
    });

    expect(
      resolveWorkshopRuntimeWithPiGreyDefault({
        runtimeSelection: { engine: "claude", source: "default" },
        tools: ["quantPaperGetWatchlist", "quantPaperPlaceOrder"],
      }),
    ).toMatchObject({
      runtimeSelection: { engine: "claude", source: "default" },
      defaultPiSelected: false,
      piGreyReadiness: {
        requested: false,
        eligible: false,
        status: "not_requested",
      },
    });
  });
});
