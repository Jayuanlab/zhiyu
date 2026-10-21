import { createHash } from "node:crypto";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import type { EvidenceObservation } from "@/lib/memory/retrieval/evidence-time";
import type { AnswerEvidenceAuditEvent, FinalizeAnswerInput, ToolConstruction } from "./answer-evidence-contract";

export const MAX_ANSWER_DRAFT_CHARACTERS = 64_000;
export const objectRecord = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const answerEvidenceHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
export const answerTextHash = (value: string) => createHash("sha256").update(value).digest("hex");
// JSON string encoding preserves distinct UTF-16 code units, including lone
// surrogates that Node's plain UTF-8 encoding otherwise replaces identically.
const promptTextHash = (value: string) => answerTextHash(JSON.stringify(value));
export const validEvidenceTime = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
export type CoreReceipt = {
  evidenceId: string; observation: EvidenceObservation;
  delivery: "result_constructed" | "tool_result_emitted";
  deliveryToolUseId?: string;
};
export type CoreDecision = {
  outcome: string; renderedText: string; renderedTextHash: string;
  rawDraftHash: string; auditPersisted: boolean; auditIncomplete: boolean;
};
export type CoreFinalState<R> = {
  input: FinalizeAnswerInput; receipts: R[]; contextReceipts: R[];
  failed: boolean; overflow: boolean; allowed: boolean; finalDenied: boolean;
  rawDraftCharacters: number; rawDraftHash: string; now: Date;
};
export type SdkContextCommit = { toolCallId: string; entryId: string; modelText: string };
export type PromptEvidenceEmbedding = { toolCallId: string; prompt: string; modelText: string; offsetUtf16: number };

/** One turn owns one core. Domain adapters supply facts/rendering, never authority. */
export function createAnswerEvidenceCore<R extends CoreReceipt>(options: {
  mode: string; supported: boolean; turnId: string;
  project: (input: ToolConstruction) => R | undefined;
  /** Host adapter projection for audit; in-memory facts remain unchanged. */
  auditProjection?: (receipt: R) => Record<string, unknown>;
  auditSink?: (event: AnswerEvidenceAuditEvent) => Promise<unknown>;
  authorizeFinal?: () => Promise<boolean>; now?: () => Date;
  toolNames?: readonly string[];
}) {
  type Construction = { resultHash: string; traceHash: string; modelTextHash?: string; modelText?: string; toolName: string; result: unknown; receipt?: R };
  const constructions = new Map<string, Construction>();
  const emitted = new Map<string, R>(), committed = new Map<string, R>();
  const promptBindings = new Map<string, { promptHash: string; promptHashEncoding: "json_string_utf8"; offsetUtf16: number; characters: number }>();
  const gaps = new Set<string>();
  const toolNames = new Set(options.toolNames ?? ["platformRecall", "askMemory"]);
  const auditReceipt = (receipt: R) => options.auditProjection?.(receipt) ?? receipt;
  let closing = false, auditFailure = false;
  let auditQueue = Promise.resolve();
  let finalPromise: Promise<CoreDecision> | undefined;
  const append = (event: AnswerEvidenceAuditEvent) => {
    if (!options.auditSink) { auditFailure = true; return Promise.resolve(false); }
    const pending = auditQueue.then(async () => {
      try { await options.auditSink!(event); return true; } catch { auditFailure = true; return false; }
    });
    auditQueue = pending.then(() => undefined);
    return pending;
  };
  async function observeToolConstruction(input: ToolConstruction) {
    if (options.mode === "off" || !options.supported || closing || !input.toolCallId || !toolNames.has(input.toolName)) return;
    const trace = input.trace;
    if (trace.toolUseId !== input.toolCallId || trace.toolName !== input.toolName || trace.status !== "completed"
      || trace.metadata?.decision !== "allow" || trace.metadata.deniedBeforeHandler || !validEvidenceTime(trace.timestamp)) {
      gaps.add("invalid_host_construction"); return;
    }
    const resultHash = answerEvidenceHash(input.result), traceHash = answerEvidenceHash(trace);
    const modelTextHash = typeof input.modelText === "string" ? answerTextHash(input.modelText) : undefined;
    const prior = constructions.get(input.toolCallId);
    if (prior) { if (prior.resultHash !== resultHash || prior.traceHash !== traceHash || prior.modelTextHash !== modelTextHash || prior.modelText !== input.modelText) gaps.add("construction_conflict"); return; }
    const receipt = options.project(input);
    constructions.set(input.toolCallId, { resultHash, traceHash, modelTextHash, modelText: input.modelText, toolName: input.toolName, result: input.result, receipt });
    if (receipt) {
      const { delivery: _delivery, ...sourceObservation } = auditReceipt(receipt);
      await append({ eventKey: `${input.toolCallId}:observed_server`, eventType: "observed_server", payload: {
        toolCallId: input.toolCallId, stage: "observed_server", registrationStage: "result_constructed_callback",
        recordedAt: (options.now ?? (() => new Date()))().toISOString(), sourceObservedAt: receipt.observation.observedAt, sourceObservation,
      } });
    }
    await append({ eventKey: `${input.toolCallId}:result_constructed`, eventType: "evidence_registered", payload: {
      toolCallId: input.toolCallId, toolName: input.toolName, resultHash, traceHash, modelTextHash,
      delivery: "result_constructed", ...(receipt ? { receipt: auditReceipt(receipt) } : {}),
    } });
  }
  function matching(toolCallId: string, result: unknown, trace: unknown, modelText: unknown) {
    const construction = constructions.get(toolCallId);
    if (!construction || construction.resultHash !== answerEvidenceHash(result) || construction.traceHash !== answerEvidenceHash(trace)
      || typeof modelText !== "string" || construction.modelText !== modelText || construction.modelTextHash !== answerTextHash(modelText)) return undefined;
    return construction;
  }
  async function markEmitted(toolUseId: string, result: unknown, trace: unknown, modelText: unknown, deliveryToolUseId?: string) {
    const construction = matching(toolUseId, result, trace, modelText);
    if (!construction) { gaps.add("tool_result_without_matching_host_construction"); return false; }
    if (construction.receipt && !emitted.has(toolUseId)) {
      const receipt = { ...construction.receipt, delivery: "tool_result_emitted" as const, ...(deliveryToolUseId ? { deliveryToolUseId } : {}) };
      emitted.set(toolUseId, receipt);
      await append({ eventKey: `${toolUseId}:tool_result_emitted`, eventType: "evidence_registered", payload: { receipt: auditReceipt(receipt) } });
    }
    return true;
  }
  async function observeToolResult(event: AgentMessage) {
    if (options.mode === "off" || !options.supported || closing || event.type !== "tool_result" || !event.toolUseId || event.isError || !event.toolResultDetails) return;
    const { result, trace } = event.toolResultDetails;
    if (!await markEmitted(event.toolUseId, result, trace, event.output)) return;
    const construction = constructions.get(event.toolUseId)!;
    if (construction.toolName !== "askMemory") return;
    const delegated = objectRecord(objectRecord(result).details).delegatedReceipts;
    if (!Array.isArray(delegated)) return;
    let outer: Record<string, any>;
    try { outer = objectRecord(JSON.parse(construction.modelText ?? "")); } catch { return; }
    if (!Array.isArray(outer.observations)) return;
    for (const raw of delegated) {
      const item = objectRecord(raw);
      if (item.deliveredComplete !== true || !toolNames.has(item.toolName) || item.toolName === "askMemory" || typeof item.toolCallId !== "string") continue;
      if (!item.toolCallId.startsWith(`${event.toolUseId}:`) || typeof item.modelText !== "string"
        || !outer.observations.some((observation: any) => observation?.tool === item.toolName && observation?.status === "retrieved"
          && observation?.truncated === false && observation?.evidence === item.modelText)) { gaps.add("delegated_result_not_fully_visible"); continue; }
      await markEmitted(item.toolCallId, item.result, item.trace, item.modelText, event.toolUseId);
    }
  }
  async function commitConstruction(callId: string, registered: Construction, entryId: string,
    source: "sdk_tool_result_entry" | "sdk_prompt_entry", extra: Record<string, unknown> = {}) {
    if (!registered.receipt || committed.has(callId)) return;
    committed.set(callId, registered.receipt);
    await append({ eventKey: `${callId}:context_committed`, eventType: "context_committed", payload: {
      toolCallId: callId, entryId, modelTextHash: registered.modelTextHash, evidenceId: registered.receipt.evidenceId,
      source, ...extra,
    } });
  }
  /** Host registration of an exact result slice, before the SDK commits the prompt. */
  async function bindPromptEvidence(input: PromptEvidenceEmbedding) {
    if (options.mode === "off" || !options.supported || closing) return;
    const construction = constructions.get(input.toolCallId);
    if (!construction?.receipt || typeof input.prompt !== "string" || typeof input.modelText !== "string"
      || !input.modelText.length || !Number.isSafeInteger(input.offsetUtf16) || input.offsetUtf16 < 0
      || construction.modelText !== input.modelText
      || construction.modelTextHash !== answerTextHash(input.modelText)
      || input.prompt.slice(input.offsetUtf16, input.offsetUtf16 + input.modelText.length) !== input.modelText) {
      gaps.add("prompt_embedding_without_matching_construction"); return;
    }
    const binding = { promptHash: promptTextHash(input.prompt), promptHashEncoding: "json_string_utf8" as const,
      offsetUtf16: input.offsetUtf16, characters: input.modelText.length };
    const prior = promptBindings.get(input.toolCallId);
    if (prior) { if (answerEvidenceHash(prior) !== answerEvidenceHash(binding)) gaps.add("construction_conflict"); return; }
    if (promptBindings.size >= 4) { gaps.add("prompt_embedding_limit_exceeded"); return; }
    promptBindings.set(input.toolCallId, binding);
    await append({ eventKey: `${input.toolCallId}:prompt_embedded`, eventType: "prompt_evidence_embedded", payload: {
      toolCallId: input.toolCallId, ...binding, modelTextHash: construction.modelTextHash, delivery: "host_prompt_embedding",
    } });
  }
  /** Actual SDK user entry. Registration alone, partial text and user claims cannot grant this stage. */
  async function observePromptContextCommitted(input: { entryId: string; modelText: string }) {
    if (options.mode === "off" || !options.supported || closing || !input.entryId || typeof input.modelText !== "string") return;
    const promptHash = promptTextHash(input.modelText);
    for (const [callId, binding] of promptBindings) {
      if (committed.has(callId)) continue;
      const construction = constructions.get(callId);
      if (binding.promptHash !== promptHash || !construction?.modelText
        || input.modelText.slice(binding.offsetUtf16, binding.offsetUtf16 + binding.characters) !== construction.modelText) {
        gaps.add("prompt_embedding_not_committed"); continue;
      }
      await commitConstruction(callId, construction, input.entryId, "sdk_prompt_entry", binding);
    }
  }
  /** SDK toolResult entry_added only. Neither tool_end, queue.push nor SSE delivery grants this stage. */
  async function observeContextCommitted(input: SdkContextCommit) {
    if (options.mode === "off" || !options.supported || closing) return;
    const construction = constructions.get(input.toolCallId);
    if (!input.entryId || !construction || construction.modelText !== input.modelText || construction.modelTextHash !== answerTextHash(input.modelText)) { gaps.add("context_without_matching_construction"); return; }
    const commit = (callId: string, registered: Construction, deliveryToolUseId?: string) => commitConstruction(callId, registered,
      input.entryId, "sdk_tool_result_entry", deliveryToolUseId ? { deliveryToolUseId } : {});
    await commit(input.toolCallId, construction);
    if (construction.toolName !== "askMemory") return;
    // The SDK commits the outer toolResult entry. A delegated child is in that
    // context only when the complete registered child text is in its body.
    let outer: Record<string, any>;
    try { outer = objectRecord(JSON.parse(input.modelText)); } catch { return; }
    const delegated = objectRecord(objectRecord(construction.result).details).delegatedReceipts;
    if (!Array.isArray(delegated) || !Array.isArray(outer.observations)) return;
    for (const raw of delegated) {
      const item = objectRecord(raw);
      if (item.deliveredComplete !== true || !toolNames.has(item.toolName) || item.toolName === "askMemory"
        || typeof item.toolCallId !== "string" || !item.toolCallId.startsWith(`${input.toolCallId}:`) || typeof item.modelText !== "string"
        || !outer.observations.some((value: any) => value?.tool === item.toolName && value?.status === "retrieved" && value?.truncated === false && value?.evidence === item.modelText)) continue;
      const child = matching(item.toolCallId, item.result, item.trace, item.modelText);
      if (child) await commit(item.toolCallId, child, input.toolCallId);
    }
  }
  async function finalizeOnce<D extends CoreDecision>(input: FinalizeAnswerInput,
    render: (state: CoreFinalState<R>) => D, onAuditFailure: (decision: D, state: CoreFinalState<R>) => void): Promise<D> {
    closing = true;
    await auditQueue;
    const rawDraftCharacters = input.rawDraftCharacters ?? input.rawDraft.length;
    const overflow = Boolean(input.draftOverflow || rawDraftCharacters > MAX_ANSWER_DRAFT_CHARACTERS);
    const terminal = input.terminal;
    const failed = !terminal || terminal.schemaVersion !== "agent-runtime-terminal.v1" || terminal.status !== "completed" || terminal.cleanupStatus !== "completed";
    const auditTerminal = terminal ?? { schemaVersion: "agent-runtime-terminal.v1" as const, status: "failed" as const, cleanupStatus: "failed" as const, completionScope: "runtime" as const, error: "Runtime terminal was not received" };
    let allowed = false;
    if (!failed && !overflow && options.authorizeFinal) { try { allowed = (await options.authorizeFinal()) === true; } catch { gaps.add("authorization_read_failed"); } }
    const state: CoreFinalState<R> = { input, receipts: [...emitted.values()], contextReceipts: [...committed.values()], failed, overflow, allowed,
      finalDenied: !failed && !overflow && !allowed, rawDraftCharacters, rawDraftHash: input.rawDraftHash ?? answerTextHash(input.rawDraft), now: (options.now ?? (() => new Date()))() };
    const base = render(state);
    await append({ eventKey: "runtime_terminal", eventType: "runtime_terminal", payload: { terminal: auditTerminal, mode: options.mode, gaps: [...gaps] } });
    const finalPayload = () => ({ ...base, auditPersisted: true, displayText: options.mode === "shadow" && overflow ? undefined : base.renderedText,
      rawDraft: { text: overflow ? null : input.rawDraft, characters: rawDraftCharacters, sha256: state.rawDraftHash, truncated: overflow } });
    if (!auditFailure) await append({ eventKey: "final_evidence", eventType: "final_evidence", payload: finalPayload() });
    if (!auditFailure) await append({ eventKey: "turn_terminal", eventType: terminal?.status === "aborted" ? "turn_aborted" : failed ? "turn_failed" : "turn_completed", payload: {
      terminal: auditTerminal, mode: options.mode, outcome: base.outcome, renderedTextHash: base.renderedTextHash,
    } });
    if (auditFailure && options.supported) {
      onAuditFailure(base, state); base.auditIncomplete = true;
      const failureTerminal = { ...auditTerminal, status: "failed" as const, completionScope: "answer_delivery" as const,
        ...(terminal ? { runtimeStatus: terminal.runtimeStatus ?? terminal.status } : {}), error: "Answer audit is incomplete; the verified conclusion was not committed" };
      const savedFinal = await append({ eventKey: "final_evidence_audit_failure", eventType: "final_evidence", payload: { ...finalPayload(), displayText: options.mode === "shadow" && overflow ? undefined : base.renderedText, auditIncomplete: true, gaps: [...gaps, "audit_event_failed"] } });
      const savedTerminal = savedFinal && await append({ eventKey: "turn_terminal_audit_failure", eventType: "turn_failed", payload: {
        terminal: failureTerminal, mode: options.mode, outcome: base.outcome, renderedTextHash: base.renderedTextHash, auditIncomplete: true,
      } });
      base.auditPersisted = Boolean(savedFinal && savedTerminal);
    } else base.auditPersisted = !auditFailure;
    return base;
  }
  return { observeToolConstruction, observeToolResult, observeContextCommitted, bindPromptEvidence, observePromptContextCommitted, append, gaps,
    receiptsForAuthorization(): readonly R[] { return [...emitted.values()]; },
    contextReceiptsForClosure(): readonly R[] { return [...committed.values()]; },
    snapshot() { return { receiptCount: emitted.size, contextReceiptCount: committed.size, gaps: [...gaps], closing, auditFailed: auditFailure }; },
    finalize<D extends CoreDecision>(input: FinalizeAnswerInput, render: (state: CoreFinalState<R>) => D, onAuditFailure: (decision: D, state: CoreFinalState<R>) => void): Promise<D> {
      return (finalPromise ??= finalizeOnce(input, render, onAuditFailure)) as Promise<D>;
    },
  };
}
