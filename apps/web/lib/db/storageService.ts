import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { UserType } from "@/app/(auth)/auth";
import type { FileStorageProvider } from "@/lib/files/config";
import { db } from "./client";
import { userFileUsage, userFiles } from "./schema";
import { memoryArtifactManifests } from "./schema.pg";
import { ARTIFACT_QUOTA_BYTES } from "@/lib/memory/artifacts/contracts";
import { cleanupArtifactReference, saveArtifactRecord } from "@/lib/memory/artifacts/service";
import { requireArtifactOwner, withArtifactOwner } from "@/lib/memory/adapters/postgres/artifacts";
import { artifactIdFromReference } from "@/lib/memory/artifacts/http";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

/** Compatibility metadata reads do not create quota rows or imply object access. */
export async function getUserStorageUsage(userId: string, _userType: UserType) {
  return withArtifactOwner(userId, "share", async store => {
    const [usage] = await store.select({ usedBytes: userFileUsage.usedBytes }).from(userFileUsage).where(eq(userFileUsage.userId, userId));
    const [pending] = await store.select({ reserved: sql`coalesce(sum(${memoryArtifactManifests.sizeBytes}),0)` }).from(memoryArtifactManifests)
      .where(and(eq(memoryArtifactManifests.userId, userId), eq(memoryArtifactManifests.quotaCharged, false), inArray(memoryArtifactManifests.state, ["pending", "sealed", "deleting"])));
    return { quotaBytes: ARTIFACT_QUOTA_BYTES, usedBytes: usage?.usedBytes ?? 0, reservedBytes: Number(pending?.reserved ?? 0) };
  });
}
type CreateUserFileInput = { userId: string; userType: UserType; chatId?: string | null; messageId?: string | null;
  blobUrl: string; blobPathname: string; name: string; contentType: string; sizeBytes: number; storageProvider?: FileStorageProvider;
  providerFileId?: string | null; providerMetadata?: Record<string, unknown> | null; commandId?: string };
/** A file record may only bind an existing owner-controlled private manifest. */
export async function createUserFile(input: CreateUserFileInput) {
  if (input.storageProvider && !["private_local", "private_blob"].includes(input.storageProvider)) throw new MemoryModuleError("artifact_legacy_uncontrolled", 410, "External exports require a separate explicit provider contract");
  const artifactId = artifactIdFromReference(input.blobPathname) ?? artifactIdFromReference(input.blobUrl);
  if (!artifactId) throw new MemoryModuleError("artifact_legacy_uncontrolled", 410, "Legacy public file metadata cannot be activated as a private artifact");
  const result = await saveArtifactRecord(input.userId, { artifactId, commandId: input.commandId ?? `file-save:${artifactId}`,
    ...(input.chatId ? { chatId: input.chatId, messageId: input.messageId ?? undefined } : {}) });
  const file = await getUserFileById({ userId: input.userId, fileId: result.manifest.userFileId ?? artifactId });
  if (!file) throw new MemoryModuleError("artifact_record_unavailable", 503, "The saved file record is unavailable");
  return { file, usage: await getUserStorageUsage(input.userId, input.userType) };
}
export async function deleteUserFile({ userId, fileId }: { userId: string; fileId: string }) {
  const file = await getUserFileById({ userId, fileId });
  if (!file) throw new MemoryModuleError("artifact_not_found", 404, "File unavailable");
  const artifactId = artifactIdFromReference(file.blobPathname);
  if (!artifactId) throw new MemoryModuleError("artifact_legacy_uncontrolled", 410, "Historical external/public objects require explicit provider migration; no revocation is claimed");
  await cleanupArtifactReference(userId, { artifactId, commandId: `file-delete:${fileId}` }); return file;
}
export async function listUserFiles({ userId, limit = 20, cursor }: { userId: string; limit?: number; cursor?: string | null }) {
  requireArtifactOwner(userId);
  const conditions = [eq(userFiles.userId, userId)];
  if (cursor) { const date = new Date(cursor); if (!Number.isFinite(date.getTime())) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid file cursor"); conditions.push(lt(userFiles.savedAt, date)); }
  const rows: (typeof userFiles.$inferSelect)[] = await db.select().from(userFiles).where(and(...conditions)).orderBy(desc(userFiles.savedAt)).limit(Math.max(1, Math.min(limit, 100)) + 1);
  const hasMore = rows.length > limit, files = hasMore ? rows.slice(0, limit) : rows;
  return { files, hasMore, nextCursor: hasMore ? files.at(-1)?.savedAt.toISOString() ?? null : null };
}
export async function getUserFileById({ userId, fileId }: { userId: string; fileId: string }) {
  requireArtifactOwner(userId);
  const [file]: (typeof userFiles.$inferSelect)[] = await db.select().from(userFiles).where(and(eq(userFiles.id, fileId), eq(userFiles.userId, userId))).limit(1);
  return file ?? null;
}
export async function getUserFileByBlobPathname({ userId, blobPathname }: { userId: string; blobPathname: string }) {
  requireArtifactOwner(userId);
  const [file]: (typeof userFiles.$inferSelect)[] = await db.select().from(userFiles).where(and(eq(userFiles.blobPathname, blobPathname), eq(userFiles.userId, userId))).limit(1);
  return file ?? null;
}
/** Legacy maintenance inventory only; never grants read or deletion capability. */
export async function getSavedBlobPathSet(blobPaths: string[]): Promise<Set<string>> {
  if (!blobPaths.length) return new Set();
  const rows: { blobPathname: string }[] = await db.select({ blobPathname: userFiles.blobPathname }).from(userFiles).where(inArray(userFiles.blobPathname, blobPaths));
  return new Set(rows.map(row => row.blobPathname));
}
