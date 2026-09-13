import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hash } from "bcrypt-ts";
import { assertAuthBinding } from "../../scripts/auth-bind-policy.mjs";

export async function runIdentityProductionCheck({ env, databaseUrl, client, web, root }) {
  const userId = randomUUID();
  const password = randomUUID();
  const passwordHash = await hash(password, 10);
  const email = "identity-review@example.invalid";
  await client`INSERT INTO "User" (id,email,password) VALUES (${userId},${email},${passwordHash})`;
  const otherUser = randomUUID(), otherWork = randomUUID();
  await client`INSERT INTO "User" (id,email) VALUES (${otherUser},'other-identity@example.invalid')`;
  await client`INSERT INTO workshops (id,user_id,name,mission) VALUES (${otherWork},${otherUser},'other owner fixture','identity regression')`;
  const checks = [];
  const record = path.join(root, "docs/plans/2026-09-06-review-remediation/records");
  for (const argv of [[], ["-H", "0.0.0.0"], ["--hostname=192.168.1.2"]]) assert.throws(() => assertAuthBinding("local_owner", argv));
  assertAuthBinding("local_owner", ["-H", "127.0.0.1"]);
  checks.push("non-loopback and implicit bind rejected");
  for (const mode of ["local_owner", "authenticated"]) {
    const port = mode === "local_owner" ? 3519 : 3520;
    const origin = `http://127.0.0.1:${port}`;
    const log = fs.openSync(path.join(record, `05-${mode}-server.log`), "w");
    const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: web, windowsHide: true, stdio: ["ignore", log, log],
      env: {...env, AUTH_MODE: mode, NODE_ENV: "production", ZHIYU_REVIEW_BUILD: "05", DEV_USER_ID: userId, POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl, ENABLE_LOCAL_SCHEDULER: "false", ENABLE_STARTUP_LISTENERS: "false", TAURI_MODE: "0", IS_TAURI: "false"},
    });
    try {
      let ready = false;
      for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error("Identity candidate exited before ready");
        try { const response = await fetch(`${origin}/api/auth/session`, {signal: AbortSignal.timeout(3000)}); if (response.ok && response.headers.get("content-type")?.includes("json")) {ready = true; break;} } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert(ready, "candidate readiness");
      const session = await (await fetch(`${origin}/api/auth/session`)).json();
      assert.equal(session?.user?.id ?? null, mode === "local_owner" ? userId : null);
      const write = (headers = {}) => fetch(`${origin}/api/native/agent/permission`, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify({toolUseID: "never-created", behavior: "allow"})});
      assert.equal((await write({Origin: "https://evil.example"})).status, 403);
      assert.equal((await write()).status, 403);
      assert.equal((await write({Origin: origin})).status, mode === "local_owner" ? 404 : 401);
      const logo = await fetch(`${origin}/_next/image?url=%2Fimages%2Fapp-logo.png&w=64&q=75`);
      assert.equal(logo.status, 200, "internal public image optimization must work");
      assert(logo.headers.get("content-type")?.startsWith("image/"));
      checks.push(`${mode}: session, cross-site, missing-origin, unauthenticated write`);
      checks.push(`${mode}: public logo image optimization`);
      if (mode === "authenticated") {
        assert.equal((await fetch(`${origin}/api/auth/guest`, {redirect: "manual"})).status, 403);
        checks.push("authenticated: implicit guest login disabled");
        const cookies = new Map();
        function capture(response) {for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(";")[0]; const at = pair.indexOf("="); cookies.set(pair.slice(0,at), pair.slice(at+1)); }}
        const cookieHeader = () => [...cookies].map(([key,value]) => `${key}=${value}`).join("; ");
        const csrfResponse = await fetch(`${origin}/api/auth/csrf`); capture(csrfResponse);
        const {csrfToken} = await csrfResponse.json();
        const login = await fetch(`${origin}/api/auth/callback/credentials`, {method: "POST", redirect: "manual", headers: {Origin: origin, Cookie: cookieHeader(), "Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({csrfToken, email, password, callbackUrl: origin})});
        capture(login);
        const identityResponse = await fetch(`${origin}/api/identity`, {headers: {Cookie: cookieHeader()}});
        assert.equal(identityResponse.status, 200, "real credentials login must work");
        assert.equal((await identityResponse.json()).actorId, userId);
        const otherResponse = await fetch(`${origin}/api/workshops/${otherWork}`, {headers: {Cookie: cookieHeader()}});
        assert.equal(otherResponse.status, 404, "another owner's work must not be visible");
        checks.push("authenticated: real bcrypt credentials + session cookie accepted");
        checks.push("authenticated: cross-owner work read refused");
      }
    } finally {
      if (child.exitCode === null) {const exit = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exit;}
      fs.closeSync(log);
    }
  }
  fs.writeFileSync(path.join(record, "05-production-smoke.json"), JSON.stringify({testedAt: new Date().toISOString(), checks}, null, 2));
  return {name: "identity production with isolated credentials", passed: true, checks};
}
