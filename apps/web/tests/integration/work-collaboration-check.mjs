import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {parse} from 'dotenv';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';

const web = resolve(import.meta.dirname, '../..');
const root = resolve(web, '../..');
const env = {};
for (const file of [resolve(root, '.env'), resolve(web, '.env')]) {
  if (existsSync(file)) Object.assign(env, parse(readFileSync(file)));
}
Object.assign(env, process.env);
const adminUrl = new URL(env.ZHIYU_TEST_ADMIN_URL || env.POSTGRES_URL || env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname)) throw Error('Isolated database requires loopback');
const database = `zhiyu_test_${randomUUID().replaceAll('-', '')}`;
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), {max: 1, onnotice: () => {}});
let client;
try {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${database}`;
  process.env.POSTGRES_URL = testUrl.toString();
  process.env.DATABASE_URL = testUrl.toString();
  process.env.ZHIYU_TEST_DATABASE_URL = testUrl.toString();
  process.env.ZHIYU_TEST_MODE = 'integration';
  process.env.NODE_ENV = 'test';
  client = postgres(testUrl.toString(), {max: 1, onnotice: () => {}});
  await migrate(drizzle(client), {migrationsFolder: resolve(web, 'lib/db/migrations')});
  const service = await import('../../lib/workshops/collaboration.ts');
  const ownerId = randomUUID(), otherOwnerId = randomUUID();
  const requesterWorkId = randomUUID(), recipientWorkId = randomUUID(), foreignWorkId = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES
    (${ownerId},'collab-owner@example.invalid'),(${otherOwnerId},'collab-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission,model_config) VALUES
    (${requesterWorkId},${ownerId},'sales','serve customers',
      ${JSON.stringify({collaboration:{allowedRecipients:[recipientWorkId]}})}::jsonb),
    (${recipientWorkId},${ownerId},'memory','research retrieval',
      ${JSON.stringify({collaboration:{acceptedKinds:['consult'],offeredCapabilities:['memory-diagnosis']}})}::jsonb),
    (${foreignWorkId},${otherOwnerId},'foreign','unrelated','{}'::jsonb)`;
  const peers = await service.listCollaborationPeers(ownerId, requesterWorkId);
  assert.deepEqual(peers.map(peer => peer.id), [recipientWorkId]);
  const base = {ownerId, requesterWorkId, recipientWorkId, kind:'consult',
    neededCapability:'memory-diagnosis', problem:'Saved report is missing from recall',
    desiredOutcome:'Find the reason', whyHelpNeeded:'Sales cannot inspect memory retrieval',
    acceptanceCriteria:'A repeat query finds the report', commandId:'case-001-create'};
  const created = await service.createCollaborationRequest(base);
  assert.equal(created.status, 'delivered');
  assert.equal(created.recipientRunId, null);
  assert.equal((await service.createCollaborationRequest(base)).id, created.id);
  await assert.rejects(service.createCollaborationRequest({...base, problem:'different'}),
    error => error.code === 'command_conflict');
  await assert.rejects(service.getCollaborationRequest(otherOwnerId, foreignWorkId, created.id),
    error => error.code === 'request_not_found');
  await assert.rejects(service.actOnCollaborationRequest({ownerId,workId:requesterWorkId,requestId:created.id,
    action:'accept',expectedVersion:1,commandId:'case-001-wrong'}), error => error.code === 'wrong_actor');
  const accepted = await service.actOnCollaborationRequest({ownerId,workId:recipientWorkId,requestId:created.id,
    action:'accept',expectedVersion:1,commandId:'case-001-accept'});
  assert.equal(accepted.version, 2);
  const replied = await service.actOnCollaborationRequest({ownerId,workId:recipientWorkId,requestId:created.id,
    action:'reply',expectedVersion:2,commandId:'case-001-reply',detail:'Indexing lag; retry after refresh.'});
  assert.equal(replied.status, 'replied');
  const verified = await service.actOnCollaborationRequest({ownerId,workId:requesterWorkId,requestId:created.id,
    action:'verify',expectedVersion:3,commandId:'case-001-verify',detail:'Repeat query now finds the report.'});
  assert.equal(verified.status, 'verified');
  assert.equal((await service.actOnCollaborationRequest({ownerId,workId:requesterWorkId,requestId:created.id,
    action:'verify',expectedVersion:3,commandId:'case-001-verify',detail:'Repeat query now finds the report.'})).version, 4);
  assert.equal((await service.getCollaborationRequest(ownerId, requesterWorkId, created.id)).events.length, 4);
  const notice = await service.createCollaborationRequest({...base,kind:'notice',acceptanceCriteria:null,commandId:'case-notice-create'});
  const acknowledged = await service.actOnCollaborationRequest({ownerId,workId:recipientWorkId,requestId:notice.id,
    action:'acknowledge',expectedVersion:1,commandId:'case-notice-ack'});
  assert.equal(acknowledged.status, 'verified');
  const clarification = await service.createCollaborationRequest({...base,commandId:'case-clarify-create'});
  await service.actOnCollaborationRequest({ownerId,workId:recipientWorkId,requestId:clarification.id,
    action:'request_info',expectedVersion:1,commandId:'case-clarify-ask',detail:'Which report ID?'});
  const supplied = await service.actOnCollaborationRequest({ownerId,workId:requesterWorkId,requestId:clarification.id,
    action:'provide_info',expectedVersion:2,commandId:'case-clarify-answer',detail:'Report ID is 123.'});
  assert.equal(supplied.status, 'delivered');
  const originRunId = randomUUID(), sourceEventId = randomUUID();
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${originRunId},${requesterWorkId},'running')`;
  await client`INSERT INTO workshop_events(id,workshop_id,run_id,seq,type,title)
    VALUES (${sourceEventId},${requesterWorkId},${originRunId},1,'observation','Recall gap observed')`;
  const autonomous = await service.createCollaborationRequest({...base,commandId:'case-002-autonomous',actorType:'work',
    originRunId,sourceEventIds:[sourceEventId]});
  assert.equal(autonomous.status, 'delivered');
  assert.ok(autonomous.recipientRunId);
  const queued = await client`SELECT status FROM workshop_runs WHERE id=${autonomous.recipientRunId}`;
  assert.equal(queued[0].status, 'queued');
  await service.actOnCollaborationRequest({ownerId,workId:recipientWorkId,requestId:autonomous.id,
    action:'accept',expectedVersion:1,commandId:'case-002-accept',actorType:'work'});
  const autonomousReply = await service.actOnCollaborationRequest({ownerId,workId:recipientWorkId,requestId:autonomous.id,
    action:'reply',expectedVersion:2,commandId:'case-002-reply',detail:'Investigated the index.',actorType:'work'});
  assert.equal(autonomousReply.status, 'replied');
  const followUps = await client`SELECT id FROM workshop_runs WHERE workshop_id=${requesterWorkId}
    AND trigger_reason->>'requestId'=${autonomous.id}`;
  assert.equal(followUps.length, 1);
  const secondAutonomous = await service.createCollaborationRequest({...base,commandId:'case-002-clarification',actorType:'work',
    originRunId,sourceEventIds:[sourceEventId]});
  await service.actOnCollaborationRequest({ownerId,workId:recipientWorkId,requestId:secondAutonomous.id,
    action:'request_info',expectedVersion:1,commandId:'case-002-ask-info',detail:'Please provide the report ID.',actorType:'work'});
  const moreInfo = await service.actOnCollaborationRequest({ownerId,workId:requesterWorkId,requestId:secondAutonomous.id,
    action:'provide_info',expectedVersion:2,commandId:'case-002-provide-info',detail:'Report 123.',actorType:'work'});
  assert.notEqual(moreInfo.recipientRunId, secondAutonomous.recipientRunId);
  assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${moreInfo.recipientRunId}`)[0].status, 'queued');
  await assert.rejects(service.createCollaborationRequest({...base,commandId:'case-003-wrong-capability',
    neededCapability:'trading',actorType:'work',originRunId,sourceEventIds:[sourceEventId]}), error => error.code === 'collaboration_not_allowed');
  await assert.rejects(service.createCollaborationRequest({...base,commandId:'case-004-foreign',
    recipientWorkId:foreignWorkId,actorType:'work',originRunId,sourceEventIds:[sourceEventId]}), error => error.code === 'work_not_found');
  await assert.rejects(service.createCollaborationRequest({...base,commandId:'case-005-no-evidence',
    actorType:'work',originRunId}), error => error.code === 'work_help_requires_run_and_evidence');
  const foreignEventId = randomUUID();
  await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title)
    VALUES (${foreignEventId},${foreignWorkId},1,'observation','private evidence')`;
  await assert.rejects(service.createCollaborationRequest({...base,commandId:'case-006-foreign-evidence',
    actorType:'work',originRunId,sourceEventIds:[foreignEventId]}), error => error.code === 'source_event_not_owned');
  await client`UPDATE workshops SET boundary_policy=${JSON.stringify({hardDeniedActions:['workshopAskColleague']})}::jsonb
    WHERE id=${requesterWorkId}`;
  await assert.rejects(service.createCollaborationRequest({...base,commandId:'case-007-denied',
    actorType:'work',originRunId,sourceEventIds:[sourceEventId]}), error => error.code === 'collaboration_not_allowed');
  const failedRequest = await service.createCollaborationRequest({...base,commandId:'case-attention-failed'});
  const failedRunId = randomUUID();
  await client`INSERT INTO workshop_runs(id,workshop_id,status,error)
    VALUES (${failedRunId},${recipientWorkId},'failed','model unavailable')`;
  await client`UPDATE work_collaboration_requests SET recipient_run_id=${failedRunId}
    WHERE id=${failedRequest.id}`;
  assert.equal((await service.scanCollaborationAttention({ownerId})).marked, 1);
  const attention = await service.getCollaborationRequest(ownerId,requesterWorkId,failedRequest.id);
  assert.equal(attention.request.attentionReason, 'recipient_run_failed');
  assert.equal(attention.events.at(-1).action, 'attention');
  assert.equal((await service.scanCollaborationAttention({ownerId})).marked, 0);
  const staleRequest = await service.createCollaborationRequest({...base,commandId:'case-attention-overdue'});
  await client`UPDATE work_collaboration_requests SET due_at=clock_timestamp()-interval '1 hour'
    WHERE id=${staleRequest.id}`;
  assert.equal((await service.scanCollaborationAttention({ownerId})).marked, 1);
  const overdue = await service.getCollaborationRequest(ownerId,requesterWorkId,staleRequest.id);
  assert.equal(overdue.request.attentionReason, 'response_overdue');
  const closed = await service.actOnCollaborationRequest({ownerId,workId:requesterWorkId,requestId:staleRequest.id,
    action:'cancel',expectedVersion:overdue.request.version,commandId:'case-attention-cancel'});
  assert.equal(closed.attentionReason, null);
  assert.equal((await service.scanCollaborationAttention({ownerId})).marked, 0);
  const manualDelivery = await service.createCollaborationRequest({...base,commandId:'case-manual-delivery'});
  await assert.rejects(service.queueCollaborationDelivery({ownerId,requesterWorkId:recipientWorkId,
    requestId:manualDelivery.id,expectedVersion:1,commandId:'case-manual-wrong'}),
    error => error.code === 'wrong_actor');
  const firstDelivery = await service.queueCollaborationDelivery({ownerId,requesterWorkId,
    requestId:manualDelivery.id,expectedVersion:1,commandId:'case-manual-queue'});
  assert.ok(firstDelivery.recipientRunId);
  assert.equal(firstDelivery.version, 2);
  assert.equal((await service.queueCollaborationDelivery({ownerId,requesterWorkId,
    requestId:manualDelivery.id,expectedVersion:1,commandId:'case-manual-queue'})).recipientRunId,
    firstDelivery.recipientRunId);
  await assert.rejects(service.queueCollaborationDelivery({ownerId,requesterWorkId,
    requestId:manualDelivery.id,expectedVersion:2,commandId:'case-manual-repeat'}),
    error => error.code === 'prior_run_requires_review');
  await client`UPDATE workshop_runs SET status='failed',error='model unavailable'
    WHERE id=${firstDelivery.recipientRunId}`;
  await assert.rejects(service.queueCollaborationDelivery({ownerId,requesterWorkId,
    requestId:manualDelivery.id,expectedVersion:2,commandId:'case-manual-retry-no-proof'}),
    error => error.code === 'no_effect_evidence_required');
  const retried = await service.queueCollaborationDelivery({ownerId,requesterWorkId,
    requestId:manualDelivery.id,expectedVersion:2,commandId:'case-manual-retry',
    confirmedNoEffect:true,evidence:'Checked prior run and found no external effects.'});
  assert.notEqual(retried.recipientRunId, firstDelivery.recipientRunId);
  assert.equal((await service.getCollaborationRequest(ownerId,requesterWorkId,manualDelivery.id)).events.at(-1).action,
    'queue_delivery');
  const externalEffectRequest = await service.createCollaborationRequest({...base,commandId:'case-external-effect'});
  const withEffect = await service.queueCollaborationDelivery({ownerId,requesterWorkId,
    requestId:externalEffectRequest.id,expectedVersion:1,commandId:'case-external-queue'});
  await client`UPDATE workshop_runs SET status='failed' WHERE id=${withEffect.recipientRunId}`;
  await client`INSERT INTO workshop_outbox(workshop_id,run_id,message,status)
    VALUES (${recipientWorkId},${withEffect.recipientRunId},'external message','sent')`;
  await assert.rejects(service.queueCollaborationDelivery({ownerId,requesterWorkId,
    requestId:externalEffectRequest.id,expectedVersion:2,commandId:'case-external-retry',
    confirmedNoEffect:true,evidence:'I checked that no action should have occurred.'}),
    error => error.code === 'prior_effect_not_clear');
  console.log(JSON.stringify({passed:true,checks:43}));
} finally {
  if (client) await client.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
}
