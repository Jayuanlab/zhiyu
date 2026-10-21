import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { memoryQueryReadReceipts } from "@/lib/db/schema.pg";
import type { MemoryResultMeta } from "../../contracts";
import type { QueryReadReceipt, QueryVersionRef } from "../../query-contracts";

export async function appendQueryReceipt(store: DrizzleDB, input: { userId: string; purpose: "discover" | "recall";
  requestHash: string; refs: QueryVersionRef[]; contextLogId?: string; coverage: Record<string, unknown>; meta: MemoryResultMeta }): Promise<QueryReadReceipt> {
  const [row] = await store.insert(memoryQueryReadReceipts).values({ id: randomUUID(), userId: input.userId,
    purpose: input.purpose, requestHash: input.requestHash, refs: input.refs, contextLogId: input.contextLogId ?? null,
    coverage: input.coverage, traceId: input.meta.traceId, contractVersion: input.meta.contractVersion,
    implementationVersion: input.meta.implementationVersion }).returning();
  if (!row) throw new Error("Query read receipt was not persisted");
  return { id: row.id, purpose: input.purpose, createdAt: row.createdAt.toISOString() };
}
export async function explainQueryRead(userId: string, receiptId: string) {
  const [row] = await db.select().from(memoryQueryReadReceipts).where(and(eq(memoryQueryReadReceipts.userId, userId), eq(memoryQueryReadReceipts.id, receiptId))).limit(1);
  return row ? { status: "ok" as const, type: "query_read" as const, historical: true, receipt: {
    id: row.id, purpose: row.purpose, createdAt: row.createdAt.toISOString(), refs: row.refs, contextLogId: row.contextLogId, coverage: row.coverage },
    implementation: { traceId: row.traceId, contractVersion: row.contractVersion, implementationVersion: row.implementationVersion }
  } : { status: "not_found" as const };
}
