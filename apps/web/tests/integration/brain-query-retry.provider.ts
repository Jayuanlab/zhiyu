import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildBrainRecallPlan } from "@/lib/brain/recall-planner";

const received: any[]=[];
const server=createServer(async(request,response)=>{
  let body="";for await(const chunk of request)body+=chunk;
  received.push(JSON.parse(body));
  response.writeHead(200,{"content-type":"application/json"});
  response.end(JSON.stringify({id:"fixture",object:"chat.completion",created:1,model:"fixture",
    choices:[{index:0,message:{role:"assistant",content:JSON.stringify({
      searchTerms:["delivery","delay"],scopes:[{type:"work",workId:"alpha"}],updatedAfter:"2026-09-01T00:00:00Z",
      queryRetry:{query:"alpha September delivery postponement",searchTerms:["postponement"],reason:"Equivalent wording"},
    })},finish_reason:"stop"}],usage:{prompt_tokens:50,completion_tokens:50,total_tokens:100}}));
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=(server.address() as {port:number}).port;
const settings={BRAIN_RECALL_PLANNER_LLM_API_KEY:"fixture-only",BRAIN_RECALL_PLANNER_LLM_BASE_URL:`http://127.0.0.1:${port}/v1`,BRAIN_RECALL_PLANNER_LLM_MODEL:"fixture"};
const previous=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
Object.assign(process.env,settings);
try{
  const original="Why was alpha delivery delayed in September?";
  const plan=await buildBrainRecallPlan({requester:{type:"work",userId:"u",id:"alpha",workId:"alpha"},taskIntent:original});
  assert.equal(plan.mode,"llm",JSON.stringify(plan.warnings));
  assert.deepEqual(plan.queryRetry,{query:"alpha September delivery postponement",searchTerms:["postponement"],reason:"Equivalent wording"});
  assert.equal(plan.updatedAfter,"2026-09-01T00:00:00.000Z");
  assert.equal(received.length,1);
  assert.ok(JSON.stringify(received[0].messages).includes(original));
  assert.ok(JSON.stringify(received[0].messages).includes("queryRetry"));
  console.log(JSON.stringify({passed:true,localHttpProvider:true,actualSdk:true,requests:received.length,rewriteParsed:true,datePreserved:true,originalInPrompt:true,paidModel:false}));
}finally{
  for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
