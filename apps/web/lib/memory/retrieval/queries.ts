import { listBrainMemoriesForUser } from "./candidates";
import { getBrainMemoryById } from "../adapters/postgres/memory-records";
import { listBrainMemoryReviewsForUser } from "../adapters/postgres/reviews";
import type { BrainMemory, BrainMemoryStatus, BrainMemoryType } from "../kernel/memory-types";
export async function listBrainMemory(input: {
  userId: string;
  limit?: number;
  statuses?: BrainMemoryStatus[];
  memoryTypes?: BrainMemoryType[];
  ownerType?: BrainMemory["ownerType"];
  ownerId?: string;
}) {
  return listBrainMemoriesForUser(input);
}

export async function getBrainMemory(input: {
  userId: string;
  memoryId: string;
}) {
  return getBrainMemoryById(input);
}

export async function listBrainReviews(input: {
  userId: string;
  memoryId?: string;
  limit?: number;
}) {
  return listBrainMemoryReviewsForUser(input);
}

export async function listBrainCandidates(input: {
  userId: string;
  limit?: number;
  ownerType?: BrainMemory["ownerType"];
  ownerId?: string;
}) {
  return listBrainMemoriesForUser({
    userId: input.userId,
    statuses: ["candidate"],
    limit: input.limit,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
  });
}
