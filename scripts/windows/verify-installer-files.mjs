import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const innoFile = /^unins\d+\.(?:exe|dat|msg)$/i;
const requiredFiles = ['Zhiyu.exe', 'runtime/manager.mjs', 'runtime/setup.html',
  'vendor/node/node.exe', 'vendor/postgres/bin/postgres.exe', 'vendor/postgres/lib/vector.dll',
  'app/apps/web/server.js', 'worker/start-runtime-worker.mjs', 'migrations/migrate.mjs'];
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (left, right) => key(resolve(left)) === key(resolve(right));
function under(root, path) {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function safeName(name) {
  return typeof name === 'string' && name.length > 0 && !/[\\:\x00-\x1f]/.test(name) &&
    !isAbsolute(name) && name.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}
async function digest(path, size) {
  if (size !== undefined && size < 4 * 1024 * 1024) return createHash('sha256').update(await readFile(path)).digest('hex');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function batches(items, task, report) {
  for (let offset = 0; offset < items.length; offset += 32) {
    await Promise.all(items.slice(offset, offset + 32).map(task));
    const completed = Math.min(offset + 32, items.length);
    if (completed % 4096 === 0 || completed === items.length) {
      console.log(JSON.stringify({ mode: report.mode, completed, total: items.length, errors: report.errors.length }));
    }
  }
}
async function enumerate(root, report) {
  const actual = new Map();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!samePath(await realpath(directory), directory)) {
      report.errors.push({ path: relative(root, directory) || '.', reason: 'redirected_directory' });
      continue;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      if (!under(root, path) || !safeName(name)) { report.errors.push({ path: name, reason: 'unsafe_installed_path' }); continue; }
      if (entry.isSymbolicLink()) { report.errors.push({ path: name, reason: 'installed_link' }); continue; }
      if (entry.isDirectory()) { pending.push(path); continue; }
      if (!entry.isFile()) { report.errors.push({ path: name, reason: 'non_regular_file' }); continue; }
      if (actual.has(key(name))) { report.errors.push({ path: name, reason: 'duplicate_installed_path' }); continue; }
      actual.set(key(name), { name, path });
    }
  }
  return actual;
}

// Read-only with respect to the payload and manifest: only the caller's JSON
// receipt is written. No application entry point, model, database or env file.
export async function verifyInstallerFiles({ appRoot, manifestPath, reportPath, mode = 'installed' }) {
  if (!['installed', 'removed'].includes(mode)) throw new Error('invalid_verification_mode');
  appRoot = resolve(appRoot);
  manifestPath = resolve(manifestPath);
  reportPath = resolve(reportPath);
  if (samePath(reportPath, manifestPath) || under(appRoot, reportPath) || samePath(appRoot, reportPath)) throw new Error('receipt_must_be_outside_payload');
  const report = { schemaVersion: 1, mode, appRoot, manifestPath, concurrency: 32, verifierPid: process.pid,
    startedAt: new Date().toISOString(), passed: false, expectedFiles: 0, checkedFiles: 0,
    checkedBytes: 0, allowedInnoFiles: [], errors: [] };
  const began = Date.now();
  try {
    const sourceBytes = await readFile(manifestPath);
    const manifest = JSON.parse(sourceBytes.toString('utf8'));
    if (manifest.schemaVersion !== 1 || manifest.product !== 'Zhiyu' || manifest.platform !== 'win32-x64' || !Array.isArray(manifest.files)) throw new Error('unexpected_reference_manifest');
    report.version = manifest.version;
    report.referenceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const expected = new Map();
    for (const item of manifest.files) {
      if (!safeName(item.path) || expected.has(key(item.path)) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error('unsafe_or_duplicate_manifest_entry');
      const path = resolve(appRoot, ...item.path.split('/'));
      if (!under(appRoot, path)) throw new Error('manifest_path_escaped_payload');
      expected.set(key(item.path), { ...item, absolutePath: path });
    }
    for (const name of requiredFiles) if (!expected.has(key(name))) throw new Error(`full_manifest_missing:${name}`);
    report.expectedFiles = expected.size;
    let actual = new Map();
    try {
      const rootStat = await lstat(appRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid_payload_root');
      actual = await enumerate(appRoot, report);
    } catch (error) {
      if (!(mode === 'removed' && error.code === 'ENOENT')) throw error;
    }
    report.actualFiles = actual.size;
    for (const item of actual.values()) {
      if (item.name === 'release-manifest.json' || expected.has(key(item.name))) continue;
      // Only root-level Inno bookkeeping is exempt; nested unins* files fail.
      if (innoFile.test(item.name)) report.allowedInnoFiles.push(item.name);
      else report.errors.push({ path: item.name, reason: 'unexpected_installed_file' });
    }
    if (mode === 'installed') {
      const installedManifest = actual.get(key('release-manifest.json'));
      if (!installedManifest || await digest(installedManifest.path) !== report.referenceSha256) report.errors.push({ path: 'release-manifest.json', reason: 'manifest_reference_mismatch' });
      await batches([...expected.values()], async item => {
        const found = actual.get(key(item.path));
        if (!found) { report.errors.push({ path: item.path, reason: 'missing_file' }); return; }
        try {
          const info = await lstat(found.path);
          if (!info.isFile() || info.isSymbolicLink()) { report.errors.push({ path: item.path, reason: 'non_regular_file' }); return; }
          if (info.size !== item.size) { report.errors.push({ path: item.path, reason: 'size_mismatch', expected: item.size, actual: info.size }); return; }
          const hash = await digest(found.path, info.size);
          if (hash !== item.sha256.toLowerCase()) { report.errors.push({ path: item.path, reason: 'hash_mismatch', expected: item.sha256, actual: hash }); return; }
          report.checkedFiles++;
          report.checkedBytes += info.size;
        } catch (error) { report.errors.push({ path: item.path, reason: 'file_read_failed', code: error.code || 'UNKNOWN' }); }
      }, report);
    } else {
      // Check every manifest path after uninstallation. The caller runs its
      // copied vendor Node so no installed binary is held open during removal.
      await batches([...expected.values()], async item => {
        try {
          await lstat(item.absolutePath);
          report.errors.push({ path: item.path, reason: 'release_file_left_after_uninstall' });
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') report.checkedFiles++;
          else report.errors.push({ path: item.path, reason: 'absence_unconfirmed', code: error.code || 'UNKNOWN' });
        }
      }, report);
      if (actual.has(key('release-manifest.json'))) report.errors.push({ path: 'release-manifest.json', reason: 'manifest_left_after_uninstall' });
    }
    report.passed = report.errors.length === 0 && report.checkedFiles === report.expectedFiles;
  } catch (error) {
    report.errors.push({ reason: 'verification_failed', detail: error.message });
  } finally {
    report.completedAt = new Date().toISOString();
    report.elapsedSeconds = (Date.now() - began) / 1000;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({ passed: report.passed, mode, expectedFiles: report.expectedFiles,
    checkedFiles: report.checkedFiles, errors: report.errors.length, elapsedSeconds: report.elapsedSeconds, reportPath }));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--app-root', '--manifest', '--report', '--mode'].includes(name) || !value || args.has(name)) throw new Error('invalid_verifier_arguments');
    args.set(name, value);
  }
  for (const name of ['--app-root', '--manifest', '--report', '--mode']) if (!args.has(name)) throw new Error(`missing_verifier_argument:${name}`);
  const report = await verifyInstallerFiles({ appRoot: args.get('--app-root'), manifestPath: args.get('--manifest'), reportPath: args.get('--report'), mode: args.get('--mode') });
  process.exitCode = report.passed ? 0 : 1;
}
