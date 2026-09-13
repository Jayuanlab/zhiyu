import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {captureReleaseSources} from './release-source-snapshot.mjs';

test('captures dirty and untracked source, excludes credentials and generated data',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'zhiyu-release-snapshot-'));
  const git=args=>execFileSync('git',args,{cwd:root,windowsHide:true,stdio:'pipe'});
  const write=(file,text)=>{mkdirSync(path.dirname(path.join(root,file)),{recursive:true});writeFileSync(path.join(root,file),text);};
  try {
    git(['init']);write('apps/web/lib/source.ts','first');git(['add','.']);
    git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
    const initial=captureReleaseSources(root);
    write('apps/web/lib/source.ts','changed');write('apps/web/lib/new.ts','untracked');
    write('apps/web/.env','SECRET=private');write('apps/web/.next/generated.ts','generated');
    const next=captureReleaseSources(root);
    assert.notEqual(initial.sourceHash,next.sourceHash);
    assert.deepEqual(next.files.map(file=>file.path),['apps/web/lib/new.ts','apps/web/lib/source.ts']);
    assert.ok(!JSON.stringify(next).includes('private'));assert.equal(captureReleaseSources(root).sourceHash,next.sourceHash);
    rmSync(path.join(root,'apps/web/lib/source.ts'));
    assert.notEqual(captureReleaseSources(root).sourceHash,next.sourceHash);
  } finally {
    if(!path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(root).startsWith('zhiyu-release-snapshot-'))throw Error('Unsafe fixture cleanup');
    rmSync(root,{recursive:true,force:true});
  }
});
