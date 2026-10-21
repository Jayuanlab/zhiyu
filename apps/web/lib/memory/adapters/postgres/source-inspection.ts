import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { brainContextLogs } from "@/lib/db/schema.pg";
import { lockContextOwnerForShare } from "./context-logs";
/** Fixed diagnostic scalars only; never select taskIntent or ref projections. */
export type SourceInspectionRow = { id: string; createdAt: Date | string; requesterType: string; stage: string;
  sequence: unknown; previousReceiptId: unknown; refs: unknown };
export async function readSourceInspection(userId: string, limit: number, receiptId?: string): Promise<SourceInspectionRow[]> {
  return db.transaction(async store => {
    await lockContextOwnerForShare(store, userId);
    const metadata = brainContextLogs.metadata;
    return store.select({ id: brainContextLogs.id, createdAt: brainContextLogs.createdAt,
      requesterType: brainContextLogs.requesterType, stage: sql<string>`${metadata}->>'source'`,
      sequence: sql<unknown>`${metadata}->'exactUse'->'dispatchSequence'`, previousReceiptId: sql<unknown>`${metadata}->'exactUse'->>'previousReceiptId'`,
      refs: sql<unknown>`coalesce((select jsonb_agg(jsonb_build_object('kind',r->>'kind','source',r->>'source','id',r->>'id','revision',r->>'revision'))
        from jsonb_array_elements(case when jsonb_typeof(${metadata}->'exactUse'->'refs')='array' then ${metadata}->'exactUse'->'refs' else '[]'::jsonb end) r),'[]'::jsonb)` })
      .from(brainContextLogs).where(and(eq(brainContextLogs.userId, userId), receiptId ? eq(brainContextLogs.id, receiptId) : undefined,
        inArray(sql<string>`${metadata}->>'source'`, ["memory_exact_use_admission", "memory_exact_use_dispatch"])))
      .orderBy(desc(brainContextLogs.createdAt), desc(brainContextLogs.id)).limit(limit + 1);
  });
}
