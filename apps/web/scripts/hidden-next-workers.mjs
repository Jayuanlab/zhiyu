import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

// Next's development static-paths worker omits windowsHide. With Windows Terminal
// as the default console host, each short-lived worker can open a visible window.
// Scope the override to Next's bundled Jest worker; preserve IPC and all other options.
export function hiddenNextWorkerFork(fork){
  return function(modulePath,args,options){
    const target=String(modulePath).replaceAll('\\','/');
    if(!target.endsWith('/next/dist/compiled/jest-worker/processChild.js'))return fork.apply(this,arguments);
    if(Array.isArray(args))return fork.call(this,modulePath,args,{...options,windowsHide:true});
    return fork.call(this,modulePath,{...args,windowsHide:true});
  };
}
let installed=false;
export function installHiddenNextWorkers(){
  if(process.platform!=='win32'||installed)return;
  installed=true;
  childProcess.fork=hiddenNextWorkerFork(childProcess.fork);
  syncBuiltinESMExports();
}
