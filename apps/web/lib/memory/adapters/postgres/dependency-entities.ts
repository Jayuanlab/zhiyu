import { and, eq } from "drizzle-orm";
import { interactionNotes, interactionTasks, loops, loopStates } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import type { MemoryDependencyEntity } from "../../revision/dependencies-entity";
import { dependencyObject, getMemoryDependencyEntityVersion, type MemoryDependencyEntityKind } from "../../revision/dependencies-common";
import { getMemoryDependencyEntityProjectionFromRow } from "../../revision/dependencies-entity-version";

/** Reads real domain rows under their owner filter and requested transaction lock. */
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
