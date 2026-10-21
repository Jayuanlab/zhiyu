import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect as baseExpect } from '@playwright/test';
import { checkMemoryModuleT6Http } from './memory-module-t6-http.mjs';
const expect = baseExpect.configure({ timeout: 60000 });

/** Actual owner HTTP and desktop against root's isolated synthetic DB. No API
 * mocking and no execution/approval button that could invoke a real model. */
export async function checkMemoryModuleT7Http({ client, owner, origin, records, mode }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  assert.match(owner, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  const regression = await checkMemoryModuleT6Http({ client, owner, origin, records, mode });
  const request = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + url, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
    return { status: response.status, value: await response.json(), cacheControl: response.headers.get('cache-control') };
  };
  assert.equal((await request('/api/identity')).value.actorId, owner);
  const files = await checkFileOperations({ client, owner, origin, request });
  const checks = [], marker = `T7_HTTP_PLAN_${randomUUID().replaceAll('-', '')}`;
  async function legacyPlan(userId, prefix) {
    const planId = `${prefix}_${randomUUID()}`, now = new Date(), plan = { id: planId, goal: `${marker} control proposal`,
      steps: [{ id: 'step-1', description: 'Review the synthetic proposal; no external action is authorized by the plan alone.', status: 'pending' }],
      notes: 'Historical source lineage was not recorded.', createdAt: now.toISOString() };
    await client`INSERT INTO native_agent_plans(owner_id,plan_id,plan_json,original_prompt,created_at,expires_at,updated_at)
      VALUES (${userId},${planId},${JSON.stringify(plan)}::jsonb,'OLD_PRIVATE_PROMPT_MUST_NOT_BE_REPLAYED',${now.toISOString()}::timestamptz,
        ${new Date(now.getTime() - 60000).toISOString()}::timestamptz,${now.toISOString()}::timestamptz)`;
    return planId;
  }
  async function observation(userId, content) {
    const id = randomUUID();
    await client`INSERT INTO brain_observations(id,user_id,source_type,source_id,observed_at,content,content_hash,trust_level,metadata)
      VALUES (${id},${userId},'t7_http_fixture',${randomUUID()},now(),${content},${'a'.repeat(64)},'raw','{}'::jsonb)`;
    return id;
  }
  const ownPlan = await legacyPlan(owner, 't7_http'), sourceId = await observation(owner, `${marker}_CURRENT_SOURCE`);
  const source = await request('/api/memory/sources/read', { source: 'brainObservations', id: sourceId });
  assert.equal(source.status, 200, JSON.stringify(source.value)); assert.ok(source.value.receiptId);
  const inspect = await request(`/api/memory/plans/${ownPlan}`);
  assert.equal(inspect.status, 200); assert.equal(inspect.value.kind, 'legacy_unverified'); assert.equal(inspect.value.historicalSources, 'unknown');
  assert.match(inspect.cacheControl, /no-store/); assert.ok(!JSON.stringify(inspect.value).includes('OLD_PRIVATE_PROMPT_MUST_NOT_BE_REPLAYED'));
  const body = { commandId: randomUUID(), expectedLegacyVersion: inspect.value.legacyVersion,
    inputPrompt: `${marker} Owner reviewed this control proposal using the explicitly selected current source.`,
    sourceReceiptIds: [source.value.receiptId], confirmed: true };
  const foreign = randomUUID(); await client`INSERT INTO "User"(id,email) VALUES (${foreign},${foreign + '@example.invalid'})`;
  const foreignPlan = await legacyPlan(foreign, 'foreign_t7'), foreignObservation = await observation(foreign, 'FOREIGN_SOURCE_MUST_NOT_LEAK');
  const denied = await request(`/api/memory/plans/${foreignPlan}`); assert.equal(denied.status, 404);
  assert.ok(!JSON.stringify(denied.value).includes(marker));
  const { readOwnerSource } = await import('../../lib/memory/sources/service.ts');
  const foreignSource = await readOwnerSource({ userId: foreign, source: 'brainObservations', id: foreignObservation });
  const foreignReceipt = await request(`/api/memory/plans/${ownPlan}/rebase`, { ...body, commandId: randomUUID(), sourceReceiptIds: [foreignSource.receiptId] });
  assert.equal(foreignReceipt.status, 503); assert.ok(!JSON.stringify(foreignReceipt.value).includes('FOREIGN_SOURCE_MUST_NOT_LEAK'));
  for (const malformed of [{ ...body, ownerId: foreign }, { ...body, confirmed: false }, { ...body, expectedLegacyVersion: 'made-up-version' },
    { ...body, sourceReceiptIds: ['invalid-id'] }]) {
    assert.equal((await request(`/api/memory/plans/${ownPlan}/rebase`, malformed)).status, 400);
  }
  const oversized = await request(`/api/memory/plans/${ownPlan}/rebase`, { ...body, extra: 'x'.repeat(1048576) }); assert.equal(oversized.status, 413);
  const planCount = async planId => Number((await client`SELECT count(*)::int AS n FROM memory_plan_records WHERE user_id=${owner} AND plan_id=${planId}`)[0].n);
  assert.equal(await planCount(ownPlan), 0);
  checks.push('Expired legacy proposal remains inspectable but unverified; foreign plan/receipt, spoofed identity, malformed and oversized requests are rejected without saved state');
  let faultName;
  const installFault = async action => {
    assert.ok(['legacy_rebase', 'revoke'].includes(action));
    faultName = 't7_plan_http_' + randomUUID().replaceAll('-', '');
    await client.unsafe(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.action='${action}' THEN RAISE EXCEPTION 'PRIVATE_T7_PLAN_COMMAND_FAULT'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${faultName} BEFORE INSERT ON memory_plan_commands FOR EACH ROW EXECUTE FUNCTION ${faultName}()`);
  };
  const removeFault = async () => {
    if (!faultName) return;
    await client.unsafe(`DROP TRIGGER IF EXISTS ${faultName} ON memory_plan_commands`); await client.unsafe(`DROP FUNCTION IF EXISTS ${faultName}()`); faultName = undefined;
  };
  const counters = async () => ({
    observations: Number((await client`SELECT count(*)::int AS n FROM brain_observations WHERE user_id=${owner}`)[0].n),
    logs: Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${owner}`)[0].n),
    commands: Number((await client`SELECT count(*)::int AS n FROM memory_plan_commands WHERE user_id=${owner}`)[0].n),
  });
  await installFault('legacy_rebase');
  try {
    const before = await counters(), failed = await request(`/api/memory/plans/${ownPlan}/rebase`, body);
    assert.equal(failed.status, 503); assert.ok(!JSON.stringify(failed.value).includes('PRIVATE_T7_PLAN_COMMAND_FAULT'));
    assert.equal(await planCount(ownPlan), 0); assert.deepEqual(await counters(), before);
  } finally { await removeFault(); }
  const restored = await request(`/api/memory/plans/${ownPlan}/rebase`, body); assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert.equal(restored.value.state, 'ready'); assert.equal(restored.value.origin, 'owner_rebased_legacy');
  assert.equal(restored.value.historicalSources, 'unknown_owner_rebased'); assert.match(restored.value.version, /^mplan1:/);
  const replay = await request(`/api/memory/plans/${ownPlan}/rebase`, body); assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true);
  assert.equal(await planCount(ownPlan), 1);
  const revoke = { commandId: randomUUID(), expectedVersion: restored.value.version };
  assert.equal((await request(`/api/memory/plans/${ownPlan}/revoke`, { ...revoke, expectedVersion: `mplan1:${'b'.repeat(64)}` })).status, 409);
  await installFault('revoke');
  try {
    const before = await counters(), failed = await request(`/api/memory/plans/${ownPlan}/revoke`, revoke);
    assert.equal(failed.status, 503); assert.deepEqual(await counters(), before); assert.equal(await planCount(ownPlan), 1);
    assert.equal((await request(`/api/memory/plans/${ownPlan}`)).value.state, 'ready');
  } finally { await removeFault(); }
  const revoked = await request(`/api/memory/plans/${ownPlan}/revoke`, revoke); assert.equal(revoked.status, 200); assert.equal(revoked.value.state, 'revoked');
  assert.equal((await request(`/api/memory/plans/${ownPlan}/revoke`, revoke)).value.replayed, true); assert.equal(await planCount(ownPlan), 2);
  checks.push('Real command-audit faults roll back input observations, source audits, plan revision and command; retry/replay is atomic, stale CAS conflicts and revoke is visible');

  const uiPlan = await legacyPlan(owner, 't7_desktop');
  const desktop = await checkPlansDesktop({ client, owner, origin, records, mode, planId: uiPlan, sourceReceiptId: source.value.receiptId,
    installFault, removeFault, planCount, marker });
  return { name: 'T7 actual file authorization, plan recovery APIs and desktop', passed: true, regression, files, desktop, checks };
}

async function checkFileOperations({ client, owner, origin, request }) {
  const taskId = randomUUID(), workId = randomUUID(), other = randomUUID(), foreignTask = randomUUID();
  const { getTaskSessionDir } = await import('../../lib/files/workspace/sessions.ts');
  await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${taskId},${owner},'T7 HTTP import',now(),'private')`;
  await client`INSERT INTO "User"(id,email) VALUES (${other},${other + '@example.invalid'})`;
  await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${foreignTask},${other},'Foreign HTTP import',now(),'private')`;
  const directory = getTaskSessionDir(taskId); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'selected.md'), '# OWNER_T7_HTTP_WORKSPACE_SNAPSHOT\n');
  const importInput = { commandId: randomUUID(), taskId, path: 'selected.md' };
  const imported = await request('/api/memory/files/import', importInput); assert.equal(imported.status, 200, JSON.stringify(imported.value));
  assert.equal(imported.value.origin.originalFileCurrent, false); assert.equal(imported.value.origin.semantics, 'owner_confirmed_imported_snapshot');
  assert.equal((await request('/api/memory/files/import', importInput)).value.replayed, true);
  assert.equal((await request('/api/memory/files/import', { ...importInput, commandId: randomUUID(), taskId: foreignTask })).status, 404);
  assert.equal((await request('/api/memory/files/import', { ...importInput, userId: other })).status, 400);
  const config = { role: 'document_markdown_cleaner', allowedTools: ['Read', 'workshopConvertDocument'] };
  await client`INSERT INTO workshops(id,user_id,name,mission,status,model_config) VALUES (${workId},${owner},'T7 HTTP bound uploads','Synthetic upload test','active',${JSON.stringify(config)}::jsonb)`;
  const upload = async (input) => {
    const form = new FormData(); form.set('file', new File(['# T7_HTTP_UPLOADED_SNAPSHOT\n'], 'uploaded.md', { type: 'text/markdown' }));
    form.set('commandId', input.commandId); form.set('expiresAt', input.expiresAt);
    const response = await fetch(`${origin}/api/workshops/${workId}/sources/upload`, { method: 'POST', headers: { Origin: origin }, body: form, signal: AbortSignal.timeout(180000) });
    return { status: response.status, value: await response.json() };
  };
  const uploadCommand = { commandId: randomUUID(), expiresAt: new Date(Date.now() + 300000).toISOString() };
  const uploaded = await upload(uploadCommand); assert.equal(uploaded.status, 201, JSON.stringify(uploaded.value));
  assert.equal(uploaded.value.binding.state, 'active'); assert.deepEqual(uploaded.value.binding.permissions, ['read', 'convert']);
  assert.match(uploaded.value.source.uri, /^artifact:/); assert.equal(uploaded.value.source.content, undefined);
  const replay = await upload(uploadCommand); assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true);
  assert.equal(replay.value.source.id, uploaded.value.source.id);
  assert.equal((await upload({ ...uploadCommand, expiresAt: new Date(Date.now() + 600000).toISOString() })).status, 409);
  assert.equal(Number((await client`SELECT count(*)::int n FROM workshop_sources WHERE workshop_id=${workId}`)[0].n), 1);
  await client`UPDATE workshop_sources SET content='REVOKED_CACHED_FILE_BODY_HTTP' WHERE id=${uploaded.value.source.id}`;
  const descriptor = await request('/api/memory/sources/read', { source: 'workshopSources', id: uploaded.value.source.id });
  assert.equal(descriptor.status, 200, JSON.stringify(descriptor.value)); assert.ok(!JSON.stringify(descriptor.value).includes('REVOKED_CACHED_FILE_BODY_HTTP'));
  assert.equal(JSON.parse(descriptor.value.content).content, null);
  const listing = await request(`/api/memory/files/bindings?workshopId=${workId}`); assert.equal(listing.status, 200); assert.equal(listing.value.bindings.length, 1);
  assert.equal((await request(`/api/memory/files/bindings?workshopId=${randomUUID()}`)).status, 404);
  assert.equal((await request(`/api/memory/files/bindings?workshopId=${workId}&userId=${other}`)).status, 400);
  const bindInput = { commandId: randomUUID(), workshopId: workId, sourceId: uploaded.value.source.id,
    artifactId: imported.value.artifactId, expectedArtifactRevision: imported.value.artifactRevision, expectedBindingRevision: 1,
    permissions: ['read'], expiresAt: uploadCommand.expiresAt };
  const bound = await request('/api/memory/files/bindings', bindInput); assert.equal(bound.status, 200, JSON.stringify(bound.value)); assert.equal(bound.value.binding.revision, 2);
  assert.equal((await request('/api/memory/files/bindings', bindInput)).value.replayed, true);
  assert.equal((await request('/api/memory/files/bindings', { ...bindInput, commandId: randomUUID() })).status, 409);
  const revokePath = `/api/memory/files/bindings/${bound.value.binding.id}/revoke`, revoke = { commandId: randomUUID(), expectedBindingRevision: 2 };
  assert.equal((await request(revokePath, { ...revoke, expectedBindingRevision: 1 })).status, 409);
  const revoked = await request(revokePath, revoke); assert.equal(revoked.status, 200); assert.equal(revoked.value.binding.state, 'revoked');
  assert.equal((await request(revokePath, revoke)).value.replayed, true);
  const fault = 't7_upload_http_' + randomUUID().replaceAll('-', ''), failedCommand = { ...uploadCommand, commandId: randomUUID() };
  const count = async () => Number((await client`SELECT count(*)::int n FROM workshop_sources WHERE workshop_id=${workId}`)[0].n);
  await client.unsafe(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid THEN RAISE EXCEPTION 'PRIVATE_T7_HTTP_UPLOAD_AUDIT'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${fault} BEFORE INSERT ON memory_file_binding_commands FOR EACH ROW EXECUTE FUNCTION ${fault}()`);
  try { const before = await count(), failed = await upload(failedCommand); assert.equal(failed.status, 503); assert.ok(!JSON.stringify(failed.value).includes('PRIVATE_T7')); assert.equal(await count(), before); }
  finally { await client.unsafe(`DROP TRIGGER ${fault} ON memory_file_binding_commands`); await client.unsafe(`DROP FUNCTION ${fault}()`); }
  assert.equal((await upload(failedCommand)).status, 201); assert.equal(await count(), 2);
  return { passed: true, apiResponsesMocked: false, workId, checks: ['Actual owner import with task ownership and immutable snapshot semantics',
    'Actual Work upload creates one private source plus TTL read/convert binding; full-input replay does not duplicate',
    'Owner list/bind/revoke APIs enforce foreign/strict input/CAS and command replay', 'Binding audit fault rolls source creation back; original upload command can retry'] };
}

async function checkPlansDesktop({ client, owner, origin, records, mode, planId, sourceReceiptId, installFault, removeFault, planCount, marker }) {
  const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'user-cookie:confirm', value: '0', url: origin }]);
  const page = await context.newPage(), pageErrors = [], screenshots = [], requests = [];
  page.setDefaultNavigationTimeout(180000); page.setDefaultTimeout(60000); page.on('pageerror', error => pageErrors.push(error.message));
  const panel = () => page.getByRole('region', { name: '计划审核与恢复', exact: true });
  const result = { mode, passed: false, apiResponsesMocked: false, externalModelInvoked: false, workExecuted: false, pageErrors, screenshots, requests };
  const pathname = `/api/memory/plans/${planId}`, waitPost = suffix => page.waitForResponse(response => new URL(response.url()).pathname === pathname + suffix && response.request().method() === 'POST');
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const loading = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.status() === 200);
    await page.goto(origin + `/memory/plans/${planId}`, { waitUntil: 'domcontentloaded' }); await loading;
    await expect(panel()).toBeVisible(); await expect(panel()).toContainText(marker);
    await panel().getByLabel('当前输入', { exact: true }).fill(`${marker} Desktop owner explicitly reviewed this proposal.`);
    await panel().getByLabel('当前来源回执 ID', { exact: true }).fill(sourceReceiptId);
    await panel().getByRole('checkbox', { name: '我已审核这份提案，理解历史来源仍未补证', exact: true }).check();
    const submit = () => panel().getByRole('button', { name: '确认恢复为待批准计划', exact: true });
    await installFault('legacy_rebase');
    let waiting = waitPost('/rebase'); await submit().focus(); await submit().press('Enter'); let response = await waiting;
    assert.equal(response.status(), 503); const failedCommand = response.request().postDataJSON(); requests.push({ action: 'rebase', status: response.status(), commandId: failedCommand.commandId });
    assert.equal(await planCount(planId), 0);
    const retry = panel().getByRole('button', { name: '重试原操作', exact: true }); await expect(retry).toBeEnabled(); await removeFault();
    waiting = waitPost('/rebase'); await retry.focus(); await retry.press('Enter'); response = await waiting;
    assert.equal(response.status(), 200); assert.equal(response.request().postDataJSON().commandId, failedCommand.commandId);
    requests.push({ action: 'rebase-retry', status: response.status(), commandId: failedCommand.commandId });
    await expect(panel().getByRole('button', { name: '撤销当前版本', exact: true })).toBeEnabled(); assert.equal(await planCount(planId), 1);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport); await panel().scrollIntoViewIfNeeded();
      const layout = await panel().evaluate(element => ({ viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
        panel: { width: element.clientWidth, scroll: element.scrollWidth }, controls: [...element.querySelectorAll('button,textarea')]
          .filter(node => node.clientWidth > 0).map(node => ({ tag: node.tagName, width: node.clientWidth, scroll: node.scrollWidth })) }));
      assert.ok(layout.pageWidth <= layout.viewport + 2, JSON.stringify(layout)); assert.ok(layout.panel.scroll <= layout.panel.width + 2, JSON.stringify(layout));
      result['layout' + viewport.width] = layout;
      const image = `t7-${mode}-plans-${viewport.width}.png`; await page.screenshot({ path: path.join(records, image), fullPage: true }); screenshots.push(image);
    }
    const revoke = panel().getByRole('button', { name: '撤销当前版本', exact: true });
    waiting = waitPost('/revoke'); await revoke.focus(); await revoke.press('Enter'); response = await waiting;
    assert.equal(response.status(), 200); requests.push({ action: 'revoke', status: response.status() });
    await expect(panel()).toContainText(/revoked|已撤销/); assert.equal(await planCount(planId), 2);
    const [latest] = await client`SELECT state FROM memory_plan_records WHERE user_id=${owner} AND plan_id=${planId} ORDER BY revision DESC LIMIT 1`;
    assert.equal(latest.state, 'revoked'); assert.deepEqual(pageErrors, []); result.passed = true; return result;
  } catch (error) {
    result.error = { name: error.name, message: error.message };
    await page.screenshot({ path: path.join(records, `t7-${mode}-plans-browser-failure.png`), fullPage: true }).catch(() => {}); throw error;
  } finally {
    await removeFault(); fs.writeFileSync(path.join(records, `t7-${mode}-plans-browser.json`), JSON.stringify(result, null, 2));
    await context.close(); await browser.close();
  }
}
