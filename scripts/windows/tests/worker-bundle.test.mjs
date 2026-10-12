import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { buildWorkerBundle, resolveReleaseExternal, transformWorkerSource } from '../build-worker.mjs';
import { migrationConfiguration, runMigrations, validateMigrationFiles } from '../migrate-entry.mjs';
import { copyDependencyClosure, copyReleaseTree, resolvePackage, within } from '../release-lib.mjs';

const execute = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ownerId = '61e7bf11-c2c5-435f-9375-7bd60f5b1d97';
const databaseUrl = 'postgres://zhiyu:test-only@127.0.0.1:54328/zhiyu';
const bootstrapUrl = 'postgres://zhiyu:test-only@127.0.0.1:54328/postgres';

async function migrationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhiyu-worker-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'sql');
  await mkdir(join(folder, 'meta'), { recursive: true });
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries: [{ tag: '0000_initial' }] }));
  await writeFile(join(folder, '0000_initial.sql'), 'SELECT 1;');
  return { root, folder };
}

test('migration requires explicit loopback target and bootstrap identity', () => {
  assert.throws(() => migrationConfiguration({}), /migration_database_required/);
  assert.throws(() => migrationConfiguration({ POSTGRES_URL: databaseUrl }), /migration_owner_required/);
  assert.throws(() => migrationConfiguration({ POSTGRES_URL: databaseUrl.replace(/\/zhiyu$/, '/existing'), ZHIYU_BOOTSTRAP_OWNER_ID: ownerId }), /migration_target_invalid/);
  assert.throws(() => migrationConfiguration({ POSTGRES_URL: databaseUrl.replace('127.0.0.1', 'db.example.com'), ZHIYU_BOOTSTRAP_OWNER_ID: ownerId }), /migration_target_invalid/);
  assert.throws(() => migrationConfiguration({ POSTGRES_URL: databaseUrl, DATABASE_URL: `${databaseUrl}?x=1`, ZHIYU_BOOTSTRAP_OWNER_ID: ownerId }), /migration_database_configuration_conflict/);
  assert.throws(() => migrationConfiguration({ POSTGRES_URL: databaseUrl, ZHIYU_BOOTSTRAP_DB_URL: bootstrapUrl.replace('54328', '54329'), ZHIYU_BOOTSTRAP_OWNER_ID: ownerId }), /migration_bootstrap_target_mismatch/);
  assert.deepEqual(migrationConfiguration({ DATABASE_URL: databaseUrl, ZHIYU_BOOTSTRAP_DB_URL: bootstrapUrl, ZHIYU_BOOTSTRAP_OWNER_ID: ownerId }), { databaseUrl, bootstrapUrl, ownerId });
});

test('migration journal rejects missing SQL and traversal before connection', async t => {
  const { folder } = await migrationFixture(t);
  assert.equal(validateMigrationFiles(folder), 1);
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries: [{ tag: '../outside' }] }));
  assert.throws(() => validateMigrationFiles(folder), /migration_sql_missing/);
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries: [{ tag: '0001_missing' }] }));
  assert.throws(() => validateMigrationFiles(folder), /migration_sql_missing/);
});

function mockDependencies({ exists = false, migrationError = null } = {}) {
  const calls = [];
  const postgresFactory = url => {
    calls.push({ operation: 'connect', url });
    const connection = async (strings, ...parameters) => {
      calls.push({ operation: 'query', url, text: strings.join('?'), parameters });
      return url === bootstrapUrl ? exists ? [{ datname: 'zhiyu' }] : [] : [];
    };
    connection.unsafe = async text => calls.push({ operation: 'unsafe', url, text });
    connection.end = async () => calls.push({ operation: 'end', url });
    return connection;
  };
  return { calls, postgresFactory, drizzleFactory: value => value,
    migrateFn: async (_db, options) => {
      calls.push({ operation: 'migrate', folder: options.migrationsFolder });
      if (migrationError) throw migrationError;
    },
  };
}

test('bootstrap creates target, migrates, ensures owner without changing existing account', async t => {
  const { folder } = await migrationFixture(t);
  const dependencies = mockDependencies();
  const receipt = await runMigrations({ databaseUrl, bootstrapUrl, ownerId }, dependencies, folder);
  assert.equal(receipt.event, 'migration_completed');
  assert.deepEqual(dependencies.calls.filter(call => call.operation === 'unsafe').map(call => call.text), ['CREATE DATABASE "zhiyu"', 'CREATE EXTENSION IF NOT EXISTS vector']);
  const insert = dependencies.calls.find(call => call.operation === 'query' && call.url === databaseUrl);
  assert.match(insert.text, /ON CONFLICT \("id"\) DO NOTHING/);
  assert.deepEqual(insert.parameters, [ownerId, 'owner@zhiyu.local', 'Local Owner']);
  assert.equal(dependencies.calls.filter(call => call.operation === 'end').length, 2);
  const second = mockDependencies({ exists: true });
  await runMigrations({ databaseUrl, bootstrapUrl, ownerId }, second, folder);
  assert.deepEqual(second.calls.filter(call => call.operation === 'unsafe').map(call => call.text), ['CREATE EXTENSION IF NOT EXISTS vector']);
});

test('failed migration closes target and does not bootstrap owner', async t => {
  const { folder } = await migrationFixture(t);
  const dependencies = mockDependencies({ exists: true, migrationError: new Error('test_failure') });
  await assert.rejects(runMigrations({ databaseUrl, bootstrapUrl, ownerId }, dependencies, folder), /migration_schema_failed/);
  assert.equal(dependencies.calls.filter(call => call.operation === 'end').length, 2);
  assert.equal(dependencies.calls.filter(call => call.operation === 'query' && call.url === databaseUrl).length, 0);
});

test('release transform removes development env loading and preserves worker IPC', async () => {
  const source = await readFile(join(workspaceRoot, 'apps/web/scripts/start-runtime-worker.mjs'), 'utf8');
  const transformed = transformWorkerSource(source, 'entry');
  assert.doesNotMatch(transformed, /from\s*['"]dotenv['"]|config\(\{path:/);
  assert.match(transformed, /ZHIYU_OPTIONAL_QUANT_ENABLED === 'false' \? \[\]/);
  assert.ok(transformed.indexOf("ZHIYU_RUNTIME_START_PAUSED==='1'") < transformed.indexOf('await step();'));
  assert.match(transformed, /\['running','paused'\]\.includes\(host\.snapshot\(\)\.phase\)&&process\.connected/);
  for (const message of ['runtime_ready', 'parent_stop', "message==='pause'", "message==='resume'"]) assert.ok(transformed.includes(message));
  const client = await readFile(join(workspaceRoot, 'apps/web/lib/db/client.ts'), 'utf8');
  assert.doesNotMatch(transformWorkerSource(client, 'database'), /dotenv|config\(\{/);
  assert.throws(() => transformWorkerSource('changed entry', 'entry'), /worker_release_transform_missing/);
});

test('saved pause blocks real host first dispatch and still permits resume', async t => {
  const { root } = await migrationFixture(t);
  const require = createRequire(join(workspaceRoot, 'package.json'));
  const { build } = require('esbuild');
  const output = join(root, 'host-controller.mjs');
  await build({ entryPoints: [join(workspaceRoot, 'apps/web/lib/runtime/host-controller.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const { RuntimeHostController } = await import(pathToFileURL(output).href);
  let dispatched = 0, heartbeatStatus;
  const host = new RuntimeHostController({
    store: { acquire: async () => ({}), heartbeat: async (_lease, _ttl, _modules, status) => { heartbeatStatus = status; return true; }, release: async () => true },
    ownerId, instanceId: ownerId, mode: 'worker', ttlMs: 15000, enabled: () => true,
    modules: [{ name: 'dispatch-probe', intervalMs: 1, timeoutMs: 1000, run: async () => { dispatched++; } }],
  });
  const source = transformWorkerSource(await readFile(join(workspaceRoot, 'apps/web/scripts/start-runtime-worker.mjs'), 'utf8'), 'entry');
  const pauseStatement = source.match(/if\(process\.env\.ZHIYU_RUNTIME_START_PAUSED==='1'\)host\.pause\(\);/)?.[0];
  assert.ok(pauseStatement);
  new Function('process', 'host', pauseStatement)({ env: { ZHIYU_RUNTIME_START_PAUSED: '1' } }, host);
  try {
    await host.step();
    await new Promise(resolveTick => setImmediate(resolveTick));
    assert.equal(dispatched, 0);
    assert.equal(host.snapshot().phase, 'paused');
    assert.equal(heartbeatStatus, 'paused');
    host.resume(); await host.step();
    await new Promise(resolveTick => setImmediate(resolveTick));
    assert.equal(dispatched, 1);
    assert.equal(host.snapshot().phase, 'running');
  } finally { await host.stop(1000); }
});

test('source consumers emit distinct package aliases for their actual OpenAI versions', async () => {
  const require = createRequire(join(workspaceRoot, 'package.json'));
  const { build } = require('esbuild');
  const webOrigin = join(workspaceRoot, 'apps/web/package.json');
  const aiOrigin = join(workspaceRoot, 'packages/ai/package.json');
  const webPackage = resolveReleaseExternal('openai', webOrigin);
  const aiPackage = resolveReleaseExternal('openai', aiOrigin);
  assert.match(webPackage.record.version, /^6\./);
  assert.match(aiPackage.record.version, /^4\./);
  assert.notEqual(webPackage.path, aiPackage.path);
  assert.notEqual(webPackage.record.packageRoot, aiPackage.record.packageRoot);
  const subpath = resolveReleaseExternal('openai/resources/chat/completions', webOrigin);
  assert.equal(subpath.path, `${webPackage.record.releasePackageName}/resources/chat/completions`);
  for (const [origin, resolvedPackage] of [[webOrigin, webPackage], [aiOrigin, aiPackage]]) {
    const result = await build({
      stdin: { contents: 'import OpenAI from "openai"; export const Client = OpenAI;', resolveDir: dirname(origin) },
      bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'consumer-external-alias', setup(api) {
        api.onResolve({ filter: /^openai$/ }, () => {
          const external = resolveReleaseExternal('openai', origin);
          return { path: external.path, external: true };
        });
      } }],
    });
    assert.ok(result.outputFiles[0].text.includes(`from "${resolvedPackage.path}"`));
    assert.ok(!result.outputFiles[0].text.includes('from "openai"'));
  }
});

test('legacy Next aliases import in an isolated directory under bundled Node', { timeout: 120000 }, async t => {
  const { root } = await migrationFixture(t);
  const origin = join(workspaceRoot, 'apps/web/package.json');
  const server = resolveReleaseExternal('next/server', origin);
  const navigation = resolveReleaseExternal('next/navigation', origin);
  assert.equal(server.path, `${server.record.releasePackageName}/server.js`);
  assert.equal(navigation.path, `${server.record.releasePackageName}/navigation.js`);
  const next = resolvePackage('next', origin);
  await copyDependencyClosure([{ ...next, releasePackageName: server.record.releasePackageName }], join(root, 'node_modules'));
  const entry = join(root, 'next-import.mjs');
  await writeFile(entry, `import { NextRequest, NextResponse } from ${JSON.stringify(server.path)};\nimport * as navigation from ${JSON.stringify(navigation.path)};\nconst response=NextResponse.json({fixture:true});\nconsole.log(JSON.stringify({nodeVersion:process.version,cwd:process.cwd(),requestType:typeof NextRequest,status:response.status,navigationType:typeof navigation.redirect,resolved:import.meta.resolve(${JSON.stringify(server.path)})}));`);
  const node = join(workspaceRoot, 'output/windows-toolchain/extracted/node-v24.14.1-win-x64/node.exe');
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'POSTGRES_URL', 'DATABASE_URL']) delete env[key];
  const { stdout } = await execute(node, [entry], { cwd: root, env, windowsHide: true });
  const receipt = JSON.parse(stdout.trim());
  assert.equal(receipt.nodeVersion, 'v24.14.1');
  assert.equal(receipt.cwd, root);
  assert.equal(receipt.requestType, 'function');
  assert.equal(receipt.navigationType, 'function');
  assert.equal(receipt.status, 200);
  assert.equal(within(root, fileURLToPath(receipt.resolved)), true);
  // The worker starts with this condition; verify its Next server import too.
  await writeFile(entry, `import { NextResponse } from ${JSON.stringify(server.path)};\nconsole.log(NextResponse.json({fixture:true}).status);`);
  assert.equal((await execute(node, ['--conditions=react-server', entry], { cwd: root, env, windowsHide: true })).stdout.trim(), '200');
  t.diagnostic(JSON.stringify({ event: 'isolated_next_alias_import', ...receipt, reactServerCondition: true, noDatabaseOrWorkerStarted: true }));
});

test('conditional export aliases preserve import and react-server runtime selection', async t => {
  const { root } = await migrationFixture(t);
  const source = join(root, 'source');
  const packageRoot = join(source, 'node_modules', 'conditional-fixture');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'conditional-fixture', version: '1.0.0', exports: { './feature': { 'react-server': './server.mjs', import: './import.mjs', require: './require.cjs' } } }));
  await writeFile(join(packageRoot, 'server.mjs'), 'export const branch="react-server";');
  await writeFile(join(packageRoot, 'import.mjs'), 'export const branch="import";');
  await writeFile(join(packageRoot, 'require.cjs'), 'exports.branch="require";');
  const external = resolveReleaseExternal('conditional-fixture/feature', join(source, 'entry.mjs'));
  assert.equal(external.path, `${external.record.releasePackageName}/feature`);
  const payload = join(root, 'payload');
  await copyReleaseTree(packageRoot, join(payload, 'node_modules', ...external.record.releasePackageName.split('/')));
  const entry = join(payload, 'entry.mjs');
  await writeFile(entry, `import {branch} from ${JSON.stringify(external.path)};console.log(branch);`);
  const node = join(workspaceRoot, 'output/windows-toolchain/extracted/node-v24.14.1-win-x64/node.exe');
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  assert.equal((await execute(node, [entry], { cwd: payload, env, windowsHide: true })).stdout.trim(), 'import');
  assert.equal((await execute(node, ['--conditions=react-server', entry], { cwd: payload, env, windowsHide: true })).stdout.trim(), 'react-server');
});

test('legacy subpath aliases refuse a symlink escaping the package boundary', async t => {
  const { root } = await migrationFixture(t);
  const packageRoot = join(root, 'node_modules', 'legacy-fixture');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), '{"name":"legacy-fixture","version":"1.0.0"}');
  const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'escape.js'), 'module.exports=1;');
  await symlink(outside, join(packageRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveReleaseExternal('legacy-fixture/escape/escape', join(root, 'entry.mjs')), /worker_release_subpath_outside_package/);
});

test('build produces pure Node release entry and journal; migrated CLI ignores cwd env', { timeout: 120000 }, async t => {
  const { root } = await migrationFixture(t);
  const stageRoot = join(root, 'stage');
  const result = await buildWorkerBundle({ workspaceRoot, stageRoot });
  assert.ok(result.externalDependencies.length > 0);
  assert.ok(result.externalDependencies.every(item => item.specifier && item.packageName && item.resolveOrigin && item.releasePackageName && item.packageRoot && item.version));
  assert.equal(validateMigrationFiles(join(stageRoot, 'migrations/sql')), result.migrations.migrationCount);
  await execute(process.execPath, ['--check', result.workerEntry]);
  await execute(process.execPath, ['--check', result.migrationEntry]);
  const workerEntry = await readFile(result.workerEntry, 'utf8');
  assert.doesNotMatch(workerEntry, /--import tsx|D:\\zhiyu|D:\/zhiyu/);
  const cwd = join(root, 'foreign-workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, '.env'), `POSTGRES_URL=${databaseUrl}\nZHIYU_BOOTSTRAP_OWNER_ID=${ownerId}\n`);
  const environment = { ...process.env };
  for (const name of ['POSTGRES_URL', 'DATABASE_URL', 'ZHIYU_BOOTSTRAP_DB_URL', 'ZHIYU_BOOTSTRAP_OWNER_ID', 'NODE_OPTIONS']) delete environment[name];
  await assert.rejects(execute(process.execPath, [result.migrationEntry], { cwd, env: environment }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /migration_database_required/);
    assert.doesNotMatch(error.stderr, /test-only/);
    return true;
  });
  assert.ok((await readdir(join(stageRoot, 'worker/chunks'))).length > 0);
});
