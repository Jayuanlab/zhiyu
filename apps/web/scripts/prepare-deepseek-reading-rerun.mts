/** Owner-authorized, bounded configuration preparation. This script never
 * starts a run or changes a mission, boundary, tool grant, Loop or schedule.
 * apply/rollback require a settled, offline host; all writes use updateWork. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
const mode = process.argv[2];
assert(["inspect", "apply", "verify", "rollback"].includes(mode), "explicit_phase_required");
assert.equal(process.env.ZHIYU_RUNTIME_MODE, "worker", "production_worker_mode_required");
assert(!process.env.ZHIYU_TEST_MODE && !process.env.ZHIYU_TEST_DATABASE_URL, "test_environment_forbidden");
assert(process.env.TAURI_MODE !== "true" && process.env.IS_TAURI !== "true", "postgres_required");
const ownerId = process.env.ZHIYU_RUNTIME_OWNER_ID!;
assert.match(ownerId, /^[0-9a-f-]{36}$/i, "runtime_owner_required");
const workId = "b6e7ddb1-c699-4898-afa5-3d1804d6edd1";
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
assert(databaseUrl, "database_required");
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname), "local_database_required");
const directory = new URL("../../../docs/verification/artifacts/deepseek-reading-rerun-2026-10-09/", import.meta.url);
const contract = {
  version: "primary-reading/v1", taskKeywords: ["deepseek"], minQualityScore: 60,
  requiredPrimarySources: [
    { id: "deepseek-math", label: "DeepSeekMath", urls: ["https://arxiv.org/html/2402.03300v3"] },
    { id: "deepseek-r1", label: "DeepSeek-R1", urls: ["https://arxiv.org/html/2501.12948v1"] },
    { id: "deepseek-grm", label: "DeepSeek-GRM / SPCT", urls: ["https://arxiv.org/html/2504.02495v1"] },
  ],
};
type Json = Record<string, any>;
type Snapshot = { at: string; ownerId: string; workId: string; commandVersion: number;
  workshop: Json; loops: Json[]; heartbeat: Json | null; sources: Json[];
  host: Json | null; lease: Json | null; busyRuns: Json[] };
type Plan = { ownerId: string; workId: string; expectedVersion: number; baselineHash: string;
  contractHash: string; commandId: string; modelConfig: Json };
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {},
  connection: { statement_timeout: 10000 } });
let loadedService = false;

function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function withoutWorkVersion(value: Json): Json {
  const { workVersion: _version, ...rest } = value;
  return rest;
}
function configuration(snapshot: Snapshot) {
  return { workshop: { ...snapshot.workshop, modelConfig: withoutWorkVersion(snapshot.workshop.modelConfig) },
    loops: snapshot.loops, heartbeat: snapshot.heartbeat, sources: snapshot.sources };
}
function assertSafeArtifact(value: any) {
  if (Array.isArray(value)) return value.forEach(assertSafeArtifact);
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert(!/(?:api.?key|auth.?token|access.?token|credential|password|secret|private.?key)$/i.test(key), "secret_field_in_artifact");
      assertSafeArtifact(item);
    }
  } else if (typeof value === "string") {
    assert(!/\uFFFD|\?{3}/u.test(value), "encoding_corruption");
    assert(!/postgres(?:ql)?:\/\/|Bearer\s+[a-z0-9._-]{8,}|\bsk-[a-z0-9_-]{8,}/i.test(value), "credential_in_artifact");
  }
}
async function load<T>(name: string): Promise<T | null> {
  try { return JSON.parse(await readFile(new URL(name, directory), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function save(name: string, value: unknown, once = false) {
  assertSafeArtifact(value);
  try { await writeFile(new URL(name, directory), JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: once ? "wx" : "w" }); }
  catch (error) { if (!once || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
async function readSnapshot(tx: postgres.TransactionSql | postgres.Sql = sql): Promise<Snapshot> {
  const rows = await tx`SELECT id,name,mission,status,autonomy_level AS "autonomyLevel",boundary_policy AS "boundaryPolicy",
    model_config AS "modelConfig",COALESCE((SELECT version FROM work_command_targets WHERE workshop_id=w.id),0)::int AS command_version
    FROM workshops w WHERE id=${workId}::uuid AND user_id=${ownerId}::uuid`;
  assert(rows[0], "target_not_found");
  const { command_version, ...workshop } = rows[0];
  assert.equal(workshop.name, "强化学习前沿学习者", "unexpected_target_name");
  assert(workshop.modelConfig && typeof workshop.modelConfig === "object" && !Array.isArray(workshop.modelConfig), "model_config_not_object");
  const loops = await tx`SELECT id,name,description,goal,status,trigger_config,context_config,action_policy,
    verification_config,approval_policy,retry_policy,escalation_policy FROM loops
    WHERE workshop_id=${workId}::uuid AND user_id=${ownerId}::uuid ORDER BY id`;
  const heartbeats = await tx`SELECT enabled,mode,heartbeat_policy FROM workshop_heartbeats WHERE workshop_id=${workId}::uuid`;
  const sources = await tx`SELECT id,name,type,uri,content,config FROM workshop_sources WHERE workshop_id=${workId}::uuid ORDER BY id`;
  const leases = await tx`SELECT phase,run_id,token,lease_until,effect_started FROM workshop_execution_leases WHERE workshop_id=${workId}::uuid`;
  const busyRuns = await tx`SELECT id,status FROM workshop_runs WHERE workshop_id=${workId}::uuid
    AND status IN ('queued','running','cancel_requested','needs_review') ORDER BY created_at,id`;
  const hosts = await tx`SELECT i.id,i.phase,i.desired_status,l.lease_until,
    l.lease_until>clock_timestamp() AND i.phase!='stopped' AS online FROM runtime_owner_leases l
    JOIN runtime_instances i ON i.id=l.instance_id AND i.owner_id=l.owner_id WHERE l.owner_id=${ownerId}`;
  return { at: new Date().toISOString(), ownerId, workId, commandVersion: Number(command_version), workshop,
    loops: [...loops], heartbeat: heartbeats[0] ?? null, sources: [...sources],
    host: hosts[0] ?? null, lease: leases[0] ?? null, busyRuns: [...busyRuns] };
}
async function snapshot() {
  return sql.begin("isolation level repeatable read read only", tx => readSnapshot(tx)) as Promise<Snapshot>;
}
function assertQuiescent(current: Snapshot) {
  assert.equal(current.busyRuns.length, 0, "target_has_unsettled_runs");
  assert(!current.lease || current.lease.phase === "idle", "target_execution_lease_unsettled");
  assert(!current.host?.online && (!current.host || current.host.phase === "stopped"), "graceful_host_stop_required");
}
function assertUnchanged(before: Snapshot, current: Snapshot, modelConfig: Json) {
  const expected = configuration(before);
  expected.workshop.modelConfig = withoutWorkVersion(modelConfig);
  assert.equal(hash(configuration(current)), hash(expected), "configuration_readback_mismatch");
}
async function commandReceipt(commandId: string) {
  const rows = await sql`SELECT command_id,target_id,type,expected_version,status,error_code,payload_hash,result,created_at,completed_at
    FROM work_commands WHERE owner_id=${ownerId}::uuid AND command_id=${commandId}`;
  return rows[0] ?? null;
}
async function applyConfiguration(plan: Plan, before: Snapshot, rollback = false) {
  assert.equal(plan.ownerId, ownerId, "plan_owner_changed");
  assert.equal(plan.workId, workId, "plan_target_changed");
  assert.equal(plan.contractHash, hash(contract), "plan_contract_changed");
  const previous = await commandReceipt(plan.commandId);
  if (previous) {
    assert.equal(previous.target_id, workId, "receipt_target_changed");
    assert.equal(previous.type, "updateWork", "receipt_command_changed");
    assert.equal(previous.expected_version, plan.expectedVersion, "receipt_version_changed");
    if (previous.status === "succeeded") {
      const current = await snapshot();
      assertUnchanged(before, current, plan.modelConfig);
      await save(rollback ? "rollback-receipt.json" : "apply-receipt.json", previous, true);
      await save(rollback ? "rollback-after.json" : "after.json", current, true);
      return { current, receipt: previous, replayed: true };
    }
    assert.equal(previous.status, "queued", "previous_command_failed");
  }
  // The owner host uses this same lock for acquisition. Holding it after a
  // graceful stop prevents a new worker from entering during the short patch.
  const result = await sql.begin(async tx => {
    const locks = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${"runtime-host:" + ownerId},0)) AS locked`;
    assert.equal(locks[0]?.locked, true, "host_start_in_progress");
    const current = await readSnapshot(tx);
    assertQuiescent(current);
    assert.equal(current.commandVersion, plan.expectedVersion, "baseline_command_version_stale");
    assert.equal(hash(configuration(current)), plan.baselineHash, "baseline_configuration_stale");
    loadedService = true;
    const { updateWork } = await import("../lib/work-runtime/commands");
    await updateWork({ userId: ownerId, workId, source: "owner", commandId: plan.commandId,
      expectedVersion: plan.expectedVersion,
      reason: rollback ? "主人授权的 DeepSeek 阅读改进回滚；恢复原 modelConfig，保留运行及失败证据。"
        : "主人要求修改后重跑：仅为 DeepSeek 主指令启用原始论文正文覆盖标准；保留使命、权限和排期。",
      patch: { modelConfig: plan.modelConfig } });
    const after = await readSnapshot(tx);
    assertUnchanged(before, after, plan.modelConfig);
    assert.equal(after.commandVersion, plan.expectedVersion + 1, "command_version_not_advanced_once");
    return after;
  }) as Snapshot;
  const receipt = await commandReceipt(plan.commandId);
  assert.equal(receipt?.status, "succeeded", "command_receipt_missing");
  await save(rollback ? "rollback-receipt.json" : "apply-receipt.json", receipt, true);
  await save(rollback ? "rollback-after.json" : "after.json", result, true);
  return { current: result, receipt, replayed: false };
}

try {
  await mkdir(directory, { recursive: true });
  let before = await load<Snapshot>("before.json");
  const current = await snapshot();
  const audit = { phase: mode, at: current.at, ownerId, workId, commandVersion: current.commandVersion,
    configurationHash: hash(configuration(current)), host: current.host, lease: current.lease,
    busyRuns: current.busyRuns, modelCalls: 0, externalActions: 0 };
  await save(`${mode}-${current.at.replaceAll(/[:.]/g, "-")}.json`, audit, true);
  if (mode === "inspect") {
    if (!before) { await save("before.json", current, true); before = await load<Snapshot>("before.json"); }
    assert(before && before.ownerId === ownerId && before.workId === workId, "baseline_identity_changed");
    const proposed: Plan = { ownerId, workId, expectedVersion: before.commandVersion,
      baselineHash: hash(configuration(before)), contractHash: hash(contract),
      commandId: `deepseek-primary-reading-v1:${before.commandVersion}:${hash(configuration(before)).slice(0, 20)}`,
      modelConfig: { ...before.workshop.modelConfig, researchEvidenceContract: contract } };
    await save("apply-plan.json", proposed, true);
    const stored = await load<Plan>("apply-plan.json");
    assert.equal(hash(stored), hash(proposed), "stored_plan_changed");
    console.log(JSON.stringify({ ok: true, ...audit, baselineVersion: before.commandVersion,
      baselineStale: before.commandVersion !== current.commandVersion || hash(configuration(before)) !== hash(configuration(current)),
      commandId: proposed.commandId, contractHash: hash(contract), requiredSources: contract.requiredPrimarySources.length,
      loopStatuses: current.loops.map(loop => ({ id: loop.id, status: loop.status })), mutationPerformed: false,
      next: "graceful stop -> apply -> verify -> restart -> independently rerun" }));
  } else {
    assert(before && before.ownerId === ownerId && before.workId === workId, "inspect_first");
    const plan = await load<Plan>("apply-plan.json");
    assert(plan, "apply_plan_missing");
    assert.equal(plan.baselineHash, hash(configuration(before)), "baseline_artifact_changed");
    assert.equal(hash(plan.modelConfig), hash({ ...before.workshop.modelConfig, researchEvidenceContract: contract }), "apply_payload_changed");
    if (mode === "verify") {
      const receipt = await commandReceipt(plan.commandId);
      assert.equal(receipt?.status, "succeeded", "apply_not_committed");
      assertUnchanged(before, current, plan.modelConfig);
      await save("verified.json", { ...audit, commandId: plan.commandId, contractHash: hash(contract), unchangedOtherConfiguration: true });
      console.log(JSON.stringify({ ok: true, ...audit, commandId: plan.commandId, contractHash: hash(contract), mutationPerformed: false }));
    } else if (mode === "apply") {
      const applied = await applyConfiguration(plan, before);
      console.log(JSON.stringify({ ok: true, phase: mode, commandId: plan.commandId, commandVersion: applied.current.commandVersion,
        contractHash: hash(contract), replayed: applied.replayed, mutationPerformed: !applied.replayed, unchangedOtherConfiguration: true }));
    } else {
      let rollbackPlan = await load<Plan>("rollback-plan.json");
      if (!rollbackPlan) {
        const receipt = await commandReceipt(plan.commandId);
        assert.equal(receipt?.status, "succeeded", "apply_not_committed");
        assertUnchanged(before, current, plan.modelConfig);
        assertQuiescent(current);
        const after = await load<Snapshot>("after.json");
        assert(after && current.workshop.modelConfig.workVersion === after.workshop.modelConfig.workVersion, "newer_configuration_blocks_rollback");
        rollbackPlan = { ownerId, workId, expectedVersion: current.commandVersion,
          baselineHash: hash(configuration(current)), contractHash: hash(contract),
          commandId: `deepseek-primary-reading-v1-rollback:${current.commandVersion}:${hash(configuration(current)).slice(0, 20)}`,
          modelConfig: before.workshop.modelConfig };
        await save("rollback-plan.json", rollbackPlan, true);
      }
      const restored = await applyConfiguration(rollbackPlan, before, true);
      console.log(JSON.stringify({ ok: true, phase: mode, commandId: rollbackPlan.commandId, commandVersion: restored.current.commandVersion,
        replayed: restored.replayed, mutationPerformed: !restored.replayed, restoredOriginalConfiguration: true }));
    }
  }
} catch (error) {
  const failure = { ok: false, phase: mode, reason: error instanceof assert.AssertionError ? error.message : "configuration_preparation_failed",
    code: typeof (error as any)?.code === "string" ? (error as any).code : undefined };
  console.error(JSON.stringify(failure));
  await save(`${mode}-last-failure.json`, { ...failure, at: new Date().toISOString(), workId }).catch(() => {});
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
  if (loadedService) { const { closePostgresDb } = await import("../lib/db/adapters/postgres"); await closePostgresDb(); }
}
