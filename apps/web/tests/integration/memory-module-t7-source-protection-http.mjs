import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { CHAT_SUGGESTIONS_SOURCE_WARNING } from '../../lib/ai/chat-suggestions-policy.ts';
import { LEGACY_INSIGHT_SOURCE_WARNING } from '../../lib/insights/source-protection.ts';

const expect = baseExpect.configure({ timeout: 60000 });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Root calls this only inside the owned isolated T7 HTTP fixture. All records
 * are synthetic; no jobs, agents, insight refreshes or real providers are run. */
export async function checkMemoryModuleT7SourceProtectionHttp({ client, owner, origin, records, mode, getProviderRequestCount, cronSecret }) {
  assert.match(owner, uuid);
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  assert.match(String((await client`SELECT current_database() AS name`)[0].name), /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(typeof getProviderRequestCount, 'function');
  assert.match(cronSecret, /^synthetic-t7-cron-/);
  const providerBefore = getProviderRequestCount(), marker = 'T7_PRIVATE_LEGACY_SOURCE_' + randomUUID().replaceAll('-', '');
  const foreign = randomUUID(), ownerBot = randomUUID(), foreignBot = randomUUID(), ownedInsight = randomUUID(), foreignInsight = randomUUID();
  const result = { name: 'T7 actual legacy-source HTTP withholding and desktop fixed suggestions', mode, passed: false,
    apiResponsesMocked: false, realProviderCalled: false, requests: [], checks: [], desktop: { screenshots: [], pageErrors: [], modelAttemptsBlocked: 0 } };
  let browser, context;
  const request = async (pathname, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const response = await fetch(origin + pathname, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
    const value = await response.json();
    result.requests.push({ pathname, method, status: response.status, code: value.code ?? null, detail: value.detail ?? null });
    assert.ok(!JSON.stringify(value).includes(marker), 'Private saved insight leaked into a response');
    return { status: response.status, value, cacheControl: response.headers.get('cache-control') };
  };
  const snapshot = async () => ({
    rows: await client`SELECT id,md5(row_to_json(i)::text) AS row_hash FROM "Insight" i WHERE id IN (${ownedInsight},${foreignInsight}) ORDER BY id`,
    insightCount: Number((await client`SELECT count(*)::int AS n FROM "Insight"`)[0].n),
  });
  try {
    assert.equal((await request('/api/identity')).value.actorId, owner);
    await client`INSERT INTO "User"(id,email) VALUES (${foreign},${foreign + '@example.invalid'})`;
    for (const [id, userId] of [[ownerBot, owner], [foreignBot, foreign]]) {
      await client`INSERT INTO "Bot"(id,"userId",name,description,adapter,adapter_config,enable)
        VALUES (${id},${userId},'T7 source protection fixture','Synthetic disabled owner relation','gmail','{}'::json,false)`;
    }
    for (const [id, botId] of [[ownedInsight, ownerBot], [foreignInsight, foreignBot]]) {
      const details = [{ platform: 'gmail', content: marker + '_DETAIL', attachments: [{ name: 'synthetic.txt', downloadUrl: 'https://invalid.example/' + marker }] }];
      await client`INSERT INTO "Insight"(id,"botId","taskLabel",title,description,importance,urgency,platform,time,details)
        VALUES (${id},${botId},'gmail',${marker + '_TITLE'},${marker + '_BODY'},'medium','normal','gmail',now(),${JSON.stringify(details)}::jsonb)`;
    }
    const before = await snapshot(); assert.equal(before.rows.length, 2);
    const suggestions = await request('/api/chat/suggestions');
    assert.equal(suggestions.status, 200); assert.match(suggestions.cacheControl, /no-store/);
    assert.equal(suggestions.value.provider, 'fixed'); assert.equal(suggestions.value.detail, 'personalized_sources_withheld');
    assert.equal(suggestions.value.warning, CHAT_SUGGESTIONS_SOURCE_WARNING);
    assert.deepEqual(suggestions.value.sourceProtection, { status: 'withheld', reason: 'source_unregistered', personalized: false,
      storedSourcesRead: false, historicalDerivationsUsed: false, modelInvoked: false });
    assert.equal(suggestions.value.suggested_prompts.length, 3);
    assert.ok(suggestions.value.suggested_prompts.every(item => item.title && item.related_insight_ids.length === 0));
    result.checks.push('Authenticated fixed suggestions explicitly withhold stored personal sources and use no model');

    const owned = await request(`/api/insights/${ownedInsight}/understand`, {});
    assert.equal(owned.status, 422); assert.equal(owned.value.code, 'memory_source_required');
    assert.equal(owned.value.detail, 'legacy_insight_source_unregistered'); assert.equal(owned.value.error, LEGACY_INSIGHT_SOURCE_WARNING);
    assert.equal(owned.value.sourceProtection.domainStateUpdated, false);
    for (const id of [foreignInsight, randomUUID()]) assert.equal((await request(`/api/insights/${id}/understand`, {})).status, 404);
    result.checks.push('Real Bot owner relation: owned insight is 422 source-required; foreign and missing insight remain 404 without body disclosure');
    for (const method of ['GET', 'POST']) {
      const body = method === 'POST' ? {} : undefined;
      assert.equal((await request('/api/insights/maintenance/weekly', body, method)).status, 401);
      const blocked = await request('/api/insights/maintenance/weekly', body, method, { Authorization: `Bearer ${cronSecret}` });
      assert.equal(blocked.status, 422); assert.equal(blocked.value.code, 'memory_source_required'); assert.equal(blocked.value.provider, 'none');
    }
    result.checks.push('Actual weekly cron authentication precedes source-required 422 for GET and POST; no successful maintenance result');
    assert.deepEqual(await snapshot(), before);
    assert.equal(getProviderRequestCount(), providerBefore, 'A fixed/withheld endpoint sent a real synthetic provider request');

    // An empty owned chat exposes the actual Greeting. Do not click a suggestion
    // or accept any automatic model/agent request during this read-only check.
    const chatId = randomUUID();
    await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${chatId},${owner},'T7 fixed suggestion protection',now(),'private')`;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'user-cookie:confirm', value: '0', url: origin }]);
    await context.addInitScript(id => localStorage.setItem('activeChatId', id), chatId);
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (request.method() === 'POST' && (/^\/api\/(?:native\/agent|ai\/|chat\/save-messages)/.test(url.pathname))) {
        result.desktop.modelAttemptsBlocked++; return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultNavigationTimeout(180000); page.setDefaultTimeout(60000);
    page.on('pageerror', error => result.desktop.pageErrors.push(error.message));
    await page.goto(`${origin}/?page=chat&chatId=${chatId}`, { waitUntil: 'domcontentloaded' });
    const cards = page.getByTestId('suggested-actions'), warning = page.getByRole('status').filter({ hasText: CHAT_SUGGESTIONS_SOURCE_WARNING });
    await expect(cards).toBeVisible(); await expect(cards.getByRole('button')).toHaveCount(4); await expect(warning).toBeVisible();
    await expect(warning).toHaveText(CHAT_SUGGESTIONS_SOURCE_WARNING);
    await expect(cards.getByRole('button').first()).toBeEnabled();
    await cards.getByRole('button').first().focus(); await expect(cards.getByRole('button').first()).toBeFocused();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport); await warning.scrollIntoViewIfNeeded();
      const layout = await warning.evaluate(element => ({ viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
        x: element.getBoundingClientRect().x, right: element.getBoundingClientRect().right,
        width: element.clientWidth, scrollWidth: element.scrollWidth }));
      assert.ok(layout.pageWidth <= layout.viewport + 2 && layout.x >= -1 && layout.right <= layout.viewport + 1 && layout.scrollWidth <= layout.width + 2,
        JSON.stringify(layout)); result.desktop['layout' + viewport.width] = layout;
      const filename = `t7-${mode}-fixed-suggestions-${viewport.width}.png`;
      await page.screenshot({ path: path.join(records, filename), fullPage: false }); result.desktop.screenshots.push(filename);
    }
    assert.equal(result.desktop.modelAttemptsBlocked, 0, 'The desktop automatically attempted model execution');
    assert.deepEqual(result.desktop.pageErrors, []); assert.deepEqual(await snapshot(), before);
    assert.equal(getProviderRequestCount(), providerBefore, 'Reading the desktop sent a provider request');
    result.providerRequestsAdded = getProviderRequestCount() - providerBefore; result.insightRowsUnchanged = true;
    result.desktop.passed = true; result.checks.push('Actual desktop fixed-card protection message remains visible at 1440/1024 and suggestion is keyboard focusable without submitting');
    result.passed = true; return result;
  } catch (error) {
    result.failure = { name: error?.name ?? 'Error', message: error instanceof assert.AssertionError ? error.message.split('\n')[0] : error?.message ?? String(error) };
    throw error;
  } finally {
    fs.writeFileSync(path.join(records, `t7-${mode}-source-protection-http.json`), JSON.stringify(result, null, 2));
    await context?.close(); await browser?.close();
  }
}
