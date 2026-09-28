export type RuntimeToolDecision = "allow" | "deny" | "require_approval";

export type RuntimeToolTraceStatus = "completed" | "error" | "denied";

export interface RuntimeToolPolicy {
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  requiresApprovalTools?: string[] | null;
  defaultDecision?: RuntimeToolDecision;
  onDecision?: (decision: RuntimeToolDecisionRecord) => void | Promise<void>;
}

export interface RuntimeToolDecisionRecord {
  toolName: string;
  toolUseId: string | null;
  decision: RuntimeToolDecision;
  reason: string;
  matchedRule: string | null;
  timestamp: string;
}

export interface RuntimeToolTraceEvent {
  type: "tool_result";
  title: string;
  detail: string | null;
  toolName: string;
  toolUseId: string | null;
  status: RuntimeToolTraceStatus;
  timestamp: string;
  durationMs: number;
  metadata: {
    decision: RuntimeToolDecision;
    reason: string;
    matchedRule: string | null;
    deniedBeforeHandler: boolean;
  };
}

export interface GuardedRuntimeToolInput<TInput, TResult> {
  toolName: string;
  toolUseId?: string | null;
  input: TInput;
  policy?: RuntimeToolPolicy;
  handler: (input: TInput) => Promise<TResult> | TResult;
  now?: () => Date;
}

export type GuardedRuntimeToolOutcome<TResult> =
  | {
      ok: true;
      result: TResult;
      trace: RuntimeToolTraceEvent;
      decision: RuntimeToolDecisionRecord;
    }
  | {
      ok: false;
      error: string;
      trace: RuntimeToolTraceEvent;
      decision: RuntimeToolDecisionRecord;
    };

function normalizeToolName(value: string) {
  const trimmed = value.trim();
  const mcpMatch = trimmed.match(/^mcp__[^_]+__(.+)$/);
  return (mcpMatch?.[1] ?? trimmed).toLowerCase();
}

function matchTool(toolName: string, candidates: string[] | null | undefined) {
  const normalized = normalizeToolName(toolName);
  return (candidates ?? []).find(
    (candidate) => normalizeToolName(candidate) === normalized,
  ) ?? null;
}

function resultDetail(value: unknown) {
  if (typeof value === "string") return value.slice(0, 2_000);
  if (value === undefined) return null;
  try {
    return JSON.stringify(value).slice(0, 2_000);
  } catch {
    return String(value).slice(0, 2_000);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function decideRuntimeTool(input: {
  toolName: string;
  toolUseId?: string | null;
  policy?: RuntimeToolPolicy;
  timestamp: string;
}): RuntimeToolDecisionRecord {
  const policy = input.policy ?? {};
  const deniedRule = matchTool(input.toolName, policy.deniedTools);
  if (deniedRule) {
    return {
      toolName: input.toolName,
      toolUseId: input.toolUseId ?? null,
      decision: "deny",
      reason: "Tool is explicitly denied by runtime policy.",
      matchedRule: deniedRule,
      timestamp: input.timestamp,
    };
  }

  const approvalRule = matchTool(input.toolName, policy.requiresApprovalTools);
  if (approvalRule) {
    return {
      toolName: input.toolName,
      toolUseId: input.toolUseId ?? null,
      decision: "require_approval",
      reason: "Tool requires owner approval and cannot run inside an autonomous runtime executor.",
      matchedRule: approvalRule,
      timestamp: input.timestamp,
    };
  }

  const allowedTools = policy.allowedTools ?? null;
  const allowedRule = matchTool(input.toolName, allowedTools);
  if (allowedTools && allowedTools.length > 0 && !allowedRule) {
    return {
      toolName: input.toolName,
      toolUseId: input.toolUseId ?? null,
      decision: "deny",
      reason: "Tool is not present in the runtime allowlist.",
      matchedRule: null,
      timestamp: input.timestamp,
    };
  }

  if (allowedRule) {
    return {
      toolName: input.toolName,
      toolUseId: input.toolUseId ?? null,
      decision: "allow",
      reason: "Tool is explicitly allowed by runtime policy.",
      matchedRule: allowedRule,
      timestamp: input.timestamp,
    };
  }

  const defaultDecision = policy.defaultDecision ?? "allow";
  return {
    toolName: input.toolName,
    toolUseId: input.toolUseId ?? null,
    decision: defaultDecision,
    reason:
      defaultDecision === "allow"
        ? "Tool is allowed by runtime policy."
        : "Tool follows the runtime default decision.",
    matchedRule: null,
    timestamp: input.timestamp,
  };
}

function traceEvent(input: {
  toolName: string;
  toolUseId?: string | null;
  status: RuntimeToolTraceStatus;
  detail: string | null;
  decision: RuntimeToolDecisionRecord;
  startedAt: number;
  completedAt: Date;
  deniedBeforeHandler: boolean;
}): RuntimeToolTraceEvent {
  return {
    type: "tool_result",
    title:
      input.status === "completed"
        ? "Tool completed"
        : input.status === "denied"
          ? "Tool denied"
          : "Tool error",
    detail: input.detail,
    toolName: input.toolName,
    toolUseId: input.toolUseId ?? null,
    status: input.status,
    timestamp: input.completedAt.toISOString(),
    durationMs: Math.max(0, input.completedAt.getTime() - input.startedAt),
    metadata: {
      decision: input.decision.decision,
      reason: input.decision.reason,
      matchedRule: input.decision.matchedRule,
      deniedBeforeHandler: input.deniedBeforeHandler,
    },
  };
}

export async function executeGuardedRuntimeTool<TInput, TResult>(
  input: GuardedRuntimeToolInput<TInput, TResult>,
): Promise<GuardedRuntimeToolOutcome<TResult>> {
  const now = input.now ?? (() => new Date());
  const started = now();
  const startedAt = started.getTime();
  const decision = decideRuntimeTool({
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    policy: input.policy,
    timestamp: started.toISOString(),
  });
  await input.policy?.onDecision?.(decision);

  if (decision.decision !== "allow") {
    const deniedAt = now();
    const error =
      decision.decision === "require_approval"
        ? "Tool requires owner approval."
        : "Tool denied by runtime policy.";
    return {
      ok: false,
      error,
      decision,
      trace: traceEvent({
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        status: "denied",
        detail: decision.reason,
        decision,
        startedAt,
        completedAt: deniedAt,
        deniedBeforeHandler: true,
      }),
    };
  }

  try {
    const result = await input.handler(input.input);
    const completedAt = now();
    return {
      ok: true,
      result,
      decision,
      trace: traceEvent({
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        status: "completed",
        detail: resultDetail(result),
        decision,
        startedAt,
        completedAt,
        deniedBeforeHandler: false,
      }),
    };
  } catch (error) {
    const completedAt = now();
    const message = errorMessage(error);
    return {
      ok: false,
      error: message,
      decision,
      trace: traceEvent({
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        status: "error",
        detail: message,
        decision,
        startedAt,
        completedAt,
        deniedBeforeHandler: false,
      }),
    };
  }
}
