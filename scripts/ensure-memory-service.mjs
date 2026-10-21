import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
/** Operator-only deployment bootstrap. No business task is started; failures stay visible in Web. */
export async function ensureMemoryService({directory,checkout}){
 const connectionFile=path.join(directory,'connection.json'),config=JSON.parse(fs.readFileSync(connectionFile,'utf8'));
 if(config.mode==='local')return{mode:'local',started:false};
 async function ready(){try{const r=await fetch(config.origin+'/v1/project/call',{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify({operation:'status',input:{}}),redirect:'error',signal:AbortSignal.timeout(1000)});return r.ok&&(await r.json()).ready===true;}catch{return false;}}
 if(await ready())return{mode:'remote',ready:true,started:false};
 let supervisorAlive=false;
 try{const s=JSON.parse(fs.readFileSync(path.join(directory,'service-status.json'),'utf8'));if(s.state!=='stopped'&&Date.now()-Date.parse(s.heartbeatAt)<15000){process.kill(s.supervisorPid,0);supervisorAlive=true;}}catch{}
 const stopFile=path.join(directory,'service-stop.json');
 if(fs.existsSync(stopFile))return{mode:'remote',ready:false,reason:'operator_stopped',started:false};
 let started=false,lock;
 const lockFile=path.join(directory,'bootstrap.lock');
 try{
 if(!supervisorAlive){
  try{
   lock=fs.openSync(lockFile,'wx');
   const child=spawn(process.execPath,[path.join(checkout,'scripts/supervise.mjs'),path.join(directory,'deployment.json')],{cwd:checkout,windowsHide:true,detached:true,stdio:'ignore'});child.unref();started=true;
  }catch(error){if(error.code!=='EEXIST')throw error;}
 }
 for(let n=0;n<40;n++){if(await ready())return{mode:'remote',ready:true,started};await new Promise(r=>setTimeout(r,250));}
 return{mode:'remote',ready:false,reason:'startup_unavailable',started};
 }finally{if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(lockFile);}}
}
