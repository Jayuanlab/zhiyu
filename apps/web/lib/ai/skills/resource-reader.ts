import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';

export const MAX_SKILL_REFERENCE_BYTES = 64 * 1024;

function isContained(root: string, target: string) {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Reads only Markdown references of an already authorized, resolved skill. */
export async function readSkillReference(skillPath: string, resource: string) {
  const parts = resource.split('/');
  if (
    isAbsolute(resource) || win32.isAbsolute(resource) ||
    /[\\\x00-\x1f\x7f:<>"|?*]/.test(resource) ||
    parts.length < 2 || parts[0] !== 'references' ||
    parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
    !/\.md$/i.test(resource)
  ) {
    throw new Error('Skill resource must be a relative .md file inside references/');
  }

  const skillRoot = await realpath(skillPath);
  const referencesRoot = await realpath(join(skillRoot, 'references'));
  if (!isContained(skillRoot, referencesRoot)) {
    throw new Error('Skill references directory escapes the assigned skill');
  }
  const sourcePath = await realpath(join(skillRoot, ...parts));
  if (!isContained(referencesRoot, sourcePath)) {
    throw new Error('Skill resource escapes the assigned references directory');
  }

  const file = await open(sourcePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Skill resource must be a regular file');
    if (stat.size > MAX_SKILL_REFERENCE_BYTES) {
      throw new Error(`Skill resource exceeds ${MAX_SKILL_REFERENCE_BYTES} bytes; no content was loaded`);
    }
    // The extra byte detects files that grow after stat without an unbounded read.
    const buffer = Buffer.alloc(MAX_SKILL_REFERENCE_BYTES + 1);
    let byteLength = 0;
    while (byteLength < buffer.length) {
      const { bytesRead } = await file.read(buffer, byteLength, buffer.length - byteLength, null);
      if (!bytesRead) break;
      byteLength += bytesRead;
    }
    if (byteLength > MAX_SKILL_REFERENCE_BYTES) {
      throw new Error(`Skill resource exceeds ${MAX_SKILL_REFERENCE_BYTES} bytes; no content was loaded`);
    }
    const bytes = buffer.subarray(0, byteLength);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      content,
      sourcePath,
      resource,
      byteLength,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await file.close();
  }
}
