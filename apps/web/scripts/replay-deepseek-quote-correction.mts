/** Local read-only replay of review48's exact candidate and owned receipts.
 * Writes verification artifacts only; never submits a run, calls a model,
 * refetches evidence, updates a configuration or modifies historical output. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import postgres from "postgres";
import { loadWebEvidence } from "../lib/ai/jina-page-reader";
import { suggestWorkshopResearchQuoteCorrections, workshopResearchSourceWindows } from "../lib/workshops/research-evidence-correction";
import { verifyWorkshopResearchEvidence, type WorkshopResearchEvidenceEvent } from "../lib/workshops/research-evidence-verification";

config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
const runId = "48da4ddf-96cc-8a33-a332-77060e594771";
const workId = "b6e7ddb1-c699-4898-afa5-3d1804d6edd1";
const ownerId = "dcb1985e-3fe2-42fd-8978-7b04d1772850";
const directory = new URL("../../../docs/verification/artifacts/deepseek-report-rerun-2026-10-09/", import.meta.url);
const originalPath = new URL(`candidate-${runId}-2.txt`, directory);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const original = await readFile(originalPath, "utf8");
const originalHash = digest(original);
assert.equal(originalHash, "1a2abb40f2474f14f316679dd7fda6a40bc3745f63fb77134e012642eca76c39", "historical_candidate_changed");
const report = JSON.parse(original);
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
assert(databaseUrl, "local_database_required");
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname), "local_database_required");
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { statement_timeout: 10000 } });
try {
  const observed = await sql.begin("isolation level repeatable read read only", async tx => {
    const runs = await tx`SELECT r.id,r.status FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
      WHERE r.id=${runId}::uuid AND w.id=${workId}::uuid AND w.user_id=${ownerId}::uuid`;
    assert.equal(runs.length, 1, "owned_historical_run_required"); assert.equal(runs[0].status, "failed", "historical_status_changed");
    const events = await tx`SELECT id,run_id,type,metadata FROM workshop_events
      WHERE workshop_id=${workId}::uuid AND run_id=${runId}::uuid AND type='source_checked' ORDER BY seq,id`;
    const outputs = await tx`SELECT result_json FROM workshop_run_outputs WHERE workshop_id=${workId}::uuid AND run_id=${runId}::uuid`;
    assert.equal(outputs.length, 1, "captured_run_required");
    return { events: events.map(event => ({ id: event.id, runId: event.run_id, type: event.type, metadata: event.metadata })) as WorkshopResearchEvidenceEvent[],
      context: outputs[0].result_json.researchEvidenceContext };
  });
  assert(observed.context?.modelConfig && typeof observed.context.taskText === "string", "pinned_context_required");
  const coverage = verifyWorkshopResearchEvidence({ modelConfig: observed.context.modelConfig, taskText: observed.context.taskText,
    runId, events: observed.events, report }).coverage;
  assert.equal(coverage.length, 3); assert(coverage.every(source => source.status === "complete"));
  // These are the three exact quote/numeric failures recorded by review48's
  // final candidate. They select retrieval targets, never an approval result.
  const historicalIssues = [
    "必读来源 deepseek-math 第 2 条结论 的短摘未完整出现在所引用的同版正文窗口中。",
    "必读来源 deepseek-r1 第 2 条结论：数字 2024 未在短摘中出现。",
    "必读来源 deepseek-r1 第 2 条结论：数字 79.8% 未在短摘中出现。",
  ];
  const result = await suggestWorkshopResearchQuoteCorrections({ workshopId: workId, runId, report,
    issues: historicalIssues, coverage, events: observed.events });
  assert(result.candidates.length <= 4);
  assert(result.candidates.some(candidate => candidate.sourceId === "deepseek-math" && candidate.quote.includes("GSM8K [^9]") && candidate.quote.includes("dataset [^17]")), "math_inline_citation_candidate_missing");
  assert(result.candidates.some(candidate => candidate.sourceId === "deepseek-r1" && candidate.quote.includes("79.8% Pass@1 on AIME 2024") && candidate.quote.includes("slightly surpassing OpenAI-o1-1217")), "r1_metric_and_comparison_candidate_missing");
  for (const candidate of result.candidates) {
    const source = coverage.find(source => source.sourceId === candidate.sourceId)!;
    const { snapshot } = await loadWebEvidence(`workshop:${workId}`, candidate.evidenceId, candidate.url);
    const window = workshopResearchSourceWindows(source, observed.events, runId).find(window => window.eventId === candidate.eventId)!;
    assert(window && candidate.offset >= window.offset && candidate.endOffset <= window.endOffset, "candidate_crosses_receipt");
    assert.equal(snapshot.content.slice(candidate.offset, candidate.endOffset), candidate.quote, "candidate_not_exact");
    assert.equal(digest(snapshot.content), candidate.contentHash, "candidate_not_owned_version");
  }
  assert.equal(digest(await readFile(originalPath, "utf8")), originalHash, "historical_candidate_mutated");
  const proof = { observedAt: new Date().toISOString(), runId, originalHash, historicalIssues, historicalStatus: "failed",
    sourceReceiptCount: observed.events.length, uniqueBodyCount: coverage.length,
    admittedWindowIds: coverage.map(source => ({ sourceId: source.sourceId, eventIds: workshopResearchSourceWindows(source, observed.events, runId).map(window => window.eventId) })),
    candidates: result.candidates, warnings: result.warnings, originalCandidateUnchanged: true,
    databaseReadOnly: true, modelCalls: 0, externalActions: 0,
    interpretationBoundary: "Only a retrieval-feedback replay. No candidate was applied, no final report approved, and no production task rerun occurred." };
  const serialized = JSON.stringify(proof, null, 2) + "\n";
  const output = new URL(`quote-correction-replay-${runId}.json`, directory);
  await writeFile(output, serialized, { encoding: "utf8", mode: 0o600 });
  assert.equal(await readFile(output, "utf8"), serialized, "artifact_readback_mismatch");
  console.log(JSON.stringify({ ok: true, runId, sourceReceiptCount: observed.events.length, candidateCount: result.candidates.length,
    inlineCitationsRecovered: true, numericContextRecovered: true, originalCandidateUnchanged: true, modelCalls: 0, externalActions: 0 }));
} finally { await sql.end(); }
