export type LoopScheduleUpdate =
  | { status: "not_recomputed" }
  | { status: "recomputed"; nextScheduledRunAt: string | null };

/** A configuration command is not an observation of a future scheduler tick.
 * In particular, a missing computation must not become a null schedule fact. */
export function loopUpdateReceiptSemantics(scheduleUpdate: LoopScheduleUpdate) {
  return {
    schemaVersion: "loop-update-receipt.v1" as const,
    layer: "configuration_command" as const,
    scheduleUpdate: { ...scheduleUpdate },
    futureAdmissionObservation: "not_observed_by_this_command" as const,
    inFlightCancellation: "not_requested_by_this_command" as const,
    historyDeletion: "not_requested_by_this_command" as const,
  };
}
