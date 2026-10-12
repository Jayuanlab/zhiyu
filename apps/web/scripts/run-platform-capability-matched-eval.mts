import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { appendAdvisory, createPaidCallBudget, createReplayTools, extractNativeReadonlyNames, gradeMain, gradeRouting,
  hash, median, readProviderPayload, replayPrompt, validateFixture, verifyProviderOutputLimit,
  type MatchedCase, type MatchedFixture } from "./lib/platform-capability-matched-eval.mjs";
import type { PlatformCapabilityRoutingResult } from "../lib/ai/platform-capability-routing";

// Usage: node --import tsx --conditions=react-server scripts/run-platform-capability-matched-eval.mts --routing --main
// With no execution flag, freeze a new private package without model requests.
// Every invocation creates a fresh folder; earlier failures are never overwritten or silently retried.
// --supplement-of=<completed private first-run folder> copies CAP-13 into a separate frozen diagnostic and spends only its remaining global budget.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "../..");
const args = process.argv.slice(2);
if (args.some(arg => !["--routing", "--main"].includes(arg) && !arg.startsWith("--url=") && !arg.startsWith("--out=") && !arg.startsWith("--supplement-of="))) throw Error("unsupported_argument");
const runRouting = args.includes("--routing");
const runMain = args.includes("--main");
if (runMain && !runRouting) throw Error("main_requires_same_run_routing");
const inherited = new Set(Object.keys(process.env));
for (const filename of [path.join(repoRoot, ".env"), path.join(webRoot, ".env"), path.join(webRoot, ".env.local")]) {
  if (!fs.existsSync(filename)) continue;
  for (const [key, value] of Object.entries(parse(fs.readFileSync(filename)))) if (!inherited.has(key)) process.env[key] = value;
}
const base = new URL(args.find(arg => arg.startsWith("--url="))?.slice(6) ?? "http://127.0.0.1:3515");
if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname) || base.username || base.password || base.search || base.hash) throw Error("local_auth_url_required");
const privateRoot = path.join(repoRoot, ".runtime/evals/platform-capability-matched");
const supplementArgument = args.find(arg => arg.startsWith("--supplement-of="))?.slice(16);
const supplementOf = supplementArgument ? path.resolve(supplementArgument) : undefined;
if (supplementOf && (!supplementOf.startsWith(privateRoot + path.sep) || !runRouting || !runMain)) throw Error("invalid_supplement_scope");
const priorSummary = supplementOf ? JSON.parse(fs.readFileSync(path.join(supplementOf, "summary.json"), "utf8")) : undefined;
const priorManifest = supplementOf ? JSON.parse(fs.readFileSync(path.join(supplementOf, "manifest.json"), "utf8")) : undefined;
const priorCalls = priorSummary?.budget?.calls ?? 0;
if (supplementOf && (priorSummary?.schemaVersion !== "platform-capability-matched-summary.v1" || !priorSummary.mainExecuted
  || priorSummary.suiteVersion !== "platform-capability-matched-16.v1" || !Number.isSafeInteger(priorCalls) || priorCalls < 0 || priorCalls > 35
  || priorSummary.budget.records?.length !== priorCalls)) throw Error("supplement_budget_or_first_run_invalid");
const output = path.resolve(args.find(arg => arg.startsWith("--out="))?.slice(6) ?? path.join(privateRoot, new Date().toISOString().replace(/[:.]/g, "-")));
if (!output.startsWith(privateRoot + path.sep) || fs.existsSync(output)) throw Error("fresh_private_output_required");
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
const progress = (value: unknown) => fs.appendFileSync(path.join(output, "progress.jsonl"), JSON.stringify(value) + "\n", "utf8");
const fixturePath = path.join(webRoot, "scripts/fixtures/platform-capability-matched-v1.json");
const fixtureBytes = fs.readFileSync(fixturePath);
let fixture: MatchedFixture = JSON.parse(fixtureBytes.toString("utf8"));
validateFixture(fixture);
if (supplementOf) {
  const previousFixture: MatchedFixture = JSON.parse(fs.readFileSync(path.join(supplementOf, "fixture.json"), "utf8"));
  const original = previousFixture.cases.find(item => item.id === "CAP-13");
  if (!original || JSON.stringify(previousFixture) !== JSON.stringify(fixture)) throw Error("supplement_frozen_fixture_mismatch");
  // Existing question, context and expected IDs are unchanged. Only separate diagnostic delivery checks are added.
  fixture = { ...previousFixture, suiteVersion: "platform-capability-cap13-supplement.v1", cases: [{ ...original, main: true,
    mainEvidenceTools: ["inspectWorkshopAgent", "describeWorkshop", "platformRecall"],
    answerPatterns: ["评估平台资料可检索性", "只读|read.only", "发送|删除|配置"] }] };
  for (const [file, expected] of Object.entries(priorManifest.sourceHashes as Record<string, string>)) {
    if (file === "apps/web/scripts/run-platform-capability-matched-eval.mts") continue;
    if (!fs.existsSync(path.join(repoRoot, file)) || hash(fs.readFileSync(path.join(repoRoot, file))) !== expected) throw Error("first_run_source_continuity_failed");
  }
}
const executionFixtureHash = supplementOf ? hash(JSON.stringify(fixture)) : hash(fixtureBytes);
const routeSource = fs.readFileSync(path.join(webRoot, "app/api/native/agent/route.ts"), "utf8");
const allowedTools = extractNativeReadonlyNames(routeSource);
const identityResponse = await fetch(new URL("/api/identity", base), { signal: AbortSignal.timeout(10_000), headers: { Origin: base.origin } });
if (!identityResponse.ok) { void identityResponse.body?.cancel(); throw Error(`local_identity_http_${identityResponse.status}`); }
const identity = await identityResponse.json();
if (typeof identity.actorId !== "string" || !identity.actorId.trim()) throw Error("authenticated_owner_missing");
const ownerId = identity.actorId as string;
if (supplementOf && ownerId !== priorManifest.ownerId) throw Error("supplement_owner_mismatch");

const { createNativePiWebChatTools, getNativePiWebChatToolPolicy } = await import("../lib/ai/native-pi-web-chat-tools");
const { buildPlatformCapabilityCatalog } = await import("../lib/ai/platform-capabilities");
const { suggestPlatformCapabilities } = await import("../lib/ai/platform-capability-routing");
const { fetchTypesafe } = await import("../lib/brain/jev-fetch");
const { resolveNativePiUserConfig } = await import("../lib/ai/native-pi-user-config");
const { getUserLlmProviderConfig } = await import("../lib/ai/user-llm-api-settings");
const [openAI, anthropic] = await Promise.all(["openai_compatible", "anthropic_compatible"].map(providerType =>
  getUserLlmProviderConfig({ userId: ownerId, providerType: providerType as "openai_compatible" | "anthropic_compatible" })));
const config = resolveNativePiUserConfig({ openAI, anthropic, env: { apiKey: process.env.PI_AGENT_API_KEY,
  baseUrl: process.env.PI_AGENT_BASE_URL, model: process.env.PI_AGENT_MODEL,
  protocol: process.env.PI_AGENT_PROTOCOL as "openai-completions" | "anthropic-messages" | "openai-responses" | undefined } });
const policy = getNativePiWebChatToolPolicy({ allowedTools, defaultDecision: "deny" });
const actualFactory = (item?: MatchedCase) => createNativePiWebChatTools({ userId: ownerId,
  question: item?.question, capabilityContext: item?.context, includeMemoryAccess: true,
  runtimeIdentity: { model: config.model, provider: "pi" }, policy,
  toolFilter: tool => allowedTools.includes(tool.name) });
const frozenActualTools = actualFactory();
const catalog = buildPlatformCapabilityCatalog({ tools: frozenActualTools, policy, runtime: "chat" });
const toolContract = frozenActualTools.map(tool => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters }));
const toolContractHash = hash(JSON.stringify(toolContract));
const catalogHash = hash(JSON.stringify(catalog));
if (supplementOf && (catalogHash !== priorManifest.catalogHash || toolContractHash !== priorManifest.toolContractHash
  || config.model !== priorManifest.provider.model || config.protocol !== priorManifest.provider.protocol
  || (config.baseUrl ? new URL(config.baseUrl).hostname : null) !== priorManifest.provider.host)) throw Error("supplement_runtime_mismatch");
const available = new Set(catalog.capabilities.map(item => item.id));
for (const item of fixture.cases) for (const names of item.expectedIdAlternatives ?? [item.expectedIds ?? []]) {
  if (names.some(name => !available.has(name))) throw Error("frozen_expected_capability_not_mounted");
}
const sourceFiles = ["apps/web/scripts/run-platform-capability-matched-eval.mts", "apps/web/scripts/lib/platform-capability-matched-eval.mts",
  "apps/web/scripts/fixtures/platform-capability-matched-v1.json", "apps/web/lib/ai/platform-capability-routing.ts",
  "apps/web/lib/ai/platform-capabilities.ts", "apps/web/lib/ai/native-pi-web-chat-tools.ts", "apps/web/lib/ai/native-pi-user-config.ts",
  "apps/web/lib/ai/runtime/pi-tool-adapter.ts", "apps/web/lib/ai/runtime/tool-executor.ts", "apps/web/lib/brain/recall-policy.ts",
  "apps/web/lib/brain/jev-fetch.ts", "apps/web/lib/brain/jev-evidence-check.ts", "apps/web/app/api/native/agent/route.ts",
  "packages/ai/src/agent/runtime/pi-model-config.ts", "packages/ai/src/agent/runtime/pi-harness-adapter.ts",
  "packages/ai/src/agent/runtime/pi-stream-diagnostics.ts", "node_modules/@earendil-works/pi-ai/package.json",
  "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js", "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js"];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repoRoot, file)))]));
const verifySources = () => {
  if (Object.entries(sourceHashes).some(([file, expected]) => !fs.existsSync(path.join(repoRoot, file)) || hash(fs.readFileSync(path.join(repoRoot, file))) !== expected)) {
    throw Error("evaluation_source_drift");
  }
};
fs.mkdirSync(output, { recursive: true });
write("fixture.json", fixture);
write("catalog.json", catalog);
write("manifest.json", { schemaVersion: "platform-capability-matched-manifest.v1", suiteVersion: fixture.suiteVersion,
  frozenAt: new Date().toISOString(), ownerId, identitySource: "authenticated_local_api_identity", fixtureHash: executionFixtureHash, sourceFixtureHash: hash(fixtureBytes), catalogHash,
  ...(supplementOf ? { supplement: { firstRunFolder: supplementOf, firstRunSummaryHash: hash(fs.readFileSync(path.join(supplementOf, "summary.json"))),
    priorPaidHttpAttempts: priorCalls, additionalPaidHttpLimit: 40 - priorCalls, scope: "CAP-13 diagnostic supplement; reported separately from the first 16-case run." } } : {}),
  toolContractHash, sourceHashes, policy, allowedTools, mountedTools: frozenActualTools.map(tool => tool.name),
  catalogScope: "Actual native factory mounted against the complete formal readonly allowlist; no candidate subset chosen for Jev.",
  protocol: { arms: ["rules", "jev"], routingCases: fixture.cases.map(item => item.id),
    mainCases: fixture.cases.filter(item => item.main).map(item => item.id), assignment: "Pair order alternates by case index.",
    routing: { modeParameter: "explicit", timeoutMs: 2000, model: "jev-1.13.0", automaticRetries: 0 },
    main: { maxToolCalls: 6, maxOutputTokensPerProviderRequest: 2048, maxCaseMs: 90_000, temperature: 0, providerRetries: 0,
      sourceAdapter: "fixed_public_synthetic_replay", privateMessagesRead: false, productionBusinessHandlersExecuted: false,
      snapshotHash: hash(JSON.stringify(fixture.snapshot)), hostScope: "Matched Pi harness only; full production HTTP Host and persisted chat context are not exercised." },
    paidHttpAttemptLimit: 40, goldPolicy: "Expected IDs and answer patterns are never inserted into state, prompt, tool schemas or tool results.",
    failurePolicy: "Every planned arm remains in the denominator. Fresh folders only; failures are not retried or overwritten." },
  provider: { model: config.model ?? null, protocol: config.protocol ?? null,
    host: config.baseUrl ? new URL(config.baseUrl).hostname : null, source: openAI ? "saved_openai_compatible" : anthropic ? "saved_anthropic_compatible" : "process_env",
    credentialsStored: false, configFrozenInProcess: true },
  evidenceLimits: ["Small synthetic set is not production accuracy or statistical proof.", "Jev mode retains rules-first behavior; every arm is not a Jev request.",
    "Main answer checks cover frozen fact patterns and source use, not whole-answer quality.", "SDK synthetic cost=0 is not billing; no currency estimate is made." ] });
console.log(JSON.stringify({ stage: "frozen", output, cases: fixture.cases.length, mainPairs: fixture.cases.filter(item => item.main).length,
  mountedTools: catalog.capabilities.length, catalogHash, fixtureHash: executionFixtureHash, model: config.model ?? null, executeRouting: runRouting, executeMain: runMain }));
const budget = createPaidCallBudget(40 - priorCalls);
const routingRecords: any[] = [];
const mainRecords: any[] = [];
const routingByArm = new Map<string, PlatformCapabilityRoutingResult>();
const nativeFetch = globalThis.fetch.bind(globalThis);

if (runRouting) {
  for (const [index, item] of fixture.cases.entries()) for (const arm of index % 2 ? ["jev", "rules"] as const : ["rules", "jev"] as const) {
    const started = Date.now();
    let calls = 0;
    let responseMetadata: Record<string, unknown> | undefined;
    let result: PlatformCapabilityRoutingResult;
    try {
      verifySources();
      result = await suggestPlatformCapabilities({ question: item.question, catalog, context: item.context, mode: arm }, {
        fetch: async (url, init) => {
          budget.reserve("jev", item.id, arm); calls++;
          const response = await fetchTypesafe(url, init);
          responseMetadata = { status: response.status };
          return response;
        },
      });
      verifySources();
    } catch (error) {
      result = { provider: "none", status: "degraded", capabilityIds: [], elapsedMs: Date.now() - started,
        policyVersion: "evaluation_harness", detail: error instanceof Error && ["evaluation_source_drift", "paid_call_limit"].includes(error.message) ? error.message : "evaluation_error" };
    }
    const record = { id: item.id, group: item.group, arm, result, networkCalls: calls, responseMetadata,
      wallMs: Date.now() - started, grade: gradeRouting(item, result, calls), questionHash: hash(item.question), contextHash: hash(JSON.stringify(item.context ?? null)), catalogHash };
    routingRecords.push(record); routingByArm.set(`${item.id}:${arm}`, result);
    write(`routing-${item.id}-${arm}.json`, record); progress({ stage: "routing", id: item.id, arm, status: result.status, provider: result.provider, calls, ms: record.wallMs });
    console.log(JSON.stringify({ stage: "routing", id: item.id, arm, status: result.status, provider: result.provider,
      detail: result.detail, ids: result.capabilityIds, calls, ms: record.wallMs }));
  }
}

if (runMain) {
  const { createPiAgentRuntime, createPiRuntimeOptionsFromModelConfig } = await import("@openzhiyu/ai/agent/runtime");
  for (const [index, item] of fixture.cases.filter(item => item.main).entries()) for (const arm of index % 2 ? ["jev", "rules"] as const : ["rules", "jev"] as const) {
    const started = Date.now();
    const record: any = { id: item.id, group: item.group, arm, status: "running", ms: 0, calls: 0, toolNames: [], replays: [],
      guardedTraces: [], receiptFacts: [], answer: "", providerPayloads: [], sourceAdapter: "fixed_public_synthetic_replay", snapshotHash: hash(JSON.stringify(fixture.snapshot)), toolContractHash };
    const controller = new AbortController();
    let toolCalls = 0;
    let sealed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      verifySources();
      if (!config.apiKey || !config.model) throw Error("main_provider_unavailable");
      const actualTools = actualFactory(item);
      if (hash(JSON.stringify(actualTools.map(tool => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters })))) !== toolContractHash) throw Error("tool_contract_drift");
      const replayTools = createReplayTools({ actualTools, snapshot: fixture.snapshot, item, policy,
        onTrace: trace => {
          if (sealed) return;
          record.guardedTraces.push({ toolName: trace.toolName, status: trace.status, metadata: trace.metadata });
          if (supplementOf && ["inspectWorkshopAgent", "describeWorkshop", "platformRecall"].includes(trace.toolName)) {
            try {
              const value = JSON.parse(trace.detail ?? "{}");
              const workshop = value.workshop;
              record.receiptFacts.push({ toolName: trace.toolName, mission: workshop?.mission, boundary: workshop?.boundary,
                observedExecutorStatus: workshop?.observedExecutorStatus ?? value.observedExecutorStatus,
                matchesFrozenFacts: workshop?.mission === fixture.snapshot.workshop.mission && workshop?.boundary === fixture.snapshot.workshop.boundary
                  && (workshop?.observedExecutorStatus ?? value.observedExecutorStatus) === "unknown" });
            } catch { record.receiptFacts.push({ toolName: trace.toolName, matchesFrozenFacts: false, detail: "unreadable_guarded_receipt" }); }
          }
        },
        onReplay: replay => { if (!sealed) record.replays.push(replay); } });
      const suggestion = routingByArm.get(`${item.id}:${arm}`)!;
      const prompt = appendAdvisory(replayPrompt(item, fixture.snapshot), suggestion);
      record.routing = suggestion; record.promptHash = hash(prompt);
      const modelOptions = createPiRuntimeOptionsFromModelConfig({ ...config, model: config.model });
      const observedFetch: typeof fetch = async (url, init) => {
        controller.signal.throwIfAborted();
        const payload = await readProviderPayload(url, init);
        const configuredOutput = verifyProviderOutputLimit(payload);
        budget.reserve("main", item.id, arm); record.calls++;
        if (!sealed) record.providerPayloads.push({ model: payload.model ?? null, maxOutputTokens: configuredOutput,
          bodyHash: hash(JSON.stringify(payload)), bytes: Buffer.byteLength(JSON.stringify(payload)), toolCount: payload.tools?.length ?? 0 });
        return nativeFetch(url, init);
      };
      const runtime = createPiAgentRuntime({ ...modelOptions, model: { ...modelOptions.model, maxTokens: 2048 }, adapter: "harness", tools: replayTools,
        streamOptions: { timeoutMs: 90_000 },
        streamFn: (model, context, options) => modelOptions.streamFn({ ...model, maxTokens: 2048 }, context, {
          ...options, maxTokens: 2048, timeoutMs: 90_000, temperature: 0, maxRetries: 0, fetch: observedFetch,
        }) });
      const consume = (async () => {
        let resultText = "";
        let chunks = "";
        let done = false;
        for await (const event of runtime.run({ operation: "run", prompt, options: { sessionId: `capability-matched-${item.id}-${arm}-${started}`,
          abortController: controller, onBeforeToolUse: async () => {
            if (++toolCalls > 6) { controller.abort(); throw Error("tool_call_limit"); }
          } } })) {
          if (sealed) continue;
          if (event.type === "tool_use") record.toolNames.push(event.name);
          if (event.type === "text") chunks += event.content ?? "";
          if (event.type === "result") resultText = event.content ?? "";
          if (event.type === "error") record.error = "main_runtime_error";
          if (event.type === "done") done = true;
          if (event.type === "runtime_terminal") {
            record.runtimeTerminal = event.runtimeTerminal;
            record.providerDiagnostics = event.providerStreamDiagnostics;
          }
        }
        record.answer = resultText || chunks;
        record.status = controller.signal.aborted ? toolCalls > 6 ? "tool_call_limit" : "aborted" : record.error ? "main_runtime_error" : done && record.answer ? "completed" : "incomplete";
      })();
      await Promise.race([consume, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("case_timeout")); }, 90_000); })]);
      verifySources();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      record.status = ["case_timeout", "paid_call_limit", "evaluation_source_drift", "main_provider_unavailable", "tool_contract_drift", "provider_output_limit_invalid", "provider_payload_unobservable"].includes(code) ? code : "evaluation_error";
      record.error = record.status;
      controller.abort();
    } finally {
      if (timer) clearTimeout(timer);
      sealed = true;
    }
    record.ms = Date.now() - started;
    record.observedToolCalls = Math.min(toolCalls, 6);
    record.grade = gradeMain(item, record.answer, record.toolNames, record.status === "completed", record.replays.filter((replay: any) => replay.unavailable).length);
    mainRecords.push(record); write(`main-${item.id}-${arm}.json`, record);
    progress({ stage: "main", id: item.id, arm, status: record.status, calls: record.calls, toolCalls: record.observedToolCalls, ms: record.ms });
    console.log(JSON.stringify({ stage: "main", id: item.id, arm, status: record.status, calls: record.calls,
      toolCalls: record.observedToolCalls, checkedFactsSupported: record.grade.checkedFactsSupported, ms: record.ms }));
  }
}

function armSummary(arm: "rules" | "jev") {
  const rows = routingRecords.filter(record => record.arm === arm);
  const mains = mainRecords.filter(record => record.arm === arm);
  return { routing: { plannedCases: fixture.cases.length, recordedCases: rows.length, accepted: rows.filter(row => row.grade.accepted).length,
    acceptableSelections: rows.filter(row => row.grade.acceptable).length, wrongSelections: rows.filter(row => row.grade.wrongSelection).length,
    abstentions: rows.filter(row => row.grade.abstained).length, correctEmpty: rows.filter(row => row.grade.correctEmpty).length,
    unresolvedPositive: rows.filter(row => row.grade.unresolvedPositive).length, degraded: rows.filter(row => row.grade.degraded).length,
    objectiveMatches: rows.filter(row => row.grade.objectiveMatch).length, networkCalls: rows.reduce((sum, row) => sum + row.networkCalls, 0),
    expectedSemanticCases: fixture.cases.filter(item => item.expectJevAttempt).length,
    semanticCasesWithRequest: rows.filter(row => row.grade.expectedJevAttempt && row.networkCalls > 0).length,
    medianWallMs: median(rows.map(row => row.wallMs)), medianProviderElapsedMs: median(rows.filter(row => row.networkCalls > 0).map(row => row.result.elapsedMs)),
    inputTokensReported: rows.reduce((sum, row) => sum + (row.result.usage?.input_tokens ?? 0), 0),
    outputTokensReported: rows.reduce((sum, row) => sum + (row.result.usage?.output_tokens ?? 0), 0),
    usageReportedCases: rows.filter(row => row.result.usage).length, usageUnknownNetworkCases: rows.filter(row => row.networkCalls && !row.result.usage).length },
    main: { plannedCases: fixture.cases.filter(item => item.main).length, recordedCases: mains.length,
      completed: mains.filter(row => row.status === "completed").length, failed: mains.filter(row => row.status !== "completed").length,
      checkedFactsSupported: mains.filter(row => row.grade.checkedFactsSupported).length,
      actualHttpAttempts: mains.reduce((sum, row) => sum + row.calls, 0), medianMs: median(mains.map(row => row.ms)),
      toolCalls: mains.reduce((sum, row) => sum + row.observedToolCalls, 0),
      usage: mains.flatMap(row => row.providerDiagnostics?.invocations?.map((invocation: any) => ({ id: row.id, usage: invocation.contextReceipt?.usage ?? null })) ?? []),
      scope: "Same synthetic snapshot, actual tool schemas, formal policy guard and main config; full production HTTP Host not tested." } };
}
write("summary.json", { schemaVersion: "platform-capability-matched-summary.v1", at: new Date().toISOString(), suiteVersion: fixture.suiteVersion,
  routingExecuted: runRouting, mainExecuted: runMain, sourceHashes, fixtureHash: executionFixtureHash, catalogHash, snapshotHash: hash(JSON.stringify(fixture.snapshot)),
  arms: { rules: armSummary("rules"), jev: armSummary("jev") }, budget: { ...budget.snapshot(), totalLimit: 40, priorHttpAttempts: priorCalls,
    totalHttpAttempts: priorCalls + budget.snapshot().calls },
  ...(supplementOf ? { supplement: { firstRunFolder: supplementOf, scope: "One diagnostic CAP-13 pair; not part of or a repair to the first-run denominator.",
    receiptFactChecks: mainRecords.map(record => ({ id: record.id, arm: record.arm, receiptFacts: record.receiptFacts })) } } : {}),
  currencyCost: { status: "not_estimated", reason: "No provider-billed currency was returned or verified pricing frozen. SDK cost fields default to zero and are not billing evidence." },
  limits: ["Do not extrapolate this small fixture to production accuracy.", "Do not credit Jev with rule selections or prefetch gains.",
    "Main replay checks do not establish desktop end-to-end correctness or overall answer superiority.", "Failed and uncertain first-run arms remain in planned denominators."] });
console.log(JSON.stringify({ stage: "finished", output, paidHttpAttempts: budget.snapshot().calls,
  routingArms: routingRecords.length, mainArms: mainRecords.length }));
try { const { closeDb } = await import("../lib/db/adapters"); await closeDb(); } catch { /* Artifacts already saved; no database writes. */ }
