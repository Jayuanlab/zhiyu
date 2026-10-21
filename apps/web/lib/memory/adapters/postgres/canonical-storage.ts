import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
type Counts = { totalMemories: number | string | null; canonicalKindRows: number | string | null; canonicalGroupRows: number | string | null };
export async function readCanonicalStorageCounts(userId: string): Promise<Counts | undefined> {
  const result: unknown = await db.execute(sql`select count(*) as "totalMemories",
    sum(case when canonical_kind is not null then 1 else 0 end) as "canonicalKindRows",
    sum(case when canonical_group_id is not null then 1 else 0 end) as "canonicalGroupRows"
    from brain_memories where user_id = ${userId}`);
  return (Array.isArray(result) ? result as Counts[] : (result as { rows?: Counts[] } | null)?.rows ?? [])[0];
}
export async function sampleCanonicalStorageMemory(userId: string): Promise<void> {
  await db.execute(sql`select id from brain_memories where user_id = ${userId} and canonical_kind in ('fact', 'boundary') limit 10`);
}
