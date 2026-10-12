import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { appendAgentAnswerAuditEvent, getAgentAnswerAuditSummary, hashAgentAnswerPayload, listAgentAnswerAuditEvents, reserveAgentAnswerTurn } from "@/lib/db/agent-answer-audits";
import { saveOwnedChatMessages, updateOwnedChatTitle } from "@/lib/db/owned-chat-messages";
import { closePostgresDb } from "@/lib/db/adapters/postgres";

const url = process.env.ZHIYU_TEST_DATABASE_URL;
if (!url || !/^\/zhiyu_test_[a-f0-9]{32}$/.test(new URL(url).pathname) || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) || process.env.POSTGRES_URL !== url) throw Error("Explicit isolated database required");
const client = postgres(url, { max: 1 });
const checks: Array<{ id: string; passed: boolean }> = [];
const owner = randomUUID(), foreign = randomUUID(), chatId = randomUUID(), otherChat = randomUUID(), foreignChat = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), foreignMessageId = randomUUID();
function pass(id: string) { checks.push({ id, passed: true }); }
const message = (id: string, target = chatId, role = "user", text = "当前状态核对。") => ({ id, chatId: target, role, parts: [{ type: "text", text }], attachments: [], createdAt: new Date(), metadata: null });
const request = { ownerId: owner, chatId, clientRequestId: randomUUID(), userMessageId: userId, assistantMessageId: assistantId, requestPayloadHash: hashAgentAnswerPayload({ query: "current status", chatId, userId, assistantId }), schemaVersion: "answer-evidence.v1", ruleVersion: "isolated.v1", runtimeHash: "isolated-runtime", payload: { answerEvidenceMode: "enforce_critical" } };
try {
  assert.equal((await client`SELECT current_database() AS name`)[0].name, new URL(url).pathname.slice(1));
  await client`INSERT INTO "User"(id,email) VALUES (${owner},${owner + "@example.invalid"}),(${foreign},${foreign + "@example.invalid"})`;
  await saveOwnedChatMessages({ ownerId: owner, chatId, title: "隔离审计", messages: [message(userId)] });
  await saveOwnedChatMessages({ ownerId: owner, chatId: otherChat, title: "Other", messages: [] });
  await saveOwnedChatMessages({ ownerId: foreign, chatId: foreignChat, title: "Foreign", messages: [message(foreignMessageId, foreignChat)] });
  assert.equal((await client`SELECT title FROM "Chat" WHERE id=${chatId}`)[0].title, "隔离审计");
  assert.ok(Array.isArray((await client`SELECT parts FROM "Message_v2" WHERE id=${userId}`)[0].parts)); pass("utf8_json_roundtrip");

  await assert.rejects(saveOwnedChatMessages({ ownerId: owner, chatId: foreignChat, title: "overwrite", messages: [] }), { status: 403 });
  await assert.rejects(saveOwnedChatMessages({ ownerId: owner, chatId: otherChat, title: "Other", messages: [message(userId, otherChat, "user", "overwrite")] }), { status: 409 });
  await assert.rejects(saveOwnedChatMessages({ ownerId: owner, chatId, title: "Other", messages: [message(userId, chatId, "assistant")] }), { status: 409 });
  await updateOwnedChatTitle({ ownerId: owner, chatId: foreignChat, title: "overwrite" });
  assert.equal((await client`SELECT title FROM "Chat" WHERE id=${foreignChat}`)[0].title, "Foreign");
  assert.equal((await client`SELECT parts FROM "Message_v2" WHERE id=${userId}`)[0].parts[0].text, "当前状态核对。"); pass("chat_message_owner_role_boundary");

  const rolledBackChat = randomUUID(), newMessage = randomUUID();
  await assert.rejects(saveOwnedChatMessages({ ownerId: owner, chatId: rolledBackChat, title: "rollback", messages: [message(newMessage, rolledBackChat), message(foreignMessageId, rolledBackChat)] }), { status: 409 });
  assert.equal((await client`SELECT count(*)::int AS count FROM "Chat" WHERE id=${rolledBackChat}`)[0].count, 0);
  assert.equal((await client`SELECT count(*)::int AS count FROM "Message_v2" WHERE id=${newMessage}`)[0].count, 0); pass("atomic_save_rejection");

  const contestedMessage = randomUUID();
  const concurrentSaves = await Promise.allSettled([chatId, otherChat].map((target) => saveOwnedChatMessages({ ownerId: owner, chatId: target, title: "unchanged", messages: [message(contestedMessage, target, "user", target)] })));
  assert.equal(concurrentSaves.filter((value) => value.status === "fulfilled").length, 1);
  const rejectedSave = concurrentSaves.find((value) => value.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejectedSave.reason.status, 409);
  const contested = (await client`SELECT * FROM "Message_v2" WHERE id=${contestedMessage}`)[0];
  assert.equal(contested.parts[0].text, contested.chatId); pass("concurrent_cross_chat_save_one_binding");

  const reserved = await Promise.all(Array.from({ length: 8 }, () => reserveAgentAnswerTurn(request)));
  assert.equal(reserved.filter((value) => value.created).length, 1);
  const turnId = reserved[0].turnId; assert.equal(new Set(reserved.map((value) => value.turnId)).size, 1);
  const [placeholder] = await client`SELECT * FROM "Message_v2" WHERE id=${assistantId}`;
  assert.equal(placeholder.role, "assistant"); assert.deepEqual(placeholder.parts, [{ type: "data-answerEvidence", data: { turnId } }]);
  assert.equal((await client`SELECT count(*)::int AS count FROM agent_answer_audits WHERE turn_id=${turnId}`)[0].count, 1); pass("concurrent_reserve_one_turn_placeholder");
  await saveOwnedChatMessages({ ownerId: owner, chatId, title: "unchanged", messages: [{ ...message(assistantId, chatId, "assistant"), parts: [] }] });
  assert.deepEqual((await client`SELECT parts FROM "Message_v2" WHERE id=${assistantId}`)[0].parts, [{ type: "data-answerEvidence", data: { turnId } }]);
  await saveOwnedChatMessages({ ownerId: owner, chatId, title: "unchanged", messages: [{ ...message(assistantId, chatId, "assistant"), parts: [{ type: "data-answerEvidence", data: { turnId: randomUUID(), outcome: "supported_fields" } }] }] });
  assert.deepEqual((await client`SELECT parts FROM "Message_v2" WHERE id=${assistantId}`)[0].parts, [{ type: "data-answerEvidence", data: { turnId } }]); pass("empty_or_wrong_ref_save_preserves_server_placeholder");

  await assert.rejects(reserveAgentAnswerTurn({ ...request, requestPayloadHash: hashAgentAnswerPayload({ query: "changed" }) }), { status: 409 });
  await assert.rejects(reserveAgentAnswerTurn({ ...request, clientRequestId: randomUUID() }), { status: 409 });
  await assert.rejects(reserveAgentAnswerTurn({ ...request, ownerId: foreign }), { status: 403 });
  await assert.rejects(reserveAgentAnswerTurn({ ...request, clientRequestId: randomUUID(), userMessageId: foreignMessageId, assistantMessageId: randomUUID() }), { status: 403 });
  await assert.rejects(reserveAgentAnswerTurn({ ...request, clientRequestId: randomUUID(), assistantMessageId: foreignMessageId }), { status: 409 });
  assert.equal(await getAgentAnswerAuditSummary({ ownerId: foreign, turnId }), null);
  assert.deepEqual(await listAgentAnswerAuditEvents({ ownerId: foreign, turnId }), []); pass("reserve_replay_owner_conflicts");

  const append = (eventKey: string, eventType: string, payload: Record<string, unknown>) => appendAgentAnswerAuditEvent({ ownerId: owner, turnId, eventKey, eventType, payload });
  const duplicate = await Promise.all(Array.from({ length: 6 }, () => append("read:r1:constructed", "evidence_registered", { observed: true, contentHash: "v1" })));
  assert.equal(duplicate.filter((value) => value.created).length, 1);
  await assert.rejects(append("read:r1:constructed", "evidence_registered", { observed: false }), { status: 409 });
  await append("read:r1:emitted", "evidence_registered", { observed: true, delivery: "tool_result_emitted" });
  await assert.rejects(appendAgentAnswerAuditEvent({ ownerId: foreign, turnId, eventKey: "forged", eventType: "final_evidence", payload: {} }), { status: 404 });
  await assert.rejects(append("turn_started_again", "turn_started", {}), { status: 400 }); pass("append_idempotence_stage_owner_boundary");

  await append("final_evidence", "final_evidence", { schemaVersion: "answer-decision.v1", ruleVersion: "isolated.v1", runtimeHash: "private-runtime", outcome: "unknown", displayText: "当前执行活性未知。", resolutions: [{ requirementId: "activity", state: "unknown", evidenceIds: ["r1"], reason: "No active mapping", presentationIncluded: true }], evidenceRefs: [{ evidenceId: "r1", observedAt: new Date().toISOString(), status: "unknown", authorization: { ownerId: owner } }], rawDraft: { text: "private draft" }, rawDraftHash: "private" });
  assert.equal((await getAgentAnswerAuditSummary({ ownerId: owner, turnId }))?.status, "running");
  assert.equal((await getAgentAnswerAuditSummary({ ownerId: owner, turnId }))?.evidence, undefined); pass("final_evidence_is_not_terminal");
  await append("turn_completed", "turn_completed", { terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" } });
  assert.equal((await append("turn_completed", "turn_completed", { terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" } })).created, false);
  await assert.rejects(append("late_result", "evidence_registered", { observed: true }), { status: 409 });
  await assert.rejects(append("second_terminal", "turn_failed", { terminal: { status: "failed" } }), { status: 409 });
  const completed = await reserveAgentAnswerTurn(request); assert.equal(completed.created, false); assert.equal(completed.status, "completed");
  assert.equal(completed.summary?.finalText, "当前执行活性未知。");
  const serialized = JSON.stringify(completed.summary);
  for (const value of ["private draft", "rawDraft", "authorization", "ownerId", "private-runtime"]) assert.ok(!serialized.includes(value)); pass("terminal_seal_replay_public_projection");

  await saveOwnedChatMessages({ ownerId: owner, chatId, title: "unchanged", messages: [{ ...message(assistantId, chatId, "assistant", "tampered mirror"), parts: [{ type: "data-answerEvidence", data: { turnId, outcome: "supported_fields", auditPersisted: true } }] }] });
  assert.deepEqual((await client`SELECT parts FROM "Message_v2" WHERE id=${assistantId}`)[0].parts, [{ type: "data-answerEvidence", data: { turnId } }]);
  assert.equal((await getAgentAnswerAuditSummary({ ownerId: owner, turnId }))?.finalText, "当前执行活性未知。"); pass("client_mirror_cannot_modify_audit");
  const events = await listAgentAnswerAuditEvents({ ownerId: owner, turnId });
  assert.ok(events.every((value, index) => index === 0 || value.seq > events[index - 1].seq));
  assert.ok(events.every((value) => value.schemaVersion === request.schemaVersion && value.ruleVersion === request.ruleVersion && value.runtimeHash === request.runtimeHash)); pass("source_versions_and_monotonic_sequence");

  const failingAssistant = randomUUID();
  const aborted = await reserveAgentAnswerTurn({ ...request, clientRequestId: randomUUID(), assistantMessageId: failingAssistant, requestPayloadHash: hashAgentAnswerPayload({ assistant: failingAssistant }) });
  await appendAgentAnswerAuditEvent({ ownerId: owner, turnId: aborted.turnId, eventKey: "turn_aborted", eventType: "turn_aborted", payload: { terminal: { status: "aborted", cleanupStatus: "unknown", error: "User aborted" } } });
  assert.equal((await getAgentAnswerAuditSummary({ ownerId: owner, turnId: aborted.turnId }))?.status, "aborted"); pass("aborted_turn_is_not_complete");
  const recoveryAssistant = randomUUID();
  const recovered = await reserveAgentAnswerTurn({ ...request, clientRequestId: randomUUID(), assistantMessageId: recoveryAssistant, requestPayloadHash: hashAgentAnswerPayload({ purpose: "audit-recovery-contract", assistant: recoveryAssistant }) });
  await appendAgentAnswerAuditEvent({ ownerId: owner, turnId: recovered.turnId, eventKey: "final_evidence", eventType: "final_evidence", payload: { schemaVersion: "answer-decision.v1", outcome: "supported_fields", displayText: "Uncommitted prior candidate", evidenceRefs: [{ evidenceId: "prior" }] } });
  await appendAgentAnswerAuditEvent({ ownerId: owner, turnId: recovered.turnId, eventKey: "final_evidence_audit_failure", eventType: "final_evidence", payload: { schemaVersion: "answer-decision.v1", ruleVersion: "recovery-contract.v1", outcome: "unknown", auditIncomplete: true, displayText: "本轮回答审计不完整，目标运行状态不能据此推断。", resolutions: [{ requirementId: "runtime_observation", state: "unknown", reason: "audit_incomplete", evidenceIds: [], presentationIncluded: true }], evidenceRefs: [] } });
  await appendAgentAnswerAuditEvent({ ownerId: owner, turnId: recovered.turnId, eventKey: "turn_terminal_audit_failure", eventType: "turn_failed", payload: { terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "failed", cleanupStatus: "completed", completionScope: "answer_delivery", runtimeStatus: "completed" } } });
  const recoveredSummary = await getAgentAnswerAuditSummary({ ownerId: owner, turnId: recovered.turnId });
  assert.equal(recoveredSummary?.status, "failed"); assert.equal(recoveredSummary?.evidence?.auditIncomplete, true); assert.equal(recoveredSummary?.evidence?.outcome, "unknown"); assert.deepEqual(recoveredSummary?.evidence?.evidenceRefs, []);
  assert.equal(recoveredSummary?.runtimeTerminal?.completionScope, "answer_delivery"); assert.equal(recoveredSummary?.runtimeTerminal?.runtimeStatus, "completed");
  const recoveryEvents = await listAgentAnswerAuditEvents({ ownerId: owner, turnId: recovered.turnId });
  assert.equal(recoveryEvents.length, 4); assert.equal(recoveryEvents[1].payload.displayText, "Uncommitted prior candidate"); pass("append_only_audit_recovery_preserves_runtime_distinction");
  const invalidAssistant = randomUUID();
  await assert.rejects(reserveAgentAnswerTurn({ ...request, clientRequestId: randomUUID(), assistantMessageId: invalidAssistant, payload: { oversized: "x".repeat(1024 * 1024 + 1) } }), { status: 413 });
  assert.equal((await client`SELECT count(*)::int AS count FROM "Message_v2" WHERE id=${invalidAssistant}`)[0].count, 0); pass("reservation_failure_rolls_back_placeholder");
  const browserAssistant = randomUUID();
  const browserDisplayText = "合成桌面核验夹具：已读取暂停配置及有限执行观测，回答瞬间的执行活性未知。";
  const browserEvidence = { schemaVersion: "answer-decision.v1", ruleVersion: "browser-contract.v1", outcome: "supported_fields", displayText: browserDisplayText, resolutions: ["loop_configuration", "runtime_observation"].map(requirementId => ({ requirementId, state: "supported", evidenceIds: ["browser-r1"], reason: "synthetic_ui_fixture", presentationIncluded: true })), evidenceRefs: [{ evidenceId: "browser-r1", observedAt: new Date().toISOString(), status: "no_active_linked_execution_observed" }] };
  const browserTurn = await reserveAgentAnswerTurn({ ...request, clientRequestId: randomUUID(), assistantMessageId: browserAssistant, requestPayloadHash: hashAgentAnswerPayload({ purpose: "browser-contract", assistant: browserAssistant }) });
  await appendAgentAnswerAuditEvent({ ownerId: owner, turnId: browserTurn.turnId, eventKey: "final_evidence", eventType: "final_evidence", payload: browserEvidence });
  await appendAgentAnswerAuditEvent({ ownerId: owner, turnId: browserTurn.turnId, eventKey: "turn_completed", eventType: "turn_completed", payload: { terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" } } });
  await saveOwnedChatMessages({ ownerId: owner, chatId, title: "unchanged", messages: [message(browserAssistant, chatId, "assistant", browserDisplayText)] });
  const positiveParts = (await client`SELECT parts FROM "Message_v2" WHERE id=${browserAssistant}`)[0].parts;
  assert.equal(positiveParts.filter((part: any) => part.type === "text").map((part: any) => part.text).join(""), (await getAgentAnswerAuditSummary({ ownerId: owner, turnId: browserTurn.turnId }))?.finalText); pass("canonical_message_body_matches_audit_final_text");

  const tamperedAssistant = randomUUID();
  const tamperedCanonicalText = "合成正文绑定夹具：仅支持读取时的配置和有限观测，当前执行活性未知。";
  const tamperedDisplayText = "合成改写正文：声称任务已停止并且全部执行成功。";
  const tamperedTurn = await reserveAgentAnswerTurn({ ...request, clientRequestId: randomUUID(), assistantMessageId: tamperedAssistant, requestPayloadHash: hashAgentAnswerPayload({ purpose: "body-binding-negative", assistant: tamperedAssistant }) });
  await saveOwnedChatMessages({ ownerId: owner, chatId, title: "unchanged", messages: [message(tamperedAssistant, chatId, "assistant", tamperedCanonicalText)] });
  await appendAgentAnswerAuditEvent({ ownerId: owner, turnId: tamperedTurn.turnId, eventKey: "final_evidence", eventType: "final_evidence", payload: { ...browserEvidence, displayText: tamperedCanonicalText } });
  await appendAgentAnswerAuditEvent({ ownerId: owner, turnId: tamperedTurn.turnId, eventKey: "turn_completed", eventType: "turn_completed", payload: { terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" } } });
  await saveOwnedChatMessages({ ownerId: owner, chatId, title: "unchanged", messages: [message(tamperedAssistant, chatId, "assistant", tamperedDisplayText)] });
  const tamperedMessage = (await client`SELECT id,"chatId",parts FROM "Message_v2" WHERE id=${tamperedAssistant}`)[0];
  const tamperedSummary = await getAgentAnswerAuditSummary({ ownerId: owner, turnId: tamperedTurn.turnId });
  assert.equal(tamperedMessage.chatId, tamperedSummary?.chatId); assert.equal(tamperedMessage.id, tamperedSummary?.assistantMessageId);
  assert.ok(tamperedMessage.parts.some((part: any) => part.type === "data-answerEvidence" && part.data.turnId === tamperedTurn.turnId));
  assert.equal(tamperedSummary?.evidence?.outcome, "supported_fields"); assert.equal(tamperedSummary?.finalText, tamperedCanonicalText);
  assert.notEqual(tamperedMessage.parts.filter((part: any) => part.type === "text").map((part: any) => part.text).join(""), tamperedSummary?.finalText);
  assert.equal((await listAgentAnswerAuditEvents({ ownerId: owner, turnId: tamperedTurn.turnId })).length, 3); pass("same_bound_assistant_body_edit_cannot_rewrite_audit_final_text");
  const fakeAssistant = randomUUID(), unknownTurnId = randomUUID();
  await client`INSERT INTO "Message_v2"(id,"chatId",role,parts,attachments,"createdAt") VALUES (${fakeAssistant},${otherChat},'assistant',${client.json([{ type: "text", text: "合成恶意缓存：声称已核验。" }, { type: "data-answerEvidence", data: { turnId: unknownTurnId, outcome: "supported_fields", auditPersisted: true } }, { type: "data-answerEvidence", data: { turnId: browserTurn.turnId, outcome: "supported_fields", auditPersisted: true } }])},'[]',now())`;
  const foreignAssistant = randomUUID();
  const foreignTurn = await reserveAgentAnswerTurn({ ...request, ownerId: foreign, chatId: foreignChat, clientRequestId: randomUUID(), userMessageId: foreignMessageId, assistantMessageId: foreignAssistant, requestPayloadHash: hashAgentAnswerPayload({ purpose: "foreign-ui" }) });
  const sourceHashes = Object.fromEntries(["lib/db/agent-answer-audits.ts", "lib/db/owned-chat-messages.ts", "lib/db/schema.pg.ts", "lib/db/schema.ts", "lib/db/migrations/0159_add_agent_answer_audits.sql", "lib/db/migrations/meta/_journal.json", "tests/integration/agent-answer-audits.check.ts"].map((file) => [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  fs.writeFileSync(process.env.ZHIYU_TEST_CHECK_OUTPUT!, JSON.stringify({ status: "passed", checks, sourceHashes, fixtures: { owner, chatId, assistantMessageId: browserAssistant, turnId: browserTurn.turnId, canonicalDisplayText: browserDisplayText, abortedTurnId: aborted.turnId, tamperedTurnId: tamperedTurn.turnId, tamperedAssistantId: tamperedAssistant, tamperedCanonicalText, tamperedDisplayText, fakeChatId: otherChat, fakeAssistantId: fakeAssistant, unknownTurnId, foreignTurnId: foreignTurn.turnId }, modelCalls: 0, productionWrites: 0 }, null, 2), "utf8");
} finally {
  await closePostgresDb(); await client.end();
}
