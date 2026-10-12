import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { config, parse } from 'dotenv';
import postgres from 'postgres';
config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
const phase=process.argv[2];assert(['before','after'].includes(phase));
const ownerId='dcb1985e-3fe2-42fd-8978-7b04d1772850';
const dbUrl=process.env.POSTGRES_URL||process.env.DATABASE_URL;
assert(dbUrl&&['localhost','127.0.0.1','[::1]'].includes(new URL(dbUrl).hostname));
const sql=postgres(dbUrl,{max:1,connect_timeout:5,onnotice:()=>{},connection:{statement_timeout:10000}});
const folder='C:/Users/96012/.codex/eval-sandboxes/workshop-chat-control-production-20261009/';
try{
  const observations=await sql.begin('isolation level repeatable read read only',async tx=>{
    const busy=await tx`SELECT r.id,r.workshop_id,r.status FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id WHERE w.user_id=${ownerId}::uuid AND r.status IN ('queued','running','cancel_requested')`;
    const leases=await tx`SELECT i.id,i.phase,i.desired_status,l.lease_until,l.lease_until>clock_timestamp() AS fresh FROM runtime_owner_leases l JOIN runtime_instances i ON i.id=l.instance_id WHERE l.owner_id=${ownerId}::uuid`;
    return {busy,leases};
  });
  const settings=JSON.parse(await readFile(folder+'launch-settings.json','utf8'));
  const launcher=JSON.parse(await readFile(folder+'launcher-state.json','utf8'));
  const buildId=(await readFile(`.tmp/next-review-${settings.review}/BUILD_ID`,'utf8')).trim();
  assert.equal(buildId,settings.buildId);
  const localProxy=parse(await readFile('.env.local','utf8')).TYPESAFE_PROXY_URL;
  assert.equal(localProxy,'http://127.0.0.1:7897');
  let served=null;
  if(phase==='before')assert.equal(observations.busy.length,0,'owner_has_unsettled_runs');
  if(phase==='after'){
    assert.equal(settings.review,'76');
    const response=await fetch(`http://127.0.0.1:${settings.port}/_next/static/${buildId}/_buildManifest.js`,{signal:AbortSignal.timeout(8000)});
    assert.equal(response.status,200);
    const content=await response.text();
    assert.equal(content,await readFile(`.tmp/next-review-${settings.review}/static/${buildId}/_buildManifest.js`,'utf8'));
    assert.equal(launcher.status,'running');
    assert(observations.leases.some(row=>row.phase==='running'&&row.fresh));
    served={status:response.status,bytes:Buffer.byteLength(content),hash:createHash('sha256').update(content).digest('hex')};
  }
  const report={at:new Date().toISOString(),phase,review:settings.review,buildId,launcher,
    ...observations,configuredProxy:localProxy,served,configurationEvidenceScope:'local env readback; a fresh production routing event verifies actual use'};
  const dir=new URL('../../../docs/verification/artifacts/jev-proxy-2026-10-09/',import.meta.url);
  await mkdir(dir,{recursive:true});
  await writeFile(new URL(`deployment-${phase}-${report.at.replaceAll(/[:.]/g,'-')}.json`,dir),JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify(report));
}finally{await sql.end();}
