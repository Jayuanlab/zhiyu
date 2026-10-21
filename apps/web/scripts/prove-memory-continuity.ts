/**
 * Controlled, real-service memory continuity acceptance runner.
 *
 * Run from apps/web with: node --import tsx --conditions=react-server
 * scripts/prove-memory-continuity.ts --action=plan --owner=<uuid>
 * --workshop=<uuid> --loop=<uuid> --out=../../.tmp/memory-continuity/<id>
 *
 * `plan` is database-read-only. Every mutation needs its own explicit action.
 * `bootstrap --allow-create-fixture` creates an isolated Work/manual Loop through
 * versioned services. Nothing schedules work, sends messages, deletes records,
 * creates users, or substitutes a fake model/tool/Brain store.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { prepareMemoryAcceptanceNetwork } from "./lib/memory-acceptance-network";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Map<string, string>(process.argv.slice(2).map(value => {
  const split = value.indexOf("=");
  return (split < 0 ? [value.replace(/^--/, ""), "true"] : [value.slice(2, split), value.slice(split + 1)]) as [string, string];
}));
const action = args.get("action") ?? "plan";
const allowedArguments = new Set(["action", "owner", "workshop", "loop", "out", "round", "note-key", "memory", "correction-file", "max-requests", "max-seconds", "fixture-marker", "allow-create-fixture", "protocol", "network", "network-prefer", "prior-review", "prior-repair-round", "prior-campaign"]);
if ([...args.keys()].some(key => !allowedArguments.has(key))) throw Error("Unknown runner argument");
const networkMode = args.get("network") ?? "default";
if (networkMode !== "default" && networkMode !== "verified-direct-opencode") throw Error("Unknown acceptance network mode");
if (!["bootstrap", "plan", "plan-repair", "plan-resume", "run", "promote", "review", "correct"].includes(action)) throw Error("Unknown runner action");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const requiredId = (key: string) => { const value = args.get(key); if (!value || !uuid.test(value)) throw Error(`Explicit --${key}=<uuid> required`); return value.toLowerCase(); };
let userId = "", workshopId = "", loopId = "";
const output = resolve(args.get("out") ?? "");
const outputRelative = relative(repository, output);
if (!args.has("out") || !outputRelative.startsWith(".tmp\\memory-continuity\\") && !outputRelative.startsWith(".tmp/memory-continuity/")) throw Error("Output must be inside repository .tmp/memory-continuity/<session>");
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function assertStoredText(value: string) {
  if (value.includes("\uFFFD") || value.includes("???") || /^\?+$/.test(value.trim())) throw Error("Stored acceptance text has possible encoding corruption; stop and preserve evidence");
}
const read = (name: string) => JSON.parse(readFileSync(resolve(output, name), "utf8"));
const command = (name: string) => `memory-continuity:${digest(outputRelative).slice(0, 16)}:${name}`;
function writeOnce(name: string, value: unknown) {
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}
const sourcePaths = [
  "apps/web/scripts/prove-memory-continuity.ts", "apps/web/scripts/verify-memory-continuity.mjs",
  "apps/web/scripts/verify-memory-continuity-followup.mjs",
  "apps/web/scripts/verify-memory-continuity-resume.mjs",
  "apps/web/scripts/lib/memory-continuity-verification.mjs",
  "apps/web/scripts/lib/memory-acceptance-network.ts",
  "apps/web/lib/loops/native-executor.ts", "apps/web/lib/loops/runtime.ts",
  "apps/web/lib/types/execution-result.ts",
  "apps/web/lib/loops/owner-loop-run.ts", "apps/web/lib/loops/context-window.ts", "apps/web/lib/loops/spec.ts",
  "apps/web/lib/loops/approval.ts", "apps/web/lib/loops/tool-gate.ts", "apps/web/lib/loops/verifier.ts", "apps/web/lib/loops/checker.ts",
  "apps/web/lib/loops/memory-recall-risk.ts",
  "apps/web/lib/workshops/working-memory-promotion.ts", "apps/web/lib/workshops/working-memory-promotion-service.ts",
  "apps/web/lib/workshops/working-memory-promotion-receipt.ts", "apps/web/lib/workshops/working-memory-continuity.ts",
  "apps/web/lib/workshops/working-memory-policy.ts", "apps/web/lib/workshops/working-memory-strategy.ts",
  "apps/web/lib/workshops/service.ts", "apps/web/lib/workshops/event-write.ts", "apps/web/lib/workshops/event-summary.ts",
  "apps/web/lib/workshops/mcp-tools.ts", "apps/web/lib/workshops/memory-evidence-reader.ts", "apps/web/lib/workshops/memory-context.ts", "apps/web/lib/workshops/boundary-policy.ts",
  "apps/web/lib/workshops/run-prompt.ts", "apps/web/lib/workshops/tool-access.ts", "apps/web/lib/workshops/pi-domain-tools.ts",
  "apps/web/lib/workshops/loop-runtime.ts", "apps/web/lib/ai/model-policy.ts", "apps/web/lib/ai/user-llm-api-settings.ts", "apps/web/lib/ai/agent-runtime-error.ts",
  "apps/web/lib/ai/jina-page-reader.ts", "apps/web/lib/ai/public-page-reader.ts",
  "apps/web/lib/ai/web-page-cleaner.ts", "apps/web/lib/workshops/web-fetch.ts",
  "apps/web/lib/workshops/research-page-method.ts",
  "apps/web/lib/memory/context/pack.ts", "apps/web/lib/memory/retrieval/recall.ts", "apps/web/lib/memory/retrieval/candidates.ts", "apps/web/lib/memory/context/workshop-memory.ts", "apps/web/lib/memory/evidence/reader.ts",
  "apps/web/lib/brain/retirement-signals.ts",
  "apps/web/lib/memory/retrieval/recall-planner.ts", "apps/web/lib/brain/recall-policy.ts", "apps/web/lib/memory/revision/policy.ts",
  "apps/web/lib/brain/memory-review.ts", "apps/web/lib/brain/memory-revision.ts", "apps/web/lib/brain/memory-revision-version.ts",
  "apps/web/lib/work-runtime/commands.ts", "apps/web/lib/work-runtime/database-command.ts", "apps/web/lib/work-runtime/command-ledger.ts",
  "apps/web/lib/work-runtime/loop-command.ts", "apps/web/lib/work-runtime/loop-execution.ts", "apps/web/lib/work-runtime/loop-admission.ts",
  "apps/web/lib/work-runtime/execution-lease.ts", "apps/web/lib/work-runtime/execution-context.ts",
  "packages/ai/src/agent/runtime/host-working-memory.ts", "packages/ai/src/agent/runtime/host-working-memory-sources.ts",
  "packages/ai/src/agent/runtime/pi-harness-adapter.ts", "packages/ai/src/agent/runtime/pi-model-config.ts",
  "packages/ai/src/agent/runtime/pi-provider-terminal.ts",
  "packages/ai/src/agent/runtime/pi-stream-diagnostics.ts",
  "packages/ai/src/agent/runtime/host-readonly-continuation.ts", "packages/ai/src/agent/runtime/host-final-validation.ts",
];
const sourceHashes = () => Object.fromEntries(sourcePaths.filter(path => existsSync(resolve(repository, path))).map(path => [path, digest(readFileSync(resolve(repository, path), "utf8"))]));
// workshopLogEvent is an internal audit record, not a business/external action.
const safeReadTools = new Set(["webreadpage", "websearch", "webfetch", "read", "glob", "grep", "time", "workingmemory", "workshoplogevent", "workshopreadmemory", "workshopsearchmemory", "workshopgetmemoryevidence", "workshoplistsources", "workshopgetdirectives"]);
const leaf = (name: string) => name.split("__").at(-1)!.toLowerCase();
const fixtureMarker = args.get("fixture-marker") ?? "memory-continuity-acceptance";
const fixtureUrl = "https://www.rfc-editor.org/rfc/rfc2119.txt";
const fixtureTools = ["webReadPage", "workingMemory", "workshopReadMemory", "workshopSearchMemory", "workshopGetMemoryEvidence", "workshopLogEvent"];
const fixtureDeniedTools = ["Bash", "Shell", "Exec", "Write", "Edit", "MultiEdit", "workshopWriteMemory", "workshopReviewMemory", "workshopCreateOutboxDraft", "wechatSendMessage", "quantPaperPlaceOrder", "delete", "remove"];
const fixtureGoal = `${fixtureMarker}: Maintain a small research memo about RFC 2119 terminology and the current exercise-only decisionLabel, using the latest scoped Brain memory and the previous Loop checkpoint. Report the current conclusion, source, applicability and next question in Chinese.`;
const fixtureProtocol = `This is an explicitly authorized ${fixtureMarker} mechanism acceptance, not genuine personal knowledge or general research evaluation.
The Loop goal is fixed across runs. Complete one bounded update of that same research task each time.
Read current Brain memoryContext and the previous durable Loop state first. Current verified/active Brain memory and owner corrections take precedence over historical model notes.
On the first run, when no inherited working-memory checkpoint exists, read ${fixtureUrl} with webReadPage. Create one source-bound fact about the document and one source-bound hypothesis with key acceptance.policy. The hypothesis must explicitly say: ${fixtureMarker}; decisionLabel=RECHECK_SOURCE; this is only an exercise proposal and its limits can be revised by the owner.
Use workingMemory read to obtain actual evidence IDs, then one LOG update with the full four-part notebook. Keep this exact open question in the notebook: Which current Brain policy should govern this fixture in the next run? Set nextAction to re-check the latest Brain version in the next run. Never invent source IDs. Leave pruneToolCallIds empty; compression savings are not under test. Do not restore or clear the notebook.
On later runs use current Brain and historical checkpoint context. Do not replace an inherited notebook solely to claim that it was saved again. Historical sourceRefs are not current evidence IDs. If the original policy was superseded, follow the actual current Brain replacement. If no current policy can be found, report unknown; do not silently reuse an old label.
Produce a concise Chinese report and a valid <structured-output> JSON block with summary, finalMarkdownReport, outcome, riskAssessment, actionTaken, reasoningChain, suggestedActions, decisionLabel, nextActions. Include a single visible line decisionLabel=<CURRENT_LABEL>. Explain the source and scope of the current choice. Do not repeat an obsolete decisionLabel literal in the report; retain history in audit records. Initial label is a first-run proposal only; later labels must come from actual current Brain recall, not this historical instruction.
No tool may send messages, place trades, delete records, modify configuration or directly activate long-term memory. Report internally; no outbox. Keep suggestedActions empty. Do not claim cost reduction, natural-task improvement, production deployment or general factual correctness from this exercise.`;

async function resolveExistingOwner() {
  const { getUserById } = await import("@/lib/db/user-queries");
  if (args.has("owner")) {
    const id = requiredId("owner");
    if (!await getUserById(id)) throw Error("Explicit owner is not an existing local User; bootstrap never creates users");
    return id;
  }
  if (process.env.AUTH_MODE === "local_owner") {
    const { createDevSession } = await import("@/lib/auth/dev-auth");
    const id = createDevSession().user?.id;
    if (id && uuid.test(id) && await getUserById(id)) return id.toLowerCase();
  }
  const [{ db }, { user }] = await Promise.all([import("@/lib/db/client"), import("@/lib/db/schema")]);
  const users = await db.select({ id: user.id }).from(user).limit(2);
  if (users.length !== 1 || !uuid.test(users[0].id) || !await getUserById(users[0].id)) throw Error("No unique existing local owner; provide --owner=<existing UUID>");
  return users[0].id.toLowerCase();
}

async function resolveBootstrapProvider() {
  const [{ getUserLlmProviderConfig }, { resolvePiAgentModelConfig }] = await Promise.all([
    import("@/lib/ai/user-llm-api-settings"), import("@/lib/ai/model-policy"),
  ]);
  const saved = await getUserLlmProviderConfig({ userId, providerType: "openai_compatible" });
  // Exact priority used by getLoopPiAgentEnvConfig, not Workshop's different priority.
  const pick = (suffix: string) => ["LLM", "INTERACTION_PROCESSOR_LLM", "WORKSHOP_PLANNER_LLM", "OPENCODE"].map(prefix => process.env[`${prefix}_${suffix}`]?.trim()).find(Boolean);
  const env = { apiKey: pick("API_KEY"), baseUrl: pick("BASE_URL"), model: pick("MODEL") };
  const protocol = args.get("protocol") ?? process.env.LOOP_PI_MODEL_PROTOCOL ?? process.env.PI_AGENT_PROTOCOL
    ?? (env.baseUrl?.includes("opencode.ai/zen/go") ? "openai-completions" : undefined);
  if (protocol !== "openai-completions" && protocol !== "openai-responses" && protocol !== "anthropic-messages") throw Error("An explicit --protocol or configured Pi protocol is required before fixture creation");
  const resolved = resolvePiAgentModelConfig({ userConfig: saved, envConfig: env, runtimeProtocol: protocol, fallbackModel: saved?.model ?? env.model ?? "" });
  if (!resolved.apiKey || !resolved.baseUrl || !resolved.model) throw Error("Existing owner/Loop provider is incomplete; no fixture was created and no replacement provider was selected");
  return { model: resolved.model, protocol, providerSource: resolved.source, endpointHash: digest(resolved.baseUrl), credentialsRecorded: false };
}

async function bootstrap() {
  if (args.get("allow-create-fixture") !== "true") throw Error("Bootstrap writes require explicit --allow-create-fixture");
  if (args.has("workshop") || args.has("loop")) throw Error("Bootstrap creates a dedicated fixture; do not supply existing business target IDs");
  userId = await resolveExistingOwner();
  const provider = await resolveBootstrapProvider();
  const { createWork } = await import("@/lib/work-runtime/commands");
  const { runDatabaseWorkCommand } = await import("@/lib/work-runtime/database-command");
  const { getWorkshop, getWorkshopConfigurationBaseline } = await import("@/lib/workshops/service");
  const { createLoop } = await import("@/lib/loops/service");
  const { parseLoopSpec, loopSpecToCreateLoopInput } = await import("@/lib/loops/spec");
  const identity = `${fixtureMarker}:${digest(outputRelative).slice(0, 10)}`;
  const createWorkCommand = { commandId: command("bootstrap-work"), expectedVersion: 0, source: "owner" as const,
    reason: "Create a dedicated owner-authorized manual memory acceptance fixture; do not modify existing workshops",
    input: { userId, name: `Memory continuity acceptance ${digest(outputRelative).slice(0, 8)}`, status: "active" as const, autonomyLevel: "observe" as const,
      mission: `${identity}. Isolated research mechanism acceptance with public RFC 2119. All records are exercise-only and scoped to this workshop. No business, external communication, financial or scheduling actions.`,
      boundaryPolicy: { mode: "observe", externalMessages: "blocked", allowWechatPreview: false, allowedRecipients: [], hardDeniedActions: fixtureDeniedTools, deniedPrecedence: true },
      modelConfig: { acceptanceFixture: fixtureMarker, role: "memory_continuity_researcher", agentRuntimeEngine: "pi", loopAgentRuntimeEngine: "pi",
        piModelProtocol: provider.protocol, loopPiModelProtocol: provider.protocol, contextProfile: "normal", toolProfile: "normal",
        allowedTools: fixtureTools, disallowedTools: fixtureDeniedTools,
        researchEvidenceContract: { version: "primary-reading/v1", taskKeywords: [fixtureMarker], reportDelivery: "grounded-report/v1",
          requiredPrimarySources: [{ id: "rfc2119", label: "RFC 2119 public primary source", urls: [fixtureUrl] }] } } } };
  const bootstrapIntentName = "bootstrap-intent.json";
  if (existsSync(resolve(output, bootstrapIntentName))) {
    const previous = read(bootstrapIntentName);
    if (digest(previous.createWorkCommand) !== digest(createWorkCommand) || digest(previous.provider) !== digest(provider)) throw Error("Bootstrap retry drift; preserve prior evidence and start a new explicit session");
  } else writeOnce(bootstrapIntentName, { createWorkCommand, provider, publicSourceUrl: fixtureUrl });
  const workshop = await createWork(createWorkCommand);
  workshopId = workshop.id;
  const baseline = await getWorkshopConfigurationBaseline(userId, workshopId);
  if (!baseline) throw Error("Created fixture workshop baseline unavailable");
  const spec = parseLoopSpec({ version: 1, goal: fixtureGoal, trigger: { type: "manual" },
    context: { sources: [], instructions: fixtureProtocol },
    actions: { allowed: fixtureTools, denied: fixtureDeniedTools, requiresApproval: [] },
    verification: { type: "structured_check", successCriteria: [], requiredFields: ["summary", "decisionLabel", "nextActions"], requiredSources: [], modelChecker: { enabled: false } },
    retry: { maxAttempts: 1, onFailure: "mark_failed" }, approval: { defaultMode: "deny", externalWrites: "deny" },
    escalation: { onBlocked: "none", onNeedsApproval: "none" }, metadata: { acceptanceFixture: fixtureMarker, publicSourceUrl: fixtureUrl } });
  const createLoopCommand = { commandId: command("bootstrap-loop"), expectedVersion: baseline.commandVersion,
    userId, workId: workshopId, source: "owner" as const, reason: "Create isolated manual-only Loop atomically without an intermediate schedule", spec,
    acceptanceFixture: fixtureMarker };
  // Persist the exact accepted version across retries; never regenerate an intent from a newer baseline.
  const savedLoopIntent = existsSync(resolve(output, "bootstrap-loop-intent.json")) ? read("bootstrap-loop-intent.json").command : createLoopCommand;
  if (!existsSync(resolve(output, "bootstrap-loop-intent.json"))) writeOnce("bootstrap-loop-intent.json", { command: savedLoopIntent });
  if (savedLoopIntent.userId !== userId || savedLoopIntent.workId !== workshopId || digest(savedLoopIntent.spec) !== digest(spec)) throw Error("Bootstrap Loop retry identity drift");
  const loop = await runDatabaseWorkCommand(savedLoopIntent, "createMemoryContinuityAcceptanceLoop", async (persisted, context) => {
    if (!await getWorkshop(persisted.userId, persisted.workId, context.db)) throw Error("Owned fixture workshop unavailable");
    const createInput = loopSpecToCreateLoopInput({ userId: persisted.userId, workshopId: persisted.workId,
      name: "Memory continuity A-B-C-D manual acceptance", description: `${fixtureMarker}; no scheduler or external delivery`, spec: parseLoopSpec(persisted.spec) });
    const created = await createLoop({ ...createInput, contextConfig: { ...createInput.contextConfig, metadata: { acceptanceFixture: fixtureMarker, agentRuntimeEngine: "pi", piModelProtocol: provider.protocol } } }, context.db);
    await context.append({ workshopId: persisted.workId, loopId: created.id, type: "loop_created", title: "Isolated manual memory acceptance Loop created",
      metadata: { commandId: persisted.commandId, acceptanceFixture: fixtureMarker, receiptAuthority: "owner_command", trigger: { type: "manual" }, externalDelivery: false } });
    return created;
  });
  loopId = loop.id;
  const initial = await snapshot();
  assertStoredText(initial.loopGoal);
  if (initial.trigger.type !== "manual" || initial.workshopStatus !== "active" || initial.loopStatus !== "active") throw Error("Fixture readback differs from manual/active intent");
  const receipt = { schemaVersion: "memory-continuity-bootstrap.v1", createdAt: new Date().toISOString(), userId, workshopId, loopId,
    provider, createWorkCommandId: createWorkCommand.commandId, createLoopCommandId: savedLoopIntent.commandId,
    createLoopExpectedVersion: savedLoopIntent.expectedVersion, commandVersion: initial.commandVersion, initial,
    modelCalls: 0, noScheduledRuns: true, noExternalDelivery: true, originalBusinessWorkshopsChanged: false };
  if (!existsSync(resolve(output, "bootstrap.json"))) writeOnce("bootstrap.json", receipt);
  if (!existsSync(resolve(output, "correction-sample.json"))) writeOnce("correction-sample.json", {
    acceptanceFixture: fixtureMarker,
    content: `${fixtureMarker}; decisionLabel=CHECK_CURRENT_VERSION. This owner-defined exercise policy replaces the earlier proposal. Before reusing a conclusion, inspect its latest Brain version and scoped sources. It applies only to this acceptance workshop; it does not claim a new RFC fact or alter user business policy.`,
    reason: "Owner-authorized isolated versioned correction exercise: prioritize the current memory version over replaying a historical proposal",
    evaluationAssertions: { outputIncludes: ["decisionLabel=CHECK_CURRENT_VERSION"], outputExcludes: ["decisionLabel=RECHECK_SOURCE"] } });
  return { action, userId, workshopId, loopId, commandVersion: initial.commandVersion, status: "fixture_created_no_model_calls", nextAction: "plan" };
}

function loadTargetIdentity() {
  const saved = existsSync(resolve(output, "resume-session.json")) ? read("resume-session.json").initial
    : action === "plan-resume" ? readPriorArtifact(priorCampaignDirectory(), "bootstrap.json")
    : existsSync(resolve(output, "bootstrap.json")) ? read("bootstrap.json") : null;
  userId = args.has("owner") ? requiredId("owner") : saved?.userId ?? "";
  workshopId = args.has("workshop") ? requiredId("workshop") : saved?.workshopId ?? "";
  loopId = args.has("loop") ? requiredId("loop") : saved?.loopId ?? "";
  if (![userId, workshopId, loopId].every(id => uuid.test(id))) throw Error("Existing target IDs or a verified bootstrap receipt are required; other actions never create fixtures");
}

/** Read-only checks use the exact owned objects which the domain services execute. */
async function snapshot() {
  const [{ getWorkshopConfigurationBaseline, listWorkshopEvents }, { getLoopInWorkshop, getLoopState }, { loopActionPolicySchema }] = await Promise.all([
    import("@/lib/workshops/service"), import("@/lib/loops/service"), import("@/lib/loops/spec"),
  ]);
  const baseline = await getWorkshopConfigurationBaseline(userId, workshopId);
  if (!baseline || baseline.workshop.userId !== userId) throw Error("Owned workshop unavailable");
  const loop = await getLoopInWorkshop({ userId, workshopId, loopId });
  if (!loop || loop.userId !== userId || loop.workshopId !== workshopId) throw Error("Owned Loop unavailable");
  if (loop.triggerConfig?.type !== "manual") throw Error("Acceptance requires an explicit manual Loop; scheduled tasks are not changed");
  const marker = object(loop.contextConfig).metadata;
  if (object(marker).acceptanceFixture !== fixtureMarker) throw Error("Loop lacks the explicit isolated acceptance-fixture marker");
  const policy = loopActionPolicySchema.parse(loop.actionPolicy);
  if (!policy.allowed.length || policy.allowed.some(name => !safeReadTools.has(leaf(name))) || policy.requiresApproval.length) throw Error("Acceptance requires an exact read-only tool allowlist without external/internal business writes");
  const [state, latest] = await Promise.all([getLoopState(loopId), listWorkshopEvents(workshopId, { order: "latest", limit: 1 })]);
  return plain({ schemaVersion: "memory-continuity-snapshot.v1", userId, workshopId, loopId,
    observedAt: new Date().toISOString(), commandVersion: baseline.commandVersion,
    workshopStatus: baseline.workshop.status, loopStatus: loop.status, trigger: loop.triggerConfig,
    loopGoal: loop.goal, loopContext: loop.contextConfig, actionPolicy: loop.actionPolicy,
    approvalPolicy: loop.approvalPolicy, retryPolicy: loop.retryPolicy,
    modelConfigHash: digest(baseline.workshop.modelConfig), goalHash: digest(loop.goal),
    loopConfigurationHash: digest([loop.goal, loop.contextConfig, loop.actionPolicy, loop.approvalPolicy, loop.retryPolicy]),
    state, lastEventSeq: latest.at(-1)?.seq ?? 0, sourceHashes: sourceHashes() });
}

function checkSession(session: any, current: any) {
  for (const key of ["userId", "workshopId", "loopId", "modelConfigHash", "goalHash", "loopConfigurationHash"]) {
    if (session.initial[key] !== current[key]) throw Error(`Acceptance identity/configuration drift: ${key}`);
  }
}

const runtimeSources = (hashes: Record<string, string>) => Object.fromEntries(Object.entries(hashes).filter(([path]) =>
  !path.endsWith("scripts/verify-memory-continuity.mjs") && !path.endsWith("scripts/verify-memory-continuity-followup.mjs")
  && !path.endsWith("scripts/verify-memory-continuity-resume.mjs")
  && !path.includes("scripts/lib/memory-continuity-verification")));
function safeArtifactName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\.json$/.test(name) || name.includes("..")) throw Error("Expected a local acceptance artifact filename");
}
const artifactHash = (name: string) => digest(readFileSync(resolve(output, name), "utf8"));
const originalBodyFailureNames = ["C: exact corrected body and current version supplied", "D: exact corrected body and current version supplied"];

function checkPriorArtifacts(hashes: Record<string, string>) {
  if (!Object.keys(hashes).length) throw Error("Original campaign artifact hash manifest is missing");
  for (const [name, hash] of Object.entries(hashes)) {
    safeArtifactName(name);
    if (artifactHash(name) !== hash) throw Error(`Preserved campaign artifact changed: ${name}`);
  }
}

async function checkRepairCorrection(repair: any) {
  const { getBrainMemoryForRevision } = await import("@/lib/memory/revision/revision");
  const current = await getBrainMemoryForRevision({ userId, memoryId: repair.correction.memoryId });
  if (current.memory.id !== repair.correction.memoryId || current.expectedVersion !== repair.correction.expectedVersion
    || digest(current.memory.content) !== repair.correction.contentHash || current.memory.status !== repair.correction.status
    || typeof repair.preservedConfidence === "number" && current.memory.confidence !== repair.preservedConfidence
    || current.memory.userId !== userId || current.memory.ownerType !== "work" || current.memory.ownerId !== workshopId) {
    throw Error("Current correction changed after repair plan; preserve evidence and create an explicit new plan");
  }
}

async function planRepair(original: any) {
  if (args.has("prior-repair-round")) return planRepairRetry(original);
  const priorReviewName = args.get("prior-review"); safeArtifactName(priorReviewName);
  if (!priorReviewName.startsWith("independent-review-")) throw Error("Repair requires the original independent review, not a supplemental audit");
  const review = read(priorReviewName);
  const failedNames = review.checks?.filter((item: any) => item.passed !== true).map((item: any) => item.name).sort();
  if (review.schemaVersion !== "memory-continuity-independent-review.v1" || review.status !== "failed"
    || review.mechanismPassed !== false || review.modelUsePassed !== true
    || digest(failedNames) !== digest([...originalBodyFailureNames].sort())) throw Error("Repair requires the preserved exact two original full-body failures");
  checkPriorArtifacts(review.artifactHashes);
  const previous = read("round-D.json"), current = await snapshot(); checkSession(original, current);
  const durable = object(previous.after?.state?.stateJson);
  if (previous.result?.result?.status !== "success" || previous.failure || durable.lastLoopRunId !== previous.result.loopRunId
    || durable.lastVerificationPassed !== true || durable.lastCheckerPassed !== true || durable.lastOutcomeAction !== "complete"
    || digest(current.state) !== digest(previous.after.state)) throw Error("Repair must continue the exact successful D state");
  if ((original.networkMode ?? "default") !== networkMode || (original.networkPreferredAddress ?? null) !== (args.get("network-prefer") ?? null)) throw Error("Repair cannot change saved network selection policy");
  const correction = read("correction.json"), correctedReview = existsSync(resolve(output, "review-corrected.json")) ? read("review-corrected.json") : null;
  const expected = correctedReview?.after ?? correction.afterNew;
  const oldSources = runtimeSources(original.initial.sourceHashes), newSources = runtimeSources(current.sourceHashes);
  const sourceDelta = [...new Set([...Object.keys(oldSources), ...Object.keys(newSources)])].sort()
    .filter(path => oldSources[path] !== newSources[path]).map(path => ({ path, beforeHash: oldSources[path] ?? null, afterHash: newSources[path] ?? null }));
  const allowedChangedPaths = ["apps/web/scripts/prove-memory-continuity.ts", "apps/web/lib/loops/context-window.ts",
    "apps/web/lib/workshops/mcp-tools.ts", "apps/web/lib/workshops/memory-evidence-reader.ts", "apps/web/lib/memory/evidence/reader.ts"];
  if (sourceDelta.some(item => !allowedChangedPaths.includes(item.path))) throw Error("Unexpected runtime changes outside the bounded repair; root must review the source delta");
  if (["apps/web/lib/loops/context-window.ts", "apps/web/lib/workshops/mcp-tools.ts", "apps/web/lib/workshops/memory-evidence-reader.ts"]
    .some(path => !sourceDelta.some(item => item.path === path && item.afterHash))) throw Error("Both bounded runtime repair implementations must be sealed before planning");
  const repair = { schemaVersion: "memory-continuity-repair-session.v1", createdAt: new Date().toISOString(), initial: current,
    acceptanceFixture: fixtureMarker, networkMode, networkPreferredAddress: args.get("network-prefer") ?? null,
    priorReview: { filename: priorReviewName, hash: artifactHash(priorReviewName), status: review.status, failedChecks: failedNames },
    preservedArtifacts: { ...review.artifactHashes, [priorReviewName]: artifactHash(priorReviewName) }, sourceDelta,
    sourceChangePolicy: { allowedChangedPaths, newlySealedExistingDependencies: ["apps/web/lib/memory/evidence/reader.ts"] },
    previousRunId: previous.result.loopRunId, originalSessionHash: artifactHash("session.json"),
    correction: { memoryId: expected.memory.id, expectedVersion: expected.expectedVersion, contentHash: digest(expected.memory.content), status: expected.memory.status },
    repairTargets: ["Preserve the full current correction body, scope and revision through context compaction", "Resolve typed Brain observation evidence with strict workshop authorization"],
    rounds: ["E: post-repair continuation from D", "F: independent subsequent post-repair continuation"],
    taskProtocol: "Unchanged persisted Loop goal and instructions; no replacement answer is copied into a new prompt",
    claims: { originalFourPassed: false, allSixSameFrozenSources: false, naturalTaskQualityImproved: false, costReduced: false, productionDeployed: false } };
  if (!sourceDelta.length) throw Error("Repair source receipt has no versioned changes");
  await checkRepairCorrection(repair);
  writeOnce("repair-session.json", repair);
  return { action, workshopId, loopId, status: "read_only_repair_preflight_saved", originalFailurePreserved: true, changedSources: sourceDelta.map(item => item.path) };
}

function eligibleExternalRetry(round: any) {
  return round?.round === "E" && !round.failure && round.result?.result?.status === "error"
    && typeof round.result.result.error === "string" && /\[data_inspection_failed\]/.test(round.result.result.error)
    && round.providerRequests?.length > 0 && round.providerRequests.every((request: any) => request.responseStatus === 200 && request.error === null)
    && round.events?.some((event: any) => event.type === "tool_error" && typeof event.body === "string" && event.body.includes("data_inspection_failed"))
    && round.after?.state?.stateJson?.lastLoopRunId === round.result.loopRunId && round.after.state.stateJson.lastJobStatus === "error"
    && round.after.state.stateJson.lastOutcomeAction === "fail" && round.after.state.stateJson.lastAttemptsUsed === 1;
}

async function planRepairRetry(original: any) {
  if (args.get("prior-repair-round") !== "E") throw Error("Only one explicit retry of the preserved external E failure is allowed");
  if (existsSync(resolve(output, "round-E2.json")) || existsSync(resolve(output, "round-E2-intent.json"))) throw Error("The single explicit retry was already attempted; no further attempts are created");
  const repair = read("repair-session.json"), failed = read("round-E.json"), current = await snapshot();
  checkSession(original, current); checkSession(repair, current); checkPriorArtifacts(repair.preservedArtifacts);
  if (repair.schemaVersion !== "memory-continuity-repair-session.v1" || !eligibleExternalRetry(failed)) throw Error("Preserved E does not match the explicitly allowed external stream failure");
  if ([failed.before.sourceHashes, failed.after.sourceHashes, failed.sourceHashes].some(hashes => digest(runtimeSources(hashes)) !== digest(runtimeSources(repair.initial.sourceHashes)))) throw Error("Failed E was outside the original repair freeze");
  if (digest(current.state) !== digest(failed.after.state)) throw Error("Retry must continue the exact failed E durable state");
  if (networkMode !== repair.networkMode || (args.get("network-prefer") ?? null) !== repair.networkPreferredAddress) throw Error("Retry cannot alter the provider transport selection policy");
  const beforeSources = runtimeSources(repair.initial.sourceHashes), afterSources = runtimeSources(current.sourceHashes);
  const sourceDelta = [...new Set([...Object.keys(beforeSources), ...Object.keys(afterSources)])].sort()
    .filter(path => beforeSources[path] !== afterSources[path]).map(path => ({ path, beforeHash: beforeSources[path] ?? null, afterHash: afterSources[path] ?? null }));
  const requiredRetryRuntime = ["apps/web/lib/memory/retrieval/candidates.ts", "apps/web/lib/memory/retrieval/recall.ts", "apps/web/lib/memory/context/pack.ts",
    "apps/web/lib/memory/context/workshop-memory.ts", "apps/web/lib/workshops/memory-context.ts", "apps/web/lib/loops/context-window.ts"];
  const allowedRetryChanges = ["apps/web/scripts/prove-memory-continuity.ts", ...requiredRetryRuntime, "apps/web/lib/loops/memory-recall-risk.ts"];
  if (!sourceDelta.length || sourceDelta.some(item => !allowedRetryChanges.includes(item.path))
    || sourceDelta.some(item => item.path === "apps/web/lib/loops/memory-recall-risk.ts" && item.beforeHash !== null)
    || requiredRetryRuntime.some(path => !sourceDelta.some(item => item.path === path && item.afterHash))) {
    throw Error("Retry requires the bounded own-work owner-feedback reservation fix; unexpected runtime changes require root review");
  }
  const retainedNames = ["repair-session.json", "round-E.json", "round-E-intent.json", ...failed.providerRequests.map((request: any) => request.requestBodyFile)];
  const preservedArtifacts = { ...repair.preservedArtifacts };
  for (const name of retainedNames) { safeArtifactName(name); preservedArtifacts[name] = artifactHash(name); }
  const correctedReadback = existsSync(resolve(output, "review-corrected.json")) ? read("review-corrected.json").after : read("correction.json").afterNew;
  const retry = { schemaVersion: "memory-continuity-retry-session.v1", createdAt: new Date().toISOString(), initial: current,
    acceptanceFixture: fixtureMarker, networkMode, networkPreferredAddress: repair.networkPreferredAddress,
    originalSessionHash: artifactHash("session.json"), priorRepairSessionHash: artifactHash("repair-session.json"),
    priorReview: repair.priorReview, correction: repair.correction, preservedArtifacts, sourceDelta,
    preservedConfidence: correctedReadback.memory.confidence,
    additionalSemanticRepair: { target: "reserve_current_own_work_owner_feedback_before_planner_filters_at_normal_risk",
      allowedChangedPaths: allowedRetryChanges, originalFailureObservedSeparately: "E automatic Brain context selected zero despite an available current owner correction",
      newlySealedExistingDependencies: [{ path: "apps/web/lib/loops/memory-recall-risk.ts", historicalSourceHash: null,
        interpretation: "Existing capability-derived risk classifier newly sealed for E2/F; no historical source-hash identity claim is made." }],
      protectedInvariants: ["No confidence or memory-content mutation", "No candidate approval bypass", "No cross-work authorization expansion", "Existing high-risk confidence and evidence gates remain"],
      selectionReceiptPolicy: "Retain only actual builder-selected id/revisionVersion provenance under the existing hard context budget; never invent identities or raise budget",
      modelFacingValuePolicy: "Carry stored confidence/status through the actual Brain builder and converter. Ranking score remains ranking only; missing legacy confidence/status remain unknown, never invented zero or active.",
      interpretation: "This is a source-versioned semantic repair separate from the external provider stream failure; it does not repair or bypass provider content inspection." },
    previousRunId: failed.result.loopRunId, priorFailedRound: { round: "E", hash: artifactHash("round-E.json"),
      failureClass: "provider_data_inspection_failed", resultStatus: "error", httpResponsesSucceededButStreamFailed: true },
    boundedRetry: { maximumAdditionalAttempts: 1, maximumAdditionalRounds: 2, perRunDomainMaxAttempts: 1, nextRounds: ["E2", "F"], automaticProviderRetry: false },
    repairTargets: [...repair.repairTargets, "Reserve authorized current own-work owner correction before normal-risk planner filters while retaining high-risk gates and original confidence",
      "Preserve the actual minimal selected memory identity receipt through compaction without increasing its hard budget",
      "Preserve actual stored confidence/status in model context; ranking score is not confidence and unknown values remain unknown"],
    taskProtocol: "Unchanged persisted goal and permissions. E2 must skip failed E history and obtain current Brain/fresh sources; no answer is pasted into a new prompt.",
    claims: { originalFourPassed: false, failedESucceeded: false, allRunsSameFrozenSources: false, naturalTaskQualityImproved: false, costReduced: false, productionDeployed: false } };
  await checkRepairCorrection(retry);
  writeOnce("retry-session.json", retry);
  return { action, status: "read_only_bounded_retry_preflight_saved", workshopId, loopId, previousRunId: retry.previousRunId, nextRounds: ["E2", "F"] };
}

function priorCampaignDirectory(savedPath?: string) {
  const value = savedPath ?? args.get("prior-campaign");
  if (!value) throw Error("Resume requires --prior-campaign=<preserved campaign directory>");
  const directory = resolve(repository, value), scoped = relative(repository, directory);
  if ((!scoped.startsWith(".tmp\\memory-continuity\\") && !scoped.startsWith(".tmp/memory-continuity/"))
    || directory === output) throw Error("Resume requires a distinct preserved acceptance directory");
  if (savedPath && args.has("prior-campaign") && resolve(repository, args.get("prior-campaign")!) !== directory) throw Error("Prior campaign differs from the immutable resume plan");
  return directory;
}

function readPriorArtifact(directory: string, name: string) {
  safeArtifactName(name);
  return JSON.parse(readFileSync(resolve(directory, name), "utf8"));
}

function checkResumePrior(session: any) {
  const directory = priorCampaignDirectory(session.priorCampaign.directory);
  if (!Object.keys(session.priorCampaign.artifactHashes ?? {}).length) throw Error("Resume prior artifact manifest is empty");
  for (const [name, expected] of Object.entries(session.priorCampaign.artifactHashes)) {
    safeArtifactName(name);
    if (digest(readFileSync(resolve(directory, name), "utf8")) !== expected) throw Error(`Preserved prior evidence changed: ${name}`);
  }
  return readPriorArtifact(directory, "round-E2.json");
}

function isFailedE2(round: any) {
  const main = (round?.providerRequests ?? []).filter((item: any) => item.kind === "working-memory-agent");
  const state = round?.after?.state?.stateJson;
  return round?.round === "E2" && !round.failure && round.result?.result?.status === "error"
    && /\[data_inspection_failed\]/.test(round.result.result.error ?? "") && main.length > 0
    && main.every((item: any) => item.responseStatus === 200 && item.error === null)
    && round.events?.some((event: any) => event.type === "tool_error" && event.body?.includes("data_inspection_failed"))
    && state?.lastLoopRunId === round.result.loopRunId && state.lastJobStatus === "error"
    && state.lastVerificationPassed === false && state.lastCheckerPassed === false && state.lastOutcomeAction === "fail" && state.lastAttemptsUsed === 1;
}

async function checkResumeProvider(session: any) {
  const current = await resolveBootstrapProvider();
  if (current.model !== session.provider.actualModel || current.protocol !== session.provider.protocol
    || current.endpointHash !== session.provider.resolution.endpointHash) throw Error("Actual winning provider model/protocol/endpoint changed; an explicit new plan is required");
  return current;
}

async function planResume() {
  if (existsSync(resolve(output, "session.json")) || existsSync(resolve(output, "bootstrap.json"))) throw Error("Resume uses a new ledger directory; never rewrite or reuse the original campaign");
  const directory = priorCampaignDirectory(), original = readPriorArtifact(directory, "session.json");
  const retry = readPriorArtifact(directory, "retry-session.json"), previous = readPriorArtifact(directory, "round-E2.json");
  const partialName = args.get("prior-review"); safeArtifactName(partialName);
  const partial = readPriorArtifact(directory, partialName), current = await snapshot();
  checkSession(original, current); checkSession(retry, current);
  if (!isFailedE2(previous) || digest(current.state) !== digest(previous.after.state)) throw Error("Resume must start from the exact preserved failed E2 durable state");
  if (partial.schemaVersion !== "memory-continuity-partial-retry-review.v1" || partial.status !== "incomplete_evidence" || partial.overallPassed !== false) throw Error("Resume requires the preserved incomplete independent retry review");
  if (networkMode !== retry.networkMode || (args.get("network-prefer") ?? null) !== retry.networkPreferredAddress) throw Error("Resume cannot change the saved provider transport selection policy");
  const oldBootstrap = readPriorArtifact(directory, "bootstrap.json"), priorMain = previous.providerRequests.filter((request: any) => request.kind === "working-memory-agent");
  const priorPayloadModels = priorMain.map((request: any) => readPriorArtifact(directory, request.requestBodyFile).payload?.model);
  const providerResolution = await resolveBootstrapProvider();
  if (!priorMain.length || new Set(priorPayloadModels).size !== 1 || !priorPayloadModels[0]
    || priorMain.some((request: any, index: number) => request.model !== priorPayloadModels[index] || request.endpointHash !== priorMain[0].endpointHash)
    || providerResolution.model !== priorPayloadModels[0] || providerResolution.protocol !== oldBootstrap.provider.protocol
    || providerResolution.endpointHash !== oldBootstrap.provider.endpointHash) throw Error("Resume must retain the actual preserved E2 model, protocol and endpoint; a key update alone does not authorize model switching");
  const maxRequests = Number(args.get("max-requests") ?? 10), maxSeconds = Number(args.get("max-seconds") ?? 360);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 10 || !Number.isSafeInteger(maxSeconds) || maxSeconds < 30 || maxSeconds > 360) throw Error("Resume budget must be at most 10 provider requests and 360 seconds per run");
  const priorSources = runtimeSources(retry.initial.sourceHashes), nextSources = runtimeSources(current.sourceHashes);
  const sourceDelta = [...new Set([...Object.keys(priorSources), ...Object.keys(nextSources)])].sort()
    .filter(path => priorSources[path] !== nextSources[path]).map(path => ({ path, beforeHash: priorSources[path] ?? null, afterHash: nextSources[path] ?? null }));
  const allowedChangedPaths = ["apps/web/scripts/prove-memory-continuity.ts", "apps/web/lib/loops/context-window.ts",
    "apps/web/lib/ai/agent-runtime-error.ts",
    "apps/web/lib/loops/native-executor.ts",
    "apps/web/lib/types/execution-result.ts",
    "packages/ai/src/agent/runtime/pi-model-config.ts", "packages/ai/src/agent/runtime/pi-harness-adapter.ts", "packages/ai/src/agent/runtime/pi-provider-terminal.ts",
    "packages/ai/src/agent/runtime/pi-stream-diagnostics.ts"];
  if (sourceDelta.some(item => !allowedChangedPaths.includes(item.path)) || !sourceDelta.some(item => item.path === "apps/web/lib/loops/context-window.ts" && item.afterHash)) throw Error("Unexpected resume runtime delta; root must review it before a new freeze");
  const artifactHashes: Record<string, string> = {};
  for (const name of readdirSync(directory).filter(name => name.endsWith(".json")).sort()) {
    safeArtifactName(name); artifactHashes[name] = digest(readFileSync(resolve(directory, name), "utf8"));
  }
  const resume = { schemaVersion: "memory-continuity-resume-session.v1", createdAt: new Date().toISOString(), initial: current,
    acceptanceFixture: fixtureMarker, networkMode, networkPreferredAddress: retry.networkPreferredAddress,
    provider: { actualModel: priorPayloadModels[0], actualEndpointHash: priorMain[0].endpointHash, protocol: oldBootstrap.provider.protocol,
      resolution: providerResolution, credentialValuesOrHashesRecorded: false },
    priorCampaign: { directory: relative(repository, directory), artifactHashes, latestRound: "E2", latestRunId: previous.result.loopRunId,
      priorPartialReview: partialName, priorPartialStatus: partial.status, originalFailureStatus: "failed", oldRetryCap: retry.boundedRetry },
    authorization: { date: "2026-10-18", scope: "User requested provider-output repair followed by real same-workshop correction stability tasks",
      supersedesExhaustedCapOnlyForNewPhase: true, preservesPriorFailures: true },
    previousRunId: previous.result.loopRunId, correction: retry.correction, preservedConfidence: retry.preservedConfidence,
    sourceDelta, sourceChangePolicy: { allowedChangedPaths,
      newOrPreviouslyUnsealedDependencies: sourceDelta.filter(item => item.beforeHash === null).map(item => item.path),
      interpretation: "New source version after provider repair, exact native terminal admission and warning preservation; old runs did not load it. A missing historical hash makes no claim about old file identity." },
    budget: { maxRequests, maxSeconds, maxToolCalls: 12, perRunDomainMaxAttempts: 1, maximumRounds: 3, automaticRetry: false, stopAfterFailure: true },
    rounds: ["R1", "R2", "R3"],
    taskProtocol: "Unchanged persisted goal, model and permissions. R1 must skip failed E2 history and save a fresh source-bound checkpoint; R2/R3 use its exact audited lineage. No prior answer or current label is inserted by this runner.",
    claims: { priorFailedRunsSucceeded: false, allHistoricalRunsSameFrozenSources: false, naturalTaskQualityImproved: false, causalMemoryBenefitProved: false, costReduced: false, productionDeployed: false } };
  await checkRepairCorrection(resume);
  checkResumePrior(resume);
  writeOnce("resume-session.json", resume);
  return { action, status: "read_only_resume_preflight_saved", workshopId, loopId, previousRunId: resume.previousRunId, nextRounds: resume.rounds, changedSources: sourceDelta.map(item => item.path) };
}

async function captureEvents(afterSeq: number, runId?: string) {
  const { listWorkshopEvents } = await import("@/lib/workshops/service");
  const events = await listWorkshopEvents(workshopId, { afterSeq, limit: 2001, order: "asc" });
  if (events.length > 2000) throw Error("Acceptance event history truncated; no partial success claim permitted");
  return plain(events.filter((event: { loopId?: string | null; loopRunId?: string | null }) => event.loopId === loopId && (!runId || event.loopRunId === runId)));
}

function installProviderBudget(round: string, afterSeq: number, network: Awaited<ReturnType<typeof prepareMemoryAcceptanceNetwork>>, defaults = { maxRequests: 6, maxSeconds: 240 }, expectedMain?: { actualModel: string; actualEndpointHash: string }) {
  const maxRequests = Number(args.get("max-requests") ?? defaults.maxRequests), maxSeconds = Number(args.get("max-seconds") ?? defaults.maxSeconds);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 10 || !Number.isSafeInteger(maxSeconds) || maxSeconds < 30 || maxSeconds > 600) throw Error("Invalid explicit acceptance budget");
  const originalFetch = globalThis.fetch;
  const startedAt = Date.now(), requests: any[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    let payload: any = null;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() === "POST") {
      try {
        const raw = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : null;
        if (raw) payload = JSON.parse(raw);
      } catch { /* Ordinary non-model request. */ }
    }
    const modelRequest = payload && typeof payload.model === "string" && (Array.isArray(payload.messages) || Array.isArray(payload.input) || typeof payload.input === "string");
    if (!modelRequest) return originalFetch(input, network.apply(url, init));
    if (requests.length >= maxRequests || Date.now() - startedAt >= maxSeconds * 1000) throw Error("Acceptance model dispatch budget exhausted before transmission");
    const remainingMs = maxSeconds * 1000 - (Date.now() - startedAt);
    const mainAgent = Array.isArray(payload.tools) && payload.tools.some((tool: any) => (tool.function?.name ?? tool.name) === "workingMemory");
    if (mainAgent && expectedMain && (payload.model !== expectedMain.actualModel || digest(url.origin + url.pathname) !== expectedMain.actualEndpointHash)) throw Error("Main model or endpoint drift rejected before transmission");
    const request = { index: requests.length + 1, round, dispatchedAt: null as string | null,
      endpointHash: digest(url.origin + url.pathname), model: payload.model, payloadHash: digest(payload),
      kind: mainAgent ? "working-memory-agent" : /embeddings?\b/i.test(url.pathname) ? "embedding-dependency" : "other-model",
      requestBodyFile: `round-${round}-provider-${requests.length + 1}.json`, responseStatus: null as number | null, error: null as string | null,
      hostPrepared: null as Record<string, unknown> | null };
    // Bodies are private local acceptance artifacts; headers and credential values are never captured.
    writeOnce(request.requestBodyFile, { payload, payloadHash: request.payloadHash });
    requests.push(request);
    try {
      if (mainAgent) {
        const { listWorkshopEvents } = await import("@/lib/workshops/service");
        const candidates = await listWorkshopEvents(workshopId, { afterSeq, types: ["working_memory_projected"], limit: 100, order: "asc" });
        const prepared = candidates.filter((event: { loopId?: string | null; metadata: Record<string, unknown> }) => event.loopId === loopId
          && event.metadata.receiptAuthority === "runtime" && event.metadata.status === "provider_request_prepared").at(-1);
        if (!prepared) throw Error("No persisted own-run prepared receipt before provider dispatch");
        request.hostPrepared = { eventId: prepared.id, seq: prepared.seq, createdAt: prepared.createdAt,
          version: prepared.metadata.version, policyIdentity: prepared.metadata.policyIdentity, loopRunId: prepared.loopRunId };
      }
      const existingSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = existingSignal ? AbortSignal.any([existingSignal, AbortSignal.timeout(remainingMs)]) : AbortSignal.timeout(remainingMs);
      request.dispatchedAt = new Date().toISOString();
      const response = await originalFetch(input, network.apply(url, { ...init, signal }));
      request.responseStatus = response.status;
      return response;
    } catch (error) {
      request.error = error instanceof Error ? error.name : "unknown_error";
      throw error;
    }
  };
  return { requests, budget: { maxRequests, maxSeconds, maxToolCalls: 12, priceUsd: null, priceStatus: "not_calculated" },
    stop() { globalThis.fetch = originalFetch; return Date.now() - startedAt; } };
}

async function runRound(session: any) {
  const round = args.get("round");
  const resuming = session.schemaVersion === "memory-continuity-resume-session.v1";
  if (!round || !(resuming ? /^R[123]$/ : /^(?:[ABCDEF]|E2)$/).test(round)) throw Error("Run requires an explicitly planned round (resume: R1|R2|R3)");
  const retrying = session.schemaVersion === "memory-continuity-retry-session.v1", repairing = ["E", "E2", "F"].includes(round);
  if (repairing && !["memory-continuity-repair-session.v1", "memory-continuity-retry-session.v1"].includes(session.schemaVersion)) throw Error("Repair rounds require an explicit immutable plan");
  if (round === "E2" && !retrying) throw Error("E2 requires the single bounded retry plan");
  const previousName = resuming ? round === "R1" ? "E2" : `R${Number(round.slice(1)) - 1}`
    : round === "E2" ? "E" : round === "F" && retrying ? "E2" : String.fromCharCode(round.charCodeAt(0) - 1);
  const previous = resuming && round === "R1" ? checkResumePrior(session) : round === "A" ? null : read(`round-${previousName}.json`);
  const allowedFailedPredecessor = resuming && round === "R1" ? isFailedE2(previous) && session.previousRunId === previous.result.loopRunId
    : round === "E2" && retrying && eligibleExternalRetry(previous)
      && session.priorFailedRound.hash === artifactHash("round-E.json") && session.previousRunId === previous.result.loopRunId;
  if (previous && previous.result?.result?.status !== "success" && !allowedFailedPredecessor) throw Error("Previous round did not succeed; no implicit retry or fallback to older history is allowed");
  if (round === "B" && !existsSync(resolve(output, "review-initial.json"))) throw Error("B requires an explicit reviewed candidate receipt");
  if (["C", "D", "E", "E2", "F"].includes(round) && !existsSync(resolve(output, "correction.json"))) throw Error("Corrected rounds require a versioned correction receipt");
  if (existsSync(resolve(output, `round-${round}.json`)) || existsSync(resolve(output, `round-${round}-intent.json`))) throw Error("Round already attempted; successes, failures and incomplete intents are immutable");
  const before = await snapshot();
  checkSession(session, before);
  const providerResolution = resuming ? await checkResumeProvider(session) : null;
  if (repairing || resuming) {
    if (resuming) checkResumePrior(session); else checkPriorArtifacts(session.preservedArtifacts);
    if (digest(runtimeSources(before.sourceHashes)) !== digest(runtimeSources(session.initial.sourceHashes))) throw Error("Repair runtime/runner changed after its frozen plan");
    if (digest(before.state) !== digest(previous.after.state)) throw Error("Repair predecessor durable state changed");
    await checkRepairCorrection(session);
  }
  if (before.workshopStatus !== "active" || before.loopStatus !== "active") throw Error("Acceptance does not resume paused/archived work");
  process.env.LOOP_MAX_TOOL_CALLS = "12";
  if ((session.networkMode ?? "default") !== networkMode || (session.networkPreferredAddress ?? null) !== (args.get("network-prefer") ?? null)) throw Error("Acceptance network mode differs from saved session");
  if (resuming && (Number(args.get("max-requests") ?? session.budget.maxRequests) !== session.budget.maxRequests
    || Number(args.get("max-seconds") ?? session.budget.maxSeconds) !== session.budget.maxSeconds)) throw Error("Resume budget differs from its immutable plan");
  const network = await prepareMemoryAcceptanceNetwork(networkMode as "default" | "verified-direct-opencode", { preferredAddress: args.get("network-prefer") });
  const budget = installProviderBudget(round, before.lastEventSeq, network, resuming ? session.budget : undefined, resuming ? session.provider : undefined);
  let result: any = null, failure: any = null, after: any = null, events: any[] = [];
  const intent = { commandId: command(`run-${round}`), expectedVersion: before.commandVersion,
    source: "owner" as const, reason: `Explicit owner-requested isolated memory continuity acceptance round ${round}`,
    userId, workId: workshopId, loopId, mode: "native_agent" as const, createOutboxDrafts: false };
  const planFilename = resuming ? "resume-session.json" : retrying ? "retry-session.json" : repairing ? "repair-session.json" : "session.json";
  const campaignPlan = { filename: planFilename, hash: artifactHash(planFilename) };
  writeOnce(`round-${round}-intent.json`, { intent, before, campaignPlan, taskProtocol: "Fixed persisted Loop goal; no previous answer is copied into a new prompt" });
  try {
    const { runWorkLoop } = await import("@/lib/work-runtime/commands");
    result = plain(await runWorkLoop(intent));
  } catch (error) { failure = { name: error instanceof Error ? error.name : "unknown_error", code: object(error).code ?? null }; }
  finally {
    const durationMs = budget.stop();
    try { after = await snapshot(); events = await captureEvents(before.lastEventSeq, result?.loopRunId); }
    catch (error) { failure ??= { name: error instanceof Error ? error.name : "receipt_error", code: object(error).code ?? null }; }
    const usageEvents = events.filter(event => event.type === "working_memory_usage" && event.metadata?.receiptAuthority === "runtime");
    writeOnce(`round-${round}.json`, { schemaVersion: "memory-continuity-round.v1", round, intent, before, after,
      result, failure, events, usageEvents, providerRequests: budget.requests, budget: budget.budget, durationMs,
      ...(resuming ? { providerResolution } : {}),
      sourceHashes: sourceHashes(), campaignPlan, network: network.metadata, naturalTask: false, taskKind: "explicit mechanism acceptance using real workshop execution",
      claims: { businessQualityImproved: false, costReduced: false, productionDeployed: false } });
    await network.close();
  }
  if (failure || result?.result?.status !== "success" || !budget.requests.length) throw Error(`Round ${round} failed or lacks observed real provider requests; evidence retained`);
  return { round, loopRunId: result.loopRunId, status: result.result.status, modelRequests: budget.requests.length };
}

async function promote(session: any) {
  const initial = read("round-A.json");
  if (initial.result?.result?.status !== "success") throw Error("A must succeed before promotion");
  const current = await snapshot(); checkSession(session, current);
  const checkpoint = initial.events.filter((event: any) => event.type === "working_memory_updated").at(-1);
  const noteKey = args.get("note-key");
  if (!noteKey || !checkpoint) throw Error("Explicit --note-key from A's actual final saved notebook is required");
  const { promoteWorkingMemory } = await import("@/lib/workshops/working-memory-promotion-service");
  const commandValue = { runKind: "loop", loopId, runId: initial.result.loopRunId,
    noteKey, expectedVersion: checkpoint.metadata.version, commandId: command("promote") };
  const result = await promoteWorkingMemory({ userId, workshopId, command: commandValue });
  const { getBrainMemoryForRevision } = await import("@/lib/memory/revision/revision");
  const memory = await getBrainMemoryForRevision({ userId, memoryId: result.candidateId });
  assertStoredText(memory.memory.content);
  writeOnce("promotion.json", { command: commandValue, result, memory, events: await captureEvents(current.lastEventSeq) });
  return result;
}

async function review(session: any) {
  checkSession(session, await snapshot());
  const initial = read("promotion.json"), correction = existsSync(resolve(output, "correction.json")) ? read("correction.json") : null;
  const memoryId = args.has("memory") ? requiredId("memory") : initial.result.candidateId;
  if (![initial.result.candidateId, correction?.result?.newMemory?.id].includes(memoryId)) throw Error("Review target is outside this isolated acceptance chain");
  const name = memoryId === initial.result.candidateId ? "review-initial.json" : "review-corrected.json";
  if (existsSync(resolve(output, name))) throw Error("Review receipt exists; inspect it rather than repeating the command");
  const { getBrainMemoryForRevision } = await import("@/lib/memory/revision/revision");
  const { reviewMemory: reviewBrainMemory } = await import("@/lib/memory/revision/writes");
  const before = await getBrainMemoryForRevision({ userId, memoryId });
  if (before.memory.status !== "candidate") throw Error("Review accepts only this exercise's current pending candidate");
  const request = { requester: { type: "chat" as const, userId, id: command("owner-review") }, memoryId,
    decision: "confirmed" as const, expectedVersion: before.expectedVersion, evidenceConfirmed: true,
    reason: "Owner-authorized isolated acceptance fixture: actual source and candidate content checked before confirming; not general stable user knowledge" };
  const result = await reviewBrainMemory(request);
  const after = await getBrainMemoryForRevision({ userId, memoryId });
  if (after.memory.content !== before.memory.content) throw Error("Review changed acceptance content unexpectedly");
  assertStoredText(after.memory.content);
  writeOnce(name, { request, before, result, after });
  if (after.memory.status !== "verified") throw Error("Review readback did not become verified");
  return { memoryId, status: after.memory.status };
}

async function correct(session: any) {
  checkSession(session, await snapshot());
  const initial = read("promotion.json");
  if (!existsSync(resolve(output, "round-B.json"))) throw Error("Correction requires retained B evidence before introducing new information");
  const file = args.get("correction-file");
  if (!file) throw Error("Explicit UTF-8 --correction-file required; no inline replacement answer");
  const correction = JSON.parse(readFileSync(resolve(file), "utf8"));
  if (correction.acceptanceFixture !== fixtureMarker || typeof correction.content !== "string" || !correction.content.includes(fixtureMarker) || typeof correction.reason !== "string" || !correction.reason.trim()) throw Error("Correction must be an explicitly labeled acceptance fixture with content and reason");
  const { getBrainMemoryForRevision, reviseBrainMemory } = await import("@/lib/memory/revision/revision");
  const before = await getBrainMemoryForRevision({ userId, memoryId: initial.result.candidateId });
  const request = { commandId: command("correct"), expectedVersion: before.expectedVersion,
    operation: "correct", authority: "owner_statement", content: correction.content, reason: correction.reason, evidenceRefs: [] };
  const result = await reviseBrainMemory({ requester: { type: "chat", userId, id: command("owner-correction") }, memoryId: before.memory.id, request });
  if (!result.newMemory) throw Error("Correction returned no replacement memory");
  const afterOld = await getBrainMemoryForRevision({ userId, memoryId: result.oldMemory.id });
  const afterNew = await getBrainMemoryForRevision({ userId, memoryId: result.newMemory.id });
  assertStoredText(afterNew.memory.content);
  if (afterNew.memory.content !== correction.content) throw Error("Correction content failed exact UTF-8 readback");
  const assertions = object(correction.evaluationAssertions);
  const outputIncludes = Array.isArray(assertions.outputIncludes) ? assertions.outputIncludes.filter((value: unknown): value is string => typeof value === "string" && !!value.trim()) : [];
  const outputExcludes = Array.isArray(assertions.outputExcludes) ? assertions.outputExcludes.filter((value: unknown): value is string => typeof value === "string" && !!value.trim()) : [];
  writeOnce("correction.json", { request, before, result, afterOld, afterNew, fixtureFileHash: digest(readFileSync(resolve(file), "utf8")),
    evaluationAssertions: { outputIncludes, outputExcludes, suppliedToRunPrompt: false, interpretation: "Narrow owner-defined fixture checks, not an independent research quality score" },
    independentlyVerifiesExternalFact: false });
  if (afterOld.memory.status !== "superseded" || !afterNew.memory.supersedes?.includes(afterOld.memory.id)) throw Error("Correction version chain failed readback");
  return { oldMemoryId: afterOld.memory.id, newMemoryId: afterNew.memory.id, status: afterNew.memory.status,
    reviewRequired: afterNew.memory.status === "candidate" };
}

async function main() {
  if (action === "bootstrap") return bootstrap();
  loadTargetIdentity();
  if (action === "plan-resume") return planResume();
  if (existsSync(resolve(output, "resume-session.json"))) {
    const resumed = read("resume-session.json");
    if (action !== "run" || resumed.acceptanceFixture !== fixtureMarker) throw Error("Resume ledger only accepts its three explicitly planned run actions");
    return runRound(resumed);
  }
  if (action === "plan") {
    const initial = await snapshot();
    const session = { schemaVersion: "memory-continuity-session.v1", createdAt: new Date().toISOString(), initial,
      acceptanceFixture: fixtureMarker, networkMode, networkPreferredAddress: args.get("network-prefer") ?? null, execution: "real runWorkLoop / Pi Harness / persistent Brain review and revision",
      rounds: ["A: source reading and notebook", "B: confirmed Brain recall", "C: versioned correction then recall", "D: independent subsequent recall"],
      taskKind: "explicit mechanism acceptance; not a natural-task quality evaluation",
      defaultBudget: { rounds: 4, providerRequestsPerRound: 6, secondsPerRound: 240, totalProviderRequests: 24, maximumRunSeconds: 960 },
      noAutomaticCleanup: true, noProductionDeployment: true };
    writeOnce("session.json", session);
    return { action, workshopId, loopId, commandVersion: initial.commandVersion, status: "read_only_preflight_saved" };
  }
  const session = read("session.json");
  if (session.acceptanceFixture !== fixtureMarker) throw Error("Acceptance fixture mismatch");
  if (action === "plan-repair") return planRepair(session);
  if (action === "run") {
    const round = args.get("round") ?? "";
    return runRound(round === "E2" || round === "F" && existsSync(resolve(output, "retry-session.json")) ? read("retry-session.json")
      : ["E", "F"].includes(round) ? read("repair-session.json") : session);
  }
  if (action === "promote") return promote(session);
  if (action === "review") return review(session);
  return correct(session);
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  // Never print provider headers/config, raw DB errors, private model input or stack.
  const failure = { action, status: "failed", observedAt: new Date().toISOString(),
    error: object(error).cause ? "Domain service failed; original application audit must be inspected" : error instanceof Error ? error.message.slice(0, 400) : "unknown_error",
    code: object(error).code ?? null };
  writeOnce(`failure-${action}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, failure);
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  await (await import("@/lib/db/adapters")).closeDb();
}
