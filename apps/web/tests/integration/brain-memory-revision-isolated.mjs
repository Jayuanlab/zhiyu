import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import postgres from 'postgres';
import {parse} from 'dotenv';
import {drizzle} from 'drizzle-orm/postgres-js';
import {PgDialect} from 'drizzle-orm/pg-core';
import {readMigrationFiles} from 'drizzle-orm/migrator';
import {captureReleaseSources} from '../../../../scripts/release-source-snapshot.mjs';
import {prepareMemoryRevisionNextConfiguration,captureMemoryRevisionConfiguration,captureMemoryRevisionRuntimeOwnership,restoreMemoryRevisionConfiguration} from './brain-memory-revision-configuration.mjs';

const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const root=path.resolve(web,'../..');
const args=process.argv.slice(2);
const browserEnabled=args.includes('--browser');
const httpEnabled=browserEnabled||args.includes('--http');
const mode=args.includes('--production')?'production':'development';
const buildEnabled=args.includes('--build');
const memoryUpdatesEnabled=args.includes('--memory-updates');
const memoryDependenciesEnabled=args.includes('--memory-dependencies');
const memoryCorrectionsEnabled=args.includes('--memory-corrections');
const memoryGovernanceEnabled=args.includes('--memory-governance');
const phase2BrowserOnly=args.includes('--phase2-browser-only');
const phase3BrowserOnly=args.includes('--phase3-browser-only');
const phase4BrowserOnly=args.includes('--phase4-browser-only');
const reuseDevelopmentOutput=args.includes('--reuse-development-output');
const stage=args.find(value=>value.startsWith('--review-stage='))?.split('=')[1]??'04';
const port=Number(args.find(value=>value.startsWith('--port='))?.split('=')[1]??3547);
if(!/^\d{2}$/.test(stage)||!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid isolated runtime options');
if(buildEnabled&&(mode!=='production'||!httpEnabled))throw Error('--build requires production HTTP/browser acceptance');
if(phase2BrowserOnly&&(mode!=='development'||!browserEnabled||!memoryUpdatesEnabled))throw Error('--phase2-browser-only is limited to development phase2 browser debugging');
if(memoryDependenciesEnabled&&!memoryUpdatesEnabled)throw Error('--memory-dependencies requires --memory-updates for the complete preceding contract');
if(memoryCorrectionsEnabled&&(!memoryUpdatesEnabled||!memoryDependenciesEnabled))throw Error('--memory-corrections requires the preceding memory update and dependency contracts');
if(phase3BrowserOnly&&(mode!=='development'||!browserEnabled||!memoryDependenciesEnabled||phase2BrowserOnly||phase4BrowserOnly))throw Error('--phase3-browser-only is limited to development phase3 browser debugging');
if(phase4BrowserOnly&&(mode!=='development'||!browserEnabled||!memoryCorrectionsEnabled||phase2BrowserOnly||phase3BrowserOnly))throw Error('--phase4-browser-only is limited to development phase4 browser debugging');
if(reuseDevelopmentOutput&&mode!=='development')throw Error('--reuse-development-output never applies to production builds');
const diskEnv={};
for(const directory of [root,web])for(const file of ['.env','.env.local',`.env.${mode}`,`.env.${mode}.local`]){
  const envFile=path.join(directory,file);if(fs.existsSync(envFile))Object.assign(diskEnv,parse(fs.readFileSync(envFile)));
}
const adminUrl=new URL(process.env.ZHIYU_TEST_ADMIN_URL??diskEnv.ZHIYU_TEST_ADMIN_URL??process.env.POSTGRES_URL??diskEnv.POSTGRES_URL??process.env.DATABASE_URL??diskEnv.DATABASE_URL);
if(!['localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname))throw Error('Fixture administration requires loopback');
const name=`zhiyu_test_${randomUUID().replaceAll('-','')}`;
const token=randomUUID();
const records=path.join(root,'.runtime','memory-revision',`${new Date().toISOString().replaceAll(':','-')}-${token}`);
fs.mkdirSync(records,{recursive:true});
const report={startedAt:new Date().toISOString(),database:name,records,nodeVersion:process.version,mode,stage,buildEnabled,httpEnabled,browserEnabled,memoryUpdatesEnabled,memoryDependenciesEnabled,memoryCorrectionsEnabled,memoryGovernanceEnabled,phase2BrowserOnly,phase3BrowserOnly,phase4BrowserOnly,reuseDevelopmentOutput,checks:[],cleanup:false,productionEffect:'not_checked_daily_instance'};

async function buildRuntime(owner){
  const saved=['tsconfig.json','next-env.d.ts'].map(file=>({file:path.join(web,file),bytes:fs.readFileSync(path.join(web,file))}));
  const sourceBefore=captureReleaseSources(root),receipt={stage,startedAt:new Date().toISOString(),nodeVersion:process.version,database:name,runtimeContract:{authMode:'local_owner',fixtureOwner:owner,localScheduler:false,startupListeners:false,externalProviderCredentials:'cleared'},sourceBefore,buildExitCode:null,passed:false};
  const configurationSnapshot=()=>captureMemoryRevisionConfiguration(saved);
  receipt.configuration={before:configurationSnapshot()};
  const log=fs.openSync(path.join(records,'build.log'),'w');
  try{
    Object.assign(process.env,{NODE_ENV:'production',ZHIYU_REVIEW_BUILD:stage,DEV_USER_ID:owner});
    const configModule=await import('next/dist/server/config.js');
    const {findPagesDir}=await import('next/dist/lib/find-pages-dir.js');
    const config=await (configModule.default.default??configModule.default)('phase-production-build',web);
    if(config.distDir!==`.tmp/next-review-${stage}`)throw Error('Unexpected isolated build output');
    const {appDir,pagesDir}=findPagesDir(web);
    receipt.configurationPreparation=await prepareMemoryRevisionNextConfiguration({web,config,appDir,pagesDir});
    receipt.configuration.prepared=configurationSnapshot();
    fs.writeSync(log,'Official Next configuration preparation passed in main process and the same Next worker; production build type checking remains enabled.\n');
    const child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:web,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,NODE_OPTIONS:'--max-old-space-size=12288',NODE_PATH:path.join(root,'node_modules')}});
    receipt.buildExitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  }catch(error){receipt.error={message:error.message,code:error.code,errno:error.errno,syscall:error.syscall,path:error.path,stack:error.stack};}
  finally{
    fs.closeSync(log);receipt.configuration.afterBuild=configurationSnapshot();
    const restoration=restoreMemoryRevisionConfiguration({saved,prepared:receipt.configuration.prepared,records});
    receipt.configuration.restored=restoration.restored;receipt.configuration.restorationDecisions=restoration.restorationDecisions;receipt.configurationRestored=restoration.configurationRestored;receipt.configurationConflict=restoration.configurationConflict;
    receipt.sourceAfter=captureReleaseSources(root);receipt.sourceStable=sourceBefore.sourceHash===receipt.sourceAfter.sourceHash&&sourceBefore.revision===receipt.sourceAfter.revision;
    const buildIdFile=path.join(web,'.tmp',`next-review-${stage}`,'BUILD_ID');
    receipt.buildId=receipt.buildExitCode===0&&fs.existsSync(buildIdFile)?fs.readFileSync(buildIdFile,'utf8').trim():null;
    receipt.completedAt=new Date().toISOString();receipt.passed=receipt.buildExitCode===0&&receipt.sourceStable&&receipt.configurationRestored&&!!receipt.buildId&&!receipt.error;
    fs.writeFileSync(path.join(records,'build-receipt.json'),JSON.stringify(receipt,null,2));
  }
  if(!receipt.passed)throw Error(receipt.error?.message??(receipt.configurationConflict?'Shared configuration changed; current files and original backups were preserved':!receipt.sourceStable?'Sources changed during isolated build':'Isolated production build failed'));
  return {name:'fresh production build against synthetic isolated database',passed:true,stage,buildId:receipt.buildId,sourceStable:receipt.sourceStable};
}
adminUrl.pathname='/postgres';
const admin=postgres(adminUrl.toString(),{max:1,onnotice:()=>{}});
let client,created=false;
try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;
  const databaseUrl=new URL(adminUrl);databaseUrl.pathname=`/${name}`;
  client=postgres(databaseUrl.toString(),{max:8,onnotice:()=>{}});
  await new PgDialect().migrate(readMigrationFiles({migrationsFolder:path.join(web,'lib/db/migrations')}),drizzle(client)._.session,{migrationsTable:'__drizzle_migrations'});
  // Explicit empty overrides stop dotenv-loaded or ambient production providers
  // from being used by this fresh test process or its owned web server.
  for(const key of Object.keys(diskEnv))process.env[key]='';
  for(const key of Object.keys(process.env))if(/(?:API_KEY|SECRET|TOKEN|LLM_(?:MODEL|BASE_URL)|SERVICE_URL)$/.test(key))process.env[key]='';
  Object.assign(process.env,{NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl.toString(),POSTGRES_URL:databaseUrl.toString(),DATABASE_URL:databaseUrl.toString(),
    AUTH_MODE:'local_owner',AUTH_SECRET:'isolated-memory-revision-fixture',TAURI_MODE:'false',IS_TAURI:'false',ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',WORK_HARNESS_EVOLUTION_ENABLED:'false',REPORT_QUALITY_EVALUATOR_ENABLED:'false',
    BRAIN_RECALL_PLANNER_LLM_API_KEY:'',BRAIN_RECALL_PLANNER_LLM_BASE_URL:'',BRAIN_RECALL_PLANNER_LLM_MODEL:'',MEMORY_RECALL_LLM_API_KEY:'',MEMORY_RECALL_LLM_BASE_URL:'',MEMORY_RECALL_LLM_MODEL:'',LLM_API_KEY:'',LLM_BASE_URL:'',LLM_MODEL:'',
    MEMORY_SEARCH_CACHE_TTL_MS:'60000',MEMORY_SEARCH_CACHE_STALE_TTL_MS:'60000'});
  const {checkBrainMemoryRevision}=await import('./brain-memory-revision.check.ts');
  report.checks.push(await checkBrainMemoryRevision(client));
  const {checkBrainMemoryReview}=await import('./brain-memory-review.check.ts');
  report.checks.push(await checkBrainMemoryReview(client));
  if(memoryUpdatesEnabled){const {checkBrainMemoryUpdate}=await import('./brain-memory-update.check.ts');report.checks.push(await checkBrainMemoryUpdate(client));}
  if(memoryDependenciesEnabled){const {checkBrainMemoryDependency}=await import('./brain-memory-dependency.check.ts');report.checks.push(await checkBrainMemoryDependency(client));}
  if(memoryCorrectionsEnabled){const {checkBrainMemoryCorrection}=await import('./brain-memory-correction.check.ts');report.checks.push(await checkBrainMemoryCorrection(client));}
  if(memoryGovernanceEnabled){
    const {checkMemoryGovernance}=await import('./memory-governance.check.ts');report.checks.push(await checkMemoryGovernance(client));
    const {checkInteractionMemoryGovernance}=await import('./interaction-memory-governance.check.ts');report.checks.push(await checkInteractionMemoryGovernance(client));
  }
  if(httpEnabled){
    // Coordinates only isolated runners using this contract, not unrelated dev tools.
    const configurationLockPath=path.join(root,'.runtime','memory-revision','configuration.lock');
    const configurationLock=fs.openSync(configurationLockPath,'wx');
    fs.writeSync(configurationLock,JSON.stringify({pid:process.pid,stage,records,createdAt:new Date().toISOString()}));
    try{
    const owner=randomUUID();await client`INSERT INTO "User"(id,email) VALUES (${owner},${owner+'@example.invalid'})`;
    const output=path.join(web,'.tmp',`next-review-${stage}`);
    if(mode==='development'&&fs.existsSync(output)&&!reuseDevelopmentOutput)throw Error('Select an unused review stage or explicitly reuse development cache; existing build output is preserved');
    if(buildEnabled&&fs.existsSync(output))throw Error('Fresh production build requires an unused stage; existing output is preserved');
    if(buildEnabled)report.checks.push(await buildRuntime(owner));
    if(mode==='production'&&!fs.existsSync(path.join(output,'BUILD_ID')))throw Error('A completed build for this review stage is required');
    const origin=`http://127.0.0.1:${port}`;
    try{await fetch(origin+'/api/identity',{signal:AbortSignal.timeout(700)});throw Error('Isolated port is already occupied');}catch(error){if(error.message==='Isolated port is already occupied')throw error;}
    const saved=['tsconfig.json','next-env.d.ts'].map(file=>({file:path.join(web,file),bytes:fs.readFileSync(path.join(web,file))}));
    const runtimeSourceBefore=captureReleaseSources(root);report.runtimeSources={before:runtimeSourceBefore};
    let runtimeOwnership=captureMemoryRevisionRuntimeOwnership(saved,stage,'production');
    if(mode==='development'){
      try{
        Object.assign(process.env,{NODE_ENV:'development',ZHIYU_REVIEW_BUILD:stage,DEV_USER_ID:owner});
        // The existing local_owner policy also validates configuration loading
        // in this parent process, before the explicitly loopback child starts.
        if(!process.argv.includes('--hostname'))process.argv.push('--hostname','127.0.0.1');
        const configModule=await import('next/dist/server/config.js');
        const {findPagesDir}=await import('next/dist/lib/find-pages-dir.js');
        const config=await (configModule.default.default??configModule.default)('phase-development-server',web);
        if(config.distDir.replaceAll('\\','/')!==`.tmp/next-review-${stage}/dev`)throw Error('Unexpected isolated development output');
        const {appDir,pagesDir}=findPagesDir(web);
        report.developmentConfigurationPreparation=await prepareMemoryRevisionNextConfiguration({web,config,appDir,pagesDir});
        runtimeOwnership=captureMemoryRevisionRuntimeOwnership(saved,stage,mode);
      }catch(error){
        report.runtimeConfiguration=restoreMemoryRevisionConfiguration({saved,prepared:captureMemoryRevisionRuntimeOwnership(saved,stage,mode),records,label:'development-preparation'});
        throw error;
      }
    }
    const log=fs.openSync(path.join(records,`${mode}-server.log`),'w');
    const command=mode==='development'?[path.join(web,'scripts/start-local-development.mjs'),'--port',String(port),'--hostname','127.0.0.1']:[path.join(root,'node_modules/next/dist/bin/next'),'start','-p',String(port),'-H','127.0.0.1'];
    const child=spawn(process.execPath,command,{cwd:web,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,NODE_ENV:mode,DEV_USER_ID:owner,ZHIYU_REVIEW_BUILD:stage,NODE_OPTIONS:'--max-old-space-size=8192',NODE_PATH:path.join(root,'node_modules')}});
    const exited=new Promise(resolve=>child.once('exit',resolve));
    try{
      let ready=false;
      for(let n=0;n<120;n++){
        if(child.exitCode!==null)throw Error('Owned web server exited');
        try{const response=await fetch(origin+'/api/identity',{signal:AbortSignal.timeout(1000)});if(response.ok){const identity=await response.json();assert.equal(identity.actorId,owner);ready=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(!ready)throw Error('Owned web server readiness failed');
      runtimeOwnership=captureMemoryRevisionRuntimeOwnership(saved,stage,mode);
      const {checkBrainMemoryRevisionHttp,checkBrainMemoryRevisionBrowser}=await import('./brain-memory-revision-browser.mjs');
      report.checks.push(await checkBrainMemoryRevisionHttp({client,owner,origin,records}));
      if(browserEnabled&&!phase2BrowserOnly&&!phase3BrowserOnly&&!phase4BrowserOnly)report.checks.push(await checkBrainMemoryRevisionBrowser({client,owner,origin,records}));
      if(memoryUpdatesEnabled){const checks=await import('./brain-memory-update-browser.mjs');report.checks.push(await checks.checkBrainMemoryUpdateHttp({client,owner,origin,records}));if(browserEnabled&&!phase3BrowserOnly&&!phase4BrowserOnly)report.checks.push(await checks.checkBrainMemoryUpdateBrowser({client,owner,origin,records}));}
      if(memoryDependenciesEnabled){const checks=await import('./brain-memory-dependency-browser.mjs');report.checks.push(await checks.checkBrainMemoryDependencyHttp({client,owner,origin,records}));if(browserEnabled&&!phase4BrowserOnly)report.checks.push(await checks.checkBrainMemoryDependencyBrowser({client,owner,origin,records}));}
      if(memoryCorrectionsEnabled){const checks=await import('./brain-memory-correction-browser.mjs');report.checks.push(await checks.checkBrainMemoryCorrectionHttp({client,owner,origin,records}));if(browserEnabled)report.checks.push(await checks.checkBrainMemoryCorrectionBrowser({client,owner,origin,records}));}
      if(memoryGovernanceEnabled){const {checkMemoryGovernanceBrowser}=await import('./memory-governance-browser.mjs');report.checks.push(await checkMemoryGovernanceBrowser({client,owner,origin,records,browserEnabled}));}
    }catch(error){report.runtimeFailure={message:error.message,code:error.code,stack:error.stack};throw error;}
    finally{
      if(child.exitCode===null){
        if(process.platform==='win32'){
          try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}
          catch(error){try{process.kill(child.pid,0);throw error;}catch(probe){if(probe.code!=='ESRCH')throw probe;}}
        }else child.kill('SIGTERM');
        await exited;
      }
      if(mode==='development')runtimeOwnership=captureMemoryRevisionRuntimeOwnership(saved,stage,mode);
      fs.closeSync(log);const restoration=restoreMemoryRevisionConfiguration({saved,prepared:runtimeOwnership,records,label:'runtime'});report.runtimeConfiguration=restoration;
      report.runtimeSources.after=captureReleaseSources(root);report.runtimeSources.stable=runtimeSourceBefore.sourceHash===report.runtimeSources.after.sourceHash&&runtimeSourceBefore.revision===report.runtimeSources.after.revision;
      if(restoration.configurationConflict||!restoration.configurationRestored)throw Error('Shared runtime configuration changed; current files and original backups were preserved');
      if(!report.runtimeSources.stable)throw Error('Sources changed during isolated runtime; preserve this partial evidence and repeat against frozen sources');
    }
    }finally{fs.closeSync(configurationLock);fs.unlinkSync(configurationLockPath);}
  }
}catch(error){report.error={message:error.message,code:error.code,stack:error.stack};process.exitCode=1;}
finally{
  try{const {closePostgresDb}=await import('../../lib/db/adapters/postgres.ts');await closePostgresDb();}catch(error){report.connectionCleanupError=error.message;process.exitCode=1;}
  if(client)await client.end();
  if(created){if(!/^zhiyu_test_[a-f0-9]{32}$/.test(name))throw Error('Unexpected fixture identity');await admin.unsafe(`DROP DATABASE "${name}"`);report.cleanup=true;}
  await admin.end();report.completedAt=new Date().toISOString();report.passed=!report.error&&!report.connectionCleanupError&&report.cleanup;
  fs.writeFileSync(path.join(records,'acceptance.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,(key,value)=>key==='files'&&Array.isArray(value)?{count:value.length,manifest:'Full file hashes are saved in acceptance.json'}:value,2));
}
