/** Necessary status membership only; schedule, attempts and host fences remain in the service. */
export const INTERACTION_PROCESSING_JOB_CLAIM_POLICY_VERSION = "interaction-processing-claim-policy.v1";
export const INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES = Object.freeze(["pending", "failed", "resume_pending"] as const);
