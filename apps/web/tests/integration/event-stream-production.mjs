import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

export async function checkEventStreamProduction({env, databaseUrl, client, web, root}) {
  const owner = randomUUID(), work = randomUUID();
  await client`INSERT INTO "User" (id,email) VALUES (${owner},'sse-fixture@example.invalid')`;
  await client`INSERT INTO workshops (id,user_id,name,mission) VALUES (${work},${owner},'SSE fixture','persistent cursor regression')`;
  await client`INSERT INTO workshop_events (workshop_id,seq,type,title) VALUES (${work},1,'observation','first'),(${work},3,'observation','intentional gap')`;
  const origin = "http://127.0.0.1:3521";
  const log = fs.openSync(path.join(root, "docs/plans/2026-09-06-review-remediation/records/06A-production-server.log"), "w");
  const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", "3521", "-H", "127.0.0.1"], {
    cwd: web, windowsHide: true, stdio: ["ignore", log, log],
    env: {...env, AUTH_MODE: "local_owner", NODE_ENV: "production", ZHIYU_REVIEW_BUILD: "06", DEV_USER_ID: owner, POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl, ENABLE_LOCAL_SCHEDULER: "false", ENABLE_STARTUP_LISTENERS: "false", TAURI_MODE: "false", IS_TAURI: "false"},
  });
  let reader;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (server.exitCode !== null) throw new Error("SSE candidate exited early");
      try {const response = await fetch(`${origin}/api/identity`, {signal: AbortSignal.timeout(2000)}); if (response.ok) {ready = true; break;}} catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(ready);
    const response = await fetch(`${origin}/api/workshops/${work}/events/stream?after=1`, {headers: {"Last-Event-ID": "2"}});
    assert.equal(response.status, 200); assert(response.headers.get("content-type").includes("text/event-stream"));
    reader = response.body.getReader();
    let buffer = "";
    const decoder = new TextDecoder();
    async function nextFrame() {
      let timer;
      try {
        return await Promise.race([
          (async () => {
            while (!buffer.includes("\n\n")) {
              const {value, done} = await reader.read();
              assert(!done, "stream ended before event"); buffer += decoder.decode(value, {stream: true});
            }
            const end = buffer.indexOf("\n\n"); const frame = buffer.slice(0,end); buffer = buffer.slice(end+2); return frame;
          })(),
          new Promise((_, reject) => {timer = setTimeout(() => reject(new Error("SSE durable replay timeout")), 8000);}),
        ]);
      } finally { clearTimeout(timer); }
    }
    const initial = await nextFrame(); assert(initial.startsWith("id: 3\n"));
    // Another process writes to persistence without this Web process's event bus.
    await client`INSERT INTO workshop_events (workshop_id,seq,type,title) VALUES (${work},4,'observation','no bus notification')`;
    const recovered = await nextFrame(); assert(recovered.startsWith("id: 4\n"));
    await reader.cancel(); reader = undefined;
    return {name: "production SSE gap, Last-Event-ID and missed notification", initialId: 3, recoveredId: 4, passed: true};
  } finally {
    await reader?.cancel().catch(() => {});
    if (server.exitCode === null) {const exited = new Promise(resolve => server.once("exit", resolve)); server.kill(); await exited;}
    fs.closeSync(log);
  }
}
