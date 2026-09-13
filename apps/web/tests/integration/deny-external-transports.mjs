// Checkpoint CLI test: database sockets remain available, but model/HTTP and
// subprocess actions fail locally. Only tsx's workspace esbuild service may run.
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const esbuild=path.join(root,'node_modules/@esbuild/win32-x64/esbuild.exe').toLowerCase();
const denied=()=>{throw Error('External transport disabled in checkpoint CLI test');};
globalThis.fetch=denied;http.request=denied;http.get=denied;https.request=denied;https.get=denied;
for(const name of ['spawn','spawnSync','execFile','execFileSync']){
  const original=childProcess[name];
  childProcess[name]=function(file,...args){if(path.resolve(String(file)).toLowerCase()!==esbuild)return denied();return original.call(this,file,...args);};
}
for(const name of ['exec','execSync','fork'])childProcess[name]=denied;
syncBuiltinESMExports();
