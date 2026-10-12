import { and, eq } from "drizzle-orm";
import { interactionNotes, interactionTasks, loops, loopStates } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import type { BrainRequester } from "./types";
import { dependencyFail, dependencyObject, getMemoryDependencyEntityVersion, isDependencyHuman, type MemoryDependencyEntityKind } from "./memory-dependencies-common";
import { getMemoryDependencyEntityProjectionFromRow } from "./memory-dependencies-entity-version";

export type MemoryDependencyEntity = { kind: MemoryDependencyEntityKind; id: string; title: string; content: string; contentTruncated: boolean; status: string; version: string; workId: string | null };
export async function readMemoryDependencyEntity(store: DrizzleDB, input: { userId: string; entityKind: MemoryDependencyEntityKind; entityId: string }, lock?: "share" | "update") {
  const table = input.entityKind === "wiki_note" ? interactionNotes : input.entityKind === "interaction_task" ? interactionTasks : loops;
  let query = store.select().from(table).where(and(eq(table.userId, input.userId), eq(table.id, input.entityId)));
  if (lock) query = query.for(lock);
  const [row] = await query;
  if (!row) return null;
  let projection: Record<string, unknown>;
  let workId: string | null = null;
  let status: string;
  if (input.entityKind === "loop") {
    let stateQuery = store.select().from(loopStates).where(eq(loopStates.loopId, row.id));
    if (lock) stateQuery = stateQuery.for(lock);
    const [state] = await stateQuery;
    workId = row.workshopId ?? null;
    status = row.status;
    projection = getMemoryDependencyEntityProjectionFromRow(input.entityKind, row, state);
  } else {
    projection = getMemoryDependencyEntityProjectionFromRow(input.entityKind, row);
    const metadata = dependencyObject(projection.metadata);
    workId = typeof metadata.workshopId === "string" ? metadata.workshopId : null;
    status = input.entityKind === "wiki_note" ? (typeof metadata.deletedAt === "string" || metadata.status === "deleted" ? "deleted" : "active") : row.status;
  }
  const content = input.entityKind === "wiki_note" ? String(row.body) : input.entityKind === "interaction_task" ? [row.title, row.description].filter(Boolean).join("\n\n") : [row.description, row.goal, JSON.stringify(projection, null, 2)].filter(Boolean).join("\n\n");
  return { entity: { kind: input.entityKind, id: row.id, title: row.title ?? row.name, content: content.slice(0, 12000), contentTruncated: content.length > 12000, status, version: getMemoryDependencyEntityVersion(projection), workId } as MemoryDependencyEntity, row };
}
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
