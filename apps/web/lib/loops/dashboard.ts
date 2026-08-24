import type { Loop, LoopRun, LoopState } from "@/lib/db/schema";
import { getLoop, getLoopState, listLoopRuns, listLoops } from "./service";

export type LoopDashboardStatus =
  | "active"
  | "paused"
  | "blocked"
  | "needs_approval"
  | "error"
  | "archived";

export interface LoopRunDashboardSummary {
  id: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  outputSummary: string | null;
  error: string | null;
  verificationPassed: boolean | null;
  checkerAction: string | null;
  checkerType: string | null;
  requiresApproval: boolean;
  denied: boolean;
  actionGuardMode: string | null;
  actionGuardBlocked: boolean;
  modelCheckerEnabled: boolean;
  modelCheckerReason: string | null;
  executionTrace: LoopRunTraceSummary;
}

export interface LoopRunTraceStep {
  type: string;
  title: string;
  detail: string | null;
  toolName: string | null;
  status: string | null;
  timestamp: string | null;
}

export interface LoopRunTraceSummary {
  events: LoopRunTraceStep[];
  toolCallCount: number;
  failedToolCallCount: number;
  permissionDecisionCount: number;
  durationMs: number | null;
}

export interface LoopSpaceSummary {
  triggerLabel: string;
  contextLabel: string;
  deliveryLabel: string | null;
  plannerAgent: string;
  executorAgent: string;
  verifierAgent: string;
  harness: string;
  externalWriteMode: "auto" | "manual_approval" | "none";
  permissionLabel: string;
}

export interface LoopDashboardSummary {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  status: string;
  dashboardStatus: LoopDashboardStatus;
  triggerConfig: Record<string, unknown>;
  currentPhase: string | null;
  nextAction: string | null;
  blockedReason: string | null;
  lastObservation: string | null;
  stateJson: Record<string, unknown>;
  nextScheduledRunAt: string | null;
  lastScheduledRunAt: string | null;
  schedulerStatus: string | null;
  spaceSummary: LoopSpaceSummary;
  latestRun: LoopRunDashboardSummary | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface LoopDashboardDetail extends LoopDashboardSummary {
  contextConfig: Record<string, unknown>;
  actionPolicy: Record<string, unknown>;
  verificationConfig: Record<string, unknown>;
  approvalPolicy: Record<string, unknown>;
  retryPolicy: Record<string, unknown>;
  escalationPolicy: Record<string, unknown>;
  runs: LoopRunDashboardSummary[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getNestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asRecord(value[key]);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateTimeValue(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isLatestRunDismissed(
  latestRun: LoopRunDashboardSummary | null,
  stateJson: Record<string, unknown>,
) {
  if (!latestRun) return false;
  const dismissedRunId =
    stringValue(stateJson.blockerDismissedLoopRunId) ??
    stringValue(stateJson.blockedClearedLoopRunId);
  if (dismissedRunId === latestRun.id) return true;

  const dismissedAt =
    dateTimeValue(stateJson.blockerDismissedAt) ??
    dateTimeValue(stateJson.blockerClearedAt);
  const latestRunAt =
    dateTimeValue(latestRun.completedAt) ?? dateTimeValue(latestRun.startedAt);
  return (
    dismissedAt !== null &&
    latestRunAt !== null &&
    latestRunAt <= dismissedAt
  );
}

function summarizeExecutionTrace(
  verification: Record<string, unknown>,
): LoopRunTraceSummary {
  const trace = asRecord(verification.executionTrace);
  const events = Array.isArray(trace.events)
    ? trace.events
        .map((event): LoopRunTraceStep | null => {
          const record = asRecord(event);
          const type = stringValue(record.type);
          if (!type) return null;
          return {
            type,
            title: stringValue(record.title) ?? type,
            detail: stringValue(record.detail),
            toolName: stringValue(record.toolName),
            status: stringValue(record.status),
            timestamp: stringValue(record.timestamp),
          };
        })
        .filter((event): event is LoopRunTraceStep => Boolean(event))
    : [];

  const inferredToolCallCount = events.filter(
    (event) => event.type === "tool_used",
  ).length;
  const inferredFailedToolCallCount = events.filter(
    (event) => event.type === "tool_result" && event.status === "error",
  ).length;
  const inferredPermissionDecisionCount = events.filter(
    (event) => event.type === "permission_decision",
  ).length;

  return {
    events: events.slice(0, 20),
    toolCallCount: numberValue(trace.toolCallCount) ?? inferredToolCallCount,
    failedToolCallCount:
      numberValue(trace.failedToolCallCount) ?? inferredFailedToolCallCount,
    permissionDecisionCount:
      numberValue(trace.permissionDecisionCount) ??
      inferredPermissionDecisionCount,
    durationMs: numberValue(trace.durationMs),
  };
}

function triggerLabel(triggerConfig: Record<string, unknown>): string {
  const type = triggerConfig.type;
  if (type === "cron") {
    return `Cron ${stringValue(triggerConfig.expression) ?? ""}`.trim();
  }
  if (type === "interval") {
    return `每 ${triggerConfig.minutes ?? "?"} 分钟`;
  }
  if (type === "once") {
    return `单次 ${stringValue(triggerConfig.at) ?? ""}`.trim();
  }
  if (type === "manual") return "手动触发";
  if (type === "scheduled_job") return "旧版定时任务";
  return "原生 Loop";
}

function buildLoopSpaceSummary(input: {
  loop: Loop;
  state: LoopState | null;
}): LoopSpaceSummary {
  const stateJson = asRecord(input.state?.stateJson);
  const loopSpec = asRecord(stateJson.loopSpec);
  const metadata = asRecord(loopSpec.metadata);
  const agents = asRecord(metadata.agents);
  const delivery = asRecord(metadata.delivery);
  const weather = asRecord(metadata.weather);
  const approval = asRecord(input.loop.approvalPolicy);
  const context = asRecord(input.loop.contextConfig);

  const recipientName = stringValue(delivery.recipientName);
  const platform = stringValue(delivery.platform);
  const city = stringValue(weather.city);
  const externalWrites = stringValue(approval.externalWrites);
  const deliveryLabel =
    platform === "wechat_desktop" && recipientName
      ? `微信：${recipientName}`
      : platform
        ? platform
        : null;
  const externalWriteMode =
    externalWrites === "allow"
      ? "auto"
      : externalWrites === "require_approval"
        ? "manual_approval"
        : "none";

  return {
    triggerLabel: triggerLabel(input.loop.triggerConfig),
    contextLabel:
      city ?? stringValue(context.instructions) ?? "按任务说明收集上下文",
    deliveryLabel,
    plannerAgent:
      stringValue(agents.planner) ??
      (metadata.createdFrom === "natural_language"
        ? "natural-language-planner"
        : "template-planner"),
    executorAgent: stringValue(agents.executor) ?? "native-loop-executor",
    verifierAgent: stringValue(agents.verifier) ?? "loop-verifier",
    harness: stringValue(metadata.harness) ?? "loop-run-harness",
    externalWriteMode,
    permissionLabel:
      externalWriteMode === "auto"
        ? "按任务自动执行"
        : externalWriteMode === "manual_approval"
          ? "执行前需要审批"
          : "禁止外部写入",
  };
}

export function summarizeLoopRun(run: LoopRun): LoopRunDashboardSummary {
  const verification = asRecord(run.verificationResult);
  const nestedVerification = getNestedRecord(verification, "verification");
  const decision = getNestedRecord(verification, "decision");
  const checker = getNestedRecord(verification, "checker");
  const approval = getNestedRecord(verification, "approval");
  const actionGuard = getNestedRecord(verification, "actionGuard");
  const modelChecker = getNestedRecord(verification, "modelChecker");

  const verificationPassed =
    typeof verification.passed === "boolean"
      ? verification.passed
      : typeof nestedVerification.passed === "boolean"
        ? nestedVerification.passed
        : null;

  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    outputSummary: run.outputSummary,
    error: run.error,
    verificationPassed,
    checkerAction: typeof decision.action === "string" ? decision.action : null,
    checkerType:
      typeof checker.checkerType === "string" ? checker.checkerType : null,
    requiresApproval: approval.requiresApproval === true,
    denied: approval.denied === true,
    actionGuardMode:
      typeof actionGuard.mode === "string" ? actionGuard.mode : null,
    actionGuardBlocked: actionGuard.blocked === true,
    modelCheckerEnabled: modelChecker.enabled === true,
    modelCheckerReason:
      typeof modelChecker.reason === "string" ? modelChecker.reason : null,
    executionTrace: summarizeExecutionTrace(verification),
  };
}

export function deriveLoopDashboardStatus(input: {
  loop: Loop;
  state: LoopState | null;
  latestRun: LoopRunDashboardSummary | null;
}): LoopDashboardStatus {
  const stateJson = asRecord(input.state?.stateJson);
  const clearedBlockedRunId =
    typeof stateJson.blockedClearedLoopRunId === "string"
      ? stateJson.blockedClearedLoopRunId
      : null;
  const latestBlockedRunCleared =
    input.latestRun?.status === "blocked" &&
    clearedBlockedRunId === input.latestRun.id &&
    input.state?.currentPhase !== "blocked" &&
    input.state?.currentPhase !== "retry_recommended";
  const latestRunDismissed =
    isLatestRunDismissed(input.latestRun, stateJson) &&
    input.state?.currentPhase !== "blocked" &&
    input.state?.currentPhase !== "retry_recommended" &&
    input.state?.currentPhase !== "error";

  if (
    stateJson.requiresOwnerActivation === true &&
    (stateJson.ownerActivationStatus === undefined ||
      stateJson.ownerActivationStatus === "pending")
  ) {
    return "needs_approval";
  }

  if (input.loop.status === "archived") return "archived";
  if (input.loop.status === "paused") return "paused";

  if (
    input.latestRun?.requiresApproval ||
    stateJson.lastApprovalRequiresApproval === true ||
    input.state?.currentPhase === "approval"
  ) {
    return "needs_approval";
  }

  if (
    (input.latestRun?.status === "blocked" &&
      !latestBlockedRunCleared &&
      !latestRunDismissed) ||
    (input.latestRun?.status !== "success" &&
      input.latestRun?.actionGuardBlocked &&
      !latestRunDismissed) ||
    (stateJson.lastJobStatus !== "success" &&
      stateJson.lastActionGuardBlocked === true) ||
    input.state?.currentPhase === "blocked" ||
    input.state?.currentPhase === "retry_recommended"
  ) {
    return "blocked";
  }

  if (
    input.loop.status === "error" ||
    (input.latestRun?.status === "failed" && !latestRunDismissed) ||
    input.state?.currentPhase === "error"
  ) {
    return "error";
  }

  return "active";
}

export function summarizeLoop(input: {
  loop: Loop;
  state: LoopState | null;
  latestRun: LoopRun | null;
}): LoopDashboardSummary {
  const latestRun = input.latestRun ? summarizeLoopRun(input.latestRun) : null;
  const stateJson = asRecord(input.state?.stateJson);
  return {
    id: input.loop.id,
    name: input.loop.name,
    description: input.loop.description,
    goal: input.loop.goal,
    status: input.loop.status,
    dashboardStatus: deriveLoopDashboardStatus({
      loop: input.loop,
      state: input.state,
      latestRun,
    }),
    triggerConfig: input.loop.triggerConfig,
    currentPhase: input.state?.currentPhase ?? null,
    nextAction: input.state?.nextAction ?? null,
    blockedReason: input.state?.blockedReason ?? null,
    lastObservation: input.state?.lastObservation ?? null,
    stateJson,
    nextScheduledRunAt:
      typeof stateJson.nextScheduledRunAt === "string"
        ? stateJson.nextScheduledRunAt
        : null,
    lastScheduledRunAt:
      typeof stateJson.lastScheduledRunAt === "string"
        ? stateJson.lastScheduledRunAt
        : null,
    schedulerStatus:
      typeof stateJson.schedulerStatus === "string"
        ? stateJson.schedulerStatus
        : null,
    spaceSummary: buildLoopSpaceSummary({
      loop: input.loop,
      state: input.state,
    }),
    latestRun,
    updatedAt: input.loop.updatedAt,
    createdAt: input.loop.createdAt,
  };
}

export async function listLoopDashboard(userId: string): Promise<{
  loops: LoopDashboardSummary[];
  counts: Record<LoopDashboardStatus, number>;
}> {
  const loops = await listLoops(userId, { limit: 200 });
  const summaries = await Promise.all(
    loops.map(async (loop) => {
      const [state, runs] = await Promise.all([
        getLoopState(loop.id),
        listLoopRuns(loop.id, { limit: 1 }),
      ]);
      return summarizeLoop({
        loop,
        state,
        latestRun: runs[0] ?? null,
      });
    }),
  );

  const counts: Record<LoopDashboardStatus, number> = {
    active: 0,
    paused: 0,
    blocked: 0,
    needs_approval: 0,
    error: 0,
    archived: 0,
  };

  for (const summary of summaries) {
    counts[summary.dashboardStatus] += 1;
  }

  return { loops: summaries, counts };
}

export async function getLoopDashboardDetail(
  userId: string,
  loopId: string,
): Promise<LoopDashboardDetail | null> {
  const loop = await getLoop(userId, loopId);
  if (!loop) return null;

  const [state, runs] = await Promise.all([
    getLoopState(loop.id),
    listLoopRuns(loop.id, { limit: 25 }),
  ]);

  return {
    ...summarizeLoop({
      loop,
      state,
      latestRun: runs[0] ?? null,
    }),
    contextConfig: loop.contextConfig,
    actionPolicy: loop.actionPolicy,
    verificationConfig: loop.verificationConfig,
    approvalPolicy: loop.approvalPolicy,
    retryPolicy: loop.retryPolicy,
    escalationPolicy: loop.escalationPolicy,
    runs: runs.map((run) => summarizeLoopRun(run)),
  };
}
