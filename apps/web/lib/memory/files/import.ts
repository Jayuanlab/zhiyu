import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { chat } from '@/lib/db/schema';
import { memoryFileImports } from '@/lib/db/schema.pg';
import { getTaskSessionDir } from '@/lib/files/workspace/sessions';
import { getAppDir } from '@/lib/env/config/constants';
import { getMimeTypeFromExtension } from '@/lib/files/config';
import { withArtifactOwner, artifactRef, lockArtifact, artifactRequestHash } from '../adapters/postgres/artifacts';
import { saveUploadedArtifact } from '../artifacts/service';
import { MAX_ARTIFACT_BYTES } from '../artifacts/contracts';
import { MemoryModuleError } from '../kernel/errors';
import { importWorkspaceFileInput, parseFileInput } from './contracts';
import { readLocalFileSnapshot } from './local-snapshot';
import type { DrizzleDB } from '@/lib/db/types';

type ImportRow = typeof memoryFileImports.$inferSelect;
const conflict = () => new MemoryModuleError('workspace_import_conflict', 409, 'This import command is already bound to another task, locator or file snapshot');
async function ownedChat(store: DrizzleDB, userId: string, taskId: string) {
  const [owned] = await store.select({ id: chat.id }).from(chat).where(and(eq(chat.id, taskId), eq(chat.userId, userId))).for('share');
  if (!owned) throw new MemoryModuleError('workspace_file_not_found', 404, 'Owned task file unavailable');
}
function result(row: ImportRow, replayed: boolean) {
  return { status: 'recorded' as const, replayed, resultSemantics: 'imported_snapshot_at_revision' as const,
    artifactId: row.artifactId!, artifactRevision: row.artifactRevision!, receiptId: row.id,
    origin: { taskId: row.taskChatId, path: row.relativePath, sha256: row.sha256, sizeBytes: row.sizeBytes,
      semantics: 'owner_confirmed_imported_snapshot' as const, originalFileCurrent: false as const } };
}
export async function importWorkspaceFile(userId: string, value: unknown) {
  const command = parseFileInput(importWorkspaceFileInput, value);
  const normalizedPath = command.path.replace(/\\/g, '/');
  const requestHash = artifactRequestHash({ ...command, path: normalizedPath });
  const previous = await withArtifactOwner(userId, 'share', async store => {
    await ownedChat(store, userId, command.taskId);
    const [prior]: ImportRow[] = await store.select().from(memoryFileImports).where(and(eq(memoryFileImports.userId, userId), eq(memoryFileImports.commandId, command.commandId)));
    if (prior && prior.requestHash !== requestHash) throw conflict();
    return prior;
  });
  if (previous?.state === 'recorded') return result(previous, true);
  const snapshot = await readLocalFileSnapshot(getTaskSessionDir(command.taskId), command.path, MAX_ARTIFACT_BYTES, getAppDir());
  if (command.expectedHash && command.expectedHash !== snapshot.sha256) throw new MemoryModuleError('workspace_file_changed', 409, 'The selected file changed; review and import the fresh snapshot');
  const pending = await withArtifactOwner(userId, 'update', async store => {
    await ownedChat(store, userId, command.taskId);
    const [prior]: ImportRow[] = await store.select().from(memoryFileImports).where(and(eq(memoryFileImports.userId, userId), eq(memoryFileImports.commandId, command.commandId))).for('update');
    if (prior) { if (prior.requestHash !== requestHash || prior.sha256 !== snapshot.sha256) throw conflict(); return prior; }
    const [saved]: ImportRow[] = await store.insert(memoryFileImports).values({ id: randomUUID(), userId, commandId: command.commandId, requestHash,
      taskChatId: command.taskId, relativePath: snapshot.relativePath, sha256: snapshot.sha256, sizeBytes: snapshot.bytes.byteLength, fileStat: snapshot.stat, state: 'pending' }).returning();
    if (!saved) throw new Error('Workspace import intent was not persisted'); return saved;
  });
  if (pending.state === 'recorded') return result(pending, true);
  const contentType = getMimeTypeFromExtension(extname(snapshot.name)) ?? (extname(snapshot.name).toLowerCase() === '.csv' ? 'text/csv' : undefined);
  if (!contentType) throw new MemoryModuleError('artifact_media_unsupported', 415, 'Import this file through a supported managed artifact format');
  const uploaded = await saveUploadedArtifact(userId, { commandId: `workspace-import:${pending.id}`, name: snapshot.name, contentType, data: snapshot.bytes, saveRecord: false });
  return withArtifactOwner(userId, 'update', async store => {
    await ownedChat(store, userId, command.taskId);
    const [current]: ImportRow[] = await store.select().from(memoryFileImports).where(and(eq(memoryFileImports.userId, userId), eq(memoryFileImports.id, pending.id))).for('update');
    const artifact = await lockArtifact(store, userId, uploaded.manifest.id, 'share');
    if (!current || current.sha256 !== snapshot.sha256 || !artifact || artifact.state !== 'active' || artifact.sha256 !== snapshot.sha256 || artifactRef(artifact).revision !== uploaded.ref.revision) throw conflict();
    const [saved]: ImportRow[] = await store.update(memoryFileImports).set({ state: 'recorded', artifactId: artifact.id, artifactRevision: uploaded.ref.revision, updatedAt: new Date() }).where(eq(memoryFileImports.id, current.id)).returning();
    if (!saved) throw new Error('Workspace import receipt was not persisted'); return result(saved, false);
  });
}
