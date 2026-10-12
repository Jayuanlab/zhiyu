import type { AnswerEvidenceAuditEvent } from "./answer-evidence-contract";
import { answerTextHash, answerEvidenceHash } from "./answer-evidence-core";
import { canonicalPlatformAnswerSource, type PlatformAnswerPlan, type PlatformAnswerReceipt, type PlatformAnswerSessionOptions } from "./platform-answer-contract";
import { renderPlatformAnswer } from "./platform-answer-renderer";

type ClosureCore = {
  contextReceiptsForClosure(): readonly PlatformAnswerReceipt[];
  snapshot(): { closing: boolean; auditFailed: boolean };
  append(event: AnswerEvidenceAuditEvent): Promise<boolean>;
};
const fieldForHandle = (field: string) => field === "textParts" ? "known_text" : field;

/** P3 is opt-in. It plans from SDK-committed host receipts, never SSE mirrors,
 * registry inventory, model prose, missing metrics, or new discovery queries. */
export function createPlatformReadonlyContinuation(plan: PlatformAnswerPlan | null, core: ClosureCore, options: PlatformAnswerSessionOptions) {
  let episodePlanned = false;
  let plannedHandles: string[] = [], startInputHash: string | undefined, startPromise: Promise<void> | undefined;
  async function beforeClose(): Promise<{ followUp: string; readHandles: string[] } | null> {
    if (!plan || options.mode !== "enforce_supported" || !options.readonlyContinuation?.enabled || episodePlanned || core.snapshot().closing || core.snapshot().auditFailed) return null;
    const receipts = [...core.contextReceiptsForClosure()];
    const decision = renderPlatformAnswer(plan, { input: { terminal: null, rawDraft: "" }, receipts, contextReceipts: receipts,
      failed: false, overflow: false, allowed: true, finalDenied: false, rawDraftCharacters: 0, rawDraftHash: answerTextHash(""), now: (options.now ?? (() => new Date()))() }, options);
    const unresolved = plan.requirements.filter(requirement => ["field", "known_text"].includes(requirement.facet)
      && decision.resolutions.some(resolution => resolution.requirementId === requirement.id && resolution.state === "unknown" && resolution.reason === "matching_field_not_read"));
    const close = async (reason: string) => {
      await core.append({ eventKey: `read_phase_closed:${reason}`, eventType: "read_phase_closed", payload: {
        schemaVersion: "platform-answer-progress.v1", reason, questionComplete: decision.questionComplete, evidenceCoverage: decision.evidenceCoverage,
      } });
      return null;
    };
    if (!unresolved.length) return close("no_safe_field_continuation");
    const contextFacts = receipts.flatMap(receipt => receipt.facts);
    const handles: string[] = [];
    for (const requirement of unresolved) {
      let id = requirement.subjectId;
      if (requirement.linkedBy && plan.subject) {
        const links = contextFacts.filter(fact => fact.kind === "field" && fact.source === plan.subject!.source && fact.id === plan.subject!.id && fact.fieldKey === requirement.linkedBy)
          .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
        const link = links[0];
        if (link?.kind === "field" && typeof link.value === "string") id = link.value.toLowerCase();
      }
      if (!id) continue;
      const field = requirement.facet === "known_text" ? "known_text" : requirement.fieldKey;
      const candidates = receipts.flatMap(receipt => receipt.readHandles ?? []).filter(handle => canonicalPlatformAnswerSource(handle.source) === requirement.source && handle.id === id && fieldForHandle(handle.fieldKey) === field);
      for (const handle of candidates) {
        try {
          const binding = options.readonlyContinuation.resolveReadHandle(handle.readHandle);
          if (binding.ownerId !== options.ownerId || binding.turnId !== options.turnId || binding.requester.kind !== "chat"
            || binding.source !== handle.source || binding.id.toLowerCase() !== handle.id || binding.fieldKey !== handle.fieldKey || binding.contentHash !== handle.parentContentHash) continue;
          if (!handles.includes(handle.readHandle)) handles.push(handle.readHandle);
          break;
        } catch { /* Expired, closed and foreign bindings remain an explicit gap. */ }
      }
      // One necessary field leaves the second extra forward for the answer.
      if (handles.length === 1) break;
    }
    if (!handles.length) return close("no_sdk_committed_registered_handle");
    let budget;
    try { budget = options.readonlyContinuation.readBudgetSnapshot(); } catch { return close("continuation_budget_unavailable"); }
    // Reserve the host-enforced maximum for the whole formatted tool envelope.
    // Native and frozen wrappers differ; the field reader's 8000-character
    // inner value alone cannot bound them. UTF-16 characters are not tokens.
    if (!budget || budget.schemaVersion !== "memory-read-budget.v1" || budget.inFlight !== 0 || budget.inFlightSize !== "none"
      || !Number.isSafeInteger(budget.attempts) || !Number.isSafeInteger(budget.committedCharacters) || !Number.isSafeInteger(budget.reservedCharacters)
      || budget.attempts < 0 || budget.committedCharacters < 0 || budget.reservedCharacters < 0
      || budget.maximumAttempts !== 10 || budget.maximumSingleCharacters !== 24_000 || budget.maximumTotalCharacters !== 64_000
      || budget.characterUnit !== "javascript_utf16") return close("continuation_read_budget_exhausted");
    const capacity = Math.min(1, budget.maximumAttempts - budget.attempts, Math.floor((budget.maximumTotalCharacters - budget.committedCharacters - budget.reservedCharacters) / budget.maximumSingleCharacters));
    if (capacity < 1) return close("continuation_read_budget_exhausted");
    handles.splice(capacity);
    episodePlanned = true;
    plannedHandles = [...handles];
    const recorded = await core.append({ eventKey: "readonly_continuation_planned", eventType: "readonly_continuation_planned", payload: {
      schemaVersion: "platform-readonly-continuation.v1", maxReads: handles.length, maxForwards: 2,
      handleHashes: handles.map(answerTextHash), requirementIds: unresolved.map(item => item.id),
    } });
    if (!recorded) return null;
    return { readHandles: handles, followUp: `原问题及所有问项保持不变。只进行本轮已登记字段的有限补读：最多 ${handles.length} 次 platformRecall，每次参数必须仅包含 readHandle。\n${handles.map(readHandle => JSON.stringify({ readHandle })).join("\n")}\n此次响应只可补读上述字段，下一次额外响应必须仅结束回答，不再请求任何工具。不得重新发现来源，不得调用 askMemory 或其它工具，不得执行修改。仍未核实的字段、范围、业务效果与其它问项保持未知。` };
  }
  async function observeContinuationStarted(input: { readHandles: string[]; maxForwards: 2; maxReads: 2; reservedOutputTokens: number }) {
    if (!episodePlanned || JSON.stringify(input.readHandles) !== JSON.stringify(plannedHandles) || input.maxForwards !== 2 || input.maxReads !== 2
      || !Number.isSafeInteger(input.reservedOutputTokens) || input.reservedOutputTokens < 1) throw Error("Readonly continuation start did not match the admitted episode");
    const inputHash = answerEvidenceHash(input);
    if (startPromise) {
      if (startInputHash !== inputHash) throw Error("Readonly continuation start conflicts with the recorded episode");
      return startPromise;
    }
    startInputHash = inputHash;
    startPromise = (async () => {
      const recorded = await core.append({ eventKey: "readonly_continuation_started", eventType: "readonly_continuation_started", payload: {
        schemaVersion: "platform-readonly-continuation.v1", maxForwards: 2, maxReads: plannedHandles.length,
        reservedOutputTokens: input.reservedOutputTokens, handleHashes: plannedHandles.map(answerTextHash),
      } });
      if (!recorded) throw Error("Readonly continuation start audit was not committed");
    })();
    return startPromise;
  }
  return { beforeClose, observeContinuationStarted };
}
