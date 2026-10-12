import fs from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "dotenv";
import postgres from "postgres";
import { captureReleaseSources } from "../../../scripts/release-source-snapshot.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "../..");
const deploymentRoot = path.join(root, ".runtime/deployments/platform-evidence");
const executeFile = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");
const credentialName = /(?:api_?key|access_?key|token|credential|secret|password|private_?key|encryption_?key)/i;
const modelKeyName = /(?:api_?key|model.*token|(?:openai|anthropic|gemini|google|qwen|dashscope|bailian|deepseek|groq|mistral|xai|openrouter|typesafe|llm).*key)/i;
const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const environmentKeys = ["ZHIYU_REVIEW_BUILD", "ANSWER_EVIDENCE_MODE"];
const pendingMigration = "0159_add_agent_answer_audits";

export function validateProductionReview(value, directoryExists) {
  if (!/^\d{2}$/.test(value)) throw Error("review_requires_exactly_two_digits");
  if (directoryExists) throw Error("review_directory_already_exists_do_not_reuse");
  return value;
}

export function validateProductionPending(names) {
  if (names.length !== 1 || names[0] !== pendingMigration) throw Error("unexpected_production_pending_migrations");
  return true;
}

// Preserve every original UTF-8 byte outside the two complete assignment lines.
// Repeated target assignments are ambiguous and are rejected, not normalized.
export function rewriteProductionEnvironment(original, review) {
  validateProductionReview(review, false);
  const text = original.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(original)) throw Error("env_local_is_not_valid_utf8");
  const values = { ZHIYU_REVIEW_BUILD: review, ANSWER_EVIDENCE_MODE: "enforce_critical" };
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  const counts = Object.fromEntries(environmentKeys.map(key => [key, 0]));
  const untouched = [], replacements = [];
  for (const line of lines) {
    const match = line.match(/^(\uFEFF?)([ \t]*(?:export[ \t]+)?)(ZHIYU_REVIEW_BUILD|ANSWER_EVIDENCE_MODE)[ \t]*=([^\r\n]*)(\r\n|\n|\r|$)$/);
    if (!match) { untouched.push(line); replacements.push(line); continue; }
    const [, bom, prefix, key, , ending] = match;
    counts[key]++;
    if (counts[key] > 1) throw Error("duplicate_deployment_env_assignment");
    replacements.push(`${bom}${prefix}${key}=${values[key]}${ending}`);
  }
  const ending = text.includes("\r\n") ? "\r\n" : "\n";
  let updated = replacements.join("");
  for (const key of environmentKeys) {
    if (!counts[key]) {
      if (updated && !/[\r\n]$/.test(updated)) updated += ending;
      updated += `${key}=${values[key]}${ending}`;
    }
  }
  const beforeFields = parse(original), afterFields = parse(updated);
  const allKeys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);
  for (const key of allKeys) if (!environmentKeys.includes(key) && beforeFields[key] !== afterFields[key]) throw Error("unrelated_environment_field_changed");
  const untouchedAfter = updated.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean).filter(line =>
    !/^(?:\uFEFF?)[ \t]*(?:export[ \t]+)?(?:ZHIYU_REVIEW_BUILD|ANSWER_EVIDENCE_MODE)[ \t]*=/.test(line)) ?? [];
  // Appending a new assignment can add a final newline to the original last
  // non-target line. Account for exactly that separator, without editing text.
  const canonical = rows => rows.join("").replace(/[\r\n]+$/, "");
  if (canonical(untouched) !== canonical(untouchedAfter)) throw Error("unrelated_environment_bytes_changed");
  return { updated: Buffer.from(updated, "utf8"), untouchedSha256: digest(canonical(untouched)),
    unrelatedFieldsUnchanged: true, unrelatedBytesUnchangedExceptRequiredFinalSeparator: true };
}

export function productionBuildEnvironment(effective, review, guardPath, guardLogPath) {
  const environment = { ...effective };
  for (const key of Object.keys(environment)) if (modelKeyName.test(key)) environment[key] = "";
  const target = new URL(environment.POSTGRES_URL);
  target.searchParams.set("options", `${target.searchParams.get("options") ?? ""} -c default_transaction_read_only=on`.trim());
  return { ...environment, POSTGRES_URL: target.toString(), NODE_ENV: "production", ZHIYU_REVIEW_BUILD: review,
    ANSWER_EVIDENCE_MODE: "enforce_critical", ENABLE_LOCAL_SCHEDULER: "false", ZHIYU_RUNTIME_MODE: "disabled", ENABLE_STARTUP_LISTENERS: "false",
    TAURI_MODE: "false", IS_TAURI: "false", SKIP_TYPE_CHECK: "false", SKIP_ESLINT: "false", NEXT_TELEMETRY_DISABLED: "1",
    SENTRY_AUTH_TOKEN: "",
    BRAIN_JEV_MODE: "off", BRAIN_JEV_ROUTING: "off", BRAIN_JEV_TARGETED_RETRY: "false",
    ZHIYU_BUILD_GUARD_PG_PORT: target.port || "5432", ZHIYU_BUILD_GUARD_LOG: guardLogPath,
    NODE_OPTIONS: `--max-old-space-size=12288 --require ${JSON.stringify(guardPath)}` };
}

export function productionStartEnvironment(effective, review) {
  return { ...effective, NODE_ENV: "production", ZHIYU_REVIEW_BUILD: review, ANSWER_EVIDENCE_MODE: "enforce_critical" };
}

async function fileHash(filename) { return existsSync(filename) ? digest(await fs.readFile(filename)) : null; }
async function packageArtifacts() {
  const rows = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) rows.push({ path: path.relative(root, filename).replaceAll(path.sep, "/"), bytes: (await fs.stat(filename)).size, sha256: await fileHash(filename) });
    }
  }
  for (const entry of (await fs.readdir(path.join(root, "packages"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    for (const name of ["dist", "build"]) { const output = path.join(root, "packages", entry.name, name); if (existsSync(output)) await walk(output); }
  }
  return { capturedAt: new Date().toISOString(), scope: "Actual non-symlink files in packages/*/{dist,build}; source/runtime hashes are separate", files: rows, artifactHash: digest(JSON.stringify(rows)) };
}
async function save(folder, name, value) { await fs.writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function options(arguments_) {
  const result = { execute: false, review: "37", port: 3515, container: "openzhiyu-postgres", output: null, cookieFile: null };
  for (const argument of arguments_) {
    if (argument === "--execute") result.execute = true;
    else if (argument.startsWith("--review=")) result.review = argument.slice(9);
    else if (argument.startsWith("--container=")) result.container = argument.slice(12);
    else if (argument.startsWith("--output=")) result.output = argument.slice(9);
    else if (argument.startsWith("--cookie-file=")) result.cookieFile = argument.slice(14);
    else throw Error("unknown_deployment_argument");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(result.container)) throw Error("invalid_postgres_container_name");
  return result;
}

async function effectiveEnvironment() {
  const localPath = path.join(web, ".env.local"), original = await fs.readFile(localPath);
  const base = existsSync(path.join(web, ".env")) ? parse(await fs.readFile(path.join(web, ".env"))) : {};
  const local = parse(original);
  // Matches the managed launcher: inherited process > .env.local > .env.
  const effective = { ...base, ...local, ...process.env };
  // Next also loads production env files. Explicitly resolve their defaults so
  // a hidden conflicting .env.production cannot change the selected target.
  const production = {};
  for (const name of [".env.production", ".env.production.local"]) if (existsSync(path.join(web, name))) Object.assign(production, parse(await fs.readFile(path.join(web, name))));
  const buildEffective = { ...production, ...effective };
  if (effective.ZHIYU_RUNTIME_MODE !== "worker" || effective.ENABLE_LOCAL_SCHEDULER === "false"
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(effective.ZHIYU_RUNTIME_OWNER_ID ?? "")) throw Error("original_worker_configuration_not_enabled_or_invalid");
  if (effective.IS_TAURI === "true" || effective.TAURI_MODE === "1") throw Error("desktop_web_production_required");
  if (effective.ZHIYU_TEST_MODE || /(?:fixture|checks)[/\\]/i.test(effective.USERPROFILE ?? "")) throw Error("fixture_environment_cannot_be_deployed");
  for (const key of ["APP_URL", "APPLICATION_URL", "NEXT_PUBLIC_APP_URL", "NEXTAUTH_URL"]) {
    if (buildEffective[key]) { let value; try { value = new URL(buildEffective[key]); } catch { throw Error("invalid_public_application_url"); }
      if (value.port === "1") throw Error("fixture_public_url_cannot_be_deployed"); }
  }
  const target = new URL(effective.POSTGRES_URL);
  if (!["postgres:", "postgresql:"].includes(target.protocol) || !loopback.has(target.hostname)) throw Error("production_postgres_must_match_local_container");
  if ([...target.searchParams.keys()].some(key => /^(?:host|hostaddr|port|database|dbname|user|password)$/i.test(key))) throw Error("postgres_query_target_override_forbidden");
  if (/^\/(?:zhiyu_test_|test_|fixture)/i.test(target.pathname)) throw Error("fixture_database_cannot_be_deployed");
  return { effective, buildEffective, original, localPath, target };
}

async function resolvePnpmCli(require) {
  try { return require.resolve("pnpm/bin/pnpm.cjs"); } catch {}
  const candidates = [path.join(path.dirname(process.execPath), "node_modules/corepack/dist/pnpm.js"),
    path.join(path.dirname(process.execPath), "node_modules/pnpm/bin/pnpm.cjs")];
  const located = await executeFile("where.exe", ["pnpm"], { windowsHide: true });
  for (const shim of located.stdout.trim().split(/\r?\n/)) {
    candidates.push(path.join(path.dirname(shim), "node_modules/corepack/dist/pnpm.js"), path.join(path.dirname(shim), "node_modules/pnpm/bin/pnpm.cjs"));
  }
  const selected = candidates.find(candidate => existsSync(candidate));
  if (!selected) throw Error("pnpm_node_cli_not_resolved_no_shell_fallback");
  return selected;
}

async function processInventory() {
  if (process.platform !== "win32") throw Error("this_deployment_script_requires_windows_inventory");
  const script = "$nodes=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'start-managed-application\\.mjs|start-runtime-worker\\.mjs' } | ForEach-Object { @{pid=$_.ProcessId;role=if($_.CommandLine -match 'start-runtime-worker'){ 'worker' }else{ 'manager' }} }); $ports=@(Get-NetTCPConnection -LocalPort 3515 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.OwningProcess;port=$_.LocalPort} }); @{managed=$nodes;listeners=$ports} | ConvertTo-Json -Compress -Depth 4";
  const result = await executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim());
}

async function databaseMetadata(url) {
  const client = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 2, onnotice: () => {} });
  try {
    const [journal] = await client`SELECT count(*)::int AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`;
    const [identity] = await client`SELECT current_database() AS database, current_user AS role, system_identifier::text AS identifier FROM pg_control_system()`;
    const source = JSON.parse(await fs.readFile(path.join(web, "lib/db/migrations/meta/_journal.json"), "utf8"));
    return { journal: { count: journal.count, latestTimestamp: Number(journal.latest),
      pending: source.entries.filter(entry => entry.when > Number(journal.latest)).map(entry => entry.tag) }, identity };
  } finally { await client.end({ timeout: 5 }); }
}

async function verifyContainer(container, target, database) {
  const execute = async arguments_ => (await executeFile("docker", arguments_, { windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
  const metadata = JSON.parse(await execute(["inspect", "--format", '{"running":{{json .State.Running}},"image":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}', container]));
  if (!metadata.running || !/^postgres:16(?:$|[-.])/.test(metadata.image)) throw Error("expected_running_postgres16_container_required");
  const bindings = metadata.ports["5432/tcp"] ?? [];
  if (!bindings.some(binding => binding.HostPort === (target.port || "5432"))) throw Error("postgres_container_port_does_not_match_target");
  if (!metadata.mounts.some(mount => mount.Type === "volume" && mount.Destination === "/var/lib/postgresql/data")) throw Error("postgres_persistent_volume_required");
  const role = decodeURIComponent(target.username), name = decodeURIComponent(target.pathname.slice(1));
  if (!role || !name || name !== database.identity.database || role !== database.identity.role) throw Error("postgres_url_identity_mismatch");
  const control = JSON.parse(await execute(["exec", container, "psql", "--no-password", "-U", role, "-d", name, "-At", "-c",
    "SELECT json_build_object('identifier',system_identifier::text,'database',current_database(),'role',current_user)::text FROM pg_control_system()"]));
  if (control.identifier !== database.identity.identifier || control.database !== name || control.role !== role) throw Error("postgres_container_system_identity_mismatch");
  return { databaseRole: role, databaseName: name, public: { container, running: true, image: metadata.image,
    publishedPortMatches: true, persistentVolumePresent: true, systemIdentityMatches: true, systemIdentitySha256: digest(control.identifier) } };
}

function sanitizer(environment) {
  const values = [...new Set(Object.entries(environment).filter(([key]) => credentialName.test(key) || /(?:POSTGRES|DATABASE).*URL/i.test(key)).map(([, value]) => value))]
    .filter(value => typeof value === "string" && value.length >= 4).sort((a, b) => b.length - a.length);
  try { const url = new URL(environment.POSTGRES_URL); if (url.password) values.push(decodeURIComponent(url.password)); } catch {}
  return input => { let value = String(input); for (const secret of values) value = value.split(secret).join("[REDACTED]");
    return value.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, "[REDACTED_POSTGRES_URL]").replace(/Bearer\s+[^\s'"<>]+/gi, "Bearer [REDACTED]").replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, "[REDACTED_KEY]"); };
}

async function runStage(folder, report, label, command, arguments_, environment, redact) {
  const stage = { label, status: "running", startedAt: new Date().toISOString(), logPath: path.join(folder, `${label}.log`) };
  report.stages.push(stage); await save(folder, "result.json", report);
  console.log(JSON.stringify({ phase: label, status: "running", logPath: stage.logPath }));
  const handle = await fs.open(stage.logPath, "wx", 0o600);
  let writes = Promise.resolve(), stdout = "", stderr = "";
  const log = text => { writes = writes.then(() => handle.write(redact(text))); };
  const consume = (chunk, isError) => {
    let buffer = (isError ? stderr : stdout) + chunk; let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) { log(buffer.slice(0, newline + 1)); buffer = buffer.slice(newline + 1); }
    if (isError) stderr = buffer; else stdout = buffer;
  };
  const child = spawn(command, arguments_, { cwd: web, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => consume(chunk, false)); child.stderr.on("data", chunk => consume(chunk, true));
  try {
    const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    stage.exitCode = exit.code; stage.signal = exit.signal;
    if (exit.code !== 0) throw Error(`${label}_failed_inspect_redacted_log`);
    stage.status = "passed";
  } catch (error) { stage.status = "failed"; stage.error = redact(error.message); throw error; }
  finally { log(stdout); log(stderr); await writes; await handle.close(); stage.finishedAt = new Date().toISOString(); await save(folder, "result.json", report); }
}

const buildGuardSource = String.raw`const net=require('node:net'),tls=require('node:tls'),fs=require('node:fs');
const allow=new Set(['127.0.0.1','localhost','::1','[::1]']);
const fail=kind=>{if(process.env.ZHIYU_BUILD_GUARD_LOG)fs.appendFileSync(process.env.ZHIYU_BUILD_GUARD_LOG,JSON.stringify({event:'build_io_denied',kind,at:new Date().toISOString()})+'\n');throw Error('production_build_io_denied:'+kind)};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const value=Array.isArray(args[0])?args[0][0]:net._normalizeArgs(args)[0];if(value.path)fail('socket_path');if(!allow.has(value.host||'localhost')||String(value.port)!==process.env.ZHIYU_BUILD_GUARD_PG_PORT)fail('tcp');return connect.apply(this,args)};
net.Server.prototype.listen=function(...args){fail('server_listen')};
const tlsConnect=tls.connect;tls.connect=function(...args){const value=typeof args[0]==='object'?args[0]:{port:args[0],host:args[1]};if(!allow.has(value.host||'localhost')||String(value.port)!==process.env.ZHIYU_BUILD_GUARD_PG_PORT)fail('tls');return tlsConnect.apply(this,args)};
if(globalThis.fetch){const fetch=globalThis.fetch;globalThis.fetch=function(...args){fail('fetch')}};
`;

export function productionBuildGuardSource() { return buildGuardSource; }

// A detached, hidden launcher retains IPC ownership so a later stop.request can
// use the manager's real graceful cleanup. It never kills other Node processes.
const launcherSource = String.raw`import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';
const folder=path.dirname(fileURLToPath(import.meta.url));const settings=JSON.parse(fs.readFileSync(path.join(folder,'launch-settings.json'),'utf8'));
const keys=/(?:api_?key|access_?key|token|credential|secret|password|private_?key|encryption_?key|(?:POSTGRES|DATABASE).*URL)/i;
const disk={};const parse=createRequire(path.join(settings.web,'package.json'))('dotenv').parse;for(const name of ['.env','.env.local','.env.production','.env.production.local']){const filename=path.join(settings.web,name);if(fs.existsSync(filename))Object.assign(disk,parse(fs.readFileSync(filename)))}
const secrets=Object.entries({...disk,...process.env}).filter(([key])=>keys.test(key)).map(([,value])=>value).filter(value=>value&&value.length>=4).sort((a,b)=>b.length-a.length);
try{const password=decodeURIComponent(new URL(process.env.POSTGRES_URL).password);if(password)secrets.push(password)}catch{}
const redact=input=>{let value=String(input);for(const secret of secrets)value=value.split(secret).join('[REDACTED]');return value.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi,'[REDACTED_POSTGRES_URL]').replace(/Bearer\s+[^\s'"<>]+/gi,'Bearer [REDACTED]').replace(/\bsk-[a-zA-Z0-9_-]{8,}/g,'[REDACTED_KEY]')};
const state={supervisorPid:process.pid,status:'starting',startedAt:new Date().toISOString()};const save=()=>fs.writeFileSync(path.join(folder,'launcher-state.json'),JSON.stringify(state,null,2)+'\n',{encoding:'utf8',mode:0o600});
let out='',err='';const log=(chunk,isError)=>{let buffer=(isError?err:out)+chunk;let end;while((end=buffer.indexOf('\n'))>=0){fs.appendFileSync(path.join(folder,isError?'managed-stderr.log':'managed-stdout.log'),redact(buffer.slice(0,end+1)),{encoding:'utf8',mode:0o600});buffer=buffer.slice(end+1)}if(isError)err=buffer;else out=buffer};
const child=spawn(process.execPath,['--import','tsx','scripts/start-managed-application.mjs','start','--port',String(settings.port)],{cwd:settings.web,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
state.managedPid=child.pid;state.status='running';save();child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>log(chunk,false));child.stderr.on('data',chunk=>log(chunk,true));
let requested=false;const interval=setInterval(()=>{if(!requested&&fs.existsSync(path.join(folder,'stop.request'))){requested=true;state.status='stop_requested';save();if(child.connected)child.send('stop',()=>{});else{state.status='stop_unconfirmed';save()}}},500);
child.once('error',()=>{state.status='failed';state.error='managed_spawn_failed';save();clearInterval(interval)});
child.once('exit',(code,signal)=>{if(out)fs.appendFileSync(path.join(folder,'managed-stdout.log'),redact(out)+'\n',{encoding:'utf8',mode:0o600});if(err)fs.appendFileSync(path.join(folder,'managed-stderr.log'),redact(err)+'\n',{encoding:'utf8',mode:0o600});state.status=code===0?'stopped':'failed';state.exitCode=code;state.signal=signal;state.finishedAt=new Date().toISOString();save();clearInterval(interval)});
`;

async function httpReadback(folder, effective, buildDirectory, buildId, cookieFile) {
  const cookie = cookieFile ? (await fs.readFile(path.resolve(cookieFile), "utf8")).trim() : null;
  const headers = cookie ? { Cookie: cookie } : {};
  const get = async pathname => {
    const response = await fetch(`http://127.0.0.1:3515${pathname}`, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return { response, text: await response.text() };
  };
  let home;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { home = await get("/"); if ([200, 302, 303, 307].includes(home.response.status)) break; } catch {}
    const stateFile = path.join(folder, "launcher-state.json");
    if (existsSync(stateFile) && ["failed", "stopped"].includes(JSON.parse(await fs.readFile(stateFile, "utf8")).status)) throw Error("managed_application_exited_before_http_ready");
    await sleep(1000);
  }
  if (!home || ![200, 302, 303, 307].includes(home.response.status)) throw Error("production_http_not_ready");
  const identity = await get("/api/identity"), runtime = await get("/api/runtime/status");
  const responseHeaders = Object.fromEntries(["x-frame-options", "x-content-type-options", "cache-control", "x-answer-evidence-protocol", "x-powered-by"]
    .map(key => [key, identity.response.headers.get(key)]));
  let identitySummary = { status: identity.response.status, ownerMatches: null };
  if (identity.response.ok) {
    const body = JSON.parse(identity.text);
    identitySummary = { status: identity.response.status, mode: body.mode, policyVersion: body.policyVersion,
      actorIdSha256: digest(String(body.actorId)), ownerMatches: String(body.actorId).toLowerCase() === effective.ZHIYU_RUNTIME_OWNER_ID.toLowerCase() };
  }
  let runtimeSummary = { status: runtime.response.status, online: null, phase: null };
  if (runtime.response.ok) {
    const body = JSON.parse(runtime.text), worker = body.worker ?? {};
    runtimeSummary = { status: runtime.response.status, online: worker.online, phase: worker.phase, configuredMode: worker.configuredMode,
      instanceId: worker.instanceId, heartbeatAt: worker.heartbeatAt, heartbeatAgeMs: worker.heartbeatAgeMs, warning: worker.warning,
      modules: (worker.modules ?? []).map(module => ({ name: module.name, phase: module.phase, inFlight: module.inFlight, lastError: module.lastError })) };
  }
  const manifestName = ["_buildManifest.js", "_ssgManifest.js"].find(name => existsSync(path.join(buildDirectory, "static", buildId, name)));
  let artifact = { status: "unverified", buildId };
  if (manifestName) {
    const asset = await get(`/_next/static/${encodeURIComponent(buildId)}/${manifestName}`);
    const expected = await fs.readFile(path.join(buildDirectory, "static", buildId, manifestName));
    artifact = { status: asset.response.ok && digest(asset.text) === digest(expected) ? "matched" : "mismatch", buildId,
      path: `/_next/static/${buildId}/${manifestName}`, diskSha256: digest(expected), httpSha256: digest(asset.text) };
  }
  const readback = { checkedAt: new Date().toISOString(), homepageStatus: home.response.status, identity: identitySummary, runtime: runtimeSummary,
    headers: responseHeaders, artifact, evidenceMode: "enforce_critical", evidenceModeReadback: "launcher_configuration_only_until_real_exact_loop_request",
    protocolHeader: "Only supported exact-loop POST responses carry v1; GET health does not verify answer protocol or model behavior." };
  await save(folder, "http-readback.json", readback);
  if (artifact.status !== "matched") throw Error("served_build_id_asset_not_verified");
  if (identitySummary.ownerMatches === false) throw Error("http_identity_does_not_match_runtime_owner");
  if (runtime.response.ok && (runtimeSummary.online !== true || runtimeSummary.phase !== "running")) throw Error("production_worker_not_running");
  return { ...readback, complete: identitySummary.ownerMatches === true && runtimeSummary.online === true && runtimeSummary.phase === "running" };
}

export async function main(arguments_ = process.argv.slice(2)) {
  const argument = options(arguments_);
  const folder = path.resolve(argument.output ?? path.join(deploymentRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`));
  if (!folder.startsWith(deploymentRoot + path.sep) || existsSync(folder)) throw Error("new_private_deployment_folder_required");
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const report = { schemaVersion: "platform-evidence-production-deployment.v1", status: "preparing", execute: argument.execute,
    folder, review: argument.review, port: argument.port, startedAt: new Date().toISOString(), stages: [], configUpdated: false,
    serviceStarted: false, migrationApplied: false, modelCallsByDeploymentScript: 0, productionEffectVerified: false };
  let redact = value => String(value).replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, "[REDACTED_POSTGRES_URL]");
  try {
    const environment = await effectiveEnvironment(); redact = sanitizer(environment.buildEffective);
    const buildDirectory = path.join(web, ".tmp", `next-review-${argument.review}`);
    validateProductionReview(argument.review, existsSync(buildDirectory));
    const inventory = await processInventory(); report.priorProcesses = inventory;
    if (inventory.listeners.length || inventory.managed.length) throw Error("existing_production_process_requires_separate_graceful_stop_review");
    const database = await databaseMetadata(environment.effective.POSTGRES_URL); report.migrationsBefore = database.journal;
    validateProductionPending(database.journal.pending);
    const container = await verifyContainer(argument.container, environment.target, database); report.postgresContainer = container.public;
    const require = createRequire(path.join(web, "package.json"));
    const pnpmCli = await resolvePnpmCli(require), nextCli = require.resolve("next/dist/bin/next");
    report.commandRuntime = { nodeVersion: process.version, pnpmCli, pnpmCliSha256: await fileHash(pnpmCli), nextCli };
    const before = captureReleaseSources(root); await save(folder, "source-before.json", before);
    const originalHash = digest(environment.original), oldFields = parse(environment.original);
    report.environment = { originalSha256: originalHash, priorReview: oldFields.ZHIYU_REVIEW_BUILD ?? null,
      priorEvidenceMode: oldFields.ANSWER_EVIDENCE_MODE ?? null, runtimeMode: environment.effective.ZHIYU_RUNTIME_MODE,
      schedulerEnabled: environment.effective.ENABLE_LOCAL_SCHEDULER !== "false", ownerConfigured: true,
      jevMode: environment.effective.BRAIN_JEV_MODE ?? null, jevRouting: environment.effective.BRAIN_JEV_ROUTING ?? null,
      jevTargetedRetry: environment.effective.BRAIN_JEV_TARGETED_RETRY ?? null, valuesLogged: false };
    report.buildDirectory = buildDirectory; report.sourceHash = before.sourceHash;
    report.plan = { sequence: ["verify_absent_processes_and_unique_output", "verify_exact_0159_pending_and_container_identity", "private_pg_dump",
      "explicit_production_migration", "workspace_packages_build", "original_web_next_build_webpack_with_types", "source_and_env_drift_check",
      "backup_and_update_only_two_env_assignments", "hidden_managed_worker_and_web_start", "http_and_migration_readback"],
      noUnrelatedProcessStop: true, noCacheDeleteOrMove: true, noFixtureArtifactReuse: true, typeChecks: true,
      compilation: { scheduler: false, startupListeners: false, worker: false, modelKeys: "empty", outboundNetwork: "only_validated_loopback_postgres_port", defaultDatabaseTransactions: "read_only" },
      rollback: "stop this launcher via stop.request; confirm real worker cleanup and manager exit; restore exact backed-up env only after concurrent-change check. Retain additive0159 and audit events. Full worker/source rollback needs matching prior source snapshot, not just an old Web BUILD_ID." };
    report.status = "prepared_only"; await save(folder, "result.json", report);
    if (!argument.execute) { console.log(JSON.stringify({ status: report.status, review: argument.review, pending: database.journal.pending, reportPath: path.join(folder, "result.json") })); return report; }

    report.status = "executing";
    const backupPath = path.join(folder, "production-before-0159.dump"), containerBackup = `/tmp/platform-evidence-${randomUUID()}.dump`;
    await runStage(folder, report, "database-backup", "docker", ["exec", argument.container, "pg_dump", "--no-password", "-U", container.databaseRole,
      "-d", container.databaseName, "-Fc", "-f", containerBackup], environment.effective, redact);
    await runStage(folder, report, "database-backup-copy", "docker", ["cp", `${argument.container}:${containerBackup}`, backupPath], environment.effective, redact);
    const backupHeader = Buffer.alloc(5), backupHandle = await fs.open(backupPath, "r");
    try { await backupHandle.read(backupHeader, 0, 5, 0); } finally { await backupHandle.close(); }
    const backupSize = (await fs.stat(backupPath)).size;
    if (backupSize < 6 || backupHeader.toString("ascii") !== "PGDMP") throw Error("postgres_backup_not_valid_custom_format");
    const backupHash = createHash("sha256"); for await (const chunk of createReadStream(backupPath)) backupHash.update(chunk);
    report.backup = { path: backupPath, bytes: backupSize, sha256: backupHash.digest("hex"), containerPath: containerBackup, format: "postgres_custom", restoreExecuted: false };
    await save(folder, "result.json", report);
    const justBeforeMigration = await databaseMetadata(environment.effective.POSTGRES_URL); validateProductionPending(justBeforeMigration.journal.pending);
    await runStage(folder, report, "production-migration", process.execPath, ["--import", "tsx", "lib/db/migrate.ts"], environment.effective, redact);
    report.migrationApplied = true; report.migrationVerification = "command_succeeded_readback_pending";
    const migrated = await databaseMetadata(environment.effective.POSTGRES_URL); report.migrationsAfter = migrated.journal;
    if (migrated.journal.pending.length || migrated.journal.count !== database.journal.count + 1) throw Error("migration_readback_did_not_apply_exactly_0159");
    report.migrationVerification = "exactly_0159_confirmed";
    const guardPath = path.join(folder, "build-no-egress.cjs"), guardLog = path.join(folder, "build-io-denied.jsonl");
    await fs.writeFile(guardPath, buildGuardSource, "utf8"); report.buildGuardSha256 = digest(buildGuardSource);
    const buildEnvironment = productionBuildEnvironment(environment.buildEffective, argument.review, guardPath, guardLog);
    // The root build:packages wrapper overwrites NODE_OPTIONS with cross-env.
    // Invoke its same recursive package scope directly to retain this guard.
    await runStage(folder, report, "workspace-packages-build", process.execPath, [pnpmCli, "-C", root, "-r", "--filter=./packages/*", "build"], buildEnvironment, redact);
    const builtPackages = await packageArtifacts(); await save(folder, "package-artifacts-after-build.json", builtPackages);
    report.workspacePackageBuild = { status: "passed", artifactHash: builtPackages.artifactHash, fileCount: builtPackages.files.length,
      path: path.join(folder, "package-artifacts-after-build.json") };
    const files = ["tsconfig.json", "next-env.d.ts"], originalTypes = new Map();
    for (const name of files) { const bytes = await fs.readFile(path.join(web, name)); originalTypes.set(name, bytes); await fs.writeFile(path.join(folder, `before-${name}`), bytes); }
    try { await runStage(folder, report, "production-web-build", process.execPath, [nextCli, "build", "--webpack"], buildEnvironment, redact); }
    finally { for (const [name, bytes] of originalTypes) await fs.writeFile(path.join(web, name), bytes); }
    const buildId = (await fs.readFile(path.join(buildDirectory, "BUILD_ID"), "utf8")).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(buildId)) throw Error("missing_or_invalid_production_build_id");
    report.buildId = buildId;
    if (existsSync(guardLog)) throw Error("compilation_attempted_forbidden_network_or_listener_io");
    const after = captureReleaseSources(root); await save(folder, "source-after-build.json", after);
    if (before.sourceHash !== after.sourceHash || before.revision !== after.revision) throw Error("source_changed_during_build_do_not_deploy");
    const packagesAfterWeb = await packageArtifacts(); await save(folder, "package-artifacts-before-start.json", packagesAfterWeb);
    if (builtPackages.artifactHash !== packagesAfterWeb.artifactHash) throw Error("workspace_package_artifacts_changed_during_web_build");
    if (await fileHash(environment.localPath) !== originalHash) throw Error("env_local_changed_during_build_do_not_overwrite");
    const preStart = await processInventory(); report.preStartProcesses = preStart;
    if (preStart.listeners.length || preStart.managed.length) throw Error("production_process_appeared_during_build");
    const rewritten = rewriteProductionEnvironment(environment.original, argument.review);
    const originalEnvPath = path.join(folder, "before.env.local"); await fs.writeFile(originalEnvPath, environment.original, { mode: 0o600 });
    report.beforeEnvironmentBackup = { path: originalEnvPath, sha256: originalHash };
    const temporary = `${environment.localPath}.platform-evidence-${randomUUID()}.tmp`;
    await fs.writeFile(temporary, rewritten.updated, { mode: 0o600 }); await fs.rename(temporary, environment.localPath);
    report.configUpdated = true;
    const stored = await fs.readFile(environment.localPath);
    if (!stored.equals(rewritten.updated)) throw Error("env_local_utf8_readback_failed");
    report.environment.updatedSha256 = digest(stored);
    report.environment.untouchedSha256 = rewritten.untouchedSha256; report.environment.unrelatedFieldsUnchanged = rewritten.unrelatedFieldsUnchanged;
    report.environment.unrelatedBytesUnchangedExceptRequiredFinalSeparator = rewritten.unrelatedBytesUnchangedExceptRequiredFinalSeparator;
    const rollback = { beforeEnvPath: originalEnvPath, beforeSha256: originalHash, deployedSha256: digest(stored),
      stopRequestPath: path.join(folder, "stop.request"), launcherStatePath: path.join(folder, "launcher-state.json"),
      databaseBackup: report.backup, restoreDatabaseAutomatically: false, priorSourceAvailable: false, sourceBeforePath: path.join(folder, "source-before.json"),
      instructions: ["Create stop.request only in this deployment folder; launcher sends owned manager IPC stop.",
        "Verify runtime_stop settled=true, application_stopped and launcher stopped before restoring configuration.",
        "Restore before.env.local bytes only if current env SHA equals deployedSha256; otherwise reconcile concurrent changes manually.",
        "No automatic database restore/drop:0159 is additive and audit/history must survive rollback.",
        "Prior Web build alone cannot roll back source-loaded worker; use a separately preserved matching source revision or leave stopped."] };
    await save(folder, "rollback.json", rollback);
    await save(folder, "launch-settings.json", { web, port: argument.port, review: argument.review, buildId, sourceHash: before.sourceHash });
    await fs.writeFile(path.join(folder, "managed-launcher.mjs"), launcherSource, "utf8");
    const launcher = spawn(process.execPath, [path.join(folder, "managed-launcher.mjs")], {
      cwd: web, env: productionStartEnvironment(environment.effective, argument.review), detached: true, windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { launcher.once("spawn", resolve); launcher.once("error", reject); }); launcher.unref();
    report.serviceStarted = true; report.supervisorPid = launcher.pid;
    await save(folder, "result.json", report);
    const readback = await httpReadback(folder, environment.effective, buildDirectory, buildId, argument.cookieFile);
    report.httpReadback = { path: path.join(folder, "http-readback.json"), complete: readback.complete, artifact: readback.artifact.status,
      identityStatus: readback.identity.status, runtimeStatus: readback.runtime.status };
    const finalDatabase = await databaseMetadata(environment.effective.POSTGRES_URL); report.migrationsFinal = finalDatabase.journal;
    if (finalDatabase.journal.pending.length) throw Error("new_pending_migration_after_start");
    report.status = readback.complete ? "production_started_readback_verified" : "production_started_readback_partial";
    report.productionEffectVerified = false;
    if (!readback.complete) process.exitCode = 2;
  } catch (error) {
    report.status = "failed"; report.error = redact(error.message); report.firstFailureRetained = true;
    // Starting/rollback are explicit reviewable actions; leave the actual state
    // visible rather than stopping an unverified process or erasing evidence.
    report.failureState = { migrationApplied: report.migrationApplied, configUpdated: report.configUpdated, serviceStarted: report.serviceStarted };
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); await save(folder, "result.json", report);
    console.log(JSON.stringify({ status: report.status, review: report.review, buildId: report.buildId ?? null,
      migrationApplied: report.migrationApplied, configUpdated: report.configUpdated, serviceStarted: report.serviceStarted,
      reportPath: path.join(folder, "result.json"), error: report.error ?? null, productionEffectVerified: false }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("deployment_preparation_failed_check_configuration_without_printing_credentials"); process.exitCode = 1; });
}
