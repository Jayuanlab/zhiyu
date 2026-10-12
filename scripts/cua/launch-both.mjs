import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const upstream = join(root, "third_party", "openai-cua-sample-app");
const launcher = join(upstream, "scripts", "launch.mjs");
const production = process.argv.includes("--production");

function configuredValue(name) {
  if (process.env[name]) return process.env[name];
  for (const file of [join(root, "apps", "web", ".env.local"), join(root, "apps", "web", ".env")]) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

const provider = configuredValue("CUA_MODEL_PROVIDER") ?? "openai";
if (!["openai", "opencode-zen"].includes(provider)) throw new Error(`Unsupported CUA model provider: ${provider}`);
const sharedEnv = { ...process.env, CUA_MODEL_PROVIDER: provider };
sharedEnv.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");
if (provider === "opencode-zen") {
  const key = configuredValue("OPENCODE_API_KEY");
  if (!key) throw new Error("OPENCODE_API_KEY is required for OpenCode Zen CUA");
  sharedEnv.OPENAI_API_KEY = key;
  sharedEnv.CUA_DEFAULT_MODEL = configuredValue("CUA_DEFAULT_MODEL") ?? "gpt-6-sol";
  delete sharedEnv.OPENCODE_API_KEY;
}

function start(backend, env) {
  const child = spawn(process.execPath, [launcher, backend, ...(production ? ["--production"] : [])], {
    cwd: upstream,
    env: { ...sharedEnv, ...env, CUA_MANAGED_LAUNCH: "1" },
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
