const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function health(url, validate, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    return response.ok && validate(await response.json());
  } catch { return false; }
}

// Dependencies outlive the launcher and may be reused. A failed launch only stops its own child.
async function launchService({ name, command, args, cwd, env = process.env, logDirectory, checkHealth, timeoutMs, pollMs = 250 }) {
  fs.mkdirSync(logDirectory, { recursive: true });
  const instanceId = randomUUID();
  const base = path.join(logDirectory, `${name}-${instanceId}`);
  const logPath = `${base}.log`, statePath = `${base}.json`;
  const descriptor = fs.openSync(logPath, 'a');
  const state = { name, instanceId, pid: null, phase: 'starting', startedAt: new Date().toISOString(), logPath };
  const record = () => fs.writeFileSync(statePath, JSON.stringify({ ...state, observedAt: new Date().toISOString(), note: 'Startup observation only; use service health for current status.' }, null, 2));
  let child, exited = false, exitCode, spawnError, interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    child = spawn(command, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', descriptor, descriptor] });
    child.once('error', error => { spawnError = error; exited = true; });
    child.once('exit', code => { exited = true; exitCode = code; });
    state.pid = child.pid ?? null;
    record();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (interrupted) throw Error('startup_interrupted');
      if (exited) throw Error(spawnError ? 'spawn_failed' : `process_exited_${exitCode}`);
      if (await checkHealth()) {
        // Check exit again: an unrelated listener must not mask an immediately failed child.
        if (exited) throw Error('process_exited_during_health_check');
        if (interrupted) throw Error('startup_interrupted');
        state.phase = 'ready'; record(); child.unref();
        return { ...state, statePath };
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw Error('health_timeout');
  } catch (error) {
    if (child?.pid && !exited) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
      // Keep the handle until the owned process really exits; do not claim it was stopped from a signal alone.
      await new Promise(resolve => {
        if (exited) return resolve();
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    state.phase = child?.pid && !exited ? 'stop_unconfirmed' : 'failed'; state.reason = error.message; record();
    if (state.phase === 'stop_unconfirmed') child.unref();
    throw Object.assign(Error(`${name}: ${error.message}; log: ${logPath}; startup record: ${statePath}`), { code: error.message, phase: state.phase });
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    fs.closeSync(descriptor);
  }
}

module.exports = { health, launchService };
