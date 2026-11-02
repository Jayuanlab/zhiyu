import {readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const retiredPackages=['@anthropic-ai/claude-agent-sdk','@anthropic-ai/claude-code'];
export function inspectPiRetirement(files,read=path=>readFileSync(path,'utf8')){
 const violations=[];let runtimeFiles=0;
 for(const file of files){
  const path=file.replaceAll('\\','/');
  // The isolated HTTP verifier deliberately requests the retired engine to
  // prove rejection; it does not instantiate one.
  if(path.endsWith('/check-pi-retirement-readiness.mjs')||path.endsWith('/verify-pi-only-runtime.mts')||path.includes('/tests/')||/\.test\.[cm]?[jt]sx?$/.test(path)||path.endsWith('.md'))continue;
  if(!/\.(?:[cm]?[jt]sx?|json|yaml|yml)$/.test(path))continue;
  const text=read(file);runtimeFiles++;
  if(path.endsWith('package.json')||path.endsWith('pnpm-lock.yaml')){
   for(const name of retiredPackages)if(text.includes(name))violations.push({path,reason:'retired_dependency',package:name});
  }else{
   const imports=[...text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)].map(match=>match[1]);
   for(const value of imports)if(retiredPackages.some(name=>value===name||value.startsWith(name+'/'))||value.includes('extensions/agent/claude')||value.includes('legacy-agent-adapter'))violations.push({path,reason:'retired_execution_import',import:value});
   if(/(?:provider|engine)\s*:\s*['"]claude['"](?!\s*\|)/.test(text))violations.push({path,reason:'retired_engine_construction'});
  }
 }
 return {passed:violations.length===0,inspectedRuntimeFiles:runtimeFiles,violations};
}

export function checkPiRetirement(root=resolve(process.cwd())){
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','apps','packages','tools','scripts','package.json','pnpm-lock.yaml'],{cwd:root,encoding:'utf8',windowsHide:true}).split(/\r?\n/).filter(Boolean).filter(path=>existsSync(resolve(root,path)));
 const result=inspectPiRetirement(files,path=>readFileSync(resolve(root,path),'utf8'));
 let installedSdk=false;
 try{const path=createRequire(resolve(root,'package.json')).resolve(retiredPackages[0]);installedSdk=!relative(root,path).startsWith('..');}catch{}
 return {...result,installedSdk,passed:result.passed&&!installedSdk,engine:'pi',anthropicMessagesSupported:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=checkPiRetirement();console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
