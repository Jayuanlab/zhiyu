import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60000 });

export async function checkMemoryModuleT6Browser({ client, origin, records, mode, row, marker, installFault, removeFault }) {
  const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'user-cookie:confirm', value: '0', url: origin }]);
  const page = await context.newPage(), pageErrors = [], screenshots = [];
  page.setDefaultNavigationTimeout(180000); page.setDefaultTimeout(60000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const panel = () => page.getByRole('region', { name: '来源覆盖与精确读取', exact: true });
  const waitRead = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/memory/sources/read' && response.request().method() === 'POST');
  const result = { mode, passed: false, apiResponsesMocked: false, externalModelInvoked: false, workExecuted: false, pageErrors, screenshots };
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const hydrated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/memory/updates/policy' && response.status() === 200, { timeout: 180000 });
    await page.goto(origin + '/memory', { waitUntil: 'domcontentloaded' }); await hydrated;
    await expect(panel().getByRole('button', { name: '刷新来源覆盖', exact: true })).toBeEnabled();
    await panel().getByLabel('精确来源类型', { exact: true }).selectOption('workshopEvents');
    await panel().getByLabel('来源记录 ID', { exact: true }).fill(row.id);
    await installFault();
    let waiting = waitRead(); await panel().getByRole('button', { name: '读取登记来源', exact: true }).click();
    assert.equal((await waiting).status(), 503); await expect(panel().getByRole('alert')).toContainText('没有把它标记为可用');
    await expect(panel().getByLabel('来源原文窗口', { exact: true })).toHaveCount(0); await removeFault();
    waiting = waitRead(); await panel().getByRole('button', { name: '重试来源窗口', exact: true }).click();
    const firstResponse = await waiting; assert.equal(firstResponse.status(), 200); const first = await firstResponse.json();
    await expect(panel().getByLabel('来源原文窗口', { exact: true })).toContainText(marker);
    waiting = waitRead(); const nextButton = panel().getByRole('button', { name: '读取下一来源窗口', exact: true });
    await expect(nextButton).toBeEnabled(); await nextButton.focus(); await nextButton.press('Enter'); const secondResponse = await waiting; assert.equal(secondResponse.status(), 200);
    assert.deepEqual(secondResponse.request().postDataJSON(), { source: 'workshopEvents', id: row.id, offset: first.nextOffset, expectedHash: first.contentHash, expectedRevision: first.revision });
    await expect(panel().getByLabel('来源原文窗口', { exact: true })).toContainText('_END');
    await panel().getByRole('button', { name: '解释来源读取回执', exact: true }).click();
    await expect(panel().getByLabel('来源回执说明', { exact: true })).toContainText('not_revalidated');
    await expect(panel().getByLabel('来源回执说明', { exact: true })).not.toContainText(marker);
    // Restart a real first window, then change the stored body before continuation.
    waiting = waitRead(); await panel().getByRole('button', { name: '读取登记来源', exact: true }).click(); assert.equal((await waiting).status(), 200);
    await expect(panel().getByRole('button', { name: '读取下一来源窗口', exact: true })).toBeEnabled();
    await client`UPDATE workshop_events SET body=${'T6_CORRECTED_DESKTOP ' + '新观测😀'.repeat(2400)} WHERE id=${row.id}`;
    waiting = waitRead(); await panel().getByRole('button', { name: '读取下一来源窗口', exact: true }).click(); assert.equal((await waiting).status(), 409);
    await expect(panel().getByRole('alert')).toContainText('旧窗口已清除'); await expect(panel().getByLabel('来源原文窗口', { exact: true })).toHaveCount(0);
    waiting = waitRead(); await panel().getByRole('button', { name: '读取登记来源', exact: true }).click(); assert.equal((await waiting).status(), 200);
    await expect(panel().getByLabel('来源原文窗口', { exact: true })).toContainText('T6_CORRECTED_DESKTOP');
    await panel().getByText('查看登记入口与工作权限', { exact: true }).click();
    await expect(panel()).toContainText('知识库目录'); await expect(panel()).toContainText('未隔离本地命令');
    await expect(page.getByRole('region', { name: '文件与连续性', exact: true })).toBeVisible();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport); await panel().scrollIntoViewIfNeeded();
      const layout = await panel().evaluate(element => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth,
        rows: [element, ...element.querySelectorAll('article,pre')].filter(node => node.clientWidth > 0).map(node => ({ tag: node.tagName, width: node.clientWidth, scroll: node.scrollWidth })) }));
      assert.ok(layout.pageWidth <= layout.width + 2); for (const row of layout.rows) assert.ok(row.scroll <= row.width + 2, JSON.stringify(row));
      result['layout' + viewport.width] = layout;
      const name = `t6-${mode}-desktop-${viewport.width}.png`; await page.screenshot({ path: path.join(records, name) }); screenshots.push(name);
    }
    assert.deepEqual(pageErrors, []); result.passed = true; return result;
  } catch (error) {
    result.error = { name: error.name, message: error.message };
    await page.screenshot({ path: path.join(records, `t6-${mode}-browser-failure.png`), fullPage: true }).catch(() => {}); throw error;
  } finally {
    await removeFault(); fs.writeFileSync(path.join(records, `t6-${mode}-browser.json`), JSON.stringify(result, null, 2)); await context.close(); await browser.close();
  }
}
