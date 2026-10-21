import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { workshops, workshopSources } from '@/lib/db/schema';
import { memoryFileBindings, memoryFileBindingCommands } from '@/lib/db/schema.pg';
import { withArtifactOwner, lockArtifact, artifactRef, artifactRequestHash } from '../adapters/postgres/artifacts';
import { MemoryModuleError } from '../kernel/errors';
import { bindWorkFileInput, revokeWorkFileInput, parseFileInput } from './contracts';
import type { FileBindingRow } from '../adapters/postgres/file-bindings';
import type { DrizzleDB } from '@/lib/db/types';

const conflict = () => new MemoryModuleError('file_binding_conflict', 409, 'The binding or file version changed; refresh and review the current source');
function summary(row: FileBindingRow) {
  return { id: row.id, workshopId: row.workshopId, sourceId: row.sourceId, artifactId: row.artifactId,
    artifactRevision: row.artifactRevision, revision: row.revision, state: row.state, permissions: row.permissions,
    expiresAt: row.expiresAt.toISOString() };
}
async function replay(store: DrizzleDB, userId: string, commandId: string, requestHash: string) {
  const [row]: Array<typeof memoryFileBindingCommands.$inferSelect> = await store.select().from(memoryFileBindingCommands)
    .where(and(eq(memoryFileBindingCommands.userId, userId), eq(memoryFileBindingCommands.commandId, commandId)));
  if (!row) return null;
  if (row.requestHash !== requestHash) throw conflict();
  return { status: 'recorded' as const, replayed: true, resultSemantics: 'command_result_at_revision' as const, binding: row.result,
    receipt: { id: row.id, commandId: row.commandId, fromRevision: row.fromRevision, toRevision: row.toRevision } };
}
async function receipt(store: DrizzleDB, userId: string, commandId: string, requestHash: string, fromRevision: number, row: FileBindingRow) {
  const result = summary(row);
  const [saved]: Array<typeof memoryFileBindingCommands.$inferSelect> = await store.insert(memoryFileBindingCommands).values({ id: randomUUID(), userId,
    commandId, requestHash, bindingId: row.id, fromRevision, toRevision: row.revision, result }).returning();
  if (!saved) throw new Error('File binding receipt was not persisted');
  return { status: 'recorded' as const, replayed: false, resultSemantics: 'command_result_at_revision' as const, binding: result,
    receipt: { id: saved.id, commandId, fromRevision, toRevision: row.revision } };
}
export async function bindWorkFile(userId: string, value: unknown) {
  const command = parseFileInput(bindWorkFileInput, value), requestHash = artifactRequestHash(command);
  return withArtifactOwner(userId, 'update', store => bindWorkFileInTransaction(store, userId, command, requestHash));
}
/** Caller holds the owner UPDATE lock in the same database transaction. */
export async function bindWorkFileInTransaction(store: DrizzleDB, userId: string,
  command: ReturnType<typeof bindWorkFileInput.parse>, requestHash = artifactRequestHash(command)) {
    const prior = await replay(store, userId, command.commandId, requestHash); if (prior) return prior;
    const [work] = await store.select({ id: workshops.id }).from(workshops).where(and(eq(workshops.id, command.workshopId), eq(workshops.userId, userId))).for('share');
    if (!work) throw new MemoryModuleError('file_binding_not_found', 404, 'Enabled owned Work file source unavailable');
    const [source] = await store.select().from(workshopSources).where(and(eq(workshopSources.id, command.sourceId), eq(workshopSources.workshopId, command.workshopId))).for('update');
    if (!source || source.type !== 'file' || !source.enabled) throw new MemoryModuleError('file_binding_not_found', 404, 'Enabled owned Work file source unavailable');
    const artifact = await lockArtifact(store, userId, command.artifactId, 'share');
    if (!artifact || artifact.state !== 'active' || artifactRef(artifact).revision !== command.expectedArtifactRevision) throw conflict();
    const [previous]: FileBindingRow[] = await store.select().from(memoryFileBindings).where(and(eq(memoryFileBindings.userId, userId), eq(memoryFileBindings.sourceId, command.sourceId))).for('update');
    if ((previous?.revision ?? 0) !== command.expectedBindingRevision || previous && previous.workshopId !== command.workshopId) throw conflict();
    const now = new Date(), expiresAt = new Date(command.expiresAt);
    if (expiresAt.getTime() <= now.getTime()) throw new MemoryModuleError('invalid_memory_request', 400, 'File binding expiry must be in the future');
    await store.update(workshopSources).set({ uri: `artifact:${artifact.id}` }).where(eq(workshopSources.id, source.id));
    const values = { userId, workshopId: work.id, sourceId: source.id, artifactId: artifact.id, artifactRevision: command.expectedArtifactRevision,
      revision: (previous?.revision ?? 0) + 1, state: 'active' as const, permissions: command.permissions, expiresAt, updatedAt: now };
    const [saved]: FileBindingRow[] = previous
      ? await store.update(memoryFileBindings).set(values).where(eq(memoryFileBindings.id, previous.id)).returning()
      : await store.insert(memoryFileBindings).values({ id: randomUUID(), ...values }).returning();
    if (!saved) throw new Error('File binding was not persisted');
    return receipt(store, userId, command.commandId, requestHash, previous?.revision ?? 0, saved);
}
export async function revokeWorkFile(userId: string, value: unknown) {
  const command = parseFileInput(revokeWorkFileInput, value), requestHash = artifactRequestHash(command);
  return withArtifactOwner(userId, 'update', async store => {
    const prior = await replay(store, userId, command.commandId, requestHash); if (prior) return prior;
    const [previous]: FileBindingRow[] = await store.select().from(memoryFileBindings).where(and(eq(memoryFileBindings.userId, userId), eq(memoryFileBindings.id, command.bindingId))).for('update');
    if (!previous) throw new MemoryModuleError('file_binding_not_found', 404, 'File binding unavailable');
    if (previous.revision !== command.expectedBindingRevision) throw conflict();
    const [saved]: FileBindingRow[] = await store.update(memoryFileBindings).set({ state: 'revoked', revision: previous.revision + 1, updatedAt: new Date() })
      .where(eq(memoryFileBindings.id, previous.id)).returning();
    if (!saved) throw new Error('File binding revocation was not persisted');
    return receipt(store, userId, command.commandId, requestHash, previous.revision, saved);
  });
}
export async function listWorkFileBindings(userId: string, workshopId: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(workshopId)) throw new MemoryModuleError('invalid_memory_request', 400, 'Invalid Work reference');
  return withArtifactOwner(userId, 'share', async store => {
    const [work] = await store.select({ id: workshops.id }).from(workshops).where(and(eq(workshops.id, workshopId), eq(workshops.userId, userId))).for('share');
    if (!work) throw new MemoryModuleError('file_binding_not_found', 404, 'Work unavailable');
    const rows: FileBindingRow[] = await store.select().from(memoryFileBindings).where(and(eq(memoryFileBindings.userId, userId), eq(memoryFileBindings.workshopId, workshopId))).orderBy(memoryFileBindings.id).limit(101);
    return { status: 'observed' as const, bindings: rows.slice(0, 100).map(summary), hasMore: rows.length > 100, complete: false as const };
  });
}
