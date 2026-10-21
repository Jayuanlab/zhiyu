import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Only a runner-owned loopback server with a fresh synthetic database. */
export async function checkMemoryModuleT2Http({ client, owner, origin, records, mode }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const database = (await client`SELECT current_database() AS name`)[0].name;
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL).pathname, `/${database}`);
  const { createOwnerMemoryClient } = await import('../../lib/memory/index.ts');
  const { createInteractionTask } = await import('../../lib/interactions/service.ts');
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + path, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    return { status: response.status, value: await response.json() };
  };
  const identity = await request('/api/identity');
  assert.equal(identity.status, 200); assert.equal(identity.value.actorId, owner); assert.equal(identity.value.mode, 'local_owner');
  const foreignUser = randomUUID(), source = randomUUID(), foreignSource = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${foreignUser},${foreignUser + '@example.invalid'})`;
  for (const [id, user] of [[source, owner], [foreignSource, foreignUser]]) await client`INSERT INTO interaction_events
    (id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${id},${user},'fixture','memory_module_t2_http','synthetic conversation','Synthetic T2 source','2026-10-01T00:00:00Z',${randomUUID()})`;
  const scenarioKey = `t2-http-${randomUUID()}`, hint = { type: 'project', key: scenarioKey, title: 'Synthetic HTTP scenario' };
  const createBody = title => ({ kind: 'task', commandId: randomUUID(), title, sourceEventIds: [source], metadata: { scenarioHints: [hint] } });
  const create = async body => {
    const result = await request('/api/interactions/wiki', body);
    assert.equal(result.status, 201); assert.ok(result.value.task); return result.value.task;
  };
  const readTask = async id => {
    const result = await request('/api/memory/read', { purpose: 'current', ref: { kind: 'interaction_task', id } });
    assert.equal(result.status, 200); assert.equal(result.value.status, 'ok');
    assert.ok(result.value.ref.revision.startsWith(`task:${result.value.record.revision}:`));
    assert.equal(result.value.record.metadata.taskState.version, result.value.record.revision);
    assert.equal(result.value.receipt.purpose, 'current'); assert.deepEqual(result.value.receipt.ref, result.value.ref);
    return result.value;
  };
  const firstBody = createBody('\u5408\u6210 HTTP task');
  const copies = await Promise.all([create(firstBody), create(firstBody)]);
  assert.equal(copies[0].id, copies[1].id); assert.equal(copies[0].revision, 0);
  const changed = await request('/api/interactions/wiki', { ...firstBody, title: 'Conflicting HTTP creation' });
  assert.equal(changed.status, 409);
  const first = copies[0];
  const commands = ['completeTask', 'dismiss'].map(action => ({ kind: 'task', id: first.id, action, expectedVersion: 0, commandId: randomUUID() }));
  const races = await Promise.all(commands.map(command => request('/api/interactions/wiki', command, 'PATCH')));
  assert.deepEqual(races.map(result => result.status).sort(), [200, 409]);
  const winner = races.findIndex(result => result.status === 200);
  assert.equal(races[winner].value.receipt.fromVersion, 0); assert.equal(races[winner].value.receipt.toVersion, 1);
  const replayed = await request('/api/interactions/wiki', commands[winner], 'PATCH');
  assert.equal(replayed.status, 200); assert.equal(replayed.value.replayed, true);
  assert.equal(replayed.value.receipt.id, races[winner].value.receipt.id);
  assert.equal(replayed.value.resultSemantics, 'command_result_at_revision');
  const conflict = await request('/api/interactions/wiki', { ...commands[winner], expectedVersion: 1 }, 'PATCH');
  assert.equal(conflict.status, 409);
  const missingVersion = await request('/api/interactions/wiki', { kind: 'task', id: first.id, status: 'done' }, 'PATCH');
  assert.equal(missingVersion.status, 400);
  const reopen = await request('/api/interactions/wiki', { kind: 'task', id: first.id, status: 'confirmed', commandId: randomUUID(), expectedVersion: 1 }, 'PATCH');
  assert.equal(reopen.status, 409);

  const current = await readTask(first.id); assert.equal(current.record.revision, 1);
  const explanation = await request(`/api/memory/receipts/${current.receipt.id}`);
  assert.equal(explanation.status, 200); assert.equal(explanation.value.status, 'ok');
  assert.deepEqual(explanation.value.receipt.ref, current.ref);
  assert.ok(!JSON.stringify(explanation.value).includes(first.title), 'State receipt explanations do not repeat the task body');
  const scenario = await request('/api/memory/read', { purpose: 'current', ref: { kind: 'scenario_state', scenarioType: 'project', scenarioKey } });
  assert.equal(scenario.status, 200); assert.equal(scenario.value.status, 'ok');
  assert.ok(scenario.value.record.content.closedLoops.some(task => task.id === first.id && task.stateRevision === 1));
  assert.equal(scenario.value.record.content.authority, 'model_estimate_unverified');
  assert.deepEqual(scenario.value.receipt.ref, scenario.value.ref);

  const foreignKey = `t2-foreign-${randomUUID()}`;
  const foreign = await createInteractionTask({ userId: foreignUser, commandId: randomUUID(), title: 'FOREIGN_T2_TASK_BODY',
    sourceEventIds: [foreignSource], metadata: { scenarioHints: [{ ...hint, key: foreignKey }] } });
  const foreignClient = createOwnerMemoryClient(foreignUser);
  const foreignCurrent = await foreignClient.read({ purpose: 'current', ref: { kind: 'interaction_task', id: foreign.id } });
  assert.equal(foreignCurrent.status, 'ok');
  for (const ref of [{ kind: 'interaction_task', id: foreign.id }, { kind: 'scenario_state', scenarioType: 'project', scenarioKey: foreignKey }]) {
    const denied = await request('/api/memory/read', { purpose: 'current', ref });
    assert.equal(denied.status, 200); assert.equal(denied.value.status, 'not_found');
    assert.ok(!JSON.stringify(denied.value).includes('FOREIGN_T2_TASK_BODY')); assert.ok(!denied.value.receipt);
  }
  const deniedReceipt = await request(`/api/memory/receipts/${foreignCurrent.receipt.id}`);
  assert.equal(deniedReceipt.status, 200); assert.equal(deniedReceipt.value.status, 'not_found');
  const deniedAction = await request('/api/interactions/wiki', { kind: 'task', id: foreign.id, action: 'completeTask', commandId: randomUUID(), expectedVersion: 0 }, 'PATCH');
  assert.equal(deniedAction.status, 409);

  const deletion = { kind: 'task', id: first.id, commandId: randomUUID(), expectedVersion: 1 };
  const removed = await request('/api/interactions/wiki', deletion, 'DELETE');
  assert.equal(removed.status, 200); assert.equal(removed.value.task.revision, 2);
  const removedAgain = await request('/api/interactions/wiki', deletion, 'DELETE');
  assert.equal(removedAgain.status, 200); assert.equal(removedAgain.value.task.revision, 2);
  const historical = await request('/api/interactions/wiki', commands[winner], 'PATCH');
  assert.equal(historical.status, 200); assert.equal(historical.value.task.revision, 1);
  assert.equal(historical.value.resultSemantics, 'command_result_at_revision');
  assert.equal((await readTask(first.id)).record.revision, 2);

  const second = await create(createBody('Synthetic legacy status task'));
  const status = await request('/api/interactions/wiki', { kind: 'task', id: second.id, status: 'confirmed', commandId: randomUUID(), expectedVersion: 0 }, 'PATCH');
  assert.equal(status.status, 200); assert.equal(status.value.task.revision, 1);
  const third = await create(createBody('Synthetic clear task'));
  const cleared = await request('/api/interactions/wiki', { action: 'clear_all', reason: 'synthetic T2 HTTP fixture' }, 'DELETE');
  assert.equal(cleared.status, 200); assert.equal(cleared.value.deletedTasks, 2);
  assert.equal((await readTask(second.id)).record.status, 'deleted'); assert.equal((await readTask(second.id)).record.revision, 2);
  assert.equal((await readTask(third.id)).record.status, 'deleted'); assert.equal((await readTask(third.id)).record.revision, 1);

  const alive = await create(createBody('Synthetic projection rollback task'));
  const counts = async () => (await client`SELECT
    (SELECT count(*) FROM interaction_tasks WHERE user_id=${owner})::int AS tasks,
    (SELECT count(*) FROM interaction_task_revisions WHERE user_id=${owner})::int AS history,
    (SELECT count(*) FROM brain_state_snapshots WHERE user_id=${owner})::int AS scenarios`)[0];
  const before = await counts(), trigger = `reject_t2_http_${randomUUID().replaceAll('-', '')}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.snapshot_type='wechat_scenario_state' THEN RAISE EXCEPTION 'injected T2 HTTP projection failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  const failingCreate = createBody('Synthetic failed HTTP create');
  try {
    const attempts = [
      ['/api/interactions/wiki', failingCreate, 'POST'],
      ['/api/interactions/wiki', { kind: 'task', id: alive.id, action: 'completeTask', commandId: randomUUID(), expectedVersion: 0 }, 'PATCH'],
      ['/api/interactions/wiki', { kind: 'task', id: alive.id, status: 'done', commandId: randomUUID(), expectedVersion: 0 }, 'PATCH'],
      ['/api/interactions/wiki', { kind: 'task', id: alive.id, commandId: randomUUID(), expectedVersion: 0 }, 'DELETE'],
      ['/api/interactions/wiki', { action: 'clear_all' }, 'DELETE'],
    ];
    for (const [path, body, method] of attempts) {
      const failure = await request(path, body, method); assert.ok(failure.status >= 500, `A projection fault must fail the ${method} route`);
      assert.deepEqual(await counts(), before); assert.equal((await readTask(alive.id)).record.revision, 0);
    }
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_state_snapshots`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  const recovery = await create(failingCreate); assert.equal(recovery.revision, 0);
  const { checkMemoryModuleT2Browser } = await import('./memory-module-t2-browser.mjs');
  const desktop = await checkMemoryModuleT2Browser({ client, owner, origin, records, mode, create, createBody });
  return { name: 'T2 real owner HTTP task writers, state read receipts and atomic L2 projection', passed: true,
    desktop,
    authentication: 'owned_loopback_local_owner_synthetic_identity', databaseScope: 'synthetic_isolated',
    checks: ['idempotent concurrent creation', 'same-version action race and fixed historical replay', 'changed expectedVersion conflict',
      'legacy HTTP status requires command/version', 'terminal reopening denied', 'exact task/scenario with safe read receipt explanation',
      'foreign records/receipt/actions withheld', 'single delete retry', 'legacy status and clear history', 'all writer projection faults roll back', 'same-create-command recovery'],
    limits: ['authenticated-session login flow not exercised', 'no existing application instance accessed', 'no external action or model invoked', 'historical task full-text evidence is not claimed'] };
}
