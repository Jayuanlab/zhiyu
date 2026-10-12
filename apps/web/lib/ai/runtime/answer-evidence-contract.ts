import type { AgentRuntimeTerminal } from "@openzhiyu/ai/agent/types";
import type { EvidenceObservation, EvidenceTimePolicy } from "@/lib/brain/evidence-time";
import type { RuntimeToolTraceEvent } from "./tool-executor";

export type AnswerEvidenceMode = "off" | "shadow" | "enforce_critical";
export type EvidenceReceipt = {
  schemaVersion: "answer-evidence.v1";
  evidenceId: string;
  turnId: string;
  toolUseId: string;
  deliveryToolUseId?: string;
  subject: { kind: "loop"; id: string };
  source: { name: string; receiptHash: string; resultHash: string };
  authorization: { ownerId: string; policyHash: string; decision: "allowed"; checkedAt: string };
  observation: EvidenceObservation & { provider: string; temporalScope: "live_read" | "snapshot" };
  availability: "read" | "source_failed";
  delivery: "result_constructed" | "tool_result_emitted";
  facts: Array<{ key: string; value: unknown; state: "observed" | "unknown" }>;
};
export type RequiredFact = {
  id: string;
  subject: EvidenceReceipt["subject"];
  factKey: string;
  timePolicy: EvidenceTimePolicy;
};
export type FactResolution = {
  requirementId: string;
  state: "supported" | "not_recorded" | "unknown" | "denied";
  evidenceIds: string[];
  reason: string;
  presentationIncluded: boolean;
};
export type AnswerDecision = {
  schemaVersion: "answer-decision.v1";
  mode: AnswerEvidenceMode;
  ruleVersion: string;
  runtimeHash: string;
  outcome: "supported_fields" | "partial" | "unknown" | "execution_failed" | "unchecked";
  resolutions: FactResolution[];
  renderedText: string;
  rawDraftHash: string;
  renderedTextHash: string;
  candidateDisplayText?: string;
  candidateDisplayTextHash?: string;
  auditPersisted: boolean;
  auditIncomplete: boolean;
  evidenceRefs: Array<{ evidenceId: string; observedAt: string; status: string }>;
};
export type AnswerEvidenceAuditEvent = {
  eventKey: string;
  eventType: string;
  payload: Record<string, unknown>;
};
export type ToolConstruction = {
  toolCallId: string;
  toolName: string;
  params: unknown;
  result: unknown;
  trace: RuntimeToolTraceEvent;
  /** Final formatted tool text, constructed on the host after budget checks. */
  modelText?: string;
  observedAt?: string;
};
export type AnswerEvidenceSessionOptions = {
  mode: AnswerEvidenceMode;
  turnId: string;
  ownerId: string;
  runtimeHash: string;
  policyHash: string;
  question: string;
  auditSink?: (event: AnswerEvidenceAuditEvent) => Promise<unknown>;
  authorizeFinal?: () => Promise<boolean>;
  now?: () => Date;
};
export type FinalizeAnswerInput = {
  terminal: AgentRuntimeTerminal | null;
  rawDraft: string;
  rawDraftHash?: string;
  rawDraftCharacters?: number;
  draftOverflow?: boolean;
};
