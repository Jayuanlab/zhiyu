import type { DrizzleDB } from "@/lib/db/types";
import { insertWorkRunStateSnapshotInTransaction, type AuthorizedWorkRunStateSnapshot } from "../adapters/postgres/work-run-state";
import { MemoryIdentityConflict } from "../kernel/reference-errors";

/** Internal host port: no new transaction, lease, run transition or arbitrary
 * snapshot type. The surrounding Work command commits its audit and terminal. */
export async function writeAuthorizedWorkRunStateSnapshotInTransaction(store: Pick<DrizzleDB, "execute">, input: AuthorizedWorkRunStateSnapshot) {
  if (input.content.workshopId !== input.workshopId || input.content.runId !== input.runId) throw new MemoryIdentityConflict();
  return insertWorkRunStateSnapshotInTransaction(store, input);
}
