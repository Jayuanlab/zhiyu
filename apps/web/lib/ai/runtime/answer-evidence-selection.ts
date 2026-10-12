import { ANSWER_EVIDENCE_RULE_VERSION, createAnswerEvidenceSession, exactCurrentLoopEvidenceSubject, type AnswerEvidenceSession } from "./answer-evidence-session";
import type { AnswerEvidenceMode, AnswerEvidenceSessionOptions } from "./answer-evidence-contract";
import { PLATFORM_ANSWER_RULE_VERSION, selectPlatformAnswerContract, type PlatformAnswerMode, type PlatformAnswerPlan, type PlatformAnswerSessionOptions } from "./platform-answer-contract";
import { createPlatformAnswerSession, type PlatformAnswerSession } from "./platform-answer-session";

export type HostAnswerEvidenceSelection =
  | { kind: "loop"; mode: Exclude<AnswerEvidenceMode, "off">; loopId: string; ruleVersion: string; readerVersion: string; scope: "single_exact_current_loop" }
  | { kind: "platform"; mode: Exclude<PlatformAnswerMode, "off">; plan: PlatformAnswerPlan; ruleVersion: string; readerVersion: string; scope: "supported_platform_readonly" };
export type HostAnswerEvidenceSession = AnswerEvidenceSession | PlatformAnswerSession;

/** The host selects one adapter before registering tools or starting a model. */
export function selectHostAnswerEvidenceContract(question: string, modes: { loopMode?: string; platformMode?: string }): HostAnswerEvidenceSelection | null {
  const loopId = exactCurrentLoopEvidenceSubject(question);
  if (loopId && (modes.loopMode === "shadow" || modes.loopMode === "enforce_critical")) return {
    kind: "loop", mode: modes.loopMode, loopId, ruleVersion: ANSWER_EVIDENCE_RULE_VERSION,
    readerVersion: "loop-runtime-observation.v1", scope: "single_exact_current_loop",
  };
  if (modes.platformMode !== "shadow" && modes.platformMode !== "enforce_supported") return null;
  const plan = selectPlatformAnswerContract(question);
  return plan ? { kind: "platform", mode: modes.platformMode, plan, ruleVersion: PLATFORM_ANSWER_RULE_VERSION,
    readerVersion: "platform-field-read.v1", scope: "supported_platform_readonly" } : null;
}

export function createHostAnswerEvidenceSession(selection: HostAnswerEvidenceSelection,
  options: Omit<AnswerEvidenceSessionOptions, "mode" | "authorizeFinal"> & Pick<PlatformAnswerSessionOptions, "snapshotAt" | "timePolicy" | "readonlyContinuation" | "authorizeFieldPageFinal" | "resolveFieldPageReadHandle">
    & { authorizeFinal?: (plan?: PlatformAnswerPlan) => Promise<boolean> }): HostAnswerEvidenceSession {
  return selection.kind === "loop" ? createAnswerEvidenceSession({ ...options, mode: selection.mode })
    : createPlatformAnswerSession({ ...options, mode: selection.mode });
}
