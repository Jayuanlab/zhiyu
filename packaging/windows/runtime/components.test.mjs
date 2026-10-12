import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from './manager.mjs';
import { componentDefaults, validateComponentSelection } from './components.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zhiyu-components-test-'));
  const installRoot = join(root, 'install'); mkdirSync(installRoot);
  const files = ['vendor/python/python.exe', 'components/quant/scripts/install_bootstrap.py', 'components/wechat/server.py', 'components/wechat/bootstrap-reader.ps1', 'vendor/wechat-reader/wx.exe'];
  for (const file of files) { const path = join(installRoot, file); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'fixture-only'); }
  writeFileSync(join(installRoot, 'component-manifest.json'), JSON.stringify({ schemaVersion: 1, quant: true, wechat: true, python: true }));
  const manager = new RuntimeManager({ installRoot, dataDir: join(root, 'data') }); manager.loadConfig();
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'zhiyu-components-test-'))); rmSync(root, { recursive: true, force: true }); });
  return manager;
}
const disabled = { quantEnabled: false, wechatEnabled: false, wechatReadConsent: false, wechatSendEnabled: false };

test('component settings cannot smuggle credentials or authorize reading by enabling sender', async t => {
  const m = fixture(t);
  assert.throws(() => validateComponentSelection({ ...disabled, readerToken: 'injected' }), /invalid_component_selection/);
  assert.throws(() => validateComponentSelection({ ...disabled, wechatReadConsent: true }), /wechat_component_required/);
  await m.components.saveSelection({ ...disabled, wechatEnabled: true, wechatSendEnabled: true });
  assert.equal(m.environment().WECHAT_LOCAL_AUTHORIZED, 'false');
  let invoked = false; m.components.readerAction = async () => { invoked = true; };
  await assert.rejects(m.components.initializeWechat({}), /wechat_read_consent_required/);
  assert.equal(invoked, false);
  const publicState = JSON.stringify(m.components.publicConfiguration());
  for (const secret of [m.config.components.wechat.readerToken, m.config.components.wechat.senderToken, m.config.components.quant.databasePassword]) assert.equal(publicState.includes(secret), false);
  m.children.set('web', { done: false });
  await assert.rejects(m.components.saveSelection(disabled), /stop_application_before_configuring/);
});

test('quant bootstrap receives admin credentials only during initialization and binds health to its account', async t => {
  const m = fixture(t); await m.components.saveSelection({ ...disabled, quantEnabled: true });
  const calls = []; m.components.pythonReceipt = async (_script, action, env) => {
    calls.push({ action, env });
    return { ok: true, component: 'quant', initialized: true, accountId: m.config.components.quant.accountId, legacyImported: false, ownerBound: true };
  };
  await m.components.initializeQuant();
  const env = m.environment(); assert.equal(env.QUANT_TRANSPORT, 'embedded');
  assert.equal(new URL(env.QUANT_PAPER_DATABASE_URL).username, 'zhiyu_quant');
  assert.equal(env.QUANT_INSTALL_ADMIN_DATABASE_URL, undefined);
  assert.equal(calls.find(call => call.action === '--initialize').env.QUANT_INSTALL_ADMIN_DATABASE_URL, env.DATABASE_URL);
  assert.equal(calls.find(call => call.action === '--initialize').env.ZHIYU_RUNTIME_OWNER_ID, m.config.ownerId);
  assert.equal(calls.find(call => call.action === '--health').env.QUANT_INSTALL_ADMIN_DATABASE_URL, undefined);
  assert.equal(calls.find(call => call.action === '--check').env.QUANT_INSTALL_ADMIN_DATABASE_URL, undefined);
  for (const call of calls) for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'ZHIYU_BOOTSTRAP_DB_URL', 'LLM_API_KEY', 'AUTH_SECRET', 'ENCRYPTION_KEY']) assert.equal(call.env[key], undefined);
  for (const name of ['sender', 'reader']) for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'LLM_API_KEY', 'QUANT_PAPER_DATABASE_URL']) assert.equal(m.components.privateEnvironment(name)[key], undefined);
  m.components.pythonReceipt = async () => ({ ok: true, component: 'quant', ownerBound: true, accountId: 'unrelated' });
  await m.components.probe(); assert.equal(m.state.components.quant.phase, 'degraded');
});

test('component receipt requires expected event and an actual successful command exit', async t => {
  const m = fixture(t);
  m.command = async (_binary, _args, options) => options.inspect(JSON.stringify({ event: 'unrelated_event', ok: true }));
  await assert.rejects(m.components.pythonReceipt('fixture', '--health'), /not_confirmed/);
  m.command = async (_binary, _args, options) => { options.inspect(JSON.stringify({ event: 'quant_install_health', ok: true })); throw new Error('fixture_exit_1'); };
  await assert.rejects(m.components.pythonReceipt('fixture', '--health'), /fixture_exit_1/);
});

test('sender window health does not assert login and cannot impersonate another child', async t => {
  const m = fixture(t); await m.components.saveSelection({ ...disabled, wechatEnabled: true, wechatReadConsent: true });
  m.children.set('wechat', { done: false, child: { pid: 123456 } });
  const health = { pid: 123456, service: 'zhiyu-wechat-desktop', requiresAuth: true, wechatWindowFound: true, desktopStatus: 'available', loginStatus: 'unverified', compatibility: 'unverified' };
  await m.components.probeWechat(health); assert.equal(m.state.components.wechat.phase, 'initialization_required'); assert.equal(m.state.components.wechat.loginConfirmed, false);
  await assert.rejects(m.components.probeWechat({ ...health, pid: 1 }), /identity_not_confirmed/);
  m.config.components.wechat.readerAuthorized = true;
  m.components.readerAction = async () => ({ ok: true, initialized: true, phase: 'initialized', pid: null });
  await m.components.probeWechat(health); assert.equal(m.state.components.wechat.phase, 'ready'); assert.equal(m.state.components.wechat.loginConfirmed, false);
  m.components.readerAction = async () => ({ ok: true, initialized: false, phase: 'init_required', pid: null });
  await m.components.probeWechat(health); assert.equal(m.state.components.wechat.phase, 'initialization_required'); assert.equal(m.config.components.wechat.readerAuthorized, false);
});

test('malformed saved identity fails instead of silently replacing a ledger identity', () => {
  const saved = componentDefaults(); assert.deepEqual(componentDefaults(saved), saved);
  assert.throws(() => componentDefaults({ quant: { accountId: 'daily-account' } }), /invalid_component_configuration/);
  assert.throws(() => componentDefaults({ wechat: { readerToken: 'bad\nvalue' } }), /invalid_component_configuration/);
});

test('a timed-out command remains owned until its process actually exits', async t => {
  const m = fixture(t), originalStop = m.forceStop.bind(m);
  m.forceStop = () => {};
  try {
    await assert.rejects(m.command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50, label: 'owned_timeout_fixture' }), /owned_timeout_fixture_timeout/);
    assert.equal(m.activeCommands.size, 1);
    await assert.rejects(m.stopComponents(), /component_command_stop_unconfirmed/);
  } finally {
    m.forceStop = originalStop;
    const exits = [...m.activeCommands].map(child => new Promise(resolve => { child.once('exit', resolve); originalStop(child); }));
    await Promise.all(exits);
  }
  assert.equal(m.activeCommands.size, 0);
});
