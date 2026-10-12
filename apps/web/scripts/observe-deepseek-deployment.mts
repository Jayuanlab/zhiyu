/** Read-only restart guard and deployment evidence. Does not launch a worker. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
const phase = process.argv[2];
assert(["before", "after"].includes(phase), "phase_required");
const targetReview = process.argv[3] ?? "46";
assert(["46", "47", "48", "49", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60"].includes(targetReview), "review_required");
const artifactFolder = targetReview === "60" ? "research-reader-first-2026-10-09" : ["58", "59"].includes(targetReview) ? "research-report-quality-2026-10-09"
  : targetReview === "46" ? "deepseek-reading-rerun-2026-10-09" : "deepseek-report-rerun-2026-10-09";
const ownerId = process.env.ZHIYU_RUNTIME_OWNER_ID;
assert(ownerId && /^[0-9a-f-]{36}$/i.test(ownerId), "owner_required");
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
assert(databaseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname), "local_database_required");
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { statement_timeout: 10000 } });
try {
  const observation = await sql.begin("isolation level repeatable read read only", async tx => {
    const busy = await tx`SELECT r.id,r.workshop_id,r.status FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id WHERE w.user_id=${ownerId}::uuid AND r.status IN ('queued','running','cancel_requested')`;
    const leases = await tx`SELECT i.id,i.phase,i.desired_status,l.lease_until,l.lease_until>clock_timestamp() AS fresh FROM runtime_owner_leases l JOIN runtime_instances i ON i.id=l.instance_id WHERE l.owner_id=${ownerId}::uuid`;
    return { busy, leases };
  });
  const folder = "C:/Users/96012/.codex/eval-sandboxes/workshop-chat-control-production-20261009/";
  const settings = JSON.parse(await readFile(folder + "launch-settings.json", "utf8"));
  const launcher = JSON.parse(await readFile(folder + "launcher-state.json", "utf8"));
  const buildId = (await readFile(`.tmp/next-review-${settings.review}/BUILD_ID`, "utf8")).trim();
  assert.equal(buildId, settings.buildId, "configured_build_mismatch");
  let served: Record<string, unknown> | null = null;
  if (phase === "before") assert.equal(observation.busy.length, 0, "owner_has_unsettled_runs");
  if (phase === "after") {
    assert.equal(settings.review, targetReview, "requested_deployment_not_loaded");
    const response = await fetch(`http://127.0.0.1:${settings.port}/_next/static/${buildId}/_buildManifest.js`);
    assert.equal(response.status, 200, "build_not_served");
    const text = await response.text();
    const disk = await readFile(`.tmp/next-review-${settings.review}/static/${buildId}/_buildManifest.js`, "utf8");
    assert.equal(text, disk, "served_build_mismatch");
    assert.equal(launcher.status, "running", "launcher_not_running");
    assert(observation.leases.some(row => row.fresh && row.phase === "running"), "worker_not_ready");
    served = { status: response.status, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
  }
  const evidence = { at: new Date().toISOString(), phase, buildId, review: settings.review, launcher, ...observation, served };
  await writeFile(`../../docs/verification/artifacts/${artifactFolder}/deployment-${phase}-${targetReview}.json`, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(evidence));
} finally { await sql.end(); }
