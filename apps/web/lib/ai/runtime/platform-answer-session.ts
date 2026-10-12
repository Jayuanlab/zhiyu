import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import type { FinalizeAnswerInput, ToolConstruction } from "./answer-evidence-contract";
import { createAnswerEvidenceCore, answerEvidenceHash, answerTextHash } from "./answer-evidence-core";
import { PLATFORM_ANSWER_RULE_VERSION, selectPlatformAnswerContract, type PlatformAnswerReceipt, type PlatformAnswerSessionOptions, type PlatformAnswerDecision } from "./platform-answer-contract";
import { projectPlatformAnswerReceipt } from "./platform-answer-validator";
import { renderPlatformAnswer } from "./platform-answer-renderer";
import { createPlatformReadonlyContinuation } from "./platform-answer-continuation";
export { guardPlatformAnswer } from "./platform-answer-gate";

/** One domain adapter over the same core used by the existing exact Loop v1. */
export function createPlatformAnswerSession(options: PlatformAnswerSessionOptions) {
  const plan = selectPlatformAnswerContract(options.question);
  const supported = Boolean(plan);
  const core = createAnswerEvidenceCore<PlatformAnswerReceipt>({ ...options, supported,
    project: input => projectPlatformAnswerReceipt(input, options),
    authorizeFinal: plan && options.authorizeFinal ? async () => {
      const subjects = new Map<string, { source: "loopRuns" | "workshopRuns" | "loops" | "message" | "chat"; id: string }>();
      if (plan.subject) subjects.set(`${plan.subject.source}:${plan.subject.id}`, plan.subject);
      const facts = core.receiptsForAuthorization().flatMap(receipt => receipt.facts);
      for (const requirement of plan.requirements) {
        if (!requirement.linkedBy || !plan.subject) continue;
        const links = facts.filter(fact => fact.kind === "field" && fact.source === plan.subject!.source && fact.id === plan.subject!.id && fact.fieldKey === requirement.linkedBy);
        for (const link of links) if (link.kind === "field" && typeof link.value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(link.value)) {
          const source = requirement.source === "loops" ? "loops" : requirement.source === "chat" ? "chat" : undefined;
          const id = link.value.toLowerCase();
          if (source && facts.some(fact => fact.kind === "field" && fact.source === source && fact.id === id)) subjects.set(`${source}:${id}`, { source, id });
        }
      }
      if (await options.authorizeFinal!({ ...plan, finalAuthorizationSubjects: [...subjects.values()] }) !== true) return false;
      const pages = core.contextReceiptsForClosure().filter(receipt => receipt.fieldPageReceipt);
      const bindings = new Map(pages.map(receipt => {
        const result = receipt.fieldPageReceipt!;
        const binding = result.hostFieldManifest?.binding ?? ("binding" in result.fieldPage ? result.fieldPage.binding : undefined);
        return [JSON.stringify(binding), binding] as const;
      }));
      for (const binding of bindings.values()) {
        if (!binding || !options.authorizeFieldPageFinal) return false;
        const manifest = pages.find(receipt => receipt.fieldPageReceipt?.hostFieldManifest?.binding === binding)?.fieldPageReceipt?.hostFieldManifest;
        if (manifest) try {
          if (!options.resolveFieldPageReadHandle) return false;
          const registered = options.resolveFieldPageReadHandle(manifest.readHandle);
          if (registered.contentHash !== binding.parentContentHash || registered.ownerId !== binding.ownerId || registered.turnId !== binding.turnId) return false;
        } catch { return false; }
        let allowed: unknown;
        try { allowed = await options.authorizeFieldPageFinal(binding); } catch { return false; }
        if (allowed !== true) return false;
      }
      return true;
    } : undefined,
    auditProjection: receipt => ({ ...receipt,
      ...(receipt.fieldPageReceipt ? { fieldPageReceipt: { ...receipt.fieldPageReceipt, fieldPage: {
        ...receipt.fieldPageReceipt.fieldPage, content: undefined, contentUTF16: receipt.fieldPageReceipt.fieldPage.content.length,
      } } } : {}), ...(receipt.readHandles ? { readHandles: receipt.readHandles.map(({ readHandle, ...metadata }) => ({ ...metadata, readHandleHash: answerTextHash(readHandle) })) } : {}), facts: receipt.facts.map(fact => {
      if (fact.kind === "gap") return fact;
      if (fact.kind === "metric") return { kind: fact.kind, source: fact.source, proofId: fact.proofId, total: fact.total,
        groupsHash: answerEvidenceHash(fact.groups ?? null), observation: fact.observation, observedAt: fact.observedAt, scope: fact.scope };
      return { kind: fact.kind, source: fact.source, id: fact.id, fieldKey: fact.fieldKey, valueHash: answerEvidenceHash(fact.value),
        state: fact.state, observedAt: fact.observedAt, scope: fact.scope, ...(fact.contentHash ? { contentHash: fact.contentHash } : {}) };
    }) }),
  });
  if (plan && options.mode !== "off") void core.append({ eventKey: "requirements_planned", eventType: "requirements_planned", payload: {
    schemaVersion: "platform-answer-progress.v1", requirements: plan.requirements.map(({ id, label, source, fieldKey, facet }) => ({ id, label, source, ...(fieldKey ? { fieldKey } : {}), facet })),
  } });
  const continuation = createPlatformReadonlyContinuation(plan, core, options);
  let decision: PlatformAnswerDecision | undefined;
  return {
    mode: options.mode, turnId: options.turnId, supported, ruleVersion: PLATFORM_ANSWER_RULE_VERSION, contractKind: plan?.kind ?? null, plan,
    observeToolConstruction(input: ToolConstruction) { return core.observeToolConstruction(input); },
    observeToolResult(event: AgentMessage) { return core.observeToolResult(event); },
    observeContextCommitted: core.observeContextCommitted,
    bindPromptEvidence: core.bindPromptEvidence,
    observePromptContextCommitted: core.observePromptContextCommitted,
    beforeClose: continuation.beforeClose,
    observeContinuationStarted: continuation.observeContinuationStarted,
    async finalize(input: FinalizeAnswerInput): Promise<PlatformAnswerDecision> {
      const result = await core.finalize(input, state => {
        if (!plan || options.mode === "off") return { schemaVersion: "platform-answer-decision.v1" as const, mode: options.mode, contractKind: "run_outcome" as const,
          ruleVersion: PLATFORM_ANSWER_RULE_VERSION, runtimeHash: options.runtimeHash, outcome: "unchecked" as const, resolutions: [],
          questionComplete: false, evidenceCoverage: { supported: 0, notRecorded: 0, unknown: 0, denied: 0, total: 0 },
          renderedText: input.rawDraft, rawDraftHash: state.rawDraftHash, renderedTextHash: state.rawDraftHash,
          auditPersisted: false, auditIncomplete: false, evidenceRefs: [] };
        const rendered = renderPlatformAnswer(plan, core.gaps.has("construction_conflict") ? { ...state, receipts: [] } : state, options);
        if (rendered.interpretationAudit) void core.append({ eventKey: "message_interpretation_checked", eventType: "message_interpretation_checked", payload: rendered.interpretationAudit });
        for (const resolution of rendered.resolutions) void core.append({ eventKey: `requirement_resolved:${resolution.requirementId}`, eventType: "requirement_resolved", payload: {
          schemaVersion: "platform-answer-progress.v1", resolution,
        } });
        void core.append({ eventKey: "read_phase_closed", eventType: "read_phase_closed", payload: {
          schemaVersion: "platform-answer-progress.v1", reason: rendered.questionComplete ? "requirements_satisfied" : "requirements_unresolved",
          questionComplete: rendered.questionComplete, evidenceCoverage: rendered.evidenceCoverage,
        } });
        decision = rendered;
        return rendered;
      }, (base, state) => {
        if (!plan) return;
        const safe = renderPlatformAnswer(plan, { ...state, receipts: [], allowed: false, finalDenied: state.finalDenied }, options);
        base.outcome = "unknown"; base.questionComplete = false; base.evidenceRefs = [];
        base.resolutions = safe.resolutions.map(item => ({ ...item, reason: "audit_incomplete" }));
        base.evidenceCoverage = safe.evidenceCoverage;
        base.interpretationAudit = safe.interpretationAudit;
        const text = `核验审计未完整保存，最终结论未提交。\n${safe.candidateDisplayText ?? safe.renderedText}`;
        if (options.mode === "shadow") { base.candidateDisplayText = text; base.candidateDisplayTextHash = answerTextHash(text); }
        else { base.renderedText = text; base.renderedTextHash = answerTextHash(text); }
        decision = base;
      });
      decision = result;
      return result;
    },
    snapshot() { return { turnId: options.turnId, supported, contractKind: plan?.kind ?? null, requirements: plan?.requirements ?? [], ...core.snapshot(), ...(decision ? { decision } : {}) }; },
  };
}
export type PlatformAnswerSession = ReturnType<typeof createPlatformAnswerSession>;
