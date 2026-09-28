import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const root = process.argv[2] || join(tmpdir(), 'zhiyu-agent-harness-0851-eval');
const core = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-agent-core/dist/index.js')));
const ai = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const ctx = core.BACKGROUND_CONTEXT;
const model = { id:'probe', name:'probe', provider:'fake', api:'openai-completions', baseUrl:'http://invalid.local', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:128000, maxTokens:4096 };
const usage = { input:1, output:1, cacheRead:0, cacheWrite:0, totalTokens:2, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
function message(content, stopReason='stop') { return {role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason,timestamp:Date.now()}; }
const results=[];
async function fixture(replies, tools=[]) {
  const repo=new core.MemorySessionRepo();
  const session=await repo.create({},ctx);
  const requests=[];
  const models={getModel:()=>model,streamSimple:(_model,context)=>{
    requests.push(structuredClone(context));
    const stream=new ai.AssistantMessageEventStream();
    const reply=replies.shift() || message([{type:'text',text:'finished'}]);
    stream.push({type:'start',partial:reply});
    if (reply.stopReason==='error') stream.push({type:'error',reason:'error',error:reply});
    else stream.push({type:'done',reason:reply.stopReason,message:reply});
    return stream;
  }};
  const {harness}=await core.AgentHarness.create({session,models,model,tools,toolContext:{},retry:{enabled:true,maxRetries:1,baseDelayMs:1},compaction:{enabled:false,reserveTokens:1024,keepRecentTokens:2048},toolExecution:'sequential'},ctx);
  const lane=await harness.lane('main',ctx);
  return {harness,lane,requests,close:async()=>{await harness.close(ctx);await repo.close(ctx);}};
}
await (async()=>{
  const f=await fixture([message([{type:'text',text:'first'}]),message([{type:'text',text:'second'}])]);
  try {
    const first=await f.lane.prompt('one',ctx); assert.equal(first.ok,true);
    const second=await f.lane.prompt('two',ctx); assert.equal(second.ok,true);
    assert.ok(f.requests[1].messages.some(x=>x.role==='assistant'));
    const watch=await f.lane.watch(ctx); assert.ok(watch.snapshot.transcript.length>=4); watch.unsubscribe();
    results.push({test:'two turns preserve history and lane snapshot',pass:true,requests:f.requests.length});
    await assert.rejects(()=>f.harness.watchSession(ctx),/not implemented|watchSession/i);
    results.push({test:'session-wide watch is unimplemented',confirmed:true});
  } finally {await f.close();}
})();
await (async()=>{
  let calls=0;
  const tool={name:'controlled_write',label:'controlled_write',description:'probe only',parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{calls++;return {content:[{type:'text',text:'written'}],details:{}};}};
  const f=await fixture([message([{type:'toolCall',id:'call-1',name:tool.name,arguments:{}}],'toolUse')],[tool]);
  try {
    f.harness.hooks.on('before_tool',()=>{throw new Error('policy unavailable');});
    const errors=[];f.harness.events.on('handler_error',e=>errors.push(e));
    await f.lane.prompt('try tool',ctx);
    assert.equal(calls,0);assert.ok(errors.length>0);
    results.push({test:'before_tool exception prevents execution',pass:true,calls});
  } finally {await f.close();}
})();
await (async()=>{
  const f=await fixture([message([{type:'text',text:'ok'}])]);
  try {
    const errors=[];f.harness.events.on('handler_error',e=>errors.push(e));
    f.harness.hooks.on('transform_context',()=>{throw new Error('redactor unavailable');});
    await f.lane.prompt('marker-that-should-be-redacted',ctx);
    assert.equal(f.requests.length,1);assert.ok(JSON.stringify(f.requests[0]).includes('marker-that-should-be-redacted'));assert.ok(errors.length>0);
    results.push({test:'transform_context exception continues with original context',confirmed:true,providerCalled:true});
  } finally {await f.close();}
})();
await (async()=>{
  const failed={...message([],'error'),errorMessage:'503 service unavailable'};
  const f=await fixture([failed,message([{type:'text',text:'recovered'}])]);
  try {
    const retries=[];f.harness.events.on('retry_scheduled',e=>retries.push(e));
    const result=await f.lane.prompt('retry once',ctx);
    assert.equal(result.ok,true);assert.equal(f.requests.length,2);assert.equal(retries.length,1);
    results.push({test:'transient model error schedules and completes retry',pass:true,requests:2});
  } finally {await f.close();}
})();
await (async()=>{
  const f=await fixture([]);
  try {
    const admitted=await f.lane.accept({kind:'prompt',operationId:'cancel-before-drive',prompt:'do not execute'},ctx);
    assert.equal(admitted.ok,true);
    const aborted=await f.lane.requestAbort('cancel-before-drive',ctx);assert.equal(aborted.ok,true);
    await f.lane.drive({operationId:'cancel-before-drive'},ctx);
    assert.equal(f.requests.length,0);
    results.push({test:'abort before drive prevents model dispatch',pass:true,requests:0});
  } finally {await f.close();}
})();
console.log(JSON.stringify({version:'0.85.1',mode:'fake model, memory repo, no network or business actions',results},null,2));
