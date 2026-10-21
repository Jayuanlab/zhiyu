import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60000 });

/** Real owner desktop; faults live in the synthetic DB, never browser API mocks. */
export async function checkMemoryModuleT5Browser({ client, owner, origin, records, mode, workId, request }) {
  const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'user-cookie:confirm', value: '0', url: origin }]);
  const page = await context.newPage(), pageErrors = [], uploads = [], screenshots = [];
  page.setDefaultNavigationTimeout(180000); page.setDefaultTimeout(60000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const panel = () => page.getByRole('region', { name: '文件与连续性', exact: true });
  const result = { mode, passed: false, apiResponsesMocked: false, externalModelInvoked: false, workExecuted: false, pageErrors, screenshots, uploads };
  const waitPost = pathname => page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST');
  async function open() {
    const hydrated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/brain/memory-updates/policy' && response.status() === 200, { timeout: 180000 });
    await page.goto(origin + '/memory', { waitUntil: 'domcontentloaded' }); await hydrated;
    await expect(panel().getByRole('button', { name: '上传私有文件', exact: true })).toBeEnabled();
  }
  let trigger;
  async function fault(action) {
    trigger = 't5_browser_' + randomUUID().replaceAll('-', '');
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.action='${action}' THEN RAISE EXCEPTION 'synthetic_browser_receipt_fault'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON memory_artifact_command_receipts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  }
  async function clearFault() {
    if (!trigger) return; await client.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON memory_artifact_command_receipts`); await client.unsafe(`DROP FUNCTION IF EXISTS ${trigger}()`); trigger = undefined;
  }
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await open();
    const name = 'T5-桌面恢复-中文.txt', bytes = Buffer.from('T5_DESKTOP_FIXED 中文 A😀中B\nactual immutable bytes\n');
    await fault('artifact.activate');
    let waiting = waitPost('/api/files/upload');
    await panel().getByLabel('选择私有文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: bytes });
    let response = await waiting; assert.equal(response.status(), 503); uploads.push({ status: response.status() });
    await expect(panel().getByRole('button', { name: '重试原上传', exact: true })).toBeEnabled();
    await expect(panel().getByRole('article', { name, exact: true })).toContainText('已封存，待激活');
    const [before] = await client`SELECT id,command_id FROM memory_artifact_manifests WHERE user_id=${owner} AND name=${name}`;
    assert.ok(before);
    const changedIntent = new FormData(); changedIntent.append('file', new Blob([bytes], { type: 'text/plain' }), name);
    // The manifest begin command is rooted at the multipart command ID. The
    // wrapper intent must still reject a changed business intent while sealed.
    changedIntent.append('commandId', before.command_id); changedIntent.append('createRecord', 'false');
    const changed = await fetch(origin + '/api/files/upload', { method: 'POST', headers: { Origin: origin }, body: changedIntent });
    assert.equal(changed.status, 409); await clearFault();
    waiting = waitPost('/api/files/upload');
    await panel().getByRole('button', { name: '重试原上传', exact: true }).click();
    response = await waiting; assert.equal(response.status(), 200); uploads.push({ status: response.status() });
    const saved = await response.json(); assert.equal(saved.artifact.id, before.id);
    assert.equal(Number((await client`SELECT count(*)::int AS n FROM memory_artifact_manifests WHERE user_id=${owner} AND name=${name}`)[0].n), 1);
    const article = () => panel().getByRole('article', { name, exact: true });
    await expect(article()).toContainText('可读取');
    const readWaiting = waitPost('/api/memory/read');
    const readButton = article().getByRole('button', { name: '读取固定窗口', exact: true }); await readButton.focus(); await readButton.press('Enter');
    const read = await readWaiting; assert.equal(read.status(), 200);
    await expect(article().getByLabel('文件固定窗口', { exact: true })).toContainText('T5_DESKTOP_FIXED 中文 A😀中B');
    await article().locator('summary').click(); await expect(article()).toContainText(saved.ref.revision);
    const downloading = page.waitForEvent('download'); await article().getByRole('link', { name: '下载文件', exact: true }).click();
    const download = await downloading; assert.equal(download.suggestedFilename(), name);
    const downloadPath = await download.path(); assert.deepEqual(fs.readFileSync(downloadPath), bytes);
    await panel().getByLabel('选择连续任务', { exact: true }).selectOption(workId);
    for (const label of ['状态已保存', '已准备模型请求', '已观察到模型用量']) await expect(panel()).toContainText(label);
    await expect(panel()).not.toContainText('MUST_NOT_EXPOSE_PRIVATE_STATE');
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport); await article().scrollIntoViewIfNeeded();
      const layout = await panel().evaluate(element => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth,
        rows: [element, ...element.querySelectorAll('article,pre')].filter(node => node.clientWidth > 0)
          .map(node => ({ tag: node.tagName, width: node.clientWidth, scroll: node.scrollWidth })) }));
      assert.ok(layout.pageWidth <= layout.width + 2); for (const row of layout.rows) assert.ok(row.scroll <= row.width + 2, JSON.stringify(row));
      result['layout' + viewport.width] = layout;
      const image = `t5-${mode}-desktop-${viewport.width}.png`; await page.screenshot({ path: path.join(records, image) }); screenshots.push(image);
    }
    await fault('artifact.cleanup'); page.once('dialog', dialog => dialog.accept());
    waiting = waitPost('/api/memory/commands'); await article().getByRole('button', { name: '清理文件', exact: true }).click();
    response = await waiting; assert.equal(response.status(), 503);
    await expect(article()).toContainText('清理未完成'); await clearFault();
    // A full reload discards local command maps: the durable recovery intent
    // must supply the same command ID and revision after a process interruption.
    const current = await request('/api/memory/read', { purpose: 'current', ref: { kind: 'artifact', id: before.id } });
    assert.ok(current.value.record.cleanupRecovery?.commandId);
    await open(); await expect(article().getByRole('button', { name: '重试原清理', exact: true })).toBeEnabled();
    page.once('dialog', dialog => dialog.accept()); waiting = waitPost('/api/memory/commands');
    await article().getByRole('button', { name: '重试原清理', exact: true }).click();
    response = await waiting; assert.equal(response.status(), 200);
    assert.equal(response.request().postDataJSON().commandId, current.value.record.cleanupRecovery.commandId);
    await expect(article()).toHaveCount(0); assert.equal((await client`SELECT state FROM memory_artifact_manifests WHERE id=${before.id}`)[0].state, 'deleted');
    // Real keyset navigation, including unfinished attachments beyond page 1.
    const { beginArtifact } = await import('../../lib/memory/artifacts/service.ts');
    const ids = [];
    for (let i = 0; i < 22; i++) ids.push((await beginArtifact(owner, { kind: 'artifact.begin', commandId: randomUUID(), name: `T5-page-${String(i).padStart(2, '0')}.txt`,
      contentType: 'text/plain', sizeBytes: 1, sha256: 'a'.repeat(64) })).manifest.id);
    await panel().getByRole('button', { name: '刷新文件清单', exact: true }).click();
    const next = panel().getByRole('button', { name: '下一页文件', exact: true }); await expect(next).toBeEnabled(); await next.click();
    await expect(panel().getByRole('button', { name: '上一页文件', exact: true })).toBeEnabled();
    await expect(panel().getByRole('article', { name: 'T5-page-00.txt', exact: true })).toBeVisible();
    await panel().getByRole('button', { name: '上一页文件', exact: true }).click();
    await expect(panel().getByRole('article', { name: 'T5-page-21.txt', exact: true })).toBeVisible();
    assert.deepEqual(pageErrors, []); result.passed = true; result.paginationFixtures = ids.length;
    return result;
  } catch (error) {
    result.error = { name: error.name, message: error.message };
    await page.screenshot({ path: path.join(records, `t5-${mode}-browser-failure.png`), fullPage: true }).catch(() => {}); throw error;
  } finally {
    await clearFault(); fs.writeFileSync(path.join(records, `t5-${mode}-browser.json`), JSON.stringify(result, null, 2)); await context.close(); await browser.close();
  }
}
