import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import {
  createWorkshopReviewablePiTools,
  WORKSHOP_REVIEWABLE_PI_PROPOSAL_TOOLS,
} from "@/lib/workshops/pi-proposal-tools";
import { buildWorkshopRuntimeToolPolicy } from "@/lib/workshops/tool-classification";

const proposeMock = vi.hoisted(() => vi.fn());
const proposeWatchlistMock = vi.hoisted(() => vi.fn());
const withExecutionWriteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workshops/agent-change-proposals", () => ({
  proposeWorkshopAgentChange: proposeMock,
}));

vi.mock("@/lib/workshops/quant-watchlist-proposal-service", () => ({
  proposeQuantPaperWatchlistChange: proposeWatchlistMock,
}));

vi.mock("@/lib/work-runtime/execution-lease", () => ({
  withExecutionWrite: withExecutionWriteMock,
}));

const now = new Date("2026-09-14T00:00:00.000Z");

function workshop() {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "AI 知识博主",
    mission: "collect and draft reviewable content",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: {},
    modelConfig: {},
    createdAt: now,
    updatedAt: now,
  } as any;
}

describe("Workshop Pi reviewable proposal tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proposeMock.mockResolvedValue({
      id: "event-1",
      title: "智能体修改提案：mission",
      metadata: {
        diff: [{ field: "mission", before: "old", after: "new" }],
        riskLevel: "medium",
      },
    });
    proposeWatchlistMock.mockResolvedValue({
      proposalId: "proposal-1",
      status: "applied",
      before: ["000977.SZ"],
      after: ["000977.SZ", "600519.SH"],
      add: [{ code: "600519.SH" }],
      remove: [],
      protectedRemove: [],
      validation: { ok: true, issues: [], warnings: [] },
      approvalRequired: false,
      eventId: "event-watchlist-1",
      appliedConfig: { codes: ["000977.SZ", "600519.SH"] },
      applyError: null,
    });
    withExecutionWriteMock.mockImplementation(async (_lease, write) =>
      write({ db: {}, append: vi.fn() }),
    );
  });

  it("creates an owner-reviewable proposal under deny-by-default policy", async () => {
    const onTrace = vi.fn();
    const policy = buildWorkshopRuntimeToolPolicy([
      ...WORKSHOP_REVIEWABLE_PI_PROPOSAL_TOOLS,
      "quantPaperPlaceOrder",
    ]);
    const tools = createWorkshopReviewablePiTools({
      workshop: workshop(),
      workshopId: "workshop-1",
      runId: "run-1",
      policy,
      onTrace,
    });
    const tool = tools.find((item) => item.name === "workshopProposeAgentChange");

    const result = await tool?.execute("tool-1", {
      reason: "narrow the mission wording",
      patch: { mission: "new mission" },
      riskLevel: "medium",
    });

    expect(result?.details.result).toMatchObject({
      ok: true,
      proposalEventId: "event-1",
      riskLevel: "medium",
    });
    expect(proposeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workshopId: "workshop-1",
        patch: { mission: "new mission" },
        reason: "narrow the mission wording",
        proposedBy: "workshop_agent",
        source: expect.objectContaining({
          surface: "pi_reviewable_proposal_tool",
          tool: "workshopProposeAgentChange",
          runId: "run-1",
        }),
      }),
      undefined,
    );
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "workshopProposeAgentChange",
        status: "completed",
      }),
    );
  });

  it("keeps explicit denied policy above the reviewable proposal promotion", async () => {
    const tools = createWorkshopReviewablePiTools({
      workshop: workshop(),
      workshopId: "workshop-1",
      policy: {
        allowedTools: ["workshopProposeAgentChange"],
        deniedTools: ["workshopProposeAgentChange"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find((item) => item.name === "workshopProposeAgentChange");

    await expect(
      tool?.execute("tool-2", {
        reason: "change mission",
        patch: { mission: "new mission" },
      }),
    ).rejects.toThrow("Tool denied by runtime policy.");
    expect(proposeMock).not.toHaveBeenCalled();
  });

  it("uses the execution lease write context when one is available", async () => {
    const lease = {
      userId: "user-1",
      workshopId: "workshop-1",
      runId: "run-1",
      workerId: "worker-1",
      token: 7,
    };
    const tools = createWorkshopReviewablePiTools({
      workshop: workshop(),
      workshopId: "workshop-1",
      runId: "run-1",
      executionLease: lease,
      policy: {
        allowedTools: ["workshopProposeAgentChange"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find((item) => item.name === "workshopProposeAgentChange");

    await tool?.execute("tool-3", {
      reason: "change mission",
      patch: { mission: "new mission" },
    });

    expect(withExecutionWriteMock).toHaveBeenCalledWith(
      lease,
      expect.any(Function),
    );
    expect(proposeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ db: {}, append: expect.any(Function) }),
    );
  });

  it("creates a watchlist proposal through the shared proposal service", async () => {
    const tools = createWorkshopReviewablePiTools({
      workshop: workshop(),
      workshopId: "workshop-1",
      runId: "run-1",
      policy: {
        allowedTools: ["quantPaperProposeWatchlistChange"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find(
      (item) => item.name === "quantPaperProposeWatchlistChange",
    );

    const result = await tool?.execute("tool-watchlist-1", {
      add: ["600519"],
      remove: [],
      keep: ["000977.SZ"],
      reason: "promote high-conviction candidate",
      strategyFit: "fits the core watchlist",
      risk: "valuation risk",
      evidenceSourceEventIds: ["event-source-1"],
    });

    expect(result?.details.result).toMatchObject({
      ok: true,
      proposalId: "proposal-1",
      status: "applied",
      eventId: "event-watchlist-1",
    });
    expect(proposeWatchlistMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        userId: "user-1",
        runId: "run-1",
        add: ["600519"],
        remove: [],
        keep: ["000977.SZ"],
        reason: "promote high-conviction candidate",
        strategyFit: "fits the core watchlist",
        risk: "valuation risk",
        evidenceSourceEventIds: ["event-source-1"],
        source: expect.objectContaining({
          surface: "pi_reviewable_proposal_tool",
          tool: "quantPaperProposeWatchlistChange",
        }),
      }),
    );
  });

  it("does not expose watchlist proposal unless the Work policy mentions it", async () => {
    const tools = createWorkshopReviewablePiTools({
      workshop: workshop(),
      workshopId: "workshop-1",
      policy: {
        allowedTools: ["workshopProposeAgentChange"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find(
      (item) => item.name === "quantPaperProposeWatchlistChange",
    );

    await expect(
      tool?.execute("tool-watchlist-unscoped", {
        add: ["600519"],
        reason: "promote high-conviction candidate",
        strategyFit: "fits the core watchlist",
        risk: "valuation risk",
      }),
    ).rejects.toThrow("Tool denied by runtime policy.");
    expect(proposeWatchlistMock).not.toHaveBeenCalled();
  });

  it("promotes watchlist proposal from requires-approval policy into guarded Pi execution", async () => {
    const tools = createWorkshopReviewablePiTools({
      workshop: workshop(),
      workshopId: "workshop-1",
      policy: {
        requiresApprovalTools: ["mcp__quant__quantPaperProposeWatchlistChange"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find(
      (item) => item.name === "quantPaperProposeWatchlistChange",
    );

    const result = await tool?.execute("tool-watchlist-promoted", {
      add: ["600519"],
      reason: "promote high-conviction candidate",
      strategyFit: "fits the core watchlist",
      risk: "valuation risk",
    });

    expect(result?.details.result).toMatchObject({
      ok: true,
      proposalId: "proposal-1",
      status: "applied",
    });
    expect(proposeWatchlistMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        add: ["600519"],
      }),
    );
  });

  it("keeps explicit denied policy above the watchlist proposal promotion", async () => {
    const tools = createWorkshopReviewablePiTools({
      workshop: workshop(),
      workshopId: "workshop-1",
      policy: {
        allowedTools: ["quantPaperProposeWatchlistChange"],
        deniedTools: ["quantPaperProposeWatchlistChange"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find(
      (item) => item.name === "quantPaperProposeWatchlistChange",
    );

    await expect(
      tool?.execute("tool-watchlist-2", {
        add: ["600519"],
        reason: "promote high-conviction candidate",
        strategyFit: "fits the core watchlist",
        risk: "valuation risk",
      }),
    ).rejects.toThrow("Tool denied by runtime policy.");
    expect(proposeWatchlistMock).not.toHaveBeenCalled();
  });

  it("passes the execution lease write context into watchlist proposal service", async () => {
    const lease = {
      userId: "user-1",
      workshopId: "workshop-1",
      runId: "run-1",
      workerId: "worker-1",
      token: 7,
    };
    proposeWatchlistMock.mockImplementationOnce(async (input) => {
      await input.withWriteContext?.(async (context: unknown) => context);
      return {
        proposalId: "proposal-1",
        status: "applied",
        before: [],
        after: [],
        add: [],
        remove: [],
        protectedRemove: [],
        validation: { ok: true, issues: [], warnings: [] },
        approvalRequired: false,
        eventId: "event-watchlist-1",
        appliedConfig: null,
        applyError: null,
      };
    });
    const tools = createWorkshopReviewablePiTools({
      workshop: workshop(),
      workshopId: "workshop-1",
      runId: "run-1",
      executionLease: lease,
      policy: {
        allowedTools: ["quantPaperProposeWatchlistChange"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find(
      (item) => item.name === "quantPaperProposeWatchlistChange",
    );

    await tool?.execute("tool-watchlist-3", {
      add: ["600519"],
      reason: "promote high-conviction candidate",
      strategyFit: "fits the core watchlist",
      risk: "valuation risk",
    });

    expect(withExecutionWriteMock).toHaveBeenCalledWith(
      lease,
      expect.any(Function),
    );
  });

  it("runs workshopProposeAgentChange through the Pi runtime tool loop", async () => {
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("workshopProposeAgentChange", {
          reason: "narrow the mission wording",
          patch: { mission: "new mission" },
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("proposal created"),
    ]);
    const runtime = createPiAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
      tools: createWorkshopReviewablePiTools({
        workshop: workshop(),
        workshopId: "workshop-1",
        runId: "run-1",
        policy: {
          allowedTools: ["workshopProposeAgentChange"],
          defaultDecision: "deny",
        },
      }),
      toolExecution: "sequential",
    });

    const messages = [];
    for await (const message of runtime.run({
      operation: "run",
      prompt: "propose a change",
      options: { sessionId: "pi-proposal-session" },
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: "tool_use",
      id: expect.any(String),
      name: "workshopProposeAgentChange",
      input: {
        reason: "narrow the mission wording",
        patch: { mission: "new mission" },
      },
    });
    expect(
      messages.find((message) => message.type === "tool_result")?.output,
    ).toContain("event-1");
    expect(messages).toContainEqual({
      type: "result",
      content: "proposal created",
      cost: 0,
    });
  });
});
