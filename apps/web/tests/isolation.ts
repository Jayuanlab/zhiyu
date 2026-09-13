import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

function blocked(): never {
  throw new Error("TEST_IO_BLOCKED: inject a fake network/process adapter");
}

/** Installed as a baseline (not a spy), so restoreAllMocks cannot enable real I/O. */
export function installUnitIsolation() {
  if (process.env.ZHIYU_TEST_MODE && process.env.ZHIYU_TEST_MODE !== "unit") {
    throw new Error("Unit runner only supports ZHIYU_TEST_MODE=unit; use the isolated integration runner");
  }
  globalThis.fetch = async () => blocked();
  net.Socket.prototype.connect = blocked;
  tls.connect = blocked;
  childProcess.spawn = blocked;
  childProcess.spawnSync = blocked;
  childProcess.exec = Object.assign(blocked, { __promisify__: blocked });
  childProcess.execSync = blocked;
  childProcess.execFile = Object.assign(blocked, { __promisify__: blocked });
  childProcess.execFileSync = blocked;
  childProcess.fork = blocked;
  syncBuiltinESMExports();
}
