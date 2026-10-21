import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { chat, message, user, userFiles, userFileUsage } from "@/lib/db/schema";
import { memoryArtifactManifests, memoryArtifactCommandReceipts, memoryArtifactReadReceipts } from "@/lib/db/schema.pg";
import { MemoryModuleError } from "../kernel/errors";
import { privateArtifactStore } from "./object-store";
import { artifactDigest, requireArtifactMedia, verifyArtifactMedia } from "./policy";
import { reserveArtifactUploadIntent } from "./upload-intent";
import { ARTIFACT_QUOTA_BYTES, ARTIFACT_UPLOAD_TTL_MS, MAX_ARTIFACT_BYTES, beginArtifactInput, sealArtifactInput, activateArtifactInput,
  cleanupArtifactInput, artifactReadInput, artifactCurrentInput, parseArtifact, type ArtifactCommandResult } from "./contracts";
import { artifactPublicManifest, artifactRef, artifactRequestHash, lockArtifact, persistArtifactCommand, persistArtifactRead,
  replayArtifactCommand, requireArtifactOwner, withArtifactOwner, type ArtifactRow } from "../adapters/postgres/artifacts";

const missing = () => new MemoryModuleError("artifact_not_found", 404, "File unavailable");
const conflict = () => new MemoryModuleError("artifact_version_conflict", 409, "The file state changed; refresh its current manifest");
const unavailable = (code = "artifact_object_unavailable") => new MemoryModuleError(code, 503, "The private file object is unavailable; its manifest remains recoverable");
const meta = () => ({ traceId: randomUUID(), contractVersion: "memory-artifact.v1", implementationVersion: "memory-t5.v1", provider: "postgres", detail: "private_artifact_manifest", warnings: [] as string[] });
function expectedPending(row: ArtifactRow, revision: number, state: "pending" | "sealed") {
  if (row.revision !== revision || row.state !== state) throw conflict();
  if (row.expiresAt.getTime() <= Date.now()) throw new MemoryModuleError("artifact_upload_expired", 409, "This upload intent expired; cleanup is required before another upload");
}
function checkBytes(row: Pick<ArtifactRow, "sizeBytes" | "sha256" | "contentType">, bytes: Uint8Array) {
  if (bytes.byteLength !== row.sizeBytes || artifactDigest(bytes) !== row.sha256)
    throw new MemoryModuleError("artifact_integrity_mismatch", 409, "The actual file size or digest does not match its manifest");
  verifyArtifactMedia(bytes, row.contentType);
}
async function currentRow(userId: string, artifactId: string) {
  return withArtifactOwner(userId, "share", store => lockArtifact(store, userId, artifactId, "share"));
}
async function usage(store: DrizzleDB, userId: string) {
  await store.insert(userFileUsage).values({ userId, usedBytes: 0 }).onConflictDoNothing();
  const [row]: { usedBytes: number }[] = await store.select({ usedBytes: userFileUsage.usedBytes }).from(userFileUsage).where(eq(userFileUsage.userId, userId)).for("update");
  if (!row || !Number.isSafeInteger(row.usedBytes) || row.usedBytes < 0) throw unavailable("artifact_quota_unavailable");
  return row.usedBytes;
}
export async function beginArtifact(userId: string, value: unknown): Promise<ArtifactCommandResult> {
  requireArtifactOwner(userId); const command = parseArtifact(beginArtifactInput, value), requestHash = artifactRequestHash(command);
  requireArtifactMedia(command.contentType);
  return withArtifactOwner(userId, "update", async store => {
    const replay = await replayArtifactCommand(store, userId, command.commandId, requestHash); if (replay) return replay;
    const provider = privateArtifactStore().provider, usedBytes = await usage(store, userId);
    const [reservation]: { bytes: string | number }[] = await store.select({ bytes: sql`coalesce(sum(${memoryArtifactManifests.sizeBytes}),0)` }).from(memoryArtifactManifests)
      .where(and(eq(memoryArtifactManifests.userId, userId), eq(memoryArtifactManifests.quotaCharged, false), inArray(memoryArtifactManifests.state, ["pending", "sealed", "deleting"])));
    const reservedBytes = Number(reservation?.bytes ?? 0);
    if (!Number.isSafeInteger(reservedBytes) || usedBytes + reservedBytes + command.sizeBytes > ARTIFACT_QUOTA_BYTES)
      throw new MemoryModuleError("artifact_quota_exceeded", 413, "File storage and pending uploads exceed the current storage quota");
    const id = randomUUID();
    const [row]: ArtifactRow[] = await store.insert(memoryArtifactManifests).values({ id, userId, commandId: command.commandId, requestHash,
      revision: 0, state: "pending", provider, objectKey: `${userId.toLowerCase()}/${id}/${randomUUID()}.bin`, name: command.name, contentType: command.contentType,
      sizeBytes: command.sizeBytes, sha256: command.sha256, expiresAt: new Date(Date.now() + ARTIFACT_UPLOAD_TTL_MS), quotaCharged: false,
      metadata: { schemaVersion: "memory-artifact.v1", indexStatus: "not_requested", storageAccess: "private_owner_only" } }).returning();
    if (!row) throw unavailable();
    return persistArtifactCommand(store, { userId, commandId: command.commandId, requestHash, action: command.kind, fromRevision: 0, row });
  });
}

/** Immutable private object IO deliberately occurs outside every DB transaction. */
export async function uploadArtifactBytes(userId: string, input: { artifactId: string; expectedRevision: number; data: Uint8Array }) {
  requireArtifactOwner(userId); if (!(input.data instanceof Uint8Array) || input.data.byteLength > MAX_ARTIFACT_BYTES) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid artifact byte upload");
  parseArtifact(sealArtifactInput, { kind: "artifact.seal", commandId: "internal-byte-upload", artifactId: input.artifactId, expectedRevision: input.expectedRevision });
  const row = await currentRow(userId, input.artifactId); if (!row) throw missing(); checkBytes(row, input.data);
  if (row.state === "sealed" || row.state === "active") return { manifest: artifactPublicManifest(row), ref: artifactRef(row) };
  expectedPending(row, input.expectedRevision, "pending"); const provider = privateArtifactStore(row.provider);
  try { await provider.putImmutable(row.objectKey, input.data); checkBytes(row, await provider.read(row.objectKey, MAX_ARTIFACT_BYTES)); }
  catch (error) {
    if (error instanceof MemoryModuleError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "PRIVATE_OBJECT_RETIRED") throw new MemoryModuleError("artifact_upload_intent_closed", 409, "The immutable upload key was retired by cleanup");
    throw unavailable();
  }
  const after = await currentRow(userId, input.artifactId);
  if (!after || ["deleting", "deleted"].includes(after.state)) {
    // The manifest tombstone keeps this random key recoverable even if this
    // late write's compensation fails or the host dies before compensation.
    await provider.remove(row.objectKey).catch(async () => {
      await withArtifactOwner(userId, "update", async store => {
        const current = await lockArtifact(store, userId, row.id, "update");
        if (current && ["deleting", "deleted"].includes(current.state)) await store.update(memoryArtifactManifests)
          .set({ state: "deleting", lastError: "artifact_late_object_cleanup_pending", revision: current.revision + 1, updatedAt: new Date(),
            metadata: { ...current.metadata, cleanupIntent: { recoveryRequired: true, fromRevision: current.revision + 1 } } })
          .where(and(eq(memoryArtifactManifests.id, row.id), eq(memoryArtifactManifests.userId, userId)));
      });
    });
    throw new MemoryModuleError("artifact_upload_intent_closed", 409, "Cleanup won the upload intent; a late upload cannot be sealed");
  }
  if (after.state === "pending" && (after.revision !== input.expectedRevision || artifactRef(after).revision !== artifactRef(row).revision)) throw conflict();
  return { manifest: artifactPublicManifest(after), ref: artifactRef(after) };
}
export async function sealArtifact(userId: string, value: unknown): Promise<ArtifactCommandResult> {
  requireArtifactOwner(userId); const command = parseArtifact(sealArtifactInput, value), requestHash = artifactRequestHash(command);
  const preflight = await withArtifactOwner(userId, "share", async store => {
    const replay = await replayArtifactCommand(store, userId, command.commandId, requestHash); if (replay) return { replay };
    const row = await lockArtifact(store, userId, command.artifactId, "share"); if (!row) throw missing(); expectedPending(row, command.expectedRevision, "pending"); return { row };
  });
  if (preflight.replay) return preflight.replay;
  const row = preflight.row; if (!row) throw missing();
  let bytes: Uint8Array; try { bytes = await privateArtifactStore(row.provider).read(row.objectKey, MAX_ARTIFACT_BYTES); }
  catch (error) { if (error instanceof MemoryModuleError) throw error; throw unavailable(); }
  checkBytes(row, bytes);
  return withArtifactOwner(userId, "update", async store => {
    const replay = await replayArtifactCommand(store, userId, command.commandId, requestHash); if (replay) return replay;
    const current = await lockArtifact(store, userId, command.artifactId, "update"); if (!current) throw missing(); expectedPending(current, command.expectedRevision, "pending");
    if (artifactRef(current).revision !== artifactRef(row).revision) throw conflict();
    const [sealed]: ArtifactRow[] = await store.update(memoryArtifactManifests).set({ state: "sealed", revision: current.revision + 1, updatedAt: new Date(),
      metadata: { ...current.metadata, integrity: "sha256_size_and_media_signature", indexStatus: "not_requested" } })
      .where(and(eq(memoryArtifactManifests.id, current.id), eq(memoryArtifactManifests.userId, userId), eq(memoryArtifactManifests.revision, command.expectedRevision), eq(memoryArtifactManifests.state, "pending"))).returning();
    if (!sealed) throw conflict();
    return persistArtifactCommand(store, { userId, commandId: command.commandId, requestHash, action: command.kind, fromRevision: current.revision, row: sealed });
  });
}
export async function activateArtifact(userId: string, value: unknown): Promise<ArtifactCommandResult> {
  requireArtifactOwner(userId); const command = parseArtifact(activateArtifactInput, value), requestHash = artifactRequestHash(command);
  return withArtifactOwner(userId, "update", async store => {
    const replay = await replayArtifactCommand(store, userId, command.commandId, requestHash); if (replay) return replay;
    const row = await lockArtifact(store, userId, command.artifactId, "update"); if (!row) throw missing();
    if (row.revision !== command.expectedRevision || !["sealed", "active"].includes(row.state)) throw conflict();
    if (row.state === "sealed") expectedPending(row, command.expectedRevision, "sealed");
    if (command.chatId && command.messageId) {
      const [ownedChat] = await store.select({ id: chat.id }).from(chat).where(and(eq(chat.id, command.chatId), eq(chat.userId, userId))).for("share");
      const [ownedMessage] = await store.select({ id: message.id }).from(message).where(and(eq(message.id, command.messageId), eq(message.chatId, command.chatId))).for("share");
      if (!ownedChat || !ownedMessage) throw missing();
    }
    let userFileId = row.userFileId;
    if (command.saveRecord && !userFileId) {
      const [saved]: { id: string }[] = await store.insert(userFiles).values({ id: row.id, userId, chatId: command.chatId ?? null, messageId: command.messageId ?? null,
        blobUrl: `/api/files/${row.id}`, blobPathname: `artifact:${row.id}`, name: row.name, contentType: row.contentType, sizeBytes: row.sizeBytes,
        storageProvider: row.provider, providerFileId: row.id, providerMetadata: { artifactId: row.id, controlStatus: "private_manifest", indexStatus: "not_requested" } }).returning({ id: userFiles.id });
      if (!saved) throw unavailable(); userFileId = saved.id;
    } else if (command.saveRecord && userFileId && command.chatId) {
      const [saved] = await store.select({ chatId: userFiles.chatId, messageId: userFiles.messageId }).from(userFiles).where(and(eq(userFiles.id, userFileId), eq(userFiles.userId, userId)));
      if (!saved || saved.chatId !== command.chatId || saved.messageId !== command.messageId) throw new MemoryModuleError("artifact_binding_conflict", 409, "This saved file already has a different business reference");
    }
    if (!row.quotaCharged) {
      const usedBytes = await usage(store, userId);
      if (usedBytes + row.sizeBytes > ARTIFACT_QUOTA_BYTES) throw new MemoryModuleError("artifact_quota_exceeded", 413, "This file exceeds the current storage quota");
      await store.update(userFileUsage).set({ usedBytes: usedBytes + row.sizeBytes, updatedAt: new Date() }).where(eq(userFileUsage.userId, userId));
    }
    let active = row;
    if (row.state !== "active" || row.userFileId !== userFileId || !row.quotaCharged) {
      const [updated]: ArtifactRow[] = await store.update(memoryArtifactManifests).set({ state: "active", quotaCharged: true, userFileId, revision: row.revision + 1, updatedAt: new Date() })
        .where(and(eq(memoryArtifactManifests.id, row.id), eq(memoryArtifactManifests.userId, userId), eq(memoryArtifactManifests.revision, command.expectedRevision))).returning();
      if (!updated) throw conflict(); active = updated;
    }
    return persistArtifactCommand(store, { userId, commandId: command.commandId, requestHash, action: command.kind, fromRevision: row.revision, row: active });
  });
}

export async function cleanupArtifact(userId: string, value: unknown): Promise<ArtifactCommandResult> {
  requireArtifactOwner(userId); const command = parseArtifact(cleanupArtifactInput, value), requestHash = artifactRequestHash(command);
  const claimed = await withArtifactOwner(userId, "update", async store => {
    const replay = await replayArtifactCommand(store, userId, command.commandId, requestHash); if (replay) return { replay };
    const row = await lockArtifact(store, userId, command.artifactId, "update"); if (!row) throw missing();
    const intent = row.metadata.cleanupIntent as { commandId?: string; requestHash?: string; fromRevision?: number; recoveryRequired?: boolean } | undefined;
    const repairingLateObject = row.state === "deleting" && intent?.recoveryRequired === true;
    if (row.state === "deleting" && !repairingLateObject) { if (intent?.commandId !== command.commandId || intent.requestHash !== requestHash) throw conflict(); }
    else if (row.revision !== command.expectedRevision) throw conflict();
    const fromRevision = row.state === "deleting" && !repairingLateObject ? intent?.fromRevision : row.revision;
    if (!Number.isSafeInteger(fromRevision)) throw unavailable();
    const [deleting]: ArtifactRow[] = await store.update(memoryArtifactManifests).set({ state: "deleting", revision: row.revision + 1,
      cleanupAttempts: row.cleanupAttempts + 1, lastError: null, updatedAt: new Date(),
      metadata: { ...row.metadata, cleanupIntent: { commandId: command.commandId, requestHash, fromRevision } } })
      .where(and(eq(memoryArtifactManifests.id, row.id), eq(memoryArtifactManifests.userId, userId), eq(memoryArtifactManifests.revision, row.revision))).returning();
    if (!deleting) throw conflict(); return { row: deleting, fromRevision: Number(fromRevision) };
  });
  if (claimed.replay) return claimed.replay;
  const row = claimed.row; if (!row) throw missing();
  try { await privateArtifactStore(row.provider).remove(row.objectKey); }
  catch {
    await withArtifactOwner(userId, "update", async store => {
      const current = await lockArtifact(store, userId, row.id, "update");
      if (current?.state === "deleting") await store.update(memoryArtifactManifests).set({ lastError: "artifact_object_delete_failed", revision: current.revision + 1, updatedAt: new Date() })
        .where(and(eq(memoryArtifactManifests.id, row.id), eq(memoryArtifactManifests.userId, userId)));
    });
    throw unavailable("artifact_cleanup_failed");
  }
  return withArtifactOwner(userId, "update", async store => {
    const replay = await replayArtifactCommand(store, userId, command.commandId, requestHash); if (replay) return replay;
    const current = await lockArtifact(store, userId, row.id, "update");
    const intent = current?.metadata.cleanupIntent as { commandId?: string; requestHash?: string } | undefined;
    if (!current || current.state !== "deleting" || intent?.commandId !== command.commandId || intent.requestHash !== requestHash) throw conflict();
    if (current.quotaCharged) {
      const usedBytes = await usage(store, userId); if (usedBytes < current.sizeBytes) throw unavailable("artifact_quota_unavailable");
      await store.update(userFileUsage).set({ usedBytes: usedBytes - current.sizeBytes, updatedAt: new Date() }).where(eq(userFileUsage.userId, userId));
    }
    if (current.userFileId) await store.delete(userFiles).where(and(eq(userFiles.id, current.userFileId), eq(userFiles.userId, userId)));
    const [deleted]: ArtifactRow[] = await store.update(memoryArtifactManifests).set({ state: "deleted", quotaCharged: false, userFileId: null, revision: current.revision + 1, lastError: null, updatedAt: new Date() })
      .where(and(eq(memoryArtifactManifests.id, current.id), eq(memoryArtifactManifests.userId, userId), eq(memoryArtifactManifests.revision, current.revision))).returning();
    if (!deleted) throw conflict();
    const fromRevision = claimed.fromRevision; if (fromRevision === undefined) throw unavailable();
    return persistArtifactCommand(store, { userId, commandId: command.commandId, requestHash, action: command.kind, fromRevision, row: deleted });
  });
}

export async function readArtifactCurrent(userId: string, value: unknown) {
  requireArtifactOwner(userId); const query = parseArtifact(artifactCurrentInput, value);
  return withArtifactOwner(userId, "share", async store => {
    const row = await lockArtifact(store, userId, query.artifactId, "share"); if (!row) return { status: "not_found" as const, meta: meta() };
    const receipt = await persistArtifactRead(store, row, { start: 0, end: 0 }, "current");
    return { status: "ok" as const, record: artifactPublicManifest(row), ref: artifactRef(row), receipt, meta: meta() };
  });
}
export async function readArtifact(userId: string, value: unknown) {
  requireArtifactOwner(userId); const query = parseArtifact(artifactReadInput, value), before = await currentRow(userId, query.artifactId);
  if (!before) return { status: "not_found" as const, meta: meta() };
  if (before.state !== "active") return { status: "unavailable" as const, code: "artifact_not_active", meta: meta() };
  if (query.revision && query.revision !== artifactRef(before).revision) return { status: "unavailable" as const, code: "version_mismatch", meta: meta() };
  let bytes: Uint8Array; try { bytes = await privateArtifactStore(before.provider).read(before.objectKey, MAX_ARTIFACT_BYTES); }
  catch (error) { if (error instanceof MemoryModuleError) throw error; throw unavailable(); }
  checkBytes(before, bytes);
  const range = { start: query.range?.start ?? 0, end: Math.min(query.range?.end ?? bytes.byteLength, bytes.byteLength) };
  if (range.start > bytes.byteLength) throw new MemoryModuleError("invalid_memory_request", 400, "The byte window starts after the file ends");
  return withArtifactOwner(userId, "share", async store => {
    const current = await lockArtifact(store, userId, query.artifactId, "share");
    if (!current || current.state !== "active" || artifactRef(current).revision !== artifactRef(before).revision)
      return { status: "unavailable" as const, code: "version_mismatch", meta: meta() };
    const receipt = await persistArtifactRead(store, current, range, "evidence");
    return { status: "ok" as const, bytes: bytes.slice(range.start, range.end), manifest: artifactPublicManifest(current), ref: artifactRef(current), receipt, meta: meta() };
  });
}
export async function revalidateArtifactInTransaction(store: DrizzleDB, proof: { userId: string; artifactId: string; revision: string }) {
  requireArtifactOwner(proof.userId);
  const [principal] = await store.select({ id: user.id }).from(user).where(eq(user.id, proof.userId)).for("share");
  if (!principal) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity unavailable");
  const row = await lockArtifact(store, proof.userId, proof.artifactId, "share");
  if (!row || row.state !== "active" || artifactRef(row).revision !== proof.revision) throw new MemoryModuleError("artifact_version_unavailable", 503, "The file manifest is no longer active at the exact read version");
  return { ref: artifactRef(row), sha256: row.sha256, sizeBytes: row.sizeBytes, contentType: row.contentType };
}
export async function explainArtifactReceipt(userId: string, receiptId: string) {
  requireArtifactOwner(userId);
  return withArtifactOwner(userId, "share", async store => {
    const [command]: (typeof memoryArtifactCommandReceipts.$inferSelect)[] = await store.select().from(memoryArtifactCommandReceipts)
      .where(and(eq(memoryArtifactCommandReceipts.userId, userId), eq(memoryArtifactCommandReceipts.id, receiptId)));
    if (command) return { status: "ok" as const, type: "artifact_command", historical: true, receipt: { id: command.id, commandId: command.commandId,
      fromRevision: command.fromRevision, toRevision: command.toRevision, createdAt: command.createdAt.toISOString() }, result: command.result };
    const [read]: (typeof memoryArtifactReadReceipts.$inferSelect)[] = await store.select().from(memoryArtifactReadReceipts)
      .where(and(eq(memoryArtifactReadReceipts.userId, userId), eq(memoryArtifactReadReceipts.id, receiptId)));
    return read ? { status: "ok" as const, type: "artifact_read", historical: true, receipt: { id: read.id, purpose: read.purpose, ref: { record: { kind: "artifact", id: read.artifactId }, revision: read.revision },
      actualRange: read.actualRange, totalLength: read.totalLength, sha256: read.sha256, createdAt: read.createdAt.toISOString() } } : { status: "not_found" as const };
  });
}
export async function saveUploadedArtifact(userId: string, input: { commandId: string; name: string; contentType: string; data: Uint8Array; saveRecord?: boolean; chatId?: string; messageId?: string }) {
  requireArtifactOwner(userId); verifyArtifactMedia(input.data, input.contentType);
  const begun = await beginArtifact(userId, { kind: "artifact.begin", commandId: input.commandId, name: input.name, contentType: input.contentType,
    sizeBytes: input.data.byteLength, sha256: artifactDigest(input.data) });
  await reserveArtifactUploadIntent(userId, { mode: "upload", commandId: input.commandId, artifactId: begun.manifest.id,
    saveRecord: input.saveRecord ?? false, chatId: input.chatId, messageId: input.messageId });
  let row = await currentRow(userId, begun.manifest.id); if (!row) throw missing();
  if (row.state === "pending") {
    await uploadArtifactBytes(userId, { artifactId: row.id, expectedRevision: row.revision, data: input.data });
    await sealArtifact(userId, { kind: "artifact.seal", commandId: `upload-seal:${artifactRequestHash(input.commandId)}`, artifactId: row.id, expectedRevision: row.revision });
    row = await currentRow(userId, row.id); if (!row) throw missing();
  }
  const activationId = `upload-activate:${artifactRequestHash(input.commandId)}`;
  // For replay use the original activation CAS input stored in its safe result;
  // do not bind a changed current revision to the same command ID.
  const [prior]: (typeof memoryArtifactCommandReceipts.$inferSelect)[] = await db.select().from(memoryArtifactCommandReceipts)
    .where(and(eq(memoryArtifactCommandReceipts.userId, userId), eq(memoryArtifactCommandReceipts.commandId, activationId)));
  const activated = await activateArtifact(userId, { kind: "artifact.activate", commandId: activationId, artifactId: row.id,
    expectedRevision: prior?.fromRevision ?? row.revision, saveRecord: input.saveRecord ?? false, ...(input.chatId ? { chatId: input.chatId, messageId: input.messageId } : {}) });
  const current = await currentRow(userId, row.id); if (!current || current.state !== "active") throw conflict();
  return { ...activated, manifest: artifactPublicManifest(current), ref: artifactRef(current), resultSemantics: "current_manifest_after_upload" as const };
}
export async function saveArtifactRecord(userId: string, input: { artifactId: string; commandId: string; expectedRevision?: number; chatId?: string; messageId?: string }) {
  requireArtifactOwner(userId); parseArtifact(sealArtifactInput, { kind: "artifact.seal", commandId: input.commandId, artifactId: input.artifactId, expectedRevision: input.expectedRevision ?? 0 });
  const row = await currentRow(userId, input.artifactId); if (!row) throw missing();
  const [prior]: (typeof memoryArtifactCommandReceipts.$inferSelect)[] = await db.select().from(memoryArtifactCommandReceipts)
    .where(and(eq(memoryArtifactCommandReceipts.userId, userId), eq(memoryArtifactCommandReceipts.commandId, input.commandId)));
  return activateArtifact(userId, { kind: "artifact.activate", commandId: input.commandId, artifactId: row.id,
    expectedRevision: input.expectedRevision ?? prior?.fromRevision ?? row.revision, saveRecord: true,
    ...(input.chatId ? { chatId: input.chatId, messageId: input.messageId } : {}) });
}
export async function resumeUploadedArtifact(userId: string, input: { commandId: string; artifactId: string; expectedRevision: number; data: Uint8Array; saveRecord?: boolean }) {
  requireArtifactOwner(userId); parseArtifact(sealArtifactInput, { kind: "artifact.seal", commandId: input.commandId, artifactId: input.artifactId, expectedRevision: input.expectedRevision });
  const row = await currentRow(userId, input.artifactId); if (!row) throw missing();
  checkBytes(row, input.data); if (["deleting", "deleted"].includes(row.state)) throw conflict();
  await reserveArtifactUploadIntent(userId, { mode: "resume", commandId: input.commandId, artifactId: row.id,
    expectedRevision: input.expectedRevision, saveRecord: input.saveRecord ?? false });
  const sealId = `resume-seal:${artifactRequestHash(input.commandId)}`;
  const [previousSeal]: (typeof memoryArtifactCommandReceipts.$inferSelect)[] = await db.select().from(memoryArtifactCommandReceipts)
    .where(and(eq(memoryArtifactCommandReceipts.userId, userId), eq(memoryArtifactCommandReceipts.commandId, sealId)));
  if (row.state !== "pending" && !previousSeal) throw conflict();
  if (row.state === "pending") await uploadArtifactBytes(userId, { artifactId: row.id, expectedRevision: input.expectedRevision, data: input.data });
  const sealed = await sealArtifact(userId, { kind: "artifact.seal", commandId: sealId, artifactId: row.id, expectedRevision: input.expectedRevision });
  const result = await activateArtifact(userId, { kind: "artifact.activate", commandId: `resume-activate:${artifactRequestHash(input.commandId)}`,
    artifactId: row.id, expectedRevision: sealed.manifest.revision, saveRecord: input.saveRecord ?? false });
  const current = await currentRow(userId, row.id); if (!current || current.state !== "active") throw conflict();
  return { ...result, manifest: artifactPublicManifest(current), ref: artifactRef(current), resultSemantics: "current_manifest_after_upload" as const };
}
export async function cleanupArtifactReference(userId: string, input: { artifactId: string; commandId: string; expectedRevision?: number }) {
  requireArtifactOwner(userId); parseArtifact(cleanupArtifactInput, { kind: "artifact.cleanup", commandId: input.commandId, artifactId: input.artifactId, expectedRevision: input.expectedRevision ?? 0 });
  const row = await currentRow(userId, input.artifactId); if (!row) throw missing();
  const [prior]: (typeof memoryArtifactCommandReceipts.$inferSelect)[] = await db.select().from(memoryArtifactCommandReceipts)
    .where(and(eq(memoryArtifactCommandReceipts.userId, userId), eq(memoryArtifactCommandReceipts.commandId, input.commandId)));
  const intent = row.metadata.cleanupIntent as { commandId?: string; fromRevision?: number } | undefined;
  return cleanupArtifact(userId, { kind: "artifact.cleanup", commandId: input.commandId, artifactId: row.id,
    expectedRevision: input.expectedRevision ?? prior?.fromRevision ?? (intent?.commandId === input.commandId ? intent.fromRevision : undefined) ?? row.revision });
}
