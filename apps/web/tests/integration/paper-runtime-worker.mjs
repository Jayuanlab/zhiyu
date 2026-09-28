import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,fork,execFileSync} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function checkPaperRuntimeWorker({client,root,web,databaseUrl,recordPrefix,credentials}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zhiyu_test_paper_worker_'));
  const key=randomUUID()+randomUUID(),token=randomUUID(),children=[],commands=[];
  const log=fs.openSync(path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-paper-worker.log`),'w');
  const python=spawn(path.join(root,'tools/quant-service/.venv/Scripts/python.exe'),['-X','utf8',path.join(root,'tools/quant-service/tests/paper_worker_server.py')],{
    cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,QUANT_PAPER_DATABASE_URL:credentials.databaseUrl,PAPER_TEST_OWNER:credentials.owner,
      PAPER_WORKER_TEST_DIRECTORY:directory,QUANT_PAPER_OWNER_ID:credentials.owner,QUANT_PAPER_SIGNING_KEY:key,QUANT_INTERNAL_TOKEN:token}});
  const pythonExited=new Promise(resolve=>python.once('exit',resolve));
  const until=async(check,label)=>{const deadline=Date.now()+45000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timeout: '+label);};
  let upstreamUrl;
  const proxy=http.createServer(async(req,res)=>{
    try{
      const buffers=[];for await(const chunk of req)buffers.push(chunk);
      const body=Buffer.concat(buffers),upstream=await fetch(upstreamUrl+req.url,{method:req.method,headers:req.headers,body:body.length?body:undefined,signal:AbortSignal.timeout(30000)});
      const bytes=Buffer.from(await upstream.arrayBuffer());
      if(req.method==='POST'&&req.url.endsWith('/ticks')){
        commands.push({commandId:JSON.parse(body).commandId,status:upstream.status});
        if(commands.length===1){res.destroy();return;}
      }
      res.writeHead(upstream.status,{'content-type':'application/json'});res.end(bytes);
    }catch{res.destroy();}
  });
  let account;
  const start=()=>{
    const child=fork(path.join(web,'scripts/start-runtime-worker.mjs'),[],{cwd:web,windowsHide:true,execArgv:['--import','tsx','--conditions=react-server'],stdio:['ignore',log,log,'ipc'],env:{...process.env,
      NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,
      TAURI_MODE:'false',IS_TAURI:'false',ENABLE_LOCAL_SCHEDULER:'true',ZHIYU_RUNTIME_MODE:'worker',ZHIYU_RUNTIME_OWNER_ID:credentials.owner,
      QUANT_TRANSPORT:'http',QUANT_SERVICE_URL:`http://127.0.0.1:${proxy.address().port}`,QUANT_PAPER_ACCOUNT_ID:account,QUANT_PAPER_OWNER_ID:credentials.owner,QUANT_PAPER_SIGNING_KEY:key,QUANT_INTERNAL_TOKEN:token,
      ENABLE_STARTUP_LISTENERS:'false',WORK_HARNESS_EVOLUTION_ENABLED:'false',REPORT_QUALITY_EVALUATOR_ENABLED:'false'}});
    const item={child,done:false};item.exited=new Promise(resolve=>child.once('exit',code=>{item.done=true;resolve(code);}));children.push(item);return item;
  };
  const stop=async item=>{if(!item.done&&item.child.connected)item.child.send('stop');await until(()=>item.done,'worker shutdown');assert.equal(await item.exited,0);};
  try{
    let health;
    await until(async()=>{
      if(python.exitCode!==null)throw Error('Python worker fixture exited');
      const readyFile=path.join(directory,'ready.json');
      if(!fs.existsSync(readyFile))return false;
      const ready=JSON.parse(fs.readFileSync(readyFile,'utf8'));
      assert.equal(ready.owner,credentials.owner);
      assert.ok(Number.isInteger(ready.port)&&ready.port>0&&ready.port<=65535);
      upstreamUrl=`http://127.0.0.1:${ready.port}`;
      try{health=await (await fetch(upstreamUrl+'/health',{signal:AbortSignal.timeout(1000)})).json();return health.owner===credentials.owner;}catch{return false;}
    },'signed Python router');
    account=health.account;const beforeObservations=health.observations;
    const sourceBytes=fs.readFileSync(path.join(directory,'source.json'));
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    const tick=async()=>(await client`SELECT * FROM runtime_paper_ticks WHERE owner_id=${credentials.owner} AND account_id=${account}`)[0];
    const fills=async()=>Number((await client`SELECT count(*)::int AS n FROM paper_fills WHERE account_id=${account}`)[0].n);
    const first=start();
    await until(async()=>commands.length===1&&await fills()===1&&(await tick())?.status==='pending','committed Python fill with unknown Web receipt');
    const pending=await tick();assert.equal(commands[0].status,200);
    await stop(first);
    const second=start();await until(async()=>(await tick())?.status==='completed','same pending command reconciled after restart');
    await stop(second);
    const completed=await tick();assert.equal(completed.sequence,pending.sequence);assert.equal(completed.command_id,pending.command_id);
    assert.equal(commands.length,2);assert.equal(commands[0].commandId,commands[1].commandId);assert.equal(await fills(),1);
    const after=await (await fetch(upstreamUrl+'/health',{signal:AbortSignal.timeout(1000)})).json();assert.equal(after.observations,beforeObservations+1);
    assert.ok(fs.readFileSync(path.join(directory,'source.json')).equals(sourceBytes));
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${credentials.owner}`)[0].n,2);
    return {name:'real runtime worker signed Python tick and restart after lost response',passed:true,commands,fillCount:1,hostInstances:2,quoteObservationsForTick:1,sourceUnchanged:true};
  }finally{
    for(const item of children)if(!item.done)await stop(item);
    proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
    if(python.exitCode===null){execFileSync('taskkill',['/PID',String(python.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await pythonExited;}
    fs.closeSync(log);
    if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('zhiyu_test_paper_worker_'))throw Error('invalid fixture cleanup');
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
