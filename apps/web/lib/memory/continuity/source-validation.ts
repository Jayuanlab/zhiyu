import { verifyExactMemoryRefsForDispatch } from "../context/exact-use";
import type { BrainRequester, BrainSourceFilters } from "../kernel/memory-types";
import type { WorkingMemoryContinuitySourceVerifier } from "./working-memory";

/** Only explicit canonical identities are recognized. A prior source_checked
 * event, title, URL or arbitrary hash does not establish current permission. */
export function createContinuitySourceVerifier(input: {
  requester: BrainRequester; accessMode?: "strict" | "owner_override"; sourceFilters?: BrainSourceFilters;
}): WorkingMemoryContinuitySourceVerifier {
  return async (sources, scope) => {
    const requester = input.requester;
    const workIds = [requester.workId, requester.workshopId, ...(requester.type === "work" ? [requester.id] : [])]
      .filter((id): id is string => typeof id === "string");
    const scopeMatches = requester.userId === scope.userId && workIds.length > 0
      && workIds.every(id => id === scope.workshopId)
      && (requester.type === "work" || requester.type === "loop" && requester.id === scope.loopId);
    const verdicts = [];
    for (const source of sources) {
      const id = source.sourceIdentity.memoryId, revision = source.sourceIdentity.sourceVersion;
      let status: "current" | "unknown" = "unknown";
      if (scopeMatches && typeof id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
        && typeof revision === "string" && /^bmrv1:[a-f0-9]{64}$/.test(revision)) {
        try {
          await verifyExactMemoryRefsForDispatch({ ...input, purpose: "continuity_source_revalidation", refs: [{ id, revision }] });
          status = "current";
        } catch { status = "unknown"; }
      }
      verdicts.push({ sourceEventId: source.sourceEventId, toolCallId: source.toolCallId, status });
    }
    return verdicts;
  };
}
