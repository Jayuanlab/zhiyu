import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DrizzleDB } from '@/lib/db/types';
const state = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>[]>(), failReceipt: false, objectWrites: 0 }));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: () => undefined }));
vi.mock('@/lib/db/client', () => ({ db: { transaction: async (run: (store: DrizzleDB) => Promise<unknown>) => {
  const before = structuredClone(state.rows); try { return await run(store()); } catch (error) { state.rows = before; throw error; }
} } }));
vi.mock('@/lib/memory/artifacts/service', () => ({ saveUploadedArtifact: vi.fn(async (_user: string, input: { commandId: string; data: Uint8Array }) => {
  state.objectWrites++; const row = state.rows.get('memory_artifact_manifests')![0] as unknown as ArtifactRow;
  return { manifest: { id: row.id }, ref: artifactRef(row) };
}) }));
const dialect = new PgDialect();
function store(): DrizzleDB {
  const match = (table: Parameters<typeof getTableName>[0], condition: Parameters<PgDialect['sqlToQuery']>[0], row: Record<string, unknown>) => {
    const name = getTableName(table), query = dialect.sqlToQuery(condition);
    return Object.entries({ id: 'id', user_id: 'userId', workshop_id: 'workshopId', source_id: 'sourceId', command_id: 'commandId' }).every(([column, key]) => {
      const found = query.sql.match(new RegExp(`"${name}"\\."${column}" = \\$(\\d+)`)); return !found || row[key] === query.params[Number(found[1]) - 1];
    });
  };
  return {
    select: (projection?: Record<string, unknown>) => ({ from: (table: Parameters<typeof getTableName>[0]) => {
      let rows = state.rows.get(getTableName(table)) ?? [];
      const values = () => projection && 'value' in projection ? [{ value: rows.length }] : structuredClone(rows);
      const chain = { where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => { rows = rows.filter(row => match(table, condition, row)); return chain; },
        for: async () => values(), then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(values()).then(resolve) }; return chain;
    } }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({ values: (value: Record<string, unknown>) => ({ returning: async () => {
      const name = getTableName(table); if (state.failReceipt && name === 'memory_file_binding_commands') throw Error('PRIVATE_RECEIPT_FAIL');
      const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...value }; const rows = state.rows.get(name) ?? []; rows.push(row); state.rows.set(name, rows); return [structuredClone(row)];
    } }) }),
    update: (table: Parameters<typeof getTableName>[0]) => ({ set: (value: Record<string, unknown>) => ({ where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const rows = (state.rows.get(getTableName(table)) ?? []).filter(row => match(table, condition, row)); for (const row of rows) Object.assign(row, value);
      return { returning: async () => structuredClone(rows), then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve) };
    } }) }), execute: async () => [{ last_seq: 1 }],
  } as unknown as DrizzleDB;
}
import { uploadWorkFile } from '@/lib/memory/files/upload';
import { artifactRef, type ArtifactRow } from '@/lib/memory/adapters/postgres/artifacts';
import { saveUploadedArtifact } from '@/lib/memory/artifacts/service';
const userId = randomUUID(), workId = randomUUID(), artifactId = randomUUID(), command = { workshopId: workId, commandId: randomUUID(), name: 'text.md', contentType: 'text/markdown', expiresAt: '2027-01-01T00:00:00.000Z' };
beforeEach(() => {
  state.rows = new Map([['User', [{ id: userId }]], ['workshops', [{ id: workId, userId, modelConfig: { role: 'document_markdown_cleaner' } }]],
    ['memory_artifact_manifests', [{ id: artifactId, userId, state: 'active', revision: 3, sha256: 'a'.repeat(64), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) }]]]);
  state.failReceipt = false; state.objectWrites = 0; vi.clearAllMocks();
});
describe('actual managed Work upload orchestration', () => {
  it('pins full upload input and atomically creates one source, binding, event and receipt; replay does not upload again', async () => {
    const bytes = new TextEncoder().encode('# synthetic'); const first = await uploadWorkFile(userId, command, bytes);
    expect(first.replayed).toBe(false); expect(state.rows.get('workshop_sources')).toHaveLength(1);
    expect(state.rows.get('memory_file_bindings')![0]).toMatchObject({ state: 'active', permissions: ['read', 'convert'], revision: 1 });
    expect(state.rows.get('workshop_events')).toHaveLength(1); expect(state.rows.get('memory_file_binding_commands')).toHaveLength(1);
    expect((await uploadWorkFile(userId, command, bytes)).replayed).toBe(true); expect(saveUploadedArtifact).toHaveBeenCalledTimes(1);
    for (const changed of [{ ...command, expiresAt: '2027-02-01T00:00:00Z' }, { ...command, name: 'other.md' }]) await expect(uploadWorkFile(userId, changed, bytes)).rejects.toMatchObject({ status: 409 });
    await expect(uploadWorkFile(userId, command, new TextEncoder().encode('changed'))).rejects.toMatchObject({ status: 409 });
    expect(state.rows.get('workshop_sources')).toHaveLength(1);
  });
  it('audit failure rolls back source/binding/event but preserves the pinned pending intent for original retry', async () => {
    const bytes = new TextEncoder().encode('# synthetic'); state.failReceipt = true;
    await expect(uploadWorkFile(userId, command, bytes)).rejects.toThrow('PRIVATE_RECEIPT_FAIL');
    expect(state.rows.get('workshop_sources') ?? []).toHaveLength(0); expect(state.rows.get('memory_file_bindings') ?? []).toHaveLength(0);
    expect(state.rows.get('workshop_events') ?? []).toHaveLength(0); expect(state.rows.get('memory_work_file_upload_intents')![0].state).toBe('pending');
    await expect(uploadWorkFile(userId, { ...command, expiresAt: '2027-02-01T00:00:00Z' }, bytes)).rejects.toMatchObject({ status: 409 });
    state.failReceipt = false; await uploadWorkFile(userId, command, bytes); expect(state.rows.get('workshop_sources')).toHaveLength(1);
  });
  it('rejects foreign Work and roles before artifact IO', async () => {
    const bytes = new TextEncoder().encode('# synthetic');
    await expect(uploadWorkFile(userId, { ...command, workshopId: randomUUID() }, bytes)).rejects.toMatchObject({ status: 404 });
    state.rows.get('workshops')![0].modelConfig = { role: 'other' };
    await expect(uploadWorkFile(userId, command, bytes)).rejects.toMatchObject({ status: 403 }); expect(saveUploadedArtifact).not.toHaveBeenCalled();
  });
});
