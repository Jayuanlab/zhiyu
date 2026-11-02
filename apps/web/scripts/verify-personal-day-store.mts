/** Destructive checks are fenced to the synthetic secondary owner and fixture DB. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
const meta = JSON.parse(
  await readFile('../../.runtime/personal-day-fixture.json', 'utf8'),
);
assert.equal(meta.productionWrites, false);
assert.match(meta.database, /^zhiyu_test_[a-f0-9]{32}$/);
const env = JSON.parse(
  await readFile(meta.root + '/private-environment.json', 'utf8'),
);
assert.equal(new URL(env.POSTGRES_URL).pathname, '/' + meta.database);
Object.assign(process.env, env, {
  NODE_ENV: 'test',
  ZHIYU_TEST_MODE: 'integration',
  ZHIYU_TEST_DATABASE_URL: env.POSTGRES_URL,
});
const {
  readDaySnapshot,
  dayTransaction,
  failDayCommand,
  dayCommandStatus,
  releasePendingDayCommand,
} = await import('@/lib/personal-day/store');
const { executeDayCommand } = await import('@/lib/personal-day/service');
const { withExecutionContext } = await import(
  '@/lib/work-runtime/execution-context'
);
const { DEFAULT_PROFILE } = await import('@/lib/personal-day/contracts');
const { closePostgresDb } = await import('@/lib/db/adapters/postgres');
const sql = postgres(env.POSTGRES_URL, { max: 1, onnotice() {} }),
  checks: string[] = [];
const ok = (name: string) => {
  checks.push(name);
  console.log('PASS ' + name);
};
const owner = meta.other;
const cmd = (operation: string, revision: number) => ({
  operation,
  commandId: randomUUID(),
  expectedRevision: revision,
});
try {
  const prior = await readDaySnapshot(meta.owner);
  assert.ok(prior.account.profile);
  assert.equal((await readDaySnapshot(owner)).account.profile, null);
  const c = {
    ...cmd('profile_save', 0),
    profile: { ...DEFAULT_PROFILE, notes: 'SYNTHETIC-SECONDARY-PRIVATE' },
  };
  await executeDayCommand(owner, c);
  await assert.rejects(
    () => dayCommandStatus(meta.owner, c.commandId),
    /command_not_found/,
  );
  assert.notEqual(
    (await readDaySnapshot(meta.owner)).account.profile!.notes,
    'SYNTHETIC-SECONDARY-PRIVATE',
  );
  ok('owner scoped reads and command receipts');
  const encrypted =
    await sql`SELECT encrypted_data FROM personal_daily_accounts WHERE owner_id=${owner}`;
  assert.ok(!JSON.stringify(encrypted).includes('SYNTHETIC-SECONDARY-PRIVATE'));
  assert.ok(!JSON.stringify(encrypted).includes('weightKg'));
  ok('database body encrypted at rest');
  const revision = (await readDaySnapshot(owner)).revision;
  const results = await Promise.allSettled([
    dayTransaction(owner, cmd('race-one', revision), () => ({
      event: { kind: 'fixture_race', payload: { value: 1 } },
    })),
    dayTransaction(owner, cmd('race-two', revision), () => ({
      event: { kind: 'fixture_race', payload: { value: 2 } },
    })),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(
    (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
      .reason.message,
    /version_conflict/,
  );
  ok('concurrent stale writer denied under owner lock');
  const rev = (await readDaySnapshot(owner)).revision,
    heavy = cmd('fixture_slow_model', rev);
  await dayTransaction(owner, heavy, () => ({ result: {} }), { reserve: true });
  await dayTransaction(owner, cmd('owner_edit_during_model', rev), () => ({
    event: { kind: 'fixture_owner_edit', payload: {} },
  }));
  await assert.rejects(
    () =>
      dayTransaction(
        owner,
        heavy,
        () => ({ event: { kind: 'stale_model_write', payload: {} } }),
        { finish: true },
      ),
    /version_conflict/,
  );
  await failDayCommand(owner, heavy.commandId, 'fixture_stale');
  ok('late model response cannot overwrite owner edits');
  const revision2 = (await readDaySnapshot(owner)).revision,
    stale = cmd('fixture_abandoned', revision2);
  await dayTransaction(owner, stale, () => ({ result: {} }), { reserve: true });
  await assert.rejects(
    () =>
      dayTransaction(
        owner,
        cmd('release-too-early', revision2),
        async (_, db) => {
          await releasePendingDayCommand(owner, stale.commandId, db);
          return {};
        },
      ),
    /command_still_running/,
  );
  await sql`UPDATE personal_daily_commands SET created_at=now()-interval '3 minutes' WHERE owner_id=${owner} AND id=${stale.commandId}`;
  await dayTransaction(owner, cmd('release', revision2), async (_, db) => {
    await releasePendingDayCommand(owner, stale.commandId, db);
    return {
      event: {
        kind: 'command_released',
        payload: { targetId: stale.commandId },
      },
    };
  });
  await assert.rejects(
    () =>
      dayTransaction(
        owner,
        stale,
        () => ({ event: { kind: 'released_response_write', payload: {} } }),
        { finish: true, expectedRevision: revision2 + 1 },
      ),
    /command_failed/,
  );
  ok('explicit stale command release fences even a late response');
  const beforeLease = (await readDaySnapshot(owner)).revision;
  await assert.rejects(() =>
    withExecutionContext(
      {
        userId: owner,
        workshopId: randomUUID(),
        runId: randomUUID(),
        workerId: 'fixture-expired',
        token: randomUUID(),
      },
      () =>
        dayTransaction(owner, cmd('invalid-lease-write', beforeLease), () => ({
          event: { kind: 'invalid_lease', payload: {} },
        })),
    ),
  );
  assert.equal((await readDaySnapshot(owner)).revision, beforeLease);
  ok('invalid Work execution lease cannot commit health state');
  await executeDayCommand(owner, {
    ...cmd('erase', beforeLease),
    confirmation: '删除个人日计划全部数据',
  });
  assert.equal((await readDaySnapshot(owner)).revision, 0);
  for (const table of [
    'personal_daily_accounts',
    'personal_daily_days',
    'personal_daily_sources',
    'personal_daily_events',
    'personal_daily_commands',
  ]) {
    const [{ count }] = await sql.unsafe(
      `SELECT count(*)::int AS count FROM ${table} WHERE owner_id=$1`,
      [owner],
    );
    assert.equal(count, 0);
  }
  assert.equal((await readDaySnapshot(meta.owner)).revision, prior.revision);
  ok(
    'erase secondary owner cleans all five tables and preserves primary owner',
  );
  await writeFile(
    '../../.runtime/personal-day-store-' + meta.mode + '.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        checks,
        passed: checks.length,
        database: meta.database,
        productionWrites: false,
      },
      null,
      2,
    ),
  );
} finally {
  await closePostgresDb();
  await sql.end();
}
