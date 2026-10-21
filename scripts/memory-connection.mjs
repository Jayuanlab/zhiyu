import fs from 'node:fs';
import path from 'node:path';
const file=process.env.ZHIYU_MEMORY_CONNECTION_FILE??path.resolve('.runtime/memory-service-deployment/connection.json');
const mode=process.argv[2];
if(!['local','remote','status'].includes(mode))throw Error('Usage: node scripts/memory-connection.mjs local|remote|status');
const config=JSON.parse(fs.readFileSync(file,'utf8'));
if(mode==='status'){console.log(JSON.stringify({mode:config.mode,origin:config.origin,ownerId:config.ownerId,automaticFallback:false}));}
else{
 if(mode==='remote'){
  const response=await fetch(new URL('/v1/project/call',config.origin),{method:'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},body:JSON.stringify({operation:'status',input:{}}),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok||!(await response.json()).ready)throw Error('Remote service must be ready before switching');
 }
 config.mode=mode;
 // Existing file is deliberately written in place: retain the operator's restrictive ACL.
 fs.writeFileSync(file,JSON.stringify(config,null,2));
 console.log(JSON.stringify({mode,sameAuthoritativeRecords:true,automaticReplay:false}));
}
