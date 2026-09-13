/** Manifest identity belongs to the import workflow, not arbitrary model config. */
export class WorkshopConfigurationConflict extends Error {
  constructor() { super("manifest_identity_reserved"); }
}
export class WorkshopProposalConflict extends Error {
  constructor(public readonly code: "not_found" | "invalid_proposal" | "proposal_already_resolved") { super(code); }
}

export class WorkshopAgentChangeStaleProposalError extends Error {
  code = "WORK_VERSION_STALE" as const;
  constructor() {
    super("Proposal is stale because the Work configuration changed after it was created");
    this.name = "WorkshopAgentChangeStaleProposalError";
  }
}

export function preserveManifestIdentity(current: Record<string, unknown>, next: Record<string, unknown>) {
  const result = {...next};
  if (Object.hasOwn(current, "manifestName")) result.manifestName = current.manifestName;
  else delete result.manifestName;
  return result;
}

export function protectManifestIdentity(current: Record<string, unknown>, next: Record<string, unknown>, manifestImport = false) {
  if (manifestImport) return next;
  if (Object.hasOwn(next, "manifestName") && next.manifestName !== current.manifestName) throw new WorkshopConfigurationConflict();
  return preserveManifestIdentity(current, next);
}

/** An opaque revision encoded as ISO time. Physical updatedAt remains independent.
 * Equal-millisecond writes and backwards clock changes cannot reuse a revision. */
export function nextConfigurationVersion(updatedAt: Date, modelConfig: Record<string, unknown>, now: Date) {
  const previous = typeof modelConfig.workVersion === "string" ? Date.parse(modelConfig.workVersion) : NaN;
  return new Date(Math.max(now.getTime(), updatedAt.getTime() + 1, Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}
