import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type postgres from "postgres";
import { buildBrainContextFromMemoryRequest } from "@/lib/brain/service";
import { completeBrainRecallRetryAudit } from "@/lib/brain/repository";

export async function checkQueryRetry(client: postgres.Sql) {
  const owner = randomUUID(), other = randomUUID(), work = randomUUID(), otherWork = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},${owner+'@example.invalid'}),(${other},${other+'@example.invalid'})`;
  const wanted = randomUUID();
  const fixtures = [
    [wanted, owner, work, "verified", 90, "2026-09-10", null],
    [randomUUID(), other, work, "verified", 90, "2026-09-10", null],
    [randomUUID(), owner, otherWork, "verified", 90, "2026-09-10", null],
    [randomUUID(), owner, work, "candidate", 90, "2026-09-10", null],
    [randomUUID(), owner, work, "verified", 20, "2026-09-10", null],
    [randomUUID(), owner, work, "verified", 90, "2020-01-01", null],
    [randomUUID(), owner, work, "verified", 90, "2026-09-10", "2020-01-01"],
  ] as const;
  for (const [id, user, scope, status, confidence, updated, expires] of fixtures) {
    await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,updated_at,expires_at)
      VALUES (${id},${user},'work',${scope},'work',${scope},'fact','Delivery note','postponement pending supplier confirmation',${status},${confidence},${updated},${expires})`;
  }
  // Expired fixture is selected by SQL then denied by policy. Exercise this separately below.
  const expired = fixtures[6][0];
  await client`UPDATE brain_memories SET content='expiry-only' WHERE id=${expired}`;
  const before = JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id IN (${owner},${other}) ORDER BY id`);
  const plan = {
    statuses: ["verified"], scopes: [{type:"work",workId:work}], minConfidence: 80,
    updatedAfter: "2026-09-01T00:00:00Z", searchTerms: Array.from({length:12},(_,i)=>`unmatched${i}`),
    includeCandidates:false, maxItems:5, memoryLimit:40,
    routes:[{route:"brain_memory",purpose:"canonical",enabled:true,reason:"fixture"}],
    rationale:["fixture"], warnings:[],
    queryRetry:{query:"delivery postponement",searchTerms:["unused-a","unused-b","unused-c","unused-d","unused-e","postponement"],reason:"Equivalent delivery wording"},
  };
  let requests = 0;
  const server = createServer(async (req,res) => {
    for await (const _ of req) { /* drain SDK request */ }
    requests++;
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({id:"fixture",object:"chat.completion",created:1,model:"fixture",
      choices:[{index:0,message:{role:"assistant",content:JSON.stringify(plan)},finish_reason:"stop"}],
      usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port = (server.address() as {port:number}).port;
  const settings = {BRAIN_RECALL_PLANNER_LLM_API_KEY:"fixture-only",BRAIN_RECALL_PLANNER_LLM_BASE_URL:`http://127.0.0.1:${port}/v1`,BRAIN_RECALL_PLANNER_LLM_MODEL:"fixture",BRAIN_RECALL_QUERY_RETRY_ENABLED:"true"};
  const previous = Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
  Object.assign(process.env,settings);
  try {
    const input = {requester:{type:"work" as const,userId:owner,id:work,workId:work},taskIntent:"Why was delivery delayed?"};
    const result = await buildBrainContextFromMemoryRequest(input);
    assert.equal(requests,1,"No second planner call");
    assert.equal(result.recallPlan.mode,"llm");
    assert.equal(result.queryRetryTrace.attempts,2);
    assert.deepEqual(result.items.map(item=>item.id),[wanted]);
    assert.equal(result.queryRetryTrace.contextLogIds.length,2);
    const logs = await client`SELECT * FROM brain_context_logs WHERE user_id=${owner} ORDER BY created_at,id`;
    assert.equal(logs.length,2);
    const first = logs.find(row=>row.id===result.queryRetryTrace.contextLogIds[0])!;
    const final = logs.find(row=>row.id===result.contextLogId)!;
    assert.deepEqual(first.selected_memory_ids,[]);
    assert.deepEqual(final.selected_memory_ids,[wanted]);
    assert.equal(final.task_intent,input.taskIntent);
    assert.equal(final.metadata.recallQuery.executed,"delivery postponement");
    assert.equal(final.metadata.candidateFilters.searchTerms.length,18);
    assert.deepEqual(final.metadata.queryRetryOutcome,result.queryRetryTrace);
    const audit = {userId:owner,contextLogId:result.contextLogId!,outcome:result.queryRetryTrace};
    await Promise.all([completeBrainRecallRetryAudit(audit),completeBrainRecallRetryAudit(audit)]);
    await assert.rejects(completeBrainRecallRetryAudit({...audit,userId:other}));
    await assert.rejects(completeBrainRecallRetryAudit({...audit,outcome:{...result.queryRetryTrace,attempts:1}}));
    assert.deepEqual((await client`SELECT metadata FROM brain_context_logs WHERE id=${result.contextLogId!}`)[0].metadata,final.metadata);
    const disabled = await buildBrainContextFromMemoryRequest({...input,allowQueryRetry:false});
    assert.equal(disabled.queryRetryTrace.attempts,1);
    assert.equal(disabled.queryRetryTrace.stopReason,"disabled");
    plan.searchTerms=["expiry-only"];
    const expiredResult=await buildBrainContextFromMemoryRequest(input);
    assert.equal(expiredResult.queryRetryTrace.attempts,1);
    assert.equal(expiredResult.queryRetryTrace.stopReason,"access_denied");
    assert.ok(expiredResult.denied.some(item=>item.id===expired));
    assert.equal(JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id IN (${owner},${other}) ORDER BY id`),before,"Recall must not rewrite facts");
    return {name:"real database recall retry with local model fixture",passed:true,plannerRequestsPerRecall:1,attempts:2,found:wanted,logs:2,filtersPreserved:true,foreignUserAndWorkExcluded:true,auditOwnerIsolation:true,concurrentReplay:true,conflictingAuditDenied:true,expiredDenialStopsRetry:true,memoriesUnchanged:true};
  } finally {
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
}
