import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {atomicAssetFileSystem} from '../../scripts/atomic-development-assets.mjs';

test('an in-flight response keeps the complete old script during replacement',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zhiyu-atomic-assets-'));
  try{
    fs.mkdirSync(path.join(directory,'static'));
    const target=path.join(directory,'static','layout.js');
    const before=Buffer.alloc(2*1024*1024,65),after=Buffer.alloc(before.length,66);
    fs.writeFileSync(target,before);
    const stream=fs.createReadStream(target,{highWaterMark:65536});
    const parts=[];
    stream.on('data',part=>{parts.push(part);stream.pause();});
    await once(stream,'data');
    const output=atomicAssetFileSystem(fs,directory);
    const published=new Promise((resolve,reject)=>output.writeFile(target,after,error=>error?reject(error):resolve()));
    stream.removeAllListeners('data');stream.on('data',part=>parts.push(part));
    const ended=once(stream,'end');stream.resume();await ended;
    await published;
    assert.deepEqual(Buffer.concat(parts),before);
    assert.deepEqual(fs.readFileSync(target),after);
    assert.deepEqual(fs.readdirSync(path.dirname(target)),['layout.js']);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('a failed replacement preserves the previous script and reports the error',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zhiyu-atomic-assets-'));
  try{
    fs.mkdirSync(path.join(directory,'static'));
    const target=path.join(directory,'static','layout.js');
    fs.writeFileSync(target,'previous complete script');
    const failing=Object.create(fs);
    failing.rename=(_from,_to,callback)=>callback(Object.assign(new Error('injected I/O failure'),{code:'EIO'}));
    const output=atomicAssetFileSystem(failing,directory);
    await assert.rejects(new Promise((resolve,reject)=>output.writeFile(target,'replacement',error=>error?reject(error):resolve())),{code:'EIO'});
    assert.equal(fs.readFileSync(target,'utf8'),'previous complete script');
    assert.deepEqual(fs.readdirSync(path.dirname(target)),['layout.js']);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
