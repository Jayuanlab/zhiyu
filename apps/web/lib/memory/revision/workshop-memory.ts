import type { Workshop } from "@/lib/db/schema";
import type { AddWorkshopMemoryInput } from "@/lib/workshops/types";
import type { BrainAccessGrant, BrainValidationIssue, BrainWriteRequest } from "../kernel/memory-types";
import { validateMemoryWrite } from "./policy";
import { workshopMemoryStatusToBrainStatus, workshopMemoryKindToBrainType, createWorkshopBrainRequester } from "../records/workshop-memory";

export type WorkshopBrainWriteCheck = {
  request: BrainWriteRequest;
  issues: BrainValidationIssue[];
};

export function validateWorkshopMemoryWrite(input: {
  workshop: Pick<Workshop, "id" | "userId">;
  memory: AddWorkshopMemoryInput;
  sourceEventIds: string[];
  grants?: BrainAccessGrant[];
  now?: Date;
}): WorkshopBrainWriteCheck {
  const status = workshopMemoryStatusToBrainStatus(
    input.memory.status ?? "active",
  );
  const request: BrainWriteRequest = {
    requester: createWorkshopBrainRequester(input.workshop),
    targetScope: { type: "workshop", workshopId: input.workshop.id },
    ownerType: "work",
    ownerId: input.workshop.id,
    memoryType: workshopMemoryKindToBrainType(input.memory.kind),
    status,
    confidence: input.memory.confidence ?? 50,
    evidenceRefs: input.sourceEventIds,
  };
  return {
    request,
    issues: validateMemoryWrite({
      request,
      grants: input.grants,
      now: input.now,
    }),
  };
}
