/**
 * A read-only, per-run view for the owner. The agent can supply prose, while
 * completion state comes only from the durable run or system lifecycle events.
 * File links point at an authenticated endpoint that checks the receipt and
 * the file hash again when opened.
 */
import { extractJsonObjectSpan } from "./json-output";
import { buildWorkshopRuntimeFailurePresentation, knownWorkshopRuntimeFailureMessage, resolveWorkshopRuntimeFailure } from "./runtime-failure";

export type WorkPresentationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "needs_review"
  | "unknown";

export type WorkPresentationRun = {
  id: string;
  status: string;
  outputSummary?: string | null;
  error?: string | null;
  createdAt?: string | Date | null;
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
};

export type WorkPresentationEvent = {
  id: string;
  runId?: string | null;
  loopRunId?: string | null;
  seq?: number;
  type: string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string | Date;
  visibility?: string;
};

export type WorkPresentationArtifact = {
  id: string;
  eventId: string;
  label: string;
  fileName: string;
  mimeType: string;
  sha256: string | null;
  availability: "recorded" | "unavailable";
  href: string | null;
};

export type WorkPresentationV1 = {
  version: 1;
  runId: string;
  status: WorkPresentationStatus;
  presentedAt: string | null;
  title: string;
  summary: string;
  reportMarkdown: string | null;
  /** Host reading views describe delivered prose; evidence verification stays separate. */
  researchBriefMarkdown?: string;
  evidenceMarkdown?: string;
  /** Presentation hints do not change the durable run status. */
  reportKind?: "grounded_research";
  failureKind?: "research_report_validation";
  evidence: Array<{ eventId: string; label: string; createdAt: string }>;
  artifacts: WorkPresentationArtifact[];
  warnings: string[];
  nextSteps: string[];
  computerUse?: {
    backend: "javascript" | "python";
    cuaRunId: string;
    latestStep: string | null;
    latestStepAt: string | null;
    outcomeVerified: boolean;
  } | null;
};

type Input = {
  workshopId?: string;
  run?: WorkPresentationRun | null;
  events: readonly WorkPresentationEvent[];
};

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_FILE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,159}$/u;
const SYSTEM_STATUS: Record<string, WorkPresentationStatus> = {
  run_queued: "queued",
  run_started: "running",
  loop_run_started: "running",
  run_completed: "completed",
  loop_run_completed: "completed",
  run_failed: "failed",
  loop_run_failed: "failed",
  run_interrupted: "interrupted",
  run_cancelled: "cancelled",
  run_needs_review: "needs_review",
};
const KNOWN_STATUSES = new Set<WorkPresentationStatus>([
  "queued", "running", "completed", "failed", "interrupted", "cancelled",
  "needs_review", "unknown",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(nonEmpty).filter((item): item is string => item !== null)
    : [];
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values)].slice(0, limit);
}

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function eventOrder(left: WorkPresentationEvent, right: WorkPresentationEvent): number {
  if (Number.isSafeInteger(left.seq) && Number.isSafeInteger(right.seq)) {
    return (left.seq as number) - (right.seq as number);
  }
  return Date.parse(String(left.createdAt)) - Date.parse(String(right.createdAt));
}

function runStatus(run: WorkPresentationRun | null | undefined, events: WorkPresentationEvent[]): WorkPresentationStatus {
  if (run && KNOWN_STATUSES.has(run.status as WorkPresentationStatus)) {
    return run.status as WorkPresentationStatus;
  }
  for (const event of [...events].reverse()) {
    const status = SYSTEM_STATUS[event.type];
    if (status) return status;
  }
  return "unknown";
}

function fileNameFromPath(path: unknown): string | null {
  const raw = nonEmpty(path);
  if (!raw) return null;
  const name = raw.split(/[\\/]/).at(-1) ?? "";
  return SAFE_FILE_NAME.test(name) && name !== "." && name !== ".." ? name : null;
}

function fileMimeType(name: string): string {
  const extension = name.toLowerCase().split(".").at(-1);
  if (extension === "md") return "text/markdown";
  if (extension === "json") return "application/json";
  if (extension === "txt") return "text/plain";
  if (extension === "pdf") return "application/pdf";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function artifactHref(workshopId: string | undefined, eventId: string, fileName: string, sha256: string | null): string | null {
  if (!workshopId || !sha256 || !SAFE_FILE_NAME.test(fileName)) return null;
  return `/api/workshops/${encodeURIComponent(workshopId)}/artifacts/${encodeURIComponent(eventId)}/${encodeURIComponent(fileName)}`;
}

function artifactsFromEvent(workshopId: string | undefined, event: WorkPresentationEvent): WorkPresentationArtifact[] {
  const metadata = asRecord(event.metadata);
  const descriptors = Array.isArray(metadata.artifacts)
    ? metadata.artifacts.map(asRecord)
    : [];
  // Compatibility for receipts written before the shared artifacts array.
  if (event.type === "document_converted") {
    descriptors.push(
      { path: metadata.documentPath, sha256: metadata.documentSha256, label: "完整 Markdown" },
      { path: metadata.manifestPath, sha256: metadata.manifestSha256, label: "产物清单" },
      ...(Array.isArray(metadata.chunks)
        ? metadata.chunks.map((item, index) => ({
            ...asRecord(item), label: `Markdown 分片 ${index + 1}`,
          }))
        : []),
    );
  }
  const artifacts: WorkPresentationArtifact[] = [];
  const seen = new Set<string>();
  for (const [index, descriptor] of descriptors.entries()) {
    const fileName = fileNameFromPath(descriptor.fileName ?? descriptor.path);
    if (!fileName || seen.has(fileName)) continue;
    seen.add(fileName);
    const recordedPathName = fileNameFromPath(descriptor.path);
    const sha256 = nonEmpty(descriptor.sha256);
    const normalizedHash = sha256 && SHA256.test(sha256) ? sha256.toLowerCase() : null;
    const href = recordedPathName === fileName
      ? artifactHref(workshopId, event.id, fileName, normalizedHash)
      : null;
    artifacts.push({
      id: `${event.id}:${index}`,
      eventId: event.id,
      label: nonEmpty(descriptor.label) ?? fileName,
      fileName,
      mimeType: nonEmpty(descriptor.mimeType) ?? fileMimeType(fileName),
      sha256: normalizedHash,
      availability: href ? "recorded" : "unavailable",
      href,
    });
  }
  return artifacts;
}

function firstHeading(markdown: string | null): string | null {
  return markdown?.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function brief(text: string | null): string | null {
  return text?.split(/[。！？\n]/u)[0]?.trim().slice(0, 160) || null;
}

export function workPresentationErrorText(value: string): string {
  if (value === "owner_cancelled") return "已按你的要求停止本次任务。";
  if (value === "owner_cancel_after_effect") return "已停止继续执行；停止前可能已产生外部效果，请核对工作记录。";
  return value;
}

export function buildWorkPresentation(input: Input): WorkPresentationV1 | null {
  const ordered = [...input.events]
    .filter(event => event.visibility !== "debug" && asRecord(event.metadata).receiptAuthority !== "agent")
    .sort(eventOrder);
  const inferredRunId = [...ordered].reverse()
    .map(event => event.loopRunId ?? event.runId)
    .find((id): id is string => Boolean(id)) ?? null;
  const runId = input.run?.id ?? inferredRunId;
  if (!runId) return null;
  const events = ordered.filter(event => event.runId === runId || event.loopRunId === runId);
  const status = runStatus(input.run, events);
  const terminal = [...events].reverse().find(event => SYSTEM_STATUS[event.type] && !["running", "queued"].includes(SYSTEM_STATUS[event.type]));
  const narrative = [...events].reverse().find(event =>
    event.type === "loop_run_completed" || event.type === "run_completed" ||
    (event.type === "agent_text" && asRecord(event.metadata).final === true));
  const terminalMetadata = asRecord(terminal?.metadata);
  const narrativeMetadata = asRecord(narrative?.metadata);
  const storedPresentation = asRecord(terminalMetadata.presentation);
  const researchDelivery = asRecord(terminalMetadata.researchDelivery);
  const canonicalHash = nonEmpty(researchDelivery.canonicalHash);
  const hasVerifiedResearchReceipt = Boolean(canonicalHash && SHA256.test(canonicalHash) && events.some(event => {
    const metadata = asRecord(event.metadata);
    return event.runId === runId && event.type === "research_report_verified" &&
      metadata.receiptAuthority === "runtime" && metadata.version === "grounded-report/v1" &&
      metadata.status === "verified" && metadata.canonicalHash === canonicalHash &&
      terminal && eventOrder(event, terminal) < 0;
  }));
  const trustedHostResearchReport = status === "completed" &&
    canonicalHash && SHA256.test(canonicalHash) &&
    (terminalMetadata.receiptAuthority === "runtime" || hasVerifiedResearchReceipt) &&
    storedPresentation.source === "host_grounded_report" &&
    researchDelivery.version === "grounded-report/v1" && researchDelivery.status === "verified";
  const hasDeliveredReaderReceipt = Boolean(canonicalHash && SHA256.test(canonicalHash) && events.some(event => {
    const metadata = asRecord(event.metadata);
    return event.runId === runId && event.type === "research_report_delivered" &&
      metadata.receiptAuthority === "runtime" && metadata.version === "reader-report/v1" &&
      metadata.status === "delivered" && metadata.canonicalHash === canonicalHash &&
      terminal && eventOrder(event, terminal) < 0;
  }));
  const trustedHostReaderReport = status === "completed" &&
    canonicalHash && SHA256.test(canonicalHash) &&
    hasDeliveredReaderReceipt &&
    storedPresentation.source === "host_research_reader" &&
    researchDelivery.version === "reader-report/v1" && researchDelivery.status === "delivered";
  const trustedReadingView = trustedHostResearchReport || trustedHostReaderReport;
  const researchBriefMarkdown = trustedReadingView ? nonEmpty(storedPresentation.researchBriefMarkdown) : null;
  const evidenceMarkdown = trustedReadingView ? nonEmpty(storedPresentation.evidenceMarkdown) : null;
  const recovered = [input.run?.outputSummary, terminal?.body]
    .map(value => typeof value === "string" ? extractJsonObjectSpan(value)?.value ?? null : null)
    .find(value => value !== null);
  const recoveredPresentation = asRecord(recovered?.presentation);
  const recordedPresentation = nonEmpty(storedPresentation.reportMarkdown) || nonEmpty(storedPresentation.summary) || nonEmpty(storedPresentation.title)
    ? storedPresentation : recoveredPresentation;
  // Historical runtimes could validate an empty final after the runtime had
  // already rejected the report. Reconstruct the reason from authenticated,
  // same-execution host receipts without modifying that failed run or its logs.
  const runtimeFailure = status === "failed" ? resolveWorkshopRuntimeFailure({
    runId, error: input.run?.error, events,
    startedAt: input.run?.startedAt ?? input.run?.createdAt,
    runtimeFailure: terminalMetadata.runtimeFailure,
  }) : null;
  const researchFailure = runtimeFailure?.code === "research_final_validation_rejected";
  const knownProcessFailure = runtimeFailure?.code === "agent_runtime_failed" && runtimeFailure.runtimeEventId &&
    knownWorkshopRuntimeFailureMessage(runtimeFailure.runtimeError);
  const failurePresentation = runtimeFailure && (researchFailure || knownProcessFailure)
    ? buildWorkshopRuntimeFailurePresentation(runtimeFailure) : null;
  const presentation = failurePresentation ?? recordedPresentation;
  const rawRunSummary = nonEmpty(input.run?.outputSummary);
  const rawTerminalBody = nonEmpty(terminal?.body);
  const reportEvent = [...events].reverse().find(event =>
    nonEmpty(asRecord(event.metadata).finalMarkdownReport) ||
    (event.type === "agent_text" && asRecord(event.metadata).final === true && nonEmpty(event.body)));
  const reportMarkdown =
    nonEmpty(presentation.reportMarkdown) ??
    nonEmpty(recovered?.finalMarkdownReport) ??
    nonEmpty(asRecord(reportEvent?.metadata).finalMarkdownReport) ??
    (reportEvent?.type === "agent_text" && !extractJsonObjectSpan(reportEvent.body ?? "") ? nonEmpty(reportEvent.body) : null) ??
    null;
  const narrativeSummary = (
    nonEmpty(presentation.summary) ??
    nonEmpty(recovered?.summary) ??
    (rawRunSummary && !extractJsonObjectSpan(rawRunSummary) ? rawRunSummary : null) ??
    nonEmpty(narrativeMetadata.summary) ??
    (rawTerminalBody && !extractJsonObjectSpan(rawTerminalBody) ? rawTerminalBody : null) ??
    brief(reportMarkdown) ??
    (status === "running" ? "正在执行本轮工作。" : "本轮尚无可展示的工作摘要。")
  ).slice(0, 800);
  const summary = status === "failed"
    ? (failurePresentation?.summary ?? `本轮运行失败：${workPresentationErrorText(nonEmpty(input.run?.error) ?? nonEmpty(terminal?.body) ?? "具体原因请查看工作记录。")}`).slice(0, 800)
    : status === "interrupted"
      ? "本轮运行中断；请查看工作记录核对已执行动作和恢复方式。"
      : status === "cancelled"
        ? "本轮运行已取消；请查看工作记录核对已执行动作。"
        : narrativeSummary;
  const artifacts = events.flatMap(event => artifactsFromEvent(input.workshopId, event));
  const artifactEvents = new Set(artifacts.map(artifact => artifact.eventId));
  const evidenceIds = strings(presentation.evidenceEventIds);
  const evidenceCandidates = evidenceIds.length > 0
    ? evidenceIds.map(id => events.find(event => event.id === id)).filter((event): event is WorkPresentationEvent => Boolean(event))
    : events.filter(event => event.type === "source_checked" || artifactEvents.has(event.id) || event.type === "loop_verification_result");
  const evidence = evidenceCandidates.slice(-12).map(event => ({
    eventId: event.id,
    label: event.title,
    createdAt: iso(event.createdAt) ?? "",
  }));
  const warnings = unique([
    ...(failurePresentation ? strings(presentation.warnings) : []),
    ...events.flatMap(event => strings(asRecord(event.metadata).warnings)),
    ...(!failurePresentation ? strings(presentation.warnings) : []),
    ...(!failurePresentation && input.run?.error ? [input.run.error] : []),
    ...(!failurePresentation && status === "failed" && terminal?.body ? [terminal.body] : []),
  ].map(workPresentationErrorText), 20);
  const nextSteps = unique([
    ...strings(presentation.nextSteps),
    ...events.filter(event => event.type === "next_wakeup_suggested").map(event => event.body?.trim() ?? "").filter(Boolean),
  ], 12);
  const cuaEvent = [...events].reverse().find(event => {
    const metadata = asRecord(event.metadata);
    return typeof metadata.cuaRunId === "string" &&
      (metadata.backend === "javascript" || metadata.backend === "python");
  });
  const cuaMetadata = asRecord(cuaEvent?.metadata);
  const cuaStep = [...events].reverse().find(event => event.type === "cua_progress" &&
    asRecord(event.metadata).cuaRunId === cuaMetadata.cuaRunId);
  const computerUse = cuaEvent &&
    (cuaMetadata.backend === "javascript" || cuaMetadata.backend === "python") &&
    typeof cuaMetadata.cuaRunId === "string"
      ? { backend: cuaMetadata.backend as "javascript" | "python", cuaRunId: cuaMetadata.cuaRunId,
          latestStep: cuaStep?.title ?? null, latestStepAt: iso(cuaStep?.createdAt),
          outcomeVerified: cuaMetadata.outcomeVerified === true }
      : null;
  const title =
    (status === "failed" ? researchFailure ? failurePresentation?.title ?? "本轮运行失败" : "本轮运行失败" : null) ??
    (status === "interrupted" ? "本轮运行中断" : null) ??
    (status === "cancelled" ? "本轮运行已取消" : null) ??
    nonEmpty(presentation.title) ??
    firstHeading(reportMarkdown) ??
    (artifacts.length > 0 ? events.find(event => artifactEvents.has(event.id))?.title : null) ??
    brief(summary) ??
    terminal?.title ??
    "本轮工作汇报";
  return {
    version: 1,
    runId,
    status,
    presentedAt: iso(terminal?.createdAt) ?? iso(input.run?.completedAt) ?? iso(events.at(-1)?.createdAt),
    title,
    summary,
    reportMarkdown,
    ...(researchBriefMarkdown ? { researchBriefMarkdown } : {}),
    ...(evidenceMarkdown ? { evidenceMarkdown } : {}),
    ...(researchFailure ? { failureKind: "research_report_validation" as const } : {}),
    ...(researchFailure || presentation.source === "host_grounded_report" || trustedHostReaderReport ||
      ["grounded-report/v1", "reader-report/v1"].includes(String(asRecord(terminalMetadata.researchDelivery).version))
      ? { reportKind: "grounded_research" as const } : {}),
    evidence,
    artifacts,
    warnings,
    nextSteps,
    computerUse,
  };
}
