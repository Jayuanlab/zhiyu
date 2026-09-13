import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWechatLocalCommand} from '../../lib/wechat-local/client.ts';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zhiyu-test-wx-cancel-'));
const marker=path.join(directory,'pid.txt'),controller=new AbortController();
const original=process.env.WECHAT_LOCAL_WX_BINARY;
process.env.WECHAT_LOCAL_WX_BINARY=process.execPath;
let task;
const report={startedAt:new Date().toISOString(),passed:false};
try{
  task=runWechatLocalCommand(['-e','require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',marker],{signal:controller.signal,timeoutMs:10000});
  const outcome=task.then(()=>({ok:true}),error=>({ok:false,error}));
  const deadline=Date.now()+5000;
  while(!fs.existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(fs.existsSync(marker),'child actually started');
  const pid=Number(fs.readFileSync(marker,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);
  process.kill(pid,0);controller.abort();
  const result=await outcome;assert.equal(result.ok,false);
  assert.throws(()=>process.kill(pid,0),'the child must be gone when the command settles');
  report.passed=true;report.childExitConfirmed=true;
}finally{
  controller.abort();await task?.catch(()=>{});
  if(original===undefined)delete process.env.WECHAT_LOCAL_WX_BINARY;else process.env.WECHAT_LOCAL_WX_BINARY=original;
  const resolved=fs.realpathSync(directory),parent=fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(),parent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('zhiyu-test-wx-cancel-'));
  fs.rmSync(resolved,{recursive:true});
  report.completedAt=new Date().toISOString();report.cleanup=true;
  fs.writeFileSync(path.resolve('../../docs/plans/2026-09-06-review-remediation/records/09G-cli-cancellation.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
