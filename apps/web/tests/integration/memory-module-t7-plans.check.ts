import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent, registerExactUseForDispatch } from "@/lib/memory/context/dispatch";
import { admitExactUse } from "@/lib/memory/context/exact-use-admission";
import { getMemoryPlanForExecution, inspectMemoryPlan, prepareMemoryPlanExecution, rebaseLegacyMemoryPlan,
  revokeMemoryPlan, saveGeneratedMemoryPlan, finishMemoryPlanExecution } from "@/lib/memory/plans/service";
import { readOwnerSource } from "@/lib/memory/sources/service";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import { appendMemoryPlan, latestMemoryPlan, lockMemoryPlan } from "@/lib/memory/adapters/postgres/plans";
export async function checkMemoryModuleT7Plans(client: postgres.Sql, owner: string) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/); assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  const chatId = randomUUID(), observationId = randomUUID(), foreign = randomUUID(), planId = `t7-plan-${randomUUID()}`;
  const marker = `T7_PLAN_SOURCE_${randomUUID()}`, checks: string[] = [];
  await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${chatId},${owner},'T7 plan lineage',now(),'private')`;
  await client`INSERT INTO "User"(id,email) VALUES (${foreign},${foreign + '@example.invalid'})`;
  await client`INSERT INTO brain_observations(id,user_id,source_type,source_id,observed_at,content,content_hash,trust_level,metadata)
    VALUES (${observationId},${owner},'t7_plan_fixture',${randomUUID()},now(),${marker},'legacy-untrusted-hash','raw','{}'::jsonb)`;
  const plan = { id: planId, goal: "Review the recorded synthetic observation", notes: undefined,
    steps: [{ id: "read", description: "Report current source", status: "pending" as const }], createdAt: new Date() };
  function provider() {
    const faux = createFauxCore({}); let calls = 0;
    const agent = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: async (...args) => { calls++; return faux.streamSimple(...args); } });
    async function request(prompt: string) {
      faux.setResponses([fauxAssistantMessage("synthetic T7 plan execution")]); let terminal: string | undefined;
      for await (const message of agent.run({ operation: "run", prompt, options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } }))
        if (message.type === "runtime_terminal") terminal = message.runtimeTerminal?.status;
      return terminal;
    }
    return { agent, request, calls: () => calls };
  }
  let saved!: Awaited<ReturnType<typeof saveGeneratedMemoryPlan>>;
  await withMemoryDispatchContext(async () => {
    const runtime = provider(); bindMemoryDispatchRuntime(runtime.agent.metadata);
    const source = await readOwnerSource({ userId: owner, source: "brainObservations", id: observationId });
    assert.match(source.content, new RegExp(marker)); assert.equal(await runtime.request(source.content), "completed");
    const input = { userId: owner, plan, inputPrompt: "Current owner control input", renderedPrompt: `Selected immutable source:\n${source.content}`, taskId: chatId.toUpperCase(), workDir: null };
    saved = await saveGeneratedMemoryPlan(input); assert.equal(saved.state, "ready"); assert.equal(saved.sourceCount, 2);
    const retry = await saveGeneratedMemoryPlan(input); assert.equal(retry.replayed, true); assert.equal(retry.version, saved.version);
    await assert.rejects(saveGeneratedMemoryPlan({ ...input, inputPrompt: "changed owner input" }), { code: "memory_plan_revision_conflict" });
  });
  checks.push("Generated plan captures the actual source receipt plus a separate immutable owner input; retries are stable and changed payloads conflict");
  const execution = { userId: owner, planId, expectedVersion: saved.version, commandId: randomUUID().toUpperCase(), taskId: chatId.toUpperCase(), workDir: null };
  assert.equal((await getMemoryPlanForExecution(execution)).version, saved.version);
  await assert.rejects(prepareMemoryPlanExecution(execution), { code: "memory_plan_dispatch_required" });
  await assert.rejects(getMemoryPlanForExecution({ ...execution, userId: foreign, taskId: null }), { code: "memory_plan_unavailable" });
  const counts = async () => ({ plans: Number((await client`SELECT count(*)::int n FROM memory_plan_records WHERE user_id=${owner}`)[0].n),
    audits: Number((await client`SELECT count(*)::int n FROM brain_context_logs WHERE user_id=${owner}`)[0].n) });
  const fault = `t7_plan_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.metadata->'exactUse'->>'purpose'='approved_plan_execution' THEN RAISE EXCEPTION 'SYNTHETIC_PLAN_AUDIT_FAULT'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${fault} BEFORE INSERT ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION ${fault}()`);
  const beforeFault = await counts();
  try { await withMemoryDispatchContext(async () => { bindMemoryDispatchRuntime(provider().agent.metadata); await assert.rejects(prepareMemoryPlanExecution(execution)); }); }
  finally { await client.unsafe(`DROP TRIGGER ${fault} ON brain_context_logs`); await client.unsafe(`DROP FUNCTION ${fault}()`); }
  assert.deepEqual(await counts(), beforeFault, "Approval revision, command, and all source admissions roll back together");
  await withMemoryDispatchContext(async () => {
    const runtime = provider(); bindMemoryDispatchRuntime(runtime.agent.metadata);
    const approved = await prepareMemoryPlanExecution(execution); assert.equal(approved.state, "approved"); assert.equal(approved.revision, 2);
    assert.equal(await runtime.request(approved.originalPrompt), "completed"); assert.equal(runtime.calls(), 1);
    await assert.rejects(prepareMemoryPlanExecution(execution), { code: "memory_plan_execution_already_started" });
    const before = await counts(); await client`UPDATE brain_observations SET content=${marker + '_CORRECTION'} WHERE id=${observationId}`;
    assert.equal(await runtime.request(approved.originalPrompt), "failed"); assert.equal(runtime.calls(), 1); assert.deepEqual(await counts(), before);
  });
  await finishMemoryPlanExecution({ userId: owner, commandId: execution.commandId, status: "failed" });
  await finishMemoryPlanExecution({ userId: owner, commandId: execution.commandId, status: "failed" });
  const runFeedback = (await inspectMemoryPlan(owner, planId));
  assert.equal(runFeedback.kind === "memory_plan" && runFeedback.execution?.state, "failed");
  await withMemoryDispatchContext(async () => { bindMemoryDispatchRuntime(provider().agent.metadata); await assert.rejects(prepareMemoryPlanExecution(execution)); });
  checks.push("Real PG approval/receipt failure is atomic; restored receipts admit the actual Pi request, and corrected sources block the next request and approval replay");
  // Legacy recovery has no historical source certificate and must say so.
  const legacyId = `t7-legacy-${randomUUID()}`, legacyPlan = { ...plan, id: legacyId };
  await client`INSERT INTO native_agent_plans(id,owner_id,plan_id,plan_json,original_prompt,task_id,created_at,expires_at,updated_at)
    VALUES (${randomUUID()},${owner},${legacyId},${JSON.stringify(legacyPlan)}::jsonb,'UNVERIFIED_OLD_PROMPT_MUST_NOT_EXECUTE',${chatId},now(),now()-interval '1 hour',now())`;
  const preview = await inspectMemoryPlan(owner, legacyId); assert.equal(preview.kind, "legacy_unverified");
  if (preview.kind !== "legacy_unverified") throw Error("Legacy preview expected");
  await assert.rejects(rebaseLegacyMemoryPlan(owner, legacyId, { commandId: randomUUID(), expectedLegacyVersion: preview.legacyVersion, inputPrompt: "Current review", sourceReceiptIds: [] }), { code: "memory_plan_invalid_request" });
  const fresh = await readOwnerSource({ userId: owner, source: "brainObservations", id: observationId });
  const command = { commandId: randomUUID(), expectedLegacyVersion: preview.legacyVersion, inputPrompt: "Owner reviewed current objective", sourceReceiptIds: [fresh.receiptId], confirmed: true };
  const rebased = await rebaseLegacyMemoryPlan(owner, legacyId, command); assert.equal(rebased.historicalSources, "unknown_owner_rebased");
  assert.equal((await rebaseLegacyMemoryPlan(owner, legacyId, command)).version, rebased.version);
  const legacyExecution = { userId: owner, planId: legacyId, expectedVersion: rebased.version, commandId: randomUUID(), taskId: chatId, workDir: null };
  await withMemoryDispatchContext(async () => {
    const runtime = provider(); bindMemoryDispatchRuntime(runtime.agent.metadata);
    const approved = await prepareMemoryPlanExecution(legacyExecution); assert.ok(!approved.originalPrompt.includes("UNVERIFIED_OLD_PROMPT_MUST_NOT_EXECUTE"));
    assert.equal(await runtime.request(approved.originalPrompt), "completed");
    await revokeMemoryPlan(owner, legacyId, { commandId: randomUUID(), expectedVersion: approved.version });
    assert.equal(await runtime.request(approved.originalPrompt), "failed"); assert.equal(runtime.calls(), 1);
  });
  const legacyRow = await client`SELECT count(*)::int n FROM native_agent_plans WHERE owner_id=${owner} AND plan_id=${legacyId}`;
  assert.equal(legacyRow[0].n, 1, "Inspection cannot delete expired historical records");
  checks.push("Expired legacy row is preserved; explicit owner rebase records unknown historical sources, excludes cached prompt, and current plan revocation blocks a later request");
  const disposable = randomUUID(), disposableChat = randomUUID(), disposablePlan = `t7-disposable-${randomUUID()}`;
  await client`INSERT INTO "User"(id,email) VALUES (${disposable},${disposable + '@example.invalid'})`;
  await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${disposableChat},${disposable},'Disposable plan parent',now(),'private')`;
  let disposableSaved!: Awaited<ReturnType<typeof saveGeneratedMemoryPlan>>;
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime(provider().agent.metadata);
    disposableSaved = await saveGeneratedMemoryPlan({ userId: disposable, plan: { ...plan, id: disposablePlan },
      inputPrompt: "Disposable owner input", renderedPrompt: "Disposable proposal", taskId: disposableChat, workDir: null });
  });
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime(provider().agent.metadata);
    for (let index = 0; index < 64; index++) registerExactUseForDispatch(await admitExactUse({
      requester: { type: "chat", userId: disposable }, accessMode: "owner_override", purpose: `synthetic_capacity_${index}`,
      publishedRecords: [{ source: "brainObservations", id: disposableSaved.inputObservationId, fields: { content: "Disposable owner input" } }] }));
    const before = Number((await client`SELECT count(*)::int n FROM brain_context_logs WHERE user_id=${disposable}`)[0].n);
    await assert.rejects(prepareMemoryPlanExecution({ userId: disposable, planId: disposablePlan, expectedVersion: disposableSaved.version,
      commandId: randomUUID(), taskId: disposableChat, workDir: null }), { code: "memory_dispatch_context_unavailable" });
    assert.equal(Number((await client`SELECT count(*)::int n FROM brain_context_logs WHERE user_id=${disposable}`)[0].n), before);
    const pending = await inspectMemoryPlan(disposable, disposablePlan);
    assert.equal(pending.kind === "memory_plan" && pending.state, "ready");
  });
  await withMemoryDispatchContext(async () => {
    const runtime = provider(); bindMemoryDispatchRuntime(runtime.agent.metadata);
    const approved = await prepareMemoryPlanExecution({ userId: disposable, planId: disposablePlan, expectedVersion: disposableSaved.version,
      commandId: randomUUID(), taskId: disposableChat, workDir: null });
    assert.equal(await runtime.request(approved.originalPrompt), "completed");
    await client`DELETE FROM "Chat" WHERE id=${disposableChat}`;
    assert.equal(await runtime.request(approved.originalPrompt), "failed"); assert.equal(runtime.calls(), 1);
  });
  await client`DELETE FROM "User" WHERE id=${disposable}`;
  assert.equal(Number((await client`SELECT count(*)::int n FROM memory_plan_records WHERE user_id=${disposable}`)[0].n), 0);
  checks.push("Chat deletion remains available and invalidates its approved plan before another provider request; owner deletion cascades plan commands without FK obstruction");
  checks.push("A full existing dispatch registry rolls back approval, execution claim and every new source audit; the displayed proposal remains ready");
  const ttlPlan = `t7-ttl-${randomUUID()}`;
  await withMemoryDispatchContext(async () => {
    const runtime = provider(); bindMemoryDispatchRuntime(runtime.agent.metadata);
    const saved = await saveGeneratedMemoryPlan({ userId: owner, plan: { ...plan, id: ttlPlan },
      inputPrompt: "Synthetic bounded plan lifetime", renderedPrompt: "Synthetic bounded plan lifetime", taskId: chatId, workDir: null });
    const expiry = new Date(Date.now() + 2500);
    const timed = await withDatabaseTransaction(async () => {
      await lockMemoryPlan(db, owner, ttlPlan, "update"); const actual = await latestMemoryPlan(db, owner, ttlPlan); assert.ok(actual);
      return appendMemoryPlan(db, { ...actual, id: randomUUID(), revision: actual.revision + 1, parentVersion: saved.version,
        expiresAt: expiry.toISOString(), createdAt: new Date().toISOString() });
    });
    const approved = await prepareMemoryPlanExecution({ userId: owner, planId: ttlPlan, expectedVersion: timed.version,
      commandId: randomUUID(), taskId: chatId, workDir: null });
    assert.equal(await runtime.request(approved.originalPrompt), "completed");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now()) + 100));
    assert.equal(await runtime.request(approved.originalPrompt), "failed"); assert.equal(runtime.calls(), 1);
  });
  checks.push("An unchanged approved plan expires on the actual post-lock clock and cannot issue its next provider request");
  return { checks };
}
