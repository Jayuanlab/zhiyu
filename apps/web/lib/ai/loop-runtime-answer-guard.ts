import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { requestedLoopRuntimeFacets } from "./runtime/answer-evidence-loop-facets";
import { guardOwnerLoopFacetAnswer } from "./loop-owner-facet-session";
import type { OwnerLoopPartialDeliveryBinding } from "./loop-partial-delivery";
const uuidInText = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;

/** Only a single, exact Loop's present executor state is eligible for this guard. */
export function directLoopRuntimeQuestionId(question: string): string | null {
  const ids = [...new Set((question.match(uuidInText) ?? []).map(id => id.toLowerCase()))];
  const labeledLoopId = question.match(/\bloop\s*(?:id)?\s*[:：#]?\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i)?.[1]?.toLowerCase();
  return ids.length === 1
    && labeledLoopId === ids[0]
    && /现在|当前|目前|此刻|实时|回答瞬间|正在|\bnow\b|\bcurrent(?:ly)?\b/i.test(question)
    && (/运行|执行器|在线|存活|\brunn?ing\b|\bexecutor\b/i.test(question) || requestedLoopRuntimeFacets(question).length > 0)
    ? ids[0] : null;
}


/** Exact eligibility remains unchanged; owner comes from route authentication. */
export async function* guardDirectLoopRuntimeAnswer(source: AsyncGenerator<AgentMessage>, question: string,
  host?: { ownerId: string; partialDelivery?: OwnerLoopPartialDeliveryBinding },
): AsyncGenerator<AgentMessage> {
  const loopId = directLoopRuntimeQuestionId(question);
  if (!loopId) { yield* source; return; }
  if (!host || typeof host.ownerId !== "string"
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(host.ownerId)) {
    yield { type: "answer_evidence", answerEvidence: { schemaVersion: "owner-loop-facet-scope.v3",
      protectedByNewRuntimeBoundary: false, outputPolicy: "baseline_stream_preserved",
      reason: "missing_or_invalid_authenticated_host_api_migration_required", fullOriginalQuestionVerified: false } };
    yield* source; return;
  }
  yield* guardOwnerLoopFacetAnswer(source, question, { ownerId: host.ownerId, loopId,
    adapter: "native_platform_recall", toolName: "platformRecall" }, host.partialDelivery);
}
