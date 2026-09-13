import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {RuntimeHostStore} from '../../lib/runtime/host-store.ts';
import {getRuntimeWorkerStatus} from '../../lib/runtime/worker-status.ts';
export async function checkRuntimeStatusRead({client,databaseUrl}){
  const owner=randomUUID(),stranger=randomUUID(),instance=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'runtime-status@example.invalid'),(${stranger},'runtime-status-other@example.invalid')`;
  const a=postgres(databaseUrl,{max:1}),b=postgres(databaseUrl,{max:1}),read=drizzle(b);
  try{
    const store=new RuntimeHostStore(a),lease=await store.acquire(owner,instance,'worker',10000);
    const module={name:'paper-matching',phase:'error',inFlight:false,lastStartedAt:Date.now(),lastCompletedAt:Date.now(),lastSuccessAt:null,nextRunAt:Date.now()+10000,lastError:'paper_migration_required',durationMs:1,skipReason:null,skipped:0};
    await store.heartbeat(lease,10000,[module],'paused');
    const query=statement=>read.execute(statement);
    const snapshot=await getRuntimeWorkerStatus(owner,query);
    assert.equal(snapshot.online,true);assert.equal(snapshot.instanceId,instance);assert.equal(snapshot.desiredStatus,'paused');
    assert.equal(snapshot.modules[0].lastError,'paper_migration_required');assert.ok(snapshot.heartbeatAgeMs>=0);
    assert.equal((await getRuntimeWorkerStatus(stranger,query)).online,false);
    await client`UPDATE runtime_owner_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE owner_id=${owner}`;
    assert.equal((await getRuntimeWorkerStatus(owner,query)).online,false);
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${owner}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM runtime_instances WHERE owner_id=${stranger}`)[0].n,0);
    return {name:'read-only durable runtime status: owner isolation, live paused host, failed module and expired heartbeat',passed:true};
  }finally{await Promise.all([a.end(),b.end()]);}
}
