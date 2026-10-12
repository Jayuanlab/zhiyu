import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { availablePort, atomicJson, childEnvironment, freshToken, isoNow, prepareDataDirectory, readJson, redact, requestAllowed, secureDirectory, validateModel } from './security.mjs';
import { RuntimeComponents } from './components.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function parseArguments(args) {
  const result = { installRoot: resolve(here, '..'), dataDir: join(process.env.LOCALAPPDATA || homedir(), 'Zhiyu', 'data'), open: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--open') result.open = true;
    else if (args[i] === '--install-root' && args[i + 1]) result.installRoot = resolve(args[++i]);
    else if (args[i] === '--data-dir' && args[i + 1]) result.dataDir = resolve(args[++i]);
    else throw new Error('unknown_manager_argument');
  }
  return result;
}

export class RuntimeManager {
  constructor(options) {
    this.options = options;
    this.dataDir = prepareDataDirectory(options.dataDir, options.installRoot);
    this.paths = {
      state: join(this.dataDir, 'runtime', 'state.json'), token: join(this.dataDir, 'runtime', 'control-token'), lock: join(this.dataDir, 'runtime', 'manager.lock'),
      config: join(this.dataDir, 'private', 'config.json'), pg: join(this.dataDir, 'postgres'),
      migrationState: join(this.dataDir, 'private', 'migration-state.json'),
      node: join(options.installRoot, 'vendor', 'node', 'node.exe'), pgCtl: join(options.installRoot, 'vendor', 'postgres', 'bin', 'pg_ctl.exe'), initDb: join(options.installRoot, 'vendor', 'postgres', 'bin', 'initdb.exe'),
      web: join(options.installRoot, 'app', 'apps', 'web', 'server.js'), worker: join(options.installRoot, 'worker', 'start-runtime-worker.mjs'), migration: join(options.installRoot, 'migrations', 'migrate.mjs'),
    };
    this.token = freshToken(); this.nonce = randomUUID(); this.children = new Map(); this.activeCommands = new Set(); this.postgresPort = 15432; this.webPort = 3515;
    this.state = { schemaVersion: 1, instanceId: this.nonce, pid: process.pid, managerPort: null, status: 'starting', webUrl: null, setupUrl: null, error: null, errorDetail: null, updatedAt: isoNow(), components: {
      database: { phase: 'stopped' }, web: { phase: 'stopped' }, worker: { phase: 'stopped' },
      model: { phase: 'not_configured' }, wechat: { phase: 'not_installed', detail: '当前安装版尚未包含微信组件' }, quant: { phase: 'not_installed', detail: '当前安装版尚未包含量化组件' },
      embeddings: { phase: 'not_configured', detail: '语义检索尚未配置，相关功能可能不可用' },
    } };
    this.busy = false; this.stopping = false; this.paused = false; this.probing = false;
    this.quantChildren = new Map();
    this.components = new RuntimeComponents(this);
  }

  secrets() { return [this.token, this.config?.databasePassword, this.config?.authSecret, this.config?.encryptionKey, this.config?.model?.apiKey,
    this.config?.components?.quant?.token, this.config?.components?.quant?.signingKey, this.config?.components?.quant?.databasePassword,
    this.config?.components?.wechat?.readerToken, this.config?.components?.wechat?.senderToken]; }
  event(event, detail = {}) {
    const file = join(this.dataDir, 'logs', 'manager-events.jsonl');
    if (existsSync(file) && statSync(file).size > 10 * 1024 * 1024) {
      const previous = `${file}.previous`;
      if (existsSync(previous)) unlinkSync(previous);
      cpSync(file, previous); writeFileSync(file, '', { mode: 0o600 });
    }
    appendFileSync(file, `${redact(JSON.stringify({ at: isoNow(), event, source: 'windows-runtime-manager', ...detail }), this.secrets())}\n`, { mode: 0o600 });
  }
  publish() { this.state.updatedAt = isoNow(); atomicJson(this.paths.state, this.state); }
  component(name, fields) { Object.assign(this.state.components[name], fields); this.publish(); }
  failure(error, component) {
    const reason = redact(error instanceof Error ? error.message : String(error), this.secrets()).slice(0, 500);
    this.state.status = 'failed'; this.state.error = reason;
    this.state.errorDetail = error?.stage || error?.driverCode ? { stage: /^[a-z_]{1,40}$/.test(error.stage || '') ? error.stage : null, driverCode: /^[0-9A-Z]{5}$/.test(error.driverCode || '') ? error.driverCode : null } : null;
    if (component) this.component(component, { phase: 'failed', error: reason });
    this.event('operation_failed', { component, reason, errorDetail: this.state.errorDetail }); this.publish();
  }

  async claim() {
    const existing = readJson(this.paths.state);
    if (existing?.managerPort && existsSync(this.paths.token)) {
      try {
        const response = await fetch(`http://127.0.0.1:${existing.managerPort}/api/status`, { headers: { 'X-Zhiyu-Token': readFileSync(this.paths.token, 'utf8').trim() }, signal: AbortSignal.timeout(1500) });
        const current = response.ok ? await response.json() : null;
        if (current?.pid === existing.pid && current?.managerPort === existing.managerPort && current?.instanceId === existing.instanceId && readJson(this.paths.lock)?.nonce === current?.instanceId) {
          if (this.options.open) await fetch(`http://127.0.0.1:${existing.managerPort}/api/open`, { method: 'POST', headers: { 'X-Zhiyu-Token': readFileSync(this.paths.token, 'utf8').trim(), Origin: `http://127.0.0.1:${existing.managerPort}` }, signal: AbortSignal.timeout(5000) });
          return false;
        }
      } catch {}
    }
    try {
      const fd = openSync(this.paths.lock, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: this.nonce, at: isoNow() })); closeSync(fd);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = readJson(this.paths.lock);
      if (!prior?.pid || alive(prior.pid)) throw new Error('manager_already_starting_or_unresponsive');
      // The launcher's per-user mutex serializes normal starts. A stale lock is
      // only removed after its owning process is confirmed dead.
      unlinkSync(this.paths.lock);
      return this.claim();
    }
    writeFileSync(this.paths.token, this.token, { encoding: 'utf8', mode: 0o600 });
    this.publish();
    this.event('manager_started', { previousStatus: existing?.status ?? null, recovered: !!existing && !['stopped', 'setup_required'].includes(existing.status) });
    return true;
  }

  loadConfig() {
    this.config = readJson(this.paths.config);
    if (!this.config) {
      this.config = { schemaVersion: 1, ownerId: randomUUID(), databasePassword: freshToken(), authSecret: freshToken(), encryptionKey: freshToken(), model: null, desiredStatus: 'stopped', createdAt: isoNow() };
      atomicJson(this.paths.config, this.config);
    }
    if (!/^[0-9a-f-]{36}$/i.test(this.config.ownerId) || !['databasePassword', 'authSecret', 'encryptionKey'].every(key => typeof this.config[key] === 'string' && this.config[key].length >= 32)) throw new Error('invalid_saved_credentials');
    this.paused = this.config.desiredStatus === 'paused';
    this.component('model', { phase: this.config.model ? 'configured' : 'not_configured', model: this.config.model?.model, lastTestAt: this.config.modelTest?.at, detail: this.config.modelTest?.detail });
    this.components.initializeConfiguration();
  }

  environment() {
    const env = childEnvironment(this.dataDir, this.config, this.postgresPort, this.webPort);
    env.ZHIYU_RUNTIME_START_PAUSED = this.paused ? '1' : '0';
    const osSystem = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    env.PATH = [dirname(this.paths.node), dirname(this.paths.pgCtl), osSystem].join(process.platform === 'win32' ? ';' : ':');
    env.OPENZHIYU_PROJECT_SKILLS_DIR = join(this.options.installRoot, 'app', 'skills');
    env.ZHIYU_RESOURCE_DIR = join(this.options.installRoot, 'app');
    return this.components.environment(env);
  }

  capture(child, name, inspect) {
    for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      const lines = createInterface({ input: stream });
      lines.on('line', line => {
        const safe = redact(line, this.secrets()).slice(0, 10000);
        this.event('component_output', { component: name, stream: streamName, detail: safe });
        inspect?.(line, streamName);
      });
    }
  }

  command(executable, args, { env = this.environment(), timeoutMs = 120000, label = 'command', inspect, allowDuringShutdown = false, sensitiveOutput = false } = {}) {
    if (this.stopping && !allowDuringShutdown) return Promise.reject(new Error('shutdown_requested'));
    return new Promise((resolveCommand, rejectCommand) => {
      const child = spawn(executable, args, { cwd: join(this.dataDir, 'app'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.activeCommands.add(child); let settled = false, output = '', migrationFailure;
      const observe = (line, streamName) => {
        output = `${output}\n${line}`.slice(-200000); inspect?.(line, streamName);
        if (label === 'database_migrate') {
          try {
            const result = JSON.parse(line);
            if (result.event === 'migration_failed' && /^migration_[a-z_]+$/.test(result.code || '')) migrationFailure = {
              code: result.code, stage: /^[a-z_]{1,40}$/.test(result.stage || '') ? result.stage : undefined,
              driverCode: /^[0-9A-Z]{5}$/.test(result.driverCode || '') ? result.driverCode : undefined,
            };
          } catch {}
        }
      };
      if (sensitiveOutput) {
        for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
          createInterface({ input: stream }).on('line', line => { if (streamName === 'stdout') observe(line, streamName); });
        }
      } else this.capture(child, label, observe);
      const timer = setTimeout(() => { this.forceStop(child); settle(new Error(`${label}_timeout`)); }, timeoutMs);
      const settle = error => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) rejectCommand(error); else resolveCommand(output);
      };
      child.once('error', error => { if (!child.pid) this.activeCommands.delete(child); settle(new Error(`${label}_spawn_failed:${error.code || 'unknown'}`)); });
      child.once('exit', code => { this.activeCommands.delete(child); settle(code === 0 ? null : migrationFailure ? Object.assign(new Error(migrationFailure.code), { stage: migrationFailure.stage, driverCode: migrationFailure.driverCode }) : new Error(`${label}_exit_${code}`)); });
    });
  }

  forceStop(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    } else child.kill('SIGKILL');
  }

  async startDatabase() {
    this.component('database', { phase: 'starting', error: null });
    let initialized = false;
    if (!existsSync(join(this.paths.pg, 'PG_VERSION'))) {
      if (existsSync(this.paths.pg) && readdirSync(this.paths.pg).length) throw new Error('postgres_partial_initialization_requires_review');
      const passwordFile = join(this.dataDir, 'private', 'initdb-password');
      writeFileSync(passwordFile, this.config.databasePassword, { encoding: 'utf8', mode: 0o600 });
      try {
        await this.command(this.paths.initDb, ['-D', this.paths.pg, '--username=zhiyu', `--pwfile=${passwordFile}`, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C'], { label: 'database_initialize' });
      } finally { if (existsSync(passwordFile)) unlinkSync(passwordFile); }
      this.event('database_initialized');
      initialized = true;
    }
    await this.ensureClusterStopped();
    if (!initialized && this.releaseFingerprint && readJson(this.paths.migrationState)?.fingerprint !== this.releaseFingerprint) {
      this.state.status = 'backing_up'; this.publish();
      const backupPath = this.snapshotCold('before_database_migration');
      this.event('migration_backup_completed', { path: backupPath });
      this.state.status = 'starting'; this.publish();
    }
    this.postgresPort = await availablePort(15432);
    this.databaseStoppedAt = null;
    await this.command(this.paths.pgCtl, ['-D', this.paths.pg, '-l', join(this.dataDir, 'logs', 'postgres.log'), '-w', '-t', '60', '-o', `-h 127.0.0.1 -p ${this.postgresPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`, 'start'], { label: 'database_start', timeoutMs: 65000 });
    this.databaseStarted = true;
    this.component('database', { phase: 'running', port: this.postgresPort, lastHeartbeat: isoNow() });
  }

  spawnManaged(name, args) {
    const child = spawn(this.paths.node, args, { cwd: join(this.dataDir, 'app'), env: this.environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const item = { child, done: false, stopping: false };
    item.exited = new Promise(resolveExit => {
      const finish = code => {
        if (item.done) return; item.done = true; resolveExit(code);
        if (!item.stopping && !this.stopping) {
          this.failure(new Error(`${name}_unexpected_exit_${code}`), name);
          void this.stopComponents().catch(error => this.failure(error));
        }
      };
      child.once('error', () => finish(1)); child.once('exit', code => finish(code ?? 1));
    });
    this.children.set(name, item);
    child.on('message', message => {
      if (name === 'web' && message?.event === 'web_components_stopped' && message.hostPid === child.pid) item.componentStopConfirmed = message.confirmed === true;
      if (message?.event === 'component_process' && message.component === 'quant' && message.hostPid === child.pid && Number.isInteger(message.pid) && message.pid > 0) {
        this.quantChildren.set(message.pid, { hostPid: child.pid, stopped: message.phase === 'stopped' });
        this.event('quant_process_observed', { hostPid: child.pid, pid: message.pid, phase: message.phase,
          ...(message.phase === 'stopped' ? { exitCode: Number.isInteger(message.exitCode) ? message.exitCode : null } : {}) });
      }
    });
    this.capture(child, name, (line, streamName) => {
      if (name !== 'worker' || streamName !== 'stdout') return;
      try {
        const message = JSON.parse(line);
        if (message.event === 'runtime_state') {
          this.component('worker', { phase: message.phase, error: redact(message.error || '', this.secrets()) || null, modules: (message.modules || []).map(module => ({ name: module.name, phase: module.phase, lastRunAt: module.lastStartedAt, nextRunAt: module.nextRunAt, lastError: redact(module.lastError || '', this.secrets()), inFlight: !!module.inFlight })) });
        }
      } catch {}
    });
    this.component(name, { phase: 'starting', pid: child.pid, error: null });
    return item;
  }

  async startWorker() {
    const item = this.spawnManaged('worker', ['--conditions=react-server', this.paths.worker]);
    const ready = await new Promise(resolveReady => {
      const timer = setTimeout(() => resolveReady(false), 90000);
      item.child.on('message', message => { if (message?.event === 'runtime_ready') { clearTimeout(timer); resolveReady(true); } });
      item.exited.then(() => { clearTimeout(timer); resolveReady(false); });
    });
    if (!ready || this.stopping || item.done) throw new Error('worker_ready_not_confirmed');
    this.component('worker', { phase: this.paused ? 'paused' : 'running', pid: item.child.pid });
    if (this.paused) item.child.send('pause', () => {});
  }

  async startWeb() {
    this.webPort = await availablePort(3515);
    this.state.webUrl = `http://127.0.0.1:${this.webPort}`;
    const item = this.spawnManaged('web', [join(here, 'web-host.mjs'), this.paths.web]);
    let ownSocketConfirmed = false;
    item.child.on('message', message => { if (message?.event === 'web_listening' && message.pid === item.child.pid && message.port === this.webPort) ownSocketConfirmed = true; });
    for (let n = 0; n < 60; n++) {
      if (item.done || this.stopping) throw new Error('web_ready_not_confirmed');
      if (!ownSocketConfirmed) { await delay(500); continue; }
      try {
        const response = await fetch(this.state.webUrl, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 400) { this.component('web', { phase: 'running', port: this.webPort, lastHeartbeat: isoNow() }); return; }
      } catch {}
      await delay(500);
    }
    throw new Error('web_ready_timeout');
  }

  async start() {
    if (this.busy || this.stopping) throw new Error('operation_in_progress');
    if (['running', 'paused'].includes(this.state.status)) return;
    if (!this.config.model) throw new Error('model_configuration_required');
    this.busy = true; this.state.status = 'starting'; this.state.error = null; this.state.errorDetail = null; this.publish(); this.event('application_start_requested');
    try {
      for (const key of ['node', 'pgCtl', 'initDb', 'web', 'worker', 'migration']) if (!existsSync(this.paths[key])) throw new Error(`release_component_missing:${key}`);
      const release = readJson(join(this.options.installRoot, 'release-manifest.json'));
      if (!release?.version || !release?.nextBuildId) throw new Error('release_manifest_missing');
      this.releaseFingerprint = createHash('sha256').update(JSON.stringify({ version: release.version, nextBuildId: release.nextBuildId })).digest('hex');
      this.webPort = await availablePort(3515);
      await this.stopComponents();
      await this.startDatabase();
      this.state.status = 'migrating'; this.publish();
      await this.command(this.paths.node, ['--conditions=react-server', realpathSync(this.paths.migration)], { label: 'database_migrate', timeoutMs: 180000 });
      atomicJson(this.paths.migrationState, { fingerprint: this.releaseFingerprint, migratedAt: isoNow() });
      this.event('migrations_confirmed');
      await this.components.initializeQuant();
      await this.components.startWechat();
      await this.startWorker();
      await this.startWeb();
      this.config.desiredStatus = this.paused ? 'paused' : 'running'; atomicJson(this.paths.config, this.config);
      const optionalNeedsAttention = ['wechat', 'quant'].some(name => this.config.components[name].enabled && this.state.components[name].phase !== 'ready');
      this.state.status = this.paused ? 'paused' : optionalNeedsAttention ? 'degraded' : 'running'; this.state.error = null; this.publish(); this.event('application_ready', { webPort: this.webPort, desiredStatus: this.config.desiredStatus });
      await this.probe();
    } catch (error) {
      this.failure(error);
      await this.stopComponents().catch(stopError => this.event('recovery_stop_failed', { reason: stopError.message }));
      throw error;
    } finally { this.busy = false; }
  }

  async stopChild(name) {
    const item = this.children.get(name);
    if (!item || item.done) return;
    item.stopping = true; this.component(name, { phase: 'stopping' });
    if (name === 'worker' && item.child.connected) item.child.send('stop', () => {});
    else if (name === 'web' && item.child.connected) item.child.send('stop', () => {});
    else if (item.child.connected) item.child.disconnect();
    else item.child.kill('SIGTERM');
    const timer = setTimeout(() => this.forceStop(item.child), name === 'worker' ? 40000 : 15000);
    const code = await item.exited; clearTimeout(timer);
    const confirmed = name === 'web' ? item.componentStopConfirmed === true : code === 0;
    this.component(name, { phase: confirmed ? 'stopped' : 'stop_unconfirmed', pid: null });
    this.event('component_stopped', { component: name, code, confirmed });
    if (!confirmed) throw new Error(`${name}_stop_unconfirmed`);
  }

  async stopComponents() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopComponentsOnce();
    try { return await this.stopPromise; } finally { this.stopPromise = null; }
  }

  async stopComponentsOnce() {
    // Worker drains durable commands before the web and private database stop.
    let workerError, webError;
    try { await this.stopChild('worker'); } catch (error) { workerError = error; }
    try { await this.stopChild('web'); } catch (error) { webError = error; }
    for (const [pid] of this.quantChildren) {
      for (let n = 0; alive(pid) && n < 40; n++) await delay(250);
      if (alive(pid)) { this.component('quant', { phase: 'stop_unconfirmed', pid }); throw new Error('quant_stop_unconfirmed'); }
      this.quantChildren.delete(pid);
    }
    await this.components.stop();
    if (workerError) throw workerError;
    if (webError) throw webError;
    for (let n = 0; this.activeCommands.size && n < 20; n++) await delay(250);
    if (this.activeCommands.size) throw new Error('component_command_stop_unconfirmed');
    await this.ensureClusterStopped();
  }

  async ensureClusterStopped() {
    if (!existsSync(join(this.paths.pg, 'PG_VERSION'))) { this.databaseStarted = false; this.databaseStoppedAt = isoNow(); return; }
    let online = true;
    try {
      await this.command(this.paths.pgCtl, ['-D', this.paths.pg, 'status'], { label: 'database_existing_status', timeoutMs: 10000, allowDuringShutdown: true });
    } catch (error) {
      if (error.message === 'database_existing_status_exit_3') online = false;
      else { this.component('database', { phase: 'stop_unconfirmed', error: error.message }); throw error; }
    }
    if (online) {
      this.component('database', { phase: 'stopping' });
      try {
        // pg_ctl checks this exact cluster. A global port or PID never grants
        // ownership, including recovery after an interrupted pg_ctl start.
        await this.command(this.paths.pgCtl, ['-D', this.paths.pg, '-m', 'fast', '-w', '-t', '60', 'stop'], { label: 'database_stop', timeoutMs: 65000, allowDuringShutdown: true });
        this.event('private_database_stop_confirmed');
      } catch (error) { this.component('database', { phase: 'stop_unconfirmed', error: error.message }); throw error; }
    }
    this.databaseStarted = false; this.databaseStoppedAt = isoNow(); this.component('database', { phase: 'stopped' });
  }

  async pause(paused) {
    if (this.busy || this.stopping) throw new Error('operation_in_progress');
    const item = this.children.get('worker');
    if (!item || item.done || !['running', 'paused', 'degraded'].includes(this.state.status)) throw new Error('application_not_running');
    this.paused = paused; this.config.desiredStatus = paused ? 'paused' : 'running'; atomicJson(this.paths.config, this.config);
    item.child.send(paused ? 'pause' : 'resume', () => {});
    this.state.status = paused ? 'pausing' : 'resuming'; this.publish();
    this.event(paused ? 'pause_requested' : 'resume_requested');
    // User intent is persisted immediately; state becomes confirmed only when
    // the worker's durable heartbeat reflects that intent.
    await delay(1200); await this.probe();
  }

  async probe() {
    if (this.probing || this.busy || this.stopping || !this.databaseStarted) return;
    this.probing = true;
    try {
      const web = this.children.get('web');
      if (web && !web.done && this.state.webUrl) {
        try {
          const response = await fetch(this.state.webUrl, { redirect: 'manual', signal: AbortSignal.timeout(4000) }); await response.body?.cancel();
          this.component('web', { phase: response.status < 400 ? 'running' : 'degraded', httpStatus: response.status, lastHeartbeat: response.status < 400 ? isoNow() : this.state.components.web.lastHeartbeat });
        } catch { this.component('web', { phase: 'degraded', error: 'web_health_timeout' }); }
      }
      let snapshot;
      await this.command(this.paths.node, ['--conditions=react-server', this.paths.worker, '--status'], { label: 'runtime_health', timeoutMs: 15000, inspect: line => { try { const event = JSON.parse(line); if (event.event === 'runtime_status') snapshot = event.status; } catch {} } });
      const heartbeat = snapshot?.last_heartbeat_at;
      const fresh = heartbeat && Date.now() - Date.parse(heartbeat) < 20000;
      const modules = (snapshot?.modules || []).map(module => ({ name: module.name, phase: module.phase, lastError: redact(module.lastError || '', this.secrets()), inFlight: !!module.inFlight, lastRunAt: module.lastStartedAt, nextRunAt: module.nextRunAt }));
      const moduleFailure = modules.some(module => module.lastError || ['error', 'failed', 'degraded'].includes(module.phase));
      const pausedConfirmed = snapshot?.desired_status === 'paused';
      const phase = !snapshot?.online || !fresh ? 'unresponsive' : pausedConfirmed ? 'paused' : moduleFailure ? 'degraded' : 'running';
      this.component('worker', { phase, lastHeartbeat: heartbeat || null, leaseUntil: snapshot?.lease_until || null, modules, error: phase === 'unresponsive' ? 'worker_heartbeat_missing_or_stale' : null });
      this.component('database', { phase: 'running', lastHeartbeat: isoNow() });
      await this.components.probe();
      const optionalNeedsAttention = ['wechat', 'quant'].some(name => this.config.components[name].enabled && this.state.components[name].phase !== 'ready');
      if (!['failed', 'stopping', 'stopped'].includes(this.state.status)) this.state.status = phase === 'paused' ? 'paused' : phase === 'running' && this.state.components.web.phase === 'running' && !optionalNeedsAttention ? 'running' : 'degraded';
      this.publish();
    } catch (error) {
      const reason = redact(error.message, this.secrets());
      this.component('database', { phase: 'degraded', error: reason });
      this.component('worker', { phase: 'unresponsive', error: 'worker_heartbeat_missing_or_stale' });
      this.state.status = 'degraded'; this.publish();
    }
    finally { this.probing = false; }
  }

  async modelTest(input) {
    const model = validateModel(input, this.config.model || {});
    const endpoint = `${model.baseUrl}/models`;
    try {
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${model.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`model_service_http_${response.status}`); }
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) throw new Error('model_service_response_too_large');
      const body = JSON.parse(text), present = Array.isArray(body.data) && body.data.some(item => item.id === model.model);
      const result = { ok: true, modelListed: present, at: isoNow(), detail: present ? '连接成功，服务商列出了此模型；尚未发起付费生成。' : '连接成功，但模型列表未列出此名称，请核对模型名称；尚未发起付费生成。' };
      this.lastModelTest = { fingerprint: createHash('sha256').update(JSON.stringify(model)).digest('hex'), result };
      this.component('model', { lastTestAt: result.at, detail: result.detail });
      this.event('model_connection_checked', { ok: true, modelListed: present }); return result;
    } catch (error) {
      this.event('model_connection_checked', { ok: false, reason: redact(error.message, [...this.secrets(), model.apiKey]) });
      throw new Error(redact(error.message, [...this.secrets(), model.apiKey]));
    }
  }

  async saveModel(input) {
    if (this.busy || this.stopping || this.children.get('web') && !this.children.get('web').done) throw new Error('stop_application_before_configuring');
    this.config.model = validateModel(input, this.config.model || {});
    const fingerprint = createHash('sha256').update(JSON.stringify(this.config.model)).digest('hex');
    this.config.modelTest = this.lastModelTest?.fingerprint === fingerprint ? this.lastModelTest.result : null; atomicJson(this.paths.config, this.config);
    this.component('model', { phase: 'configured', model: this.config.model.model, lastTestAt: this.config.modelTest?.at || null, detail: this.config.modelTest?.detail || '配置已保存，启动后生效；模型连接尚未验证。' });
    this.state.status = 'stopped'; this.state.error = null; this.state.errorDetail = null; this.publish(); this.event('model_configuration_saved', { model: this.config.model.model });
  }

  async backup() {
    if (this.busy || this.stopping) throw new Error('operation_in_progress');
    this.busy = true; const shouldRestart = ['running', 'paused', 'degraded'].includes(this.state.status) && !!this.children.get('worker') && !this.children.get('worker').done;
    let target;
    try {
      this.state.status = 'backing_up'; this.publish(); this.event('backup_requested');
      await this.stopComponents();
      target = this.snapshotCold('user_requested');
      this.event('backup_completed', { path: target }); this.state.status = 'stopped'; this.publish();
    } catch (error) { this.failure(error); throw error; }
    finally { this.busy = false; }
    if (shouldRestart) await this.start();
    return target;
  }

  snapshotCold(reason) {
    if (this.databaseStarted || [...this.children.values()].some(item => !item.done)) throw new Error('backup_requires_confirmed_stop');
    if (existsSync(join(this.paths.pg, 'PG_VERSION')) && !this.databaseStoppedAt) throw new Error('backup_requires_confirmed_database_stop');
    const target = join(this.dataDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
    secureDirectory(target);
    for (const name of ['postgres', 'app-data', 'private', 'quant', 'wechat']) {
      const source = join(this.dataDir, name);
      if (existsSync(source)) cpSync(source, join(target, name), { recursive: true, dereference: false, errorOnExist: true });
    }
    atomicJson(join(target, 'backup.json'), { schemaVersion: 1, at: isoNow(), ownerId: this.config.ownerId, postgresMajor: existsSync(join(this.paths.pg, 'PG_VERSION')) ? readFileSync(join(this.paths.pg, 'PG_VERSION'), 'utf8').trim() : null, encrypted: false, containsCredentials: true, kind: 'cold-private-install-copy', reason, releaseFingerprint: this.releaseFingerprint || null, symlinkHandling: 'links_preserved_without_external_files' });
    return target;
  }

  async stopApplication() {
    if (this.busy || this.stopping) throw new Error('operation_in_progress');
    this.busy = true;
    try {
      this.config.desiredStatus = 'stopped'; atomicJson(this.paths.config, this.config);
      this.paused = false;
      this.state.status = 'stopping'; this.publish(); this.event('application_stop_requested');
      await this.stopComponents(); this.state.status = 'stopped'; this.publish();
    } finally { this.busy = false; }
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.stopping = true; clearInterval(this.healthTimer); this.state.status = 'stopping'; this.publish(); this.event('manager_shutdown_requested');
      for (const child of this.activeCommands) this.forceStop(child);
      // Existing start/backup must settle before the same cluster is stopped.
      for (let n = 0; this.busy && n < 240; n++) await delay(250);
      try { await this.stopComponents(); this.state.status = 'stopped'; this.state.error = null; this.state.errorDetail = null; }
      catch (error) { this.failure(error); }
      this.publish(); this.event('manager_stopped', { confirmed: this.state.status === 'stopped' });
      try { if (readJson(this.paths.lock)?.nonce === this.nonce) unlinkSync(this.paths.lock); } catch {}
      this.server?.close(); this.server?.closeAllConnections();
    })();
    return this.shutdownPromise;
  }

  open() {
    const target = `${this.state.setupUrl}#token=${encodeURIComponent(this.token)}`;
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    if (process.platform === 'win32') {
      const browser = spawn(join(systemRoot, 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', target], { windowsHide: true, stdio: 'ignore', detached: true });
      browser.once('error', error => this.event('browser_open_failed', { reason: error.code || 'unknown' })); browser.unref();
    } else this.event('open_requires_windows');
  }

  async readBody(request) {
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 16000) throw new Error('request_too_large'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('invalid_json'); }
  }

  async handle(request, response) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" };
    const json = (status, body, extra = {}) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); response.end(JSON.stringify(body)); };
    const local = request.headers.host === `127.0.0.1:${this.state.managerPort}` && ['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
    if (!local) { json(403, { ok: false, error: 'untrusted_host' }); return; }
    const url = new URL(request.url, this.state.setupUrl);
    if (request.method === 'GET' && ['/setup', '/', '/setup.js'].includes(url.pathname)) {
      response.writeHead(200, { ...headers, 'Content-Type': url.pathname === '/setup.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
      response.end(readFileSync(join(here, url.pathname === '/setup.js' ? 'setup.js' : 'setup.html'))); return;
    }
    const mutation = request.method !== 'GET';
    const denied = requestAllowed(request, this.state.managerPort, this.token, mutation);
    if (denied) { json(403, { ok: false, error: denied }); return; }
    try {
      if (request.method === 'GET' && url.pathname === '/api/status') { json(200, this.state); return; }
      if (url.pathname === '/api/session' && ['GET', 'POST'].includes(request.method)) {
        json(200, { ok: true, csrfToken: this.token }, { 'Set-Cookie': `zhiyu-control=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        json(200, { baseUrl: this.config.model?.baseUrl || '', model: this.config.model?.model || '', hasApiKey: !!this.config.model?.apiKey, components: this.components.publicConfiguration() }); return;
      }
      if (request.method !== 'POST') { json(404, { ok: false, error: 'not_found' }); return; }
      if (url.pathname === '/api/open') { this.open(); json(200, { ok: true }); return; }
      if (url.pathname === '/api/shutdown') { if (this.busy) throw new Error('operation_in_progress'); json(202, { ok: true }); setTimeout(() => void this.shutdown(), 50); return; }
      if (url.pathname === '/api/model-test') { json(200, await this.modelTest(await this.readBody(request))); return; }
      if (url.pathname === '/api/components') { json(200, { ok: true, components: await this.components.saveSelection(await this.readBody(request)) }); return; }
      if (url.pathname === '/api/wechat-init') { json(200, await this.components.initializeWechat(await this.readBody(request))); return; }
      if (url.pathname === '/api/config') await this.saveModel(await this.readBody(request));
      else if (url.pathname === '/api/start') await this.start();
      else if (url.pathname === '/api/stop') await this.stopApplication();
      else if (url.pathname === '/api/pause') await this.pause(true);
      else if (url.pathname === '/api/resume') await this.pause(false);
      else if (url.pathname === '/api/backup') { json(200, { ok: true, path: await this.backup() }); return; }
      else { json(404, { ok: false, error: 'not_found' }); return; }
      json(200, { ok: true, status: this.state.status });
    } catch (error) {
      json(/operation_in_progress|stop_application_before_configuring/.test(error.message) ? 409 : 400, { ok: false, error: redact(error.message, this.secrets()).slice(0, 500) });
    }
  }

  async run() {
    if (!await this.claim()) return false;
    try {
      this.loadConfig();
      this.server = createServer((request, response) => { void this.handle(request, response).catch(error => { this.event('http_handler_failed', { reason: error.message }); if (!response.headersSent) response.writeHead(500); response.end(); }); });
      await new Promise((resolveListen, rejectListen) => { this.server.once('error', rejectListen); this.server.listen(0, '127.0.0.1', resolveListen); });
      this.state.managerPort = this.server.address().port; this.state.setupUrl = `http://127.0.0.1:${this.state.managerPort}/setup`;
      this.state.status = this.config.model ? 'stopped' : 'setup_required'; this.publish();
      process.once('SIGINT', () => void this.shutdown()); process.once('SIGTERM', () => void this.shutdown());
      this.healthTimer = setInterval(() => void this.probe(), 10000);
      if (this.options.open) this.open();
      if (this.config.model && ['running', 'paused'].includes(this.config.desiredStatus)) void this.start().catch(() => {});
      return true;
    } catch (error) { this.failure(error); await this.shutdown(); throw error; }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await new RuntimeManager(parseArguments(process.argv.slice(2))).run(); }
  catch (error) { console.error(JSON.stringify({ event: 'manager_start_failed', error: redact(error.message) })); process.exitCode = 1; }
}
