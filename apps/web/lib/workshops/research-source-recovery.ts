import { resolveWorkshopResearchContract, verifyWorkshopResearchEvidence,
  type WorkshopResearchEvidenceEvent } from "./research-evidence-verification";

type RecoveryRead = { url: string; offset: number; evidenceId?: string };
const canonical = (raw: unknown) => {
  if (typeof raw !== "string") return null;
  try { const url = new URL(raw); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = ""; return url.href; } catch { return null; }
};

/** Only the pinned required papers and current same-run receipt cursors may
 * participate in source recovery. This creates no tool or URL permission. */
export function inspectWorkshopResearchSourceRecovery(input: {
  runId: string; modelConfig: unknown; taskText: string;
  events: readonly WorkshopResearchEvidenceEvent[];
}) {
  const resolution = resolveWorkshopResearchContract(input.modelConfig, input.taskText);
  if (!resolution.active || resolution.issues.length || resolution.contract?.reportDelivery !== "grounded-report/v1") {
    throw Error("Research source recovery contract is unavailable");
  }
  if (input.events.length > 1000) throw Error("Research source recovery receipt limit exceeded");
  const verification = verifyWorkshopResearchEvidence({ ...input, report: undefined });
  const reads: RecoveryRead[] = verification.coverage.filter(source => source.status !== "complete").flatMap(source =>
    source.urls.map(url => ({ url, offset: source.coveredChars, ...(source.evidenceId ? { evidenceId: source.evidenceId } : {}) })));
  return { incomplete: reads.length > 0,
    requests: reads.map(read => ({ ...read, maxChars: 30000 })),
    describeRequest(rawInput: unknown) {
      const params = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : {};
      return {
        keys: Object.keys(params).slice(0, 20).map(key => key.slice(0, 80)),
        url: reads.some(read => canonical(params.url) === canonical(read.url)) ? canonical(params.url) : "[unapproved_url]",
        offset: Number.isSafeInteger(params.offset) ? params.offset : "[invalid_or_missing_offset]",
        maxChars: Number.isSafeInteger(params.maxChars) ? params.maxChars : "[invalid_or_missing_limit]",
        evidenceId: typeof params.evidenceId === "string" && /^[0-9a-f-]{36}$/i.test(params.evidenceId) ? params.evidenceId : "[invalid_or_missing_identity]",
      };
    },
    isToolAllowed(toolName: string, rawInput: unknown) {
      if (!["webReadPage", "mcp__workshop-tools__webReadPage"].includes(toolName) || !rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return false;
      const params = rawInput as Record<string, unknown>;
      if (Object.keys(params).some(key => !["url", "offset", "maxChars", "evidenceId"].includes(key)) ||
        !Number.isSafeInteger(params.maxChars) || (params.maxChars as number) < 1 || (params.maxChars as number) > 30000) return false;
      return reads.some(read => canonical(params.url) === canonical(read.url) && (params.offset ?? 0) === read.offset &&
        (read.evidenceId ? params.evidenceId === read.evidenceId : params.evidenceId === undefined));
    },
  };
}
