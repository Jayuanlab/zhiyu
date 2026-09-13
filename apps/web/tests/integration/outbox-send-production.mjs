import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';

export async function withFakeWechat(check) {
  const token=randomUUID(), receipts=new Map(),resolutions=new Map();
  const state={sends:0,effects:0,sendCommandIds:[],queries:0,resolutionCalls:0,resolutions:0,unknownNextSend:false,dropNextResolutionResponse:false};
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw||'{}');
      const reply=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
      if(req.url==='/preview')return reply({ok:true,requiresConfirmation:true,confirmToken:'isolated-token',expiresInSeconds:300,preview:{...body,messageHash:'fake-hash'}});
      if(req.url==='/send'){
        assert(body.commandId);state.sends++;
        state.sendCommandIds.push(body.commandId);
        if(!state.unknownNextSend){state.effects++;receipts.set(body.commandId,{status:'sent',result:{sent:true,backend:'fake-window'}});}
        state.unknownNextSend=false;
        res.destroy();return;
      }
      if(req.url==='/send-status'){
        state.queries++;const receipt=receipts.get(body.commandId);
        return reply(receipt?{ok:true,...receipt}:{ok:true,status:'not_found'});
      }
      if(req.url==='/resolve-send'){
        state.resolutionCalls++;
        const key=JSON.stringify(body),old=resolutions.get(body.resolutionId);
        if(old){if(old.key!==key){res.writeHead(409).end();return;}return reply(old.receipt);}
        const known=receipts.get(body.commandId);
        if(known&&known.status!==body.decision){res.writeHead(409).end();return;}
        const receipt={ok:true,...(known??{status:body.decision,result:{ok:true,resolution:{id:body.resolutionId,decision:body.decision,actorId:body.actorId,evidence:body.evidence,source:'owner_attestation'}}})};
        receipts.set(body.commandId,receipt);resolutions.set(body.resolutionId,{key,receipt});state.resolutions++;
        if(state.dropNextResolutionResponse){state.dropNextResolutionResponse=false;res.destroy();return;}
        return reply(receipt);
      }
      res.writeHead(404).end();
    }catch(error){res.writeHead(500).end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{return await check({WECHAT_DESKTOP_SERVICE_URL:`http://127.0.0.1:${server.address().port}`,WECHAT_DESKTOP_TOKEN:token},state);}
  finally{await new Promise(resolve=>server.close(resolve));}
}

export async function checkOutboxSendProduction({client,owner,request,state,reconcile=false}){
  const work=randomUUID(),outbox=randomUUID();
  const policy={externalMessages:'draft',allowedRecipients:['recipient'],requireSourcesForOutbox:false,minConfidenceToSend:0,minConfidenceToDraft:0};
  await client`INSERT INTO workshops(id,user_id,name,mission,autonomy_level,boundary_policy) VALUES (${work},${owner},'HTTP send test','isolated','draft',${JSON.stringify(policy)}::jsonb)`;
  await client`INSERT INTO workshop_outbox(id,workshop_id,status,recipient_name,message,confidence,risk_level) VALUES (${outbox},${work},'pending_approval','recipient','isolated test',100,'low')`;
  const endpoint=`/api/workshops/${work}/outbox/${outbox}`;
  assert.equal((await request(endpoint+'/send',{})).status,400);
  assert.equal(state.sends,0);
  if(reconcile)assert.equal((await request(endpoint+'/reconcile',{})).status,404);
  const preview=await request(endpoint+'/preview',{});
  assert.equal(preview.status,200,await preview.clone().text());
  const row=(await client`SELECT boundary_result FROM workshop_outbox WHERE id=${outbox}`)[0];
  const expectedContentHash=row.boundary_result.wechatPreview.contentHash;
  assert.match(expectedContentHash,/^[a-f0-9]{64}$/);
  assert.equal((await request(endpoint+'/send',{expectedContentHash:'0'.repeat(64)})).status,409);
  assert.equal(state.sends,0);
  const lost=await request(endpoint+'/send',{expectedContentHash});
  assert.equal(lost.status,400,await lost.clone().text());
  assert.equal((await client`SELECT status FROM workshop_outbox WHERE id=${outbox}`)[0].status,'unknown');
  assert.equal(state.sends,1);
  if(reconcile){
    const summary=await (await request(`/api/page-state/workshop/${work}/summary?refresh=1`,undefined,'GET')).json();
    assert.equal(summary.dashboard.counts.outboxUnknown,1);assert.equal(summary.dashboard.counts.pendingOutbox,1);
    await client`UPDATE workshops SET boundary_policy='{"externalMessages":"blocked"}'::jsonb WHERE id=${work}`;
  }
  const recovered=await request(endpoint+(reconcile?'/reconcile':'/send'),{expectedContentHash});
  assert.equal(recovered.status,200,await recovered.clone().text());
  assert.equal((await client`SELECT status FROM workshop_outbox WHERE id=${outbox}`)[0].status,'sent');
  assert.equal((await request(endpoint+(reconcile?'/reconcile':'/send'),{expectedContentHash})).status,200);
  assert.equal(state.sends,1);assert.equal(state.queries,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_outbox_attempts WHERE outbox_id=${outbox}`)[0].n,1);
  return {passed:true,sendCalls:state.sends,statusQueries:state.queries,responseLossRecovered:true,previewHashRequired:true,reconcileAfterPolicyRevocation:reconcile};
}
