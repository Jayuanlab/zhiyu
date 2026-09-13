import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {checkLoopMigrationBrowser} from './loop-migration-browser.mjs';

export async function checkLoopDevelopment({env,databaseUrl,client,web,root,recordPrefix='10A',browserCheck=checkLoopMigrationBrowser,ownerId,mode='development',reviewStage='65',managed=false}){
  if(!['development','production'].includes(mode)||!/^\d{2}$/.test(reviewStage))throw Error('Invalid isolated browser runtime');
  const owner=ownerId??randomUUID(),origin='http://127.0.0.1:3537';
  if(!ownerId)await client`INSERT INTO "User"(id,email) VALUES (${owner},'loop-layout@example.invalid')`;
  const saved=['tsconfig.json','next-env.d.ts'].map(name=>({file:path.join(web,name),bytes:fs.readFileSync(path.join(web,name))}));
  const log=fs.openSync(path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-${mode}.log`),'w');
  const args=managed?['--import','tsx',path.join(web,'scripts/start-managed-application.mjs'),mode==='development'?'dev':'start']:mode==='development'?[path.join(web,'scripts/start-local-development.mjs'),'--port','3537','--hostname','127.0.0.1']:
    [path.join(root,'node_modules/next/dist/bin/next'),'start','-p','3537','-H','127.0.0.1'];
  const child=spawn(process.execPath,args,{
    cwd:web,windowsHide:true,stdio:managed?['ignore',log,log,'ipc']:['ignore',log,log],env:{...env,NODE_ENV:mode,NODE_OPTIONS:'--max-old-space-size=8192',NODE_PATH:path.join(root,'node_modules'),ZHIYU_REVIEW_BUILD:reviewStage,AUTH_MODE:'local_owner',DEV_USER_ID:owner,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',WORK_HARNESS_EVOLUTION_ENABLED:'false',REPORT_QUALITY_EVALUATOR_ENABLED:'false',TAURI_MODE:'false',IS_TAURI:'false',...(managed?{PORT:'3537',DEV_WARMUP:'0',ZHIYU_RUNTIME_MODE:'worker',ZHIYU_RUNTIME_OWNER_ID:owner,ENABLE_LOCAL_SCHEDULER:'true',QUANT_PAPER_ACCOUNT_ID:'',QUANT_PAPER_OWNER_ID:'',QUANT_PAPER_SIGNING_KEY:'',QUANT_INTERNAL_TOKEN:''}:{})}
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try{
    let ready=false;
    for(let n=0;n<120;n++){
      if(child.exitCode!==null)throw Error('Development server exited');
      try{const response=await fetch(origin+'/api/identity',{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!ready)throw Error('Development server did not become ready');
    const checks=await browserCheck({client,owner,origin,root,recordPrefix,child,databaseUrl,legacyConversion:true,responsive:true,legacyReview:recordPrefix==='06E9'});
    fs.writeFileSync(path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-browser.json`),JSON.stringify(checks,null,2));
    return {name:browserCheck===checkLoopMigrationBrowser?`${mode} Loop migration and responsive operation`:`${mode} browser verification`,passed:true,mode,checks};
  }finally{
    try{
      if(managed&&child.exitCode===null&&child.connected){
        child.send('stop',()=>{});
        let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,40000);})]);clearTimeout(timer);
      }
      if(child.exitCode===null){
        if(process.platform==='win32'){
          try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}
          catch(error){
            // Ignore a vanished descendant only when the owned server is gone.
            try{process.kill(child.pid,0);throw error;}
            catch(probe){if(probe.code!=='ESRCH')throw probe;}
          }
        }else child.kill('SIGTERM');
        await exited;
      }
    }finally{
      fs.closeSync(log);
      for(const item of saved)fs.writeFileSync(item.file,item.bytes);
    }
  }
}
