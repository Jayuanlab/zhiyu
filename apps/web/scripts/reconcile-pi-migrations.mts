/** Preserve the original migration ledger when moving from the later-dated
 * model-center snapshot to Pi's earlier-dated, previously unapplied migrations.
 * Dry-run by default. Only the reviewed Pi additions and model center may apply.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { readFile, writeFile } from 'node:fs/promises';
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });
const url = process.env.POSTGRES_URL;
if (!url) throw Error('POSTGRES_URL_required');
const apply = process.argv.includes('--apply'),
  sql = postgres(url, { max: 1, onnotice() {} });
const journal = JSON.parse(
  await readFile('./lib/db/migrations/meta/_journal.json', 'utf8'),
);
const migrations = readMigrationFiles({
  migrationsFolder: './lib/db/migrations',
});
try {
  const receipt = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('zhiyu:pi-branch-migration',0))`;
    const ledger =
      await tx`SELECT hash,created_at FROM drizzle.__drizzle_migrations`;
    const pending = migrations
      .map((migration, index) => ({
        ...migration,
        tag: journal.entries[index].tag,
        index,
      }))
      .filter(
        (migration) =>
          !ledger.some(
            (row) =>
              row.hash === migration.hash ||
              Number(row.created_at) === migration.folderMillis,
          ),
      );
    // Baseline migrations must already exist; never guess how to repair a different schema.
    if (
      pending.some(
        (migration) =>
          migration.index < 146 || !/^01(?:5[5-9]|6[0-8])_/.test(migration.tag),
      )
    )
      throw Error('unreviewed_baseline_migration_gap');
    if (apply)
      for (const migration of pending) {
        for (const statement of migration.sql)
          if (statement.trim()) await tx.unsafe(statement);
        await tx`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(${migration.hash},${migration.folderMillis})`;
      }
    return {
      at: new Date().toISOString(),
      applied: apply,
      pending: pending.map((m) => ({
        tag: m.tag,
        hash: m.hash,
        when: m.folderMillis,
      })),
      preservedLedgerRows: ledger.length,
    };
  });
  await writeFile(
    '../../.runtime/pi-migration-reconciliation.json',
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await sql.end({ timeout: 2 });
}
