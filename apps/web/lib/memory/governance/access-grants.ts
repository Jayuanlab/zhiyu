import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { user, brainAccessGrants, brainStateSnapshots } from "@/lib/db/schema";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { memoryInvalid, MemoryModuleError } from "../kernel/errors";
import { brainAccessGrantFromRow, brainAccessGrantToInsertRow } from "../records/memory-record";
import type { BrainAccessGrant } from "../kernel/memory-types";

async function lockAuthority(store: typeof db, userId: string) {
  if (resolveExecutionLease()) throw new MemoryModuleError("memory_owner_context_required", 403, "Access changes require an owner context");
  const [owner] = await store.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
  if (!owner) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity unavailable");
}
async function audit(store: typeof db, grant: BrainAccessGrant, action: "create" | "revoke") {
  const [saved] = await store.insert(brainStateSnapshots).values({ id: randomUUID(), userId: grant.userId,
    scopeType: "global", scopeId: null, snapshotType: "memory_access_change",
    content: { version: "memory-access-change.v1", action, grant },
    metadata: { source: "memory_governance", authority: "owner", actorId: grant.userId } }).returning();
  if (!saved) throw new Error("Memory access change audit was not persisted");
}
/** Every access mutation takes the same authority row exclusively that final
 * context admission holds shared, including creation and revocation of grants. */
export async function createBrainAccessGrant(grant: Omit<BrainAccessGrant, "id"> & { id?: string; reason?: string | null }): Promise<BrainAccessGrant> {
  if (typeof grant.userId !== "string") memoryInvalid("Invalid owner");
  return db.transaction(async store => {
    await lockAuthority(store, grant.userId);
    const [created] = await store.insert(brainAccessGrants).values(brainAccessGrantToInsertRow(grant)).returning();
    if (!created) throw new Error("Memory access grant was not persisted");
    const result = brainAccessGrantFromRow(created);
    await audit(store, result, "create"); return result;
  });
}
export async function deleteBrainAccessGrant(input: { userId: string; grantId: string }) {
  return db.transaction(async store => {
    await lockAuthority(store, input.userId);
    const deleted = await store.delete(brainAccessGrants).where(and(eq(brainAccessGrants.userId, input.userId), eq(brainAccessGrants.id, input.grantId))).returning();
    for (const row of deleted) await audit(store, brainAccessGrantFromRow(row), "revoke");
    return { deletedCount: deleted.length };
  });
}
