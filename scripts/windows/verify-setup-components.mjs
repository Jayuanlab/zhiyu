import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../../packaging/windows/runtime/manager.mjs';

// This checks only the manager's local settings page. Every optional executable
// is an invalid dummy file, and all component/DB command paths are tripwires.
const workspace = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const id = `setup-components-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const physicalRoot = join(homedir(), 'ZhiyuSetupChecks', id);
const outputLink = join(workspace, 'output', 'windows-installer-check', id);
const installRoot = join(physicalRoot, 'fixture', 'install');
const dataDir = join(physicalRoot, 'fixture', 'data');
await mkdir(installRoot, { recursive: true });
await mkdir(join(workspace, 'output', 'windows-installer-check'), { recursive: true });
await symlink(physicalRoot, outputLink, 'junction');
assert.equal(await realpath(outputLink), await realpath(physicalRoot));
const dummyFiles = ['vendor/python/python.exe', 'components/quant/scripts/install_bootstrap.py', 'components/wechat/server.py', 'components/wechat/bootstrap-reader.ps1', 'vendor/wechat-reader/wx.exe'];
for (const file of dummyFiles) {
  const path = join(installRoot, file);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, 'ZH IYU TEST DUMMY: deliberately not executable; no services permitted.\n', 'utf8');
}
await writeFile(join(installRoot, 'component-manifest.json'), JSON.stringify({ schemaVersion: 1, quant: true, wechat: true, python: true }), 'utf8');
const report = { schemaVersion: 1, kind: 'settings-page-only-dummy-install', startedAt: new Date().toISOString(), outputDirectory: outputLink,
  physicalDirectory: physicalRoot, viewports: [1440, 1100], sourceHashes: {}, checks: [], screenshots: [], requests: [], forbiddenRequests: [], browserErrors: [], componentCommandAttempts: [], limitations: ['No model, database, application, quant, reader, sender, or real WeChat service is started.', 'Window screenshots and DOM checks cover desktop browser layouts only.'] };
for (const file of ['setup.html', 'setup.js', 'components.mjs', 'manager.mjs']) {
  report.sourceHashes[file] = createHash('sha256').update(await readFile(join(workspace, 'packaging', 'windows', 'runtime', file))).digest('hex');
}
const manager = new RuntimeManager({ installRoot, dataDir, open: false });
manager.command = async (_exe, _args, options) => { report.componentCommandAttempts.push(options?.label || 'command'); throw new Error('settings_verification_component_command_forbidden'); };
manager.spawnManaged = () => { report.componentCommandAttempts.push('spawnManaged'); throw new Error('settings_verification_component_spawn_forbidden'); };
manager.components.readerAction = async action => { report.componentCommandAttempts.push(`reader:${action}`); throw new Error('settings_verification_reader_operation_forbidden'); };
manager.components.startWechat = async () => { report.componentCommandAttempts.push('startWechat'); throw new Error('settings_verification_sender_start_forbidden'); };
let browser, failure;
const check = (name, detail = {}) => report.checks.push({ name, passed: true, ...detail });
const waitUntil = async predicate => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 75)); }
  throw new Error('settings_verification_condition_timeout');
};
try {
  assert.equal(await manager.run(), true);
  assert.equal(manager.state.status, 'setup_required');
  assert.equal(manager.config.model, null);
  assert.equal(manager.config.desiredStatus, 'stopped');
  const require = createRequire(join(workspace, 'apps', 'web', 'package.json'));
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const origin = new URL(manager.state.setupUrl).origin;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname, method = request.method();
    const allowed = url.origin === origin && (method === 'GET' && ['/', '/setup', '/setup.js', '/api/status', '/api/config', '/api/session'].includes(path)
      || method === 'POST' && ['/api/session', '/api/components'].includes(path));
    report.requests.push({ method, path, allowed });
    if (!allowed) { report.forbiddenRequests.push({ method, path }); await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(`${manager.state.setupUrl}#token=${manager.token}`);
  await page.getByText('首次使用：', { exact: false }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.locator('#api-key').inputValue(), '');
  assert.equal(await page.locator('#start').isDisabled(), true);
  assert.equal(await page.locator('#quant-enabled').isDisabled(), false);
  assert.equal(await page.locator('#wechat-enabled').isDisabled(), false);
  assert.equal(await page.locator('#wechat-read-consent').isDisabled(), true);
  assert.equal(await page.locator('#wechat-send-enabled').isDisabled(), true);
  assert.equal(await page.locator('#wechat-init').isDisabled(), true);
  assert.equal(await page.locator('#wechat-init-elevated').isHidden(), true);
  check('fresh_configuration_available_without_model_or_service', { phase: manager.state.status, installed: ['quant', 'wechat'], startDisabled: true });
  const screenshot = async name => {
    const file = join(physicalRoot, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    report.screenshots.push({ name, path: join(outputLink, `${name}.png`) });
  };
  const layout = async width => {
    await page.setViewportSize({ width, height: 1000 });
    const value = await page.evaluate(() => {
      const bounds = [...document.querySelectorAll('main,section,input,button,select,label.choice')].map(element => {
        const rect = element.getBoundingClientRect(); return { tag: element.tagName, id: element.id, left: rect.left, right: rect.right, width: rect.width };
      });
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
        overflow: bounds.filter(rect => rect.left < -1 || rect.right > innerWidth + 1), text: document.body.innerText,
        choices: [...document.querySelectorAll('label.choice')].map(label => ({ text: label.innerText, control: label.querySelector('input')?.id })) };
    });
    assert.ok(value.documentWidth <= width + 1 && value.bodyWidth <= width + 1, 'horizontal overflow');
    assert.deepEqual(value.overflow, []);
    assert.equal(value.choices.length, 4);
    assert.ok(value.choices.every(choice => choice.text && choice.control));
    assert.ok(value.text.includes('授权接入本人微信消息'));
    assert.ok(value.text.includes('首次启用会创建独立的空模拟账户'));
    assert.ok(!value.text.includes('\ufffd') && !value.text.includes('???'));
    await writeFile(join(physicalRoot, `layout-${width}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    check(`desktop_layout_${width}`, { viewport: width, documentWidth: value.documentWidth, horizontalOverflow: false, labeledCheckboxes: value.choices.length });
  };
  await layout(1440); await screenshot('fresh-1440');
  await layout(1100); await screenshot('fresh-1100');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#quant-enabled').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#quant-enabled').isChecked(), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'wechat-enabled');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#wechat-enabled').isChecked(), true);
  assert.equal(await page.locator('#wechat-read-consent').isDisabled(), false);
  assert.equal(await page.locator('#wechat-send-enabled').isDisabled(), false);
  assert.equal(await page.locator('#wechat-init').isDisabled(), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'wechat-read-consent');
  const focus = await page.locator('#wechat-read-consent').evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }));
  assert.notEqual(focus.style, 'none'); assert.notEqual(focus.width, '0px');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#wechat-read-consent').isChecked(), true);
  assert.equal(await page.locator('#wechat-init').isDisabled(), false);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'wechat-send-enabled');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#wechat-send-enabled').isChecked(), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'components-save');
  await screenshot('authorized-unsaved-1440');
  await page.keyboard.press('Enter');
  await waitUntil(() => manager.config.components.quant.enabled && manager.config.components.wechat.readConsent && manager.config.components.wechat.sendEnabled);
  await waitUntil(() => page.locator('#components-save').isEnabled());
  assert.equal(manager.config.components.wechat.readerAuthorized, false);
  check('keyboard_component_selection_and_save', { focusVisible: focus, tabOrder: ['quant-enabled', 'wechat-enabled', 'wechat-read-consent', 'wechat-send-enabled', 'components-save'], readerInitialized: false });
  await page.locator('#wechat-enabled').uncheck();
  assert.equal(await page.locator('#wechat-read-consent').isChecked(), false);
  assert.equal(await page.locator('#wechat-send-enabled').isChecked(), false);
  assert.equal(await page.locator('#wechat-read-consent').isDisabled(), true);
  assert.equal(await page.locator('#wechat-send-enabled').isDisabled(), true);
  assert.equal(await page.locator('#wechat-init').isDisabled(), true);
  check('parent_switch_clears_and_disables_consent_and_sending');
  await page.locator('#wechat-enabled').check();
  await page.locator('#wechat-send-enabled').check();
  assert.equal(await page.locator('#wechat-read-consent').isChecked(), false);
  assert.equal(await page.locator('#wechat-init').isDisabled(), true);
  await page.locator('#components-save').click();
  await waitUntil(() => manager.config.components.wechat.sendEnabled && !manager.config.components.wechat.readConsent);
  await waitUntil(() => page.locator('#components-save').isEnabled());
  assert.equal(manager.environment().WECHAT_LOCAL_AUTHORIZED, 'false');
  check('sending_option_does_not_grant_read_or_initialize_authorization');
  const disableOptions = async () => {
    await page.locator('#wechat-enabled').uncheck(); await page.locator('#quant-enabled').uncheck();
    await page.locator('#components-save').click();
    await waitUntil(() => !manager.config.components.wechat.enabled && !manager.config.components.quant.enabled);
    await waitUntil(() => page.locator('#components-save').isEnabled());
  };
  await disableOptions();
  await manager.stopApplication();
  assert.equal(manager.state.status, 'stopped');
  await waitUntil(async () => (await page.locator('#overall').innerText()) === '已停止');
  await page.locator('#quant-enabled').check(); await page.locator('#wechat-enabled').check();
  await page.locator('#components-save').click();
  await waitUntil(() => manager.config.components.quant.enabled && manager.config.components.wechat.enabled);
  await waitUntil(() => page.locator('#components-save').isEnabled());
  assert.equal(manager.state.status, 'stopped');
  assert.equal(manager.config.model, null);
  await page.setViewportSize({ width: 1100, height: 1000 }); await screenshot('stopped-saved-1100');
  check('stopped_state_can_save_components_without_model_or_app_start');
  await page.locator('#modules summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#modules').evaluate(element => element.open), true);
  check('keyboard_engine_details_toggle');
  await disableOptions();
  assert.equal(manager.children.size, 0); assert.equal(manager.activeCommands.size, 0);
  assert.equal(existsSync(join(dataDir, 'postgres', 'PG_VERSION')), false);
  assert.equal(existsSync(join(dataDir, 'quant')), false); assert.equal(existsSync(join(dataDir, 'wechat')), false);
  assert.deepEqual(report.componentCommandAttempts, []); assert.deepEqual(report.forbiddenRequests, []); assert.deepEqual(report.browserErrors, []);
  const config = JSON.parse(await readFile(manager.paths.config, 'utf8'));
  assert.equal(config.model, null); assert.equal(config.components.wechat.readerAuthorized, false);
  check('no_real_service_or_component_action', { managedChildren: 0, componentCommands: 0, forbiddenRequests: 0, postgresInitialized: false, componentDataCreated: false });
  report.ok = true;
} catch (error) {
  failure = error; report.ok = false; report.failure = { message: error.message, stack: error.stack };
} finally {
  await browser?.close();
  // UI operations never initialize a reader. Disable saved dummy selections
  // before manager shutdown so that shutdown does not execute dummy stop paths.
  if (manager.config?.components) {
    manager.config.components.quant.enabled = false;
    manager.config.components.wechat.enabled = false;
    manager.config.components.wechat.readConsent = false;
    manager.config.components.wechat.sendEnabled = false;
  }
  try { await manager.shutdown(); } catch (error) { report.shutdownError = error.message; report.ok = false; }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(physicalRoot, 'setup-components-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ event: 'setup_components_acceptance', ok: report.ok, checks: report.checks.length, report: join(outputLink, 'setup-components-acceptance.json'), screenshots: report.screenshots }));
if (failure || !report.ok) process.exitCode = 1;
