import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import { memoryArtifactManifests, memoryArtifactCommandReceipts, memoryArtifactReadReceipts } from "@/lib/db/schema.pg";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { MemoryModuleError } from "../../kernel/errors";
import { stableJson } from "../../records/observations";
import type { ArtifactCommandResult, ArtifactManifest, ArtifactRef } from "../../artifacts/contracts";

export type ArtifactRow = typeof memoryArtifactManifests.$inferSelect;
export function requireArtifactOwner(userId: string) {
  if (resolveExecutionLease()) throw new MemoryModuleError("memory_owner_context_required", 403, "File access requires an explicit owner context; Work file bindings are not registered");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(userId)) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity unavailable");
  if (process.env.IS_TAURI === "true") throw new MemoryModuleError("artifact_native_provider_unavailable", 503, "The native file provider has not adopted the private manifest contract");
}
export async function withArtifactOwner<T>(userId: string, mode: "share" | "update", work: (store: DrizzleDB) => Promise<T>): Promise<T> {
  requireArtifactOwner(userId);
  return db.transaction(async store => {
    const [owner] = await store.select({ id: user.id }).from(user).where(eq(user.id, userId)).for(mode);
    if (!owner) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity unavailable");
    return work(store);
  });
}
export async function lockArtifact(store: DrizzleDB, userId: string, artifactId: string, mode: "share" | "update") {
  const [row]: ArtifactRow[] = await store.select().from(memoryArtifactManifests)
    .where(and(eq(memoryArtifactManifests.userId, userId), eq(memoryArtifactManifests.id, artifactId))).for(mode);
  return row ?? null;
}
export function artifactRef(row: ArtifactRow): ArtifactRef {
  const digest = createHash("sha256").update(stableJson({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt.toISOString() })).digest("hex");
  return { record: { kind: "artifact", id: row.id }, revision: `artifact:${row.id}:${row.revision}:${digest}` };
}
export function artifactPublicManifest(row: ArtifactRow): ArtifactManifest {
  const recovery = row.metadata.cleanupIntent as { commandId?: unknown; fromRevision?: unknown } | undefined;
  return { id: row.id, name: row.name, contentType: row.contentType, sizeBytes: row.sizeBytes, sha256: row.sha256, state: row.state,
    revision: row.revision, provider: row.provider, expiresAt: row.expiresAt.toISOString(), cleanupAttempts: row.cleanupAttempts, lastError: row.lastError,
    userFileId: row.userFileId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), url: `/api/files/${row.id}`, indexStatus: "not_requested",
    ...(row.state === "deleting" && typeof recovery?.commandId === "string" && typeof recovery.fromRevision === "number" && Number.isSafeInteger(recovery.fromRevision)
      ? { cleanupRecovery: { commandId: recovery.commandId, expectedRevision: recovery.fromRevision } } : {}) };
}
export const artifactRequestHash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
export async function replayArtifactCommand(store: DrizzleDB, userId: string, commandId: string, requestHash: string): Promise<ArtifactCommandResult | null> {
  const [previous]: (typeof memoryArtifactCommandReceipts.$inferSelect)[] = await store.select().from(memoryArtifactCommandReceipts)
    .where(and(eq(memoryArtifactCommandReceipts.userId, userId), eq(memoryArtifactCommandReceipts.commandId, commandId)));
  if (!previous) return null;
  if (previous.requestHash !== requestHash) throw new MemoryModuleError("memory_command_conflict", 409, "The command ID was already used for different file input");
  return { status: "recorded", replayed: true, resultSemantics: "command_result_at_revision", ...previous.result as { manifest: ArtifactManifest; ref: ArtifactRef },
    receipt: { id: previous.id, commandId, fromRevision: previous.fromRevision, toRevision: previous.toRevision, createdAt: previous.createdAt.toISOString() } };
}
export async function persistArtifactCommand(store: DrizzleDB, input: { userId: string; commandId: string; requestHash: string; action: string; fromRevision: number; row: ArtifactRow }): Promise<ArtifactCommandResult> {
  const result = { manifest: artifactPublicManifest(input.row), ref: artifactRef(input.row) };
  const [saved]: (typeof memoryArtifactCommandReceipts.$inferSelect)[] = await store.insert(memoryArtifactCommandReceipts).values({ id: randomUUID(),
    userId: input.userId, commandId: input.commandId, requestHash: input.requestHash, action: input.action,
    artifactId: input.row.id, fromRevision: input.fromRevision, toRevision: input.row.revision, result }).returning();
  if (!saved) throw new Error("Artifact command receipt was not persisted");
  return { status: "recorded", replayed: false, resultSemantics: "command_result_at_revision", ...result,
    receipt: { id: saved.id, commandId: saved.commandId, fromRevision: saved.fromRevision, toRevision: saved.toRevision, createdAt: saved.createdAt.toISOString() } };
}
export async function persistArtifactRead(store: DrizzleDB, row: ArtifactRow, range: { start: number; end: number }, purpose: "current" | "evidence" = "evidence") {
  const ref = artifactRef(row);
  const [saved]: (typeof memoryArtifactReadReceipts.$inferSelect)[] = await store.insert(memoryArtifactReadReceipts).values({ id: randomUUID(), userId: row.userId,
    artifactId: row.id, revision: ref.revision, purpose, actualRange: { ...range, unit: "bytes" }, totalLength: row.sizeBytes, sha256: row.sha256 }).returning();
  if (!saved) throw new Error("Artifact read receipt was not persisted");
  return { id: saved.id, purpose, ref, actualRange: saved.actualRange, totalLength: saved.totalLength, sha256: saved.sha256, createdAt: saved.createdAt.toISOString() };
}
