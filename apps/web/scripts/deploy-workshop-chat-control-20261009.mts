import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Explicit owner-authorized deployment. Never output connection/provider values.
config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
const mode = process.argv[2];
assert(["inspect", "migrate", "verify"].includes(mode), "explicit_deployment_phase_required");
assert.equal(process.env.ZHIYU_RUNTIME_MODE, "worker");
assert.equal(process.env.ZHIYU_REVIEW_BUILD, "44");
assert(!process.env.ZHIYU_TEST_MODE && !process.env.ZHIYU_TEST_DATABASE_URL, "test_environment_forbidden");
const ownerId = process.env.ZHIYU_RUNTIME_OWNER_ID!;
assert.match(ownerId, /^[0-9a-f-]{36}$/i);
const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
assert(url, "database_required");
const parsed = new URL(url);
assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname), "local_database_required");
const migrationRoot = new URL("../lib/db/migrations/", import.meta.url);
const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrationRoot), "utf8"));
const latest = journal.entries.at(-1), previous = journal.entries.at(-2);
assert.equal(latest.tag, "0160_add_workshop_chat_control");
const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
const report: Record<string, unknown> = { phase: mode, at: new Date().toISOString(), ownerId, modelCalls: 0, externalActions: 0 };
try {
  const before = await sql`SELECT id,created_at,hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
  report.beforeMigration = { id: before[0].id, when: String(before[0].created_at) };
  assert([String(previous.when), String(latest.when)].includes(String(before[0].created_at)), "unexpected_pending_migrations");
  const active = await sql`SELECT count(*)::int AS count FROM workshop_execution_leases l JOIN workshops w ON w.id=l.workshop_id
    WHERE w.user_id=${ownerId}::uuid AND l.phase='running' AND l.lease_until>now()`;
  report.activeWorkLeases = active[0].count;
  const target = await sql`SELECT id,name,status FROM workshops WHERE id='b6e7ddb1-c699-4898-afa5-3d1804d6edd1'::uuid AND user_id=${ownerId}::uuid`;
  report.target = target[0] ?? null;
  report.targetLoops = await sql`SELECT id,name,status FROM loops WHERE workshop_id='b6e7ddb1-c699-4898-afa5-3d1804d6edd1'::uuid AND user_id=${ownerId}::uuid ORDER BY id`;
  if (mode === "migrate") {
    assert.equal(active[0].count, 0, "execution_lease_still_active");
    await migrate(drizzle(sql), { migrationsFolder: new URL(migrationRoot).pathname.replace(/^\/(?=[A-Za-z]:)/, "") });
  }
  const after = await sql`SELECT id,created_at,hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
  report.afterMigration = { id: after[0].id, when: String(after[0].created_at) };
  if (mode !== "inspect") {
    assert.equal(String(after[0].created_at), String(latest.when));
    const digest = createHash("sha256").update(await readFile(new URL(latest.tag + ".sql", migrationRoot))).digest("hex");
    assert.equal(after[0].hash, digest, "migration_hash_mismatch");
    report.tables = await sql`SELECT (SELECT count(*)::int FROM workshop_chat_contexts WHERE owner_id=${ownerId}::uuid) AS contexts,
      (SELECT count(*)::int FROM workshop_chat_work_items WHERE owner_id=${ownerId}::uuid) AS items,
      (SELECT count(*)::int FROM workshop_chat_deliveries WHERE owner_id=${ownerId}::uuid) AS deliveries`;
    report.buildId = (await readFile(new URL("../.tmp/next-review-44/BUILD_ID", import.meta.url), "utf8")).trim();
    if (mode === "verify") {
      const get = (path: string) => fetch("http://127.0.0.1:3515" + path, { signal: AbortSignal.timeout(15000), cache: "no-store" });
      const identity = await get("/api/identity"); assert.equal(identity.status, 200);
      assert.equal((await identity.json()).actorId, ownerId);
      const runtime = await get("/api/runtime/status"); assert.equal(runtime.status, 200);
      const worker = (await runtime.json()).worker;
      assert.equal(worker.online, true); assert.equal(worker.phase, "running");
      assert(worker.modules.some((module: any) => module.name === "chat-result-delivery" && !module.lastError));
      report.worker = { instanceId: worker.instanceId, online: worker.online, phase: worker.phase,
        heartbeatAgeMs: worker.heartbeatAgeMs, modules: worker.modules.map((module: any) => ({ name: module.name, phase: module.phase,
          lastSuccessAt: module.lastSuccessAt, lastError: module.lastError, inFlight: module.inFlight })) };
      const asset = await get(`/_next/static/${report.buildId}/_buildManifest.js`); assert.equal(asset.status, 200);
      const served = Buffer.from(await asset.arrayBuffer());
      const compiled = await readFile(new URL(`../.tmp/next-review-44/static/${report.buildId}/_buildManifest.js`, import.meta.url));
      assert.deepEqual(served, compiled, "served_build_asset_mismatch");
      report.buildAssetHash = createHash("sha256").update(served).digest("hex");
      report.pages = [];
      for (const path of ["/", "/workshop"]) { const page = await get(path); assert.equal(page.status, 200); (report.pages as any[]).push({ path, status: page.status }); }
    }
  }
  const directory = new URL("../../../docs/verification/artifacts/workshop-chat-control-2026-10-09/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(`deployment-${mode}.json`, directory), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, ...report }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, phase: mode, reason: error instanceof assert.AssertionError ? error.message : "deployment_database_operation_failed", code: typeof (error as any)?.code === "string" ? (error as any).code : undefined }));
  process.exitCode = 1;
} finally { await sql.end({ timeout: 2 }); }
