import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { PROTOCOL, MemoryError } from "../../../../packages/memory/src/index";
import { createMemoryHost } from "../../../../packages/memory/src/host";
import {
  createPostgresObservationStore,
  initializeObservationSchema,
} from "../../../../packages/memory-postgres/src/index";
import { runRecordLoop } from "../../../../examples/memory-project/record-loop";
import { checkMemoryModuleT1 } from "./memory-module-t1.check";
import { createOwnerMemoryClient } from "@/lib/memory/client";
import {
  observationVersion,
  stableJson,
} from "@/lib/memory/records/observations";
import { closeDb } from "@/lib/db/adapters";

async function main() {
  assert.equal(process.env.ZHIYU_TEST_MODE, "integration");
  const url = process.env.ZHIYU_TEST_DATABASE_URL!;
  assert.equal(url, process.env.POSTGRES_URL);
  assert.match(new URL(url).pathname, /^\/zhiyu_test_[a-f0-9]{32}$/);
  const sql = postgres(url, { max: 10, onnotice: () => {} }),
    checks: string[] = [];
  try {
    await initializeObservationSchema(sql);
    await initializeObservationSchema(sql);
    await sql`CREATE TABLE g1_example_authority(tenant_id text,project_id text,principal_id text,allowed boolean,PRIMARY KEY(tenant_id,project_id,principal_id))`;
    for (const [tenant, project, principal] of [
      ["team", "dev", "reader"],
      ["team", "other", "reader"],
      ["team", "dev", "other"],
      ["another", "dev", "reader"],
    ])
      await sql`INSERT INTO g1_example_authority VALUES(${tenant},${project},${principal},true)`;
    const store = createPostgresObservationStore(sql, async (tx, i) => {
      const [r] =
        await tx`SELECT allowed FROM g1_example_authority WHERE tenant_id=${i.namespace.tenantId} AND project_id=${i.namespace.projectId} AND principal_id=${i.principalId} FOR SHARE`;
      if (!r?.allowed)
        throw new MemoryError("access_denied", 403, "Authority revoked");
    });
    const sessions = new Map([
      [
        "dev",
        {
          namespace: { tenantId: "team", projectId: "dev" },
          principalId: "reader",
        },
      ],
      [
        "other-project",
        {
          namespace: { tenantId: "team", projectId: "other" },
          principalId: "reader",
        },
      ],
      [
        "other-principal",
        {
          namespace: { tenantId: "team", projectId: "dev" },
          principalId: "other",
        },
      ],
      [
        "other-tenant",
        {
          namespace: { tenantId: "another", projectId: "dev" },
          principalId: "reader",
        },
      ],
    ]);
    const host = createMemoryHost(
      {
        store,
        sources: [
          {
            id: "demo.build",
            adapterVersion: "demo.v1",
            kind: "build_report",
            trustLevel: "raw",
          },
        ],
      },
      async (session: string) => {
        const i = sessions.get(session);
        if (!i) throw new MemoryError("access_denied", 403, "Invalid session");
        return i;
      },
    );
    const client = await host.forSession("dev"),
      example = await runRecordLoop(client);
    assert.equal(example.retry.replayed, true);
    assert.equal(example.exact.status, "ok");
    assert.equal(example.receipt.status, "committed");
    assert.equal(example.saved.receipt.id, example.retry.receipt.id);
    checks.push("independent_example_save_exact_read_retry_receipt");
    await assert.rejects(
      sql`UPDATE general_memory_observations_g1 SET record=record WHERE id=${example.saved.ref.record.id}`,
      /immutable observation/,
    );
    await assert.rejects(
      sql`DELETE FROM general_memory_observations_g1 WHERE id=${example.saved.ref.record.id}`,
      /immutable observation/,
    );
    checks.push("generic_store_rejects_original_update_and_delete");
    const command = {
      protocolVersion: PROTOCOL,
      kind: "observation.append",
      commandId: "parallel",
      payload: {
        source: {
          sourceId: "demo.build",
          externalId: "job-parallel",
          version: "a",
        },
        observedAt: "2026-10-21T02:00:00Z",
        content: "原始🧭\r\n观测",
      },
    };
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => client.execute(command)),
    );
    assert.equal(new Set(concurrent.map((r) => r.receipt.id)).size, 1);
    assert.equal(concurrent.filter((r) => !r.replayed).length, 1);
    checks.push("real_pg_concurrent_identical_command_one_commit");
    const sameSource = await client.execute({
      ...command,
      commandId: "same-source",
    });
    assert.equal(sameSource.ref.record.id, concurrent[0].ref.record.id);
    assert.deepEqual(sameSource.observation, concurrent[0].observation);
    checks.push("source_identity_dedup_preserves_observation");
    await assert.rejects(
      client.execute({
        ...command,
        payload: { ...command.payload, content: "changed" },
      }),
      { code: "idempotency_conflict" },
    );
    await assert.rejects(
      client.execute({
        ...command,
        commandId: "conflicting-source",
        payload: { ...command.payload, content: "changed" },
      }),
      { code: "source_conflict" },
    );
    checks.push("command_and_immutable_source_conflicts");
    const restarted = await host.forSession("dev");
    assert.equal(
      (await restarted.execute(command)).receipt.id,
      concurrent[0].receipt.id,
    );
    checks.push("rebound_client_recovers_committed_response");
    for (const session of ["other-project", "other-tenant"]) {
      const other = await host.forSession(session);
      await assert.rejects(
        other.read({ purpose: "current", ref: concurrent[0].ref.record }),
        { code: "namespace_mismatch" },
      );
      assert.equal(
        (await other.read({ purpose: "receipt", commandId: "parallel" }))
          .status,
        "not_found",
      );
      const own = await other.execute(command);
      assert.notEqual(own.ref.record.id, concurrent[0].ref.record.id);
    }
    const otherPrincipal = await host.forSession("other-principal");
    assert.equal(
      (await otherPrincipal.read({ purpose: "receipt", commandId: "parallel" }))
        .status,
      "not_found",
    );
    checks.push("tenant_project_and_principal_receipt_isolation");
    const exact = await client.read({
      purpose: "evidence",
      ref: concurrent[0].ref,
      range: { start: 2, end: 5, unit: "unicode_code_points" },
    });
    assert.equal(exact.status, "ok");
    if (exact.status === "ok") assert.equal(exact.content, "🧭\r\n");
    const stale = await client.read({
      purpose: "evidence",
      ref: { ...concurrent[0].ref, value: "wrong" },
      range: { start: 0, end: 1, unit: "unicode_code_points" },
    });
    assert.equal(stale.status, "unavailable");
    checks.push("unicode_exact_range_and_wrong_version_no_evidence");
    await sql`UPDATE g1_example_authority SET allowed=false WHERE tenant_id='team' AND project_id='dev' AND principal_id='reader'`;
    for (const op of [
      () => client.execute(command),
      () => client.read({ purpose: "current", ref: concurrent[0].ref.record }),
      () => client.read({ purpose: "receipt", commandId: "parallel" }),
    ])
      await assert.rejects(op(), { code: "access_denied" });
    await sql`UPDATE g1_example_authority SET allowed=true`;
    checks.push("authority_revocation_checked_on_read_retry_and_receipt");
    const before = Number(
      (await sql`SELECT count(*) n FROM general_memory_observations_g1`)[0].n,
    );
    await sql.unsafe(
      "CREATE FUNCTION g1_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit commit failure'; END $$",
    );
    await sql.unsafe(
      "CREATE CONSTRAINT TRIGGER g1_fail_command AFTER INSERT ON general_memory_commands_g1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION g1_fail_audit()",
    );
    const failed = {
      ...command,
      commandId: "commit-failed",
      payload: {
        ...command.payload,
        source: { ...command.payload.source, externalId: "failed" },
      },
    };
    await assert.rejects(client.execute(failed));
    assert.equal(
      Number(
        (await sql`SELECT count(*) n FROM general_memory_observations_g1`)[0].n,
      ),
      before,
    );
    assert.equal(
      (await client.read({ purpose: "receipt", commandId: "commit-failed" }))
        .status,
      "not_found",
    );
    await sql.unsafe(
      "DROP TRIGGER g1_fail_command ON general_memory_commands_g1",
    );
    const recovered = await client.execute(failed);
    assert.equal(recovered.replayed, false);
    await sql.unsafe(
      "CREATE CONSTRAINT TRIGGER g1_fail_read AFTER INSERT ON general_memory_reads_g1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION g1_fail_audit()",
    );
    const reads = Number(
      (await sql`SELECT count(*) n FROM general_memory_reads_g1`)[0].n,
    );
    await assert.rejects(
      client.read({ purpose: "current", ref: recovered.ref.record }),
    );
    assert.equal(
      Number((await sql`SELECT count(*) n FROM general_memory_reads_g1`)[0].n),
      reads,
    );
    await sql.unsafe("DROP TRIGGER g1_fail_read ON general_memory_reads_g1");
    checks.push("deferred_commit_failure_rolls_back_record_and_read_receipts");
    // Historical T1 receipt generated by the PRE-G1 canonical hash, inserted without the new core.
    const owner = randomUUID();
    await sql`INSERT INTO "User"(id,email) VALUES(${owner},'g1-legacy@example.invalid')`;
    const oldCommand = {
      kind: "observation.append" as const,
      commandId: randomUUID(),
      sourceId: "old-source",
      observedAt: "2026-10-20T00:00:00.000Z",
      content: "Historical observation",
      metadata: { old: true },
    };
    const obs = {
        id: randomUUID(),
        userId: owner,
        sourceType: "manual",
        sourceId: oldCommand.sourceId,
        observedAt: oldCommand.observedAt,
        content: oldCommand.content,
        contentHash: "old-content-hash",
        trustLevel: "raw",
        metadata: oldCommand.metadata,
        createdAt: "2026-10-20T01:00:00.000Z",
      },
      ref = observationVersion(obs),
      receiptId = randomUUID();
    await sql`INSERT INTO brain_observations(id,user_id,source_type,source_id,observed_at,content,content_hash,trust_level,metadata,created_at) VALUES(${obs.id},${owner},'manual',${obs.sourceId},${obs.observedAt},${obs.content},${obs.contentHash},'raw',${sql.json(obs.metadata)},${obs.createdAt})`;
    await sql`INSERT INTO memory_operation_receipts(id,user_id,command_id,request_hash,observation_id,revision,trace_id,contract_version,implementation_version) VALUES(${receiptId},${owner},${oldCommand.commandId},${createHash("sha256").update(stableJson(oldCommand)).digest("hex")},${obs.id},${ref.revision},${randomUUID()},'memory-observation.v1','memory-t1.v1')`;
    const legacy = createOwnerMemoryClient(owner),
      replayed = await legacy.submit(oldCommand);
    assert.equal(replayed.status, "committed");
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.receipt.id, receiptId);
    assert.deepEqual(replayed.ref, ref);
    const legacyRead = await legacy.read({
      purpose: "evidence",
      ref,
      range: { start: 0, end: 10 },
    });
    assert.equal(legacyRead.status, "ok");
    checks.push("pre_g1_receipt_hash_version_and_id_replay_compatible");
    const baseline = await checkMemoryModuleT1(sql);
    assert.equal(baseline.passed, true);
    checks.push("unchanged_t1_pg_contract_and_transaction_lock_barriers");
    const result = {
      passed: true,
      checks,
      legacyChecks: baseline.checks,
      coverage: "R only; no review, recall or dispatch claims",
      dailyDatabaseUsed: false,
    };
    fs.writeFileSync(
      process.env.ZHIYU_LIFECYCLE_TEST_RESULT!,
      JSON.stringify(result, null, 2),
    );
    console.log(
      JSON.stringify({
        passed: true,
        checks: checks.length,
        legacyChecks: baseline.checks.length,
      }),
    );
  } finally {
    await sql.end();
    await closeDb();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
