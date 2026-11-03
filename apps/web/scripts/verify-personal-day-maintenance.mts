/** Real HTTP, persisted Work queue and fenced runtime against a disposable fixture DB only. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const meta = JSON.parse(
  await readFile('../../.runtime/personal-day-fixture.json', 'utf8'),
);
assert.match(meta.database, /^zhiyu_test_[a-f0-9]{32}$/);
assert.equal(meta.productionWrites, false);
const env = JSON.parse(
  await readFile(meta.root + '/private-environment.json', 'utf8'),
);
assert.equal(new URL(env.POSTGRES_URL).pathname, '/' + meta.database);
Object.assign(process.env, env, {
  NODE_ENV: 'test',
  ZHIYU_TEST_MODE: 'integration',
  ZHIYU_TEST_DATABASE_URL: env.POSTGRES_URL,
});
const { consumeOwnedWorkRuns } = await import(
  '@/lib/work-runtime/run-consumer'
);
const { updateWork, getWorkSummarySnapshot } = await import(
  '@/lib/work-runtime'
);
const { readDaySnapshot } = await import('@/lib/personal-day/store');
const { ownedFeedback } = await import('@/lib/personal-day/feedback-store');
const { getWorkshop } = await import('@/lib/workshops/service');
const { closePostgresDb } = await import('@/lib/db/adapters/postgres');
const { businessDate, nextDate, DEFAULT_PROFILE } = await import(
  '@/lib/personal-day/contracts'
);
const checks: string[] = [],
  base = 'http://127.0.0.1:3516';
let data: any, workId: string;
const ok = (name: string) => {
  checks.push(name);
  console.log('PASS ' + name);
};
async function request(
  path: string,
  body?: any,
  status = 200,
  headers: any = {},
) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Personal-Day-Actor': meta.owner,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(180000),
  });
  const value = await r.json();
  assert.equal(r.status, status, path + ' ' + JSON.stringify(value));
  return value;
}
const refresh = async () => (data = await request('/api/personal-day'));
async function command(operation: string, extra: any = {}) {
  const result = await request('/api/personal-day', {
    operation,
    commandId: randomUUID(),
    expectedRevision: data.revision,
    ...extra,
  });
  await refresh();
  return result;
}
async function configure(enabled: boolean) {
  const result = await request('/api/personal-day/maintenance', {
    operation: 'configure',
    commandId: randomUUID(),
    expectedRevision: data.revision,
    enabled,
  });
  await refresh();
  return result;
}
async function feedback(text: string, id = randomUUID(), status = 202) {
  const body = { operation: 'feedback', id, date: businessDate(), text };
  const value = await request('/api/personal-day/maintenance', body, status);
  return { id, value, body };
}
async function consume() {
  const results = await consumeOwnedWorkRuns({
    userId: meta.owner,
    workerId: 'personal-day-maintenance-fixture',
    workshopIds: [workId],
    limit: 10,
    leaseMs: 180000,
  });
  console.log('CONSUMER ' + JSON.stringify(results));
  return results;
}
async function patch(patch: any) {
  const baseline = await getWorkSummarySnapshot({ userId: meta.owner, workId });
  return updateWork({
    userId: meta.owner,
    workId,
    commandId: randomUUID(),
    expectedVersion: baseline!.detail.commandVersion,
    source: 'owner',
    reason: 'synthetic acceptance',
    patch,
  });
}
try {
  await refresh();
  assert.equal(data.account.profile, null);
  const before = (await request('/api/personal-day/maintenance')).binding;
  assert.equal(before, null);
  ok('read-only homepage does not create a Work or profile');
  await request(
    '/api/personal-day/maintenance',
    {
      operation: 'configure',
      commandId: randomUUID(),
      expectedRevision: 0,
      enabled: false,
    },
    403,
    { Origin: 'https://evil.example.invalid' },
  );
  await request('/api/personal-day/maintenance', undefined, 409, {
    'X-Personal-Day-Actor': meta.other,
  });
  ok('same origin and actor isolation');
  workId = (await configure(false)).result.workId;
  assert.ok(workId);
  assert.equal(data.account.maintenance.workId, workId);
  ok('one-time setup creates a genuine associated Work');
  const model = await request('/api/preferences/models');
  const modelResponse = await fetch(base + '/api/preferences/models', {
    method: 'PUT',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: model.revision ?? 0,
      document: {
        connections: [
          {
            id: 'daily_fixture',
            name: 'Synthetic loopback Pi fixture',
            protocol: 'openai_compatible',
            baseUrl: meta.providerBaseUrl,
            model: 'daily-fixture',
            enabled: true,
          },
        ],
        defaults: {
          openai_compatible: 'daily_fixture',
          anthropic_compatible: null,
        },
        defaultConnectionId: 'daily_fixture',
        conversationProtocol: 'auto',
        assignments: {},
      },
      secretUpdates: { daily_fixture: 'fixture-key-not-a-real-secret' },
    }),
  });
  assert.equal(modelResponse.status, 200);
  await command('profile_save', {
    profile: {
      ...DEFAULT_PROFILE,
      cloudConsent: true,
      sourceConsent: true,
      notes: 'SYNTHETIC-MAINTENANCE-ONLY',
    },
  });
  await configure(true);
  ok('owner explicitly authorizes health maintenance and center model');
  const first = await feedback('今天走了20分钟，午饭吃了牛肉面。请安排明天。');
  assert.equal(first.value.status, 'queued');
  const entry = await ownedFeedback(meta.owner, first.id);
  assert.ok(entry.row.runId);
  assert.ok(!entry.row.input.includes('牛肉面'));
  await assert.rejects(
    () => ownedFeedback(meta.other, first.id),
    /feedback_not_found/,
  );
  ok(
    'immutable encrypted feedback and real queue receipt saved before execution',
  );
  const runs = await consume();
  assert.ok(runs.some((r) => r.state === 'completed'));
  await refresh();
  const processed = await ownedFeedback(meta.owner, first.id);
  assert.equal(processed.row.status, 'processed');
  assert.equal(processed.result.facts[0].minutes, 20);
  assert.equal(processed.result.facts[1].kind, 'meal');
  assert.equal(processed.result.facts[1].value, undefined);
  assert.ok(
    data.days[nextDate(businessDate())].active.items.every(
      (i: any) => i.flexible && i.start === '',
    ),
  );
  assert.equal(processed.result.receipt.workId, workId);
  ok(
    'actual Work runtime uses Pi fixture and automatically publishes sourced flexible plan',
  );
  await request('/api/personal-day/maintenance', first.body, 202);
  assert.equal(
    (await ownedFeedback(meta.owner, first.id)).row.runId,
    entry.row.runId,
  );
  assert.equal((await consume()).length, 0);
  ok('duplicate admission replays without duplicate run or model call');
  await patch({ status: 'paused' });
  const paused = await feedback('今天走了10分钟。');
  assert.equal(paused.value.status, 'received');
  assert.equal((await getWorkshop(meta.owner, workId))!.status, 'paused');
  await patch({ status: 'active' });
  await request(
    '/api/personal-day/maintenance',
    { operation: 'retry', id: paused.id, retryId: randomUUID() },
    202,
  );
  assert.ok((await consume()).some((r) => r.state === 'completed'));
  ok('pause preserves raw feedback and never silently resumes the Work');
  const work = await getWorkshop(meta.owner, workId);
  await patch({
    boundaryPolicy: {
      ...(work!.boundaryPolicy as any),
      mode: 'auto',
      hardDeniedActions: ['personalDay*', 'sendMessage', 'bash', 'delete'],
    },
  });
  const denied = await feedback('今天走了15分钟。');
  assert.ok((await consume()).some((r) => r.state === 'failed'));
  assert.equal(
    (await ownedFeedback(meta.owner, denied.id)).row.error,
    'maintenance_boundary_denied',
  );
  ok('wildcard denial takes precedence over allowed maintenance tools');
  await patch({
    boundaryPolicy: {
      ...(work!.boundaryPolicy as any),
      mode: 'auto',
      hardDeniedActions: ['sendMessage', 'bash', 'delete'],
    },
  });
  const retryId = randomUUID();
  await request(
    '/api/personal-day/maintenance',
    { operation: 'retry', id: denied.id, retryId },
    202,
  );
  assert.ok((await consume()).some((r) => r.state === 'completed'));
  assert.equal(
    (await ownedFeedback(meta.owner, retryId)).input.retryOf,
    denied.id,
  );
  ok('explicit retry keeps failed source record and links a new attempt');
  await refresh();
  await request(
    '/api/personal-day',
    {
      operation: 'generate',
      commandId: randomUUID(),
      expectedRevision: data.revision,
      date: nextDate(businessDate()),
      mode: 'pi',
      reason: 'no hidden calls',
    },
    409,
  );
  ok('legacy standalone model generation is retired');
  const pain = await feedback('明天膝盖疼，请不要安排运动。');
  assert.ok((await consume()).some((r) => r.state === 'completed'));
  await refresh();
  assert.equal(data.days[nextDate(businessDate())].active.items.length, 0);
  ok(
    'natural feedback changes constraints and future plan without a replan button',
  );
  const correction = await feedback('更正：今天走了40分钟。');
  assert.ok((await consume()).some((r) => r.state === 'failed')); // pain remains a hard constraint: model cannot reintroduce exercise.
  assert.equal(
    (await ownedFeedback(meta.owner, correction.id)).row.error,
    'exercise_restricted',
  );
  ok(
    'host retains health constraints even if the next model reply forgets them',
  );
  const exported = await request('/api/personal-day/export');
  assert.ok(exported.feedback.length >= 5);
  assert.equal(
    exported.feedback.find((f: any) => f.id === first.id).text,
    first.body.text,
  );
  ok('complete export includes immutable feedback and interpretation receipts');
  await writeFile(
    '../../.runtime/maintenance-http-' + meta.mode + '.json',
    JSON.stringify(
      {
        passed: true,
        checks,
        at: new Date().toISOString(),
        productionWrites: false,
        externalProvidersCalled: false,
        workId,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closePostgresDb();
}
