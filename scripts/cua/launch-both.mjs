import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const upstream = join(root, "third_party", "openai-cua-sample-app");
const launcher = join(upstream, "scripts", "launch.mjs");
const production = process.argv.includes("--production");

function start(backend, env) {
  const child = spawn(process.execPath, [launcher, backend, ...(production ? ["--production"] : [])], {
    cwd: upstream,
    env: { ...process.env, ...env, CUA_MANAGED_LAUNCH: "1" },
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  const done = new Promise((resolveDone) => {
    child.once("error", (error) => resolveDone({ backend, error }));
    child.once("exit", (code, signal) => resolveDone({ backend, code, signal }));
  });
  child.stdin.on("error", () => {});
  return { backend, child, done };
}

const processes = [
  start("javascript", { PORT: "4001", CUA_COORDINATION_PORT: "4050", CUA_CONSOLE_PORT: "3000", CUA_CONSOLE_INSTANCE: "javascript" }),
  start("python", { PORT: "4041", CUA_COORDINATION_PORT: "4051", CUA_CONSOLE_PORT: "3001", CUA_CONSOLE_INSTANCE: "python" }),
];

let stopping;
function stop() {
  return stopping ??= (async () => {
    for (const processInfo of processes) processInfo.child.stdin.end();
    const timeout = new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 35_000));
    const outcome = await Promise.race([Promise.all(processes.map((item) => item.done)), timeout]);
    if (outcome === "timeout") {
      console.error("CUA shutdown is still in progress. Check the desktop runner before restarting; it may be releasing input.");
      process.exitCode = 1;
      return;
    }
  })();
}

process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
const first = await Promise.race(processes.map((item) => item.done));
if (!stopping) {
  console.error(`CUA ${first.backend} launcher exited unexpectedly: ${first.error ?? first.code ?? first.signal}`);
  process.exitCode = 1;
}
await stop();
