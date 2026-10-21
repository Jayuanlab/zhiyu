import { sql } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { MemoryWriteBusy } from "./reference-errors";

/** A leased business gate may already hold source SHARE rows. Never wait for
 * an advisory lock while holding those rows in the reverse order. */
export async function acquireMemoryWriteAdvisoryLock(store: DrizzleDB, key: string) {
  if (!resolveExecutionLease()) {
    await store.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
    return;
  }
  const rows = await store.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS acquired`);
  if (rows[0]?.acquired !== true) throw new MemoryWriteBusy();
}
