import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {memoryConnectionStatus,routeOwnerMemory} from '@/lib/memory-zhiyu/remote';
const owner='11111111-1111-4111-8111-111111111111';
let dir:string,file:string;const previous=process.env.ZHIYU_MEMORY_CONNECTION_FILE;
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'zhiyu-memory-transport-'));file=path.join(dir,'connection.json');delete process.env.ZHIYU_MEMORY_CONNECTION_FILE;});
afterEach(()=>{vi.unstubAllGlobals();if(previous===undefined)delete process.env.ZHIYU_MEMORY_CONNECTION_FILE;else process.env.ZHIYU_MEMORY_CONNECTION_FILE=previous;if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);});
function remote(){fs.writeFileSync(file,JSON.stringify({mode:'remote',ownerId:owner,origin:'http://127.0.0.1:3640',token:'x'.repeat(43)}));process.env.ZHIYU_MEMORY_CONNECTION_FILE=file;}
it('defaults to the local adapter and switches only with explicit validated configuration',async()=>{
 const local=vi.fn(async()=>({status:'local'}));expect(await routeOwnerMemory(owner,'owner.read',{},local)).toEqual({status:'local'});remote();
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({status:'remote'})));vi.stubGlobal('fetch',fetcher);
 expect(await routeOwnerMemory(owner,'owner.read',{purpose:'discover'},local)).toEqual({status:'remote'});expect(local).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('fails closed without replaying writes locally or exposing the private credential in status',async()=>{
 remote();const local=vi.fn(async()=>({status:'local'}));vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('connection refused');}));
 await expect(routeOwnerMemory(owner,'owner.submit',{commandId:'same-command'},local)).rejects.toMatchObject({code:'memory_remote_outcome_unknown',status:503});expect(local).not.toHaveBeenCalled();
 const status=await memoryConnectionStatus(owner);expect(status).toMatchObject({mode:'remote',status:'unavailable',automaticFallback:false});expect(JSON.stringify(status)).not.toContain('x'.repeat(43));
});
it('rejects a credential configuration for a different owner before any network request',async()=>{
 remote();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 await expect(routeOwnerMemory('22222222-2222-4222-8222-222222222222','owner.read',{},async()=>({}))).rejects.toMatchObject({code:'memory_remote_configuration_invalid'});expect(fetcher).not.toHaveBeenCalled();
});
