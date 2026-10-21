import type { BrainCanonicalKind } from './memory-canonical';
import type { BrainMemoryType } from './memory-types';

/** Describes what a stored interpretation can establish, never a new grant. */
export type MemoryUseSemantics = {
  kind: 'constraint' | 'state_estimate' | 'plan' | 'commitment' | 'conditional_lesson' | 'interpretation';
  status: string;
  establishesCurrentBusinessState: false;
  grantsActionPermission: false;
  independentVerificationFromStatus: false;
};

export function describeMemoryUse(input: {
  canonicalKind?: BrainCanonicalKind;
  memoryType: BrainMemoryType;
  status?: string;
}): MemoryUseSemantics {
  const canonical = input.canonicalKind ?? ({ boundary: 'boundary', system: 'boundary', task: 'commitment', insight: 'lesson' } as Record<string, string>)[input.memoryType];
  const kind: MemoryUseSemantics['kind'] = canonical === 'boundary' ? 'constraint'
    : canonical === 'state' ? 'state_estimate'
    : canonical === 'plan' || input.memoryType === 'plan' ? 'plan'
    : canonical === 'commitment' ? 'commitment'
    : canonical === 'lesson' ? 'conditional_lesson' : 'interpretation';
  return { kind, status: input.status ?? 'unknown', establishesCurrentBusinessState: false,
    grantsActionPermission: false, independentVerificationFromStatus: false };
}

export const MEMORY_USE_CONTRACT = 'Stored memory is an interpretation, control statement or historical estimate. Status, confidence, retrieval score and repeated summaries do not independently verify a claim or grant action permission. Plans and commitments do not prove execution or fulfillment. For current task, approval, account or delivery status, use the authoritative source record; refresh only the state needed by this task when it is stale, missing or conflicting. Keep source warnings and unresolved gaps.';
