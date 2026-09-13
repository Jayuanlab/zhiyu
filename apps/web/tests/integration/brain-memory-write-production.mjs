import assert from 'node:assert/strict';
export async function checkBrainMemoryWriteProduction({client,owner,request,review=false,extendedReview=false}){
  const response=await request('/api/brain/memories',{scope:{type:'global'},subject:'production memory fixture',content:'生产候选记忆回测',status:'candidate'});
  assert.equal(response.status,200);
  const {memory}=await response.json();
  assert.equal(memory.userId,owner);assert.equal(memory.ownerType,'chat');
  assert.equal(memory.ownerId,owner);assert.equal(memory.content,'生产候选记忆回测');
  const stored=(await client`SELECT user_id,owner_id,scope_type,scope_id,content,status FROM brain_memories WHERE id=${memory.id}`)[0];
  assert.equal(stored.user_id,owner);assert.equal(stored.owner_id,owner);
  assert.equal(stored.scope_type,'global');assert.equal(stored.scope_id,null);
  assert.equal(stored.content,'生产候选记忆回测');assert.equal(stored.status,'candidate');
  if(review){
    for(const body of [undefined,{},[],{decision:'typo'}]){
      const rejected=await request(`/api/brain/candidates/${memory.id}/review`,body);
      assert.equal(rejected.status,400);assert.equal((await rejected.json()).code,'invalid_decision');
    }
    assert.equal((await client`SELECT status FROM brain_memories WHERE id=${memory.id}`)[0].status,'candidate');
    assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${memory.id}`)[0].n,0);
    const response=await request(`/api/brain/candidates/${memory.id}/review`,{decision:'confirmed',reason:'生产审核回测'});
    assert.equal(response.status,200);
    const reviewed=(await response.json()).memory;
    assert.equal(reviewed.status,'verified');assert.equal(reviewed.content,memory.content);
    const stored=(await client`SELECT status,content FROM brain_memories WHERE id=${memory.id}`)[0];
    assert.equal(stored.status,'verified');assert.equal(stored.content,memory.content);
    const audit=await client`SELECT user_id,decision,reason,metadata FROM brain_memory_reviews WHERE memory_id=${memory.id}`;
    assert.equal(audit.length,1);assert.equal(audit[0].user_id,owner);
    assert.equal(audit[0].decision,'confirmed');assert.equal(audit[0].reason,'生产审核回测');
    assert.equal(audit[0].metadata.previousStatus,'candidate');assert.equal(audit[0].metadata.nextStatus,'verified');
  }
  if(extendedReview){
    for(const decision of ['weakened','active']){
      const response=await request(`/api/brain/candidates/${memory.id}/review`,{decision,reason:'状态必须保真'});
      assert.equal(response.status,200);assert.equal((await response.json()).memory.status,decision);
      assert.equal((await client`SELECT status FROM brain_memories WHERE id=${memory.id}`)[0].status,decision);
      assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${memory.id} AND decision=${decision}`)[0].n,1);
    }
  }
  return {ownerCandidateWrite:true,globalScope:true,utf8RoundTrip:true,ownerReview:review,extendedReview};
}
