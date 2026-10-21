import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { workshops, workshopSources, workshopEvents } from '@/lib/db/schema';
import { memoryWorkFileUploadIntents } from '@/lib/db/schema.pg';
import type { DrizzleDB } from '@/lib/db/types';
import { artifactRequestHash, withArtifactOwner } from '../adapters/postgres/artifacts';
import { saveUploadedArtifact } from '../artifacts/service';
import { MAX_ARTIFACT_BYTES } from '../artifacts/contracts';
import { artifactDigest, verifyArtifactMedia } from '../artifacts/policy';
import { MemoryModuleError } from '../kernel/errors';
import { parseFileInput } from './contracts';
import { bindWorkFileInTransaction } from './commands';

const inputSchema = z.object({ commandId: z.string().trim().min(1).max(200), workshopId: z.string().uuid(),
  name: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value)), contentType: z.string().min(1).max(200),
  expiresAt: z.string().datetime({ offset: true }) }).strict();
type Intent = typeof memoryWorkFileUploadIntents.$inferSelect;
const conflict = () => new MemoryModuleError('work_file_upload_conflict', 409, 'This upload command is bound to different file input or authorization; retry the original operation');
async function workForUpload(store: DrizzleDB, userId: string, workshopId: string) {
  const [work] = await store.select().from(workshops).where(and(eq(workshops.id, workshopId), eq(workshops.userId, userId))).for('update');
  if (!work) throw new MemoryModuleError('file_binding_not_found', 404, 'Work unavailable');
  if (work.modelConfig?.role !== 'document_markdown_cleaner') throw new MemoryModuleError('work_file_upload_denied', 403, 'This Work cannot accept document uploads');
  return work;
}
/** Explicit owner upload creates a private immutable snapshot and a bounded Work binding.
 * Object upload is outside the final database transaction; a durable intent pins
 * all input before IO, so retries cannot change scope, bytes, TTL or create a second source.
 */
export async function uploadWorkFile(userId: string, value: unknown, bytes: Uint8Array) {
  const command = parseFileInput(inputSchema, value);
  if (!bytes.byteLength || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new MemoryModuleError('artifact_request_too_large', 413, 'Choose a nonempty file within the managed upload limit');
  verifyArtifactMedia(bytes, command.contentType);
  const requestHash = artifactRequestHash({ ...command, sha256: artifactDigest(bytes), sizeBytes: bytes.byteLength, permissions: ['read', 'convert'] });
  const intent = await withArtifactOwner(userId, 'update', async store => {
    await workForUpload(store, userId, command.workshopId);
    const [prior]: Intent[] = await store.select().from(memoryWorkFileUploadIntents).where(and(eq(memoryWorkFileUploadIntents.userId, userId), eq(memoryWorkFileUploadIntents.commandId, command.commandId))).for('update');
    if (prior) { if (prior.requestHash !== requestHash) throw conflict(); return prior; }
    if (Date.parse(command.expiresAt) <= Date.now()) throw new MemoryModuleError('invalid_memory_request', 400, 'File binding expiry must be in the future');
    const [{ value: countValue }] = await store.select({ value: count() }).from(workshopSources).where(eq(workshopSources.workshopId, command.workshopId));
    if (Number(countValue) >= 1000) throw new MemoryModuleError('work_source_limit', 409, 'This Work already has 1,000 sources');
    const [saved]: Intent[] = await store.insert(memoryWorkFileUploadIntents).values({ id: randomUUID(), userId, commandId: command.commandId,
      requestHash, workshopId: command.workshopId, state: 'pending' }).returning();
    if (!saved) throw new Error('Upload intent not persisted'); return saved;
  });
  if (intent.state === 'recorded') return { ...intent.result, replayed: true, resultSemantics: 'command_result_at_revision' as const };
  const uploaded = await saveUploadedArtifact(userId, { commandId: `work-file-upload:${intent.id}`, name: command.name,
    contentType: command.contentType, data: bytes, saveRecord: false });
  return withArtifactOwner(userId, 'update', async store => {
    await workForUpload(store, userId, command.workshopId);
    const [current]: Intent[] = await store.select().from(memoryWorkFileUploadIntents).where(and(eq(memoryWorkFileUploadIntents.id, intent.id), eq(memoryWorkFileUploadIntents.userId, userId))).for('update');
    if (!current || current.requestHash !== requestHash) throw conflict();
    if (current.state === 'recorded') return { ...current.result, replayed: true, resultSemantics: 'command_result_at_revision' as const };
    const [{ value: countValue }] = await store.select({ value: count() }).from(workshopSources).where(eq(workshopSources.workshopId, command.workshopId));
    if (Number(countValue) >= 1000) throw new MemoryModuleError('work_source_limit', 409, 'This Work already has 1,000 sources');
    const [source] = await store.insert(workshopSources).values({ id: randomUUID(), workshopId: command.workshopId, type: 'file', name: command.name,
      uri: `artifact:${uploaded.manifest.id}`, content: null, enabled: true,
      config: { representation: 'owner_uploaded_immutable_snapshot', artifactId: uploaded.manifest.id, uploadIntentId: intent.id } }).returning();
    if (!source) throw new Error('Upload source not persisted');
    const bindingResult = await bindWorkFileInTransaction(store, userId, { commandId: `work-file-bind:${intent.id}`, workshopId: command.workshopId,
      sourceId: source.id, artifactId: uploaded.manifest.id, expectedArtifactRevision: uploaded.ref.revision, expectedBindingRevision: 0,
      permissions: ['read', 'convert'], expiresAt: command.expiresAt });
    // This is a durable owner authorization event, not a claim of model consumption.
    await store.execute(sql`INSERT INTO workshop_event_counters(workshop_id,last_seq) SELECT ${command.workshopId}::uuid,COALESCE((SELECT max(seq) FROM workshop_events WHERE workshop_id=${command.workshopId}::uuid),0) ON CONFLICT(workshop_id) DO NOTHING`);
    const seq = await store.execute(sql`UPDATE workshop_event_counters SET last_seq=last_seq+1 WHERE workshop_id=${command.workshopId}::uuid RETURNING last_seq`);
    if (!seq[0]) throw new Error('Upload event sequence unavailable');
    const [event] = await store.insert(workshopEvents).values({ id: randomUUID(), workshopId: command.workshopId, seq: Number(seq[0].last_seq), type: 'source_added',
      title: '已上传并限期授权文件快照', metadata: { sourceId: source.id, bindingId: bindingResult.binding.id, bindingRevision: 1,
        artifactId: uploaded.manifest.id, permissions: ['read', 'convert'], expiresAt: command.expiresAt, authority: 'owner_command', modelConsumption: false } }).returning();
    if (!event) throw new Error('Upload event not persisted');
    const result = { source: { id: source.id, workshopId: source.workshopId, type: source.type, name: source.name, uri: source.uri, enabled: source.enabled },
      binding: bindingResult.binding, receipt: bindingResult.receipt, artifact: { id: uploaded.manifest.id, revision: uploaded.ref.revision }, status: 'recorded' };
    const [saved] = await store.update(memoryWorkFileUploadIntents).set({ sourceId: source.id, state: 'recorded', result }).where(eq(memoryWorkFileUploadIntents.id, intent.id)).returning();
    if (!saved) throw new Error('Upload result not persisted');
    return { ...result, replayed: false, resultSemantics: 'command_result_at_revision' as const };
  });
}
