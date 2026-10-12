import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, availablePort, freshToken, isoNow, readJson, secureDirectory } from './security.mjs';

const pythonFlags = ['-I', '-B', '-X', 'utf8', '-u'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function componentDefaults(previous = {}) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('invalid_component_configuration');
  const quant = previous.quant || {}, wechat = previous.wechat || {};
  for (const value of [quant, wechat]) if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_component_configuration');
  for (const [value, names] of [[quant, ['token', 'signingKey', 'databasePassword']], [wechat, ['readerToken', 'senderToken']]]) {
    for (const name of names) if (value[name] !== undefined && (typeof value[name] !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value[name]))) throw new Error('invalid_component_configuration');
  }
  if (quant.accountId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(quant.accountId)) throw new Error('invalid_component_configuration');
  const accountId = quant.accountId || randomUUID();
  if (quant.commandId !== undefined && quant.commandId !== `install-init:${accountId}`) throw new Error('invalid_component_configuration');
  return {
    quant: { ...quant, enabled: quant.enabled === true, accountId,
      commandId: quant.commandId || `install-init:${accountId}`, token: quant.token || freshToken(),
      signingKey: quant.signingKey || freshToken(), databasePassword: quant.databasePassword || freshToken() },
    wechat: { ...wechat, enabled: wechat.enabled === true, readConsent: wechat.readConsent === true,
      readerAuthorized: wechat.readerAuthorized === true, sendEnabled: wechat.sendEnabled === true,
      readerToken: wechat.readerToken || freshToken(), senderToken: wechat.senderToken || freshToken() },
  };
}

export function validateComponentSelection(input) {
  const names = ['quantEnabled', 'wechatEnabled', 'wechatReadConsent', 'wechatSendEnabled'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || names.some(name => typeof input[name] !== 'boolean')) throw new Error('invalid_component_selection');
  if (Object.keys(input).some(name => !names.includes(name))) throw new Error('invalid_component_selection');
  if (input.wechatSendEnabled && !input.wechatEnabled || input.wechatReadConsent && !input.wechatEnabled) throw new Error('wechat_component_required');
  return Object.fromEntries(names.map(name => [name, input[name]]));
}

export class RuntimeComponents {
  constructor(manager) {
    this.manager = manager;
    const root = manager.options.installRoot, data = manager.dataDir;
    this.paths = {
      python: join(root, 'vendor', 'python', 'python.exe'),
      quant: join(root, 'components', 'quant'), astock: join(root, 'components', 'a-stock-data'),
      quantBootstrap: join(root, 'components', 'quant', 'scripts', 'install_bootstrap.py'),
      wechat: join(root, 'components', 'wechat'), sender: join(root, 'components', 'wechat', 'server.py'),
      reader: join(root, 'vendor', 'wechat-reader', 'wx.exe'),
      readerBootstrap: join(root, 'components', 'wechat', 'bootstrap-reader.ps1'),
      readerData: join(data, 'wechat', 'reader'), senderData: join(data, 'wechat', 'sender'),
      readerToken: join(data, 'private', 'wechat-reader-token'),
    };
    this.wechatPort = null;
    this.capabilities = readJson(join(root, 'component-manifest.json')) || readJson(join(root, 'release-manifest.json'))?.optionalComponents || {};
  }
  get config() { return this.manager.config.components; }
  installed(name) {
    const required = name === 'quant' ? ['python', 'quantBootstrap'] : ['python', 'reader', 'sender', 'readerBootstrap'];
    return this.capabilities[name] === true && required.every(key => existsSync(this.paths[key]));
  }
  initializeConfiguration() {
    this.manager.config.components = componentDefaults(this.manager.config.components);
    atomicJson(this.manager.paths.config, this.manager.config);
    for (const name of ['quant', 'wechat']) this.manager.component(name, {
      phase: this.installed(name) ? this.config[name].enabled ? 'configured' : 'disabled' : 'not_installed',
      installed: this.installed(name), enabled: this.config[name].enabled, error: null,
      detail: name === 'quant' ? '行情与模拟盘独立保存在本机，不接真实交易。' : '读取本人消息须先授权接入；发送仍须审核确认。',
    });
  }
  publicConfiguration() {
    return { quantEnabled: this.config.quant.enabled, wechatEnabled: this.config.wechat.enabled,
      wechatReadConsent: this.config.wechat.readConsent, wechatReaderInitialized: this.config.wechat.readerAuthorized,
      wechatSendEnabled: this.config.wechat.sendEnabled, quantInstalled: this.installed('quant'), wechatInstalled: this.installed('wechat') };
  }
  privateEnvironment(name, base = this.manager.environment()) {
    const osNames = ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'PROCESSOR_ARCHITECTURE', 'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'TZ', 'LANG', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUTF8', 'PYTHONIOENCODING'];
    const resourceNames = ['ZHIYU_INSTALL_ROOT', 'ZHIYU_INSTALL_DATA_DIR', 'ZHIYU_RUNTIME_OWNER_ID', 'ZHIYU_QUANT_INSTALL_MODE', 'ZHIYU_QUANT_RESOURCE_DIR', 'ZHIYU_ASTOCK_RESOURCE_DIR'];
    return Object.fromEntries(Object.entries(base).filter(([key]) => osNames.includes(key) || name === 'quant' && (resourceNames.includes(key) || /^(?:QUANT_|ASTOCK_)/.test(key)) || name === 'sender' && /^WECHAT_DESKTOP_/.test(key) || name === 'reader' && /^(?:WECHAT_LOCAL_|WX_CLI_)/.test(key)));
  }
  environment(base) {
    const env = { ...base }, { quant, wechat } = this.config;
    Object.assign(env, { ZHIYU_INSTALL_ROOT: this.manager.options.installRoot, ZHIYU_INSTALL_DATA_DIR: this.manager.dataDir,
      PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    if (this.installed('quant') && quant.enabled) {
      const database = new URL(base.DATABASE_URL); database.username = 'zhiyu_quant'; database.password = quant.databasePassword;
      Object.assign(env, { ZHIYU_OPTIONAL_QUANT_ENABLED: 'true', ZHIYU_QUANT_INSTALL_MODE: '1',
        ZHIYU_QUANT_RESOURCE_DIR: this.paths.quant, ZHIYU_ASTOCK_RESOURCE_DIR: this.paths.astock,
        QUANT_PYTHON_BIN: this.paths.python, ASTOCK_PYTHON_BIN: this.paths.python,
        QUANT_DATA_DIR: join(this.manager.dataDir, 'quant'), QUANT_TIMING_LOG_PATH: join(this.manager.dataDir, 'logs', 'quant-timing.log'),
        QUANT_TRANSPORT: 'embedded', QUANT_INTERNAL_TOKEN: quant.token, QUANT_PAPER_SIGNING_KEY: quant.signingKey,
        QUANT_PAPER_OWNER_ID: this.manager.config.ownerId, QUANT_PAPER_ACCOUNT_ID: quant.accountId,
        QUANT_PAPER_DATABASE_URL: database.href, QUANT_TDX_LOCAL_ENABLED: 'false', OPENZHIYU_SKIP_QUANT: '1' });
    }
    if (this.installed('wechat')) Object.assign(env, {
      ZHIYU_OPTIONAL_WECHAT_ENABLED: wechat.enabled ? 'true' : 'false',
      WECHAT_LOCAL_WX_BINARY: this.paths.reader, WECHAT_LOCAL_DATA_DIR: this.paths.readerData,
      WX_CLI_HOME: this.paths.readerData, WX_CLI_SESSION_TOKEN: wechat.readerToken,
      WECHAT_LOCAL_AUTHORIZED: wechat.enabled && wechat.readConsent && wechat.readerAuthorized ? 'true' : 'false',
      WECHAT_DESKTOP_DATA_DIR: this.paths.senderData, WECHAT_DESKTOP_TOKEN: wechat.senderToken,
      WECHAT_DESKTOP_SEND_ENABLED: wechat.enabled && wechat.sendEnabled ? 'true' : 'false',
      WECHAT_DESKTOP_SERVICE_URL: wechat.enabled && this.wechatPort ? `http://127.0.0.1:${this.wechatPort}` : 'http://127.0.0.1:1',
    });
    return env;
  }
  async saveSelection(input) {
    const value = validateComponentSelection(input), m = this.manager;
    if (m.busy || m.stopping || [...m.children.values()].some(item => !item.done)) throw new Error('stop_application_before_configuring');
    if (value.quantEnabled && !this.installed('quant') || value.wechatEnabled && !this.installed('wechat')) throw new Error('release_component_not_installed');
    this.config.quant.enabled = value.quantEnabled;
    Object.assign(this.config.wechat, { enabled: value.wechatEnabled, readConsent: value.wechatReadConsent, sendEnabled: value.wechatSendEnabled });
    if (!value.wechatReadConsent) this.config.wechat.readerAuthorized = false;
    atomicJson(m.paths.config, m.config); this.initializeConfiguration();
    m.event('component_configuration_saved', value);
    return this.publicConfiguration();
  }
  async pythonReceipt(script, action, env = this.privateEnvironment('quant'), label = 'component_check') {
    let receipt;
    const expectedEvent = { '--check': 'quant_install_checked', '--initialize': 'quant_install_initialized', '--health': 'quant_install_health' }[action];
    let failure;
    try { await this.manager.command(this.paths.python, [...pythonFlags, script, action], { env, label, timeoutMs: 90000,
      sensitiveOutput: true, inspect: line => { try { const value = JSON.parse(line); if (value?.event === expectedEvent) receipt = value; } catch {} } });
    } catch (error) { failure = error; }
    if (receipt?.ok !== true) throw new Error(receipt?.error && /^[a-z_0-9:.-]{1,100}$/.test(receipt.error) ? receipt.error : `${label}_not_confirmed`);
    if (failure) throw failure;
    return receipt;
  }
  async initializeQuant() {
    if (!this.config.quant.enabled) return;
    const m = this.manager;
    if (!this.installed('quant')) throw new Error('release_component_not_installed');
    secureDirectory(join(m.dataDir, 'quant'));
    m.component('quant', { phase: 'starting', error: null, detail: '正在准备独立模拟账户…' });
    const env = { ...this.privateEnvironment('quant'), QUANT_INSTALL_ADMIN_DATABASE_URL: m.environment().DATABASE_URL,
      QUANT_INSTALL_DATABASE_ROLE: 'zhiyu_quant', QUANT_INSTALL_DATABASE_PASSWORD: this.config.quant.databasePassword,
      QUANT_INSTALL_BOOTSTRAP_COMMAND_ID: this.config.quant.commandId, QUANT_INSTALL_INITIAL_CASH: '1000000.00' };
    await this.pythonReceipt(this.paths.quantBootstrap, '--check', this.privateEnvironment('quant'), 'quant_dependency_check');
    const initialized = await this.pythonReceipt(this.paths.quantBootstrap, '--initialize', env, 'quant_initialize');
    if (initialized.component !== 'quant' || initialized.initialized !== true || initialized.accountId !== this.config.quant.accountId || initialized.legacyImported !== false) throw new Error('quant_initialize_not_confirmed');
    const status = await this.pythonReceipt(this.paths.quantBootstrap, '--health', this.privateEnvironment('quant'), 'quant_health');
    if (status.component !== 'quant' || status.ownerBound !== true || status.accountId !== this.config.quant.accountId) throw new Error('quant_health_not_confirmed');
    m.component('quant', { phase: 'ready', lastHeartbeat: isoNow(), detail: '独立模拟账户已准备。行情质量以量化页面的来源与时间为准。', accountInitialized: true });
    m.event('quant_account_ready', { accountId: this.config.quant.accountId, initialized: status.ok });
  }
  async readerAction(action, { elevate = false } = {}) {
    if (!this.installed('wechat')) throw new Error('release_component_not_installed');
    secureDirectory(this.paths.readerData);
    writeFileSync(this.paths.readerToken, this.config.wechat.readerToken, { mode: 0o600 });
    const system = process.env.SystemRoot || 'C:\\Windows';
    let receipt;
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.paths.readerBootstrap,
      '-ReaderBinary', this.paths.reader, '-DataDirectory', this.paths.readerData, '-TokenFile', this.paths.readerToken, '-Action', action];
    if (elevate) args.push('-Elevate');
    let failure;
    try { await this.manager.command(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, {
      label: `wechat_reader_${action}`, env: this.privateEnvironment('reader'), timeoutMs: action === 'initialize' ? 300000 : 30000,
      allowDuringShutdown: action === 'stop',
      sensitiveOutput: true, inspect: line => { try { const value = JSON.parse(line); if (value.event === `wechat_reader_${action}`) receipt = value; } catch {} } });
    } catch (error) { failure = error; }
    if (receipt?.ok !== true) throw new Error(receipt?.error && /^[a-z_0-9:.-]{1,100}$/.test(receipt.error) ? receipt.error : `wechat_reader_${action}_not_confirmed`);
    if (failure) throw failure;
    return receipt;
  }
  async initializeWechat(input) {
    const m = this.manager;
    if (m.busy || m.stopping || [...m.children.values()].some(item => !item.done)) throw new Error('stop_application_before_configuring');
    if (!this.config.wechat.enabled || !this.config.wechat.readConsent) throw new Error('wechat_read_consent_required');
    if (input?.elevate !== undefined && typeof input.elevate !== 'boolean') throw new Error('invalid_component_selection');
    m.busy = true; m.component('wechat', { phase: 'initializing', error: null });
    try {
      const receipt = await this.readerAction('initialize', { elevate: input?.elevate === true });
      if (receipt.initialized !== true) throw new Error('wechat_reader_initialization_not_confirmed');
      this.config.wechat.readerAuthorized = true; atomicJson(m.paths.config, m.config);
      const warning = receipt.warning ? '读取端已完成接入准备。请在微信工作台核对消息能否读取、时间是否正确；发送仍须审核确认。' : null;
      m.component('wechat', { phase: 'configured', readerInitialized: true, lastHeartbeat: isoNow(), detail: warning || '消息读取已接入；发送仍按你的开关与审核流程执行。' });
      m.event('wechat_reader_authorized', { version: receipt.version || null, warningCode: receipt.warning || null });
      return { ok: true, initialized: true, warning };
    } catch (error) { m.component('wechat', { phase: 'initialization_required', error: error.message }); throw error; }
    finally { m.busy = false; }
  }
  async startWechat() {
    if (!this.config.wechat.enabled) return;
    const m = this.manager;
    secureDirectory(this.paths.senderData);
    this.wechatPort = await availablePort(18765);
    const child = spawn(this.paths.python, [...pythonFlags, this.paths.sender, '--host', '127.0.0.1', '--port', String(this.wechatPort), '--data-dir', this.paths.senderData, '--managed-stdin'], {
      cwd: this.paths.senderData, env: this.privateEnvironment('sender'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const item = { child, done: false, stopping: false };
    item.exited = new Promise(resolve => {
      const finish = code => { if (item.done) return; item.done = true; resolve(code);
        if (!item.stopping && !m.stopping) { m.component('wechat', { phase: 'failed', error: 'wechat_sender_unexpected_exit', pid: null }); m.event('wechat_sender_unexpected_exit', { code }); } };
      child.once('error', () => finish(1)); child.once('exit', code => finish(code ?? 1));
    });
    m.children.set('wechat', item); m.capture(child, 'wechat');
    for (let n = 0; n < 60; n++) {
      if (item.done || m.stopping) throw new Error('wechat_sender_start_failed');
      try { const value = await this.senderRequest('/health');
        if (value.pid === child.pid) { await this.probeWechat(value); return; }
      } catch {}
      await wait(500);
    }
    throw new Error('wechat_sender_ready_timeout');
  }
  async senderRequest(path, method = 'GET') {
    const response = await fetch(`http://127.0.0.1:${this.wechatPort}${path}`, { method,
      headers: { Authorization: `Bearer ${this.config.wechat.senderToken}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('wechat_sender_health_unavailable'); }
    return response.json();
  }
  async probeWechat(value) {
    if (!this.config.wechat.enabled) return;
    const health = value || await this.senderRequest('/health');
    const child = this.manager.children.get('wechat');
    if (!child || child.done || health.pid !== child.child.pid) throw new Error('wechat_sender_identity_not_confirmed');
    if (health.service !== 'zhiyu-wechat-desktop' || health.requiresAuth !== true) throw new Error('wechat_sender_identity_not_confirmed');
    const windowAvailable = health.wechatWindowFound === true && health.desktopStatus === 'available';
    let readerPhase = this.config.wechat.readConsent ? 'initialization_required' : 'disabled';
    let readerPid = null;
    if (this.config.wechat.readConsent && this.config.wechat.readerAuthorized) {
      const reader = await this.readerAction('health'); readerPhase = reader.phase; readerPid = reader.pid || null;
      if (!['running', 'initialized', 'init_required', 'unresponsive'].includes(reader.phase)) throw new Error('reader_health_unconfirmed');
      if (reader.initialized !== true) { this.config.wechat.readerAuthorized = false; atomicJson(this.manager.paths.config, this.manager.config); }
      if (reader.phase === 'unresponsive') throw new Error('reader_health_unconfirmed');
    }
    this.manager.component('wechat', { phase: !this.config.wechat.readerAuthorized && this.config.wechat.readConsent ? 'initialization_required' : windowAvailable ? 'ready' : 'window_not_available',
      pid: health.pid, lastHeartbeat: isoNow(), readerInitialized: this.config.wechat.readerAuthorized,
      readerPhase, readerPid,
      loginConfirmed: false, loginStatus: health.loginStatus || 'unverified', compatibility: health.compatibility || 'unverified',
      sendEnabled: this.config.wechat.sendEnabled, error: null,
      detail: windowAvailable ? '桌面组件已响应；窗口存在不等于登录或消息已送达，请在微信工作台核对。' : '请安装并登录电脑版微信，保持桌面会话可用。' });
  }
  async probe() {
    if (this.config.quant.enabled && this.installed('quant')) {
      try { const status = await this.pythonReceipt(this.paths.quantBootstrap, '--health', this.privateEnvironment('quant'), 'quant_health');
        if (status.component !== 'quant' || status.ownerBound !== true || status.accountId !== this.config.quant.accountId) throw new Error('quant_health_not_confirmed');
        this.manager.component('quant', { phase: 'ready', lastHeartbeat: isoNow(), error: null });
      } catch (error) { this.manager.component('quant', { phase: 'degraded', error: error.message }); }
    }
    if (this.config.wechat.enabled && this.installed('wechat')) {
      try { await this.probeWechat(); }
      catch (error) { this.manager.component('wechat', { phase: 'degraded', error: error.message }); }
    }
  }
  async stop() {
    const m = this.manager, item = m.children.get('wechat');
    if (item && !item.done) {
      item.stopping = true; m.component('wechat', { phase: 'stopping' });
      try { await this.senderRequest('/shutdown', 'POST'); } catch (error) { m.event('wechat_shutdown_request_failed', { reason: error.message }); }
      const settled = await Promise.race([item.exited.then(code => ({ code })), wait(20000).then(() => null)]);
      if (!settled || settled.code !== 0) { m.component('wechat', { phase: 'stop_unconfirmed' }); throw new Error('wechat_sender_stop_unconfirmed'); }
    }
    if (this.config.wechat.enabled && this.installed('wechat')) await this.readerAction('stop');
    this.wechatPort = null;
    for (const name of ['wechat', 'quant']) if (this.installed(name)) m.component(name, { phase: this.config[name].enabled ? 'stopped' : 'disabled', pid: null });
  }
}
