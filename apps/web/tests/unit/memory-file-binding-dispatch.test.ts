import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DrizzleDB } from '@/lib/db/types';
const fixture = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>[]>(), auditFails: false,
  lease: undefined as undefined | { userId: string; workshopId: string; runId: string; workerId: string; token: number } }));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: () => fixture.lease }));
vi.mock('@/lib/memory/revision/transaction', () => ({ withMemoryRecordWrite: async (_owner: string, _kind: string, run: (store: DrizzleDB) => Promise<{ result: unknown }>) => (await run(store())).result }));
vi.mock('@/lib/db/client', () => ({ db: { transaction: async (run: (store: DrizzleDB) => Promise<unknown>) => transaction(() => run(store())) },
  withDatabaseTransaction: async (run: () => Promise<unknown>) => transaction(run) }));
vi.mock('@/lib/memory/context/finalize', () => ({ finalizeContextPack: vi.fn() }));
const dialect = new PgDialect();
async function transaction<T>(run: () => Promise<T>) {
  const snapshot = structuredClone(fixture.rows);
  try { return await run(); } catch (error) { fixture.rows = snapshot; throw error; }
}
function store(): DrizzleDB {
  return {
    select: () => ({ from: (table: Parameters<typeof getTableName>[0]) => {
      const name = getTableName(table); let rows = structuredClone(fixture.rows.get(name) ?? []);
      const chain = { where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
        const query = dialect.sqlToQuery(condition);
        for (const [column, key] of Object.entries({ id: 'id', user_id: 'userId', userId: 'userId', workshop_id: 'workshopId', source_id: 'sourceId' })) {
          const match = query.sql.match(new RegExp(`"${name}"\\."${column}" = \\$(\\d+)`));
          if (match) rows = rows.filter(row => row[key] === query.params[Number(match[1]) - 1]);
        }
        return chain;
      }, for: async () => rows, orderBy: () => chain, limit: () => chain };
      return chain;
    } }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({ values: (value: Record<string, unknown>) => ({ returning: async () => {
      const name = getTableName(table); if (name === 'brain_context_logs' && fixture.auditFails) throw Error('PRIVATE_SQL_AUDIT_FAILURE');
      const row = { id: randomUUID(), createdAt: new Date(), ...value }; const rows = fixture.rows.get(name) ?? []; rows.push(row); fixture.rows.set(name, rows); return [row];
    } }) }),
  } as DrizzleDB;
}
import { artifactRef, type ArtifactRow } from '@/lib/memory/adapters/postgres/artifacts';
import { privateArtifactStore } from '@/lib/memory/artifacts/object-store';
import { artifactDigest } from '@/lib/memory/artifacts/policy';
import { readWorkFile } from '@/lib/memory/files/read';
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent } from '@/lib/memory/context/dispatch';
const owner = '11111111-1111-4111-8111-111111111111', work = '22222222-2222-4222-8222-222222222222', source = '33333333-3333-4333-8333-333333333333';
const artifactId = '44444444-4444-4444-8444-444444444444', bindingId = '55555555-5555-4555-8555-555555555555';
const bytes = new TextEncoder().encode('PRIVATE_BOUND_TEXT \u6d4b\u8bd5\ud83d\ude80');
const roots: string[] = []; let objectPath: string; const originalRoot = process.env.MEMORY_ARTIFACT_STORAGE_ROOT;
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhiyu-t7-bound-')); roots.push(root); process.env.MEMORY_ARTIFACT_STORAGE_ROOT = root;
  const now = new Date('2026-10-20T00:00:00Z'), key = `${owner}/${artifactId}/${randomUUID()}.bin`;
  const manifest: ArtifactRow = { id: artifactId, userId: owner, commandId: 'fixture', requestHash: 'a'.repeat(64), revision: 2,
    state: 'active', provider: 'private_local', objectKey: key, name: 'bound.txt', contentType: 'text/plain', sizeBytes: bytes.byteLength,
    sha256: artifactDigest(bytes), expiresAt: new Date('2099-01-01T00:00:00Z'), quotaCharged: true, cleanupAttempts: 0,
    lastError: null, userFileId: null, metadata: {}, createdAt: now, updatedAt: now };
  fixture.rows = new Map([['User', [{ id: owner }]], ['workshops', [{ id: work, userId: owner, modelConfig: { allowedTools: ['Read'] }, boundaryPolicy: {} }]],
    ['workshop_sources', [{ id: source, workshopId: work, type: 'file', uri: `artifact:${artifactId}`, enabled: true }]],
    ['memory_artifact_manifests', [manifest]], ['memory_file_bindings', [{ id: bindingId, userId: owner, workshopId: work, sourceId: source, artifactId,
      artifactRevision: artifactRef(manifest).revision, revision: 1, state: 'active', permissions: ['read'], expiresAt: new Date('2099-01-01T00:00:00Z'), createdAt: now, updatedAt: now }]]]);
  fixture.auditFails = false; fixture.lease = { userId: owner, workshopId: work, runId: randomUUID(), workerId: 'synthetic', token: 1 };
  await privateArtifactStore().putImmutable(key, bytes); objectPath = join(root, ...key.split('/'));
});
afterEach(async () => {
  if (originalRoot === undefined) delete process.env.MEMORY_ARTIFACT_STORAGE_ROOT; else process.env.MEMORY_ARTIFACT_STORAGE_ROOT = originalRoot;
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('zhiyu-t7-bound-')) throw Error('Unsafe synthetic cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
describe('registered Work file read and actual physical dispatch', () => {
  it.each(['object', 'binding', 'denied', 'expiry', 'expiry-extension'])('delivers an unseen exact source once and blocks later %s changes', async change => {
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
      const read = await readWorkFile({ sourceId: source }); expect(read.content).toContain('PRIVATE_BOUND_TEXT');
      await assertMemoryDispatchCurrent(); const count = fixture.rows.get('brain_context_logs')?.length;
      if (change === 'object') await writeFile(objectPath, 'CORRUPTED_PHYSICAL_OBJECT');
      if (change === 'binding') fixture.rows.get('memory_file_bindings')![0].state = 'revoked';
      if (change === 'denied') fixture.rows.get('workshops')![0].modelConfig = { allowedTools: ['Read'], disallowedTools: ['mcp__workshop-tools__READ'] };
      if (change === 'expiry') fixture.rows.get('memory_file_bindings')![0].expiresAt = new Date(0);
      if (change === 'expiry-extension') fixture.rows.get('memory_file_bindings')![0].expiresAt = new Date('2099-02-01T00:00:00Z');
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: 'memory_dispatch_context_unavailable' });
      expect(fixture.rows.get('brain_context_logs')?.length).toBe(count);
      expect(JSON.stringify(fixture.rows.get('brain_context_logs'))).not.toContain('PRIVATE_BOUND_TEXT');
    });
  });
  it('requires the actual matching lease and binding even if the source locator exists', async () => {
    fixture.lease!.workshopId = randomUUID();
    await expect(readWorkFile({ sourceId: source })).rejects.toMatchObject({ code: 'work_file_unavailable' });
    expect(fixture.rows.get('memory_artifact_read_receipts')).toBeUndefined();
  });
  it('rolls back the actual artifact read receipt if exact admission audit fails and keeps internal details private', async () => {
    fixture.auditFails = true;
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
      await expect(readWorkFile({ sourceId: source })).rejects.toMatchObject({ code: 'file_source_unavailable', status: 503 });
      expect(fixture.rows.get('memory_artifact_read_receipts')).toBeUndefined();
    });
  });
});
