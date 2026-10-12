import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { productionBuildGuardSource } from "../../scripts/restart-platform-evidence-production.mjs";

const execute = promisify(execFile);
test("compile guard preserves Node standard socket normalization and inherited fork IPC", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "zhiyu build guard-"));
  const server = net.createServer(socket => socket.end());
  try {
    const guard = path.join(folder, "guard.cjs"), child = path.join(folder, "child.cjs");
    await fs.writeFile(guard, productionBuildGuardSource(), "utf8");
    await fs.writeFile(child, "process.send({ok:true});process.disconnect();", "utf8");
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const environment = { ...process.env, ZHIYU_BUILD_GUARD_PG_PORT: String(port), NODE_OPTIONS: `--require ${JSON.stringify(guard)}` };
    const socket = await execute(process.execPath, ["-e",
      `const s=require('node:net').createConnection({host:'127.0.0.1',port:${port}});s.on('connect',()=>{console.log('allowed');s.end()});s.on('error',()=>process.exit(1))`], { env: environment, windowsHide: true });
    assert.equal(socket.stdout.trim(), "allowed");
    const ipc = await execute(process.execPath, ["-e",
      `const c=require('node:child_process').fork(${JSON.stringify(child)},{stdio:['ignore','ignore','ignore','ipc']});c.on('message',m=>console.log(m.ok));c.on('exit',code=>process.exitCode=code)`], { env: environment, windowsHide: true });
    assert.equal(ipc.stdout.trim(), "true");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(folder), intended = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(intended + path.sep) && path.basename(resolved).startsWith("zhiyu build guard-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
