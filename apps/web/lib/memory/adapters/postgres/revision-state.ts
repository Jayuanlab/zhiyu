import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { brainMemories, user } from "@/lib/db/schema";
import { memoryStateReadReceipts } from "@/lib/db/schema.pg";
import { MemoryModuleError } from "../../kernel/errors";
import { memoryFromRow } from "../../records/memory-record";
import type { MemoryResultMeta, RevisionStateVersionRef } from "../../contracts";

/** The authority row, selected memory rows and receipt share one commit. */
export async function withRevisionStateRead<T>(userId: string, read: (store: DrizzleDB) => Promise<T>): Promise<T> {
  return db.transaction(async store => {
    const [principal] = await store.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("share");
    if (!principal) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity is no longer available");
    return read(store);
  });
}

export async function readRevisionMemoryForShare(store: DrizzleDB, userId: string, id: string) {
  const [row] = await store.select().from(brainMemories)
    .where(and(eq(brainMemories.userId, userId), eq(brainMemories.id, id))).for("share");
  return row ? memoryFromRow(row) : null;
}

export async function appendRevisionStateReadReceipt(store: DrizzleDB, input: {
  userId: string; ref: RevisionStateVersionRef; locator: Record<string, unknown>; meta: MemoryResultMeta;
}) {
  const [saved] = await store.insert(memoryStateReadReceipts).values({ id: randomUUID(), userId: input.userId,
    target: input.ref.record, revision: input.ref.revision, locator: input.locator,
    traceId: input.meta.traceId, contractVersion: input.meta.contractVersion, implementationVersion: input.meta.implementationVersion }).returning();
  if (!saved) throw new Error("Revision state read receipt was not persisted");
  return { id: saved.id, purpose: "current" as const, ref: input.ref, createdAt: saved.createdAt.toISOString() };
}
