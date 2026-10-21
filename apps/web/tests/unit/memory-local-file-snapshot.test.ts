import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readLocalFileSnapshot } from '@/lib/memory/files/local-snapshot';

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'zhiyu-t7-file-')); roots.push(root); return root; }
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('zhiyu-t7-file-')) throw Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
describe('owner task file snapshot IO', () => {
  it('imports only a bounded exact regular-file snapshot', async () => {
    const root = await fixture(); await mkdir(join(root, 'output')); await writeFile(join(root, 'output', 'note.txt'), 'snapshot \u6d4b\u8bd5\ud83d\ude80');
    const result = await readLocalFileSnapshot(root, 'output/note.txt', 64);
    expect(new TextDecoder().decode(result.bytes)).toBe('snapshot \u6d4b\u8bd5\ud83d\ude80');
    expect(result).toMatchObject({ relativePath: 'output/note.txt', name: 'note.txt', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), semantics: 'owner_confirmed_imported_snapshot' });
    await writeFile(join(root, 'output', 'note.txt'), 'changed');
    expect((await readLocalFileSnapshot(root, 'output/note.txt', 64)).sha256).not.toBe(result.sha256);
    await expect(readLocalFileSnapshot(root, 'output/note.txt', 3)).rejects.toMatchObject({ code: 'file_source_unavailable' });
  });
  it.each(['../outside.txt', '/outside.txt', 'C:\\outside.txt', 'output/../secret.txt', 'note.txt:secret', 'CON.txt', 'output//note.txt'])('rejects non-relative or special input %s before file reads', async path => {
    await expect(readLocalFileSnapshot(await fixture(), path, 64)).rejects.toMatchObject({ code: 'file_source_unavailable' });
  });
  it('rejects a linked directory and hardlink even if their target is readable', async () => {
    const root = await fixture(), outside = await fixture(); await writeFile(join(outside, 'private.txt'), 'PRIVATE');
    await symlink(outside, join(root, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
    await link(join(outside, 'private.txt'), join(root, 'hard.txt'));
    for (const path of ['folder/private.txt', 'hard.txt']) await expect(readLocalFileSnapshot(root, path, 64)).rejects.toMatchObject({ code: 'file_source_unavailable' });
    await expect(readLocalFileSnapshot(join(root, 'folder'), 'private.txt', 64, root)).rejects.toMatchObject({ code: 'file_source_unavailable' });
  });
});
