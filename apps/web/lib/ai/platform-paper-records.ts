import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { PlatformRecord } from "./platform-record-reader";
import { currentExactUseReaderPolicy } from '@/lib/memory/context/exact-use';
import { resolveExecutionLease } from '@/lib/work-runtime/execution-context';
import { MemoryModuleError } from '@/lib/memory/kernel/errors';

export function paperRecordKeys(question = "") {
  return [...new Set(question.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}/gi) ?? [])].slice(0, 4);
}

/** Fixed projections only. Every child AND provenance join remains account/owner scoped. */
export async function readPaperRecordsForOwner(userId: string, keys: string[], execute: (query: SQL) => Promise<any> = query => db.execute(query)): Promise<PlatformRecord[]> {
  const policy = currentExactUseReaderPolicy();
  if (resolveExecutionLease() || policy && (policy.requester.type !== 'chat' || policy.requester.userId !== userId)) throw new MemoryModuleError('memory_source_scope_unverified', 403, 'Owner remote-ledger discovery is unavailable to Work recall');
  const records: PlatformRecord[] = [];
  for (const key of keys) {
    if (!paperRecordKeys(key).includes(key)) continue;
    const [accountId, id] = key.split("/");
    const fills = await execute(sql`SELECT f.account_id, f.id, f.order_id, f.quantity, f.price, f.amount,
      o.code, o.side, o.quantity AS order_quantity, o.status AS order_status
      FROM paper_fills f JOIN paper_accounts a ON a.id=f.account_id
      JOIN paper_orders o ON o.account_id=f.account_id AND o.id=f.order_id
      WHERE a.owner_id=${userId}::uuid AND f.account_id=${accountId}::uuid AND f.id=${id} LIMIT 1`);
    for (const row of fills) records.push({ source: "paper_fills", id: key, fields: { ...row } });
    const orders = await execute(sql`SELECT o.account_id, o.id, o.code, o.side, o.status, o.quantity, o.remaining_quantity, o.limit_price
      FROM paper_orders o JOIN paper_accounts a ON a.id=o.account_id
      WHERE a.owner_id=${userId}::uuid AND o.account_id=${accountId}::uuid AND o.id=${id} LIMIT 1`);
    for (const row of orders) records.push({ source: "paper_orders", id: key, fields: { ...row } });
  }
  return records;
}
