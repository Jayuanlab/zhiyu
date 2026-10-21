import { mkdirSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export class BuildRetentionError extends Error {
  constructor(receipt) { super(receipt.error ?? 'Build output retention did not converge'); this.name = 'BuildRetentionError'; this.receipt = receipt; }
}
export function applyBuildRetention({ workspaceRoot = defaultRoot, action = 'prune', outputPath, outputPaths, currentPayload, leaseId, outcome, label = 'explicit-retention' } = {}) {
  const root = path.resolve(workspaceRoot);
  if (process.platform !== 'win32') throw new Error('build_retention_windows_safe_executor_required');
  const requests = path.join(root, '.runtime/build-retention/requests');
  for (let parent = requests; ; parent = path.dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('build_retention_metadata_reparse_refused');
    if (parent === path.dirname(parent)) break;
  }
  mkdirSync(requests, { recursive: true });
  const file = path.join(requests, randomUUID() + '.json');
  writeFileSync(file, JSON.stringify({ workspaceRoot: root, action, outputPath, outputPaths, currentPayload, leaseId, outcome, label, ownerPid: process.pid }), { flag: 'wx', encoding: 'utf8' });
  const child = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(defaultRoot, 'scripts/windows/build-retention.ps1'), '-RequestFile', file],
    { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (child.error) throw child.error;
  let receipt;
  try { receipt = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)); }
  catch { throw new Error('build_retention_receipt_unavailable: ' + child.stderr.trim().slice(0, 500)); }
  if (child.status !== 0 || !receipt.passed) throw new BuildRetentionError(receipt);
  return receipt;
}
export function reserveBuildOutput(input) {
  const receipt = applyBuildRetention({ ...input, action: 'reserve' }); let finished = false;
  return { receipt, finish(outcome = 'completed') {
    if (finished) return;
    const completed = applyBuildRetention({ workspaceRoot: input?.workspaceRoot, action: 'finish', leaseId: receipt.leaseId, outcome, label: input?.label });
    finished = true; return completed;
  } };
}
export async function withBuildRetention(input, work) {
  const lease = reserveBuildOutput(input); let outcome = 'failed'; let workError;
  try { const result = await work(lease); outcome = 'completed'; return result; }
  catch (error) { workError = error; throw error; }
  finally {
    try { const receipt = lease.finish(outcome); console.log(JSON.stringify({ event: 'build_retention_finished', outcome, receipt: receipt?.receiptPath })); }
    catch (error) { if (workError) throw new AggregateError([workError, error], 'Build and retention both failed'); throw error; }
  }
}
// This repository's safe destructive executor is Windows-specific. Other hosts
// retain their existing build behavior and expose the missing enforcement.
export async function withHostBuildRetention(input, work) {
  if (process.platform === 'win32') return withBuildRetention(input, work);
  console.warn(JSON.stringify({ event: 'build_retention_not_enforced', platform: process.platform, reason: 'windows_executor_only' }));
  return work({ receipt: { status: 'not_enforced', platform: process.platform } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(value => !['--inventory', '--prune'].includes(value))) throw new Error('Only --inventory or --prune is supported; build outputs are registered by host wrappers');
  try { console.log(JSON.stringify(applyBuildRetention({ action: args.includes('--inventory') ? 'inventory' : 'prune' }))); }
  catch (error) { console.error(JSON.stringify(error instanceof BuildRetentionError ? error.receipt : { passed: false, error: error.message })); process.exitCode = 2; }
}
