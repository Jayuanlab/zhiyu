import type { WorkingMemorySnapshot } from '@openzhiyu/ai/agent/runtime/host-working-memory';
import { canonicalCommandJson } from '@/lib/work-runtime/command-payload';
import type { WorkshopEvent } from './run-history-types';
import { inspectWorkingMemoryCheckpoint, inspectWorkingMemoryCheckpointProof,
  type WorkingMemoryCheckpointInspectionInput, type WorkingMemoryCheckpointProof } from './working-memory-continuity';

export type WorkingMemoryDeliveryContract = { required?: boolean; requireFreshSource?: boolean };
export type WorkingMemoryDeliveryScope = Pick<WorkingMemoryCheckpointInspectionInput,
  'userId' | 'workshopId' | 'runId' | 'loopId' | 'startedAt' | 'policyIdentity' | 'applicabilityHash'>;
export type WorkingMemoryDeliveryResult = {
  schemaVersion: 'working-memory-delivery.v1';
  ok: boolean;
  status: 'not_required' | 'satisfied' | 'needs_correction' | 'failed';
  code: string;
  feedback?: string;
  checkpoint: WorkingMemoryCheckpointProof | null;
};

/** Opt-in delivery, never a tool grant or a host-authored notebook update.
 * The caller owns admission, complete same-scope reads and the finite correction
 * budget. A satisfied candidate still needs a successful runtime terminal;
 * next-run continuity independently applies current owner/Brain corrections. */
export function checkWorkingMemoryDelivery(input: {
  contract?: WorkingMemoryDeliveryContract | null;
  scope: WorkingMemoryDeliveryScope;
  snapshot: WorkingMemorySnapshot | null | undefined;
  durableEvents: WorkshopEvent[];
  eventsTruncated?: boolean;
  attempt: number;
  now?: Date;
  /** Host-known current correction state; never accepted from model text. */
  correctionsPresent?: boolean;
}): WorkingMemoryDeliveryResult {
  const base = { schemaVersion: 'working-memory-delivery.v1' as const, checkpoint: null };
  const reject = (code: string, fatal = false): WorkingMemoryDeliveryResult => ({ ...base, ok: false,
    status: fatal || input.attempt >= 1 ? 'failed' : 'needs_correction', code,
    feedback: `Required working-memory checkpoint is not delivered (${code}).${code === 'continuity_context_over_budget' ? ' The actual inheritable material exceeds the fixed transfer budget. Reduce the notebook while retaining exact source references and genuine unresolved questions. Do not resubmit the same LOG; another identical update cannot fix this size limit.' : ''} Within the existing tool permissions, deadline and remaining budget, use workingMemory operation=read to inspect the actual version and evidenceCatalog. If needed, read an already authorized source. Then submit operation=update with phase=LOG, a unique commandId, expectedVersion from that read, complete state {facts,hypotheses,openQuestions,nextAction}, and pruneToolCallIds (may be []). evidenceIds must be actual evidenceCatalog.toolCallId values; never invent tool, source or event IDs. Preserve genuinely unresolved questions or a concrete next action.${input.correctionsPresent ? ' Current correction precedence suppresses historical facts, hypotheses and action suggestions, so a genuinely unresolved openQuestions entry is required for safe continuity. If none exists, report that blocker honestly; never invent a question.' : ''} Source observations and hypotheses remain unverified, and current owner/Brain corrections take precedence. A read, ordinary event log or final report text is not a LOG update. No tools, permissions, extra task attempts or budget are granted. If the checkpoint cannot be saved safely, report the blocker; do not claim completion.` });
  if (input.contract?.required !== undefined && typeof input.contract.required !== 'boolean'
    || input.contract?.requireFreshSource !== undefined && typeof input.contract.requireFreshSource !== 'boolean') {
    return reject('invalid_delivery_contract', true);
  }
  if (input.contract?.required !== true) return { ...base, ok: true, status: 'not_required', code: 'not_required' };
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) return reject('invalid_validation_attempt', true);
  const inspectionInput = { ...input.scope, events: input.durableEvents,
    eventsTruncated: input.eventsTruncated, now: input.now };
  const inspected = inspectWorkingMemoryCheckpointProof(inspectionInput);
  if (inspected.status !== 'eligible' || !inspected.checkpoint) return reject(inspected.reason);
  const checkpoint = inspected.checkpoint;
  const event = input.durableEvents.find(item => item.id === checkpoint.eventId)!;
  if (event.metadata.operation !== 'update' || event.metadata.phase !== 'LOG') return reject('latest_checkpoint_not_log');
  const snapshot = input.snapshot;
  try {
    if (!snapshot || snapshot.schemaVersion !== 'host-working-memory.v1' || snapshot.mode !== 'apply'
      || snapshot.authority !== 'model-authored-unverified' || snapshot.stateScope !== 'complete'
      || snapshot.version !== checkpoint.version
      || snapshot.policyIdentity?.version !== input.scope.policyIdentity.version
      || snapshot.policyIdentity.hash.toLowerCase() !== input.scope.policyIdentity.hash.toLowerCase()
      || canonicalCommandJson(snapshot.state) !== canonicalCommandJson(event.metadata.state)) {
      return reject('checkpoint_snapshot_mismatch');
    }
  } catch { return reject('checkpoint_snapshot_mismatch'); }
  if (input.contract.requireFreshSource && !checkpoint.sourceEventIds.length) return reject('checkpoint_has_no_bound_source');
  if (input.correctionsPresent && !checkpoint.hasOpenQuestions) return reject('checkpoint_has_no_progress_under_correction');
  if (!checkpoint.hasOpenQuestions && !checkpoint.hasNextAction) return reject('checkpoint_has_no_progress');
  const transfer = inspectWorkingMemoryCheckpoint({ ...inspectionInput, correctionsPresent: input.correctionsPresent });
  if (transfer.status !== 'eligible' || !transfer.checkpoint) return reject(transfer.reason);
  if (transfer.checkpoint.checkpointEventId !== checkpoint.eventId || transfer.checkpoint.version !== checkpoint.version
    || transfer.checkpoint.chain.rootHash !== checkpoint.rootHash || transfer.checkpoint.expiresAt !== checkpoint.expiresAt) {
    return reject('checkpoint_transfer_mismatch');
  }
  return { schemaVersion: base.schemaVersion, ok: true, status: 'satisfied', code: 'current_source_checkpoint_delivered',
    checkpoint };
}
