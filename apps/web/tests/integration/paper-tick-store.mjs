import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {PaperTickStore} from '../../lib/runtime/paper-tick-store.ts';
export async function checkPaperTickStore({client,databaseUrl}){
  const owner=randomUUID(),account=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'paper-tick@example.invalid')`;
  const a=postgres(databaseUrl,{max:1}),b=postgres(databaseUrl,{max:1});
  try{
    const first=new PaperTickStore(a),second=new PaperTickStore(b);
    const [one,two]=await Promise.all([first.prepare(owner,account),second.prepare(owner,account)]);
    assert.equal(one,two);assert.ok(one.endsWith(':1'));
    assert.equal(await new PaperTickStore(b).prepare(owner,account),one);
    const receipt={commandId:one,version:1,result:{status:'completed',matched:[],waiting:{}}};
    assert.equal(await first.complete(owner,account,one,receipt),true);
    assert.equal(await second.complete(owner,account,one,receipt),false);
    assert.equal(await second.prepare(owner,account),null);
    const [saved]=await b`SELECT receipt FROM runtime_paper_ticks WHERE owner_id=${owner} AND account_id=${account}`;
    assert.deepEqual(saved.receipt,receipt);
    await client`UPDATE runtime_paper_ticks SET next_tick_at=clock_timestamp()-interval '1 second' WHERE owner_id=${owner} AND account_id=${account}`;
    const next=await second.prepare(owner,account);assert.ok(next.endsWith(':2'));
    assert.equal(await first.complete(owner,account,one,receipt),false);
    assert.equal(await first.prepare(owner,account),next);
    return {name:'durable paper ticks: concurrent prepare, restart reuses pending ID, receipt, cadence and stale completion fence',passed:true};
  }finally{await Promise.all([a.end(),b.end()]);}
}
