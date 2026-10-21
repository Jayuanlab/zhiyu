import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { parse } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { captureReleaseSources } from '../../../../scripts/release-source-snapshot.mjs';
import { withHostBuildRetention } from '../../../../scripts/build-retention.mjs';
import { prepareMemoryRevisionNextConfiguration, captureMemoryRevisionConfiguration,
  captureMemoryRevisionRuntimeOwnership, restoreMemoryRevisionConfiguration } from './brain-memory-revision-configuration.mjs';

// Run from apps/web with node --import tsx --conditions=react-server.
// This runner creates a new synthetic database. It never attaches to an existing
// application server and does not run schedulers, workers or old suites. A fresh
// build is permitted only by the explicit --production --http --build combination.
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.resolve(web, '../..');
const args = process.argv.slice(2);
// A closed selector reuses fixture safety without changing the accepted T1 path.
const fixture = args.find(value => value.startsWith('--fixture='))?.slice('--fixture='.length) ?? 't1';
if (!['t1', 't2', 't3', 't4', 't5', 't6', 't7'].includes(fixture)) throw Error('Unknown memory module fixture');
const fixtureLabel = fixture.toUpperCase();
const suiteName = `memory-module-${fixture}`;
const httpEnabled = args.includes('--http');
const production = args.includes('--production');
const buildEnabled = args.includes('--build');
const mode = production ? 'production' : 'development';
const stage = args.find(value => value.startsWith('--review-stage='))?.split('=')[1] ?? (fixture === 't7' ? production ? '15' : '14' : fixture === 't6' ? production ? '13' : '12' : fixture === 't5' ? production ? '11' : '10' : fixture === 't4' ? production ? '36' : '35' : fixture === 't3' ? production ? '33' : '32' : fixture === 't2' ? production ? '74' : '73' : '71');
const port = Number(args.find(value => value.startsWith('--port='))?.split('=')[1] ?? (fixture === 't7' ? production ? 3615 : 3614 : fixture === 't6' ? production ? 3613 : 3612 : fixture === 't5' ? production ? 3611 : 3610 : fixture === 't4' ? production ? 3636 : 3635 : fixture === 't3' ? production ? 3633 : 3632 : fixture === 't2' ? production ? 3574 : 3573 : 3571));
const reuseDevelopmentOutput = args.includes('--reuse-development-output');
let buildReceiptPath = args.find(value => value.startsWith('--build-receipt='))?.slice('--build-receipt='.length);
const allowed = new Set(['--http', '--production', '--build', '--reuse-development-output']);
if (args.some(value => !allowed.has(value) && !/^--(?:fixture|review-stage|port|build-receipt)=/.test(value))) throw Error(`Unknown ${fixtureLabel} fixture option; existing-server attachment is unsupported`);
if (!/^\d{2}$/.test(stage) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid isolated runtime options');
if (fixture === 't2' && (['71', '72'].includes(stage) || [3571, 3572].includes(port))) throw Error('T2 cannot occupy the accepted T1 review stages or ports');
if (fixture === 't3' && (['71', '72', '73', '74', '75'].includes(stage) || [3571, 3572, 3573, 3574, 3575].includes(port))) throw Error('T3 cannot occupy the accepted T1/T2 review stages or ports');
if (fixture === 't4' && (['32', '33', '71', '72', '73', '74', '75'].includes(stage) || [3632, 3633, 3571, 3572, 3573, 3574, 3575].includes(port))) throw Error('T4 cannot occupy the accepted T1/T2/T3 review stages or ports');
if (fixture === 't5' && (['32', '33', '35', '36', '71', '72', '73', '74', '75'].includes(stage) || [3632, 3633, 3635, 3636, 3571, 3572, 3573, 3574, 3575].includes(port))) throw Error('T5 cannot occupy the accepted T1/T2/T3/T4 review stages or ports');
if (fixture === 't6' && (['10', '11', '32', '33', '35', '36', '71', '72', '73', '74', '75'].includes(stage) || [3610, 3611, 3632, 3633, 3635, 3636, 3571, 3572, 3573, 3574, 3575].includes(port))) throw Error('T6 cannot occupy accepted previous memory stages or ports');
if (fixture === 't7' && (['10', '11', '12', '13', '32', '33', '35', '36', '65', '71', '72', '73', '74', '75'].includes(stage)
  || [3515, 3610, 3611, 3612, 3613, 3632, 3633, 3635, 3636, 3571, 3572, 3573, 3574, 3575].includes(port))) throw Error('T7 cannot occupy daily or accepted previous stages or ports');
if (buildEnabled && (!production || !httpEnabled || buildReceiptPath)) throw Error('--build requires --production --http and cannot reuse a build receipt');
if (production && (!httpEnabled || !buildEnabled && !buildReceiptPath || reuseDevelopmentOutput)) throw Error('Production HTTP requires a fresh isolated build or matching completed build receipt');

// Read connection configuration in-process without printing it or copying it to
// acceptance receipts. Only loopback administration is permitted.
const diskEnv = {};
for (const directory of [root, web]) for (const file of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
  const target = path.join(directory, file);
  if (fs.existsSync(target)) Object.assign(diskEnv, parse(fs.readFileSync(target)));
}
const configuredAdmin = process.env.ZHIYU_TEST_ADMIN_URL ?? diskEnv.ZHIYU_TEST_ADMIN_URL
  ?? process.env.POSTGRES_URL ?? diskEnv.POSTGRES_URL ?? process.env.DATABASE_URL ?? diskEnv.DATABASE_URL;
if (!configuredAdmin) throw Error('A loopback PostgreSQL fixture administrator is required');
const adminUrl = new URL(configuredAdmin);
if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname)) throw Error('Fixture administration requires loopback PostgreSQL');
const secrets = [...new Set([configuredAdmin, adminUrl.password && decodeURIComponent(adminUrl.password),
  ...Object.entries({ ...diskEnv, ...process.env }).filter(([key]) => /(?:API_KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|POSTGRES_URL|ADMIN_URL)$/.test(key)).map(([, value]) => value),
].filter(value => typeof value === 'string' && value.length > 3))].sort((a, b) => b.length - a.length);
const redact = value => typeof value === 'string' ? secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
  .replace(/postgres(?:ql)?:\/\/[^\s"')]+/g, '[redacted-postgres-url]') : value;
const safeError = error => ({ name: error?.name, code: error?.code, message: redact(String(error?.message ?? error)), stack: redact(error?.stack) });
const name = `zhiyu_test_${randomUUID().replaceAll('-', '')}`;
const owner = randomUUID();
const records = path.join(root, '.runtime', suiteName, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
fs.mkdirSync(records, { recursive: true });
const report = { startedAt: new Date().toISOString(), database: name, databaseScope: 'synthetic_isolated', records,
  nodeVersion: process.version, mode: httpEnabled ? mode : 'integration', httpEnabled, stage, checks: [], cleanup: false,
  productionEffect: 'daily_instance_not_started_or_checked', externalProviders: 'disabled', builds: buildEnabled ? 'requested_fresh_isolated' : 'not_run' };
const writeReport = () => fs.writeFileSync(path.join(records, 'acceptance.json'), JSON.stringify(report, (key, value) => redact(value), 2));
const sourceSummary = snapshot => ({ revision: snapshot.revision, sourceHash: snapshot.sourceHash, fileCount: snapshot.files.length, scope: snapshot.scope });

async function requireUnusedPort() {
  // A bind probe avoids issuing any request to a possibly real running server.
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

/** Only called after a new migrated fixture DB and the shared configuration lock exist. */
async function buildRuntime() {
  const saved = ['tsconfig.json', 'next-env.d.ts'].map(file => ({ file: path.join(web, file), bytes: fs.readFileSync(path.join(web, file)) }));
  const before = captureReleaseSources(root), receiptPath = path.join(records, 'build-receipt.json');
  const receipt = { stage, startedAt: new Date().toISOString(), nodeVersion: process.version, database: name,
    runtimeContract: { authMode: 'local_owner', fixtureOwner: owner, localScheduler: false, startupListeners: false,
      externalProviderCredentials: 'cleared', dailyInstance: 'not_used' }, sourceBefore: before, buildExitCode: null, passed: false,
    configuration: { before: captureMemoryRevisionConfiguration(saved) } };
  const log = fs.openSync(path.join(records, 'build.log'), 'w');
  try {
    Object.assign(process.env, { NODE_ENV: 'production', ZHIYU_REVIEW_BUILD: stage, DEV_USER_ID: owner });
    const configModule = await import('next/dist/server/config.js');
    const { findPagesDir } = await import('next/dist/lib/find-pages-dir.js');
    const config = await (configModule.default.default ?? configModule.default)('phase-production-build', web);
    assert.equal(config.distDir.replaceAll('\\', '/'), `.tmp/next-review-${stage}`);
    assert.notEqual(config.typescript.ignoreBuildErrors, true, 'Production build type checking must remain enabled');
    receipt.typeCheckingEnabled = true;
    const { appDir, pagesDir } = findPagesDir(web);
    receipt.configurationPreparation = await prepareMemoryRevisionNextConfiguration({ web, config, appDir, pagesDir });
    receipt.configuration.prepared = captureMemoryRevisionConfiguration(saved);
    const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
      cwd: web, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=12288', NODE_PATH: path.join(root, 'node_modules') },
    });
    child.stdout.on('data', chunk => fs.writeSync(log, redact(chunk.toString('utf8'))));
    child.stderr.on('data', chunk => fs.writeSync(log, redact(chunk.toString('utf8'))));
    receipt.buildExitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  } catch (error) { receipt.error = safeError(error); }
  finally {
    fs.closeSync(log);
    receipt.configuration.afterBuild = captureMemoryRevisionConfiguration(saved);
    const restoration = restoreMemoryRevisionConfiguration({ saved, prepared: receipt.configuration.prepared, records, label: `${fixture}-build` });
    receipt.configuration.restored = restoration.restored;
    receipt.configuration.restorationDecisions = restoration.restorationDecisions;
    receipt.configurationRestored = restoration.configurationRestored;
    receipt.configurationConflict = restoration.configurationConflict;
    receipt.sourceAfter = captureReleaseSources(root);
    receipt.sourceStable = before.sourceHash === receipt.sourceAfter.sourceHash && before.revision === receipt.sourceAfter.revision;
    const buildIdFile = path.join(web, '.tmp', `next-review-${stage}`, 'BUILD_ID');
    receipt.buildId = receipt.buildExitCode === 0 && fs.existsSync(buildIdFile) ? fs.readFileSync(buildIdFile, 'utf8').trim() : null;
    receipt.completedAt = new Date().toISOString();
    receipt.passed = receipt.buildExitCode === 0 && receipt.typeCheckingEnabled && receipt.sourceStable && receipt.configurationRestored && !!receipt.buildId && !receipt.error;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, (key, value) => redact(value), 2));
  }
  if (!receipt.passed) throw Error(receipt.error?.message ?? (receipt.configurationConflict ? 'Shared configuration changed during isolated build; original and conflicting files were preserved'
    : !receipt.sourceStable ? 'Sources changed during isolated build' : `Isolated ${fixtureLabel} production build failed`));
  buildReceiptPath = receiptPath;
  return { name: `fresh ${fixtureLabel} production webpack build against synthetic isolated database`, passed: true, stage,
    buildId: receipt.buildId, sourceHash: receipt.sourceAfter.sourceHash, typeCheckingEnabled: true, receipt: receiptPath };
}

async function runOwnedHttp(client) {
  return withHostBuildRetention({ workspaceRoot: root, outputPath: path.join(web, '.tmp', `next-review-${stage}`), label: `${suiteName}-${mode}` }, async lease => {
    report.buildRetention = { reservation: lease.receipt.receiptPath, status: lease.receipt.status };
    return runOwnedHttpWithReservedOutput(client);
  });
}
async function runOwnedHttpWithReservedOutput(client) {
  await requireUnusedPort();
  const output = path.join(web, '.tmp', `next-review-${stage}`);
  if (!production && fs.existsSync(output) && !reuseDevelopmentOutput) throw Error('Review output already exists; choose an unused stage or explicitly reuse development output');
  if (buildEnabled && fs.existsSync(output)) throw Error(`Fresh ${fixtureLabel} production build requires an unused review stage; existing output is preserved`);
  const lockPath = path.join(root, '.runtime', 'memory-revision', 'configuration.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lock = fs.openSync(lockPath, 'wx');
  fs.writeSync(lock, JSON.stringify({ pid: process.pid, suite: suiteName, stage, records }));
  const saved = ['tsconfig.json', 'next-env.d.ts'].map(file => ({ file: path.join(web, file), bytes: fs.readFileSync(path.join(web, file)) }));
  let prepared = captureMemoryRevisionConfiguration(saved), child, exited, log, nativeProvider;
  const providerEnvironmentBefore = new Map();
  try {
    if (fixture === 't7') {
      const { startT7NativeHttpProvider } = await import('./memory-module-t7-native-http.mjs');
      nativeProvider = await startT7NativeHttpProvider({ client, owner });
      for (const [key, value] of Object.entries(nativeProvider.environment)) {
        providerEnvironmentBefore.set(key, process.env[key]); process.env[key] = value;
      }
      report.externalProviders = 'synthetic_loopback_only_no_real_model';
    }
    if (buildEnabled) report.checks.push(await buildRuntime());
    if (production) {
      const receipt = JSON.parse(fs.readFileSync(path.resolve(buildReceiptPath), 'utf8'));
      const source = captureReleaseSources(root), buildIdFile = path.join(output, 'BUILD_ID');
      assert.equal(receipt.passed, true, 'Production build receipt must have passed');
      assert.equal(receipt.stage, stage, 'Build receipt stage must match');
      assert.equal(receipt.sourceAfter?.sourceHash, source.sourceHash, 'Production build must match current source');
      assert.ok(fs.existsSync(buildIdFile), 'Production output must already exist');
      assert.equal(receipt.buildId, fs.readFileSync(buildIdFile, 'utf8').trim(), 'Production build identity must match');
      report.buildReceipt = { path: path.resolve(buildReceiptPath), buildId: receipt.buildId, sourceHash: source.sourceHash };
    }
    Object.assign(process.env, { NODE_ENV: mode, ZHIYU_REVIEW_BUILD: stage, DEV_USER_ID: owner });
    if (!production) {
      if (!process.argv.includes('--hostname')) process.argv.push('--hostname', '127.0.0.1');
      const configModule = await import('next/dist/server/config.js');
      const { findPagesDir } = await import('next/dist/lib/find-pages-dir.js');
      const config = await (configModule.default.default ?? configModule.default)('phase-development-server', web);
      assert.equal(config.distDir.replaceAll('\\', '/'), `.tmp/next-review-${stage}/dev`);
      const { appDir, pagesDir } = findPagesDir(web);
      report.configurationPreparation = await prepareMemoryRevisionNextConfiguration({ web, config, appDir, pagesDir });
      prepared = captureMemoryRevisionRuntimeOwnership(saved, stage, mode);
    }
    log = fs.openSync(path.join(records, `${mode}-server.log`), 'w');
    const command = production ? [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1']
      : [path.join(web, 'scripts/start-local-development.mjs'), '--port', String(port), '--hostname', '127.0.0.1'];
    child = spawn(process.execPath, command, { cwd: web, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: mode, DEV_USER_ID: owner, ZHIYU_REVIEW_BUILD: stage, NODE_OPTIONS: '--max-old-space-size=8192', NODE_PATH: path.join(root, 'node_modules') } });
    child.stdout.on('data', chunk => fs.writeSync(log, redact(chunk.toString('utf8'))));
    child.stderr.on('data', chunk => fs.writeSync(log, redact(chunk.toString('utf8'))));
    exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', error => { report.serverStartError = safeError(error); resolve(); }); });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null || report.serverStartError) throw Error(`Owned ${fixtureLabel} server exited before readiness`);
      try {
        const response = await fetch(origin + '/api/identity', { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          const identity = await response.json();
          assert.equal(identity.mode, 'local_owner'); assert.equal(identity.actorId, owner);
          ready = true; break;
        }
      } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw Error(`Owned ${fixtureLabel} server readiness failed`);
    prepared = captureMemoryRevisionRuntimeOwnership(saved, stage, mode);
    if (fixture === 't1') {
      const { checkMemoryModuleT1Http } = await import('./memory-module-t1-http.mjs');
      report.checks.push(await checkMemoryModuleT1Http({ client, owner, origin }));
    } else if (fixture === 't2') {
      const { checkMemoryModuleT2Http } = await import('./memory-module-t2-http.mjs');
      report.checks.push(await checkMemoryModuleT2Http({ client, owner, origin, records, mode }));
    } else if (fixture === 't3') {
      const { checkMemoryModuleT3Http } = await import('./memory-module-t3-http.mjs');
      report.checks.push(await checkMemoryModuleT3Http({ client, owner, origin, records, mode }));
    } else if (fixture === 't4') {
      const { checkMemoryModuleT4Http } = await import('./memory-module-t4-http.mjs');
      report.checks.push(await checkMemoryModuleT4Http({ client, owner, origin, records, mode }));
    } else if (fixture === 't5') {
      const { checkMemoryModuleT5Http } = await import('./memory-module-t5-http.mjs');
      report.checks.push(await checkMemoryModuleT5Http({ client, owner, origin, records, mode }));
    } else if (fixture === 't6') {
      const { checkMemoryModuleT6Http } = await import('./memory-module-t6-http.mjs');
      report.checks.push(await checkMemoryModuleT6Http({ client, owner, origin, records, mode }));
    } else {
      const { checkMemoryModuleT7Http } = await import('./memory-module-t7-http.mjs');
      report.checks.push(await checkMemoryModuleT7Http({ client, owner, origin, records, mode }));
      report.checks.push(await nativeProvider.check({ origin, records, mode }));
    }
  } finally {
    if (child && child.exitCode === null && child.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch (error) { try { process.kill(child.pid, 0); throw error; } catch (probe) { if (probe.code !== 'ESRCH') throw probe; } }
      } else child.kill('SIGTERM');
      await exited;
    }
    if (log !== undefined) fs.closeSync(log);
    try {
      if (!production) prepared = captureMemoryRevisionRuntimeOwnership(saved, stage, mode);
      report.configuration = restoreMemoryRevisionConfiguration({ saved, prepared, records, label: `${fixture}-runtime` });
    } finally {
      try { await nativeProvider?.close(); }
      finally {
        for (const [key, value] of providerEnvironmentBefore) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        fs.closeSync(lock); fs.unlinkSync(lockPath);
      }
    }
    if (report.configuration.configurationConflict || !report.configuration.configurationRestored) throw Error('Shared configuration changed; original and conflicting files were preserved');
  }
}

adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
let client, created = false;
try {
  await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
  const fixtureUrl = new URL(adminUrl); fixtureUrl.pathname = `/${name}`;
  client = postgres(fixtureUrl.toString(), { max: 8, onnotice: () => {} });
  const migrationsFolder = path.join(web, 'lib/db/migrations');
  const migrations = readMigrationFiles({ migrationsFolder });
  if (fixture === 't2') {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
    const target = journal.entries.find(entry => /^0162_/.test(entry.tag));
    if (!target) throw Error('T2 revision migration is not registered');
    const index = migrations.findIndex(migration => migration.folderMillis === target.when);
    if (index < 1 || !migrations[index].sql.join('\n').includes('interaction_task_revisions')) throw Error('T2 revision migration identity is unexpected');
    await new PgDialect().migrate(migrations.slice(0, index), drizzle(client)._.session, { migrationsTable: '__drizzle_migrations' });
    const { seedMemoryModuleT2LegacyTasks } = await import('./memory-module-t2-migration-fixture.mjs');
    report.legacyMigrationFixture = await seedMemoryModuleT2LegacyTasks(client, name);
  }
  await new PgDialect().migrate(migrations, drizzle(client)._.session, { migrationsTable: '__drizzle_migrations' });
  for (const key of Object.keys(diskEnv)) process.env[key] = '';
  for (const key of Object.keys(process.env)) if (/(?:API_KEY|SECRET|TOKEN|PASSWORD|LLM_(?:MODEL|BASE_URL)|SERVICE_URL)$/.test(key)) process.env[key] = '';
  Object.assign(process.env, { NODE_ENV: 'test', ZHIYU_TEST_MODE: 'integration', ZHIYU_TEST_DATABASE_URL: fixtureUrl.toString(),
    POSTGRES_URL: fixtureUrl.toString(), DATABASE_URL: fixtureUrl.toString(), AUTH_MODE: 'local_owner', AUTH_SECRET: `synthetic-${fixture}-fixture-only`, DEV_USER_ID: owner,
    TAURI_MODE: 'false', IS_TAURI: 'false', ENABLE_LOCAL_SCHEDULER: 'false', ENABLE_STARTUP_LISTENERS: 'false',
    WORK_HARNESS_EVOLUTION_ENABLED: 'false', REPORT_QUALITY_EVALUATOR_ENABLED: 'false',
    BRAIN_RECALL_PLANNER_LLM_API_KEY: '', BRAIN_RECALL_PLANNER_LLM_BASE_URL: '', BRAIN_RECALL_PLANNER_LLM_MODEL: '',
    MEMORY_RECALL_LLM_API_KEY: '', MEMORY_RECALL_LLM_BASE_URL: '', MEMORY_RECALL_LLM_MODEL: '', LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '' });
  if (['t5', 't6', 't7'].includes(fixture)) {
    process.env.MEMORY_ARTIFACT_STORAGE_ROOT = path.join(records, 'private-objects');
    fs.mkdirSync(process.env.MEMORY_ARTIFACT_STORAGE_ROOT, { recursive: true });
    report.artifactStorage = { provider: 'private_local', scope: 'owned_synthetic_directory', path: process.env.MEMORY_ARTIFACT_STORAGE_ROOT };
  }
  if (fixture === 't7') {
    process.env.ZHIYU_APP_DATA_DIR = path.join(records, 'app-data');
    fs.mkdirSync(process.env.ZHIYU_APP_DATA_DIR, { recursive: true });
    report.appDataStorage = { scope: 'owned_synthetic_directory', path: process.env.ZHIYU_APP_DATA_DIR };
  }
  await client`INSERT INTO "User"(id,email) VALUES (${owner},${owner + '@example.invalid'})`;
  const before = captureReleaseSources(root); report.sources = { before: sourceSummary(before) };
  if (fixture === 't1') {
    const { checkMemoryModuleT1 } = await import('./memory-module-t1.check.ts');
    report.checks.push(await checkMemoryModuleT1(client));
  } else if (fixture === 't2') {
    const { checkMemoryModuleT2 } = await import('./memory-module-t2.check.ts');
    report.checks.push(await checkMemoryModuleT2(client, report.legacyMigrationFixture));
  } else if (fixture === 't3') {
    const { checkMemoryModuleT3 } = await import('./memory-module-t3.check.ts');
    report.checks.push(await checkMemoryModuleT3(client));
  } else if (fixture === 't4') {
    const { checkMemoryModuleT4 } = await import('./memory-module-t4.check.ts');
    report.checks.push(await checkMemoryModuleT4(client));
  } else if (fixture === 't5') {
    const { checkMemoryModuleT5 } = await import('./memory-module-t5.check.ts');
    await checkMemoryModuleT5(client, owner, check => { report.checks.push(check); writeReport(); });
  } else if (fixture === 't6') {
    const { checkMemoryModuleT6 } = await import('./memory-module-t6.check.ts');
    await checkMemoryModuleT6(client, owner, check => { report.checks.push(check); writeReport(); });
  } else {
    const { checkMemoryModuleT7 } = await import('./memory-module-t7.check.ts');
    await checkMemoryModuleT7(client, owner, check => { report.checks.push(check); writeReport(); });
  }
  if (httpEnabled) await runOwnedHttp(client);
  report.sources.after = sourceSummary(captureReleaseSources(root));
  report.sources.stable = report.sources.before.sourceHash === report.sources.after.sourceHash && report.sources.before.revision === report.sources.after.revision;
  if (!report.sources.stable) throw Error('Sources changed during acceptance; preserve this partial receipt and rerun against frozen sources');
} catch (error) { report.error = safeError(error); process.exitCode = 1; }
finally {
  if (fixture === 't7' && report.appDataStorage) {
    try {
      writeReport();
      const { cleanupMemoryModuleT7AppData } = await import('./memory-module-t7-app-data-cleanup.mjs');
      report.appDataCleanup = await cleanupMemoryModuleT7AppData(records);
    } catch (error) { report.appDataCleanupError = safeError(error); process.exitCode = 1; }
  }
  if (['t5', 't6', 't7'].includes(fixture) && client && report.artifactStorage) {
    try {
      const { cleanupMemoryModuleT5 } = await import('./memory-module-t5-cleanup.mjs');
      report.artifactCleanup = await cleanupMemoryModuleT5({ client, records, database: name });
    } catch (error) { report.artifactCleanupError = safeError(error); process.exitCode = 1; }
  }
  try { const { closePostgresDb } = await import('../../lib/db/adapters/postgres.ts'); await closePostgresDb(); }
  catch (error) { report.connectionCleanupError = safeError(error); process.exitCode = 1; }
  if (client) await client.end();
  if (created) {
    try {
      assert.match(name, /^zhiyu_test_[a-f0-9]{32}$/);
      await admin.unsafe(`DROP DATABASE "${name}"`); report.cleanup = true;
    } catch (error) { report.databaseCleanupError = safeError(error); process.exitCode = 1; }
  }
  await admin.end();
  report.completedAt = new Date().toISOString();
  report.passed = !report.error && !report.appDataCleanupError && !report.artifactCleanupError && !report.connectionCleanupError && !report.databaseCleanupError && report.cleanup;
  writeReport();
  console.log(JSON.stringify({ passed: report.passed, records, checks: report.checks.map(check => ({ name: check.name, passed: check.passed })),
    cleanup: report.cleanup, error: report.error ?? report.databaseCleanupError ?? null }, null, 2));
}
