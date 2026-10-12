/** Read-only production observation. All database access is in a READ ONLY
 * snapshot. No service mutation, worker launch, model or provider call exists. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";
import { formatWorkshopResearchContract } from "../lib/workshops/research-evidence-verification";
import { isSavedResearchPageMethod } from "../lib/workshops/research-page-method";
import { finalizeWorkshopResearchDelivery } from "../lib/workshops/research-report-delivery";
import { finalizeWorkshopResearchReaderDelivery } from "../lib/workshops/research-reader-delivery";
import { observeResearchReport } from "./research-report-observation";
import type { WorkshopExecutionResult } from "../lib/workshops/executor";

config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
const args = process.argv.slice(2);
assert(args.length === 2 && ["--chat", "--run"].includes(args[0]), "usage_--chat_uuid_or_--run_uuid");
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
assert.match(args[1], UUID, "invalid_target_uuid");
const ownerId = process.env.ZHIYU_RUNTIME_OWNER_ID!;
assert.match(ownerId, UUID, "runtime_owner_required");
assert(process.env.TAURI_MODE !== "true" && process.env.IS_TAURI !== "true", "postgres_required");
assert(!process.env.ZHIYU_TEST_MODE && !process.env.ZHIYU_TEST_DATABASE_URL, "production_observation_required");
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
assert(databaseUrl, "database_required");
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname), "local_database_required");
const workId = "b6e7ddb1-c699-4898-afa5-3d1804d6edd1";
const baselineRunId = "23826eba-bb8e-80e9-a1d6-1d645557b349";
const originalPrompt = "让强化学习前沿学习者，重点看deepseek关于这方面的工作";
const directory = new URL("../../../docs/verification/artifacts/deepseek-report-rerun-2026-10-09/", import.meta.url);
const baselinePath = new URL(`../../../docs/verification/artifacts/deepseek-reading-rerun-2026-10-09/run-${baselineRunId}-latest.json`, import.meta.url);
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { statement_timeout: 10000 } });
type Json = Record<string, any>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const textOf = (parts: any) => Array.isArray(parts) ? parts.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("") : "";
const redact = (value: any): any => {
  // postgres returns timestamp columns as Date instances; enumerate only after
  // preserving their ISO representation instead of turning them into {}.
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /(?:api[-_]?key|auth(?:orization)?|access[-_]?token|credential|password|secret|private[-_]?key)$/i.test(key) ? "[REDACTED]" : redact(item)]));
  if (typeof value === "string") return value.replace(/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/\S+/gi, "[REDACTED]");
  return value;
};
async function readJson(path: URL | string) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function save(name: string, value: unknown) {
  await writeFile(new URL(name, directory), JSON.stringify(redact(value), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}
function uniqueCalls(events: Json[], toolName: string) {
  return [...new Set(events.filter(e => ["tool_call", "tool_result"].includes(e.type) && e.metadata?.toolName === toolName)
    .map(e => e.metadata?.toolUseId ?? e.metadata?.toolCallId ?? (e.type === "tool_call" ? e.id : null)).filter(Boolean))].length;
}
async function observeDatabase() {
  return sql.begin("isolation level repeatable read read only", async tx => {
    let selected: Json | null = null, chatId: string | null = args[0] === "--chat" ? args[1] : null;
    let command: Json | null = null, runId: string | null = args[0] === "--run" ? args[1] : null;
    let recentAssistant: Json[] = [];
    if (chatId) {
      const chats = await tx`SELECT id FROM "Chat" WHERE id=${chatId}::uuid AND "userId"=${ownerId}::uuid`;
      assert(chats[0], "owned_chat_missing");
      const messages = await tx`SELECT id,parts,"createdAt" AS at FROM "Message_v2" WHERE "chatId"=${chatId}::uuid AND role='user'
        ORDER BY "createdAt" DESC,id DESC LIMIT 1`;
      if (!messages[0]) return { state: "awaiting_owner_prompt", chatId, sourceMessage: null, run: null };
      selected = { id: messages[0].id, at: messages[0].at, text: textOf(messages[0].parts) };
      const expectedCommandId = "chat-workshop-control:" + digest(JSON.stringify(["v1", ownerId, chatId, selected.id, "assign"]));
      const commands = await tx`SELECT command_id,target_id,type,expected_version,status,error_code,payload_hash,result,created_at,completed_at
        FROM work_commands WHERE owner_id=${ownerId}::uuid AND command_id=${expectedCommandId}`;
      command = commands[0] ?? null;
      const runs = await tx`SELECT r.id FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
        WHERE w.user_id=${ownerId}::uuid AND w.id=${workId}::uuid AND r.trigger_reason->>'chatId'=${chatId}
        AND r.trigger_reason->>'userMessageId'=${selected.id} ORDER BY r.created_at DESC,r.id DESC LIMIT 2`;
      assert(runs.length <= 1, "multiple_runs_for_owner_message");
      runId = runs[0]?.id ?? null;
      const assistants = await tx`SELECT id,parts,metadata,"createdAt" AS at FROM "Message_v2" WHERE "chatId"=${chatId}::uuid
        AND role='assistant' AND "createdAt">=${selected.at} ORDER BY "createdAt",id LIMIT 20`;
      recentAssistant = assistants.map(row => ({ id: row.id, at: row.at, partTypes: Array.isArray(row.parts) ? row.parts.map(p => p.type) : [],
        textChars: textOf(row.parts).length, textHash: digest(textOf(row.parts)), delivery: row.metadata?.workshopChatDelivery ?? null,
        tools: Array.isArray(row.parts) ? row.parts.filter(p => p.type === "tool-native").map(p => ({ name: p.toolName ?? p.name,
          state: p.status ?? p.state, outputOk: record(p.toolOutput ?? p.output ?? p.result).ok ?? null })) : [] }));
      if (!runId) return { state: selected.text === originalPrompt ? "owner_prompt_persisted_no_admission" : "latest_prompt_different",
        chatId, sourceMessage: selected, command, recentAssistant, run: null };
    }
    const rows = await tx`SELECT r.id,r.workshop_id,r.status,r.trigger_reason,r.input_snapshot,r.completion_json,r.output_summary,r.error,
      r.started_at,r.created_at,r.completed_at FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
      WHERE r.id=${runId}::uuid AND w.id=${workId}::uuid AND w.user_id=${ownerId}::uuid`;
    assert(rows[0], "owned_target_run_missing");
    const run = rows[0];
    chatId = run.trigger_reason?.chatId ?? chatId;
    if (!selected && run.trigger_reason?.userMessageId) {
      const messages = await tx`SELECT m.id,m.parts,m."createdAt" AS at FROM "Message_v2" m JOIN "Chat" c ON c.id=m."chatId"
        WHERE m.id=${run.trigger_reason.userMessageId}::uuid AND c."userId"=${ownerId}::uuid AND m.role='user'`;
      if (messages[0]) selected = { id: messages[0].id, at: messages[0].at, text: textOf(messages[0].parts) };
    }
    if (!command && typeof run.trigger_reason?.commandMeta?.commandId === "string") {
      const commands = await tx`SELECT command_id,target_id,type,expected_version,status,error_code,payload_hash,result,created_at,completed_at
        FROM work_commands WHERE owner_id=${ownerId}::uuid AND command_id=${run.trigger_reason.commandMeta.commandId}`;
      command = commands[0] ?? null;
    }
    const directives = typeof run.trigger_reason?.directiveId === "string" ? await tx`SELECT id,run_id,content,scope,status FROM workshop_directives
      WHERE id=${run.trigger_reason.directiveId}::uuid AND workshop_id=${workId}::uuid` : [];
    const items = await tx`SELECT id,chat_id,source_message_id,primary_directive_id,latest_run_id,revision,status FROM workshop_chat_work_items
      WHERE owner_id=${ownerId}::uuid AND workshop_id=${workId}::uuid AND (latest_run_id=${run.id}::uuid OR id::text=${run.trigger_reason?.workItemId ?? ""})`;
    const events = await tx`SELECT id,workshop_id,run_id,seq,type,title,body,metadata,created_at FROM workshop_events
      WHERE workshop_id=${workId}::uuid AND run_id=${run.id}::uuid ORDER BY seq,id`;
    const outputs = await tx`SELECT result_json,directive_ids,worker_id,fencing_token,created_at FROM workshop_run_outputs
      WHERE workshop_id=${workId}::uuid AND run_id=${run.id}::uuid`;
    const deliveries = await tx`SELECT d.id,d.chat_id,d.source_message_id,d.message_id,d.run_status,d.status,d.attempts,d.last_error_code,d.delivered_at,
      m.role,m."chatId" AS message_chat_id,m.metadata,m.parts,m."createdAt" AS message_at
      FROM workshop_chat_deliveries d LEFT JOIN "Message_v2" m ON m.id=d.message_id
      WHERE d.owner_id=${ownerId}::uuid AND d.workshop_id=${workId}::uuid AND d.run_id=${run.id}::uuid ORDER BY d.created_at,d.id`;
    return { state: run.status, chatId, sourceMessage: selected, command, recentAssistant, run,
      directive: directives[0] ?? null, items: [...items], events: [...events], captured: outputs[0] ?? null, deliveries: [...deliveries] };
  });
}
async function inspectPageGroup(group: Json[]) {
  const first = group[0], evidenceId = String(first.metadata.evidenceId), expectedHash = String(first.metadata.contentHash);
  if (!UUID.test(evidenceId) || !/^[a-f0-9]{64}$/i.test(expectedHash)) return { evidenceId, contentHash: expectedHash,
    available: false, error: "invalid_snapshot_identity", eventIds: group.map(e => e.id), validEventIds: [] };
  const evidenceDirectory = join(resolve(process.env.WEB_READ_EVIDENCE_DIR || ".data/web-read-evidence"), digest(`workshop:${workId}`), evidenceId);
  try {
    const snapshot = await readJson(join(evidenceDirectory, "snapshot.json"));
    assert(snapshot && typeof snapshot.content === "string", "saved_snapshot_missing");
    const hashMatches = digest(snapshot.content) === expectedHash && snapshot.contentHash === expectedHash;
    const identityMatches = snapshot.evidenceId === evidenceId && group.every(e => e.metadata.url === snapshot.url);
    const files = await readdir(evidenceDirectory);
    const diskWindows: Json[] = [];
    for (const name of files.filter(name => /^window-\d+-\d+\.json$/.test(name)).sort()) {
      const window = await readJson(join(evidenceDirectory, name));
      const end = window?.offset + String(window?.content ?? "").length;
      const valid = hashMatches && identityMatches && window?.evidenceId === evidenceId && window?.url === snapshot.url
        && window?.contentHash === expectedHash && window?.totalChars === snapshot.content.length
        && Number.isSafeInteger(window?.offset) && window.offset >= 0 && typeof window?.content === "string"
        && window.content === snapshot.content.slice(window.offset, end) && end <= snapshot.content.length
        && (window.nextOffset === null ? end === snapshot.content.length : window.nextOffset === end && end < snapshot.content.length);
      diskWindows.push({ file: name, valid, offset: window?.offset, contentLength: typeof window?.content === "string" ? window.content.length : null,
        totalChars: window?.totalChars, nextOffset: window?.nextOffset, contentHash: window?.contentHash, truncated: window?.truncated });
    }
    const windows = [...new Map(group.map(event => [JSON.stringify([event.metadata.offset, event.metadata.contentLength, event.metadata.totalChars, event.metadata.nextOffset]), event])).values()]
      .map(event => ({ eventId: event.id, offset: event.metadata.offset, contentLength: event.metadata.contentLength,
        totalChars: event.metadata.totalChars, nextOffset: event.metadata.nextOffset, qualityScore: event.metadata.qualityScore,
        diskWindowMatches: diskWindows.some(window => window.valid && window.offset === event.metadata.offset && window.contentLength === event.metadata.contentLength
          && window.totalChars === event.metadata.totalChars && window.nextOffset === event.metadata.nextOffset) }));
    const validEventIds = group.filter(event => windows.some(window => window.diskWindowMatches && window.offset === event.metadata.offset
      && window.contentLength === event.metadata.contentLength && window.totalChars === event.metadata.totalChars && window.nextOffset === event.metadata.nextOffset)).map(event => event.id);
    let coveredChars = 0;
    for (const window of windows.filter(w => w.diskWindowMatches).sort((a, b) => a.offset - b.offset || b.contentLength - a.contentLength)) {
      if (window.offset > coveredChars) break;
      coveredChars = Math.max(coveredChars, window.offset + window.contentLength);
    }
    const complete = coveredChars === snapshot.content.length && windows.some(w => w.diskWindowMatches && w.nextOffset === null);
    return { evidenceId, contentHash: expectedHash, url: snapshot.url, fetchedAt: snapshot.fetchedAt, available: true,
      hashMatches, identityMatches, snapshotChars: snapshot.content.length, coveredChars, complete,
      eventCount: group.length, uniqueWindowCount: windows.length, eventIds: group.map(e => e.id), validEventIds,
      windows, diskWindows, figureCount: snapshot.figures?.length ?? 0,
      interpretedFigures: files.filter(name => /\.interpretation-/.test(name)).length,
      warnings: [...new Set(group.flatMap(event => event.metadata.warnings ?? []))] };
  } catch (error) {
    return { evidenceId, contentHash: expectedHash, available: false, eventIds: group.map(e => e.id), validEventIds: [],
      error: error instanceof assert.AssertionError ? error.message : "snapshot_read_failed",
      errorCode: (error as NodeJS.ErrnoException).code ?? null };
  }
}

try {
  await mkdir(directory, { recursive: true });
  const observed = await observeDatabase() as Json;
  const observedAt = new Date().toISOString();
  const stamp = observedAt.replaceAll(/[:.]/g, "-");
  if (!observed.run) {
    const report = { observedAt, ownerId, workId, ...observed, databaseReadOnly: true, modelCalls: 0, externalActions: 0 };
    await save(`chat-${args[1]}-${stamp}.json`, report);
    await save(`chat-${args[1]}-latest.json`, report);
    console.log(JSON.stringify({ ok: true, state: observed.state, chatId: observed.chatId,
      sourceMessageId: observed.sourceMessage?.id ?? null, samePromptAsBaseline: observed.sourceMessage?.text === originalPrompt,
      commandStatus: observed.command?.status ?? null, runId: null, modelCalls: 0, externalActions: 0 }));
  } else {
    const events = observed.events as Json[], run = observed.run as Json;
    const captured = record(observed.captured?.result_json), structured = record(captured.structured);
    const taskText = record(captured.researchEvidenceContext).taskText ?? observed.directive?.content ?? run.trigger_reason?.content ?? "";
    const plan = await readJson(new URL("apply-plan.json", directory));
    const modelConfig = record(captured.researchEvidenceContext).modelConfig ?? plan?.modelConfig ?? {};
    const requiredContractText = formatWorkshopResearchContract(modelConfig, taskText);
    const configured = events.filter(e => e.type === "agent_configured").map(event => {
      const snapshot = record(event.metadata?.runtimeRunSnapshot), assembly = record(record(snapshot.extra).promptAssembly);
      return { eventId: event.id, at: event.created_at, engine: snapshot.engine, adapter: snapshot.adapter, model: snapshot.model,
        runtimeHash: snapshot.runtimeHash, promptHash: snapshot.promptHash, systemPromptHash: snapshot.systemPromptHash,
        finalValidationPolicy: record(snapshot.extra).finalValidationPolicy ?? null,
        maxToolCalls: event.metadata?.maxToolCalls ?? record(snapshot.extra).maxToolCalls,
        promptAssembly: { version: assembly.version, workVersion: assembly.workVersion,
          researchContractActive: assembly.researchContractActive, researchContractVersion: assembly.researchContractVersion,
          researchContractHash: assembly.researchContractHash, systemPromptChars: assembly.systemPromptChars, taskPromptChars: assembly.taskPromptChars },
        // Prompt assembly uses sha256Hex's JSON representation of a string,
        // while web-page snapshots hash the raw body bytes.
        expectedResearchContractHash: requiredContractText ? digest(JSON.stringify(requiredContractText)) : null,
        contractHashMatches: requiredContractText !== null && assembly.researchContractHash === digest(JSON.stringify(requiredContractText)) };
    });
    const bodyEvents = events.filter(e => e.type === "source_checked" && e.metadata?.receiptAuthority === "runtime"
      && isSavedResearchPageMethod(record(e.metadata)) && e.metadata?.evidenceId && e.metadata?.contentHash);
    const groups = new Map<string, Json[]>();
    for (const event of bodyEvents) {
      const key = JSON.stringify([event.metadata.evidenceId, event.metadata.contentHash]);
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    const pages = await Promise.all([...groups.values()].map(inspectPageGroup));
    const validIds = new Set(pages.flatMap(page => page.validEventIds));
    const eventInputs = events.map(e => ({ id: e.id, runId: e.run_id, type: e.type, metadata: e.metadata }));
    const runtimeVerification = events.filter(e => ["research_evidence_verified", "research_evidence_insufficient"].includes(e.type))
      .map(e => ({ eventId: e.id, type: e.type, at: e.created_at, receiptAuthority: e.metadata?.receiptAuthority,
        status: e.metadata?.status, contractVersion: e.metadata?.contractVersion, coverage: e.metadata?.coverage,
        gaps: e.metadata?.gaps, warnings: e.metadata?.warnings, verifiedEventIds: e.metadata?.verifiedEventIds }));
    const completion = record(run.completion_json), metadata = record(record(completion.request).metadata);
    const researchEvents = eventInputs.filter(e => validIds.has(e.id) || e.type === "research_quote_selected");
    const observation = await observeResearchReport({ capturedOutputPresent: Boolean(observed.captured), runStatus: run.status,
      sources: { modelConfig, taskText, runId: run.id, events: researchEvents },
      expectedCanonicalHash: metadata.researchDelivery?.canonicalHash,
      finalize: () => (metadata.researchDelivery?.version === "reader-report/v1" ? finalizeWorkshopResearchReaderDelivery : finalizeWorkshopResearchDelivery)({ modelConfig, taskText, workshopId: workId, runId: run.id,
        events: researchEvents, result: captured as WorkshopExecutionResult }) });
    const { derivedVerification, sourceProgress } = observation;
    const presentation = Object.keys(record(structured.presentation)).length ? record(structured.presentation) : record(metadata.presentation);
    const reportMarkdown = typeof presentation.reportMarkdown === "string" ? presentation.reportMarkdown : "";
    const reportText = redact(reportMarkdown);
    const terminal = ["completed", "failed", "cancelled", "interrupted", "needs_review"].includes(run.status);
    const candidateChecks: Json[] = [];
    for (const event of events.filter(e => ["research_final_validation_passed", "research_final_validation_rejected"].includes(e.type))) {
      const body = typeof event.body === "string" ? event.body : "";
      const attempt = event.metadata?.attempt;
      assert(Number.isSafeInteger(attempt) && attempt >= 0 && attempt <= 2, "invalid_validation_attempt");
      const candidateText = redact(body);
      const candidateFile = `candidate-${run.id}-${attempt}.txt`;
      try { await writeFile(new URL(candidateFile, directory), candidateText, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      assert.equal(await readFile(new URL(candidateFile, directory), "utf8"), candidateText, "candidate_utf8_readback_failed");
      candidateChecks.push({ eventId: event.id, type: event.type, attempt, at: event.created_at,
        file: candidateFile, chars: body.length, hash: digest(body), redacted: candidateText !== body,
        feedback: event.metadata?.feedback ?? null, status: event.metadata?.status,
        semanticStatus: event.metadata?.semanticStatus, maxCorrections: event.metadata?.maxCorrections,
        maxExtraForwards: event.metadata?.maxExtraForwards, reservedOutputTokens: event.metadata?.reservedOutputTokens,
        timeoutMs: event.metadata?.timeoutMs });
    }
    const rejectedTranscripts: Json[] = [];
    for (const event of events.filter(e => e.type === "agent_final_output_rejected")) {
      const body = typeof event.body === "string" ? event.body : "";
      const transcriptText = redact(body);
      const file = `rejected-transcript-${run.id}-${event.id}.txt`;
      try { await writeFile(new URL(file, directory), transcriptText, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      assert.equal(await readFile(new URL(file, directory), "utf8"), transcriptText, "rejected_transcript_utf8_readback_failed");
      rejectedTranscripts.push({ eventId: event.id, file, chars: body.length, hash: digest(body),
        redacted: transcriptText !== body, metadata: event.metadata, utf8ReadbackPassed: true });
    }
    const reportFile = terminal && reportText ? `report-${run.id}.md` : null;
    if (reportFile) {
      await writeFile(new URL(reportFile, directory), reportText, { encoding: "utf8", mode: 0o600 });
      assert.equal(await readFile(new URL(reportFile, directory), "utf8"), reportText, "utf8_report_readback_failed");
    }
    // agent_text may be a 4,000-character event summary. Export the exact output
    // checkpoint; on runtime rejection this may be an error, not model text.
    // Candidate messages and the rejected transcript are preserved separately.
    const rawOutput = typeof captured.output === "string" ? captured.output : null;
    const rawOutputFile = terminal && rawOutput !== null ? `raw-output-${run.id}.txt` : null;
    if (rawOutputFile && rawOutput !== null) {
      try {
        await writeFile(new URL(rawOutputFile, directory), rawOutput, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      assert.equal(await readFile(new URL(rawOutputFile, directory), "utf8"), rawOutput, "captured_output_utf8_readback_failed");
    }
    const deliveries = observed.deliveries.map((d: Json) => ({ id: d.id, chatId: d.chat_id, sourceMessageId: d.source_message_id,
      messageId: d.message_id, status: d.status, runStatus: d.run_status, attempts: d.attempts,
      lastErrorCode: d.last_error_code, deliveredAt: d.delivered_at, messageAt: d.message_at,
      messageFound: d.role === "assistant", correctChat: d.message_chat_id === d.chat_id,
      receiptMatches: d.metadata?.workshopChatDelivery?.deliveryId === d.id,
      partTypes: Array.isArray(d.parts) ? d.parts.map((p: Json) => p.type) : [],
      textChars: textOf(d.parts).length, textHash: digest(textOf(d.parts)) }));
    const baseline = await readJson(baselinePath);
    const metrics = { searchCalls: uniqueCalls(events, "webSearch"), webReadPageCalls: uniqueCalls(events, "webReadPage"),
      bodyReceiptEvents: bodyEvents.length, uniqueBodySnapshots: pages.length,
      diskValidatedSnapshots: pages.filter(p => p.available && p.hashMatches && p.identityMatches).length,
      uniqueWindows: pages.reduce((total, p) => total + (p.uniqueWindowCount ?? 0), 0),
      coveredChars: pages.reduce((total, p) => total + (p.coveredChars ?? 0), 0),
      completePrimarySources: sourceProgress.coverage.filter(p => p.status === "complete").length,
      requiredPrimarySources: sourceProgress.coverage.length };
    const evidence = { observedAt, ownerId, workId, baselineRunId, run: { id: run.id, status: run.status, createdAt: run.created_at,
      startedAt: run.started_at, completedAt: run.completed_at, error: run.error, triggerReason: run.trigger_reason,
      inputSnapshotKeys: Object.keys(run.input_snapshot ?? {}), continuationIncluded: Boolean(run.input_snapshot?.chatContinuation) },
      sourceMessage: observed.sourceMessage, command: observed.command, directive: observed.directive, workItems: observed.items,
      matchedInput: { expectedPrompt: originalPrompt, sourcePromptMatches: observed.sourceMessage?.text === originalPrompt,
        primaryDirectiveMatches: observed.directive?.content === originalPrompt,
        baselineArtifactsUntouched: true, persistentMemoryMayDiffer: true },
      eventCount: events.length, configured, metrics, pages, runtimeVerification, completionResearchEvidence: metadata.researchEvidence ?? null,
      sourceCheckedReceipts: bodyEvents.map(e => ({ eventId: e.id, runId: e.run_id, workshopId: e.workshop_id,
        type: e.type, at: e.created_at, metadata: e.metadata })),
      allSourceCheckedReceipts: events.filter(e => e.type === "source_checked" && e.metadata?.receiptAuthority === "runtime")
        .map(e => ({ eventId: e.id, runId: e.run_id, workshopId: e.workshop_id, type: e.type, at: e.created_at, metadata: e.metadata })),
      completionResearchDelivery: metadata.researchDelivery ?? null,
      correctionForwards: events.filter(e => e.type === "research_final_validation_forward" && e.metadata?.receiptAuthority === "runtime")
        .map(e => ({ eventId: e.id, at: e.created_at, ...e.metadata })),
      quoteSelections: events.filter(e => e.type === "research_quote_selected" && e.metadata?.receiptAuthority === "runtime")
        .map(e => ({ eventId: e.id, runId: e.run_id, workshopId: e.workshop_id, type: e.type,
          at: e.created_at, metadata: e.metadata, ...e.metadata })),
      // These are existing event summaries, not reconstructed model requests.
      // Preserve truncation/unknowns instead of inferring a missing query.
      researchToolCallSummaries: events.filter(e => ["tool_call", "tool_error"].includes(e.type)
        && e.metadata?.toolName === "webReadPage")
        .map(e => ({ eventId: e.id, type: e.type, at: e.created_at,
          toolUseId: e.metadata?.toolUseId, body: e.body })),
      researchToolAdmissions: events.filter(e => e.type === "research_tool_admitted" && e.metadata?.receiptAuthority === "runtime")
        .map(e => ({ eventId: e.id, at: e.created_at, ...e.metadata })),
      sourceRecoveryDenials: events.filter(e => e.type === "research_source_recovery_denied" && e.metadata?.receiptAuthority === "runtime")
        .map(e => ({ eventId: e.id, at: e.created_at, ...e.metadata })),
      providerStreamDiagnostics: events.filter(e => e.metadata?.providerStreamDiagnostics)
        .map(e => ({ eventId: e.id, at: e.created_at, diagnostics: e.metadata.providerStreamDiagnostics })),
      candidateChecks, rejectedTranscripts,
      derivedGate: observation.derivedGate, sourceProgress,
      deliveryHashMatches: observation.deliveryHashMatches,
      derivedVerification, deliveryVerification: observation.deliveryVerification,
      canonicalPresentation: observation.canonicalPresentation,
      finalOutputReceipts: events.filter(e => ["agent_final_output", "agent_final_output_rejected", "research_report_verified", "research_report_rejected",
        "research_final_validation_passed", "research_final_validation_rejected"].includes(e.type))
        .map(e => ({ eventId: e.id, type: e.type, metadata: e.metadata })),
      captured: { present: Boolean(observed.captured), status: captured.status, durationMs: captured.durationMs,
        toolCallCount: captured.toolCallCount, workerId: observed.captured?.worker_id, fencingToken: observed.captured?.fencing_token,
        runtimeFailure: captured.runtimeFailure ?? null,
        directiveIds: observed.captured?.directive_ids, pinnedResearchContext: captured.researchEvidenceContext ?? null },
      researchEvidence: structured.researchEvidence ?? null, presentation,
      report: { file: reportFile, chars: reportText.length, hash: digest(reportText), redacted: reportText !== reportMarkdown },
      rawOutput: { file: rawOutputFile, source: "workshop_run_outputs.result_json.output", chars: rawOutput?.length ?? 0,
        hash: rawOutput === null ? null : digest(rawOutput), exactCapturedOutput: rawOutputFile !== null,
        utf8ReadbackPassed: rawOutputFile !== null },
      deliveries, recentAssistant: observed.recentAssistant,
      failures: events.filter(e => /failed|error|timeout|budget/.test(e.type) && e.type !== "context_budget_report")
        .map(e => ({ eventId: e.id, type: e.type, at: e.created_at, title: e.title, body: e.body })),
      memoryWrites: events.filter(e => e.type === "memory_written").map(e => ({ eventId: e.id, status: e.metadata?.status, sourceEventIds: e.metadata?.sourceEventIds })),
      comparison: { baseline: baseline ? { runId: baselineRunId, eventCount: baseline.eventCount, searchCalls: baseline.metrics?.searchCalls ?? null,
        uniqueBodySnapshots: baseline.metrics?.uniqueBodySnapshots ?? null,
        primarySourceBodies: baseline.metrics?.completePrimarySources ?? null, savedBodyChars: baseline.metrics?.coveredChars ?? null,
        status: baseline.run?.status ?? null } : null,
        rerun: metrics },
      databaseReadOnly: true, modelCalls: 0, externalActions: 0,
      interpretationBoundary: "正文连续覆盖和报告位置字段不证明公式、图片或科学结论已核验；需人工逐结论对照原文。" };
    await save(`run-${run.id}-${stamp}.json`, evidence);
    await save(`run-${run.id}-latest.json`, evidence);
    if (terminal) await save(`run-${run.id}-terminal-${stamp}.json`, evidence);
    console.log(JSON.stringify({ ok: true, state: run.status, terminal, runId: run.id, chatId: observed.chatId,
      sourceMessageId: observed.sourceMessage?.id, commandStatus: observed.command?.status,
      samePromptAsBaseline: observed.sourceMessage?.text === originalPrompt && observed.directive?.content === originalPrompt,
      eventCount: events.length, configured: configured.at(-1) ?? null, metrics,
      coverage: sourceProgress.coverage.map(p => ({ id: p.sourceId, status: p.status, coveredChars: p.coveredChars, totalChars: p.totalChars ?? null })),
      runtimeGate: runtimeVerification.at(-1)?.status ?? null,
      candidateChecks: candidateChecks.map(check => ({ attempt: check.attempt, type: check.type, chars: check.chars })),
      derivedGate: observation.derivedGate,
      gapCount: derivedVerification?.gaps.length ?? null, delivery: deliveries.map((d: Json) => ({ status: d.status, messageFound: d.messageFound, receiptMatches: d.receiptMatches })),
      reportFile, rawOutputFile, rawOutputChars: rawOutput?.length ?? 0,
      rawOutputHash: rawOutput === null ? null : digest(rawOutput), modelCalls: 0, externalActions: 0 }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error instanceof assert.AssertionError ? error.message : "rerun_observation_failed",
    code: typeof (error as any)?.code === "string" ? (error as any).code : undefined }));
  process.exitCode = 1;
} finally { await sql.end({ timeout: 2 }); }
