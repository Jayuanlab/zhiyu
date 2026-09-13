import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, rmdirSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const state = vi.hoisted(()=>({root:''}));
vi.mock('@/lib/env/config/constants',()=>({getAppDir:()=>state.root}));
vi.mock('@/lib/utils/logger',()=>({workspaceLogger:{info:vi.fn(),error:vi.fn()}}));
import {getTaskSessionDir,getSessionsDir,listSessionFiles,getAllFilesAtPathWithSize,getAllWorkspaceFilesRecursive} from '@/lib/files/workspace/sessions';
describe('authorized workspace listing paths',()=>{
  beforeEach(()=>{
    state.root=mkdtempSync(join(tmpdir(),'zhiyu-listing-'));
    mkdirSync(getTaskSessionDir('owner'),{recursive:true});
    mkdirSync(getTaskSessionDir('other'),{recursive:true});
    writeFileSync(join(getTaskSessionDir('owner'),'owned.txt'),'owned');
    writeFileSync(join(getTaskSessionDir('other'),'private.txt'),'private');
  });
  afterEach(()=>{
    vi.restoreAllMocks();
    if(!resolve(state.root).startsWith(resolve(tmpdir())+sep)||!state.root.includes('zhiyu-listing-'))throw Error('Unsafe fixture cleanup');
    rmSync(state.root,{recursive:true,force:true});
  });
  it('enters only authorized task roots, without enumerating all sessions',async()=>{
    const read=vi.spyOn(fs,'readdir');
    const files=await getAllWorkspaceFilesRecursive(new Set(['owner']));
    expect(files.map(file=>file.name)).toEqual(['owned.txt']);
    expect(read.mock.calls.map(args=>String(args[0]))).not.toContain(getSessionsDir());
    expect(read.mock.calls.every(args=>String(args[0]).startsWith(getTaskSessionDir('owner')))).toBe(true);
    read.mockClear();expect(await getAllWorkspaceFilesRecursive(new Set())).toEqual([]);expect(read).not.toHaveBeenCalled();
  });
  it('rejects traversal and absolute paths into another task',()=>{
    expect(()=>listSessionFiles('owner','../other')).toThrow('authorized task');
    expect(()=>listSessionFiles('owner',getTaskSessionDir('other'))).toThrow('authorized task');
    expect(()=>getTaskSessionDir('../other')).toThrow('authorized task');
  });
  it('rejects a task root replaced with a junction',async()=>{
    const linked=join(getSessionsDir(),'linked');symlinkSync(getTaskSessionDir('other'),linked,'junction');
    expect(()=>listSessionFiles('linked')).toThrow('authorized task');
    await expect(getAllWorkspaceFilesRecursive(new Set(['linked']))).rejects.toThrow('authorized task');
  });
  it('does not follow nested junctions in shallow or recursive listings',async()=>{
    symlinkSync(getTaskSessionDir('other'),join(getTaskSessionDir('owner'),'escape'),'junction');
    expect(listSessionFiles('owner').map(item=>item.name)).toEqual(['owned.txt']);
    expect(()=>listSessionFiles('owner','escape')).toThrow('authorized task');
    expect((await getAllWorkspaceFilesRecursive(new Set(['owner']))).map(item=>item.name)).toEqual(['owned.txt']);
    expect((await getAllFilesAtPathWithSize('owner',getTaskSessionDir('owner'))).files.map(item=>item.name)).toEqual(['owned.txt']);
  });
  it('does not let a warm cache authorize a replaced directory',async()=>{
    const child=join(getTaskSessionDir('owner'),'child');mkdirSync(child);writeFileSync(join(child,'before.txt'),'before');
    expect((await getAllFilesAtPathWithSize('owner',getTaskSessionDir('owner'))).files.some(item=>item.name==='before.txt')).toBe(true);
    rmSync(join(child,'before.txt'));rmdirSync(child);symlinkSync(getTaskSessionDir('other'),child,'junction');
    const next=await getAllFilesAtPathWithSize('owner',getTaskSessionDir('owner'));
    expect(next.files.map(item=>item.name)).toEqual(['owned.txt']);
  });
  it('preserves missing-task empty results',()=>{expect(listSessionFiles('missing')).toEqual([]);});
});
