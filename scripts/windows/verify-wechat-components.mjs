// Safe installed-component verification. This never initializes WeChat,
// enumerates its windows, queries messages, focuses a window or sends text.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { sha256 } from './release-lib.mjs';

const args = process.argv.slice(2);
function option(name) { const index=args.indexOf(name); return index<0?undefined:args[index+1]; }
const workspace=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const binary=option('--reader'), python=option('--python');
const componentRoot=option('--component-root')??join(workspace,'tools','wechat-desktop-service');
if(!isAbsolute(componentRoot))throw new Error('--component-root must be an absolute directory.');
const serverScript=join(componentRoot,'server.py'), readerHelper=join(componentRoot,'bootstrap-reader.ps1');
const senderOnly=args.includes('--sender-only');
if(!python||!isAbsolute(python)||(!senderOnly&&(!binary||!isAbsolute(binary)))) throw new Error('Absolute --reader and --python are required (or --sender-only).');
const ownedRoot=await mkdtemp(join(tmpdir(),'zhiyu-wechat-safe-check-'));
const uuid=randomUUID();
await writeFile(join(ownedRoot,'.zhiyu-wechat-check-owned'),uuid+'\n','utf8');
const reportDirectory=join(workspace,'output','windows-wechat-check',uuid);
await mkdir(reportDirectory,{recursive:true});
const report={schemaVersion:1,ownedRoot,uuid,reader:binary,readerSha256:binary?await sha256(binary):null,python,componentRoot,componentSourceSha256:{server:await sha256(serverScript),bootstrapReader:await sha256(readerHelper)},startedAt:new Date().toISOString(),checks:[],passed:false,realWechatInitialized:false,realMessagesRead:false,realMessagesSent:false};
const check=(name,details)=>report.checks.push({name,passed:true,...details});
const safeEnvironment=()=>Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','USERNAME','USERDOMAIN','PATH','PATHEXT'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
async function command(file,arguments_,env=safeEnvironment(),cwd=dirname(file),timeout=30000) {
  const child=spawn(file,arguments_,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>child.kill(),timeout);
  try { return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));}); }
  finally {clearTimeout(timer);}
}
async function helper(action,data,tokenFile) {
  const result=await command(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',readerHelper,'-ReaderBinary',binary,'-DataDirectory',data,'-TokenFile',tokenFile,'-Action',action]);
  assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');
  const lines=result.stdout.trim().split(/\r?\n/);assert.equal(lines.length,1,'one safe receipt');return JSON.parse(lines[0]);
}
let sender, senderLog='';
const fixtureDaemons=[];
try {
  const dataA=join(ownedRoot,'reader-a'),dataB=join(ownedRoot,'reader-b'),tokenA=join(ownedRoot,'token-a'),tokenB=join(ownedRoot,'token-b');
  const secretA=randomBytes(32).toString('hex'),secretB=randomBytes(32).toString('hex');
  await mkdir(dataA);await mkdir(dataB);await writeFile(tokenA,secretA,'utf8');await writeFile(tokenB,secretB,'utf8');
  // These are newly owned temporary dirs; protect only this run's private tree.
  const acl=await command('icacls.exe',[ownedRoot,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`]);
  assert.equal(acl.code,0,'private test ACL');
  if(!senderOnly){
  const metadata=await command(binary,['--zhiyu-build-info']);assert.equal(metadata.code,0);
  const buildInfo=JSON.parse(metadata.stdout);assert.equal(buildInfo.authenticatedIpc,true);assert.equal(buildInfo.privateDataRequired,true);
  const version=await helper('version',join(ownedRoot,'missing-data'),join(ownedRoot,'missing-token'));
  assert.equal(version.ok,true);assert.equal(version.phase,'installed');assert.equal(version.version,'0.6.3');
  check('version_without_personal_data',{version:version.version,buildInfo});
  const missingStop=await helper('stop',join(ownedRoot,'missing-data'),join(ownedRoot,'missing-token'));
  assert.equal(missingStop.phase,'stopped');assert.equal(missingStop.pid,null);check('stop_without_initialized_directory');
  for(const [data,tokenFile,secret] of [[dataA,tokenA,secretA],[dataB,tokenB,secretB]]) {
    const health=await helper('health',data,tokenFile);assert.equal(health.phase,'init_required');assert.equal(health.initialized,false);assert.equal(health.pid,null);
    const stop=await helper('stop',data,tokenFile);assert.equal(stop.phase,'stopped');assert.equal(stop.pid,null);
    const native=await command(binary,['--zhiyu-runtime-status'],{...safeEnvironment(),WX_CLI_HOME:data,WX_CLI_SESSION_TOKEN:secret},data);
    assert.equal(native.code,0);const status=JSON.parse(native.stdout);assert.equal(status.running,false);assert.equal(status.responsive,false);
    check('private_reader_metadata_and_idempotent_stop',{directory:data,pipe:status.privateDataDirHash});
    assert.deepEqual(await readdir(data),[],'metadata probes never initialize or cache personal data');
  }
  const privateChecks=report.checks.filter(check=>check.name==='private_reader_metadata_and_idempotent_stop');
  assert.notEqual(privateChecks[0].pipe,privateChecks[1].pipe,'two private directories cannot share the IPC pipe');
  const rejected=await command(binary,['--zhiyu-runtime-status']);assert.equal(rejected.code,64);assert.match(rejected.stderr,/private_directory_and_credential_required/);
  check('no_global_profile_or_unauthenticated_fallback');
  // Actual daemon IPC against empty, synthetic databases. This is explicitly
  // a protocol/lifecycle fixture, never proof of a WeChat login or data reader.
  for(const [data,tokenFile,secret] of [[dataA,tokenA,secretA],[dataB,tokenB,secretB]]) {
    const db=join(data,'synthetic-empty-database');await mkdir(db);
    await writeFile(join(data,'config.json'),JSON.stringify({db_dir:db,keys_file:'all_keys.json'}),'utf8');
    await writeFile(join(data,'all_keys.json'),'{}','utf8');
    const child=spawn(binary,[],{cwd:data,env:{...safeEnvironment(),WX_CLI_HOME:data,WX_CLI_SESSION_TOKEN:secret,WX_DAEMON_MODE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
    const fixture={child,data,tokenFile,secret,log:'',closed:new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));})};
    child.stdout.on('data',value=>fixture.log+=value);child.stderr.on('data',value=>fixture.log+=value);fixtureDaemons.push(fixture);
    // Mirrors upstream transport's ownership receipt; it records only this
    // exact child process created by this fixture.
    await writeFile(join(data,'daemon.pid'),JSON.stringify({pid:child.pid,exe:binary}),'utf8');
    let status;
    for(let attempt=0;attempt<100;attempt++) {
      const current=await command(binary,['--zhiyu-runtime-status'],{...safeEnvironment(),WX_CLI_HOME:data,WX_CLI_SESSION_TOKEN:secret},data);
      if(current.code===0){status=JSON.parse(current.stdout);if(status.responsive)break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(status?.responsive,true,fixture.log);assert.equal(status.pid,child.pid);
  }
  const wrongCredential=await command(binary,['--zhiyu-runtime-status'],{...safeEnvironment(),WX_CLI_HOME:dataA,WX_CLI_SESSION_TOKEN:secretB},dataA);
  assert.equal(wrongCredential.code,0);assert.equal(JSON.parse(wrongCredential.stdout).responsive,false);
  const wrongStop=await command(binary,['--zhiyu-runtime-stop'],{...safeEnvironment(),WX_CLI_HOME:dataA,WX_CLI_SESSION_TOKEN:secretB},dataA);
  assert.equal(wrongStop.code,65,'wrong token cannot stop private daemon');
  check('native_daemon_authentication',{syntheticFixture:true,pids:fixtureDaemons.map(fixture=>fixture.child.pid)});
  for(const [index,fixture] of fixtureDaemons.entries()) {
    const live=await helper('health',fixture.data,fixture.tokenFile);assert.equal(live.phase,'running');assert.equal(live.pid,fixture.child.pid);
    const stopped=await helper('stop',fixture.data,fixture.tokenFile);assert.equal(stopped.phase,'stopped');assert.equal(stopped.pid,fixture.child.pid);
    const exit=await Promise.race([fixture.closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('owned_reader_shutdown_unconfirmed')),5000))]);
    assert.equal(exit.code,0);assert.equal(exit.signal,null);
    if(index===0){const other=await helper('health',dataB,tokenB);assert.equal(other.phase,'running');assert.equal(other.pid,fixtureDaemons[1].child.pid);}
    await writeFile(join(reportDirectory,`reader-fixture-${index}.log`),fixture.log,'utf8');
    check('native_daemon_graceful_owned_exit',{syntheticFixture:true,pid:fixture.child.pid,exitCode:exit.code});
  }
  }

  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const senderData=join(ownedRoot,'sender');const senderToken=randomBytes(32).toString('hex');
  const senderEnv={...safeEnvironment(),WECHAT_DESKTOP_TOKEN:senderToken,WECHAT_DESKTOP_SEND_ENABLED:'false'};
  const senderArguments=['-I','-B','-X','utf8','-u',serverScript,'--host','127.0.0.1','--port',String(port),'--data-dir',senderData,'--no-window-probe','--managed-stdin'];
  sender=spawn(python,senderArguments,{env:senderEnv,windowsHide:true,stdio:['pipe','pipe','pipe']});
  senderLog='';sender.stdout.on('data',data=>senderLog+=data);sender.stderr.on('data',data=>senderLog+=data);
  const closed=new Promise((resolve,reject)=>{sender.once('error',reject);sender.once('close',(code,signal)=>resolve({code,signal}));});
  const base=`http://127.0.0.1:${port}`;
  const headers={Authorization:`Bearer ${senderToken}`,'Content-Type':'application/json'};
  let health;
  for(let attempt=0;attempt<100;attempt++) {try {const response=await fetch(base+'/health',{headers,signal:AbortSignal.timeout(1000)});if(response.ok){health=await response.json();break;}}catch{};await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(health?.pid,sender.pid,'owned process identity');assert.equal(health.windowAutomationAvailable,true);assert.equal(health.windowProbe,'not_requested');assert.equal(health.loginStatus,'unverified');assert.equal(health.sendEnabled,false);assert.equal(health.capabilities.readMessages,false);
  assert.equal((await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).status,401);
  assert.equal((await fetch(base+'/health',{headers:{Authorization:'Bearer invalid'},signal:AbortSignal.timeout(1000)})).status,401);
  check('real_private_python_health_and_authentication',{health});
  const previewResponse=await fetch(base+'/preview',{method:'POST',headers,body:JSON.stringify({recipientName:'verification-fixture',message:'verification-fixture'})});
  assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
  const sendResponse=await fetch(base+'/send',{method:'POST',headers,body:JSON.stringify({recipientName:'verification-fixture',message:'verification-fixture',confirmToken:preview.confirmToken,commandId:uuid})});
  assert.equal(sendResponse.status,403,'disabled sending stops before GUI');
  check('send_disabled_before_gui_dispatch');
  const shutdown=await fetch(base+'/shutdown',{method:'POST',headers,body:'{}'});assert.equal(shutdown.status,200);
  const exit=await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('owned_sender_shutdown_unconfirmed')),10000))]);
  assert.equal(exit.code,0);assert.equal(exit.signal,null);check('sender_natural_exit',{pid:sender.pid,exitCode:exit.code});
  await writeFile(join(reportDirectory,'sender.log'),senderLog,'utf8');sender=null;
  sender=spawn(python,senderArguments,{env:senderEnv,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let eofLog='';sender.stdout.on('data',data=>eofLog+=data);sender.stderr.on('data',data=>eofLog+=data);
  const eofClosed=new Promise((resolve,reject)=>{sender.once('error',reject);sender.once('close',(code,signal)=>resolve({code,signal}));});
  let eofHealth;
  for(let attempt=0;attempt<100;attempt++) {try {const response=await fetch(base+'/health',{headers,signal:AbortSignal.timeout(1000)});if(response.ok){eofHealth=await response.json();break;}}catch{};await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(eofHealth?.pid,sender.pid);sender.stdin.end();
  const eofExit=await Promise.race([eofClosed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('owned_sender_parent_eof_unconfirmed')),10000))]);
  assert.equal(eofExit.code,0);assert.equal(eofExit.signal,null);check('sender_parent_pipe_eof_natural_exit',{pid:sender.pid,exitCode:eofExit.code});
  await writeFile(join(reportDirectory,'sender-parent-eof.log'),eofLog,'utf8');sender=null;
  report.passed=true;
}catch(error){report.error=String(error?.stack??error);throw error;}
finally {
  if(sender&&sender.exitCode===null) {sender.kill();await new Promise(resolve=>sender.once('close',resolve));report.cleanup='terminated_only_owned_fixture_sender';}
  for(const fixture of fixtureDaemons){
    if(fixture.child.exitCode===null){fixture.child.kill();await fixture.closed;report.fixtureCleanup='terminated_only_owned_synthetic_reader';}
    await writeFile(join(reportDirectory,`reader-${fixture.child.pid}.log`),fixture.log,'utf8');
  }
  report.completedAt=new Date().toISOString();await writeFile(join(reportDirectory,'verification.json'),JSON.stringify(report,null,2)+'\n','utf8');
  if(senderLog) await writeFile(join(reportDirectory,'sender-output.log'),senderLog,'utf8');
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,report:join(reportDirectory,'verification.json'),ownedRoot}));
}
