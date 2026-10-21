import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import type { BrainRequester } from "../kernel/memory-types";
import { dependencyFail, isDependencyHuman, type MemoryDependencyEntityKind } from "./dependencies-common";
import { readMemoryDependencyEntity } from "../adapters/postgres/dependency-entities";
export { readMemoryDependencyEntity } from "../adapters/postgres/dependency-entities";

export type MemoryDependencyEntity = { kind: MemoryDependencyEntityKind; id: string; title: string; content: string; contentTruncated: boolean; status: string; version: string; workId: string | null };
export function authorizeMemoryDependencyEntity(requester: BrainRequester, value: NonNullable<Awaited<ReturnType<typeof readMemoryDependencyEntity>>>, capture = false) {
  if (value.row.userId !== requester.userId) dependencyFail("dependency_not_allowed", 403, "Target belongs to another owner");
  if (isDependencyHuman(requester)) return;
  const workId = requester.type === "work" ? requester.id : requester.workId ?? requester.workshopId;
  if (!workId || value.entity.workId !== workId) dependencyFail("dependency_not_allowed", 403, "Requester does not own this target");
  // Notes/tasks have no hard Work owner column. Only a server execution context can capture them.
  if (value.entity.kind !== "loop" && capture) {
    const lease = resolveExecutionLease();
    if (!lease || lease.userId !== requester.userId || lease.workshopId !== workId)
      dependencyFail("dependency_not_allowed", 403, "Model capture requires the matching server execution context");
  }
}
