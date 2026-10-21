import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function cleanupMemoryModuleT7AppData(records) {
  const recordPath = path.resolve(records), root = path.join(recordPath, 'app-data');
  assert.match(recordPath.replaceAll('\\', '/'), /\/\.runtime\/memory-module-t7\/\d{4}-\d\d-\d\dT[^/]+-[a-f0-9-]{36}$/);
  const receipt = JSON.parse(await fs.readFile(path.join(recordPath, 'acceptance.json'), 'utf8'));
  assert.equal(path.resolve(receipt.appDataStorage.path), root); assert.equal(receipt.appDataStorage.scope, 'owned_synthetic_directory');
  const rootStat = await fs.lstat(root); assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  let files = 0, bytes = 0, links = 0;
  async function remove(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.resolve(directory, entry.name); assert.ok(target.startsWith(root + path.sep));
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) { await fs.unlink(target); links++; }
      else if (stat.isDirectory()) { await remove(target); await fs.rmdir(target); }
      else { assert.ok(stat.isFile()); files++; bytes += stat.size; await fs.unlink(target); }
    }
  }
  await remove(root); assert.equal((await fs.readdir(root)).length, 0);
  return { passed: true, filesRemoved: files, bytesRemoved: bytes, linksUnlinked: links, remainingBodyBytes: 0, scope: 'owned_synthetic_directory' };
}
