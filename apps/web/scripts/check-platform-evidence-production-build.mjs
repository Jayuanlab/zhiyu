import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
import postgres from "postgres";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "../..");
const checksRoot = path.join(root, ".runtime/checks/platform-evidence-production-build");
const reviewBuild = "99";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const skipped = new Set(["node_modules", ".next", ".tmp", ".runtime", ".data", ".cache", ".git", ".turbo", "coverage", "test-results", "playwright-report"]);
const credentialName = /(?:api_?key|access_?key|token|credential|secret|password|private_?key|encryption_?key)/i;
const explicitModelKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DASHSCOPE_API_KEY", "BAILIAN_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "AZURE_OPENAI_API_KEY", "TYPESAFE_API_KEY", "LLM_API_KEY", "MEMORY_RECALL_LLM_API_KEY", "BRAIN_RECALL_PLANNER_LLM_API_KEY"];

// Read values only to choose a loopback administrator and redact logs. Never
// copy private environment files into the isolated source or report their values.
const disk = {};
for (const base of [root, web]) {
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    const filename = path.join(base, name);
    if (existsSync(filename)) Object.assign(disk, parse(await fs.readFile(filename)));
  }
}
const configured = process.env.ZHIYU_TEST_ADMIN_URL ?? disk.ZHIYU_TEST_ADMIN_URL
  ?? process.env.POSTGRES_URL ?? disk.POSTGRES_URL ?? process.env.DATABASE_URL ?? disk.DATABASE_URL;
let adminUrl;
try { adminUrl = new URL(configured); } catch { throw Error("No valid local test administrator URL configured"); }
if (!loopback.has(adminUrl.hostname) || !["postgres:", "postgresql:"].includes(adminUrl.protocol)) throw Error("Build administration requires loopback PostgreSQL");
if ([...adminUrl.searchParams.keys()].some(name => /^(?:host|hostaddr|port|database|dbname|user|password)$/i.test(name))) throw Error("Database URL cannot override its validated loopback target through query parameters");
adminUrl.pathname = "/postgres";
const require = createRequire(path.join(web, "package.json"));
const nextCli = require.resolve("next/dist/bin/next");
const nextVersion = JSON.parse(await fs.readFile(require.resolve("next/package.json"), "utf8")).version;

if (!process.argv.includes("--execute")) {
  console.log(JSON.stringify({ status: "prepared_only", reviewBuild, nextVersion, typeChecks: true,
    command: "node <installed Next CLI> build --webpack", sourceCopy: true, randomLoopbackTestDatabase: true,
    authMode: "authenticated", modelKeysEmpty: true, modelCallsAuthorized: false, deploy: false,
    originalNextAndTsconfigWriteAuthorized: false, outputRoot: checksRoot }));
  process.exit(0);
}

const argument = process.argv.find(value => value.startsWith("--output="))?.slice(9);
const folder = path.resolve(argument ?? path.join(checksRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`));
if (!folder.startsWith(checksRoot + path.sep) || existsSync(folder)) throw Error("Use a new output folder inside the named build checks root; prior attempts are immutable");
await fs.mkdir(folder, { recursive: true });
const repository = path.join(folder, "repository"), copiedWeb = path.join(repository, "apps/web"), fixtureHome = path.join(folder, "fixture-home");
const dbName = `zhiyu_test_${randomUUID().replaceAll("-", "")}`;
if (!/^zhiyu_test_[a-f0-9]{32}$/.test(dbName)) throw Error("Invalid random test database name");
const targetUrl = new URL(adminUrl); targetUrl.pathname = `/${dbName}`;
if (!loopback.has(targetUrl.hostname) || targetUrl.pathname !== `/${dbName}`) throw Error("Unsafe build database target");
const authSecret = randomBytes(32).toString("base64"), encryptionKey = randomBytes(32).toString("base64");
const emptied = new Set([...explicitModelKeys, ...Object.keys({ ...disk, ...process.env }).filter(name => credentialName.test(name))]);
const childEnv = { ...process.env };
for (const name of emptied) childEnv[name] = "";
Object.assign(childEnv, { NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=12288", AUTH_MODE: "authenticated", DEV_USER_ID: "",
  POSTGRES_URL: targetUrl.toString(), DATABASE_URL: targetUrl.toString(), ZHIYU_TEST_DATABASE_URL: targetUrl.toString(), ZHIYU_TEST_ADMIN_URL: "",
  ZHIYU_TEST_MODE: "integration", ZHIYU_REVIEW_BUILD: reviewBuild, SKIP_TYPE_CHECK: "false", SKIP_ESLINT: "false", ANSWER_EVIDENCE_MODE: "off",
  BRAIN_JEV_MODE: "off", BRAIN_JEV_ROUTING: "off", BRAIN_JEV_TARGETED_RETRY: "false", ENABLE_STARTUP_LISTENERS: "false", ENABLE_LOCAL_SCHEDULER: "false",
  TAURI_MODE: "false", IS_TAURI: "false", NEXT_TELEMETRY_DISABLED: "1", SENTRY_AUTH_TOKEN: "", AUTH_SECRET: authSecret, ENCRYPTION_KEY: encryptionKey,
  USERPROFILE: fixtureHome, APPDATA: path.join(fixtureHome, "AppData/Roaming"), LOCALAPPDATA: path.join(fixtureHome, "AppData/Local"),
  APP_URL: "http://127.0.0.1:1", APPLICATION_URL: "http://127.0.0.1:1", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:1", NEXTAUTH_URL: "http://127.0.0.1:1" });
// Node uses HOME on Unix and USERPROFILE on Windows. This is the child's
// isolated profile only; the invoking process and desktop profile stay intact.
if (process.platform !== "win32") childEnv.HOME = fixtureHome;
const secretValues = [...new Set([adminUrl.toString(), targetUrl.toString(), decodeURIComponent(adminUrl.password), authSecret, encryptionKey,
  ...Object.entries({ ...disk, ...process.env }).filter(([name]) => credentialName.test(name)).map(([, value]) => value)])]
  .filter(value => typeof value === "string" && value.length >= 6).sort((a, b) => b.length - a.length);
function redact(value) {
  let result = String(value);
  for (const secret of secretValues) result = result.split(secret).join("[REDACTED]");
  return result.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, "[REDACTED_POSTGRES_URL]")
    .replace(/Bearer\s+[^\s'"<>]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, "[REDACTED_KEY]");
}
const report = { status: "running", track: "isolated_production_compilation_not_deployment", startedAt: new Date().toISOString(),
  nextVersion, reviewBuild, testDatabase: dbName, databaseHost: targetUrl.hostname, sourceDirectory: copiedWeb,
  outputDirectory: path.join(copiedWeb, ".tmp/next-review-99"), typeChecks: true, authMode: "authenticated", modelKeysEmpty: true,
  emptiedCredentialVariableCount: emptied.size, modelCallsAuthorized: false, paidModelCalls: 0, productionBusinessActions: 0,
  productionLoaded: false, productionEffectVerified: false, stages: [], cleanup: null,
  limitations: ["Compilation verifies this source snapshot with currently installed dependencies; it does not deploy, load the production service, or establish model behavior.",
    "Installed dependency links can resolve workspace packages outside the copied repository; resolved paths and original package hashes are recorded and checked before/after."] };
async function save(name, value) { await fs.writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + "\n", "utf8"); }
async function fileHash(filename) { return existsSync(filename) ? digest(await fs.readFile(filename)) : null; }
async function tree(directory, relative = "", hashContents = true) {
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (hashContents && (skipped.has(entry.name) || entry.name.startsWith(".env") || entry.name.endsWith(".tsbuildinfo"))) continue;
    const absolute = path.join(directory, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) { rows.push({ path: name, symbolicLink: await fs.readlink(absolute) }); continue; }
    if (entry.isDirectory()) rows.push(...await tree(absolute, name, hashContents));
    else { const stat = await fs.stat(absolute); rows.push(hashContents ? { path: name, sha256: await fileHash(absolute) } : { path: name, bytes: stat.size, modifiedAt: stat.mtimeMs }); }
  }
  return rows;
}
async function originalState() {
  return { tsconfig: await fileHash(path.join(web, "tsconfig.json")), nextEnv: await fileHash(path.join(web, "next-env.d.ts")),
    originalNextMetadataHash: digest(JSON.stringify(await tree(path.join(web, ".next"), "", false))),
    workspacePackageFiles: await tree(path.join(root, "packages")) };
}
async function copySource() {
  for (const name of ["apps/web", "packages"]) {
    const source = path.join(root, name), target = path.join(repository, name);
    await fs.cp(source, target, { recursive: true, dereference: false, filter: candidate => {
      const parts = path.relative(source, candidate).split(path.sep);
      return !parts.some(part => skipped.has(part) || part.startsWith(".env") || part.endsWith(".tsbuildinfo"));
    } });
  }
  for (const name of ["package.json", "pnpm-workspace.yaml"]) if (existsSync(path.join(root, name))) await fs.copyFile(path.join(root, name), path.join(repository, name));
  await fs.symlink(path.join(root, "node_modules"), path.join(repository, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  if (existsSync(path.join(web, "node_modules"))) await fs.symlink(path.join(web, "node_modules"), path.join(copiedWeb, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  // Only cache/generated paths change in this private copy. All typechecking
  // remains enabled and Next regenerates its route declarations for review 99.
  const config = JSON.parse(await fs.readFile(path.join(copiedWeb, "tsconfig.json"), "utf8"));
  config.compilerOptions.tsBuildInfoFile = ".tmp/next-review-99/cache/tsconfig.tsbuildinfo";
  await fs.writeFile(path.join(copiedWeb, "tsconfig.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(copiedWeb, "next-env.d.ts"), '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n', "utf8");
  await fs.mkdir(fixtureHome, { recursive: true });
  const stagedRequire = createRequire(path.join(copiedWeb, "package.json"));
  const dependencies = JSON.parse(await fs.readFile(path.join(web, "package.json"), "utf8")).dependencies;
  const resolution = [];
  for (const name of Object.keys(dependencies).filter(name => name.startsWith("@openzhiyu/")).sort()) {
    try { const resolved = stagedRequire.resolve(name); resolution.push({ name, resolved, realPath: await fs.realpath(resolved), sha256: await fileHash(resolved) }); }
    catch { resolution.push({ name, status: "not_resolved_by_node_require", note: "Webpack/TypeScript may use a source alias or import-only export" }); }
  }
  const sources = [...(await tree(copiedWeb)).map(row => ({ ...row, path: `apps/web/${row.path}` })), ...(await tree(path.join(repository, "packages"))).map(row => ({ ...row, path: `packages/${row.path}` }))];
  await save("source-snapshot.json", { files: sources, workspaceDependencyResolutions: resolution,
    copyOnlyAdjustments: ["tsBuildInfoFile -> private review99 cache", "next-env generated references reset for Next to regenerate"] });
  report.sourceFileCount = sources.length; report.sourceSnapshotHash = digest(JSON.stringify(sources));
  report.workspaceDependencyResolutionCount = resolution.length;
}
async function runStage(label, arguments_) {
  const logPath = path.join(folder, `${label}.log`), handle = await fs.open(logPath, "wx");
  const stage = { label, status: "running", logPath, startedAt: new Date().toISOString() }; report.stages.push(stage);
  console.log(JSON.stringify({ phase: label, status: "running", logPath }));
  let logWrites = Promise.resolve(), outBuffer = "", errBuffer = "";
  const writeLog = text => { logWrites = logWrites.then(() => handle.write(redact(text))); };
  const pipe = (chunk, errorStream) => {
    let buffer = (errorStream ? errBuffer : outBuffer) + chunk.toString("utf8"), end;
    while ((end = buffer.indexOf("\n")) >= 0) { writeLog(buffer.slice(0, end + 1)); buffer = buffer.slice(end + 1); }
    if (errorStream) errBuffer = buffer; else outBuffer = buffer;
  };
  const child = spawn(process.execPath, arguments_, { cwd: copiedWeb, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => pipe(chunk, false)); child.stderr.on("data", chunk => pipe(chunk, true));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGKILL");
  }, label === "build" ? 25 * 60_000 : 3 * 60_000);
  try {
    const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    stage.exitCode = exit.code; stage.signal = exit.signal; stage.timedOut = timedOut;
    if (exit.code !== 0 || timedOut) throw Error(`${label} failed; inspect its redacted log`);
    stage.status = "passed";
  } catch (error) { stage.status = "failed"; stage.error = redact(error.message); throw error; }
  finally {
    clearTimeout(timeout); stage.finishedAt = new Date().toISOString();
    writeLog(outBuffer); writeLog(errBuffer); await logWrites; await handle.close();
    console.log(JSON.stringify({ phase: label, status: stage.status, exitCode: stage.exitCode, logPath }));
  }
}

let admin, creationAttempted = false, originalBefore;
try {
  originalBefore = await originalState(); await save("original-state-before.json", originalBefore);
  await copySource();
  await save("isolation.json", { testDatabase: dbName, databaseHost: targetUrl.hostname, fixtureHome, reviewBuild,
    sourceDirectory: copiedWeb, typeChecks: true, authMode: "authenticated", modelKeysEmpty: true, originalNextWriteAuthorized: false, deploy: false });
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  creationAttempted = true;
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await runStage("migration", ["--import", "tsx", "--conditions=react-server", "lib/db/migrate.ts"]);
  const testClient = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await testClient`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    report.migrationCount = rows[0].count;
  } finally { await testClient.end(); }
  await runStage("build", [nextCli, "build", "--webpack"]);
  report.buildIdPresent = existsSync(path.join(copiedWeb, ".tmp/next-review-99/BUILD_ID"));
  if (!report.buildIdPresent) throw Error("Next exited successfully without the isolated review99 BUILD_ID");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = redact(error.message); process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  if (creationAttempted) {
    try {
      if (!loopback.has(adminUrl.hostname) || !/^zhiyu_test_[a-f0-9]{32}$/.test(dbName)) throw Error("Unsafe cleanup target");
      const existing = await admin`SELECT datname FROM pg_database WHERE datname=${dbName}`;
      if (existing.length) {
        await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${dbName} AND pid <> pg_backend_pid()`;
        await admin.unsafe(`DROP DATABASE "${dbName}"`);
      }
      const rows = await admin`SELECT datname FROM pg_database WHERE datname=${dbName}`;
      report.cleanup = { status: rows.length === 0 ? "completed" : "failed", databaseAbsent: rows.length === 0, artifactLogsRetained: true };
    } catch (error) { cleanupErrors.push(redact(error.message)); }
  } else report.cleanup = { status: "not_created", databaseAbsent: true, artifactLogsRetained: true };
  if (admin) { try { await admin.end(); } catch (error) { cleanupErrors.push(redact(error.message)); } }
  if (cleanupErrors.length) report.cleanup = { status: "failed", databaseAbsent: report.cleanup?.databaseAbsent ?? false, errors: cleanupErrors };
  if (originalBefore) {
    try {
      const originalAfter = await originalState(); await save("original-state-after.json", originalAfter);
      report.originalTsconfigUnchanged = originalBefore.tsconfig === originalAfter.tsconfig;
      report.originalNextEnvUnchanged = originalBefore.nextEnv === originalAfter.nextEnv;
      report.originalNextMetadataUnchanged = originalBefore.originalNextMetadataHash === originalAfter.originalNextMetadataHash;
      report.originalWorkspacePackagesUnchanged = digest(JSON.stringify(originalBefore.workspacePackageFiles)) === digest(JSON.stringify(originalAfter.workspacePackageFiles));
      if (![report.originalTsconfigUnchanged, report.originalNextEnvUnchanged, report.originalNextMetadataUnchanged, report.originalWorkspacePackagesUnchanged].every(Boolean)) {
        report.status = "failed"; report.isolationOrConcurrentSourceDrift = true;
      }
    } catch (error) { report.status = "failed"; report.sourceDriftCheckError = redact(error.message); }
  }
  if (report.cleanup.status === "failed") report.status = "failed";
  report.finishedAt = new Date().toISOString();
  await save("result.json", report);
  if (report.status !== "passed") process.exitCode = 1;
  console.log(JSON.stringify({ status: report.status, stageCount: report.stages.length, migrationCount: report.migrationCount,
    sourceFileCount: report.sourceFileCount, cleanup: report.cleanup, reportPath: path.join(folder, "result.json"),
    productionLoaded: false, productionEffectVerified: false }));
}
