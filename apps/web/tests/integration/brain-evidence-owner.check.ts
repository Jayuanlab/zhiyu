import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {resolveBrainEvidenceRefs} from '@/lib/brain/evidence-reader';
export async function checkEvidenceOwner(client:postgres.Sql){
  const owner=randomUUID(),other=randomUUID(),ownWork=randomUUID(),foreignWork=randomUUID(),ownEvent=randomUUID(),foreignEvent=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'evidence-owner@example.invalid'),(${other},'evidence-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${ownWork},${owner},'Own work','fixture'),(${foreignWork},${other},'Other work','fixture')`;
  await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title,body) VALUES (${ownEvent},${ownWork},1,'observation','Own source','Owner evidence'),(${foreignEvent},${foreignWork},1,'observation','Private source','Other owner private evidence')`;
  const hints=new Map([[ownEvent,[{ownerType:'work',ownerId:ownWork}]],[foreignEvent,[{ownerType:'work',ownerId:foreignWork}]]]);
  const first=await resolveBrainEvidenceRefs({userId:owner,evidenceRefs:[ownEvent,foreignEvent],ownerHintsByRef:hints});
  assert.equal(first[0].status,'resolved');assert.equal(first[0].content,'Owner evidence');
  assert.equal(first[1].status,'unresolved','A forged source owner hint must not reveal another owner workshop event');assert.equal(first[1].content,null);
  const mixed=await resolveBrainEvidenceRefs({userId:owner,evidenceRefs:[ownEvent,'legacy:not-a-uuid'],ownerHintsByRef:new Map([...hints,['legacy:not-a-uuid',[{ownerType:'work',ownerId:ownWork},{ownerType:'chat',ownerId:owner}]]])});
  assert.equal(mixed[0].status,'resolved');assert.equal(mixed[1].status,'unresolved');
  await client`UPDATE workshops SET user_id=${other} WHERE id=${ownWork}`;
  const changedOwner=await resolveBrainEvidenceRefs({userId:owner,evidenceRefs:[ownEvent],ownerHintsByRef:hints});assert.equal(changedOwner[0].status,'unresolved');assert.equal(changedOwner[0].content,null);
  await client`UPDATE workshops SET user_id=${owner} WHERE id=${ownWork}`;
  await client`DELETE FROM workshop_events WHERE id=${ownEvent}`;
  const deleted=await resolveBrainEvidenceRefs({userId:owner,evidenceRefs:[ownEvent],ownerHintsByRef:hints});assert.equal(deleted[0].status,'unresolved');assert.equal(deleted[0].createdAt,null);
  return {name:'evidence reader enforces source owner, tolerates invalid legacy refs and reports deleted sources',passed:true,crossOwnerUnresolved:true,validEvidenceSurvivesInvalidRef:true,changedSourceOwnerUnresolved:true,deletedSourceUnresolved:true};
}
