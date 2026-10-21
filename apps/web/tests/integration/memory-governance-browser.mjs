import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

/** Synthetic isolated owner only; the runner supplies an empty test database. */
export async function checkMemoryGovernanceBrowser({ client, owner, origin, records, browserEnabled }) {
  const id = randomUUID(), evidence = randomUUID(), suffix = randomUUID().slice(0, 8);
  const subject = `治理验收项目承诺 ${suffix}`, content = '合成项目承诺，履约状态须查正式任务记录。';
  await client`INSERT INTO brain_observations(id,user_id,source_type,source_id,observed_at,content,content_hash)
    VALUES (${evidence},${owner},'memory_governance_fixture',${id},now(),${content},${createHash('sha256').update(content).digest('hex')})`;
  const metadata = { canonicalKind: 'commitment', canonicalGroupId: `governance:${id}`,
    facets: { scenarioKeys: ['project:governance-alpha'], scenarioApplicability: 'scoped' } };
  await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content,status,confidence,evidence_refs,metadata)
    VALUES (${id},${owner},'global','chat',${owner},'task',${subject},${content},'verified',90,
      ${JSON.stringify([`brain-observation:${evidence}`])}::jsonb,${JSON.stringify(metadata)}::jsonb)`;
  const response = await fetch(origin + '/api/memory/search', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: subject, sources: ['memory'], threshold: 0, limit: 20 }) });
  assert.equal(response.status, 200);
  const result = await response.json(), item = result.results.find(item => item.id === id);
  assert.ok(item, 'Owner discovery must still find project-scoped memories');
  assert.equal(item.metadata.scenarioApplicability.status, 'scoped');
  assert.equal(item.metadata.useSemantics.kind, 'commitment');
  assert.equal(item.metadata.useSemantics.establishesCurrentBusinessState, false);
  assert.equal(result.contextTrace.applicabilityMode, 'discovery');
  if (!browserEnabled) return { name: 'memory governance isolated HTTP metadata', passed: true, browser: 'not_requested' };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + '/memory');
    const search = page.getByRole('textbox', { name: '召回需求' });
    await search.fill(subject);
    const submit = page.getByRole('button', { name: '开始召回', exact: true });
    await submit.focus();
    await submit.press('Enter');
    const card = page.locator('article').filter({ hasText: content }).first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText('指定场景适用');
    await expect(card).toContainText('project:governance-alpha');
    await expect(card).toContainText('履约需查任务');
    await expect(card).toContainText('不证明当前业务状态');
    await card.screenshot({ path: join(records, 'memory-governance-card.png') });
    await page.screenshot({ path: join(records, 'memory-governance-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(card).toBeVisible();
    const sourceChoices = await page.locator('form button[type="button"]').all();
    assert.equal(sourceChoices.length, 5, 'All memory source choices must be available');
    for (const source of sourceChoices) {
      const bounds = await source.boundingBox();
      assert.ok(bounds && bounds.width >= 90, 'Desktop source choices must remain wide enough to read');
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'Desktop layout should not overflow horizontally');
    await page.locator('form').screenshot({ path: join(records, 'memory-governance-sources-resized.png') });
    await page.screenshot({ path: join(records, 'memory-governance-desktop-resized.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
    return { name: 'memory governance isolated desktop and HTTP', passed: true, ownerDiscovery: true,
      applicabilityDisplayed: true, commitmentNotFulfillment: true, keyboardSearch: true, desktopResize: true,
      screenshots: ['memory-governance-card.png', 'memory-governance-desktop.png', 'memory-governance-sources-resized.png', 'memory-governance-desktop-resized.png'] };
  } catch (error) {
    await page.screenshot({ path: join(records, 'memory-governance-browser-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}
