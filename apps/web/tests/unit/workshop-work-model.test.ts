import { describe, expect, it } from "vitest";
import type { Loop, Workshop, WorkshopHeartbeat } from "@/lib/db/schema";
import type { AgentToolMatrix } from "@/lib/agent-tools/types";
import { buildWorkshopWorkModel } from "@/lib/workshops/work-model";

const now = new Date("2026-08-01T00:00:00.000Z");

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "Watchlist hunter",
    mission: "Maintain paper-trading watchlist.",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: { mode: "draft", externalMessages: "blocked" },
    modelConfig: {
      role: "watchlist_selector",
      primarySkills: ["watchlist-selection-control"],
      loopSkillMap: {
        "Post-close watchlist selection": "watchlist-selection-control",
      },
      allowedTools: [
        "quantMarketDiscoverCandidates",
        "quantPaperGetWatchlist",
        "quantPaperProposeWatchlistChange",
      ],
      disallowedTools: ["quantPaperPlaceOrder"],
      memoryRecallProfiles: [
        {
          id: "watchlist-selection",
          matchTerms: ["candidate", "watchlist"],
          memoryTypeBoosts: { plan: 40, insight: 30 },
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-1",
    userId: "user-1",
    workshopId: "workshop-1",
    name: "Post-close watchlist selection",
    description: null,
    goal: "Review watchlist candidates.",
    status: "active",
    triggerConfig: { type: "cron", expression: "30 18 * * 1-5" },
    contextConfig: {},
    actionPolicy: {
      allowed: ["quantMarketDiscoverCandidates"],
      denied: ["quantPaperPlaceOrder"],
    },
    verificationConfig: {
      requiredFields: [
        "marketScanSummary",
        "currentWatchlistReview",
        "candidatePool",
        "watchlistDecision",
      ],
    },
    approvalPolicy: {},
    retryPolicy: {},
    escalationPolicy: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Loop;
}

function heartbeat(): WorkshopHeartbeat {
  return {
    workshopId: "workshop-1",
    enabled: true,
    mode: "cron",
    nextWakeupAt: new Date("2026-08-03T10:30:00.000Z"),
    lastWakeupAt: null,
    lastHeartbeatAt: null,
    schedulerStatus: "idle",
    schedulerError: null,
    consecutiveFailures: 0,
    leaseUntil: null,
    heartbeatPolicy: {},
    createdAt: now,
    updatedAt: now,
  } as WorkshopHeartbeat;
}

function toolMatrix(): AgentToolMatrix {
  return {
    runtime: "workshop",
    workshopId: "workshop-1",
    generatedAt: now.toISOString(),
    counts: {
      total: 3,
      allow: 1,
      requireApproval: 1,
      deny: 1,
      disabled: 0,
      unknown: 0,
      bySource: {
        claude_builtin: 0,
        pi_builtin: 0,
        business_tools: 0,
        workshop_tools: 3,
        skill: 0,
        user_mcp: 0,
      },
      byRisk: {
        low: 1,
        medium: 1,
        high: 1,
        critical: 0,
      },
    },
    tools: [
      {
        id: "workshop:quantPaperGetWatchlist",
        name: "quantPaperGetWatchlist",
        displayName: "quantPaperGetWatchlist",
        source: "workshop_tools",
        description: "Read watchlist.",
        capabilities: ["market_data"],
        risk: "low",
        runtimeScopes: ["workshop", "loop"],
        availability: "allow",
        decisionReason: "allowed",
      },
      {
        id: "workshop:quantPaperProposeWatchlistChange",
        name: "quantPaperProposeWatchlistChange",
        displayName: "quantPaperProposeWatchlistChange",
        source: "workshop_tools",
        description: "Create and auto-apply validated watchlist changes.",
        capabilities: ["task_create"],
        risk: "medium",
        runtimeScopes: ["workshop", "loop"],
        availability: "allow",
        decisionReason: "auto apply after validation",
      },
      {
        id: "workshop:quantPaperPlaceOrder",
        name: "quantPaperPlaceOrder",
        displayName: "quantPaperPlaceOrder",
        source: "workshop_tools",
        description: "Place paper order.",
        capabilities: ["unknown"],
        risk: "high",
        runtimeScopes: ["workshop", "loop"],
        availability: "deny",
        decisionReason: "role boundary",
      },
    ],
  };
}

function readOnlyToolMatrix(): AgentToolMatrix {
  return {
    ...toolMatrix(),
    tools: [
      {
        id: "workshop:quantPaperGetWatchlist",
        name: "quantPaperGetWatchlist",
        displayName: "quantPaperGetWatchlist",
        source: "workshop_tools",
        description: "Read watchlist.",
        capabilities: ["market_data"],
        risk: "low",
        runtimeScopes: ["workshop", "loop"],
        availability: "allow",
        decisionReason: "allowed",
      },
    ],
  };
}

function highRiskAllowedToolMatrix(): AgentToolMatrix {
  return {
    ...readOnlyToolMatrix(),
    tools: [
      ...readOnlyToolMatrix().tools,
      {
        id: "workshop:quantPaperPlaceOrder",
        name: "quantPaperPlaceOrder",
        displayName: "quantPaperPlaceOrder",
        source: "workshop_tools",
        description: "Place paper order.",
        capabilities: ["unknown"],
        risk: "high",
        runtimeScopes: ["workshop", "loop"],
        availability: "allow",
        decisionReason: "test override",
      },
    ],
  };
}

describe("workshop work model", () => {
  it("derives a bounded Work model from existing workshop state", () => {
    const model = buildWorkshopWorkModel({
      workshop: workshop(),
      loops: [loop()],
      heartbeat: heartbeat(),
      toolMatrix: toolMatrix(),
      availableSkillNames: ["watchlist-selection-control"],
    });

    expect(model.manifest).toMatchObject({
      id: "workshop-1",
      role: "watchlist_selector",
      status: "active",
    });
    expect(model.controlContract.controlledObjects).toEqual(
      expect.arrayContaining([
        "market_candidate_pool",
        "core_watchlist_pool",
        "trading_watchlist_pool",
        "holding_watchlist_pool",
      ]),
    );
    expect(model.controlContract.allowedActions).toContain(
      "quantPaperGetWatchlist",
    );
    expect(model.controlContract.allowedActions).toContain(
      "quantPaperProposeWatchlistChange",
    );
    expect(model.controlContract.approvalRequiredActions).not.toContain(
      "quantPaperProposeWatchlistChange",
    );
    expect(model.controlContract.deniedActions).toContain("quantPaperPlaceOrder");
    expect(model.skillBindings.missingSkills).toEqual([]);
    expect(model.memoryPolicy.recallProfiles).toEqual([
      {
        id: "watchlist-selection",
        matchTerms: ["candidate", "watchlist"],
        memoryTypeBoosts: { plan: 40, insight: 30 },
      },
    ]);
    expect(model.loopBindings[0]).toMatchObject({
      skillName: "watchlist-selection-control",
      skillStatus: "bound",
      hasVerification: true,
    });
    expect(model.presentationContract).toEqual({
      audience: "owner",
      reportFormat: "markdown",
      purpose: "Maintain paper-trading watchlist.",
      requiredSections: ["conclusion", "evidence", "actions", "limitations", "next_steps"],
      expectedArtifacts: [],
      evidenceSource: "run_events",
      artifactSource: "run_receipts",
      statusSource: "run_lifecycle",
      source: "default",
    });
    expect(model.runtime).toMatchObject({
      engine: "pi",
      source: "default",
      piGreyReadiness: {
        requested: true,
        eligible: true,
        status: "eligible",
      },
    });
    expect(model.runtime.piGreyReadiness.nextSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "run_isolated_grey" }),
      ]),
    );
  });

  it("keeps default Work runtime on Claude when Pi grey readiness is blocked", () => {
    const model = buildWorkshopWorkModel({
      workshop: workshop({
        modelConfig: {
          role: "general",
          allowedTools: [
            "quantPaperGetWatchlist",
            "quantPaperPlaceOrder",
          ],
        },
      }),
      loops: [loop()],
      heartbeat: heartbeat(),
      toolMatrix: highRiskAllowedToolMatrix(),
      availableSkillNames: ["watchlist-selection-control"],
    });

    expect(model.runtime).toMatchObject({
      engine: "claude",
      source: "default",
      piGreyReadiness: {
        requested: false,
        eligible: false,
        status: "not_requested",
      },
    });
  });

  it("marks explicit Pi runtime eligible only for read and migrated reviewable write tools", () => {
    const model = buildWorkshopWorkModel({
      workshop: workshop({
        modelConfig: {
          role: "general",
          agentRuntimeEngine: "pi",
          allowedTools: [
            "quantPaperGetWatchlist",
            "quantPaperProposeWatchlistChange",
            "workshopLogEvent",
            "workshopProposeAgentChange",
            "workshopWriteMemory",
          ],
        },
      }),
      loops: [loop()],
      heartbeat: heartbeat(),
      toolMatrix: readOnlyToolMatrix(),
      availableSkillNames: ["watchlist-selection-control"],
    });

    expect(model.runtime).toMatchObject({
      engine: "pi",
      source: "config",
      piGreyReadiness: {
        requested: true,
        eligible: true,
        status: "eligible",
        migratedWriteTools: [
          "quantPaperProposeWatchlistChange",
          "workshopLogEvent",
          "workshopProposeAgentChange",
          "workshopWriteMemory",
        ],
        policyScopedMigratedWriteTools: [
          "quantPaperProposeWatchlistChange",
        ],
        nextSteps: [
          expect.objectContaining({ code: "run_isolated_grey" }),
        ],
      },
    });
  });

  it("uses the same env runtime override as the executor selection", () => {
    const originalRuntime = process.env.WORKSHOP_AGENT_RUNTIME;
    process.env.WORKSHOP_AGENT_RUNTIME = "pi";
    try {
      const model = buildWorkshopWorkModel({
        workshop: workshop({
          modelConfig: {
            role: "general",
            allowedTools: ["quantPaperGetWatchlist"],
          },
        }),
        loops: [loop()],
        heartbeat: heartbeat(),
        toolMatrix: readOnlyToolMatrix(),
        availableSkillNames: ["watchlist-selection-control"],
      });

      expect(model.runtime).toMatchObject({
        engine: "pi",
        source: "env",
        piGreyReadiness: {
          requested: true,
          eligible: true,
          status: "eligible",
          nextSteps: [
            expect.objectContaining({ code: "run_isolated_grey" }),
          ],
        },
      });
    } finally {
      if (originalRuntime === undefined) {
        delete process.env.WORKSHOP_AGENT_RUNTIME;
      } else {
        process.env.WORKSHOP_AGENT_RUNTIME = originalRuntime;
      }
    }
  });

  it("surfaces Pi grey blockers in the Work model", () => {
    const model = buildWorkshopWorkModel({
      workshop: workshop({
        modelConfig: {
          role: "general",
          agentRuntimeEngine: "pi",
          allowedTools: [
            "quantPaperGetWatchlist",
            "quantPaperProposeWatchlistChange",
            "quantPaperPlaceOrder",
          ],
        },
      }),
      loops: [loop()],
      heartbeat: heartbeat(),
      toolMatrix: highRiskAllowedToolMatrix(),
      availableSkillNames: ["watchlist-selection-control"],
    });

    expect(model.runtime.piGreyReadiness).toMatchObject({
      requested: true,
      eligible: false,
      status: "blocked",
      blockedTools: [
        expect.objectContaining({ toolName: "quantPaperPlaceOrder" }),
      ],
      migratedWriteTools: ["quantPaperProposeWatchlistChange"],
      policyScopedMigratedWriteTools: ["quantPaperProposeWatchlistChange"],
      needsMigrationTools: [],
      nextSteps: [
        expect.objectContaining({
          code: "remove_or_split_blocked_tools",
          toolNames: ["quantPaperPlaceOrder"],
        }),
      ],
    });
    expect(model.observability.warnings).toEqual(
      expect.arrayContaining([
        "Pi grey run is blocked by high-risk or denied tools.",
      ]),
    );
  });

  it("surfaces missing skills and unmapped loops as observability warnings", () => {
    const model = buildWorkshopWorkModel({
      workshop: workshop({
        modelConfig: {
          role: "paper_trader",
          primarySkills: ["missing-skill"],
          loopSkillMap: {},
          allowedTools: ["aStockQuote", "quantPaperPlaceOrder"],
          disallowedTools: ["quantPaperPlaceOrder"],
        },
      }),
      loops: [loop({ name: "Intraday check", verificationConfig: {} })],
      heartbeat: null,
      toolMatrix: toolMatrix(),
      availableSkillNames: [],
    });

    expect(model.skillBindings.missingSkills).toEqual(["missing-skill"]);
    expect(model.controlContract.conflicts).toEqual([
      { kind: "allowed_and_denied", tool: "quantPaperPlaceOrder" },
    ]);
    expect(model.loopBindings[0]).toMatchObject({
      skillName: null,
      skillStatus: "unmapped",
      requiredFields: [],
    });
    expect(model.observability.warnings).toEqual(
      expect.arrayContaining([
        "Some configured Skills are missing.",
        'Loop "Intraday check" has no Skill mapping.',
        'Loop "Intraday check" has no required verifier fields.',
      ]),
    );
  });

  it("reads presentation goals from a Work manifest without changing evidence authority", () => {
    const model = buildWorkshopWorkModel({
      workshop: workshop({ modelConfig: {
        role: "general",
        manifestSpec: { presentation: {
          purpose: "Show source-backed converted files",
          requiredSections: ["result", "source evidence", "limitations"],
          expectedArtifacts: ["Markdown", "manifest"],
        } },
      } }),
      loops: [loop()],
      heartbeat: null,
      toolMatrix: toolMatrix(),
      availableSkillNames: [],
    });
    expect(model.presentationContract).toMatchObject({
      source: "manifest",
      purpose: "Show source-backed converted files",
      requiredSections: ["result", "source evidence", "limitations"],
      expectedArtifacts: ["Markdown", "manifest"],
      evidenceSource: "run_events",
      artifactSource: "run_receipts",
      statusSource: "run_lifecycle",
    });
  });

  it("does not warn when the Work self-audit system loop has no Skill mapping", () => {
    const model = buildWorkshopWorkModel({
      workshop: workshop(),
      loops: [
        loop(),
        loop({
          id: "work-self-audit-loop",
          name: "Work 自检升级",
          goal: "Run a closed-loop Work self-audit.",
          triggerConfig: {
            type: "cron",
            expression: "0 3 * * *",
            timezone: "Asia/Shanghai",
            metadata: { templateId: "work-self-audit" },
          },
          verificationConfig: {
            requiredFields: [
              "workHealthSummary",
              "observedGaps",
              "proposalsCreated",
              "nextControlAction",
            ],
          },
        }),
      ],
      heartbeat: heartbeat(),
      toolMatrix: toolMatrix(),
      availableSkillNames: ["watchlist-selection-control"],
    });

    expect(model.loopBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Work 自检升级",
          skillName: null,
          skillStatus: "unmapped",
          hasVerification: true,
        }),
      ]),
    );
    expect(model.observability.warnings).not.toContain(
      'Loop "Work 自检升级" has no Skill mapping.',
    );
  });
});
