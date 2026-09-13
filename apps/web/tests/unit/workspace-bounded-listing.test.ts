import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {BoundedWorkspaceListing} from '@/lib/files/workspace/bounded-listing';
describe('bounded workspace scans',()=>{
  let root:string,listing:BoundedWorkspaceListing,allowed:boolean;
  beforeEach(()=>{
    root=mkdtempSync(join(tmpdir(),'zhiyu-bounded-'));allowed=true;
    listing=new BoundedWorkspaceListing({nextRoot:async(owner,after)=>owner==='owner'&&allowed&&!after?{taskId:'task',path:root}:null,allowed:async owner=>owner==='owner'&&allowed},{budget:32,ttlMs:120000,maxScans:8,maxDepth:8});
  });
  afterEach(async()=>{
    await listing.close();
    if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('zhiyu-bounded-'))throw Error('Unsafe cleanup');
    rmSync(root,{recursive:true,force:true});
  });
  it('completes a large tree without exceeding the read budget or losing files',async()=>{
    for(let n=0;n<12;n++){
      const dir=join(root,`d${n}`);mkdirSync(dir);
      for(let i=0;i<100;i++)writeFileSync(join(dir,`f${i}.txt`),'fixture');
    }
    let cursor:string|null=null;let pages=0,maxScanned=0;const names:string[]=[];
    do{
      const page=await listing.page('owner',cursor,17);pages++;
      maxScanned=Math.max(maxScanned,page.scannedEntries);
      names.push(...page.files.map(file=>file.path));expect(page.total).toBeNull();
      cursor=page.nextCursor;
    }while(cursor&&pages<200);
    expect(cursor).toBeNull();expect(names).toHaveLength(1200);expect(new Set(names).size).toBe(1200);expect(maxScanned).toBeLessThanOrEqual(32);
  });
  it('allows empty budget-limited pages to continue',async()=>{
    for(let i=0;i<80;i++)writeFileSync(join(root,`f${i}.json`),'{}');
    const first=await listing.page('owner',null,50);
    expect(first.files).toEqual([]);expect(first.hasMore).toBe(true);expect(first.scannedEntries).toBe(32);
    let page=first;let pages=1;
    while(page.nextCursor){page=await listing.page('owner',page.nextCursor,50);pages++;}
    expect(pages).toBeGreaterThan(1);expect(page.hasMore).toBe(false);
  });
  it('replays a continuation after response loss without advancing',async()=>{
    for(let i=0;i<5;i++)writeFileSync(join(root,`f${i}.txt`),'fixture');
    const first=await listing.page('owner',null,1);
    const second=await listing.page('owner',first.nextCursor,1);
    expect(await listing.page('owner',first.nextCursor,1)).toEqual(second);
    const third=await listing.page('owner',second.nextCursor,1);
    expect(third.files[0].path).not.toBe(second.files[0].path);
  });
  it('rejects other owners and revoked grants before returning cached or new files',async()=>{
    writeFileSync(join(root,'one.txt'),'fixture');writeFileSync(join(root,'two.txt'),'fixture');
    const first=await listing.page('owner',null,1);
    await expect(listing.page('other',first.nextCursor,1)).rejects.toMatchObject({status:410});
    const second=await listing.page('owner',first.nextCursor,1);expect(second.files).toHaveLength(1);
    allowed=false;
    await expect(listing.page('owner',first.nextCursor,1)).rejects.toMatchObject({status:403});
    await expect(listing.page('owner',second.nextCursor,1)).rejects.toMatchObject({status:410});
  });
  it('rejects expired process cursors and invalid sizes explicitly',async()=>{
    writeFileSync(join(root,'one.txt'),'fixture');const first=await listing.page('owner',null,1);
    await listing.close();await expect(listing.page('owner',first.nextCursor,1)).rejects.toMatchObject({status:410});
    await expect(listing.page('owner',null,1001)).rejects.toMatchObject({status:400});
  });
});
