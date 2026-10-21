import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });
const proxyUrl=process.argv[2];
assert.equal(proxyUrl,'http://127.0.0.1:7897','owner_system_proxy_required');
process.env.TYPESAFE_PROXY_URL=proxyUrl;
assert(process.env.TYPESAFE_API_KEY,'key_missing');
const { fetchTypesafe } = await import("../lib/memory/retrieval/jev-fetch.ts");
const { routeRecallWithJev } = await import("../lib/memory/retrieval/jev-recall-router.ts");
const router=await readFile(new URL('../lib/memory/retrieval/jev-recall-router.ts',import.meta.url),'utf8');
const block=router.match(/const criteria:[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1];
const criteria=Object.fromEntries([...(block??'').matchAll(/^\s*(architecture|records|knowledge|brain):\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)].map(m=>[m[1],JSON.parse(m[2])]));
assert.equal(Object.keys(criteria).length,4);
const question='How is the public example software project organized into modules?';
const report={at:new Date().toISOString(),proxyUrl,model:'jev-1.13.0',publicSyntheticInput:true,networkRequests:0};
const started=performance.now();
try {
  report.networkRequests++;
  const response=await fetchTypesafe('https://api.typesafe.ai/v1/systemone',{
    method:'POST',headers:{Authorization:`Bearer ${process.env.TYPESAFE_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:report.model,state:{question},questions:Object.fromEntries(Object.entries(criteria).map(([name,instructions])=>[name,{type:'noul',instructions}]))}),
    signal:AbortSignal.timeout(8000),
  });
  report.httpStatus=response.status;
  if(response.ok){
    const value=await response.json();
    report.schemaValid=Object.keys(criteria).every(name=>value?.answers?.[name]?.type==='noul'&&Number.isFinite(value.answers[name].noul)&&value.answers[name].noul>=0&&value.answers[name].noul<=1);
    report.returnedModel=value.model;
  } else {await response.body?.cancel();report.schemaValid=false;}
}catch(error){report.errorType=error?.name??'unknown';report.errorCode=/^[A-Z_0-9]+$/.test(error?.cause?.code??'')?error.cause.code:null;}
report.transportElapsedMs=Math.round(performance.now()-started);
if(report.httpStatus===200&&report.schemaValid){
  report.networkRequests++;
  const route=await routeRecallWithJev(question,undefined,{enabled:true});
  report.actualRouter={status:route.status,detail:route.detail,elapsedMs:route.elapsedMs,model:route.model,sources:route.sources,
    sourceProbabilities:route.sourceProbabilities,uncertainSources:route.uncertainSources};
}
report.providerAvailable=report.httpStatus===200&&report.schemaValid===true;
report.routingDecisionConfident=report.actualRouter?.status==='ok';
// A valid uncertain source decision is a working provider, not a transport failure.
report.passed=report.providerAvailable&&(report.routingDecisionConfident||report.actualRouter?.detail==='uncertain_route');
const dir=new URL('../../../docs/verification/artifacts/jev-proxy-2026-10-09/',import.meta.url);
await mkdir(dir,{recursive:true});
await writeFile(new URL(`proxy-probe-${report.at.replaceAll(/[:.]/g,'-')}.json`,dir),JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify(report));
if(!report.passed)process.exitCode=1;
