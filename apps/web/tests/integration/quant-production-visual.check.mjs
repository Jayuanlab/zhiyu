import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const origin = process.env.QUANT_VISUAL_ORIGIN || 'http://127.0.0.1:3515';
const output = path.resolve(process.cwd(), '.tmp/quant-migration-visual-20260925');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures = [];

async function layoutSnapshot(page) {
  return page.evaluate(() => {
    const main = [...document.querySelectorAll('main')].at(-1);
    const briefHeading = [...document.querySelectorAll('h2')].find((item) => item.textContent?.trim() === '今日控制摘要');
    const brief = briefHeading?.closest('section');
    const mainBox = main?.getBoundingClientRect();
    const briefBox = brief?.getBoundingClientRect();
    return {
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      mainRight: mainBox?.right,
      briefRight: briefBox?.right,
      briefFullyVisible: Boolean(mainBox && briefBox && briefBox.left >= mainBox.left && briefBox.right <= mainBox.right),
      mainScrollHeight: main?.scrollHeight,
      mainClientHeight: main?.clientHeight,
    };
  });
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => failures.push(error.message));
  const response = await page.goto(`${origin}/quant`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  assert.equal(response?.status(), 200);
  await page.waitForFunction(() => document.body.innerText.includes('模拟盘'), { timeout: 20_000 });
  await page.waitForTimeout(2500);

  const desktopContent = await page.evaluate(() => ({
    title: document.title,
    bodyText: document.body.innerText.slice(0, 1800),
    headings: [...document.querySelectorAll('h1,h2,h3')].map((item) => item.textContent?.trim()).filter(Boolean).slice(0, 18),
  }));
  const desktop = { ...desktopContent, ...await layoutSnapshot(page) };
  await page.screenshot({ path: path.join(output, 'quant-1440.png'), fullPage: true });
  await page.locator('main').last().evaluate((main) => { main.scrollTop = main.scrollHeight; });
  await page.screenshot({ path: path.join(output, 'quant-1440-bottom.png') });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator('main').last().evaluate((main) => { main.scrollTop = 0; });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(output, 'quant-1024.png'), fullPage: true });
  const compact = await layoutSnapshot(page);
  await page.getByRole('heading', { name: '今日控制摘要' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'quant-1024-control-brief.png') });
  await page.locator('main').last().evaluate((main) => { main.scrollTop = main.scrollHeight; });
  await page.screenshot({ path: path.join(output, 'quant-1024-bottom.png') });

  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    label: document.activeElement?.getAttribute('aria-label'),
    visible: document.activeElement instanceof HTMLElement && document.activeElement.getBoundingClientRect().width > 0,
  }));
  assert.equal(failures.length, 0, failures.join('; '));
  assert.ok(desktop.bodyText.includes('模拟盘'));
  assert.ok(desktop.scrollWidth <= desktop.width + 1, '1440px document overflows horizontally');
  assert.ok(compact.scrollWidth <= compact.width + 1, '1024px document overflows horizontally');
  assert.ok(desktop.briefFullyVisible, '1440px control brief is clipped');
  assert.ok(compact.briefFullyVisible, '1024px control brief is clipped');
  assert.ok(compact.mainScrollHeight > compact.mainClientHeight, '1024px main content cannot scroll');
  assert.ok(focus.tag && focus.tag !== 'BODY' && focus.visible, 'keyboard focus is not visible');

  const result = { origin, responseStatus: response.status(), desktop, compact, focus, pageErrors: failures,
    screenshots: ['quant-1440.png', 'quant-1440-bottom.png', 'quant-1024.png', 'quant-1024-control-brief.png', 'quant-1024-bottom.png'] };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.responseStatus, headings: desktop.headings,
    bodyExcerpt: desktop.bodyText.slice(0, 350), desktopWidth: desktop.scrollWidth,
    compactWidth: compact.scrollWidth, focus, pageErrors: failures, output }));
} finally {
  await browser.close();
}
