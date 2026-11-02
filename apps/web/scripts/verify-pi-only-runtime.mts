/** Real HTTP through the isolated production Web host. No live owner changes. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startModelProviderFixture} from './model-provider-fixture.mjs';
const app=process.env.MODEL_TEST_APP_URL;
if(app!=='http://127.0.0.1:3516'||!process.env.MODEL_FIXTURE_OWNER)throw Error('isolated_fixture_app_required');
assert.equal((await (await fetch(app+'/api/auth/session')).json()).user.id,process.env.MODEL_FIXTURE_OWNER);
const fixture=await startModelProviderFixture(),checks:string[]=[];
async function request(path:string,body?:unknown,method=body?'POST':'GET'){
 const response=await fetch(app+path,{method,headers:{'Content-Type':'application/json',Origin:app!},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 return {status:response.status,text:await response.text()};
}
function events(text:string){return text.split('\n\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));}
try{
 const providers=JSON.parse((await request('/api/native/providers')).text);
 assert.deepEqual(providers.agents.map((agent:any)=>agent.type),['pi']);checks.push('only_pi_registered');
 for(const protocol of ['openai_compatible','openai_responses','anthropic_compatible']){
  const current=JSON.parse((await request('/api/preferences/models')).text),id='pi_only_fixture';
  const saved=await request('/api/preferences/models',{expectedRevision:current.revision,document:{connections:[{id,name:'Pi plan fixture',enabled:true,protocol,model:'plan',baseUrl:fixture.baseUrl}],defaultConnectionId:id,defaults:{openai_compatible:null,openai_responses:null,anthropic_compatible:null},assignments:{}},secretUpdates:{[id]:'local-fixture-key'}},'PUT');assert.equal(saved.status,200,saved.text);
  const planResult=await request('/api/native/agent',{provider:'pi',phase:'plan',prompt:'Prepare a short plan for a source-backed explanation.',allowedTools:[]});assert.equal(planResult.status,200,planResult.text);
  const planned=events(planResult.text);assert.ok(!planned.some(event=>event.type==='error'),planResult.text);
  const proposal=planned.find(event=>event.type==='plan');assert.ok(proposal?.plan?.id,planResult.text);assert.equal(proposal.plan.goal,'Fixture reviewed goal');assert.equal(proposal.plan.steps[0].status,'pending');assert.ok(proposal.sourceLineage.version.startsWith('mplan1:'));
  assert.equal(fixture.observed.at(-1)!.body.tools?.length??0,0);
  const before=fixture.observed.length;
  const stale=await request('/api/native/agent',{provider:'pi',phase:'execute',prompt:'Approve fixture',planId:proposal.plan.id,planVersion:'mplan1:'+'0'.repeat(64),planCommandId:randomUUID(),allowedTools:[]});assert.equal(stale.status,409,stale.text);assert.equal(fixture.observed.length,before);
  const executed=await request('/api/native/agent',{provider:'pi',phase:'execute',prompt:'Approve fixture',planId:proposal.plan.id,planVersion:proposal.sourceLineage.version,planCommandId:randomUUID(),allowedTools:[]});assert.equal(executed.status,200,executed.text);
  const completed=events(executed.text);assert.ok(!completed.some(event=>event.type==='error'),executed.text);assert.ok(completed.some(event=>event.type==='runtime_terminal'&&event.runtimeTerminal?.status==='completed'&&event.runtimeTerminal.cleanupStatus==='completed'),executed.text);assert.ok(completed.some(event=>event.type==='result'),executed.text);
  checks.push(protocol+':real_plan_persisted_lineage_stale_approval_denied_and_pi_execution');
 }
 const before=fixture.observed.length;
 assert.equal((await request('/api/native/agent',{provider:'claude',prompt:'fixture'})).status,400);
 assert.equal((await request('/api/native/agent',{provider:'pi',prompt:'fixture',modelConfig:{apiKey:'forged'}})).status,400);
 assert.equal(fixture.observed.length,before);checks.push('retired_engine_and_connection_override_rejected_before_provider');
 console.log(JSON.stringify({ok:true,checks,externalProviderCalled:false},null,2));
}finally{await fixture.close();}
