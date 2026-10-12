import type { JobExecutionResult } from "@/lib/cron/types";
import type { StructuredExecutionOutput } from "@/lib/types/execution-result";
import type { LoopJson } from "./types";
import { loopVerificationSchema } from "./spec";
import { verifyContentReview } from "./content-review-verification";
import { verifyResearchProcess } from "./research-process-verification";

export interface LoopVerificationIssue {
  code:
    | "job_failed"
    | "missing_required_field"
    | "missing_required_source"
    | "missing_success_criteria"
    | "invalid_trend_follow_decision"
    | "missing_numeric_rule_evidence"
    | "document_artifact_invalid"
    | "invalid_content_review"
    | "invalid_research_process"
    | "unknown_verification_type";
  message: string;
  severity: "error" | "warning";
}

export interface LoopVerificationEvidence {
  status: JobExecutionResult["status"];
  observedFields: string[];
  observedSources: string[];
  artifactCount: number;
  hasOutput: boolean;
  hasStructuredReport: boolean;
}

export interface LoopVerificationResult {
  type: "legacy_status" | "structured_check";
  passed: boolean;
  issues: LoopVerificationIssue[];
  evidence: LoopVerificationEvidence;
  checkedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractStructuredReport(
  result: JobExecutionResult,
): StructuredExecutionOutput | null {
  const resultData = asRecord(result.result);
  const report = resultData.structuredReport;
  return report && typeof report === "object"
    ? (report as StructuredExecutionOutput)
    : null;
}

function addFieldMarkers(fields: Set<string>, text: unknown) {
  if (typeof text !== "string" || !text.trim()) return;

  for (const match of text.matchAll(
    /(?:^|\n)\s{0,3}#{1,6}\s+([A-Za-z][A-Za-z0-9_]*)\b/g,
  )) {
    fields.add(match[1]);
  }

  for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*:/g)) {
    fields.add(match[1]);
  }
}

function cleanSourceMarker(value: string) {
  return value
    .replace(/[`*_>|#\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addSourceMarkers(sources: Set<string>, text: unknown) {
  if (typeof text !== "string" || !text.trim()) return;

  for (const match of text.matchAll(/(?:^|\n)\s{0,3}#{1,6}\s+(.{1,80})/g)) {
    const marker = cleanSourceMarker(match[1]);
    if (marker) sources.add(marker);
  }

  for (const match of text.matchAll(/(?:^|\n)\s*[-*]\s+(.{1,80})/g)) {
    const marker = cleanSourceMarker(match[1]);
    if (marker) sources.add(marker);
  }
}

function addKnownToolSourceAliases(sources: Set<string>, toolName: unknown) {
  if (typeof toolName !== "string" || !toolName.trim()) return;
  const normalized = toolName.toLowerCase();

  if (
    normalized.includes("quantpaper") ||
    normalized.includes("astock") ||
    normalized.includes("a-stock")
  ) {
    sources.add("量化工作台");
    sources.add("A股数据");
  }

  if (normalized.includes("douyin")) {
    sources.add("抖音发布器");
  }

  if (
    normalized.includes("videorender") ||
    normalized.includes("videogenerate") ||
    normalized.includes("bailian")
  ) {
    sources.add("video_generation_model");
    sources.add("bailian_video");
  }

  if (normalized.includes("workshopreadlinkedworkshopevents")) {
    sources.add("绑定车间记录");
  }
}

function collectObservedFields(
  result: JobExecutionResult,
  structuredReport: StructuredExecutionOutput | null,
): string[] {
  const fields = new Set<string>();
  const resultData = asRecord(result.result);

  for (const key of Object.keys(resultData)) {
    fields.add(key);
  }

  if (result.output?.trim()) fields.add("output");
  if (result.error?.trim()) fields.add("error");
  addFieldMarkers(fields, result.output);
  addFieldMarkers(fields, result.error);

  const executionTrace = asRecord(resultData.executionTrace);
  const traceEvents = Array.isArray(executionTrace.events)
    ? executionTrace.events
    : [];
  for (const event of traceEvents) {
    const record = asRecord(event);
    addFieldMarkers(fields, record.title);
    addFieldMarkers(fields, record.detail);
  }

  if (structuredReport) {
    for (const key of Object.keys(structuredReport)) {
      fields.add(key);
    }
    if (structuredReport.summary?.trim()) fields.add("summary");
    if (structuredReport.outcome?.trim()) fields.add("outcome");
    if (structuredReport.reasoningChain?.length) fields.add("reasoningChain");
    if (structuredReport.files?.length) fields.add("files");
    if (structuredReport.suggestedActions?.length) {
      fields.add("suggestedActions");
    }
  }

  return [...fields].sort();
}

function collectObservedSources(
  result: JobExecutionResult,
  structuredReport: StructuredExecutionOutput | null,
): string[] {
  const sources = new Set<string>();
  const resultData = asRecord(result.result);
  const executionTrace = asRecord(resultData.executionTrace);
  const traceEvents = Array.isArray(executionTrace.events)
    ? executionTrace.events
    : [];
  const toolGate = asRecord(resultData.toolGate);
  const toolGateDecisions = Array.isArray(toolGate.decisions)
    ? toolGate.decisions
    : [];

  for (const step of structuredReport?.reasoningChain ?? []) {
    if (step.sourceType) sources.add(step.sourceType);
    if (step.sourceLabel) sources.add(step.sourceLabel);
    addSourceMarkers(sources, step.summary);
    addSourceMarkers(sources, step.description);
  }

  addSourceMarkers(sources, result.output);
  addSourceMarkers(sources, result.error);

  for (const event of traceEvents) {
    const record = asRecord(event);
    addSourceMarkers(sources, record.title);
    addSourceMarkers(sources, record.detail);
    if (typeof record.toolName === "string" && record.toolName.trim()) {
      sources.add(record.toolName);
      addKnownToolSourceAliases(sources, record.toolName);
      if (record.toolName.includes("__")) {
        const leafName = record.toolName.split("__").pop() ?? record.toolName;
        sources.add(leafName);
        addKnownToolSourceAliases(sources, leafName);
      }
    }
  }

  for (const decision of toolGateDecisions) {
    const record = asRecord(decision);
    if (typeof record.actionName === "string" && record.actionName.trim()) {
      sources.add(record.actionName);
      addKnownToolSourceAliases(sources, record.actionName);
      if (record.actionName.includes("__")) {
        const leafName =
          record.actionName.split("__").pop() ?? record.actionName;
        sources.add(leafName);
        addKnownToolSourceAliases(sources, leafName);
      }
    }
  }

  return [...sources].sort();
}

function collectObservedToolSources(result: JobExecutionResult): string[] {
  const sources = new Set<string>();
  const resultData = asRecord(result.result);
  const executionTrace = asRecord(resultData.executionTrace);
  const traceEvents = Array.isArray(executionTrace.events)
    ? executionTrace.events
    : [];
  const toolGate = asRecord(resultData.toolGate);
  const toolGateDecisions = Array.isArray(toolGate.decisions)
    ? toolGate.decisions
    : [];

  for (const event of traceEvents) {
    const record = asRecord(event);
    if (typeof record.toolName === "string" && record.toolName.trim()) {
      sources.add(record.toolName);
      addKnownToolSourceAliases(sources, record.toolName);
      if (record.toolName.includes("__")) {
        const leafName = record.toolName.split("__").pop() ?? record.toolName;
        sources.add(leafName);
        addKnownToolSourceAliases(sources, leafName);
      }
    }
  }

  for (const decision of toolGateDecisions) {
    const record = asRecord(decision);
    if (typeof record.actionName === "string" && record.actionName.trim()) {
      sources.add(record.actionName);
      addKnownToolSourceAliases(sources, record.actionName);
      if (record.actionName.includes("__")) {
        const leafName =
          record.actionName.split("__").pop() ?? record.actionName;
        sources.add(leafName);
        addKnownToolSourceAliases(sources, leafName);
      }
    }
  }

  return [...sources].sort();
}

function isToolLikeRequiredSource(source: string) {
  return /^(mcp__|quant|aStock|workshop|wechat|douyin|video|webRead|watchlist|Read$|Bash$)/i.test(
    source,
  );
}

function countArtifacts(
  result: JobExecutionResult,
  structuredReport: StructuredExecutionOutput | null,
): number {
  const resultData = asRecord(result.result);
  let count = structuredReport?.files?.length ?? 0;
  if (typeof resultData.sessionDir === "string") count += 1;
  return count;
}

function hasField(observedFields: string[], required: string): boolean {
  const normalized = required.toLowerCase();
  return observedFields.some((field) => field.toLowerCase() === normalized);
}

function hasSource(observedSources: string[], required: string): boolean {
  const normalized = cleanSourceMarker(required).toLowerCase();
  if (!normalized) return false;
  return observedSources.some((source) => {
    const observed = cleanSourceMarker(source).toLowerCase();
    return (
      observed === normalized ||
      observed.includes(normalized) ||
      normalized.includes(observed)
    );
  });
}

function hasAnyField(requiredFields: string[], candidates: string[]): boolean {
  const normalized = new Set(
    requiredFields.map((field) => field.toLowerCase()),
  );
  return candidates.some((candidate) => normalized.has(candidate.toLowerCase()));
}

function lowerString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function valueHasContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object");
}

function hasAnyContent(record: Record<string, unknown>, keys: string[]) {
  return keys.some((key) => valueHasContent(record[key]));
}

function includesTrendWarning(value: unknown): boolean {
  if (typeof value === "string") {
    return /break_warning|reduce_watch|exit_required|broken/i.test(value);
  }
  if (Array.isArray(value)) return value.some(includesTrendWarning);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      includesTrendWarning,
    );
  }
  return false;
}

function candidateIdentifier(
  candidate: Record<string, unknown>,
  index: number,
) {
  return (
    lowerString(candidate.code) ||
    lowerString(candidate.symbol) ||
    lowerString(candidate.name) ||
    `candidate[${index}]`
  );
}

function validateTrendCandidateDecision(
  candidate: Record<string, unknown>,
  index: number,
): { code: LoopVerificationIssue["code"]; message: string } | null {
  const decision =
    lowerString(candidate.decision) ||
    lowerString(candidate.action) ||
    lowerString(candidate.orderAction);
  if (!decision) {
    return {
      code: "invalid_trend_follow_decision",
      message: `${candidateIdentifier(candidate, index)} is missing decision/action`,
    };
  }

  const hasOrder = hasAnyContent(candidate, [
    "orderId",
    "order",
    "submittedOrder",
    "orderResult",
  ]);
  const hasBlocker = hasAnyContent(candidate, [
    "blockedReason",
    "blockedReasons",
    "blocker",
    "blockers",
    "notTradedReason",
  ]);
  const hasHoldReason = hasAnyContent(candidate, [
    "holdReason",
    "profitProtection",
    "nextVerification",
    "nextCheck",
  ]);
  const requiresOrderOrBlocker =
    /enter|add|buy|sell|reduce|exit|order|submit/.test(decision);

  if (requiresOrderOrBlocker && !hasOrder && !hasBlocker) {
    return {
      code: "invalid_trend_follow_decision",
      message: `${candidateIdentifier(candidate, index)} decision "${decision}" needs order evidence or a blocker`,
    };
  }

  if (!requiresOrderOrBlocker && !hasOrder && !hasBlocker && !hasHoldReason) {
    return {
      code: "invalid_trend_follow_decision",
      message: `${candidateIdentifier(candidate, index)} needs hold reason, blocker, order evidence, or next verification`,
    };
  }

  if (
    includesTrendWarning(candidate) &&
    !hasAnyContent(candidate, ["breakWarningHandling", "profitProtection"])
  ) {
    return {
      code: "invalid_trend_follow_decision",
      message: `${candidateIdentifier(candidate, index)} has break_warning/reduce_watch but no breakWarningHandling/profitProtection`,
    };
  }

  const needsNumericEvidence =
    /enter|add|buy|sell|reduce|exit|order|submit|blocked|invalidate|invalid|stop|trigger/.test(
      decision,
    ) ||
    hasAnyContent(candidate, [
      "triggerCondition",
      "invalidation",
      "stop",
      "stopLoss",
      "hardStop",
      "threshold",
      "actualPrice",
      "limitPrice",
      "plannedPrice",
    ]);
  const hasNumericEvidence = hasAnyContent(candidate, [
    "ruleEvidence",
    "ruleEvidences",
    "numericEvidence",
    "quantRuleEvidence",
  ]);
  const isStructuralSafetyBlock =
    decision === "blocked" &&
    lowerString(candidate.blockerType) === "missing_structured_output" &&
    hasBlocker &&
    !hasAnyContent(candidate, [
      "triggerCondition",
      "invalidation",
      "stop",
      "stopLoss",
      "hardStop",
      "threshold",
      "actualPrice",
      "limitPrice",
      "plannedPrice",
    ]);

  if (needsNumericEvidence && !isStructuralSafetyBlock && !hasNumericEvidence) {
    return {
      code: "missing_numeric_rule_evidence",
      message: `${candidateIdentifier(candidate, index)} decision "${decision}" needs quantRuleEvaluate ruleEvidence`,
    };
  }

  return null;
}

function addTrendFollowDecisionIssues(input: {
  requiredFields: string[];
  structuredReport: StructuredExecutionOutput | null;
  issues: LoopVerificationIssue[];
}) {
  if (
    !hasAnyField(input.requiredFields, [
      "trendFollowDecision",
      "trendTradeDecision",
    ])
  ) {
    return;
  }

  const decision = asRecord(
    input.structuredReport?.trendFollowDecision ??
      input.structuredReport?.trendTradeDecision,
  );
  if (Object.keys(decision).length === 0) {
    input.issues.push({
      code: "invalid_trend_follow_decision",
      message:
        "trendFollowDecision must be a structured object, not only prose",
      severity: "error",
    });
    return;
  }

  const candidates = Array.isArray(decision.candidateDecisions)
    ? decision.candidateDecisions
    : Array.isArray(decision.decisions)
      ? decision.decisions
      : [];
  if (candidates.length === 0) {
    input.issues.push({
      code: "invalid_trend_follow_decision",
      message:
        "trendFollowDecision.candidateDecisions must contain at least one symbol decision or explicit blocked candidate",
      severity: "error",
    });
    return;
  }

  for (const [index, candidateValue] of candidates.entries()) {
    const candidate = asRecord(candidateValue);
    const issue = validateTrendCandidateDecision(candidate, index);
    if (issue) {
      input.issues.push({
        code: issue.code,
        message: issue.message,
        severity: "error",
      });
    }
  }
}

export function verifyLoopRun(input: {
  verificationConfig: LoopJson;
  result: JobExecutionResult;
}): LoopVerificationResult {
  const config = loopVerificationSchema.parse(input.verificationConfig ?? {});
  const structuredReport = extractStructuredReport(input.result);
  const observedFields = collectObservedFields(input.result, structuredReport);
  const observedSources = collectObservedSources(input.result, structuredReport);
  const observedToolSources = collectObservedToolSources(input.result);
  const evidence: LoopVerificationEvidence = {
    status: input.result.status,
    observedFields,
    observedSources,
    artifactCount: countArtifacts(input.result, structuredReport),
    hasOutput: !!input.result.output?.trim(),
    hasStructuredReport: !!structuredReport,
  };

  const issues: LoopVerificationIssue[] = [];

  if (input.result.status !== "success") {
    issues.push({
      code: "job_failed",
      message:
        input.result.error || `Execution status was ${input.result.status}`,
      severity: "error",
    });
  }

  if (config.type === "legacy_status") {
    return {
      type: "legacy_status",
      passed: issues.length === 0,
      issues,
      evidence,
      checkedAt: new Date().toISOString(),
    };
  }

  for (const field of config.requiredFields) {
    if (!hasField(observedFields, field)) {
      issues.push({
        code: "missing_required_field",
        message: `Required field "${field}" was not observed`,
        severity: "error",
      });
    }
  }

  for (const source of config.requiredSources) {
    const sourceObserved = isToolLikeRequiredSource(source)
      ? hasSource(observedToolSources, source)
      : hasSource(observedSources, source);
    if (!sourceObserved) {
      issues.push({
        code: "missing_required_source",
        message: `Required source "${source}" was not observed`,
        severity: "error",
      });
    }
  }

  addTrendFollowDecisionIssues({
    requiredFields: config.requiredFields,
    structuredReport,
    issues,
  });

  for (const message of verifyContentReview(config.requiredFields, structuredReport)) {
    issues.push({code: "invalid_content_review", message, severity: "error"});
  }
  for (const message of verifyResearchProcess(config.requiredFields, structuredReport, asRecord(input.result.result).executionTrace)) {
    issues.push({code: "invalid_research_process", message, severity: "error"});
  }

  if (config.successCriteria.length > 0 && !input.result.output?.trim()) {
    issues.push({
      code: "missing_success_criteria",
      message: "Execution produced no output to evaluate success criteria",
      severity: "warning",
    });
  }

  return {
    type: "structured_check",
    passed: !issues.some((issue) => issue.severity === "error"),
    issues,
    evidence,
    checkedAt: new Date().toISOString(),
  };
}
