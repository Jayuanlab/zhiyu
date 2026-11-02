/** Isolated DB + synthetic owner + loopback Pi provider + Web on 3516. */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { startPersonalDayProviderFixture } from './personal-day-provider-fixture.mjs';
if (!process.argv.includes('--execute'))
  throw Error('explicit_fixture_execution_required');
const disk = parse(await readFile('.env', 'utf8')),
  url = new URL(disk.POSTGRES_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search)
  throw Error('loopback_database_required');
const database = 'zhiyu_test_' + randomUUID().replaceAll('-', ''),
  owner = randomUUID(),
  other = randomUUID();
if (!/^zhiyu_test_[a-f0-9]{32}$/.test(database)) throw Error('unsafe_database');
url.pathname = '/postgres';
const admin = postgres(url.toString(), { max: 1, onnotice() {} });
await admin.unsafe(`CREATE DATABASE "${database}"`);
url.pathname = '/' + database;
const sql = postgres(url.toString(), { max: 1, onnotice() {} }),
  fixture = await startPersonalDayProviderFixture(),
  root = await mkdtemp(resolve('../../.runtime/personal-day-fixture-'));
let child: ReturnType<typeof spawn> | undefined;
try {
  await migrate(drizzle(sql), { migrationsFolder: 'lib/db/migrations' });
  await sql`INSERT INTO "User"(id,email) VALUES (${owner},'daily-owner@example.invalid'),(${other},'daily-other@example.invalid')`;
  const env = { ...process.env };
  for (const key of Object.keys({ ...disk, ...env }))
    if (/API_KEY|TOKEN|SECRET|PASSWORD|_BASE_URL|_ENDPOINT/.test(key))
      env[key] = '';
  Object.assign(env, {
    POSTGRES_URL: url.toString(),
    DATABASE_URL: url.toString(),
    AUTH_MODE: 'local_owner',
    DEV_USER_ID: owner,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUTH_SECRET: randomBytes(32).toString('base64'),
    ENABLE_LOCAL_SCHEDULER: 'false',
    ENABLE_STARTUP_LISTENERS: 'false',
    ZHIYU_REVIEW_BUILD: process.env.ZHIYU_REVIEW_BUILD || '96',
    PORT: '3516',
    NODE_OPTIONS:
      '--max-old-space-size=8192 --require ./scripts/patch-http-timeout.cjs',
    NO_PROXY: '127.0.0.1,localhost',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NEXTAUTH_URL: 'http://127.0.0.1:3516',
  });
  const mode = process.argv.includes('--production') ? 'start' : 'dev';
  await writeFile(root + '/private-environment.json', JSON.stringify(env), {
    mode: 0o600,
  });
  child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/start-managed-application.mjs',
      mode,
      ...(mode === 'start' ? ['--port', '3516'] : []),
    ],
    { cwd: process.cwd(), env, windowsHide: true, stdio: 'inherit' },
  );
  await writeFile(
    '../../.runtime/personal-day-fixture.json',
    JSON.stringify(
      {
        root,
        owner,
        other,
        database,
        providerBaseUrl: fixture.baseUrl,
        pid: child.pid,
        mode,
        productionWrites: false,
        externalProvidersCalled: false,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      fixtureReady: true,
      database,
      owner,
      pid: child.pid,
      mode,
    }),
  );
  await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
} finally {
  child?.kill();
  await fixture.close();
  await rm(resolve(root, 'private-environment.json'), { force: true });
  await sql.end();
  for (let i = 0; i < 40; i++) {
    const [{ count }] =
      await admin`SELECT count(*)::int FROM pg_stat_activity WHERE datname=${database}`;
    if (!count) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (/^zhiyu_test_[a-f0-9]{32}$/.test(database))
    await admin.unsafe(`DROP DATABASE "${database}"`);
  await admin.end();
}
