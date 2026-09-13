import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

export async function checkEventConcurrency({env, databaseUrl, client, web}) {
  const userId = randomUUID(), workId = randomUUID();
  await client`INSERT INTO "User" (id,email) VALUES (${userId},'events-review@example.invalid')`;
  await client`INSERT INTO workshops (id,user_id,name,mission) VALUES (${workId},${userId},'event fixture','concurrency regression')`;
  const workers = Array.from({length: 2}, () => fork(path.join(web, "tests/integration/event-writer.worker.ts"), [], {
    cwd: web, execArgv: ["--import", "tsx", "--conditions=react-server"], silent: true,
    env: {...env, NODE_ENV: "test", TAURI_MODE: "false", IS_TAURI: "false", ZHIYU_TEST_MODE: "integration", ZHIYU_TEST_WORK_ID: workId, ZHIYU_TEST_DATABASE_URL: databaseUrl, POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl, ENABLE_LOCAL_SCHEDULER: "false", ENABLE_STARTUP_LISTENERS: "false"},
  }));
  const ready = [], results = [], exits = [];
  for (const worker of workers) {
    let stderr = "";
    worker.stderr.on("data", chunk => {stderr = (stderr + chunk.toString()).slice(-4000);});
    worker.stdout.resume();
    ready.push(new Promise((resolve, reject) => {
      worker.on("message", message => {if (message.type === "ready") resolve(message);});
      worker.once("error", reject); worker.once("exit", () => reject(new Error(`Writer exited before ready: ${stderr}`)));
    }));
    results.push(new Promise((resolve, reject) => {
      worker.on("message", message => {if (message.type === "result") resolve(message);});
      worker.once("error", reject); worker.once("exit", () => reject(new Error(`Writer exited before result: ${stderr}`)));
    }));
    exits.push(new Promise(resolve => worker.once("exit", resolve)));
  }
  // Attach rejection handlers before readiness so failed child imports never leak promises.
  const allResults = Promise.all(results); allResults.catch(() => {});
  const timeout = setTimeout(() => {for (const worker of workers) worker.kill();}, 60_000);
  try {
    await Promise.all(ready);
    for (const worker of workers) worker.send({type: "start"});
    const outcomes = await allResults;
    await Promise.all(exits);
    const [counts] = await client`SELECT count(*)::int AS total,count(DISTINCT seq)::int AS unique_seq,min(seq)::int AS first,max(seq)::int AS last FROM workshop_events WHERE workshop_id=${workId}`;
    const outcome = {name: "two independent event writers", outcomes, counts};
    console.log(JSON.stringify(outcome));
    assert.equal(counts.total, 200);
    assert.equal(counts.unique_seq, 200);
    assert.equal(counts.first, 1); assert.equal(counts.last, 200);
    assert(outcomes.every(item => item.written === 100 && item.failures.length === 0));
    const crashing = fork(path.join(web, "tests/integration/event-rollback.worker.ts"), [], {
      cwd: web, execArgv: ["--import", "tsx", "--conditions=react-server"], silent: true,
      env: {...env, NODE_ENV: "test", TAURI_MODE: "false", IS_TAURI: "false", ZHIYU_TEST_MODE: "integration", ZHIYU_TEST_WORK_ID: workId, ZHIYU_TEST_DATABASE_URL: databaseUrl, POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl},
    });
    let crashError = "";
    crashing.stdout.resume(); crashing.stderr.on("data", chunk => {crashError = (crashError + chunk).slice(-3000);});
    const crashed = new Promise(resolve => crashing.once("exit", resolve));
    const crashTimeout = setTimeout(() => crashing.kill(), 30_000);
    try {
      await new Promise((resolve, reject) => {
        crashing.on("message", message => {if (message.type === "uncommitted") resolve(message);});
        crashing.once("error", reject);
        crashing.once("exit", () => reject(new Error(`Crash fixture exited before transaction: ${crashError}`)));
      });
      crashing.kill(); await crashed;
      const [afterCrash] = await client`SELECT (SELECT count(*)::int FROM workshop_events WHERE workshop_id=${workId}) AS events, (SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workId}) AS last_seq, name FROM workshops WHERE id=${workId}`;
      assert.deepEqual(afterCrash, {events: 200, last_seq: 200, name: "event fixture"});
    } finally {
      clearTimeout(crashTimeout);
      if (crashing.exitCode === null) crashing.kill();
      await crashed;
    }
    return {...outcome, crashRollback: true, passed: true};
  } finally {
    clearTimeout(timeout);
    for (const worker of workers) if (worker.exitCode === null) worker.kill();
    await Promise.all(exits);
  }
}
