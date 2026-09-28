const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { health, launchService } = require('../local-service-process.cjs');
const fixture = path.join(__dirname, 'local-service-fixture.cjs');
const valid = body => body.service === 'quant-service' && body.ok === true;
function kill(pid) {
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill(-pid, 'SIGKILL');
}
function setup(mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyu_test_deps_'));
  const ready = path.join(directory, 'ready.json');
  const options = { name: 'fixture', command: process.execPath, args: [fixture, mode, ready], cwd: directory,
    logDirectory: directory, timeoutMs: 2500, pollMs: 30,
    checkHealth: async () => fs.existsSync(ready) && health(`http://127.0.0.1:${JSON.parse(fs.readFileSync(ready)).port}/health`, valid, 100) };
  const remove = () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('zhiyu_test_deps_'));
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { directory, options, remove };
}
test('healthy child persists startup identity and logs', async () => {
  const item = setup('healthy'); let launched;
  try {
    launched = await launchService(item.options);
    assert.equal(launched.phase, 'ready');
    assert.ok(fs.readFileSync(launched.logPath, 'utf8').includes('fixture started'));
    const state = JSON.parse(fs.readFileSync(launched.statePath));
    assert.equal(state.pid, launched.pid); assert.equal(state.instanceId, launched.instanceId);
    process.kill(launched.pid, 0);
  } finally { if (launched) kill(launched.pid); item.remove(); }
});
test('startup exit retains stderr and reports failure rather than waiting for timeout', async () => {
  const item = setup('exit');
  try {
    await assert.rejects(launchService(item.options), /process_exited_7/);
    const state = JSON.parse(fs.readFileSync(path.join(item.directory, fs.readdirSync(item.directory).find(name => name.endsWith('.json')))));
    assert.equal(state.phase, 'failed');
    assert.match(fs.readFileSync(state.logPath, 'utf8'), /fixture startup failure/);
  } finally { item.remove(); }
});
test('hung health times out, terminates only the owned process, and records failure', async () => {
  const item = setup('hang');
  try {
    await assert.rejects(launchService({ ...item.options, timeoutMs: 600 }), /health_timeout/);
    const name = fs.readdirSync(item.directory).find(name => name.startsWith('fixture-') && name.endsWith('.json'));
    const state = JSON.parse(fs.readFileSync(path.join(item.directory, name)));
    assert.equal(state.phase, 'failed'); assert.equal(state.reason, 'health_timeout');
    assert.throws(() => process.kill(state.pid, 0));
  } finally { item.remove(); }
});
test('missing executable is a recorded spawn failure', async () => {
  const item = setup('healthy');
  try { await assert.rejects(launchService({ ...item.options, command: path.join(item.directory, 'missing.exe') }), /spawn_failed/); }
  finally { item.remove(); }
});
test('stop during startup terminates the owned child and removes temporary signal handlers', async () => {
  const item = setup('hang'); const listeners = process.listenerCount('SIGTERM');
  let sent = false;
  try {
    await assert.rejects(launchService({ ...item.options, checkHealth: async () => {
      if (!sent && fs.existsSync(path.join(item.directory, 'ready.json'))) { sent = true; process.emit('SIGTERM'); }
      return false;
    } }), error => error.code === 'startup_interrupted' && error.phase === 'failed');
    assert.equal(sent, true);
    const name = fs.readdirSync(item.directory).find(name => name.startsWith('fixture-') && name.endsWith('.json'));
    const state = JSON.parse(fs.readFileSync(path.join(item.directory, name)));
    assert.equal(state.phase, 'failed'); assert.throws(() => process.kill(state.pid, 0));
    assert.equal(process.listenerCount('SIGTERM'), listeners);
  } finally { item.remove(); }
});
test('unrelated HTTP listener fails identity validation and remains untouched', async () => {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, service: 'other-service' })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await health(url, valid), false);
    assert.equal((await fetch(url)).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
