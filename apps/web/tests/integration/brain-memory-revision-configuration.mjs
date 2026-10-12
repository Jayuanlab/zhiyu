import path from 'node:path';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;

export function captureMemoryRevisionConfiguration(saved){
  return saved.map(file=>{try{return {file:path.basename(file.file),sha256:digest(fs.readFileSync(file.file)),mtimeMs:fs.statSync(file.file).mtimeMs};}catch(error){return {file:path.basename(file.file),readError:error.code??error.message};}});
}

// Dev may generate only its own type references. Do not claim unrelated changes.
export function captureMemoryRevisionRuntimeOwnership(saved,stage,mode){
  return saved.map(file=>{
    const originalHash=digest(file.bytes),name=path.basename(file.file);
    if(mode!=='development')return {file:name,sha256:originalHash};
    try{
      const current=fs.readFileSync(file.file),original=file.bytes.toString('utf8');let owned=false;
      if(name==='next-env.d.ts')owned=current.toString('utf8')===original.replace(/\.tmp\/next-review-\d{2}\/(?:dev\/)?types\//g,`.tmp/next-review-${stage}/dev/types/`);
      if(name==='tsconfig.json'){
        const before=JSON.parse(original),after=JSON.parse(current.toString('utf8'));
        const generated=new Set([`.tmp/next-review-${stage}/types/**/*.ts`,`.tmp/next-review-${stage}/dev/types/**/*.ts`]);
        before.include=before.include?.filter(value=>!generated.has(value));after.include=after.include?.filter(value=>!generated.has(value));
        owned=JSON.stringify(ordered(before))===JSON.stringify(ordered(after));
      }
      return {file:name,sha256:owned?digest(current):originalHash,ownedGeneratedState:owned};
    }catch{return {file:name,sha256:originalHash,ownedGeneratedState:false};}
  });
}

export function restoreMemoryRevisionConfiguration({saved,prepared,records,label='build'}){
  const backup=path.join(records,'configuration-before',label),conflict=path.join(records,'configuration-conflict',label);
  fs.mkdirSync(backup,{recursive:true});const restorationDecisions=[];
  for(const file of saved){
    const name=path.basename(file.file),originalHash=digest(file.bytes),expectedHash=prepared?.find(value=>value.file===name)?.sha256??originalHash;
    fs.writeFileSync(path.join(backup,name),file.bytes);
    let current;try{current=fs.readFileSync(file.file);}catch(error){restorationDecisions.push({file:name,action:'preserved_conflict',readError:error.code??error.message,originalBackup:path.join(backup,name)});continue;}
    const currentHash=digest(current);
    if(currentHash===originalHash){restorationDecisions.push({file:name,action:'already_original'});continue;}
    if(currentHash===expectedHash){fs.writeFileSync(file.file,file.bytes);restorationDecisions.push({file:name,action:'restored_owned'});continue;}
    fs.mkdirSync(conflict,{recursive:true});fs.writeFileSync(path.join(conflict,name),current);
    restorationDecisions.push({file:name,action:'preserved_conflict',currentHash,expectedHash,originalBackup:path.join(backup,name),currentBackup:path.join(conflict,name)});
  }
  const restored=captureMemoryRevisionConfiguration(saved),configurationRestored=saved.every((file,index)=>restored[index].sha256===digest(file.bytes));
  return {restored,restorationDecisions,configurationRestored,configurationConflict:restorationDecisions.some(value=>value.action==='preserved_conflict')};
}

// This is configuration preparation, not a substitute for Next build type checks.
export async function prepareMemoryRevisionNextConfiguration({web,config,appDir,pagesDir}){
  const require=createRequire(path.join(web,'package.json'));
  const {verifyAndRunTypeScript}=require('next/dist/lib/verify-typescript-setup.js');
  const {Worker}=require('next/dist/lib/worker.js');
  const options={dir:web,distDir:config.distDir,strictRouteTypes:Boolean(config.experimental.strictRouteTypes),shouldRunTypeCheck:false,tsconfigPath:config.typescript.tsconfigPath,typedRoutes:Boolean(config.typedRoutes),disableStaticImages:config.images.disableStaticImages,cacheDir:path.join(web,config.distDir,'cache'),hasAppDir:!!appDir,hasPagesDir:!!pagesDir,appDir,pagesDir};
  await verifyAndRunTypeScript(options);
  const worker=new Worker(require.resolve('next/dist/lib/verify-typescript-setup.js'),{exposedMethods:['verifyAndRunTypeScript'],debuggerPortOffset:-1,isolatedMemory:false,numWorkers:1,enableWorkerThreads:config.experimental.workerThreads,maxRetries:0});
  try{await worker.verifyAndRunTypeScript(options);}finally{await worker.end();}
  return {kind:'next_configuration_preparation',typeChecksRun:false,mainPreparationPassed:true,sameNextWorkerPreparationPassed:true};
}
