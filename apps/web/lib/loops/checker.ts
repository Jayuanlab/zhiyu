import { loopRetryPolicySchema } from "./spec";
import type { LoopApprovalEvaluation } from "./approval";
import type { LoopActionGuardResult } from "./action-guard";
import type { LoopToolGateEvaluation } from "./tool-gate";
import type { LoopJson, LoopRunStatus } from "./types";
import type { LoopVerificationIssue, LoopVerificationResult } from "./verifier";

export interface LoopCheckerResult {
  checkerType: "deterministic" | "model" | "hybrid";
  passed: boolean;
  feedback: string;
  retryRecommended: boolean;
  requiresHumanApproval: boolean;
  issues: LoopVerificationIssue[];
  checkedAt: string;
  modelFeedback?: LoopJson | null;
}

export interface LoopModelChecker {
  check: (input: {
    verification: LoopVerificationResult;
    deterministic: LoopCheckerResult;
  }) => Promise<{
    passed: boolean;
    feedback: string;
    retryRecommended?: boolean;
    requiresHumanApproval?: boolean;
    modelFeedback?: LoopJson | null;
  }>;
}

export type LoopOutcomeAction =
  | "complete"
  | "retry"
  | "block"
  | "fail"
  | "needs_approval";

export interface LoopOutcomeDecision {
  action: LoopOutcomeAction;
  runStatus: Exclude<LoopRunStatus, "running" | "queued" | "cancelled" | "needs_review">;
  statePhase: "idle" | "retry_recommended" | "blocked" | "error" | "approval";
  nextAction: string | null;
  blockedReason: string | null;
  attemptsUsed: number;
  attemptsRemaining: number;
}

function summarizeIssues(issues: LoopVerificationIssue[]): string {
  if (issues.length === 0) {
    return "Verification passed.";
  }

  return issues.map((issue) => issue.message).join("; ");
}

export function runDeterministicChecker(
  verification: LoopVerificationResult,
): LoopCheckerResult {
  const errorIssues = verification.issues.filter(
    (issue) => issue.severity === "error",
  );

  return {
    checkerType: "deterministic",
    passed: verification.passed,
    feedback: summarizeIssues(verification.issues),
    retryRecommended: !verification.passed && errorIssues.length > 0,
    requiresHumanApproval: false,
    issues: verification.issues,
    checkedAt: new Date().toISOString(),
  };
}

export async function runLoopChecker(input: {
  verification: LoopVerificationResult;
  modelChecker?: LoopModelChecker | null;
}): Promise<LoopCheckerResult> {
  const deterministic = runDeterministicChecker(input.verification);
  if (!input.modelChecker) {
    return deterministic;
  }

  const model = await input.modelChecker.check({
    verification: input.verification,
    deterministic,
  });

  return {
    checkerType: "hybrid",
    passed: deterministic.passed && model.passed,
    feedback: [deterministic.feedback, model.feedback]
      .filter((item) => item.trim())
      .join(" "),
    retryRecommended:
      deterministic.retryRecommended || model.retryRecommended === true,
    requiresHumanApproval:
      deterministic.requiresHumanApproval ||
      model.requiresHumanApproval === true,
    issues: deterministic.issues,
    checkedAt: new Date().toISOString(),
    modelFeedback: model.modelFeedback ?? null,
  };
}

export function decideLoopOutcome(input: {
  checker: LoopCheckerResult;
  retryPolicy: LoopJson;
  attemptsUsed?: number;
}): LoopOutcomeDecision {
  const retryPolicy = loopRetryPolicySchema.parse(input.retryPolicy ?? {});
  const attemptsUsed = Math.max(1, input.attemptsUsed ?? 1);
  const attemptsRemaining = Math.max(0, retryPolicy.maxAttempts - attemptsUsed);

  if (input.checker.passed) {
    return {
      action: "complete",
      runStatus: "success",
      statePhase: "idle",
      nextAction: null,
      blockedReason: null,
      attemptsUsed,
      attemptsRemaining,
    };
  }

  if (input.checker.requiresHumanApproval) {
    return {
      action: "needs_approval",
      runStatus: "needs_approval",
      statePhase: "approval",
      nextAction: "Review checker request",
      blockedReason: input.checker.feedback,
      attemptsUsed,
      attemptsRemaining,
    };
  }

  if (input.checker.retryRecommended && attemptsRemaining > 0) {
    return {
      action: "retry",
      runStatus: "blocked",
      statePhase: "retry_recommended",
      nextAction: "Retry maker execution with checker feedback",
      blockedReason: input.checker.feedback,
      attemptsUsed,
      attemptsRemaining,
    };
  }

  if (retryPolicy.onFailure === "ask_human") {
    return {
      action: "needs_approval",
      runStatus: "needs_approval",
      statePhase: "approval",
      nextAction: "Ask user to resolve failed verification",
      blockedReason: input.checker.feedback,
      attemptsUsed,
      attemptsRemaining,
    };
  }

  if (retryPolicy.onFailure === "mark_failed") {
    return {
      action: "fail",
      runStatus: "failed",
      statePhase: "error",
      nextAction: "Review failed loop run",
      blockedReason: input.checker.feedback,
      attemptsUsed,
      attemptsRemaining,
    };
  }

  return {
    action: "block",
    runStatus: "blocked",
    statePhase: "blocked",
    nextAction: "Review blocked loop run",
    blockedReason: input.checker.feedback,
    attemptsUsed,
    attemptsRemaining,
  };
}

export function buildCheckerVerificationPayload(input: {
  verification: LoopVerificationResult;
  checker: LoopCheckerResult;
  decision: LoopOutcomeDecision;
  approval?: LoopApprovalEvaluation;
  actionGuard?: LoopActionGuardResult;
  toolGate?: LoopToolGateEvaluation;
  executionTrace?: LoopJson;
  modelChecker?: LoopJson;
}): LoopJson {
  return {
    verification: input.verification,
    checker: input.checker,
    decision: input.decision,
    approval: input.approval,
    actionGuard: input.actionGuard,
    toolGate: input.toolGate,
    executionTrace: input.executionTrace,
    modelChecker: input.modelChecker,
    passed: input.decision.action === "complete",
  };
}
