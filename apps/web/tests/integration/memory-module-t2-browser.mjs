import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60_000 });

/** Actual desktop entry, no API response replacement and no Work execution. */
export async function checkMemoryModuleT2Browser({ client, owner, origin, records, mode, create, createBody }) {
  const workshopId = randomUUID(), title = `T2 desktop task ${randomUUID().slice(0, 8)}`;
  await client`INSERT INTO workshops(id,user_id,name,mission,status)
    VALUES (${workshopId},${owner},'Synthetic T2 desktop Work','Fixture only; no execution','active')`;
  const task = await create(createBody(title)); assert.equal(task.revision, 0);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'user-cookie:confirm', value: '0', url: origin }]);
  const page = await context.newPage(), pageErrors = [], submitted = [];
  page.setDefaultNavigationTimeout(180_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const report = { mode, route: `/workshop?workId=${workshopId}&tab=sources`, taskId: task.id,
    passed: false, apiResponsesMocked: false, workExecuted: false, submitted, pageErrors };
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + report.route, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(`[data-workshop-id="${workshopId}"]`)).toHaveAttribute('aria-pressed', 'true');
    const card = page.locator('div.rounded-lg.border.p-3').filter({ has: page.getByText(title, { exact: true }) }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText('\u5019', { exact: true })).toBeVisible();
    await card.screenshot({ path: path.join(records, 't2-task-before.png') });
    await page.setViewportSize({ width: 1180, height: 900 });
    await expect(card).toBeVisible();
    const sizing = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(sizing.document <= sizing.viewport, 'The desktop window has no page-level horizontal overflow after resize');
    report.desktopResize = { from: 1440, to: 1180, ...sizing };
    const responsePromise = page.waitForResponse(response => {
      const request = response.request();
      return new URL(response.url()).pathname === '/api/interactions/wiki' && request.method() === 'PATCH'
        && request.postDataJSON()?.id === task.id;
    });
    await card.getByRole('button', { name: '\u786e\u8ba4', exact: true }).focus();
    await page.keyboard.press('Enter');
    report.activation = 'native_button_keyboard_enter';
    const response = await responsePromise, command = response.request().postDataJSON();
    submitted.push(command);
    assert.equal(command.kind, 'task'); assert.equal(command.status, 'confirmed');
    assert.equal(command.expectedVersion, 0); assert.equal(typeof command.commandId, 'string'); assert.ok(command.commandId.length > 0);
    assert.equal(response.status(), 200);
    const result = await response.json(); assert.equal(result.task.revision, 1); assert.equal(result.task.status, 'confirmed');
    await expect(card.getByText('\u5df2\u786e', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: '\u786e\u8ba4', exact: true })).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(card.getByText('\u5df2\u786e', { exact: true })).toBeVisible();
    await card.screenshot({ path: path.join(records, 't2-task-confirmed.png') });
    await page.screenshot({ path: path.join(records, 't2-desktop-confirmed.png'), fullPage: true });
    report.passed = true; report.visibleState = '\u5df2\u786e'; report.persistedAfterReload = true;
    report.screenshots = ['t2-task-before.png', 't2-task-confirmed.png', 't2-desktop-confirmed.png'];
    assert.deepEqual(pageErrors, []);
    return report;
  } catch (error) {
    report.passed = false; report.failure = String(error?.message ?? error);
    await page.screenshot({ path: path.join(records, 't2-desktop-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(records, 't2-desktop.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    await browser.close();
  }
}
