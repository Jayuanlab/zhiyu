import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { artifactDigest } from '../artifacts/policy';
import { MemoryModuleError } from '../kernel/errors';

const unavailable = () => new MemoryModuleError('file_source_unavailable', 409,
  'The selected task file changed, is linked, or is outside its managed directory; select and import a fresh regular file');
function contained(root: string, target: string) {
  const path = relative(root, target);
  return !!path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}
function segments(path: string) {
  const parts = path.split(/[\\/]/);
  if (!path || isAbsolute(path) || /^[a-z]:/i.test(path) || parts.some(part => !part || part === '.' || part === '..'
    || /[\u0000-\u001f\u007f:]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw unavailable();
  return parts;
}

/** The owner service chooses root from a real owned Chat, never from workDir.
 * No symlinks, junctions, hardlinks or device files may become imported bytes. */
export async function readLocalFileSnapshot(root: string, path: string, maximumBytes: number, managedAnchor = root) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw unavailable();
  const parts = segments(path), base = resolve(root), target = join(base, ...parts);
  if (!contained(base, target)) throw unavailable();
  const inspect = async () => {
    const anchor = resolve(managedAnchor), rootParts = relative(anchor, base);
    if (anchor !== base && !contained(anchor, base)) throw unavailable();
    let ancestor = anchor;
    for (const part of ['', ...rootParts.split(sep).filter(Boolean)]) {
      if (part) ancestor = join(ancestor, part);
      const info = await lstat(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    }
    const rootInfo = await lstat(base);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unavailable();
    const realRoot = await realpath(base);
    let current = base;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
        || !contained(realRoot, await realpath(current))) throw unavailable();
    }
    const info = await lstat(target);
    if (!info.size || info.size > maximumBytes) throw unavailable();
    return info;
  };
  try {
    const before = await inspect(), handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw unavailable();
      const buffer = Buffer.alloc(opened.size + 1); let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat(), final = await inspect();
      if (length !== opened.size || length > maximumBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs || final.dev !== after.dev || final.ino !== after.ino
        || final.size !== after.size || final.mtimeMs !== after.mtimeMs || final.ctimeMs !== after.ctimeMs) throw unavailable();
      const bytes = new Uint8Array(buffer.subarray(0, length));
      return { bytes, sha256: artifactDigest(bytes), name: basename(target), relativePath: parts.join('/'),
        stat: { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs },
        semantics: 'owner_confirmed_imported_snapshot' as const };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof MemoryModuleError) throw error;
    throw unavailable();
  }
}
