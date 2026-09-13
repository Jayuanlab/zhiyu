import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawn,execSync=cp.execSync,calls=[];
cp.spawn=function(command,args,options){calls.push({kind:'spawn',hidden:options?.windowsHide});return spawn.call(this,command,args,options);};
cp.execSync=function(command,options){calls.push({kind:'execSync',hidden:options?.windowsHide});return execSync.call(this,command,options);};
syncBuiltinESMExports();
try{
 const {NativeProvider}=await import('../../../../packages/ai/src/agent/sandbox/providers/native.ts');
 const {isCommandAvailable}=await import('../../../../packages/ai/src/agent/sandbox/plugin.ts');
 assert.equal(isCommandAvailable('node'),true);
 const provider=new NativeProvider();
 const success=await provider.exec({command:process.execPath,args:['-e','process.stdout.write("background-ok");process.stderr.write("diagnostic")']});
 assert.equal(success.stdout,'background-ok');assert.equal(success.stderr,'diagnostic');assert.equal(success.exitCode,0);
 const failed=await provider.exec({command:process.execPath,args:['-e','process.exit(7)']});
 assert.equal(failed.exitCode,7);
 assert(calls.length>=3);assert(calls.every(call=>call.hidden===true));
 console.log(JSON.stringify({passed:true,checks:['real_command_discovery_hidden','real_native_spawn_hidden','stdout_stderr_preserved','exit_status_preserved'],calls}));
}finally{cp.spawn=spawn;cp.execSync=execSync;syncBuiltinESMExports();}
