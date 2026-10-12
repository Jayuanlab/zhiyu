import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createGuardedPiTools,
  type GuardedPiToolDefinition,
} from "@/lib/ai/runtime/pi-tool-adapter";
import type {
  RuntimeToolPolicy,
  RuntimeToolTraceEvent,
} from "@/lib/ai/runtime/tool-executor";
import {
  proposeWorkshopAgentChange,
  type WorkshopAgentChangePatch,
} from "./agent-change-proposals";
import { proposeQuantPaperWatchlistChange } from "./quant-watchlist-proposal-service";
import type { Workshop } from "@/lib/db/schema";
import {
  withExecutionBusinessWrite,
  type ExecutionLease,
} from "@/lib/work-runtime/execution-lease";

export const WORKSHOP_REVIEWABLE_PI_PROPOSAL_TOOLS = [
  "workshopProposeAgentChange",
  "quantPaperProposeWatchlistChange",
] as const;

const ALWAYS_AVAILABLE_REVIEWABLE_PI_PROPOSAL_TOOLS = [
  "workshopProposeAgentChange",
] as const satisfies readonly WorkshopReviewablePiProposalToolName[];

const POLICY_SCOPED_REVIEWABLE_PI_PROPOSAL_TOOLS = [
  "quantPaperProposeWatchlistChange",
] as const satisfies readonly WorkshopReviewablePiProposalToolName[];

export type WorkshopReviewablePiProposalToolName =
  (typeof WORKSHOP_REVIEWABLE_PI_PROPOSAL_TOOLS)[number];

export interface WorkshopReviewablePiToolsInput {
  workshop: Workshop;
  workshopId: string;
  runId?: string | null;
  loopId?: string | null;
  loopRunId?: string | null;
  executionLease?: ExecutionLease;
  policy?: RuntimeToolPolicy;
  onTrace?: (trace: RuntimeToolTraceEvent) => void | Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeRiskLevel(value: unknown): "low" | "medium" | "high" | undefined {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizePatch(value: unknown): WorkshopAgentChangePatch {
  const record = asRecord(value);
  const patch: WorkshopAgentChangePatch = {};
  if (typeof record.name === "string") patch.name = record.name;
  if (typeof record.mission === "string") patch.mission = record.mission;
  if (
    record.status === "active" ||
    record.status === "paused" ||
    record.status === "archived"
  ) {
    patch.status = record.status;
  }
  if (
    record.autonomyLevel === "observe" ||
    record.autonomyLevel === "draft" ||
    record.autonomyLevel === "auto"
  ) {
    patch.autonomyLevel = record.autonomyLevel;
  }
  const boundaryPolicy = jsonObject(record.boundaryPolicy);
  if (boundaryPolicy) patch.boundaryPolicy = boundaryPolicy;
  const modelConfig = jsonObject(record.modelConfig);
  if (modelConfig) patch.modelConfig = modelConfig;
  return patch;
}

function normalizeToolName(value: string) {
  const trimmed = value.trim();
  const mcpMatch = trimmed.match(/^mcp__[^_]+__(.+)$/);
  return (mcpMatch?.[1] ?? trimmed).toLowerCase();
}

function policyMentionsTool(
  policy: RuntimeToolPolicy | undefined,
  toolName: WorkshopReviewablePiProposalToolName,
) {
  const normalized = normalizeToolName(toolName);
  return [
    ...(policy?.allowedTools ?? []),
    ...(policy?.requiresApprovalTools ?? []),
  ].some((tool) => normalizeToolName(tool) === normalized);
}

function proposalPolicy(policy: RuntimeToolPolicy | undefined): RuntimeToolPolicy {
  const promotedTools = [
    ...ALWAYS_AVAILABLE_REVIEWABLE_PI_PROPOSAL_TOOLS,
    ...POLICY_SCOPED_REVIEWABLE_PI_PROPOSAL_TOOLS.filter((tool) =>
      policyMentionsTool(policy, tool),
    ),
  ];
  const promotedToolNames = new Set(promotedTools.map(normalizeToolName));
  const requiresApprovalTools = (policy?.requiresApprovalTools ?? []).filter(
    (tool) => !promotedToolNames.has(normalizeToolName(tool)),
  );
  const allowedTools = [
    ...(policy?.allowedTools ?? []),
    ...promotedTools,
  ];
  return {
    ...policy,
    allowedTools: [...new Set(allowedTools)],
    requiresApprovalTools,
    deniedTools: policy?.deniedTools,
    defaultDecision: policy?.defaultDecision ?? "deny",
  };
}

export function createWorkshopReviewablePiToolDefinitions(
  input: WorkshopReviewablePiToolsInput,
): GuardedPiToolDefinition[] {
  const policy = proposalPolicy(input.policy);
  return [
    {
      name: "workshopProposeAgentChange",
      label: "Propose Work configuration change",
      description: [
        "Create an owner-reviewable proposal to change this Work configuration.",
        "This writes only a pending proposal/review item and never applies the change directly.",
        "Keep the patch narrow and explain the observed gap in reason.",
      ].join("\n"),
      parameters: Type.Object({
        reason: Type.String(),
        riskLevel: Type.Optional(Type.String()),
        patch: Type.Object({
          name: Type.Optional(Type.String()),
          mission: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          autonomyLevel: Type.Optional(Type.String()),
          boundaryPolicy: Type.Optional(Type.Any()),
          modelConfig: Type.Optional(Type.Any()),
        }),
      }),
      policy,
      onTrace: input.onTrace,
      execute: async (params) => {
        const record = asRecord(params);
        const reason = typeof record.reason === "string" ? record.reason.trim() : "";
        if (reason.length < 8) {
          throw new Error("A proposal reason of at least 8 characters is required.");
        }
        const patch = normalizePatch(record.patch);
        const runScope = {
          surface: "pi_reviewable_proposal_tool",
          tool: "workshopProposeAgentChange",
          runId: input.runId ?? null,
          loopId: input.loopId ?? null,
          loopRunId: input.loopRunId ?? null,
        };
        const write = async (context?: Parameters<typeof proposeWorkshopAgentChange>[1]) =>
          proposeWorkshopAgentChange(
            {
              userId: input.workshop.userId,
              workshopId: input.workshopId,
              patch,
              reason,
              riskLevel: normalizeRiskLevel(record.riskLevel),
              proposedBy: "workshop_agent",
              source: runScope,
            },
            context,
          );
        const proposal = input.executionLease
          ? await withExecutionBusinessWrite(input.executionLease, (context) => write(context))
          : await write();
        return {
          ok: true,
          message:
            "Created a Work configuration proposal. The owner must approve it before the Work changes.",
          proposalEventId: proposal.id,
          title: proposal.title,
          diff: proposal.metadata?.diff ?? [],
          riskLevel: proposal.metadata?.riskLevel ?? null,
        };
      },
    },
    {
      name: "quantPaperProposeWatchlistChange",
      label: "Propose active watchlist change",
      description: [
        "Create an auditable active core/trading watchlist change proposal using the same validation path as the Claude MCP tool.",
        "This validates symbols, protects current paper positions and open orders, records a review item, and auto-applies only when validation passes.",
        "It cannot place or cancel paper orders and cannot clean candidate-pool-only symbols.",
      ].join("\n"),
      parameters: Type.Object({
        add: Type.Optional(Type.Array(Type.String())),
        remove: Type.Optional(Type.Array(Type.String())),
        keep: Type.Optional(Type.Array(Type.String())),
        reason: Type.String(),
        strategyFit: Type.String(),
        risk: Type.String(),
        evidenceSourceEventIds: Type.Optional(Type.Array(Type.String())),
      }),
      policy,
      onTrace: input.onTrace,
      execute: async (params) => {
        const record = asRecord(params);
        const reason = typeof record.reason === "string" ? record.reason.trim() : "";
        const strategyFit =
          typeof record.strategyFit === "string" ? record.strategyFit.trim() : "";
        const risk = typeof record.risk === "string" ? record.risk.trim() : "";
        if (reason.length < 8) {
          throw new Error("A watchlist proposal reason of at least 8 characters is required.");
        }
        if (strategyFit.length < 4) {
          throw new Error("A strategyFit explanation of at least 4 characters is required.");
        }
        if (risk.length < 4) {
          throw new Error("A risk explanation of at least 4 characters is required.");
        }

        const payload = await proposeQuantPaperWatchlistChange({
          workshopId: input.workshopId,
          userId: input.workshop.userId,
          runId: input.runId ?? null,
          loopId: input.loopId ?? null,
          loopRunId: input.loopRunId ?? null,
          add: stringArray(record.add),
          remove: stringArray(record.remove),
          keep: stringArray(record.keep),
          reason,
          strategyFit,
          risk,
          evidenceSourceEventIds: stringArray(record.evidenceSourceEventIds),
          source: {
            surface: "pi_reviewable_proposal_tool",
            tool: "quantPaperProposeWatchlistChange",
          },
          withWriteContext: input.executionLease
            ? (write) => withExecutionBusinessWrite(input.executionLease!, write)
            : undefined,
        });

        return {
          ok: payload.validation.ok,
          message:
            payload.status === "applied"
              ? "Created and auto-applied a validated active watchlist proposal."
              : "Created an active watchlist proposal record. Review the validation status before relying on it.",
          ...payload,
        };
      },
    },
  ];
}

export function createWorkshopReviewablePiTools(
  input: WorkshopReviewablePiToolsInput,
): AgentTool<any>[] {
  return createGuardedPiTools(createWorkshopReviewablePiToolDefinitions(input));
}
