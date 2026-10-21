import type { BrainMemory } from "../kernel/memory-types";

/** Identity-only projection. Retired content, subject, evidence and metadata are never selected. */
export type BrainRetirementIdentity = {
  id: string; userId: string; scopeType: string; scopeId: string | null; ownerType: string; ownerId: string;
  memoryType: BrainMemory['memoryType']; status: string; updatedAt: Date | string; expiresAt: Date | string | null;
};
export type BrainRetirementQuery = { userId: string; workId: string; updatedAfter: Date; now: Date; limit: number };
