import { describe, expect, it } from "vitest";
import { resolveWorkshopSdkAllowedTools } from "@/lib/workshops/tool-access";
import { buildAgentToolMatrix } from "@/lib/agent-tools/matrix";

describe("shared tool identity policy", () => {
  for (const [role, tool] of [["watchlist_selector", "quantPaperPlaceOrder"], ["watchlist_selector", "quantPaperCancelOrder"], ["paper_trader", "quantPaperProposeWatchlistChange"], ["paper_trader", "quantCandidatePoolMaintain"]]) {
    it(`${role} cannot obtain ${tool} by adding it to allowedTools`, () => {
      const workshop = { autonomyLevel: "draft", boundaryPolicy: {}, modelConfig: { role, allowedTools: [tool] } };
      expect(resolveWorkshopSdkAllowedTools(workshop, [tool, `mcp__workshop-tools__${tool}`])).toEqual([]);
      expect(buildAgentToolMatrix({ runtime: "workshop", workshop }).tools.find((entry) => entry.name === tool)?.availability).toBe("deny");
    });
  }
  it("canonicalizes both sides of MCP aliases so denied always wins", () => {
    expect(resolveWorkshopSdkAllowedTools({ modelConfig: { allowedTools: ["quantRuleEvaluate"], disallowedTools: ["mcp__workshop-tools__quantRuleEvaluate"] } }, ["quantRuleEvaluate", "mcp__workshop-tools__quantRuleEvaluate"])).toEqual([]);
  });
});
