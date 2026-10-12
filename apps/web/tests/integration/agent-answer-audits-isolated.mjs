import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
import postgres from "postgres";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = path.resolve(web, "../..");
const disk = {};
for (const folder of [root, web]) for (const file of [".env", ".env.local"]) {
  const target = path.join(folder, file); if (fs.existsSync(target)) Object.assign(disk, parse(fs.readFileSync(target)));
}
const adminUrl = new URL(process.env.ZHIYU_TEST_ADMIN_URL ?? disk.ZHIYU_TEST_ADMIN_URL ?? process.env.POSTGRES_URL ?? disk.POSTGRES_URL ?? process.env.DATABASE_URL ?? disk.DATABASE_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname)) throw Error("Isolated test administration requires loopback");
const dbName = `zhiyu_test_${randomUUID().replaceAll("-", "")}`;
if (!/^zhiyu_test_[a-f0-9]{32}$/.test(dbName)) throw Error("Unsafe test database identity");
const targetUrl = new URL(adminUrl); targetUrl.pathname = `/${dbName}`;
if (targetUrl.pathname !== `/${dbName}`) throw Error("Isolated database target mismatch");
const folder = path.join(root, ".runtime", "answer-audits", new Date().toISOString().replaceAll(":", "-"));
fs.mkdirSync(folder, { recursive: true });
const admin = postgres(adminUrl.toString(), { max: 1 });
let created = false;
const report = { status: "running", testDatabase: dbName, migration: "0159_add_agent_answer_audits", modelCalls: 0, productionWrites: 0, cleanup: null };
fs.writeFileSync(path.join(folder, "isolation.json"), JSON.stringify({ testDatabase: dbName, databaseHost: targetUrl.hostname, targetProfile: path.join(folder, "http-home"), modelCallsAuthorized: false }, null, 2), "utf8");
async function run(script, args = []) {
  const log = fs.openSync(path.join(folder, `${path.basename(script)}.log`), "w");
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "--conditions=react-server", script, ...args], { cwd: web, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, NODE_ENV: "test", ZHIYU_TEST_MODE: "integration", POSTGRES_URL: targetUrl.toString(), DATABASE_URL: targetUrl.toString(), ZHIYU_TEST_DATABASE_URL: targetUrl.toString(), ZHIYU_TEST_CHECK_OUTPUT: path.join(folder, "checks.json") } });
    await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(Error(`Isolated ${path.basename(script)} exited ${code}; inspect owned log`))); });
  } finally { fs.closeSync(log); }
}
try {
  await admin.unsafe(`CREATE DATABASE "${dbName}"`); created = true;
  // Same migration entry point as pnpm db:migrate, with the verified test URL.
  await run("lib/db/migrate.ts");
  await run("tests/integration/agent-answer-audits.check.ts");
  report.checks = JSON.parse(fs.readFileSync(path.join(folder, "checks.json"), "utf8"));
  if (process.argv.includes("--browser")) {
    const { checkAgentAnswerAuditsBrowser } = await import("./agent-answer-audits-browser.mjs");
    report.browser = await checkAgentAnswerAuditsBrowser({ databaseUrl: targetUrl.toString(), fixtures: report.checks.fixtures, folder });
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.message; process.exitCode = 1;
} finally {
  if (created) {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${dbName} AND pid <> pg_backend_pid()`;
    await admin.unsafe(`DROP DATABASE "${dbName}"`);
    const rows = await admin`SELECT datname FROM pg_database WHERE datname=${dbName}`;
    report.cleanup = { status: rows.length === 0 ? "completed" : "failed", databaseAbsent: rows.length === 0 };
  }
  await admin.end();
  fs.writeFileSync(path.join(folder, "result.json"), JSON.stringify(report, null, 2), "utf8");
}
  console.log(JSON.stringify({ status: report.status, checks: report.checks?.checks?.length ?? 0, cleanup: report.cleanup, artifact: path.join(folder, "result.json") }));
