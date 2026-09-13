import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {RuntimeHostStore} from '../../lib/runtime/host-store.ts';

export async function checkRuntimeHostProcesses({client,databaseUrl,web,root,recordPrefix}){
  const owner=randomUUID();await client`INSERT INTO "User"(id,email) VALUES (${owner},'process-host@example.invalid')`;
  const children=[],events=[],checks=[];
  function start(){
    const instance=randomUUID();
    const child=fork(path.join(web,'tests/integration/runtime-host-child.mjs'),[],{cwd:web,windowsHide:true,
      execArgv:['--import','tsx','--conditions=react-server'],stdio:['ignore','ignore','pipe','ipc'],
      env:{...process.env,RUNTIME_HOST_TEST_URL:databaseUrl,RUNTIME_HOST_TEST_OWNER:owner,RUNTIME_HOST_TEST_INSTANCE:instance}});
    const record={child,instance,errors:'',exited:new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})))};
    child.stderr.on('data',chunk=>record.errors+=chunk.toString());
    child.on('message',message=>events.push({...message,at:Date.now()}));
    children.push(record);return record;
  }
  async function until(condition,label){
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,30));}
    throw Error(`Timed out: ${label}`);
  }
  const phase=record=>events.filter(e=>e.instanceId===record.instance&&e.kind==='phase').at(-1)?.phase;
  const count=(record,kind)=>events.filter(e=>e.instanceId===record.instance&&e.kind===kind).length;
  try{
    const before=Date.now(),a=start(),b=start();
    await until(()=>[phase(a),phase(b)].includes('running')&&[phase(a),phase(b)].includes('lost'),'one running host and one rejected peer');
    const winner=phase(a)==='running'?a:b,loser=winner===a?b:a;
    assert.equal(count(loser,'fast_started'),0);
    const store=new RuntimeHostStore(client),first=await store.status(owner);
    assert.equal(first.online,true);assert.ok(Date.now()-before<10000);
    await until(()=>count(winner,'slow_started')===1&&count(winner,'fast_started')>=3,'fast module continues beside pending slow module');
    checks.push({name:'two real processes, one lease holder, first heartbeat under 10 seconds, slow module isolated',passed:true});
    winner.child.kill();await winner.exited;
    await until(async()=>!(await store.status(owner)).online,'crashed holder lease expires');
    const replacement=start();await until(()=>phase(replacement)==='running','replacement takes expired lease');
    const second=await store.status(owner);assert.equal(second.token,first.token+1);assert.equal(second.instance_id,replacement.instance);
    assert.equal(count(loser,'fast_started'),0);
    checks.push({name:'abrupt process exit, observed offline lease, fenced successor',passed:true});
    await until(()=>count(replacement,'slow_started')===1,'replacement slow module starts');
    replacement.child.send('disconnect');
    await until(()=>phase(replacement)==='lost'&&count(replacement,'slow_aborted')===1,'closed database connection stops dispatch and requests cancellation');
    const stoppedCount=count(replacement,'fast_started');
    await new Promise(resolve=>setTimeout(resolve,600));assert.equal(count(replacement,'fast_started'),stoppedCount);
    checks.push({name:'real connection closure causes lost state, cancellation and no further dispatch',passed:true});
    return {name:'runtime host real process lifecycle',passed:true,checks};
  }finally{
    for(const record of children){
      if(record.child.exitCode===null&&record.child.signalCode===null){record.child.kill();await record.exited;}
    }
    fs.writeFileSync(path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-processes.json`),JSON.stringify({checks,events,children:children.map(c=>({instance:c.instance,errors:c.errors}))},null,2));
  }
}
