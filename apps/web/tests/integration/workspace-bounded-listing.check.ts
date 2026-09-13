import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import type postgres from 'postgres';
import {createWorkspaceListing} from '@/lib/files/workspace/bounded-listing-service';
export async function checkWorkspaceBoundedListing(client:postgres.Sql){
  const owner=randomUUID(),other=randomUUID(),task=randomUUID(),foreign=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'listing-owner@example.invalid'),(${other},'listing-other@example.invalid')`;
  await client`INSERT INTO "Chat"(id,"createdAt",title,"userId") VALUES (${task},now(),'Owned fixture',${owner}),(${foreign},now(),'Private fixture',${other})`;
  const root=mkdtempSync(join(tmpdir(),'zhiyu-bounded-db-'));const touched:string[]=[];
  const listing=createWorkspaceListing(id=>{touched.push(id);return join(root,id);});
  try{
    mkdirSync(join(root,task));mkdirSync(join(root,foreign));
    writeFileSync(join(root,foreign,'private.txt'),'private');
    for(let i=0;i<1200;i++)writeFileSync(join(root,task,`item-${i}.txt`),'fixture');
    const started=performance.now(),heapBefore=process.memoryUsage().heapUsed;
    let cursor:string|null=null,pages=0,maxScanned=0;const paths:string[]=[];
    do{
      const page=await listing.page(owner,cursor,100);pages++;maxScanned=Math.max(maxScanned,page.scannedEntries);
      assert.equal(page.total,null);assert.ok(page.files.every(file=>file.taskId===task));
      paths.push(...page.files.map(file=>file.path));cursor=page.nextCursor;
    }while(cursor&&pages<100);
    assert.equal(cursor,null);assert.equal(paths.length,1200);assert.equal(new Set(paths).size,1200);assert.ok(maxScanned<=500);
    assert.ok(touched.every(id=>id===task));
    const elapsedMs=performance.now()-started,heapDeltaBytes=process.memoryUsage().heapUsed-heapBefore;
    mkdirSync(join(root,task,'docs'));writeFileSync(join(root,task,'docs','one.txt'),'one');writeFileSync(join(root,task,'docs','two.txt'),'two');
    const scope={taskId:task,path:'docs'};
    const scoped=await listing.page(owner,null,1,scope);
    assert.equal(scoped.files.length,1);assert.ok(scoped.files[0].path.startsWith('docs'));
    await assert.rejects(listing.page(owner,scoped.nextCursor,1),(error:any)=>error.code==='cursor_scope_mismatch');
    await assert.rejects(listing.page(owner,scoped.nextCursor,1,{taskId:task,path:''}),(error:any)=>error.code==='cursor_scope_mismatch');
    assert.equal((await listing.page(owner,scoped.nextCursor,1,scope)).files.length,1);
    await assert.rejects(listing.page(owner,null,1,{taskId:foreign}),(error:any)=>error.status===403);
    await assert.rejects(listing.page(owner,null,1,{taskId:task,path:`../${foreign}`}));
    const first=await listing.page(owner,null,1);
    await client`UPDATE "Chat" SET "userId"=${other} WHERE id=${task}`;
    await assert.rejects(listing.page(owner,first.nextCursor,1),(error:any)=>error.status===403);
    assert.deepEqual((await listing.page(owner,null,10)).files,[]);
    return {name:'bounded authorized workspace scan',passed:true,files:1200,pages,maxScanned,readBudget:500,elapsedMs,heapDeltaBytes,platform:process.platform,node:process.version,unownedRootNeverResolved:true,realDatabaseRevocation:true,totalUnknownExplicit:true,taskScopeBoundToCursor:true,subdirectoryPathsRelativeToTask:true,foreignTaskAndTraversalRejected:true,fixtureCleanup:true};
  }finally{
    await listing.close();
    if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('zhiyu-bounded-db-'))throw Error('Unsafe cleanup');
    rmSync(root,{recursive:true,force:true});
  }
}
