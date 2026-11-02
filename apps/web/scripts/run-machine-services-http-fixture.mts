/** Explicit isolated production Web fixture. SIGINT closes its own host and DB. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { startModelMediaFixture, fixtureWav } from './model-media-fixture.mjs';
if (!process.argv.includes('--execute'))
  throw Error('explicit_fixture_execution_required');
const disk = parse(await readFile('.env', 'utf8')),
  url = new URL(disk.POSTGRES_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search)
  throw Error('loopback_database_required');
const database = 'zhiyu_test_' + randomUUID().replaceAll('-', ''),
  owner = randomUUID();
if (!/^zhiyu_test_[a-f0-9]{32}$/.test(database))
  throw Error('invalid_fixture_database');
url.pathname = '/postgres';
const admin = postgres(url.toString(), { max: 1, onnotice() {} });
await admin.unsafe(`CREATE DATABASE "${database}"`);
url.pathname = '/' + database;
const sql = postgres(url.toString(), { max: 1, onnotice() {} }),
  fixture = await startModelMediaFixture();
const root = await mkdtemp(resolve('../../.runtime/media-services-web-'));
let child: ReturnType<typeof spawn> | undefined,
  closed = false;
async function cleanup() {
  if (closed) return;
  closed = true;
  child?.kill();
  await fixture.close();
  await sql.end();
  if (/^zhiyu_test_[a-f0-9]{32}$/.test(database)) {
    for (let i = 0; i < 20; i++) {
      const [{ count }] =
        await admin`SELECT count(*)::int FROM pg_stat_activity WHERE datname=${database}`;
      if (!count) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await admin.unsafe(`DROP DATABASE "${database}"`);
  }
  await admin.end();
}
try {
  await migrate(drizzle(sql), { migrationsFolder: 'lib/db/migrations' });
  await sql`INSERT INTO "User" (id,email) VALUES (${owner},'media-fixture@example.invalid')`;
  const settings = {
    EMBEDDING_PROVIDER: 'cloud',
    LLM_EMBEDDING_BASE_URL: fixture.baseUrl + '/compatible-mode/v1',
    OPENAI_EMBEDDINGS_API_KEY: 'fixture-embedding-key',
    LLM_EMBEDDING_MODEL: 'text-embedding-v4',
    LLM_EMBEDDING_DIMENSIONS: '4',
    LLM_EMBEDDING_API_FORMAT: 'openai',
    AUDIO_PROVIDER: 'bailian',
    AUDIO_BASE_URL: fixture.baseUrl + '/api/v1',
    AUDIO_API_KEY: 'fixture-audio-key',
    AUDIO_TTS_MODEL: 'qwen-audio-3.1-tts-flash',
    AUDIO_TTS_VOICE: 'longanhuan_v3.1',
    AUDIO_ASR_MODEL: 'qwen3-asr-flash',
    AI_VIDEO_AGENT_VIDEO_BASE_URL: fixture.baseUrl + '/api/v1',
    AI_VIDEO_AGENT_VIDEO_API_KEY: 'fixture-video-key',
    AI_VIDEO_AGENT_VIDEO_MODEL: 'wan2.7-t2v-2026-06-12',
  };
  await writeFile(
    join(root, '.env'),
    Object.entries(settings)
      .map(([key, value]) => `${key}="${value}"`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  await writeFile(join(root, 'sample.wav'), fixtureWav());
  const env = { ...process.env };
  for (const key of Object.keys({ ...disk, ...env }))
    if (/API_KEY|TOKEN|SECRET|PASSWORD|_ENDPOINT|_BASE_URL/.test(key))
      env[key] = '';
  Object.assign(env, settings, {
    POSTGRES_URL: url.toString(),
    DATABASE_URL: url.toString(),
    AUTH_MODE: 'local_owner',
    DEV_USER_ID: owner,
    DEV_USER_EMAIL: 'media-fixture@example.invalid',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUTH_SECRET: randomBytes(32).toString('base64'),
    ENABLE_LOCAL_SCHEDULER: 'false',
    ENABLE_STARTUP_LISTENERS: 'false',
    ZHIYU_MACHINE_MODEL_ROOT: root,
    ZHIYU_REVIEW_BUILD: process.env.ZHIYU_REVIEW_BUILD || '95',
    NODE_ENV: 'production',
    NEXTAUTH_URL: 'http://127.0.0.1:3516',
    PORT: '3516',
    NO_PROXY: '127.0.0.1,localhost,[::1]',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
  });
  child = spawn(
    process.execPath,
    [
      '../../node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3516',
    ],
    { cwd: process.cwd(), env, windowsHide: true, stdio: 'inherit' },
  );
  const metadata = {
    root,
    owner,
    database,
    providerBaseUrl: fixture.baseUrl,
    pid: child.pid,
    productionWrites: false,
    externalProvidersCalled: false,
  };
  await writeFile(
    '../../.runtime/media-services-web-fixture.json',
    JSON.stringify(metadata, null, 2),
  );
  console.log(
    JSON.stringify({
      fixtureReady: true,
      root,
      owner,
      database,
      pid: child.pid,
    }),
  );
  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void cleanup().then(() => process.exit(0));
  });
  await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
} finally {
  await cleanup();
}
