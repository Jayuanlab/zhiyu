import { describe, expect, it } from "vitest";
import { LOOP_WORKSHOP_ALLOWED_TOOLS, WORKSHOP_ALLOWED_TOOLS } from "@/lib/workshops/executor-tools";
import { buildWorkshopToolProfile } from "@/lib/workshops/tool-profile";
import { resolveWorkshopSdkAllowedTools } from "@/lib/workshops/tool-access";

describe("quantRuleEvaluate runtime whitelist", () => {
  for (const [executor, baseTools] of [["loop", LOOP_WORKSHOP_ALLOWED_TOOLS], ["workshop", WORKSHOP_ALLOWED_TOOLS]] as const) {
    it.each(["cheap", "normal", "full"] as const)(`${executor} exposes direct and MCP tools in %s profile`, (contextProfile) => {
      const workshop = { modelConfig: { role: "trader", allowedTools: ["quantRuleEvaluate"] } };
      const profile = buildWorkshopToolProfile({ workshop, contextProfile, baseTools });
      expect(resolveWorkshopSdkAllowedTools(workshop, profile.tools)).toEqual(expect.arrayContaining([
        "quantRuleEvaluate", "mcp__workshop-tools__quantRuleEvaluate",
      ]));
    });
    it(`${executor} removes denied rules even when requested`, () => {
      const workshop = { modelConfig: { allowedTools: ["quantRuleEvaluate"], disallowedTools: ["quantRuleEvaluate"] } };
      const profile = buildWorkshopToolProfile({ workshop, contextProfile: "full", baseTools });
      const tools = resolveWorkshopSdkAllowedTools(workshop, profile.tools);
      expect(tools).not.toContain("quantRuleEvaluate");
      expect(tools).not.toContain("mcp__workshop-tools__quantRuleEvaluate");
    });
  }
});
