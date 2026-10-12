import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { guardEvidenceAnswerStream } from "./answer-evidence-loop-gate";
import type { PlatformAnswerDecision } from "./platform-answer-contract";
import type { PlatformAnswerSession } from "./platform-answer-session";

export function guardPlatformAnswer(source: AsyncGenerator<AgentMessage>, session: PlatformAnswerSession): AsyncGenerator<AgentMessage> {
  return guardEvidenceAnswerStream(source, session, "enforce_supported", value => {
    const decision = value as PlatformAnswerDecision;
    return { schemaVersion: "platform-answer-summary.v1", kind: "platform", mode: session.mode, turnId: session.turnId,
      contractKind: decision.contractKind, ruleVersion: decision.ruleVersion, runtimeHash: decision.runtimeHash,
      outcome: decision.outcome, displayText: decision.renderedText, resolutions: decision.resolutions, evidenceRefs: decision.evidenceRefs,
      questionComplete: decision.questionComplete, evidenceCoverage: decision.evidenceCoverage,
      renderedTextHash: decision.renderedTextHash, auditPersisted: decision.auditPersisted, auditIncomplete: decision.auditIncomplete };
  });
}
