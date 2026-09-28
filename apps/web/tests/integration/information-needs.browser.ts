import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from '@playwright/test';
import { BrainRecallRetryDetails } from '@/components/brain-recall-retry-details';
import { unavailableInformationReadiness } from '@/lib/brain/information-needs';

const browser = await chromium.launch({ headless: true });
const folder = path.resolve('../../.runtime/evals/information-needs');
await mkdir(folder, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const trace = { originalQuery: '平台工具调用失败后如何恢复任务', stopReason: 'source_unavailable', attempts: 1,
    informationReadiness: unavailableInformationReadiness('平台工具调用失败后如何恢复任务', 'retry') };
  const markup = renderToStaticMarkup(React.createElement(BrainRecallRetryDetails, { trace }));
  await page.setContent(`<html lang="zh"><meta charset="utf-8"><style>body{font:16px/1.6 system-ui;margin:32px}main{max-width:900px}span,p,li{overflow-wrap:anywhere}summary:focus-visible{outline:2px solid blue}</style><main><h1>所需信息清单 · 隔离组件验收</h1>${markup}</main></html>`);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('summary').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('details').getAttribute('open'), '');
  assert.equal(await page.locator('li').count(), 6);
  assert.ok(await page.getByText('工具回执：数据源不可用', { exact: false }).isVisible());
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.locator('details').evaluate(el => { el.style.fontSize = '28px'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(folder, 'desktop.png'), fullPage: true });
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('details').getAttribute('open'), null);
  assert.deepEqual(errors, []);
  const report = { passed: true, componentFixture: true, productionPage: false, sixCategories: true,
    keyboardDisclosure: true, desktopWidths: [1280, 1024], doubleFontNoOverflow: true, pageErrors: errors };
  await writeFile(path.join(folder, 'browser.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
