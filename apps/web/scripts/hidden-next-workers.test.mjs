import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import cp from 'node:child_process';
import {hiddenNextWorkerFork,installHiddenNextWorkers} from './hidden-next-workers.mjs';
test('only Next worker forks are hidden; both fork signatures retain IPC options',()=>{
 const calls=[];const fork=hiddenNextWorkerFork((...args)=>{calls.push(args);return 'child';});
 const target='D:\\zhiyu\\node_modules\\next\\dist\\compiled\\jest-worker\\processChild.js';
 const options={stdio:['pipe','pipe','pipe','ipc'],env:{FIXTURE:'yes'}};
 assert.equal(fork(target,['one'],options),'child');
 assert.deepEqual(calls[0],[target,['one'],{...options,windowsHide:true}]);
 fork(target,options);assert.deepEqual(calls[1],[target,{...options,windowsHide:true}]);
 fork('/other/processChild.js',[],options);assert.equal(calls[2][2],options);
 assert.equal(options.windowsHide,undefined);
});
test('real bundled Jest worker keeps request/response and shuts down',async()=>{
 if(process.platform!=='win32')return;
 const seen=[];const original=cp.fork;
 cp.fork=hiddenNextWorkerFork(function(...args){seen.push(args[2]?.windowsHide??args[1]?.windowsHide);return original.apply(this,args);});
 installHiddenNextWorkers();
 const require=createRequire(import.meta.url);
 const {Worker}=require('next/dist/compiled/jest-worker');
 const worker=new Worker(require.resolve('./hidden-next-worker-fixture.cjs'),{numWorkers:1,exposedMethods:['echo']});
 try{assert.deepEqual(await worker.echo({value:'ipc-ok'}),{value:'ipc-ok'});assert(seen.length>0);assert(seen.every(Boolean));}
 finally{await worker.end();cp.fork=original;}
});
