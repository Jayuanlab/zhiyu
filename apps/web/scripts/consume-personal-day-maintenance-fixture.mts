import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
const { readDaySnapshot } = await import('@/lib/personal-day/store');
const { consumeOwnedWorkRuns } = await import(
  '@/lib/work-runtime/run-consumer'
);
const { closePostgresDb } = await import('@/lib/db/adapters/postgres');
try {
  const snapshot = await readDaySnapshot(meta.owner),
    workId = snapshot.account.maintenance?.workId;
  assert.ok(workId);
  console.log(
    JSON.stringify(
      await consumeOwnedWorkRuns({
        userId: meta.owner,
        workerId: 'personal-day-browser-acceptance',
        workshopIds: [workId],
        limit: 10,
        leaseMs: 180000,
      }),
    ),
  );
} finally {
  await closePostgresDb();
}
