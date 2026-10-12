import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function migrationStageError(stage, code, error) {
  const failed = new Error(code);
  failed.stage = stage;
  const driverCode = error?.cause?.code || error?.code;
  if (typeof driverCode === 'string' && /^[0-9A-Z]{5}$/.test(driverCode)) failed.driverCode = driverCode;
  return failed;
}

async function migrationStage(stage, code, action) {
  try { return await action(); }
  catch (error) { throw migrationStageError(stage, code, error); }
}

function databaseConnection(value, database, errorCode) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(errorCode); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !loopbackHosts.has(parsed.hostname) || parsed.pathname !== `/${database}` ||
      !parsed.username || parsed.search || parsed.hash) throw new Error(errorCode);
  return parsed;
}

export function migrationConfiguration(env = process.env) {
  const databaseUrl = env.POSTGRES_URL?.trim() || env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('migration_database_required');
  if (env.POSTGRES_URL && env.DATABASE_URL && env.POSTGRES_URL !== env.DATABASE_URL) {
    throw new Error('migration_database_configuration_conflict');
  }
  const target = databaseConnection(databaseUrl, 'zhiyu', 'migration_target_invalid');
  const ownerId = env.ZHIYU_BOOTSTRAP_OWNER_ID?.trim().toLowerCase();
  if (!ownerId || !uuidPattern.test(ownerId)) throw new Error('migration_owner_required');
  const bootstrapUrl = env.ZHIYU_BOOTSTRAP_DB_URL?.trim();
  if (bootstrapUrl) {
    const admin = databaseConnection(bootstrapUrl, 'postgres', 'migration_bootstrap_invalid');
    if (admin.hostname !== target.hostname || (admin.port || '5432') !== (target.port || '5432') ||
        admin.username !== target.username || admin.password !== target.password) {
      throw new Error('migration_bootstrap_target_mismatch');
    }
  }
  return { databaseUrl, bootstrapUrl, ownerId };
}

export function validateMigrationFiles(migrationsFolder) {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  let journal;
  try { journal = JSON.parse(readFileSync(journalPath, 'utf8')); }
  catch { throw new Error('migration_journal_invalid'); }
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) throw new Error('migration_journal_invalid');
  for (const entry of journal.entries) {
    if (typeof entry.tag !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.tag) ||
        !existsSync(join(migrationsFolder, `${entry.tag}.sql`))) throw new Error('migration_sql_missing');
  }
  return journal.entries.length;
}

export async function runMigrations(configuration, dependencies, migrationsFolder) {
  const migrationCount = validateMigrationFiles(migrationsFolder);
  const { postgresFactory, drizzleFactory, migrateFn } = dependencies;
  const options = { max: 1, connect_timeout: 10, onnotice: () => {} };
  if (configuration.bootstrapUrl) {
    const admin = postgresFactory(configuration.bootstrapUrl, options);
    try {
      await migrationStage('database_bootstrap', 'migration_database_bootstrap_failed', async () => {
        const existing = await admin`SELECT datname FROM pg_database WHERE datname = ${'zhiyu'}`;
        if (existing.length === 0) {
          try { await admin.unsafe('CREATE DATABASE "zhiyu"'); }
          catch (error) { if (error?.code !== '42P04') throw error; }
        }
      });
    } finally { await admin.end({ timeout: 5 }); }
  }
  const connection = postgresFactory(configuration.databaseUrl, options);
  try {
    // The canonical schema stores embeddings as text and application queries
    // cast them to vector. The journal does not enable the extension, so a
    // fresh installer-owned database must prepare it explicitly and fail if
    // the bundled PostgreSQL extension cannot be loaded.
    await migrationStage('vector_setup', 'migration_extension_failed', () => connection.unsafe('CREATE EXTENSION IF NOT EXISTS vector'));
    await migrationStage('schema_migrate', 'migration_schema_failed', () => migrateFn(drizzleFactory(connection), { migrationsFolder }));
    await migrationStage('owner_bootstrap', 'migration_owner_failed', () => connection`INSERT INTO "User" ("id", "email", "name")
      VALUES (${configuration.ownerId}, ${'owner@zhiyu.local'}, ${'Local Owner'})
      ON CONFLICT ("id") DO NOTHING`);
    return { event: 'migration_completed', migrationCount, ownerId: configuration.ownerId };
  } finally { await connection.end({ timeout: 5 }); }
}

export async function main(env = process.env) {
  // Validate before importing a driver or opening any connection. Never load dotenv.
  const configuration = migrationConfiguration(env);
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), 'sql');
  validateMigrationFiles(migrationsFolder);
  const [{ default: postgresFactory }, { drizzle: drizzleFactory }, { migrate: migrateFn }] = await Promise.all([
    import('postgres'), import('drizzle-orm/postgres-js'), import('drizzle-orm/postgres-js/migrator'),
  ]);
  return runMigrations(configuration, { postgresFactory, drizzleFactory, migrateFn }, migrationsFolder);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    // Driver messages may contain credentials or SQL data; expose a stable code only.
    const safeCode = /^migration_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'migration_failed';
    console.error(JSON.stringify({ event: 'migration_failed', code: safeCode,
      stage: /^[a-z_]{1,40}$/.test(error?.stage || '') ? error.stage : undefined,
      driverCode: /^[0-9A-Z]{5}$/.test(error?.driverCode || '') ? error.driverCode : undefined }));
    process.exitCode = 1;
  });
}
