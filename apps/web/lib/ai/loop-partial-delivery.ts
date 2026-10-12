import type { AgentMessage, AgentRuntimeTerminal } from "@openzhiyu/ai/agent/types";
import { answerTextHash, type CoreDecision, type CoreReceipt, type createAnswerEvidenceCore } from "./runtime/answer-evidence-core";
import { guardTrustedLoopRuntimeAnswer, renderLoopRuntimeObservationFacet, unknownLoopRuntimeFacet,
  type HostVerifiedLoopFacet, type LoopRuntimeObservationFacet, type TrustedLoopRuntimeContext } from "./loop-runtime-evidence-boundary";

type OwnedCore = ReturnType<typeof createAnswerEvidenceCore<CoreReceipt>>;
export type OwnerLoopPartialDeliveryBinding = {
  ownerId: string; loopId: string; originalQuestion: string; core: OwnedCore;
  /** Populated by the host construction adapter, never inferred from model text or replay. */
  factEvidenceIds: Readonly<Record<string, readonly string[]>>;
  turnId?: string; runtimeHash?: string; policyHash?: string;
};
/** This seam cannot take over the selected evidence/session's existing core. */
export function bindOwnerLoopPartialDelivery(input: {
  selectedEvidence: unknown; currentCore: OwnedCore | undefined;
  ownerId: string; loopId: string; originalQuestion: string;
  factEvidenceIds: Readonly<Record<string, readonly string[]>>;
}): { binding: OwnerLoopPartialDeliveryBinding | undefined; reason: string } {
  if (input.selectedEvidence != null) return { binding: undefined, reason: "existing_selected_evidence_owns_turn" };
  if (!input.currentCore) return { binding: undefined, reason: "host_owned_core_not_available_actual_entry_pending" };
  return { binding: { ownerId: input.ownerId, loopId: input.loopId, originalQuestion: input.originalQuestion,
    core: input.currentCore, factEvidenceIds: input.factEvidenceIds }, reason: "host_owned_existing_core_bound" };
}
type PartialDecision = CoreDecision & {
  outcome: "partial" | "execution_failed" | "unknown";
  committed: boolean; retainedIndependentFacts: HostVerifiedLoopFacet[];
  runtimeFacet: LoopRuntimeObservationFacet; gaps: string[];
};
export async function* deliverOwnerLoopPartial(input: {
  context: TrustedLoopRuntimeContext; originalQuestion: string; events: readonly AgentMessage[];
  independentFacts: readonly HostVerifiedLoopFacet[]; gaps: readonly string[];
  rawDraft: string; rawDraftCharacters: number; overflow: boolean;
  binding?: OwnerLoopPartialDeliveryBinding;
  /** Diagnostic owner-domain coverage, never a context-commit receipt. */
  hostCoverage?: unknown;
}): AsyncGenerator<AgentMessage> {
  const originalQuestion = { text: input.originalQuestion, charactersUtf16: input.originalQuestion.length,
    sha256: answerTextHash(JSON.stringify(input.originalQuestion)), encoding: "json_string_utf8" };
  let runtimeFacet = unknownLoopRuntimeFacet(input.context, "runtime_observation_missing");
  async function* actualReads() { for (const event of input.events) yield event; }
  // Replaying registered events only projects a host observation. It does not call core construction/context methods.
  for await (const event of guardTrustedLoopRuntimeAnswer(actualReads(), input.context, { questionScope: "runtime_only" })) {
    if (event.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1")
      runtimeFacet = event.answerEvidence.runtimeFacet as LoopRuntimeObservationFacet;
  }
  const terminalEvent = [...input.events].reverse().find(e => e.type === "runtime_terminal");
  const terminal: AgentRuntimeTerminal | null = input.events.some(event => event.type === "error")
    ? null : terminalEvent?.runtimeTerminal ?? null;
  const done = [...input.events].reverse().find(e => e.type === "done");
  const gaps = [...new Set(input.gaps)];
  const stagedFacts = input.independentFacts.filter(f => f.text.trim() && f.evidenceRefs.length > 0);
  const binding = input.binding;
  const bindingMatches = binding && binding.ownerId === input.context.ownerId && binding.loopId === input.context.loopId
    && binding.originalQuestion === input.originalQuestion;
  const notice = "本轮回答尚未提交，当前执行状态仍未知。原问题的独立问项仍有证据缺口；不会把未经核验的草稿作为执行状态或修复结论。";
  const unknownNotice = "本轮未确认任何经 SDK 提交且获最终授权的事实，回答尚未提交，当前状态仍未知。审计记录保存与事实提交是两个状态；审计保存不代表模型已读到事实，也不代表原问题已完成。";
  if (!bindingMatches) {
    yield { type: "answer_evidence", answerEvidence: { schemaVersion: "owner-loop-partial-delivery.v1",
      outcome: "unknown", commitState: "uncommitted", originalQuestion, fullOriginalQuestionVerified: false,
      outputPolicy: "unsafe_draft_withheld_gap_notice", gaps: [...gaps, binding ? "host_binding_subject_or_question_mismatch" : "host_owned_core_binding_missing"],
      stagedIndependentFacts: stagedFacts, stagedRuntimeObservation: runtimeFacet,
      evidenceStage: "registered_tool_result_observation_only", sdkContextCommitObserved: false,
      hostCoverage: input.hostCoverage, coverageStage: "owner_domain_projection_before_sdk_closure",
      committedIndependentFacts: [], automaticReadsExecuted: false } };
    yield { type: "text", content: notice, answerPhase: "candidate_final" };
    if (done) yield done;
    return;
  }
  const runtimeRef = runtimeFacet.toolCallId ? `tool:${runtimeFacet.toolCallId}` : null;
  const decision = await binding.core.finalize<PartialDecision>({ terminal, rawDraft: input.rawDraft,
    rawDraftCharacters: input.rawDraftCharacters, draftOverflow: input.overflow }, state => {
    const committedReceipts = new Map(state.contextReceipts.map(r => [r.evidenceId, r]));
    const refsCommitted = (refs: readonly string[]) => refs.length > 0 && refs.every(ref => {
      const ids = binding.factEvidenceIds[ref]; return ids?.length && ids.every(id => {
        const receipt = committedReceipts.get(id);
        if (!receipt) return false;
        const source = receipt as CoreReceipt & { ownerId?: string; loopId?: string; originalQuestionHash?: string; sourceRefs?: string[] };
        return source.ownerId === input.context.ownerId && source.loopId === input.context.loopId
          && source.originalQuestionHash === originalQuestion.sha256 && source.sourceRefs?.includes(ref) === true;
      });
    });
    const allowed = !state.failed && !state.overflow && state.allowed && !state.finalDenied;
    const retained = allowed ? stagedFacts.filter(f => refsCommitted(f.evidenceRefs)) : [];
    const verifiedRuntime = allowed && runtimeRef && refsCommitted([runtimeRef])
      ? runtimeFacet : unknownLoopRuntimeFacet(input.context, "sdk_context_commit_or_final_authorization_unverified");
    const missing = stagedFacts.filter(f => !retained.includes(f)).flatMap(f => f.evidenceRefs.map(ref => `context_commit_unverified:${ref}`));
    const finalGaps = [...new Set([...gaps, ...missing, ...(!runtimeRef || verifiedRuntime.state !== "observed" ? ["runtime_context_or_observation_unverified"] : [])])];
    const factsCommitted = retained.length > 0 || verifiedRuntime.state === "observed";
    const renderedText = allowed && factsCommitted ? [...retained.map(f => f.text), renderLoopRuntimeObservationFacet(verifiedRuntime),
      "原问题只完成部分核对；其余独立问项未核实，不能据此宣称整个问题已完成。"].join("\n\n") : factsCommitted ? notice : unknownNotice;
    return { outcome: state.failed ? "execution_failed" : allowed && factsCommitted ? "partial" : "unknown", renderedText,
      renderedTextHash: answerTextHash(renderedText), rawDraftHash: state.rawDraftHash, auditPersisted: false,
      auditIncomplete: false, committed: allowed && factsCommitted, retainedIndependentFacts: retained, runtimeFacet: verifiedRuntime,
      gaps: [...new Set([...finalGaps, ...(!factsCommitted ? ["no_verified_fact_committed_to_sdk_context"] : [])])] };
  }, failed => {
    failed.committed = false; failed.retainedIndependentFacts = []; failed.runtimeFacet = unknownLoopRuntimeFacet(input.context, "audit_not_persisted");
    failed.renderedText = notice; failed.renderedTextHash = answerTextHash(notice); failed.outcome = "unknown";
    failed.gaps = [...new Set([...failed.gaps, "audit_not_persisted"])];
  });
  const committed = decision.committed && decision.auditPersisted && !decision.auditIncomplete;
  yield { type: "answer_evidence", answerEvidence: { schemaVersion: "owner-loop-partial-delivery.v1", outcome: decision.outcome,
    commitState: committed ? "committed_partial" : "uncommitted", originalQuestion, fullOriginalQuestionVerified: false,
    turnId: binding.turnId, runtimeHash: binding.runtimeHash, policyHash: binding.policyHash,
    hostCoverage: input.hostCoverage, coverageStage: "owner_domain_projection_before_sdk_closure",
    outputPolicy: "unsafe_draft_withheld_gap_notice", gaps: decision.gaps, committedIndependentFacts: committed ? decision.retainedIndependentFacts : [],
    runtimeFacet: decision.runtimeFacet, auditPersisted: decision.auditPersisted, auditIncomplete: decision.auditIncomplete,
    auditState: decision.auditPersisted && !decision.auditIncomplete ? "audit_persisted" : "audit_unconfirmed",
    factCommitState: committed ? "verified_partial_facts_committed" : "no_verified_fact_commit",
    sdkContextCommitObserved: binding.core.contextReceiptsForClosure().length > 0,
    sdkContextReceiptCount: binding.core.contextReceiptsForClosure().length,
    finalFactCommitAccepted: committed,
    automaticReadsExecuted: false } };
  yield { type: "text", content: decision.renderedText, answerPhase: committed ? "committed" : "candidate_final" };
  if (committed) yield { type: "result", content: decision.renderedText, answerPhase: "committed" };
  if (done) yield done;
}
