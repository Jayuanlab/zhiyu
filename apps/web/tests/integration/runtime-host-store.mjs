import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {RuntimeHostStore} from '../../lib/runtime/host-store.ts';

export async function checkRuntimeHostStore({client,databaseUrl}){
  const owner=randomUUID(),other=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'host-test@example.invalid'),(${other},'host-other@example.invalid')`;
  const a=postgres(databaseUrl,{max:1}),b=postgres(databaseUrl,{max:1});
  try{
    const one=new RuntimeHostStore(a),two=new RuntimeHostStore(b),ids=[randomUUID(),randomUUID()];
    const claims=await Promise.all([one.acquire(owner,ids[0],'worker',10000),two.acquire(owner,ids[1],'worker',10000)]);
    assert.equal(claims.filter(Boolean).length,1);
    const lease=claims.find(Boolean);
    assert.deepEqual(await one.acquire(owner,lease.instanceId,'worker',10000),lease);
    const state={name:'ingest',phase:'running',inFlight:true,lastStartedAt:1000,lastCompletedAt:null,lastSuccessAt:null,
      nextRunAt:0,lastError:null,durationMs:null,skipReason:null,skipped:0};
    assert.equal(await one.heartbeat(lease,10000,[state]),true);
    assert.equal((await two.status(owner)).modules[0].inFlight,true);
    assert.equal(await two.status(other),null);
    await assert.rejects(one.release(lease,[state]),/host_operations_unsettled/);
    await client`UPDATE runtime_owner_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE owner_id=${owner}`;
    assert.equal((await one.status(owner)).online,false);
    assert.equal(await one.heartbeat(lease,10000,[]),false);
    const successor=await two.acquire(owner,randomUUID(),'worker',10000);
    assert.equal(successor.token,lease.token+1);
    assert.equal(await one.release(lease,[]),false);
    assert.equal(await one.heartbeat(lease,10000,[]),false);
    assert.equal((await one.status(owner)).instance_id,successor.instanceId);
    const [{phase}]=await client`SELECT phase FROM runtime_instances WHERE id=${lease.instanceId}`;
    assert.equal(phase,'lost');
    assert.equal(await two.release(successor,[]),true);
    assert.equal((await one.status(owner)).online,false);
    return {name:'runtime host database fence, heartbeat, expiry takeover and settled release',passed:true};
  }finally{await a.end();await b.end();}
}
