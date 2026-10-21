import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60_000 });

/** Desktop routes against the owned synthetic HTTP fixture; no API mocks. */
export async function checkMemoryModuleT4Browser({ client, owner, origin, records, mode, fixture, request }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'user-cookie:confirm', value: '0', url: origin }]);
  const page = await context.newPage(), pageErrors = [], submitted = [];
  page.setDefaultNavigationTimeout(180_000); page.setDefaultTimeout(60_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', req => {
    if (new URL(req.url()).origin === origin && req.method() === 'POST' && new URL(req.url()).pathname.startsWith('/api/memory/'))
      submitted.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() });
  });
  const report = { mode, routes: ['/memory', `/workshop?workId=${fixture.workId}&tab=memory`], passed: false,
    apiResponsesMocked: false, workExecuted: false, externalModelInvoked: false, submitted, pageErrors, screenshots: [] };
  const preview = () => page.getByRole('region', { name: '\u6309\u4efb\u52a1\u53ec\u56de', exact: true });
  const query = () => page.getByLabel('\u4efb\u52a1\u6216\u68c0\u7d22\u5185\u5bb9', { exact: true });
  const apiResponse = (url, purpose) => page.waitForResponse(response => new URL(response.url()).pathname === url
    && response.request().method() === 'POST' && (!purpose || response.request().postDataJSON()?.purpose === purpose));
  async function screenshot(name, locator = page) {
    await locator.screenshot({ path: path.join(records, name), ...(locator === page ? { fullPage: true } : {}) }); report.screenshots.push(name);
  }
  async function recallFromDesktop() {
    const waiting = apiResponse('/api/memory/read', 'recall'), button = preview().getByRole('button', { name: '\u6309\u4efb\u52a1\u53ec\u56de', exact: true });
    await expect(button).toBeEnabled(); await button.focus(); await button.press('Enter');
    const response = await waiting; assert.equal(response.status(), 200); const result = await response.json();
    assert.ok(['ok', 'empty'].includes(result.status)); assert.equal(result.pack.interfaceVersion, 'memory-context.v1');
    assert.deepEqual(response.request().postDataJSON(), { purpose: 'recall', taskIntent: fixture.marker, maxTokens: 8192 });
    await expect(preview().getByRole('status')).toContainText('\u5df2\u53d6\u5f97\u672c\u6b21\u4efb\u52a1'); return result;
  }
  let trigger;
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    // The SSR form is visible before React attaches its event handlers. Wait
    // for a real mounted child effect, then prove the controlled query updated
    // task-preview state before pressing the form submit button.
    const hydrated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/brain/memory-updates/policy'
      && response.request().method() === 'GET' && response.status() === 200, { timeout: 180_000 });
    await page.goto(origin + '/memory', { waitUntil: 'domcontentloaded' });
    await hydrated;
    await expect(page.getByRole('heading', { name: '\u8bb0\u5fc6', exact: true })).toBeVisible();
    await query().fill(fixture.marker);
    await expect(preview().getByRole('button', { name: '\u6309\u4efb\u52a1\u53ec\u56de', exact: true })).toBeEnabled();
    const discoveryWaiting = apiResponse('/api/memory/search');
    const discover = page.getByRole('button', { name: '\u53d1\u73b0\u8bb0\u5fc6', exact: true });
    await discover.focus(); await discover.press('Enter');
    const discovery = await discoveryWaiting; assert.equal(discovery.status(), 200);
    const discovered = await discovery.json(); assert.equal(discovered.purpose, 'discover'); assert.equal(discovered.contextTrace, undefined);
    assert.equal(discovered.receipt.purpose, 'discover');
    assert.deepEqual(discovery.request().postDataJSON().sources, ['memory']);
    assert.equal(submitted.filter(item => item.path === '/api/memory/read' && item.body.purpose === 'recall').length, 0,
      'Discovery must not implicitly load a task context');
    await expect(preview().getByRole('status')).toHaveCount(0);
    const admitted = await recallFromDesktop(); report.contextLogId = admitted.pack.contextLogId;
    for (const label of ['\u7ea6\u675f', '\u5f53\u524d\u4e3b\u8bb0\u5f55\u4e0e\u573a\u666f\u4f30\u8ba1', '\u539f\u59cb\u8bc1\u636e', '\u7406\u89e3\u4e0e\u7ecf\u9a8c', '\u4fe1\u606f\u7f3a\u53e3'])
      await expect(preview().getByRole('region', { name: label, exact: true })).toBeVisible();
    await expect(preview()).toContainText('OWNER_T4_HTTP_CORRECTED');
    for (const name of ['candidate', 'expired', 'foreign', 'global']) await expect(preview()).not.toContainText(fixture.bodies[name]);
    const historical = preview().getByRole('region', { name: '\u539f\u59cb\u8bc1\u636e', exact: true });
    const evidenceWaiting = apiResponse('/api/memory/read', 'evidence');
    await historical.getByRole('button', { name: '\u5c55\u5f00\u56fa\u5b9a\u539f\u6587', exact: true }).first().click();
    const evidence = await evidenceWaiting, evidenceBody = evidence.request().postDataJSON(), evidenceResult = await evidence.json();
    assert.equal(evidence.status(), 200); assert.equal(evidenceResult.status, 'ok'); assert.deepEqual(evidenceBody.ref, fixture.raw.ref);
    assert.deepEqual(evidenceResult.receipt.actualRange, { start: 0, end: Array.from(fixture.raw.observation.content).length, unit: 'unicode_code_points' });
    await expect(historical.getByLabel('\u56fa\u5b9a\u539f\u6587\u6b63\u6587').first()).toContainText('A\u{1f600}\u4e2dB');
    await expect(historical.getByLabel('\u56fa\u5b9a\u539f\u6587\u6b63\u6587').first()).toContainText('\u5df2\u8bfb\u8303\u56f4');
    await historical.locator('summary').filter({ hasText: '\u7248\u672c\u4e0e\u8bfb\u53d6\u56de\u6267' }).first().click();
    await expect(historical).toContainText(fixture.raw.ref.revision);
    await page.setViewportSize({ width: 1024, height: 768 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), '1024 desktop page must not overflow horizontally');
    await preview().evaluate(element => element.scrollIntoView({ block: 'start', inline: 'nearest' }));
    const layout1024 = await preview().evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { viewportWidth: window.innerWidth, preview: { x: rect.x, right: rect.right, width: rect.width },
        elements: [element, ...element.querySelectorAll('article, pre, [aria-label="\u56fa\u5b9a\u539f\u6587\u6b63\u6587"]')]
          .filter(item => item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0)
          .map(item => ({ tag: item.tagName, label: item.getAttribute('aria-label'), scrollWidth: item.scrollWidth, clientWidth: item.clientWidth })) };
    });
    report.layout1024 = layout1024;
    assert.ok(layout1024.preview.x >= 0 && layout1024.preview.right <= layout1024.viewportWidth + 2, '1024 preview must lie inside the actual viewport');
    for (const item of layout1024.elements) assert.ok(item.scrollWidth <= item.clientWidth + 2,
      `1024 ${item.tag} ${item.label ?? ''} must fit its actual content width: ${item.scrollWidth}/${item.clientWidth}`);
    await page.screenshot({ path: path.join(records, 't4-memory-viewport-1024.png'), fullPage: false }); report.screenshots.push('t4-memory-viewport-1024.png');
    await screenshot('t4-memory-context-1024.png', preview());
    const feedbackWaiting = apiResponse('/api/memory/recall-feedback');
    const used = preview().getByRole('button', { name: '\u53cd\u9988\u6709\u7528', exact: true });
    await expect(used).toBeEnabled(); await used.focus(); await used.press('Enter');
    const feedback = await feedbackWaiting, feedbackBody = feedback.request().postDataJSON(); assert.equal(feedback.status(), 201);
    assert.equal(feedbackBody.contextLogId, admitted.pack.contextLogId); assert.equal(feedbackBody.outcome, 'used'); assert.equal(feedbackBody.query, fixture.marker);
    await expect(page.getByRole('status', { name: '\u53ec\u56de\u53cd\u9988\u72b6\u6001' })).toContainText('\u5df2\u8bb0\u5f55');
    const savedFeedback = (await client`SELECT system_info FROM feedback WHERE id=${feedbackBody.feedbackId} AND user_id=${owner}`)[0];
    assert.ok(savedFeedback); assert.equal(savedFeedback.system_info.contextLogId, admitted.pack.contextLogId);
    assert.equal(savedFeedback.system_info.associationStatus, 'verified_context');
    trigger = `reject_t4_desktop_${randomUUID().replaceAll('-', '')}`;
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.system_info->>'outcome'='missing' THEN RAISE EXCEPTION 'injected T4 desktop feedback failure'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON feedback FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    const failingFeedbackWaiting = apiResponse('/api/memory/recall-feedback');
    await preview().getByRole('button', { name: '\u53cd\u9988\u7f3a\u5931', exact: true }).click();
    const failedFeedback = await failingFeedbackWaiting, pendingBody = failedFeedback.request().postDataJSON(); assert.equal(failedFeedback.status(), 503);
    await expect(page.getByRole('button', { name: '\u91cd\u8bd5\u539f\u53cd\u9988', exact: true })).toBeEnabled();
    await screenshot('t4-memory-feedback-recovery.png');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const retry = page.getByRole('button', { name: '\u91cd\u8bd5\u539f\u53cd\u9988', exact: true }); await expect(retry).toBeEnabled();
    await client.unsafe(`DROP TRIGGER ${trigger} ON feedback`); await client.unsafe(`DROP FUNCTION ${trigger}()`); trigger = undefined;
    const retryWaiting = apiResponse('/api/memory/recall-feedback'); await retry.focus(); await retry.press('Enter');
    const retried = await retryWaiting; assert.equal(retried.status(), 201); assert.deepEqual(retried.request().postDataJSON(), pendingBody);
    assert.equal(Number((await client`SELECT count(*)::int AS n FROM feedback WHERE id=${pendingBody.feedbackId} AND user_id=${owner}`)[0].n), 1);
    await expect(page.getByRole('button', { name: '\u91cd\u8bd5\u539f\u53cd\u9988', exact: true })).toHaveCount(0);
    await query().fill(fixture.marker); const reloaded = await recallFromDesktop();
    assert.ok(JSON.stringify(reloaded.pack).includes('OWNER_T4_HTTP_CORRECTED')); assert.ok(!JSON.stringify(reloaded.pack).includes(fixture.bodies.global));
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), '1440 desktop page must not overflow horizontally');
    await screenshot('t4-memory-context-1440.png');
    const qualityPath = `/api/workshops/${fixture.workId}/memory-recall-quality`;
    assert.equal((await request(qualityPath)).status, 200);
    const reviewCount = async () => Number((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE workshop_id=${fixture.workId}`)[0].n);
    const reviewsBefore = await reviewCount();
    await page.goto(origin + report.routes[1], { waitUntil: 'domcontentloaded' });
    await expect(page.locator(`[data-workshop-id="${fixture.workId}"]`)).toHaveAttribute('aria-pressed', 'true');
    const quality = page.getByRole('region', { name: '\u8bb0\u5fc6\u8d28\u91cf\u4fe1\u606f', exact: true });
    await expect(quality).toBeVisible(); await expect(quality).toContainText('\u8bfb\u53d6\u6b64\u62a5\u544a\u4e0d\u4f1a\u540c\u6b65\u5ba1\u6838\u9879');
    assert.equal(await reviewCount(), reviewsBefore, 'Opening the desktop quality report is readonly');
    const maintenanceWaiting = apiResponse(qualityPath), sync = quality.getByRole('button', { name: '\u540c\u6b65\u8bb0\u5fc6\u8d28\u91cf\u5ba1\u6838\u9879', exact: true });
    await sync.focus(); await sync.press('Enter'); const maintenance = await maintenanceWaiting;
    assert.equal(maintenance.status(), 200); assert.deepEqual(maintenance.request().postDataJSON(), { action: 'sync_review_items' });
    await expect(quality.getByRole('status')).toContainText('\u5ba1\u6838\u9879\u5df2\u540c\u6b65');
    await screenshot('t4-workshop-quality-1440.png');
    assert.deepEqual(pageErrors, []); report.passed = true; report.keyboardActions = true; report.desktopResize = true;
    report.horizontalOverflow = false; report.feedbackRecoverySameCommandAfterReload = true; report.qualityGetReadOnly = true;
    return report;
  } catch (error) {
    report.failure = String(error?.message ?? error); await screenshot('t4-desktop-failure.png').catch(() => {}); throw error;
  } finally {
    if (trigger) { await client.unsafe(`DROP TRIGGER ${trigger} ON feedback`).catch(() => {}); await client.unsafe(`DROP FUNCTION ${trigger}()`).catch(() => {}); }
    fs.writeFileSync(path.join(records, 't4-desktop.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'); await browser.close();
  }
}
