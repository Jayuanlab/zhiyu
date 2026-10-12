import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
import { buildWorkerBundle } from './build-worker.mjs';
import { copyDependencyClosure, resolvePackage } from './release-lib.mjs';
import { migrationConfiguration, runMigrations } from './migrate-entry.mjs';
import { availablePort, childEnvironment, freshToken, prepareDataDirectory, redact, atomicJson } from '../../packaging/windows/runtime/security.mjs';

const workspaceRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const vendorRoot = resolve(workspaceRoot, 'output', 'windows-toolchain', 'extracted', 'pgsql');
const node = resolve(workspaceRoot, 'output', 'windows-toolchain', 'extracted', 'node-v24.14.1-win-x64', 'node.exe');
for (const file of [node, join(vendorRoot, 'bin', 'initdb.exe'), join(vendorRoot, 'bin', 'pg_ctl.exe')]) if (!existsSync(file)) throw new Error('smoke_vendor_missing');
const root = await mkdtemp(join(tmpdir(), 'zhiyu-fresh-migration-'));
const stageRoot = join(root, 'payload'); await mkdir(stageRoot);
const dataDir = prepareDataDirectory(join(root, 'data'), stageRoot);
const logDir = join(dataDir, 'logs'), cluster = join(dataDir, 'postgres');
const ownerId = randomUUID();
const config = { ownerId, databasePassword: freshToken(), authSecret: freshToken(), encryptionKey: freshToken(), desiredStatus: 'stopped' };
const port = await availablePort();
const env = childEnvironment(dataDir, config, port, 3515);
env.PATH = [join(vendorRoot, 'bin'), dirname(node), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';');
const secrets = [config.databasePassword, config.authSecret, config.encryptionKey];
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), directory: root, ownerId, port, checks: [], stopConfirmed: false };
atomicJson(join(root, 'smoke-state.json'), report);
console.log(JSON.stringify({ event: 'fresh_migration_smoke_started', directory: root, port }));

async function command(executable, args, label, timeoutMs = 180000) {
  return new Promise((accept, reject) => {
    const log = createWriteStream(join(logDir, `${label}.log`));
    const child = spawn(executable, args, { cwd: dataDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); log.end(); error ? reject(error) : accept(tail); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${label}_timeout`)); }, timeoutMs);
    const capture = chunk => { const text = redact(chunk.toString('utf8'), secrets); log.write(text); tail = (tail + text).slice(-10000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => finish(new Error(`${label}_spawn_${error.code}`)));
    child.once('exit', code => finish(code === 0 ? null : new Error(`${label}_exit_${code}`)));
  });
}

function check(name, detail = {}) { report.checks.push({ name, passed: true, ...detail }); atomicJson(join(root, 'smoke-state.json'), report); }
let sql;
try {
  const metadata = await buildWorkerBundle({ workspaceRoot, stageRoot });
  const migrationPackages = metadata.externalDependencies.filter(record => ['postgres', 'drizzle-orm'].includes(record.packageName)).map(record => ({ ...resolvePackage(record.packageName, record.resolveOrigin), releasePackageName: record.releasePackageName }));
  const closure = await copyDependencyClosure(migrationPackages, join(stageRoot, 'node_modules'));
  check('latest portable migration built', { migrationCount: metadata.migrations.migrationCount, dependencyPackages: closure.packageCount });
  const passwordFile = join(dataDir, 'private', 'initdb-password'); await writeFile(passwordFile, config.databasePassword, 'utf8');
  await command(join(vendorRoot, 'bin', 'initdb.exe'), ['-D', cluster, '--username=zhiyu', `--pwfile=${passwordFile}`, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C'], 'initdb');
  const { unlink } = await import('node:fs/promises'); await unlink(passwordFile);
  check('fresh private cluster initialized');
  await command(join(vendorRoot, 'bin', 'pg_ctl.exe'), ['-D', cluster, '-l', join(logDir, 'postgres.log'), '-w', '-t', '60', '-o', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`, 'start'], 'postgres-start', 65000);
  check('private loopback database started');
  try { await command(node, ['--conditions=react-server', metadata.migrationEntry], 'migration-first'); }
  catch (error) {
    // The installed CLI intentionally reports stable error codes. Diagnose only
    // this explicitly-created test database and keep details in the private log.
    const require = createRequire(join(workspaceRoot, 'apps', 'web', 'package.json'));
    try { await runMigrations(migrationConfiguration(env), { postgresFactory: require('postgres'), drizzleFactory: require('drizzle-orm/postgres-js').drizzle, migrateFn: require('drizzle-orm/postgres-js/migrator').migrate }, join(stageRoot, 'migrations', 'sql')); }
    catch (diagnosis) {
      await writeFile(join(logDir, 'migration-diagnostic.json'), redact(JSON.stringify({ name: diagnosis.name, message: diagnosis.message, stage: diagnosis.stage, driverCode: diagnosis.driverCode, code: diagnosis.code, cause: diagnosis.cause ? { name: diagnosis.cause.name, message: diagnosis.cause.message, code: diagnosis.cause.code, table_name: diagnosis.cause.table_name, constraint_name: diagnosis.cause.constraint_name } : null }, null, 2), secrets), 'utf8');
      report.diagnostic = { stage: diagnosis.stage, code: diagnosis.driverCode || diagnosis.cause?.code || diagnosis.code, message: redact(diagnosis.cause?.message || diagnosis.message, secrets).slice(0, 500) };
    }
    throw error;
  }
  check('portable first migration completed');
  const require = createRequire(join(workspaceRoot, 'apps', 'web', 'package.json'));
  sql = require('postgres')(env.POSTGRES_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const [extension] = await sql`SELECT extname, extversion FROM pg_extension WHERE extname='vector'`;
  assert.equal(extension?.extname, 'vector'); check('vector extension available', { version: extension.extversion });
  const [owner] = await sql`SELECT id,email,name FROM "User" WHERE id=${ownerId}`;
  assert.equal(owner?.id, ownerId); assert.equal(owner?.email, 'owner@zhiyu.local'); check('independent owner bootstrapped', { id: owner.id });
  const [first] = await sql.unsafe('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
  const journal = JSON.parse(await readFile(join(stageRoot, 'migrations', 'sql', 'meta', '_journal.json'), 'utf8'));
  assert.equal(first.count, journal.entries.length); check('full migration journal applied', { count: first.count });
  await sql`CREATE TABLE installer_smoke_fixture(id int primary key, note text not null)`;
  await sql`INSERT INTO installer_smoke_fixture(id,note) VALUES(1,${'preserve-first-run'})`;
  await command(node, ['--conditions=react-server', metadata.migrationEntry], 'migration-second');
  const [second] = await sql.unsafe('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
  const [owners] = await sql`SELECT count(*)::int AS count FROM "User" WHERE id=${ownerId}`;
  const [fixture] = await sql`SELECT note FROM installer_smoke_fixture WHERE id=1`;
  assert.equal(second.count, first.count); assert.equal(owners.count, 1); assert.equal(fixture.note, 'preserve-first-run');
  check('repeat migration preserves journal owner and user data', { count: second.count });
} catch (error) {
  report.error = redact(error.message, secrets); process.exitCode = 1;
} finally {
  if (sql) await sql.end({ timeout: 5 });
  if (existsSync(join(cluster, 'PG_VERSION'))) {
    try { await command(join(vendorRoot, 'bin', 'pg_ctl.exe'), ['-D', cluster, '-m', 'fast', '-w', '-t', '60', 'stop'], 'postgres-stop', 65000); report.stopConfirmed = true; }
    catch (error) {
      try { await command(join(vendorRoot, 'bin', 'pg_ctl.exe'), ['-D', cluster, 'status'], 'postgres-final-status', 10000); report.stopError = error.message; process.exitCode = 1; }
      catch (statusError) { if (statusError.message === 'postgres-final-status_exit_3') report.stopConfirmed = true; else { report.stopError = statusError.message; process.exitCode = 1; } }
    }
  }
  report.finishedAt = new Date().toISOString(); atomicJson(join(root, 'smoke-state.json'), report);
  console.log(JSON.stringify({ event: 'fresh_migration_smoke_finished', directory: root, checks: report.checks, error: report.error, diagnostic: report.diagnostic, stopConfirmed: report.stopConfirmed }));
}
