import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '../..');
const base = path.join(root, '.runtime/evals/platform-memory-real-100');
const folder = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).folder;
const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(folder, 'cases.json'), 'utf8'));
const identity = await fetch('http://127.0.0.1:3515/api/identity', { signal: AbortSignal.timeout(10000) }).then(r => r.json());
if (identity.actorId !== manifest.ownerId) throw Error('Evaluation owner no longer matches current identity');
const runArg = process.argv.find(v => v.startsWith('--run='))?.slice(6);
const runFolder = runArg ? path.resolve(runArg) : path.join(folder, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
if (!runFolder.startsWith(folder + path.sep)) throw Error('Run output must be inside selected snapshot');
fs.mkdirSync(runFolder, { recursive: true });
const limit = Number(process.argv.find(v => v.startsWith('--limit='))?.slice(8) ?? 100);
const selected = cases.slice(0, limit);
fs.writeFileSync(path.join(base, 'latest-run.json'), JSON.stringify({ folder, runFolder }, null, 2));
const run = { startedAt: new Date().toISOString(), folder, runFolder, caseCount: selected.length,
  track: 'live Brain service plus tool-free answer harness; not full Chat UI or action execution',
  concurrency: 3, timeoutMs: 150000, goldInjected: false, corpusImported: false,
  sideEffects: 'normal Brain recall audit logs only',
  sourceHashes: Object.fromEntries(['lib/brain/service.ts','lib/brain/recall-planner.ts','lib/brain/query-retry.ts'].map(file =>
    [file, createHash('sha256').update(fs.readFileSync(path.join(web, file))).digest('hex')])) };
fs.writeFileSync(path.join(runFolder, 'run.json'), JSON.stringify(run, null, 2));
let next = 0, done = 0;
async function execute(c) {
  const output = path.join(runFolder, `${c.id}.json`);
  if (fs.existsSync(output) && JSON.parse(fs.readFileSync(output, 'utf8')).status === 'completed') { done++; return; }
  await new Promise(resolve => {
    const log = fs.openSync(path.join(runFolder, `${c.id}.log`), 'w');
    const child = spawn(process.execPath, ['--import','tsx','--conditions=react-server','scripts/run-real-memory-eval-worker.mjs',folder,output,c.id],
      { cwd: web, windowsHide: true, stdio: ['ignore', log, log] });
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, run.timeoutMs);
    child.on('error', error => { clearTimeout(timer); fs.closeSync(log); throw error; });
    child.on('exit', code => {
      clearTimeout(timer); fs.closeSync(log);
      let value = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { id: c.id };
      if (expired || !['completed','answer_failed','recall_failed'].includes(value.status)) {
        value = { ...value, status: expired ? 'timeout' : 'worker_failed', exitCode: code };
        fs.writeFileSync(output, JSON.stringify(value, null, 2));
      }
      done++;
      console.log(JSON.stringify({ completed: done, total: selected.length, id: c.id, status: value.status, recalled: value.recall?.items?.length ?? 0, ms: value.totalMs }));
      resolve();
    });
  });
}
await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
  while (next < selected.length) await execute(selected[next++]);
}));
console.log(JSON.stringify({ finished: true, runFolder }));
