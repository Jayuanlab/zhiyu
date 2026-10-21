import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Condition = { op: 'eq'; column: string; value: unknown } | { op: 'and'; conditions: Condition[] };
const fixture = vi.hoisted(() => ({
  authenticated: true, userId: '11111111-1111-4111-8111-111111111111', lease: false, calls: 0, nextId: 1,
  failTable: '', failure: null as Error | null,
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  tables: { user: { name: 'users', id: 'users.id' },
    observations: { name: 'observations', id: 'observations.id', userId: 'observations.userId', sourceType: 'observations.sourceType', sourceId: 'observations.sourceId', observedAt: 'observations.observedAt' },
    operations: { name: 'operations', id: 'operations.id', userId: 'operations.userId', commandId: 'operations.commandId' },
    reads: { name: 'reads', id: 'reads.id', userId: 'reads.userId' } },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/app/(auth)/auth', () => ({ auth: async () => fixture.authenticated ? { user: { id: fixture.userId } } : null }));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: () => fixture.lease ? { userId: fixture.userId } : undefined }));
vi.mock('@/lib/memory/kernel/transaction', () => ({ withObservationTransaction: vi.fn(), appendObservationExecutionAudit: vi.fn() }));
// T1 exercises only observation capabilities; state receipts have their own PG fixture.
vi.mock('@/lib/memory/records/current-state', () => ({ explainCurrentStateRead: async () => ({ status: 'not_found' }) }));
vi.mock('@/lib/memory/revision/owner-commands', () => ({ explainRevisionCommand: async () => ({ status: 'not_found' }) }));
vi.mock('@/lib/memory/adapters/postgres/query-receipts', () => ({ explainQueryRead: async () => ({ status: 'not_found' }) }));
vi.mock('@/lib/memory/artifacts/service', () => ({ explainArtifactReceipt: async () => ({ status: 'not_found' }) }));
vi.mock('@/lib/memory/sources/inspection', () => ({ explainMemorySourceReceipt: async () => ({ status: 'not_found' }) }));
vi.mock('@/lib/db/schema', () => ({ user: fixture.tables.user, brainObservations: fixture.tables.observations }));
vi.mock('@/lib/memory/adapters/postgres/receipt-schema', () => ({ memoryOperationReceipts: fixture.tables.operations, memoryReadReceipts: fixture.tables.reads }));
vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => ({ op: 'eq', column, value }),
  and: (...conditions: Condition[]) => ({ op: 'and', conditions }),
  desc: (column: unknown) => column, inArray: vi.fn(), sql: vi.fn(),
}));
vi.mock('@/lib/db/client', () => {
  const match = (row: Row, condition: Condition): boolean => condition.op === 'and'
    ? condition.conditions.every(item => match(row, item)) : row[condition.column.split('.').at(-1)!] === condition.value;
  function check(table: { name: string }) {
    fixture.calls += 1;
    if (fixture.failure && (!fixture.failTable || fixture.failTable === table.name)) throw fixture.failure;
  }
  const store = {
    execute: async () => { fixture.calls += 1; return []; },
    select: () => ({ from: (table: { name: string }) => ({ where: (condition: Condition) => {
      check(table);
      const result = (fixture.rows[table.name] ?? []).filter(row => match(row, condition));
      return { limit: async (count: number) => result.slice(0, count), for: async () => result };
    } }) }),
    insert: (table: { name: string }) => ({ values: (value: Row) => {
      const returning = async () => {
        check(table);
        const rows = fixture.rows[table.name] ??= [];
        if (table.name === 'observations' && rows.some(row => row.userId === value.userId
          && row.sourceType === value.sourceType && row.sourceId === value.sourceId)) return [];
        const row = { ...structuredClone(value), id: value.id ?? `00000000-0000-4000-8000-${String(fixture.nextId++).padStart(12, '0')}`,
          createdAt: new Date('2026-10-20T00:00:00Z') };
        rows.push(row); return [row];
      };
      return { returning, onConflictDoNothing: () => ({ returning }) };
    } }),
  };
  return { db: { ...store, transaction: async <T>(work: (database: typeof store) => Promise<T>) => {
    const previous = structuredClone(fixture.rows);
    try { return await work(store); } catch (error) { fixture.rows = previous; throw error; }
  } } };
});
// The routes exercise the real client, strict parsers, row mappers and PostgreSQL observation adapter.
vi.mock('@/lib/memory', async () => ({ ...await import('@/lib/memory/client') }));

import { POST as commandPost } from '@/app/api/memory/commands/route';
import { POST as readPost } from '@/app/api/memory/read/route';
import { GET as receiptGet } from '@/app/api/memory/receipts/[id]/route';

const otherOwner = '22222222-2222-4222-8222-222222222222';
const command = (patch: Row = {}) => ({ kind: 'observation.append', commandId: 'fixture-command', sourceId: 'fixture-source',
  observedAt: '2026-10-20T08:00:00+08:00', content: 'A\u{1F600}\u4E2DB', metadata: { nested: { b: 2, a: 1 } }, ...patch });
const request = (path: string, body: unknown) => new Request(`http://localhost/api/memory/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const getReceipt = (id: string) => receiptGet(new Request(`http://localhost/api/memory/receipts/${id}`), { params: Promise.resolve({ id }) });
async function append(patch: Row = {}) {
  const response = await commandPost(request('commands', command(patch)));
  expect(response.status).toBe(200);
  return response.json();
}
beforeEach(() => {
  vi.stubEnv('IS_TAURI', 'false'); vi.stubEnv('TAURI_MODE', 'false');
  fixture.authenticated = true; fixture.userId = '11111111-1111-4111-8111-111111111111'; fixture.lease = false;
  fixture.calls = 0; fixture.nextId = 1; fixture.failure = null; fixture.failTable = '';
  fixture.rows = { users: [{ id: fixture.userId }, { id: otherOwner }], observations: [], operations: [], reads: [] };
});
afterEach(() => vi.unstubAllEnvs());

describe('memory T1 real client HTTP contracts', () => {
  it('requires authentication for commands, reads and receipt explanation without opening storage', async () => {
    fixture.authenticated = false;
    const responses = await Promise.all([commandPost(request('commands', command())), readPost(request('read', {})),
      getReceipt('33333333-3333-4333-8333-333333333333')]);
    expect(responses.map(response => response.status)).toEqual([401, 401, 401]);
    expect(fixture.calls).toBe(0);
  });

  it.each(['owner', 'userId', 'trustLevel', 'sourceType', 'grant', 'lease'])('rejects command injection through %s using the actual parser', async field => {
    const response = await commandPost(request('commands', command({ [field]: field === 'trustLevel' ? 'verified' : otherOwner })));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_memory_request' });
    expect(fixture.calls).toBe(0);
  });

  it('does not let Work execution impersonate the owner client', async () => {
    fixture.lease = true;
    const response = await commandPost(request('commands', command()));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'memory_owner_context_required' });
    expect(fixture.calls).toBe(0);
  });

  it('replays canonical metadata/time requests while rejecting changed content under one command ID', async () => {
    const original = await append();
    const replay = await append({ observedAt: '2026-10-20T00:00:00.000Z', metadata: { nested: { a: 1, b: 2 } } });
    expect(replay).toMatchObject({ status: 'committed', replayed: true, ref: original.ref, receipt: original.receipt });
    expect(fixture.rows.observations).toHaveLength(1); expect(fixture.rows.operations).toHaveLength(1);
    expect(original.observation).toMatchObject({ userId: fixture.userId, sourceType: 'manual', trustLevel: 'raw' });
    const changed = await commandPost(request('commands', command({ content: 'Changed under old command' })));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'memory_command_conflict' });
  });

  it('does not overwrite an existing source with changed data under a new command ID', async () => {
    await append();
    const response = await commandPost(request('commands', command({ commandId: 'different-command', content: 'replacement' })));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'observation_source_conflict' });
    expect(fixture.rows.observations).toHaveLength(1); expect(fixture.rows.operations).toHaveLength(1);
  });

  it('uses Unicode code point windows and records the actual clamped range', async () => {
    const saved = await append();
    const first = await readPost(request('read', { purpose: 'evidence', ref: saved.ref, range: { start: 1, end: 2 } }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'ok', content: '\u{1F600}', receipt: {
      actualRange: { start: 1, end: 2, unit: 'unicode_code_points' }, totalLength: 4,
    } });
    const tail = await readPost(request('read', { purpose: 'evidence', ref: saved.ref, range: { start: 2, end: 100 } }));
    const tailData = await tail.json();
    expect(tailData).toMatchObject({ status: 'ok', content: '\u4E2DB', receipt: { actualRange: { start: 2, end: 4 } } });
    expect(await (await getReceipt(tailData.receipt.id)).json()).toMatchObject({ status: 'ok', type: 'read',
      receipt: { actualRange: { start: 2, end: 4, unit: 'unicode_code_points' }, totalLength: 4 } });
  });

  it('refuses a mismatched version and does not issue a false read receipt', async () => {
    const saved = await append();
    const response = await readPost(request('read', { purpose: 'evidence', ref: { ...saved.ref, revision: `obsrv1:${'f'.repeat(64)}` }, range: { start: 0, end: 4 } }));
    expect(await response.json()).toMatchObject({ status: 'unavailable', code: 'version_mismatch' });
    expect(fixture.rows.reads).toHaveLength(0);
  });

  it.each([{ start: -1, end: 1 }, { start: 0, end: 8193 }, { start: 2, end: 1 }, { start: 0.5, end: 2 }])(
    'rejects an invalid evidence window without issuing a read receipt: %j', async range => {
      const saved = await append();
      const callsBefore = fixture.calls;
      const response = await readPost(request('read', { purpose: 'evidence', ref: saved.ref, range }));
      expect(response.status).toBe(400);
      expect(fixture.calls).toBe(callsBefore); expect(fixture.rows.reads).toHaveLength(0);
    });

  it('hides other owners observations and receipts with real owner-scoped adapter queries', async () => {
    const saved = await append();
    fixture.userId = otherOwner;
    const current = await readPost(request('read', { purpose: 'current', ref: saved.ref.record }));
    expect(await current.json()).toMatchObject({ status: 'not_found' });
    expect(await (await getReceipt(saved.receipt.id)).json()).toEqual({ status: 'not_found' });
    expect(fixture.rows.reads).toHaveLength(0);
  });

  it.each(['commands', 'read', 'receipt'] as const)('sanitizes internal storage failures for %s', async route => {
    const saved = await append();
    fixture.failure = Error('SQL SELECT private_secret FROM hidden; postgres://secret-password');
    const response = route === 'commands' ? await commandPost(request('commands', command({ commandId: 'retry' })))
      : route === 'read' ? await readPost(request('read', { purpose: 'current', ref: saved.ref.record })) : await getReceipt(saved.receipt.id);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('memory_request_failed');
    expect(body).not.toContain('private_secret'); expect(body).not.toContain('secret-password'); expect(body).not.toContain('SELECT');
  });

  it('rolls back an inserted observation when the mandatory operation receipt fails', async () => {
    fixture.failure = Error('private insert receipt failure'); fixture.failTable = 'operations';
    const response = await commandPost(request('commands', command()));
    expect(response.status).toBe(503);
    expect(fixture.rows.observations).toHaveLength(0); expect(fixture.rows.operations).toHaveLength(0);
  });

  it('rejects malformed JSON and read-scope injection before any storage access', async () => {
    const malformed = await commandPost(new Request('http://localhost/api/memory/commands', { method: 'POST', body: '{' }));
    expect(malformed.status).toBe(400);
    const injected = await readPost(request('read', { purpose: 'current', ref: { kind: 'observation', id: otherOwner }, owner: otherOwner }));
    expect(injected.status).toBe(400); expect(fixture.calls).toBe(0);
  });

  it('rejects oversized streamed bodies without Content-Length before commands or reads reach storage', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(command({ content: 'x'.repeat(1024 * 1024) })));
    const streamedRequest = (path: string) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bytes.subarray(0, 17));
        controller.enqueue(bytes.subarray(17, 700000));
        controller.enqueue(bytes.subarray(700000));
        controller.close();
      } });
      const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' };
      const incoming = new Request(`http://localhost/api/memory/${path}`, init);
      expect(incoming.headers.has('content-length')).toBe(false);
      return incoming;
    };
    const responses = await Promise.all([commandPost(streamedRequest('commands')), readPost(streamedRequest('read'))]);
    expect(responses.map(response => response.status)).toEqual([413, 413]);
    for (const response of responses) expect(await response.json()).toMatchObject({ code: 'memory_request_too_large' });
    expect(fixture.calls).toBe(0);
    expect(fixture.rows.observations).toHaveLength(0); expect(fixture.rows.reads).toHaveLength(0);
  });

  it('accepts an actual leap day while rejecting February 29 in a non-leap year before storage', async () => {
    const leapDay = await append({ observedAt: '2024-02-29T00:00:00Z' });
    expect(leapDay.observation.observedAt).toBe('2024-02-29T00:00:00.000Z');
    const callsBefore = fixture.calls;
    const invalid = await commandPost(request('commands', command({ commandId: 'invalid-leap-day', sourceId: 'invalid-date', observedAt: '2026-02-29T00:00:00Z' })));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'invalid_memory_request' });
    expect(fixture.calls).toBe(callsBefore); expect(fixture.rows.observations).toHaveLength(1);
  });

  it('rejects a nonexistent calendar date rather than silently recording a normalized observation time', async () => {
    const response = await commandPost(request('commands', command({ observedAt: '2026-02-30T00:00:00Z' })));
    expect(response.status).toBe(400);
    expect(fixture.rows.observations).toHaveLength(0);
  });
});
