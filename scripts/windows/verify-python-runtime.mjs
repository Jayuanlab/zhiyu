import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, within } from './release-lib.mjs';

const receiptName = 'zhiyu-python-receipt.json';
const forbiddenPart = name => ['__pycache__', '.venv', '.git', '.env'].includes(name) || /^\.env\./.test(name) || /\.(?:pyc|pyo)$/i.test(name);

/** Read-only verification, required before cache reuse and after stage copy.
 * This is independent of the payload build recipe: adding verification must not
 * cause a valid, hash-pinned interpreter and 83 wheels to be rebuilt.
 */
export async function verifyPythonRuntime({ runtimeRoot } = {}) {
  if (typeof runtimeRoot !== 'string' || !isAbsolute(runtimeRoot)) throw new Error('python_verify_absolute_runtime_required');
  const root = await realpath(runtimeRoot);
  const receiptPath = join(root, receiptName);
  const receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw new Error('python_verify_receipt_not_regular');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.files) || !receipt.files.length) throw new Error('python_verify_receipt_invalid');
  const expected = new Map([[receiptName, null]]);
  const folded = new Set([receiptName.toLowerCase()]);
  for (const file of receipt.files) {
    if (!file || typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.includes(':')
      || isAbsolute(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..' || forbiddenPart(part))
      || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256 || '')) throw new Error('python_verify_file_record_invalid');
    if (folded.has(file.path.toLowerCase())) throw new Error('python_verify_file_record_duplicate');
    folded.add(file.path.toLowerCase()); expected.set(file.path, file);
  }
  const actual = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`python_verify_symlink_forbidden:${name}`);
      if (forbiddenPart(entry.name)) throw new Error(`python_verify_cache_or_private_file_forbidden:${name}`);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) actual.set(name, info.size);
      else throw new Error(`python_verify_nonregular_file:${name}`);
    }
  }
  await walk(root);
  const extra = [...actual.keys()].filter(name => !expected.has(name));
  const missing = [...expected.keys()].filter(name => !actual.has(name));
  if (extra.length || missing.length) throw new Error(`python_verify_file_set_mismatch:${JSON.stringify({ extra: extra.slice(0, 10), missing: missing.slice(0, 10), extraCount: extra.length, missingCount: missing.length })}`);
  const sorted = [...expected.keys()].sort();
  for (const name of sorted) {
    const file = expected.get(name);
    if (!file) continue;
    if (actual.get(name) !== file.size || await sha256(join(root, name), file.size) !== file.sha256) throw new Error(`python_verify_payload_hash_mismatch:${name}`);
  }
  // Recheck the set after hashing too; an accidental concurrent smoke must not
  // introduce unreceipted bytecode while the tree is being verified.
  const before = new Map(actual); actual.clear(); await walk(root);
  if (actual.size !== before.size || [...actual].some(([name, size]) => before.get(name) !== size)) throw new Error('python_verify_file_set_changed_during_hashing');
  return { event: 'python_runtime_verified', ok: true, pythonVersion: receipt.python?.version,
    lockSha256: receipt.lockSha256, recipeSha256: receipt.recipeSha256,
    payloadFiles: receipt.files.length, totalFiles: actual.size,
    bytes: [...actual.values()].reduce((total, size) => total + size, 0), packages: receipt.packages?.length || 0,
    fileSetSha256: createHash('sha256').update(sorted.join('\n') + '\n').digest('hex'),
    extraFiles: 0, missingFiles: 0, symlinks: 0, bytecodeOrCache: 0, verifiedAt: new Date().toISOString() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let runtimeRoot, reportPath;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--runtime-root' && process.argv[i + 1]) runtimeRoot = process.argv[++i];
    else if (process.argv[i] === '--report' && process.argv[i + 1]) reportPath = process.argv[++i];
    else throw new Error('python_verify_unknown_argument');
  }
  const report = await verifyPythonRuntime({ runtimeRoot });
  if (reportPath) {
    if (!isAbsolute(reportPath) || within(await realpath(runtimeRoot), reportPath)) throw new Error('python_verify_report_must_be_outside_runtime');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report));
}
