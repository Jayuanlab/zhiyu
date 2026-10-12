/** Shared by the locked dispatcher and read-only conditional explanation.
 * This predicate performs no admission and is not a scheduler observation. */
export const SCHEDULED_LOOP_AUTHORITY_RULE = "work-scheduled-loop-owner-authority.v1";
export function scheduledLoopAuthority(input: {
  workStatus: string; loopStatus: string; previouslyAccepted: boolean;
}): "prior_admission_replay" | "paused" | "continue_checks" {
  if (input.previouslyAccepted) return "prior_admission_replay";
  return input.workStatus !== "active" || input.loopStatus !== "active" ? "paused" : "continue_checks";
}
