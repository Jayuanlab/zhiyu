import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });
const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error('key_missing');
const router = await readFile(new URL('../lib/brain/jev-recall-router.ts',import.meta.url),'utf8');
const block=router.match(/const criteria:[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1];
const criteria=Object.fromEntries([...(block??'').matchAll(/^\s*(architecture|records|knowledge|brain):\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)].map(m=>[m[1],JSON.parse(m[2])]));
if (Object.keys(criteria).length!==4) throw new Error('criteria_missing');
const sanitize = text => String(text).replaceAll(key,'[credential]').replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [credential]')
  .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g,'[credential]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[ip]')
  .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,'[email]').slice(0,2048);
const started=performance.now();
const report={at:new Date().toISOString(),model:'jev-1.13.0',publicSyntheticInput:true,requests:1};
try {
  const response=await fetch('https://api.typesafe.ai/v1/systemone',{
    method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:report.model,state:{question:'How is the public example software project organized into modules?'},
      questions:Object.fromEntries(Object.entries(criteria).map(([name,instructions])=>[name,{type:'noul',instructions}]))}),
    signal:AbortSignal.timeout(8000),
  });
  report.httpStatus=response.status;
  report.contentType=response.headers.get('content-type');
  report.server=response.headers.get('server');
  if (!response.ok) report.providerError=sanitize(await response.text());
  else report.providerError=null;
} catch(error) {report.transportError=sanitize(error?.name??'unknown');}
report.elapsedMs=Math.round(performance.now()-started);
const dir=new URL('../../../docs/verification/artifacts/jev-availability-2026-10-09/',import.meta.url);
await mkdir(dir,{recursive:true});
await writeFile(new URL(`provider-error-${report.at.replaceAll(/[:.]/g,'-')}.json`,dir),JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify(report));
