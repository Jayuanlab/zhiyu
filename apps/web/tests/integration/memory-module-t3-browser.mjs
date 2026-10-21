import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60_000 });

/** A synthetic Work-scoped fixture makes the existing proposal UI reachable. */
export async function checkMemoryModuleT3Browser({ client, owner, origin, records, mode, request, submit, read, evidenceRef }) {
  const workId = randomUUID(), memoryId = randomUUID(), subject = `T3 desktop proposal ${randomUUID().slice(0, 8)}`;
  await client`INSERT INTO workshops(id,user_id,name,mission,status)
    VALUES (${workId},${owner},'Synthetic T3 desktop Work','Fixture only; no Work execution','active')`;
  await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,evidence_refs,metadata)
    VALUES (${memoryId},${owner},'work',${workId},'work',${workId},'insight',${subject},'Synthetic prior Work assertion','active',80,
      ${JSON.stringify([evidenceRef])}::jsonb,${JSON.stringify({ canonicalGroupId: `t3-browser:${memoryId}` })}::jsonb)`;
  const before = await read({ kind: 'memory', id: memoryId });
  const proposal = await submit({ kind: 'memory.propose', commandId: randomUUID(), targetMemoryId: memoryId, expectedVersion: before.ref.revision,
    content: 'Synthetic desktop proposal after reviewing original evidence', reason: 'Synthetic changed understanding', evidenceRefs: [evidenceRef] });
  const candidate = proposal.outcome.records.find(record => record.role === 'candidate'); assert.ok(candidate);
  const base = proposal.outcome.records.find(record => record.role === 'base'); assert.ok(base);
  // Compile the real readonly compatibility routes before the desktop's bounded
  // fetch deadline; all browser reads still reach the actual server afterwards.
  const details = await request(`/api/brain/memory-updates/${candidate.id}`); assert.equal(details.status, 200);
  const evidence = await request(`/api/brain/memory-updates/evidence?proposalId=${candidate.id}`); assert.equal(evidence.status, 200);
  assert.ok(evidence.value.sources.some(item => item.id === evidenceRef && item.status === 'resolved'));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'user-cookie:confirm', value: '0', url: origin }]);
  const page = await context.newPage(), pageErrors = [], submitted = [];
  page.setDefaultNavigationTimeout(180_000); page.setDefaultTimeout(60_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const report = { mode, route: `/workshop?workId=${workId}&tab=memory`, proposalId: candidate.id,
    passed: false, apiResponsesMocked: false, workExecuted: false, compatibilityDecisionRoute: true, submitted, pageErrors };
  const dialog = () => page.getByRole('dialog', { name: '\u8bb0\u5fc6\u66f4\u65b0\u63d0\u6848\u5ba1\u6838' });
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + report.route, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(`[data-workshop-id="${workId}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '\u5237\u65b0\u8bb0\u5fc6', exact: true })).toBeEnabled();
    const list = page.getByRole('region', { name: '\u8bb0\u5fc6\u66f4\u65b0\u63d0\u6848\u5217\u8868' });
    await expect(list).toBeVisible();
    const expand = list.getByRole('button', { name: '\u67e5\u770b\u8bb0\u5fc6\u66f4\u65b0\u63d0\u6848', exact: true });
    if (await expand.count()) await expand.click();
    await list.locator(`[data-proposal-id="${candidate.id}"]`).getByRole('button', { name: '\u5ba1\u6838\u66f4\u65b0\u63d0\u6848', exact: true }).click();
    const reason = dialog().getByLabel('\u5ba1\u6838\u7406\u7531');
    await expect(reason).toBeEnabled();
    await expect(dialog()).toContainText('Synthetic prior Work assertion');
    await expect(dialog()).toContainText('Synthetic desktop proposal after reviewing original evidence');
    await dialog().locator('summary').filter({ hasText: '\u67e5\u770b\u539f\u59cb\u8bc1\u636e' }).click();
    await expect(dialog()).toContainText('Synthetic T3 original HTTP evidence');
    await page.setViewportSize({ width: 1024, height: 768 });
    const reasonText = 'Synthetic desktop owner inspected original evidence and accepts this proposal';
    await reason.fill(reasonText);
    await dialog().getByLabel('\u6211\u5df2\u6838\u5bf9\u539f\u59cb\u6765\u6e90\uff0c\u786e\u8ba4\u53ef\u4ee5\u91c7\u7528\u63d0\u6848', { exact: true }).check();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), '1024 desktop page must not overflow horizontally');
    await dialog().screenshot({ path: path.join(records, 't3-proposal-review-1024.png') });
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/brain/memory-updates/${candidate.id}/decision`
      && response.request().method() === 'POST');
    const accept = dialog().getByRole('button', { name: '\u63a5\u53d7\u63d0\u6848', exact: true });
    await expect(accept).toBeEnabled(); await accept.focus(); await accept.press('Enter');
    const response = await responsePromise, command = response.request().postDataJSON(); submitted.push(command);
    assert.equal(response.status(), 200); assert.equal(command.action, 'accept'); assert.equal(command.reason, reasonText);
    assert.equal(command.evidenceConfirmed, true); assert.equal(command.expectedVersion, candidate.revision); assert.equal(command.expectedBaseVersion, base.revision);
    assert.equal(typeof command.commandId, 'string'); assert.ok(command.commandId.length > 0);
    await expect(dialog().getByRole('status').filter({ hasText: '\u63d0\u6848\u5df2\u63a5\u53d7' })).toBeVisible();
    await dialog().screenshot({ path: path.join(records, 't3-proposal-accepted.png') });
    await dialog().getByRole('button', { name: '\u5b8c\u6210\u5e76\u5237\u65b0\u63d0\u6848\u5217\u8868', exact: true }).click();
    await expect(dialog()).toHaveCount(0);
    const after = await read({ kind: 'memory', id: memoryId }); assert.equal(after.record.id, candidate.id); assert.equal(after.record.status, 'active');
    const replay = await request(`/api/brain/memory-updates/${candidate.id}/decision`, command); assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true);
    assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE user_id=${owner} AND metadata->>'commandId'=${command.commandId}`)[0].n), 1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(`[data-memory-id="${candidate.id}"]`)).toBeVisible();
    const reloaded = await read({ kind: 'memory', id: memoryId });
    assert.equal(reloaded.record.id, candidate.id); assert.equal(reloaded.ref.revision, after.ref.revision);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), '1440 desktop page must not overflow horizontally');
    await page.screenshot({ path: path.join(records, 't3-desktop-accepted.png'), fullPage: true });
    assert.deepEqual(pageErrors, []); report.passed = true; report.keyboardDecision = true; report.desktopResize = true;
    report.persistedAfterReload = true; report.currentRef = reloaded.ref; report.horizontalOverflow = false;
    report.screenshots = ['t3-proposal-review-1024.png', 't3-proposal-accepted.png', 't3-desktop-accepted.png'];
    return report;
  } catch (error) {
    report.passed = false; report.failure = String(error?.message ?? error);
    await page.screenshot({ path: path.join(records, 't3-desktop-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(records, 't3-desktop.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    await browser.close();
  }
}
