// A new immutable run manifest; this launcher never updates the historical latest pointer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
import {
  PROVIDER_LOCK_VERSION, configurationHash, readSavedEvalProvider, readLockedEvalProvider,
  readEvalProviderLock, verifyEvalVersionLock, closeEvalProviderDatabase, EvalConfigurationLockError,
} from "./lib/platform-eval-v2-provider-lock.mjs";
import { prepareEvalSourceWorkspace, verifyEvalSourceWorkspace, REQUIRED_EVAL_WORKSPACE_SOURCE_PATHS } from "./lib/platform-eval-v2-source-workspace.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "../..");
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folderArgument = argument("folder");
if (!folderArgument) throw Error("Explicit --folder=<unchanged v2 package> is required");
const folder = path.resolve(folderArgument);
const packageManifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
if (packageManifest.suiteVersion !== "platform-capability-100.v2") throw Error("Unsupported suite");
const runFolder = path.resolve(argument("run-folder") ?? path.join(folder, `run-locked-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`));
if (!runFolder.startsWith(folder + path.sep)) throw Error("New run must stay inside its explicit package");
const inherited = new Set(Object.keys(process.env));
for (const filename of [path.join(root, ".env"), path.join(web, ".env"), path.join(web, ".env.local")]) if (fs.existsSync(filename)) {
  for (const [key, value] of Object.entries(parse(fs.readFileSync(filename)))) if (!inherited.has(key)) process.env[key] = value;
}
const fixedEnvironment = { BRAIN_JEV_ROUTING: "replace", BRAIN_JEV_MODE: "off", BRAIN_JEV_TARGETED_RETRY: "false", ANSWER_EVIDENCE_MODE: "off" };
Object.assign(process.env, fixedEnvironment);
const lockPath = path.join(runFolder, "provider-lock.json"), manifestPath = path.join(runFolder, "locked-run-manifest.json");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hashFile = filename => digest(fs.readFileSync(filename));
const writeNew = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
const shaFiles = {};
function collect(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) throw Error(`Missing versioned evaluation source: ${relative}`);
  if (fs.statSync(absolute).isDirectory()) {
    for (const item of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (item.isSymbolicLink() || [".data", ".cache", ".tmp", "node_modules"].includes(item.name) || item.name.startsWith(".env")) continue;
      if (item.isDirectory()) collect(`${relative}/${item.name}`);
      else if (/\.(?:ts|tsx|mts|mjs|js|sql|json|yaml|yml)$/u.test(item.name)) shaFiles[`${relative}/${item.name}`] = hashFile(path.join(absolute, item.name));
    }
  } else shaFiles[relative] = hashFile(absolute);
}
const explicitSources = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/web/package.json", "apps/web/tsconfig.json", "apps/web/next.config.js", "packages/ai/package.json",
  "apps/web/scripts/run-platform-capability-eval-v2-locked.mjs", "apps/web/scripts/run-platform-capability-eval-v2.mjs",
  "apps/web/scripts/run-platform-capability-eval-v2-worker.mts", "apps/web/scripts/judge-platform-capability-eval-v2.mjs",
  "apps/web/scripts/judge-platform-capability-workflow-receipts-v2.mjs", "apps/web/scripts/platform-capability-eval-v2-specs.mjs",
  "apps/web/scripts/validate-platform-capability-eval-v2.mjs", "apps/web/scripts/lib/platform-eval-v2-provider-lock.mjs",
  "apps/web/scripts/lib/platform-eval-v2-frozen-tools.mts", "apps/web/scripts/lib/platform-eval-v2-workflows.mjs",
  "apps/web/scripts/lib/platform-eval-v2-workflow-worker.mts", "apps/web/scripts/lib/platform-eval-v2-http-server.mjs",
  "apps/web/scripts/lib/platform-eval-v2-source-workspace.mjs", "apps/web/scripts/lib/platform-loop-current-comparison-http.mjs", "apps/web/scripts/run-platform-loop-current-comparison.mts",
  "apps/web/scripts/lib/platform-eval-v2-contract.mjs", "apps/web/scripts/lib/platform-eval-v2-grading.mjs",
  "apps/web/scripts/lib/platform-eval-v2-adjudications.mjs", "apps/web/scripts/lib/platform-eval-v2-workflow-review.mjs",
  "apps/web/lib", "apps/web/app", "packages/ai/src", "packages/shared/src", "packages/security/src", "manifests/workshops",
  "apps/web/tests/unit/platform-eval-v2-provider-lock.test.ts",
  "apps/web/tests/unit/platform-eval-v2-source-workspace.test.ts", ...REQUIRED_EVAL_WORKSPACE_SOURCE_PATHS,
];
for (const relative of explicitSources) collect(relative);
for (const item of fs.readdirSync(path.join(root,"packages"),{withFileTypes:true})) if (item.isDirectory() && !item.isSymbolicLink()) {
  for (const entry of ["src","package.json"]) if (fs.existsSync(path.join(root,"packages",item.name,entry))) collect(`packages/${item.name}/${entry}`);
}
const require = createRequire(path.join(web, "package.json"));
function installedVersion(name) {
  try {
    let directory = path.dirname(require.resolve(name));
    while (directory !== path.dirname(directory)) {
      const filename = path.join(directory, "package.json");
      if (fs.existsSync(filename)) { const value = JSON.parse(fs.readFileSync(filename, "utf8")); if (value.name === name) return { version: value.version, packageJsonHash: hashFile(filename) }; }
      directory = path.dirname(directory);
    }
  } catch { /* An unavailable installed version is explicit. */ }
  return { status: "unavailable" };
}
const packageNames = ["manifest.json", "integrity.json", "questions.jsonl", "cases.json", "gold.jsonl", "rubric.json", "corpus.jsonl", "results-template.jsonl"];
const packageHashes = Object.fromEntries(packageNames.map(name => [name, hashFile(path.join(folder, name))]));
const previousIntegrity = JSON.parse(fs.readFileSync(path.join(folder, "integrity.json"), "utf8"));
for (const [name, expected] of Object.entries(previousIntegrity)) if (hashFile(path.join(folder, name)) !== expected) throw Error("Original package integrity changed");

async function verifyIdentity() {
  const base = argument("identity-url") ?? process.env.MEMORY_EVAL_URL;
  if (!base) throw new EvalConfigurationLockError("explicit_identity_url_required");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new EvalConfigurationLockError("identity_url_scope_invalid");
  const response = await fetch(new URL("/api/identity", url), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new EvalConfigurationLockError("identity_unavailable");
  const identity = await response.json();
  if (identity.actorId !== packageManifest.ownerId) throw new EvalConfigurationLockError("identity_owner_mismatch");
  process.env.MEMORY_EVAL_URL = url.origin;
  return { base: url.origin, mode: identity.mode, policyVersion: identity.policyVersion, ownerMatchesPackage: true, observedAt: new Date().toISOString() };
}
async function command(script, args) {
  console.log(JSON.stringify({ phase: script, status: "running", runFolder }));
  const child = spawn(process.execPath, ["--import", "tsx", "--conditions=react-server", script, ...args], {
    cwd: web, windowsHide: true, stdio: "inherit", env: { ...process.env, PLATFORM_EVAL_PROVIDER_LOCK_PATH: lockPath },
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new EvalConfigurationLockError("locked_evaluation_stage_failed");
}

try {
  let lock, runManifest, sourceWorkspace;
  if (fs.existsSync(runFolder)) {
    if (!fs.existsSync(lockPath) || !fs.existsSync(manifestPath)) throw new EvalConfigurationLockError("existing_unowned_run_rejected");
    lock = readEvalProviderLock(lockPath, runFolder);
    runManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (runManifest.schemaVersion !== "platform-eval-locked-run.v1" || runManifest.lockHash !== lock.lockHash) throw new EvalConfigurationLockError("run_manifest_invalid");
    if (!lock.sourceWorkspace) throw new EvalConfigurationLockError("explicit_evaluation_workspace_required");
    Object.assign(fixedEnvironment, { PLATFORM_EVAL_SOURCE_WORKSPACE: lock.sourceWorkspace.provenanceFile, PLATFORM_EVAL_SOURCE_WORKSPACE_HASH: lock.sourceWorkspace.workspaceHash });
    Object.assign(process.env, fixedEnvironment);
    verifyEvalVersionLock(lock, root);
    sourceWorkspace = verifyEvalSourceWorkspace({ ...lock.sourceWorkspace, expectedWorkspaceHash:lock.sourceWorkspace.workspaceHash, sourceHashes:lock.sourceHashes, formalRoot:root });
    await readLockedEvalProvider({ lock, role: "agent" }); await readLockedEvalProvider({ lock, role: "judge" });
  } else {
    const provenanceFile = argument("source-workspace"), templateRoot = argument("source-workspace-template");
    if (provenanceFile && templateRoot || !provenanceFile && !templateRoot) throw new EvalConfigurationLockError("explicit_evaluation_workspace_required");
    if (templateRoot) sourceWorkspace = prepareEvalSourceWorkspace({ templateRoot:path.resolve(templateRoot),
      targetRoot:path.join(path.dirname(path.dirname(path.resolve(templateRoot))), "eval-workspaces", randomUUID(), "repository"), sourceHashes:shaFiles,formalRoot:root });
    else {
      const marker = JSON.parse(fs.readFileSync(path.resolve(provenanceFile),"utf8"));
      sourceWorkspace = verifyEvalSourceWorkspace({provenanceFile:path.resolve(provenanceFile),expectedWorkspaceHash:marker.workspaceHash,sourceHashes:shaFiles,formalRoot:root});
    }
    const pinnedWorkspace = { provenanceFile:sourceWorkspace.provenanceFile, provenanceFileHash:hashFile(sourceWorkspace.provenanceFile), workspaceHash:sourceWorkspace.workspaceHash,
      repositoryRoot:sourceWorkspace.repositoryRoot, sourceFileCount:sourceWorkspace.sourceFileCount, nextDependency:sourceWorkspace.nextDependency };
    Object.assign(fixedEnvironment, { PLATFORM_EVAL_SOURCE_WORKSPACE: pinnedWorkspace.provenanceFile, PLATFORM_EVAL_SOURCE_WORKSPACE_HASH: pinnedWorkspace.workspaceHash });
    Object.assign(process.env, fixedEnvironment);
    const agent = await readSavedEvalProvider({ ownerId: packageManifest.ownerId, role: "agent" });
    const judge = await readSavedEvalProvider({ ownerId: packageManifest.ownerId, role: "judge" });
    const body = { schemaVersion: PROVIDER_LOCK_VERSION, folder, runFolder, ownerId: packageManifest.ownerId, createdAt: new Date().toISOString(),
      providers: { agent: agent.snapshot, judge: judge.snapshot }, fixedEnvironment, sourceHashes: shaFiles, packageHashes,sourceWorkspace:pinnedWorkspace };
    lock = { ...body, lockHash: configurationHash(body) };
    runManifest = { schemaVersion: "platform-eval-locked-run.v1", experimentId: argument("experiment-id") ?? randomUUID(),
      armLabel: argument("arm") ?? "post-i1-new-baseline", lockHash: lock.lockHash, createdAt: body.createdAt, runFolder, folder,
      suiteVersion: packageManifest.suiteVersion, caseCount: 100, tracks: { qa: 90, sandboxWorkflow: 10 },
      inputProtocol: "raw-user-question.v2", goldInjected: false, sourcePolicy: "frozen owner corpus plus isolated workflow fixtures; production provider settings are read only",
      recordSnapshotCapturedAt: packageManifest.recordSnapshotCapturedAt, repositoryCapturedAt: packageManifest.repositoryCapturedAt,
      packageHashes, providers: body.providers, fixedEnvironment, sourceHashes: shaFiles,sourceWorkspace:pinnedWorkspace,
      deploymentComparisonScope:"production review38 core was deployed before these evaluation-only HTTP/workspace script changes; this run loads the pinned formal source in an isolated C fixture, not production business writes",
      runtimeVersions: { node: process.version, piAi: installedVersion("@earendil-works/pi-ai"), piHarness: installedVersion("@earendil-works/pi-coding-agent"), next: installedVersion("next") },
      permissions: { allowedQaTools: ["time", "platformRecall", "readPlatformSource", "askMemory"], defaultDecision: "deny", productionBusinessWrites: false, workflows: "fresh random loopback test database/home only" },
      budgets: { concurrency: 3, maxOutputTokens: 2200, runtimeToolUseLimit: 20, timeoutMs: 240000, hardWorkerTimeoutMs: 330000,
        readHandlerAttempts: 10, maxResultCharacters: 24000, maxEvidenceCharacters: 64000, sourceWindowUtf16: 8000,
        automaticRetry: false, compaction: false, thinkingLevel: "off", temperature: "runtime provider default; not explicitly configured",
        jevRoutingTimeoutMs: 2000, jevPrefetchCountsAgainstSharedReadBudget: true, runtimeToolUseLimitExcludesApplicationPrefetch: true },
      jev: { model: "jev-1.13.0", schemaVersion: "recall-sources.v2", policyVersion: "noul-conservative.v1", thresholds: { select: 0.8, exclude: 0.2 }, selection: "any uncertain source vetoes automatic prefetch", applicationGuard: "same versioned change-history rule" },
      scoring: { qaBatchMembership: "authored full100 order sliced in groups of5, excluding workflows only within each group", qaBatchCount: 20, workflowReceiptBatchCount: 2, workflowProtocol: "receipt grounded protocol from versioned review module", humanCertified: false },
      comparison: { oldFirstAttemptStrictlyMatched: false, reasons: ["old first four pilot cases lacked full loaded hashes", "reader and 071/085/100 fixtures changed"],
        i3GateEligibleInOriginal100: 0, i3EffectsAssessedSeparately: true, thisWorkerLoadsI3Gate: false, oldResultsNeverReplaced: true },
      resultPolicy: "Keep every first attempt and failure. Recovery is a separate artifact. Provider/version drift blocks calls rather than switching settings.",
      latestPointerUpdated: false, identity: "checked separately immediately before execution", statusAtPreparation: "prepared_only" };
    fs.mkdirSync(runFolder, { recursive: false });
    writeNew(lockPath, lock); writeNew(manifestPath, runManifest);
  }
  await closeEvalProviderDatabase();
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify({ status: "prepared_only", runFolder, manifestPath, lockHash: lock.lockHash, sourceFileCount: Object.keys(lock.sourceHashes).length,
      sourceWorkspace:{provenanceFile:sourceWorkspace.provenanceFile,workspaceHash:sourceWorkspace.workspaceHash,repositoryRoot:sourceWorkspace.repositoryRoot},
      providerFingerprints: { agent: lock.providers.agent.fingerprint, judge: lock.providers.judge.fingerprint }, modelCalls: 0, latestPointerUpdated: false }));
  } else {
    const identity = await verifyIdentity();
    writeNew(path.join(runFolder, `execution-start-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`), { lockHash: lock.lockHash, identity, fixedEnvironment, modelCallsAuthorized: true });
    if (!process.argv.includes("--judge-only")) {
      const resume = fs.existsSync(path.join(runFolder, "run.json"));
      await command("scripts/run-platform-capability-eval-v2.mjs", [`--folder=${folder}`, `--run-folder=${runFolder}`, "--concurrency=3", "--execute", "--no-latest", `--provider-lock=${lockPath}`, ...(resume ? ["--resume"] : [])]);
    }
    if (process.argv.includes("--judge") || process.argv.includes("--judge-only")) {
      const args = [`--folder=${folder}`, `--run-folder=${runFolder}`, "--execute", `--provider-lock=${lockPath}`];
      await command("scripts/judge-platform-capability-eval-v2.mjs", args);
      await command("scripts/judge-platform-capability-workflow-receipts-v2.mjs", args);
      await command("scripts/judge-platform-capability-eval-v2.mjs", [`--folder=${folder}`, `--run-folder=${runFolder}`, "--report-only"]);
    }
    verifyEvalVersionLock(lock, root);
    console.log(JSON.stringify({ status: "completed", runFolder, lockHash: lock.lockHash, latestPointerUpdated: false, productionBusinessWrites: false }));
  }
} catch (error) {
  const code = error instanceof EvalConfigurationLockError ? error.code : "locked_run_setup_or_execution_failed";
  if (fs.existsSync(manifestPath)) writeNew(path.join(runFolder, `launcher-failure-${Date.now()}-${randomUUID()}.json`), { status: "failed", errorCode: code, at: new Date().toISOString(), modelCallsMayHaveOccurred: process.argv.includes("--execute"), latestPointerUpdated: false });
  console.log(JSON.stringify({ status: "failed", errorCode: code, runFolder, latestPointerUpdated: false })); process.exitCode = 1;
} finally { try { await closeEvalProviderDatabase(); } catch { /* The bounded failure artifact is retained. */ } }
