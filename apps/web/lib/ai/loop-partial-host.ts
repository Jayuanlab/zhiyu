import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { createAnswerEvidenceCore, answerEvidenceHash, answerTextHash, validEvidenceTime,
  type CoreReceipt, type SdkContextCommit } from "./runtime/answer-evidence-core";
import type { AnswerEvidenceAuditEvent, ToolConstruction } from "./runtime/answer-evidence-contract";
import { exactExplicitOwnerLoopQuestionId, ownerLoopFacetQuestionScope, ownerLoopCurrentRuntimeRequested } from "./loop-owner-facet-session";
import { isTrustedLoopRuntimeContext, projectTrustedLoopRuntimeObservation,
  type TrustedLoopRuntimeContext } from "./loop-runtime-evidence-boundary";
import { bindOwnerLoopPartialDelivery, deliverOwnerLoopPartial } from "./loop-partial-delivery";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null
  && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type OwnerReceipt = CoreReceipt & {
  ownerId: string; loopId: string; originalQuestionHash: string; turnId: string;
  runtimeHash: string; policyHash: string; sourceRefs: string[];
};
export type OwnerLoopPartialHost = NonNullable<ReturnType<typeof createOwnerLoopPartialHost>>;

/** A reserved audit without a loaded runtime gets a failure record, never a fabricated runtime/context receipt. */
export async function closeOwnerLoopPartialSetup(input: {
  streamStarted: boolean; host?: OwnerLoopPartialHost; reservedTurnId?: string;
  reservedAuditSink?: (event: AnswerEvidenceAuditEvent) => Promise<unknown>;
}): Promise<"skipped" | "core_closed" | "setup_failed_audit_recorded" | "setup_failed_audit_unconfirmed"> {
  if (input.streamStarted || !input.reservedTurnId) return "skipped";
  if (input.host) {
    if (input.host.turnId !== input.reservedTurnId) return "setup_failed_audit_unconfirmed";
    await input.host.closeUnstarted("request_setup_did_not_reach_runtime_stream");
    return input.host.core.snapshot().auditFailed ? "setup_failed_audit_unconfirmed" : "core_closed";
  }
  if (!input.reservedAuditSink) return "setup_failed_audit_unconfirmed";
  try {
    await input.reservedAuditSink({ eventKey: "partial_setup_failed_before_core", eventType: "turn_failed", payload: {
      scope: "request_setup_before_runtime_load", runtimeStarted: false, runtimeTerminalObserved: false,
      sdkContextCommitObserved: false, verifiedFactCommitted: false,
      reason: "request_setup_did_not_reach_loaded_owner_partial_core" } });
    return "setup_failed_audit_recorded";
  } catch { return "setup_failed_audit_unconfirmed"; }
}

/** The entry uses this same predicate before reserving an audit turn. */
export function canCreateOwnerLoopPartialHost(context: TrustedLoopRuntimeContext, originalQuestion: string, selectedEvidence: unknown): boolean {
  return selectedEvidence == null && isTrustedLoopRuntimeContext(context)
    && exactExplicitOwnerLoopQuestionId(originalQuestion) === context.loopId.toLowerCase()
    && ownerLoopFacetQuestionScope(originalQuestion) !== "runtime_only"
    && ownerLoopCurrentRuntimeRequested(originalQuestion);
}

/** Only the authenticated entry creates this core; selected sessions remain exclusive. */
export function createOwnerLoopPartialHost(options: {
  selectedEvidence: unknown; context: TrustedLoopRuntimeContext; originalQuestion: string;
  turnId: string; runtimeHash: string; policyHash: string; toolNames: readonly string[];
  auditSink?: (event: AnswerEvidenceAuditEvent) => Promise<unknown>;
  authorizeFinal?: () => Promise<boolean>;
}) {
  const context = options.context;
  if (!canCreateOwnerLoopPartialHost(context, options.originalQuestion, options.selectedEvidence)
    || !options.turnId || !options.runtimeHash || !options.policyHash) return undefined;
  const factEvidenceIds: Record<string, string[]> = Object.create(null);
  const questionHash = answerTextHash(JSON.stringify(options.originalQuestion));
  const toolNames = context.adapter === "native_platform_recall" ? ["platformRecall"]
    : ["readLoopRuntimeObservation", "readLoopRunTimeline", "readRunRecord"];
  const registeredNames = toolNames.filter(name => options.toolNames.includes(name));
  function project(input: ToolConstruction): OwnerReceipt | undefined {
    const params = object(input.params), payload = object(input.result);
    if (!params || !payload || payload.ok === false
      || params.ownerId !== undefined && params.ownerId !== context.ownerId
      || params.userId !== undefined && params.userId !== context.ownerId) return undefined;
    const data = context.adapter === "native_platform_recall" ? object(payload.data) : payload;
    if (!data) return undefined;
    const refs: string[] = [];
    const record = context.adapter === "native_platform_recall" ? object(data.recordRead) : input.toolName === "readRunRecord" ? payload : undefined;
    const request = context.adapter === "native_platform_recall" ? object(params.recordRead)
      : input.toolName === "readRunRecord" ? { source: "loopRuns", id: params.runId, offset: params.offset ?? 0, expectedHash: params.expectedHash } : undefined;
    if (record && request && record.status === "read" && record.source === request.source && record.id === request.id
      && typeof record.id === "string" && uuid.test(record.id) && ["loops", "loopRuns"].includes(String(record.source))
      && (record.source !== "loops" || record.id.toLowerCase() === context.loopId.toLowerCase())
      && Number.isSafeInteger(record.offset) && record.offset === (request.offset ?? 0)
      && typeof record.content === "string" && record.content.length <= 24000
      && typeof record.contentHash === "string" && /^[a-f0-9]{64}$/.test(record.contentHash)
      && (request.expectedHash === undefined || request.expectedHash === record.contentHash)) {
      refs.push(`${record.source}:${record.id}@${record.contentHash}`);
    }
    const runtimeRequest = context.adapter === "native_platform_recall" ? object(params.runtimeRead)
      ?? (typeof params.question === "string" && exactExplicitOwnerLoopQuestionId(params.question) === context.loopId.toLowerCase()
        ? { loopId: context.loopId } : undefined) : params;
    const runtimeObservation = input.toolName === context.toolName && (!request)
      && runtimeRequest && (runtimeRequest.loopId === undefined && context.adapter === "owner_workflow_runtime_reader"
        || typeof runtimeRequest.loopId === "string" && runtimeRequest.loopId.toLowerCase() === context.loopId.toLowerCase())
      ? projectTrustedLoopRuntimeObservation(context, { toolCallId: input.toolCallId, output: input.result }) : undefined;
    if (runtimeObservation?.state === "observed") refs.push(`tool:${input.toolCallId}`);
    // Discovery/timeline, partial fields and unrecognised sources cannot create fact receipts.
    if (!refs.length) return undefined;
    const observedAt = runtimeObservation?.observedAt ?? input.observedAt ?? input.trace.timestamp;
    if (!validEvidenceTime(observedAt)) return undefined;
    const evidenceId = answerEvidenceHash({ turnId: options.turnId, ownerId: context.ownerId,
      loopId: context.loopId, questionHash, toolCallId: input.toolCallId, sourceRefs: refs,
      resultHash: answerEvidenceHash(input.result), traceHash: answerEvidenceHash(input.trace) });
    for (const ref of refs) (factEvidenceIds[ref] ??= []).push(evidenceId);
    return { evidenceId, ownerId: context.ownerId, loopId: context.loopId, turnId: options.turnId,
      originalQuestionHash: questionHash, runtimeHash: options.runtimeHash, policyHash: options.policyHash,
      sourceRefs: refs, observation: { kind: "live", observedAt }, delivery: "result_constructed" };
  }
  const core = createAnswerEvidenceCore<CoreReceipt>({ mode: "owner_partial", supported: true,
    turnId: options.turnId, toolNames: registeredNames, project,
    auditSink: options.auditSink, authorizeFinal: options.authorizeFinal });
  const binding = bindOwnerLoopPartialDelivery({ selectedEvidence: options.selectedEvidence, currentCore: core,
    ownerId: context.ownerId, loopId: context.loopId, originalQuestion: options.originalQuestion, factEvidenceIds }).binding!;
  Object.assign(binding, { turnId: options.turnId, runtimeHash: options.runtimeHash, policyHash: options.policyHash });
  return { turnId: options.turnId, binding, core,
    // These functions are installed at the actual construction/SDK host callbacks.
    onResultConstructed: (receipt: ToolConstruction) => core.observeToolConstruction(receipt),
    onToolContextCommitted: (receipt: SdkContextCommit) => core.observeContextCommitted(receipt),
    observeToolResult: (event: AgentMessage) => core.observeToolResult(event),
    async closeUnstarted(reason: string) {
      for await (const _event of deliverOwnerLoopPartial({ context, originalQuestion: options.originalQuestion,
        events: [], independentFacts: [], gaps: [reason], rawDraft: "", rawDraftCharacters: 0, overflow: false, binding })) { /* audit failure closure only; no fabricated runtime/context event */ }
    } };
}
