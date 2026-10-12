import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { RuntimeManager, parseArguments } from './manager.mjs';
import { availablePort, childEnvironment, constantEqual, prepareDataDirectory, redact, requestAllowed, validateModel } from './security.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zhiyu-manager-test-'));
  const installRoot = join(root, 'install'); mkdirSync(installRoot);
  t.after(async () => { if (t.runtimeManager) await t.runtimeManager.shutdown(); assert.ok(root.startsWith(join(tmpdir(), 'zhiyu-manager-test-'))); rmSync(root, { recursive: true, force: true }); });
  return { root, installRoot, dataDir: join(root, 'data') };
}
const sampleConfig = () => ({ ownerId: randomUUID(), databasePassword: 'database-password-private-123456789', authSecret: 'auth-secret-private-12345678901234', encryptionKey: 'encryption-key-private-12345678901', model: { baseUrl: 'https://model.example/v1', apiKey: 'provider-key-private-1234567890123', model: 'test-model' }, desiredStatus: 'paused' });
const fakeRequest = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers: { host: '127.0.0.1:12345', ...headers }, socket: { remoteAddress } });

test('management requires loopback Host, token and mutation Origin/CSRF', () => {
  const token = 'a-private-control-token';
  assert.equal(requestAllowed(fakeRequest(), 12345, token), 'control_token_required');
  assert.equal(requestAllowed(fakeRequest({ 'x-zhiyu-token': token }), 12345, token), null);
  assert.equal(requestAllowed(fakeRequest({ 'x-zhiyu-token': token }), 12345, token, true), 'same_origin_required');
  assert.equal(requestAllowed(fakeRequest({ 'x-zhiyu-token': token, origin: 'http://127.0.0.1:12345' }), 12345, token, true), null);
  assert.equal(requestAllowed(fakeRequest({ cookie: `zhiyu-control=${token}`, origin: 'http://127.0.0.1:12345' }), 12345, token, true), 'csrf_required');
  assert.equal(requestAllowed(fakeRequest({ cookie: `zhiyu-control=${token}`, origin: 'http://127.0.0.1:12345', 'x-zhiyu-csrf': token }), 12345, token, true), null);
  assert.equal(requestAllowed(fakeRequest({ host: 'attacker.example:12345', 'x-zhiyu-token': token }), 12345, token), 'untrusted_host');
  assert.equal(requestAllowed(fakeRequest({ 'x-zhiyu-token': token }, '192.0.2.1'), 12345, token), 'loopback_required');
  assert.equal(requestAllowed(fakeRequest({ 'x-zhiyu-token': token, 'sec-fetch-site': 'cross-site' }), 12345, token), 'cross_site_request');
  assert.equal(constantEqual('a', 'aa'), false);
});

test('model validation forbids insecure external URLs and preserves saved key', () => {
  assert.throws(() => validateModel({ baseUrl: 'http://external.example/v1', model: 'x', apiKey: 'key' }), /requires_https/);
  assert.throws(() => validateModel({ baseUrl: 'https://user:pass@external.example/v1', model: 'x', apiKey: 'key' }), /requires_https/);
  assert.throws(() => validateModel({ baseUrl: 'https://external.example/v1?credential=key', model: 'x', apiKey: 'key' }), /requires_https/);
  assert.throws(() => validateModel({ baseUrl: 'https://external.example/v1', model: 'x\ny', apiKey: 'key' }), /invalid_model_name/);
  assert.equal(validateModel({ baseUrl: 'http://127.0.0.1:11434/v1/', model: 'local', apiKey: '' }, { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'saved-key' }).apiKey, 'saved-key');
  assert.throws(() => validateModel({ baseUrl: 'https://another-provider.example/v1', model: 'x', apiKey: '' }, { baseUrl: 'https://original-provider.example/v1', apiKey: 'old-provider-secret' }), /invalid_model_key/);
});

test('events remove every configured credential and bearer/connection passwords', () => {
  const text = 'my-private-key postgres://someone:password@127.0.0.1/db Authorization: Bearer hiddenvalue API_KEY=anothersecret';
  const result = redact(text, ['my-private-key']);
  for (const value of ['my-private-key', ':password@', 'hiddenvalue', 'anothersecret']) assert.equal(result.includes(value), false);
});

test('runtime env uses private owner/database and never inherits development secrets', () => {
  const config = sampleConfig(), env = childEnvironment('C:\\ZhiyuData', config, 15433, 3516, { OPENAI_API_KEY: 'ambient-secret', POSTGRES_URL: 'postgres://dev/db', QUANT_PAPER_ACCOUNT_ID: randomUUID(), SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Owner' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.QUANT_PAPER_ACCOUNT_ID, undefined);
  assert.equal(env.DEV_USER_ID, config.ownerId); assert.equal(env.ZHIYU_RUNTIME_OWNER_ID, config.ownerId);
  assert.equal(new URL(env.POSTGRES_URL).pathname, '/zhiyu'); assert.equal(new URL(env.ZHIYU_BOOTSTRAP_DB_URL).pathname, '/postgres');
  assert.equal(env.AUTH_MODE, 'local_owner'); assert.equal(env.HOSTNAME, '127.0.0.1');
  assert.equal(env.ZHIYU_OPTIONAL_QUANT_ENABLED, 'false'); assert.equal(env.ZHIYU_RUNTIME_START_PAUSED, '1');
  assert.equal(env.QUANT_TRANSPORT, 'http'); assert.equal(env.QUANT_SERVICE_URL, 'http://127.0.0.1:1'); assert.equal(env.QUANT_INTERNAL_TOKEN, '');
  assert.equal(env.PI_AGENT_PROTOCOL, 'openai-completions'); assert.equal(env.WORKSHOP_PI_MODEL_PROTOCOL, 'openai-completions'); assert.equal(env.LOOP_PI_MODEL_PROTOCOL, 'openai-completions');
  assert.equal(env.USERPROFILE, 'C:\\Users\\Owner'); assert.equal(env.LLM_API_KEY, config.model.apiKey);
});

test('private data cannot overlap installation or adopt unrelated data', t => {
  const options = fixture(t);
  assert.throws(() => prepareDataDirectory(join(options.installRoot, 'data'), options.installRoot), /unsafe_data_directory/);
  const unrelated = join(options.root, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'existing.env'), 'keep');
  assert.throws(() => prepareDataDirectory(unrelated, options.installRoot), /data_directory_not_owned/);
  assert.equal(readFileSync(join(unrelated, 'existing.env'), 'utf8'), 'keep');
});

test('fresh manager remains setup-required; HTTP never exposes model keys or token in state', async t => {
  const manager = new RuntimeManager(fixture(t)); await manager.run();
  t.runtimeManager = manager;
  const base = `http://127.0.0.1:${manager.state.managerPort}`, headers = { 'X-Zhiyu-Token': manager.token };
  assert.equal(manager.state.status, 'setup_required'); assert.equal(manager.children.size, 0);
  assert.equal((await fetch(`${base}/api/status`)).status, 403);
  assert.equal((await fetch(`${base}/api/config`)).status, 403);
  const state = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.equal(state.pid, process.pid); assert.equal(state.components.quant.phase, 'not_installed'); assert.equal(JSON.stringify(state).includes(manager.token), false);
  const post = (path, body, extra = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, Origin: base, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/config', sampleConfig().model, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post('/api/config', { baseUrl: 'https://model.example/v1', model: 'unit-test', apiKey: 'never-expose-private-key' })).status, 200);
  const configuration = await (await fetch(`${base}/api/config`, { headers })).json();
  assert.deepEqual(configuration, { baseUrl: 'https://model.example/v1', model: 'unit-test', hasApiKey: true,
    components: { quantEnabled: false, wechatEnabled: false, wechatReadConsent: false, wechatReaderInitialized: false,
      wechatSendEnabled: false, quantInstalled: false, wechatInstalled: false } });
  assert.equal(readFileSync(manager.paths.state, 'utf8').includes('never-expose-private-key'), false);
  assert.equal(readFileSync(join(manager.dataDir, 'logs', 'manager-events.jsonl'), 'utf8').includes('never-expose-private-key'), false);
  const session = await post('/api/session', {}); assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/stop`, { method: 'POST', headers: { Cookie: cookie, Origin: base } })).status, 403);
  manager.busy = true; assert.equal((await post('/api/shutdown', {})).status, 409); manager.busy = false;
});

test('duplicate invocation reuses live manager without replacing its token', async t => {
  const options = fixture(t), manager = new RuntimeManager(options); await manager.run();
  t.runtimeManager = manager;
  const token = readFileSync(manager.paths.token, 'utf8');
  const duplicate = new RuntimeManager(options); assert.equal(await duplicate.run(), false);
  assert.equal(readFileSync(manager.paths.token, 'utf8'), token);
});

test('missing release component fails visibly and leaves saved data intact', async t => {
  const manager = new RuntimeManager(fixture(t)); manager.loadConfig(); manager.config.model = sampleConfig().model;
  await assert.rejects(manager.start(), /release_component_missing:node/);
  assert.equal(manager.state.status, 'failed'); assert.match(manager.state.error, /release_component_missing/);
  assert.equal(manager.children.size, 0); assert.equal(existsSync(manager.paths.config), true);
});

test('cold backup preserves private data and clearly declares credentials', async t => {
  const manager = new RuntimeManager(fixture(t)); manager.loadConfig();
  mkdirSync(manager.paths.pg); writeFileSync(join(manager.paths.pg, 'PG_VERSION'), '17\n');
  manager.command = async () => { throw new Error('database_existing_status_exit_3'); };
  writeFileSync(join(manager.dataDir, 'app-data', 'sample.txt'), 'private-user-data');
  const target = await manager.backup();
  assert.equal(readFileSync(join(target, 'app-data', 'sample.txt'), 'utf8'), 'private-user-data');
  const metadata = JSON.parse(readFileSync(join(target, 'backup.json'), 'utf8'));
  assert.equal(metadata.containsCredentials, true); assert.equal(metadata.kind, 'cold-private-install-copy'); assert.equal(metadata.postgresMajor, '17');
  assert.equal(manager.state.status, 'stopped'); assert.equal(readdirSync(join(manager.dataDir, 'backups')).length, 1);
});

test('backup verifies and stops an orphaned private cluster before declaring a cold copy', async t => {
  const manager = new RuntimeManager(fixture(t)); manager.loadConfig();
  mkdirSync(manager.paths.pg); writeFileSync(join(manager.paths.pg, 'PG_VERSION'), '17\n');
  assert.equal(manager.databaseStarted, undefined);
  const calls = [];
  manager.command = async (_exe, args, options) => { calls.push({ args, label: options.label }); return ''; };
  const target = await manager.backup();
  assert.deepEqual(calls.map(call => call.label), ['database_existing_status', 'database_stop']);
  assert.equal(calls[0].args[1], manager.paths.pg); assert.equal(calls[1].args[1], manager.paths.pg);
  assert.equal(manager.databaseStarted, false); assert.ok(manager.databaseStoppedAt); assert.equal(existsSync(join(target, 'backup.json')), true);
});

test('failed private cluster stop blocks backup instead of copying live database files', async t => {
  const manager = new RuntimeManager(fixture(t)); manager.loadConfig();
  mkdirSync(manager.paths.pg); writeFileSync(join(manager.paths.pg, 'PG_VERSION'), '17\n');
  manager.command = async (_exe, _args, options) => { if (options.label === 'database_stop') throw new Error('database_stop_timeout'); return ''; };
  await assert.rejects(manager.backup(), /database_stop_timeout/);
  assert.equal(manager.state.status, 'failed'); assert.equal(manager.state.components.database.phase, 'stop_unconfirmed');
  assert.equal(readdirSync(join(manager.dataDir, 'backups')).length, 0);
});

test('worker health is derived from fresh database heartbeat and module failures', async t => {
  const manager = new RuntimeManager(fixture(t)); manager.loadConfig(); manager.databaseStarted = true; manager.state.status = 'running';
  manager.command = async (_exe, _args, options) => { options.inspect(JSON.stringify({ event: 'runtime_status', status: { online: true, last_heartbeat_at: new Date().toISOString(), lease_until: new Date(Date.now() + 10000).toISOString(), desired_status: 'running', modules: [{ name: 'loop-execution', phase: 'error', lastError: 'loop_execution_failed', lastStartedAt: Date.now(), nextRunAt: Date.now() + 10000 }] } })); };
  await manager.probe(); assert.equal(manager.state.status, 'degraded'); assert.equal(manager.state.components.worker.phase, 'degraded');
  assert.ok(manager.state.components.worker.modules[0].lastRunAt);
  manager.command = async (_exe, _args, options) => { options.inspect(JSON.stringify({ event: 'runtime_status', status: { online: true, last_heartbeat_at: new Date(Date.now() - 30000).toISOString(), desired_status: 'running', modules: [] } })); };
  await manager.probe(); assert.equal(manager.state.components.worker.phase, 'unresponsive'); assert.equal(manager.state.status, 'degraded');
});

test('paused intent reaches initial worker env, and explicit stop makes the next start running', async t => {
  const manager = new RuntimeManager(fixture(t)); manager.loadConfig();
  manager.paused = true; manager.config.desiredStatus = 'stopped';
  assert.equal(manager.environment().ZHIYU_RUNTIME_START_PAUSED, '1');
  assert.equal(manager.environment().ZHIYU_RESOURCE_DIR, join(manager.options.installRoot, 'app'));
  await manager.stopApplication();
  assert.equal(manager.paused, false); assert.equal(manager.environment().ZHIYU_RUNTIME_START_PAUSED, '0');
});

test('model check reads models only and preserves its evidence only for matching saved settings', async t => {
  const manager = new RuntimeManager(fixture(t)); manager.loadConfig();
  const calls = [];
  const provider = createServer((request, response) => { calls.push({ path: request.url, authorization: request.headers.authorization }); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'test-model' }] })); });
  await new Promise(resolveListen => provider.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose)); });
  const model = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'test-model', apiKey: 'model-check-private-secret' };
  const result = await manager.modelTest(model);
  assert.equal(result.ok, true); assert.equal(result.modelListed, true); assert.equal(manager.state.components.model.phase, 'not_configured');
  await manager.saveModel(model); assert.equal(manager.config.modelTest.at, result.at);
  await manager.saveModel({ ...model, model: 'different-model' }); assert.equal(manager.config.modelTest, null);
  assert.deepEqual(calls, [{ path: '/v1/models', authorization: 'Bearer model-check-private-secret' }]);
  assert.equal(readFileSync(join(manager.dataDir, 'logs', 'manager-events.jsonl'), 'utf8').includes(model.apiKey), false);
});

test('argument parser accepts explicit isolated paths and rejects unknown flags', () => {
  assert.equal(parseArguments(['--install-root', 'C:\\Install', '--data-dir', 'C:\\Data', '--open']).open, true);
  assert.throws(() => parseArguments(['--development-db']), /unknown_manager_argument/);
});

test('migration stderr exposes only stable stage and validated SQLSTATE in manager failure', async t => {
  const manager = new RuntimeManager(fixture(t)); manager.loadConfig();
  const script = "console.error(JSON.stringify({event:'migration_failed',code:'migration_extension_failed',stage:'vector_setup',driverCode:'58P01'}));process.exitCode=1;";
  const error = await manager.command(process.execPath, ['-e', script], { label: 'database_migrate' }).then(() => null, error => error);
  assert.equal(error.message, 'migration_extension_failed'); assert.equal(error.stage, 'vector_setup'); assert.equal(error.driverCode, '58P01');
  manager.failure(error); assert.deepEqual(manager.state.errorDetail, { stage: 'vector_setup', driverCode: '58P01' });
});

test('managed web host confirms its own loopback socket over IPC and exits with its parent', async t => {
  const options = fixture(t), entry = join(options.root, 'fake-server.mjs'), port = await availablePort();
  writeFileSync(entry, "import {createServer} from 'node:http';createServer((_req,res)=>res.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');", 'utf8');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./web-host.mjs', import.meta.url)), entry], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const event = await new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => rejectEvent(new Error('web_listening_timeout')), 5000);
    child.once('error', error => { clearTimeout(timer); rejectEvent(error); });
    child.on('message', message => { if (message.event === 'web_listening') { clearTimeout(timer); resolveEvent(message); } });
  });
  assert.equal(event.pid, child.pid); assert.equal(event.port, port);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ok');
  const exited = new Promise(resolveExit => child.once('exit', resolveExit)); child.disconnect(); await exited;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
