import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { user, userFileUsage } from '@/lib/db/schema';
import { memoryArtifactManifests } from '@/lib/db/schema.pg';
import { withExecutionBusinessWrite } from '@/lib/work-runtime/execution-lease';
import { resolveExecutionLease } from '@/lib/work-runtime/execution-context';
import { artifactRequestHash, lockArtifact, artifactRef, persistArtifactCommand, replayArtifactCommand, type ArtifactRow } from '../adapters/postgres/artifacts';
import { readFileBindingForShare } from '../adapters/postgres/file-bindings';
import { readExactArtifactEvidenceReceiptForShare } from '../adapters/postgres/exact-published-sources';
import { privateArtifactStore } from '../artifacts/object-store';
import { artifactDigest, verifyArtifactMedia } from '../artifacts/policy';
import { ARTIFACT_QUOTA_BYTES, ARTIFACT_UPLOAD_TTL_MS, MAX_ARTIFACT_BYTES } from '../artifacts/contracts';
import { MemoryModuleError } from '../kernel/errors';
import type { FileBindingRef } from './contracts';
import type { DrizzleDB } from '@/lib/db/types';
import { ExecutionLeaseError } from '@/lib/work-runtime/execution-errors';
import { MemoryWriteBusy } from '../kernel/reference-errors';

/** This narrow producer accepts only host converter output and a real same-Work
 * source read receipt. It does not grant an owner upload capability to a Work. */
async function saveDerived(input: { commandId: string; source: FileBindingRef; name: string; bytes: Uint8Array }) {
  const lease = resolveExecutionLease();
  if (!lease || input.source.permission !== 'convert' || input.source.tool !== 'workshopConvertDocument')
    throw new MemoryModuleError('work_file_unavailable', 403, 'A current converter execution capability is required');
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_ARTIFACT_BYTES || !/^[^\\/\u0000-\u001f]{1,200}$/.test(input.name))
    throw new MemoryModuleError('invalid_memory_request', 400, 'Invalid derived file');
  verifyArtifactMedia(input.bytes, 'text/markdown');
  const sha256 = artifactDigest(input.bytes), commandId = `work-derived:${artifactRequestHash({ runId: lease.runId, commandId: input.commandId })}`;
  const requestHash = artifactRequestHash({ source: input.source, name: input.name, sha256, size: input.bytes.byteLength });
  const validate = async (store: DrizzleDB) => {
    await store.select({ id: user.id }).from(user).where(eq(user.id, lease.userId)).for('update');
    const source = await readFileBindingForShare(store, { userId: lease.userId, workId: lease.workshopId, bindingId: input.source.id, permission: 'convert', tool: 'workshopConvertDocument' });
    const read = await readExactArtifactEvidenceReceiptForShare(store, { userId: lease.userId, receiptId: input.source.evidenceReceiptId });
    if (source.revision !== input.source.revision || source.manifest.id !== input.source.artifactId || source.binding.artifactRevision !== input.source.artifactRevision
      || !read || read.purpose !== 'evidence' || read.artifactId !== source.manifest.id || read.revision !== source.binding.artifactRevision
      || read.sha256 !== source.manifest.sha256) throw new MemoryModuleError('file_derivation_source_changed', 409, 'The converter source changed; read a fresh bound source');
    return source;
  };
  const pending = await withExecutionBusinessWrite(lease, async ({ db: store }) => {
    await validate(store);
    const replay = await replayArtifactCommand(store, lease.userId, commandId, requestHash); if (replay) return { replay };
    const [existing]: ArtifactRow[] = await store.select().from(memoryArtifactManifests).where(and(eq(memoryArtifactManifests.userId, lease.userId), eq(memoryArtifactManifests.commandId, commandId))).for('update');
    if (existing) { if (existing.requestHash !== requestHash || existing.state !== 'pending') throw new MemoryModuleError('artifact_version_conflict', 409, 'Derived upload intent changed'); return { row: existing }; }
    await store.insert(userFileUsage).values({ userId: lease.userId, usedBytes: 0 }).onConflictDoNothing();
    const [usage]: Array<{ usedBytes: number }> = await store.select({ usedBytes: userFileUsage.usedBytes }).from(userFileUsage).where(eq(userFileUsage.userId, lease.userId)).for('update');
    const [reserved]: Array<{ bytes: string | number }> = await store.select({ bytes: sql`coalesce(sum(${memoryArtifactManifests.sizeBytes}),0)` }).from(memoryArtifactManifests)
      .where(and(eq(memoryArtifactManifests.userId, lease.userId), eq(memoryArtifactManifests.quotaCharged, false), inArray(memoryArtifactManifests.state, ['pending', 'sealed', 'deleting'])));
    if (!usage || !Number.isSafeInteger(usage.usedBytes) || usage.usedBytes < 0 || !Number.isSafeInteger(Number(reserved?.bytes ?? 0))
      || usage.usedBytes + Number(reserved?.bytes ?? 0) + input.bytes.byteLength > ARTIFACT_QUOTA_BYTES)
      throw new MemoryModuleError('artifact_quota_exceeded', 413, 'Derived file exceeds storage and pending-upload quota');
    const id = randomUUID();
    const [row]: ArtifactRow[] = await store.insert(memoryArtifactManifests).values({ id, userId: lease.userId, commandId, requestHash,
      revision: 0, state: 'pending', provider: privateArtifactStore().provider, objectKey: `${lease.userId}/${id}/${randomUUID()}.bin`,
      name: input.name, contentType: 'text/markdown', sizeBytes: input.bytes.byteLength, sha256,
      expiresAt: new Date(Date.now() + ARTIFACT_UPLOAD_TTL_MS), quotaCharged: false,
      metadata: { schemaVersion: 'memory-artifact.v1', representation: 'derived_content', origin: { bindingId: input.source.id,
        sourceRevision: input.source.revision, artifactId: input.source.artifactId, artifactRevision: input.source.artifactRevision,
        evidenceReceiptId: input.source.evidenceReceiptId, runId: lease.runId }, indexStatus: 'not_requested', storageAccess: 'private_owner_only' } }).returning();
    if (!row) throw new Error('Derived upload intent was not persisted'); return { row };
  });
  if (pending.replay) return pending.replay;
  const row = pending.row; if (!row) throw new Error('Derived upload intent unavailable');
  const provider = privateArtifactStore(row.provider);
  await provider.putImmutable(row.objectKey, input.bytes);
  const actual = await provider.read(row.objectKey, MAX_ARTIFACT_BYTES);
  if (actual.byteLength !== input.bytes.byteLength || artifactDigest(actual) !== sha256) throw new MemoryModuleError('artifact_integrity_mismatch', 503, 'Derived object integrity unavailable');
  return withExecutionBusinessWrite(lease, async ({ db: store, append }) => {
    await validate(store);
    const replay = await replayArtifactCommand(store, lease.userId, commandId, requestHash); if (replay) return replay;
    const current = await lockArtifact(store, lease.userId, row.id, 'update');
    if (!current || current.state !== 'pending' || current.revision !== row.revision || artifactRef(current).revision !== artifactRef(row).revision
      || current.expiresAt.getTime() <= Date.now()) throw new MemoryModuleError('artifact_upload_intent_closed', 409, 'Derived upload closed before activation');
    const [usage]: Array<{ usedBytes: number }> = await store.select({ usedBytes: userFileUsage.usedBytes }).from(userFileUsage).where(eq(userFileUsage.userId, lease.userId)).for('update');
    if (!usage || usage.usedBytes + current.sizeBytes > ARTIFACT_QUOTA_BYTES) throw new MemoryModuleError('artifact_quota_exceeded', 413, 'Derived file exceeds current quota');
    await store.update(userFileUsage).set({ usedBytes: usage.usedBytes + current.sizeBytes, updatedAt: new Date() }).where(eq(userFileUsage.userId, lease.userId));
    const [active]: ArtifactRow[] = await store.update(memoryArtifactManifests).set({ state: 'active', revision: current.revision + 1, quotaCharged: true, updatedAt: new Date() }).where(eq(memoryArtifactManifests.id, current.id)).returning();
    if (!active) throw new Error('Derived artifact activation was not persisted');
    const result = await persistArtifactCommand(store, { userId: lease.userId, commandId, requestHash, action: 'work_file.derive', fromRevision: current.revision, row: active });
    await append({ workshopId: lease.workshopId, runId: lease.runId, type: 'file_derivation_recorded', title: 'Bound document conversion saved',
      metadata: { artifactId: active.id, revision: active.revision, bindingId: input.source.id, sourceRevision: input.source.revision, receiptId: result.receipt.id } });
    return result;
  });
}
export async function saveWorkDerivedFile(input: Parameters<typeof saveDerived>[0]) {
  try { return await saveDerived(input); }
  catch (error) {
    if (error instanceof MemoryModuleError || error instanceof ExecutionLeaseError || error instanceof MemoryWriteBusy) throw error;
    throw new MemoryModuleError('file_derivation_unavailable', 503, 'The source, derived object or its atomic activation receipt could not be verified');
  }
}
