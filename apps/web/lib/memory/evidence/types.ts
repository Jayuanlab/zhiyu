export type EvidenceOwnerHint = { ownerType: string; ownerId: string };

export type ResolvedEvidenceIdentity = {
  source: 'workshop_event' | 'interaction_event' | 'raw_message' | 'brain_observation';
  sourceId: string;
  /** A stored observation association, never an inferred content match. */
  sourceEventId?: string;
};

export type ResolvedEvidence = {
  id: string;
  status: 'resolved' | 'unresolved';
  source: ResolvedEvidenceIdentity['source'] | 'unknown';
  sourceSemantics: 'evidence_source';
  ownerHints: EvidenceOwnerHint[];
  title: string | null;
  content: string | null;
  createdAt: string | null;
  metadata: Record<string, unknown>;
  resolvedIdentity?: ResolvedEvidenceIdentity;
};

/** Hints locate candidates; the source reader must enforce stored ownership. */
export type EvidenceReadRequest = {
  userId: string;
  evidenceRefs: string[];
  ownerHintsByRef?: Map<string, EvidenceOwnerHint[]>;
  /** Server-only model capability, never derived from the evidence text. */
  modelPolicy?: import('../context/exact-use-admission').ExactUsePolicy;
  modelMemoryIdsByRef?: Map<string, string[]>;
};

export type EvidenceRootGroup = { rootKey: string; source: string; sourceId: string; refs: string[] };
