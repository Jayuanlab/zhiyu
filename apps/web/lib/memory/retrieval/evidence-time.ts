export type EvidenceObservation = {
  kind: "live" | "snapshot" | "memory" | "static";
  observedAt?: string;
  /** Trusted metadata supplied by the reader, never parsed from evidence prose. */
  validFrom?: string;
  validTo?: string;
};
export type EvidenceTimePolicy =
  | { mode: "unconstrained" }
  | { mode: "current"; now: string; maxAgeMs: number }
  | { mode: "as_of"; at: string }
  | { mode: "unresolved"; reason: string };
export type EvidenceTimeCheck = { evidenceId: string; state: "eligible" | "stale" | "future" | "unknown" | "wrong_time"; detail: string };
function instant(value?: string): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
export function inferEvidenceTimePolicy(question: string, now = new Date()): EvidenceTimePolicy {
  // Historical state requires a real as-of version; an old created_at is not one.
  if (/截至|当时|历史快照|评测快照|\bas of\b/i.test(question)) {
    const iso = question.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/)?.[0];
    return iso && instant(iso) !== undefined ? { mode: "as_of", at: iso }
      : { mode: "unresolved", reason: "Historical state needs an explicit instant with timezone and a matching snapshot/version." };
  }
  if (/当前|目前|现在|最新|是否恢复|恢复了吗|\b(current|now|latest)\b/i.test(question)) {
    return { mode: "current", now: now.toISOString(), maxAgeMs: 5 * 60_000 };
  }
  return { mode: "unconstrained" };
}

export function recordObservation(source: string, fields: Record<string, unknown>, observedAt?: string): EvidenceObservation {
  if (source === "brainMemories") {
    return { kind: "memory", observedAt: typeof fields.updatedAt === "string" ? fields.updatedAt : undefined };
  }
  if (source === "brainObservations") {
    return { kind: "snapshot", observedAt: typeof fields.observedAt === "string" ? fields.observedAt : undefined };
  }
  if (["brainStateSnapshots", "workshopRuntimeSnapshots", "workRunEvidenceBundles"].includes(source)) {
    const captured = fields.createdAt ?? fields.created_at;
    return { kind: "snapshot", observedAt: typeof captured === "string" ? captured : undefined };
  }
  return { kind: "live", observedAt };
}
export function checkEvidenceTime(evidenceId: string, observation: EvidenceObservation | undefined, policy: EvidenceTimePolicy): EvidenceTimeCheck {
  const result = (state: EvidenceTimeCheck["state"], detail: string) => ({ evidenceId, state, detail });
  if (policy.mode === "unconstrained") return result("eligible", "No state-time constraint requested.");
  if (policy.mode === "unresolved") return result("unknown", policy.reason);
  if (!observation) return result("unknown", "No trusted observation metadata.");
  if (policy.mode === "as_of") {
    const at = instant(policy.at), from = instant(observation.validFrom), to = instant(observation.validTo);
    if (at === undefined || from === undefined || to === undefined || from >= to) return result("unknown", "No bounded validity interval for the requested historical instant.");
    return at >= from && at < to ? result("eligible", "Historical instant is within the recorded validity interval.")
      : result("wrong_time", "Historical instant is outside the recorded validity interval.");
  }
  const now = instant(policy.now), observed = instant(observation.observedAt);
  if (now === undefined || observed === undefined || !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0) return result("unknown", "Invalid time metadata or freshness budget.");
  if (observed > now) return result("future", "Observation is in the future.");
  // Updating a summary is not the same as observing current source state.
  if (observation.kind !== "live") return result("unknown", "Current state requires a live source observation; memory update time is insufficient.");
  return now - observed <= policy.maxAgeMs ? result("eligible", "Live observation is within the freshness budget.")
    : result("stale", "Live observation exceeds the freshness budget.");
}
