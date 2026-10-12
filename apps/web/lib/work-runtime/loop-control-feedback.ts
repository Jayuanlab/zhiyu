import { SCHEDULED_LOOP_AUTHORITY_RULE, scheduledLoopAuthority } from "./scheduled-loop-authority";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const iso = (value: Date | string | null | undefined) => {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
export type LoopControlFeedbackSubject = { ownerId: string; workId: string; loopId: string; commandId: string };
export type LoopControlFeedbackSnapshot = {
  ownerId: string; workId: string; loopId: string; observedAt: Date | string;
  workStatus: string; loopStatus: string; loopUpdatedAt: Date | string; workCommandVersion: number;
  command: { commandId: string; workId: string; type: string; status: string; expectedVersion: number;
    completedAt: Date | string | null; result: unknown;
    appliedLoop: { id: string; userId: string; workshopId: string | null; status: string; updatedAt: Date | string } | null } | null;
};
export async function readPausedLoopControlFeedback(subject: LoopControlFeedbackSubject,
  readAuthorizedSnapshot: (subject: LoopControlFeedbackSubject) => Promise<LoopControlFeedbackSnapshot | null>) {
  if (![subject.ownerId, subject.workId, subject.loopId].every(id => uuid.test(id))
    || !subject.commandId.trim() || subject.commandId.length > 256) throw Error("invalid_loop_feedback_subject");
  const unavailable = (reason: string) => ({ schemaVersion: "loop-control-feedback.v1" as const,
    subject: { ...subject }, command: { state: "unknown" as const, immutableReceipt: null },
    postcondition: { status: "unknown" as const, reason },
    futureAdmission: { kind: "not_observed" as const, physicallyObserved: false as const },
    inFlightCancellation: "not_requested_by_this_feedback" as const,
    history: { observation: "not_read_by_this_feedback" as const, permanentRetentionGuaranteed: false as const } });
  let row: LoopControlFeedbackSnapshot | null;
  try { row = await readAuthorizedSnapshot(subject); } catch { return unavailable("fresh_owner_read_unavailable"); }
  if (!row || row.ownerId !== subject.ownerId || row.workId !== subject.workId || row.loopId !== subject.loopId)
    return unavailable("owner_work_loop_not_visible");
  const observedAt = iso(row.observedAt), loopUpdatedAt = iso(row.loopUpdatedAt);
  if (!observedAt || !loopUpdatedAt || !Number.isSafeInteger(row.workCommandVersion) || row.workCommandVersion < 0)
    return unavailable("invalid_fresh_read");
  const command = row.command, applied = command?.appliedLoop;
  const completedAt = iso(command?.completedAt);
  const receiptBound = !!command && command.commandId === subject.commandId && command.workId === subject.workId
    && command.type === "updateWorkLoop" && command.status === "succeeded"
    && !!applied && applied.id === subject.loopId && applied.userId === subject.ownerId
    && applied.workshopId === subject.workId && applied.status === "paused";
  const association = receiptBound && !!command
    && Number.isSafeInteger(command.expectedVersion) && command.expectedVersion >= 0
    && row.workCommandVersion >= command.expectedVersion + 1 && !!completedAt
    && Date.parse(observedAt) >= Date.parse(completedAt)
    && !!applied
    && iso(applied.updatedAt) === loopUpdatedAt;
  const status = !receiptBound ? "command_association_unknown" as const
    : row.loopStatus !== "paused" ? "superseded" as const
    : association ? "verified_paused" as const : "command_association_unknown" as const;
  const observation = { provider: "owner_work_loop_command_snapshot" as const,
    scope: "one_owner_work_loop_database_statement" as const, observedAt, configurationStatus: row.loopStatus,
    workStatus: row.workStatus, loopUpdatedAt, workCommandVersion: row.workCommandVersion };
  // Never executes the dispatcher, changes time, cancels a run or deletes history.
  const conditional = scheduledLoopAuthority({ workStatus: row.workStatus, loopStatus: row.loopStatus,
    previouslyAccepted: false }) === "paused";
  return { schemaVersion: "loop-control-feedback.v1" as const, subject: { ...subject },
    command: { state: receiptBound ? "applied" as const : "unknown" as const,
      immutableReceipt: receiptBound ? structuredClone(command!.result) : null },
    postcondition: { status, commandAssociationVerified: association, observation },
    futureAdmission: conditional ? { kind: "conditional_policy" as const,
      ruleId: SCHEDULED_LOOP_AUTHORITY_RULE, physicallyObserved: false as const,
      conditions: { sameOwnerWorkLoop: true as const, statusesRemainAsRead: true as const,
        freshPreviouslyUnacceptedSlot: true as const }, observation,
      conclusion: "new_admission_rejected_by_configuration_authority_if_conditions_hold" as const,
      existingAcceptedSlotReplay: "excluded_from_this_conclusion" as const,
      scheduleTimeComputationObserved: false as const }
      : { kind: "not_observed" as const, physicallyObserved: false as const },
    inFlightCancellation: "not_requested_by_this_feedback" as const,
    history: { observation: "not_read_by_this_feedback" as const,
      commandDeletion: "not_requested_by_updateWorkLoop" as const, permanentRetentionGuaranteed: false as const } };
}
