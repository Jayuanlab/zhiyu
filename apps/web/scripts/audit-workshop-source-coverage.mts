import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
const runId = process.argv[2];
assert.match(runId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const ownerId = process.env.ZHIYU_RUNTIME_OWNER_ID!;
const sql = postgres(process.env.POSTGRES_URL || process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const safe = (value: unknown) => typeof value === "string" ? value.replace(/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/\S+/gi, "[REDACTED]") : value;
try {
  const report = await sql.begin("read only", async tx => {
    const [run] = await tx`SELECT r.id,r.workshop_id,r.status,r.created_at,r.completed_at,r.error,r.output_summary,r.trigger_reason
      FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id WHERE r.id=${runId}::uuid AND w.user_id=${ownerId}::uuid`;
    assert.ok(run, "owned_run_missing");
    const events = await tx`SELECT id,type,title,body,metadata,created_at FROM workshop_events WHERE run_id=${runId}::uuid ORDER BY seq`;
    const toolResults = events.filter(event => event.type === "tool_result");
    const uniqueTools = [...new Map(toolResults.filter(event => event.metadata?.toolUseId)
      .map(event => [event.metadata.toolUseId, { toolUseId: event.metadata.toolUseId, toolName: event.metadata.toolName, at: event.created_at }])).values()];
    const searches = events.filter(event => event.type === "tool_call" && event.metadata?.toolName === "webSearch")
      .map(event => ({ id: event.id, at: event.created_at, input: JSON.parse(event.body ?? "{}") }));
    const reads = events.filter(event => event.type === "source_checked" && event.metadata?.url && event.metadata?.method)
      .map(event => ({ id: event.id, at: event.created_at, url: event.metadata.url, title: event.title, method: event.metadata.method,
        evidenceId: event.metadata.evidenceId, contentHash: event.metadata.contentHash, truncated: event.metadata.truncated,
        nextOffset: event.metadata.nextOffset, warnings: event.metadata.warnings, qualityScore: event.metadata.qualityScore }));
    const savedPages = [];
    for (const page of reads) {
      if (!page.evidenceId) continue;
      const scopeHash = createHash("sha256").update(`workshop:${run.workshop_id}`).digest("hex");
      const directory = join(resolve(process.env.WEB_READ_EVIDENCE_DIR || ".data/web-read-evidence"), scopeHash, page.evidenceId);
      try {
        const snapshot = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"));
        const files = await readdir(directory);
        const windows = await Promise.all(files.filter(name => /^window-\d+-\d+\.json$/.test(name)).map(async name => {
          const window = JSON.parse(await readFile(join(directory, name), "utf8"));
          return { file: name, offset: window.offset, chars: window.content?.length, totalChars: window.totalChars,
            nextOffset: window.nextOffset, truncated: window.truncated, maxChars: Number(name.split("-")[2].split(".")[0]) };
        }));
        savedPages.push({ evidenceId: page.evidenceId, url: snapshot.url, title: snapshot.title,
          chars: snapshot.content.length, hashMatches: createHash("sha256").update(snapshot.content).digest("hex") === page.contentHash,
          headings: snapshot.content.split("\n").filter((line: string) => /^#{1,6}\s/.test(line)).map((line: string) => safe(line)),
          figureCount: snapshot.figures?.length ?? 0, interpretedFigures: files.filter(name => /\.interpretation-/.test(name)).length,
          windows, directory });
      } catch (error) { savedPages.push({ evidenceId: page.evidenceId, unavailable: true, errorCode: (error as any)?.code ?? "snapshot_read_failed" }); }
    }
    const [output] = await tx`SELECT result_json,directive_ids FROM workshop_run_outputs WHERE run_id=${runId}::uuid`;
    const budget = events.find(event => event.type === "context_budget_report")?.metadata;
    const finalText = events.findLast(event => event.type === "agent_text" && event.metadata?.final === true)?.body ?? "";
    const completion = events.findLast(event => event.type === "run_completed")?.metadata;
    return { inspectedAt: new Date().toISOString(), run: { ...run, output_summary: safe(run.output_summary) }, eventCount: events.length,
      uniqueToolCount: uniqueTools.length, uniqueTools, searches, reads, savedPages,
      budget: budget ? { promptChars: budget.promptChars, toolCount: budget.toolCount, maxToolCalls: budget.maxToolCalls } : null,
      failures: events.filter(event => /failed|error|budget|timeout/.test(event.type) && event.type !== "context_budget_report")
        .map(event => ({ id: event.id, type: event.type, body: safe(event.body) })),
      agentDeclaredCoverage: events.filter(event => event.type === "observation" && event.metadata?.sources_checked)
        .map(event => ({ id: event.id, count: event.metadata.sources_checked, authority: event.metadata.receiptAuthority })),
      reportText: safe(finalText), reportWarnings: completion?.presentation?.warnings ?? [],
      reportEvidenceIds: completion?.presentation?.evidenceEventIds ?? [], capturedOutput: Boolean(output),
      capturedOutputKeys: output ? Object.keys(output.result_json ?? {}) : [],
      directiveIds: output?.directive_ids ?? [], memoryWrites: events.filter(event => event.type === "memory_written")
        .map(event => ({ id: event.id, status: event.metadata?.status, kind: event.metadata?.kind, sourceEventIds: event.metadata?.sourceEventIds ?? [] })) };
  });
  const directory = new URL("../../../docs/verification/artifacts/workshop-chat-control-2026-10-09/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const path = new URL(`source-coverage-${runId}.json`, directory);
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ path: path.pathname, ...report, reportText: String(report.reportText).slice(0, 1300) }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: (error as any)?.code, reason: error instanceof assert.AssertionError ? error.message : "source_audit_failed" }));
  process.exitCode = 1;
} finally { await sql.end({ timeout: 2 }); }
