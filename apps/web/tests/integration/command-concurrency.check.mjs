import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

export async function checkCommandConcurrency({env, databaseUrl, client, web}) {
  const ownerId = randomUUID(), workId = randomUUID(), commandId = randomUUID();
  await client`INSERT INTO "User" (id,email) VALUES (${ownerId},'concurrent-command@example.invalid')`;
  await client`INSERT INTO workshops (id,user_id,name,mission) VALUES (${workId},${ownerId},'0','command concurrency')`;
  const children = [];
  function spawn(id, version, crash = false) {
    const child = fork(path.join(web, 'tests/integration/command-ledger.worker.ts'), [], {
      cwd: web, execArgv: ['--import','tsx','--conditions=react-server'], silent: true,
      env: {...env, NODE_ENV: 'test', TAURI_MODE: 'false', IS_TAURI: 'false', ZHIYU_TEST_MODE: 'integration',
        ZHIYU_TEST_DATABASE_URL: databaseUrl, POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl,
        ZHIYU_TEST_OWNER_ID: ownerId, ZHIYU_TEST_WORK_ID: workId, ZHIYU_TEST_COMMAND_ID: id,
        ZHIYU_TEST_VERSION: String(version), ZHIYU_TEST_CRASH: String(crash), ENABLE_LOCAL_SCHEDULER: 'false', ENABLE_STARTUP_LISTENERS: 'false'},
    });
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-4000);});
    const exit = new Promise(resolve => child.once('exit', resolve));
    function message(type) {
      return new Promise((resolve, reject) => {
        child.on('message', data => {if (data.type === type) resolve(data); if (data.type === 'failure') reject(new Error(data.message));});
        child.once('error', reject); child.once('exit', () => reject(new Error(`Worker exited before ${type}: ${stderr}`)));
      });
    }
    const ready = message('ready'), outcome = message(crash ? 'uncommitted' : 'result');
    ready.catch(() => {}); outcome.catch(() => {});
    const timer = setTimeout(() => child.kill(), 45000);
    const worker = {child, ready, outcome, exit, timer}; children.push(worker); return worker;
  }
  try {
    const pair = [spawn(commandId, 0), spawn(commandId, 0)];
    await Promise.all(pair.map(w => w.ready)); pair.forEach(w => w.child.send({type: 'start'}));
    const results = await Promise.all(pair.map(w => w.outcome));
    await Promise.all(pair.map(w => w.exit));
    assert.deepEqual(results[0].result, results[1].result);
    assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, '1');
    assert.equal((await client`SELECT count(*)::int AS n FROM work_commands WHERE owner_id=${ownerId}`)[0].n, 1);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workId}`)[0].n, 2);
    const recoveryId = randomUUID(), crashing = spawn(recoveryId, 1, true);
    await crashing.ready; crashing.child.send({type: 'start'}); await crashing.outcome;
    crashing.child.kill(); await crashing.exit;
    assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, '1');
    assert.equal((await client`SELECT version FROM work_command_targets WHERE workshop_id=${workId}`)[0].version, 1);
    assert.equal((await client`SELECT status FROM work_commands WHERE owner_id=${ownerId} AND command_id=${recoveryId}`)[0].status, 'queued');
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workId}`)[0].n, 3);
    const recovery = spawn(recoveryId, 1);
    await recovery.ready; recovery.child.send({type: 'start'});
    const recovered = await recovery.outcome; await recovery.exit;
    assert.equal(recovered.result.status, 'succeeded');
    assert.equal(recovered.result.result.count, 2);
    assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, '2');
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workId}`)[0].n, 4);
    return {name: 'two OS processes submit/execute once; killed transaction retains queued receipt and explicit retry commits once', passed: true,
      pids: pair.map(w => w.child.pid), crashedPid: crashing.child.pid, recoveryPid: recovery.child.pid};
  } finally {
    for (const w of children) {clearTimeout(w.timer); if (w.child.exitCode === null) w.child.kill();}
    await Promise.all(children.map(w => w.exit));
  }
}
