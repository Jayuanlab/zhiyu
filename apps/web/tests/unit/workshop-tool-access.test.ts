import { describe, expect, it } from "vitest";
import { resolveWorkshopSdkAllowedTools, restrictWorkshopPiRequestedTools } from "@/lib/workshops/tool-access";

const BASE_TOOLS = [
  "Read",
  "Write",
  "Bash",
  "Skill",
  "workshopInspectHarnessQuality",
  "mcp__workshop-tools__workshopInspectHarnessQuality",
  "workshopCreateHarnessProposal",
  "mcp__workshop-tools__workshopCreateHarnessProposal",
  "workshopProposeAgentChange",
  "mcp__workshop-tools__workshopProposeAgentChange",
  "quantPaperPlaceOrder",
];

describe("workshop SDK tool access", () => {
  it("does not widen an explicit Pi Work allowlist with the broad runtime profile", () => {
    const requested = restrictWorkshopPiRequestedTools({modelConfig: {
      allowedTools: ["quantPaperGetWatchlist", "workshopAskColleague"],
    }} as any, ["quantPaperGetWatchlist", "quantPaperGetAccount", "quantPaperPlaceOrder",
      "mcp__workshop-tools__workshopAskColleague"]);
    expect(requested).toEqual(["quantPaperGetWatchlist", "mcp__workshop-tools__workshopAskColleague"]);
  });
  it("enforces configured denied tools for ordinary Works", () => {
    const tools = resolveWorkshopSdkAllowedTools(
      {
        modelConfig: {
          disallowedTools: ["workshopProposeAgentChange"],
        },
      } as any,
      BASE_TOOLS,
    );

    expect(tools).toContain("Read");
    expect(tools).not.toContain("Skill");
    expect(tools).not.toContain("workshopProposeAgentChange");
    expect(tools).not.toContain(
      "mcp__workshop-tools__workshopProposeAgentChange",
    );
  });

  it("gives Harness Quality Work only its explicit proposal-only tools", () => {
    const tools = resolveWorkshopSdkAllowedTools(
      {
        modelConfig: {
          role: "harness_quality_steward",
          allowedTools: [
            "workshopInspectHarnessQuality",
            "workshopCreateHarnessProposal",
          ],
          disallowedTools: [
            "workshopProposeAgentChange",
            "quantPaperPlaceOrder",
          ],
        },
      } as any,
      BASE_TOOLS,
    );

    expect(tools).toEqual([
      "workshopInspectHarnessQuality",
      "mcp__workshop-tools__workshopInspectHarnessQuality",
      "workshopCreateHarnessProposal",
      "mcp__workshop-tools__workshopCreateHarnessProposal",
    ]);
    expect(tools).not.toEqual(
      expect.arrayContaining(["Read", "Write", "Bash", "quantPaperPlaceOrder"]),
    );
  });

  it("keeps Skill only when the Work has configured Skill bindings", () => {
    const tools = resolveWorkshopSdkAllowedTools(
      {
        modelConfig: {
          role: "harness_quality_steward",
          primarySkills: ["harness-quality-control"],
          allowedTools: ["Skill", "workshopInspectHarnessQuality"],
        },
      } as any,
      BASE_TOOLS,
    );

    expect(tools).toEqual([
      "Skill",
      "workshopInspectHarnessQuality",
      "mcp__workshop-tools__workshopInspectHarnessQuality",
    ]);
  });
});
