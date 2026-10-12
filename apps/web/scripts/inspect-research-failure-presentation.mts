/** Read-only proof of the owner's persisted failure presentation. This script
 * never invokes a model, tool, mutation service, worker, or business rerun. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import postgres from "postgres";
import { buildWorkPresentation, type WorkPresentationEvent, type WorkPresentationRun } from "../lib/workshops/work-presentation";

config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
const runId = process.argv[2];
const ownerId = process.env.ZHIYU_RUNTIME_OWNER_ID!;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
assert(runId && UUID.test(runId), "run_uuid_required");
assert(ownerId && UUID.test(ownerId), "configured_owner_required");
assert(!process.env.ZHIYU_TEST_MODE && !process.env.ZHIYU_TEST_DATABASE_URL, "production_observation_required");
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
assert(databaseUrl, "database_required");
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname), "local_database_required");
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { statement_timeout: 10000 } });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const directory = new URL("../../../docs/verification/artifacts/deepseek-report-rerun-2026-10-09/", import.meta.url);

try {
  const observed = await sql.begin("isolation level repeatable read read only", async tx => {
    const runs = await tx`SELECT r.id,r.status,r.error,r.output_summary AS "outputSummary",r.workshop_id AS "workshopId",
      r.created_at AS "createdAt",r.started_at AS "startedAt",r.completed_at AS "completedAt"
      FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
      WHERE r.id=${runId}::uuid AND w.user_id=${ownerId}::uuid`;
    assert(runs.length === 1, "owned_run_required");
    const run = runs[0] as unknown as WorkPresentationRun & { workshopId: string };
    const events = await tx`SELECT id,run_id AS "runId",seq,type,title,body,metadata,created_at AS "createdAt",visibility
      FROM workshop_events WHERE workshop_id=${run.workshopId}::uuid AND run_id=${runId}::uuid ORDER BY seq,id`;
    return { run, events: [...events] as unknown as WorkPresentationEvent[] };
  });
  const originalRowsHash = digest(JSON.stringify(observed));
  const presentation = buildWorkPresentation({ workshopId: observed.run.workshopId, ...observed });
  assert(presentation && presentation.status === observed.run.status, "projection_must_preserve_status");
  assert(digest(JSON.stringify(observed)) === originalRowsHash, "projection_must_not_mutate_input");
  const evidence = {
    observedAt: new Date().toISOString(), databaseReadOnly: true, modelCalls: 0, externalActions: 0,
    buildLoaded: "workspace_source_only", run: observed.run,
    originalRowsHash, projectionPreservesStatus: true, projectionMutatesRows: false,
    hostValidationReceipts: observed.events.filter(event =>
      ["research_final_validation_rejected", "research_final_validation_passed", "agent_final_output_rejected"].includes(event.type))
      .map(event => ({ id: event.id, runId: event.runId, seq: event.seq, type: event.type, createdAt: event.createdAt,
        metadata: event.metadata })),
    presentation,
  };
  await mkdir(directory, { recursive: true });
  const artifact = new URL(`failure-presentation-${runId}.json`, directory);
  const content = JSON.stringify(evidence, null, 2) + "\n";
  await writeFile(artifact, content, { encoding: "utf8", mode: 0o600 });
  assert(await readFile(artifact, "utf8") === content, "utf8_artifact_readback_required");
  console.log(JSON.stringify({ runId, status: presentation.status, title: presentation.title,
    failureKind: presentation.failureKind, warnings: presentation.warnings,
    artifact: artifact.pathname, artifactHash: digest(content), databaseReadOnly: true,
    buildLoaded: "workspace_source_only", modelCalls: 0, externalActions: 0 }, null, 2));
} finally { await sql.end({ timeout: 5 }); }
