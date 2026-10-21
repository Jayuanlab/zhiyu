import Module from "node:module";

type ModuleLoad = (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) => unknown;

const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only" || request.includes("server-only")) {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...valueParts] = arg.slice(2).split("=");
    args.set(key, valueParts.length > 0 ? valueParts.join("=") : true);
  }
  return args;
}

function stringArg(
  args: Map<string, string | boolean>,
  name: string,
): string | undefined {
  const value = args.get(name);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function collectPostgresDiagnostics() {
  const [{ sql }, { db }] = await Promise.all([
    import("drizzle-orm"),
    import("@/lib/db/client"),
  ]);
  const rowsFrom = <T>(result: unknown): T[] => {
    if (Array.isArray(result)) return result as T[];
    return (
      (result as { rows?: T[] } | null | undefined)?.rows ??
      []
    );
  };
  const [connectionResult, tablesResult, columnsResult, migrationsResult] =
    await Promise.all([
      db.execute(
        sql`
          select
            current_database() as "databaseName",
            current_schema() as "schemaName"
        `,
      ),
      db.execute(
        sql`
          select table_schema as "tableSchema", table_name as "tableName"
          from information_schema.tables
          where table_name like '%brain%'
          order by table_schema, table_name
        `,
      ),
    db.execute(
      sql`
        select table_schema as "tableSchema", column_name as "columnName"
        from information_schema.columns
        where table_name = 'brain_memories'
        order by table_schema, ordinal_position
      `,
    ),
    db.execute(
      sql`
        select id, hash, created_at as "createdAt"
        from drizzle.__drizzle_migrations
        order by id desc
        limit 5
      `,
    ),
    ]);
  const connection =
    rowsFrom<{ databaseName: string; schemaName: string }>(
      connectionResult,
    )[0] ?? null;
  const tables = rowsFrom<{ tableSchema: string; tableName: string }>(
    tablesResult,
  );
  const columns = rowsFrom<{ tableSchema: string; columnName: string }>(
    columnsResult,
  );
  const migrations = rowsFrom<{
    id: number;
    hash: string;
    createdAt: string | number;
  }>(migrationsResult);
  return {
    connection,
    brainTables: tables,
    brainMemoryColumns: columns,
    recentDrizzleMigrations: migrations,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId =
    stringArg(args, "user") ?? stringArg(args, "user-id") ?? process.env.USER_ID;
  const warnOnly = args.has("warn-only") || process.env.WARN_ONLY === "1";
  const jsonOnly = args.has("json");

  if (!userId) {
    throw new Error(
      "Usage: USER_ID=<id> pnpm db:brain:check or pnpm db:brain:check -- --user=<id> [--warn-only] [--json]",
    );
  }
  if (!isUuid(userId)) {
    throw new Error(
      `Brain canonical storage check requires a UUID user id; got "${userId}".`,
    );
  }

  const [{ getBrainCanonicalStorageStatus }, { closeDb }] = await Promise.all([
    import("@/lib/memory/governance/canonical-storage-status"),
    import("@/lib/db/adapters"),
  ]);

  try {
    const status = await getBrainCanonicalStorageStatus({ userId });
    const diagnostics =
      !status.migrationReady || status.status === "migration_missing"
        ? await collectPostgresDiagnostics().catch((error) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
        : null;
    const payload = {
      userId,
      ok: status.migrationReady && status.status === "ok",
      status,
      diagnostics,
    };

    if (jsonOnly) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(
        `[BrainCanonicalStorage] user=${userId} status=${status.status} migrationReady=${status.migrationReady} total=${status.totalMemories} canonicalKindCoverage=${status.canonicalKindCoverage.toFixed(3)} canonicalGroupCoverage=${status.canonicalGroupCoverage.toFixed(3)} sampleQueryMs=${status.sampleQueryMs ?? "n/a"}`,
      );
      for (const warning of status.warnings) {
        console.warn(`[BrainCanonicalStorage] warning: ${warning}`);
      }
      if (status.error) {
        console.error(`[BrainCanonicalStorage] error: ${status.error}`);
      }
      if (diagnostics) {
        console.log(
          `[BrainCanonicalStorage] diagnostics=${JSON.stringify(diagnostics)}`,
        );
      }
    }

    if (!payload.ok && !warnOnly) {
      process.exitCode = 1;
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("[BrainCanonicalStorage] failed", error);
  process.exit(1);
});
