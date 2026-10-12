import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import { randomUUID } from "node:crypto";
import type { JevRoutingResult } from "./jev-recall-router";
import { getBrainRecallPlannerMode } from "./recall-policy";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import type {
  BrainMemoryStatus,
  BrainMemoryType,
  BrainRequester,
  BrainSourceFilters,
  BrainScope,
} from "./types";
import type { BrainCanonicalKind } from "./canonical";
import type { InformationNeed } from './information-needs';

export type BrainMemoryRequest = {
  /** Trusted caller restriction for optional discovery, independent of model routing. */
  discoverySources?: Array<"knowledge" | "graph">;
  informationNeeds?: InformationNeed[];
  requester: BrainRequester;
  taskIntent: string;
  platformState?: {
    platform?: "chat" | "workshop" | "work" | "loop" | "mcp_tool" | "system";
    phase?: string;
    riskLevel?: "low" | "normal" | "high";
    currentStateVerified?: boolean;
    highRiskAction?: boolean;
    notes?: string;
  };
  action?: {
    kind?:
      | "answer"
      | "plan"
      | "execute"
      | "review"
      | "write_memory"
      | "external_message"
      | "trade"
      | "config_change";
    description?: string;
  };
  sourceFilters?: BrainSourceFilters;
  maxItems?: number;
  memoryLimit?: number;
  /** Set false when the outer agent owns query exploration. */
  allowQueryRetry?: boolean;
};

export type BrainRecallRoute = {
  route:
    | "brain_memory"
    | "knowledge_store"
    | "memory_graph"
    | "evidence_read";
  purpose: "canonical" | "evidence" | "derived_index" | "fallback";
  enabled: boolean;
  reason: string;
};

export type BrainRecallPlan = {
  interfaceVersion: "brain-recall-plan.v1";
  mode: "rules" | "llm" | "fallback_rules" | "jev";
  /** Retained for previously recorded plans; the rules planner does not call Jev. */
  routing?: JevRoutingResult;
  statuses: BrainMemoryStatus[];
  memoryTypes?: BrainMemoryType[];
  canonicalKinds?: BrainCanonicalKind[];
  scopes?: BrainScope[];
  minConfidence?: number;
  updatedAfter?: string;
  searchTerms: string[];
  includeCandidates: boolean;
  maxItems: number;
  memoryLimit: number;
  routes: BrainRecallRoute[];
  rationale: string[];
  warnings: string[];
  queryRetry?: { query: string; searchTerms: string[]; reason: string };
};

type RawRecallPlan = Partial<
  Omit<BrainRecallPlan, "interfaceVersion" | "mode" | "rationale" | "warnings">
> & {
  rationale?: unknown;
  warnings?: unknown;
};

const MEMORY_TYPES = new Set<BrainMemoryType>([
  "fact",
  "preference",
  "boundary",
  "relationship",
  "plan",
  "task",
  "insight",
  "system",
]);

const CANONICAL_KINDS = new Set<BrainCanonicalKind>([
  "boundary",
  "preference",
  "state",
  "plan",
  "commitment",
  "lesson",
  "profile",
  "fact",
]);

const STATUSES = new Set<BrainMemoryStatus>([
  "candidate",
  "active",
  "verified",
  "weakened",
  "superseded",
  "deleted",
]);

const RECALL_ROUTES = new Set<BrainRecallRoute["route"]>([
  "brain_memory",
  "knowledge_store",
  "memory_graph",
  "evidence_read",
]);

const ROUTE_PURPOSES = new Set<BrainRecallRoute["purpose"]>([
  "canonical",
  "evidence",
  "derived_index",
  "fallback",
]);

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildOpenAICompatibleBaseUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) {
    return normalized.replace(/\/chat\/completions$/, "");
  }
  if (normalized.endsWith("/v1")) return normalized;
  return `${normalized}/v1`;
}

function createRecallPlannerModel(config: {
  apiKey: string;
  baseUrl: string;
  model: string;
}) {
  return createOpenAICompatible({
    baseURL: buildOpenAICompatibleBaseUrl(config.baseUrl),
    name: "brain-recall-planner",
    apiKey: config.apiKey,
    headers: recallProviderHeaders(config.baseUrl),
  }).chatModel(config.model);
}

async function resolveRecallPlannerProviderConfig(userId: string) {
  const apiKey =
    normalizeOptionalString(process.env.BRAIN_RECALL_PLANNER_LLM_API_KEY) ??
    normalizeOptionalString(process.env.MEMORY_RECALL_LLM_API_KEY) ??
    normalizeOptionalString(process.env.LLM_API_KEY);
  const baseUrl =
    normalizeOptionalString(process.env.BRAIN_RECALL_PLANNER_LLM_BASE_URL) ??
    normalizeOptionalString(process.env.MEMORY_RECALL_LLM_BASE_URL) ??
    normalizeOptionalString(process.env.LLM_BASE_URL);
  const model =
    normalizeOptionalString(process.env.BRAIN_RECALL_PLANNER_LLM_MODEL) ??
    normalizeOptionalString(process.env.MEMORY_RECALL_LLM_MODEL) ??
    normalizeOptionalString(process.env.LLM_MODEL);
  if (apiKey && baseUrl && model) {
    return { apiKey, baseUrl, model, protocol: "openai" as const };
  }

  const openai = await getUserLlmProviderConfig({
    userId,
    providerType: "openai_compatible",
  });
  if (openai) return { ...openai, protocol: "openai" as const };
  const anthropic = await getUserLlmProviderConfig({ userId, providerType: "anthropic_compatible" });
  return anthropic ? { ...anthropic, protocol: "anthropic" as const } : undefined;
}

function recallProviderHeaders(baseUrl: string): Record<string, string> {
  return /opencode\.ai\/zen\/go(?:\/|$)/i.test(baseUrl)
    ? { "x-opencode-session": `zhiyu-brain-recall-${randomUUID()}` } : {};
}

async function generateRecallPlanText(config: NonNullable<Awaited<ReturnType<typeof resolveRecallPlannerProviderConfig>>>, prompt: string) {
  const signal = AbortSignal.timeout(25_000);
  if (config.protocol === "anthropic") {
    const base = config.baseUrl.replace(/\/+$/, "");
    const endpoint = base.endsWith("/messages") ? base : base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    const response = await fetch(endpoint, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", ...recallProviderHeaders(base) },
      body: JSON.stringify({ model: config.model, max_tokens: 1400, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    if (!response.ok) throw new Error(`recall_provider_http_${response.status}`);
    const body = await response.json() as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
    if (!text?.trim()) throw new Error("recall_provider_empty_response");
    return text;
  }
  const response = await generateText({
    model: createRecallPlannerModel(config), prompt, temperature: 0, maxOutputTokens: 1400,
    abortSignal: signal, maxRetries: 0,
    providerOptions: { openai: { responseFormat: { type: "json_object" } } },
  });
  return response.text;
}

function uniqueStrings(values: string[], limit: number) {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase().normalize("NFKC"))
        .filter((value) => value.length >= 2),
    ),
  ).slice(0, limit);
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeMemoryTypes(value: unknown) {
  const items = asStringArray(value).filter((item): item is BrainMemoryType =>
    MEMORY_TYPES.has(item as BrainMemoryType),
  );
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function normalizeCanonicalKinds(value: unknown) {
  const items = asStringArray(value).filter((item): item is BrainCanonicalKind =>
    CANONICAL_KINDS.has(item as BrainCanonicalKind),
  );
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function normalizeStatuses(
  value: unknown,
  includeCandidates: boolean,
): BrainMemoryStatus[] {
  const items = asStringArray(value).filter((item): item is BrainMemoryStatus =>
    STATUSES.has(item as BrainMemoryStatus),
  );
  const statuses: BrainMemoryStatus[] =
    items.length > 0
      ? items
      : (["active", "verified", "weakened"] as BrainMemoryStatus[]);
  if (includeCandidates && !statuses.includes("candidate")) {
    statuses.push("candidate");
  }
  return statuses.filter(
    (status) => status !== "deleted" && status !== "superseded",
  );
}

function normalizeScopes(
  value: unknown,
  requester: BrainRequester,
): BrainScope[] | undefined {
  const records = Array.isArray(value) ? value : [];
  const scopes: BrainScope[] = [];
  for (const item of records) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const scope = item as Record<string, unknown>;
    if (scope.type === "global") scopes.push({ type: "global" });
    if (scope.type === "work" && typeof scope.workId === "string") {
      scopes.push({ type: "work", workId: scope.workId });
    }
    if (scope.type === "workshop" && typeof scope.workshopId === "string") {
      scopes.push({ type: "workshop", workshopId: scope.workshopId });
    }
    if (scope.type === "workspace" && typeof scope.workspaceId === "string") {
      scopes.push({ type: "workspace", workspaceId: scope.workspaceId });
    }
  }
  if (scopes.length > 0) return scopes;
  // Work identity and persisted scope are separate: legacy workshop records
  // remain valid when a Loop also carries its parent Work identity.
  const defaultScopes: BrainScope[] = [];
  if (requester.workId) {
    defaultScopes.push({ type: "work", workId: requester.workId });
  }
  if (requester.workshopId) {
    defaultScopes.push({ type: "workshop", workshopId: requester.workshopId });
  }
  return defaultScopes.length ? defaultScopes : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.round(parsed)))
    : fallback;
}

function isoUpdatedAfter(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizeRecallRoutes(value: unknown): BrainRecallRoute[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const routes: BrainRecallRoute[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (
      !RECALL_ROUTES.has(record.route as BrainRecallRoute["route"]) ||
      !ROUTE_PURPOSES.has(record.purpose as BrainRecallRoute["purpose"])
    ) {
      continue;
    }
    routes.push({
      route: record.route as BrainRecallRoute["route"],
      purpose: record.purpose as BrainRecallRoute["purpose"],
      enabled: record.enabled !== false,
      reason:
        typeof record.reason === "string" && record.reason.trim()
          ? record.reason.trim().slice(0, 240)
          : "planner_selected",
    });
  }
  return routes.length > 0 ? routes : undefined;
}

function defaultRecallRoutes(input: {
  text: string;
  highRisk: boolean;
  includeCandidates: boolean;
}): BrainRecallRoute[] {
  const routes: BrainRecallRoute[] = [
    {
      route: "brain_memory",
      purpose: "canonical",
      enabled: true,
      reason: "Brain Memory is the canonical long-term memory source.",
    },
  ];
  if (
    input.highRisk ||
    input.includeCandidates ||
    /audit|evidence|source|raw|\u5ba1\u8ba1|\u8bc1\u636e|\u539f\u59cb|\u6765\u6e90/.test(
      input.text,
    )
  ) {
    routes.push({
      route: "evidence_read",
      purpose: "evidence",
      enabled: true,
      reason: "Task may need source evidence before relying on memory.",
    });
  }
  if (
    /document|knowledge|file|chunk|rag|\u6587\u6863|\u77e5\u8bc6|\u8d44\u6599/.test(
      input.text,
    )
  ) {
    routes.push({
      route: "knowledge_store",
      purpose: "evidence",
      enabled: true,
      reason: "Task mentions documents or knowledge sources.",
    });
  }
  if (
    /relationship|graph|entity|person|project|symbol|\u5173\u7cfb|\u56fe\u8c31|\u5b9e\u4f53|\u4eba|\u9879\u76ee|\u6807\u7684/.test(
      input.text,
    )
  ) {
    routes.push({
      route: "memory_graph",
      purpose: "derived_index",
      enabled: true,
      reason: "Task may benefit from entity or relationship expansion.",
    });
  }
  return routes;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(jsonrepair(fenced));
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(jsonrepair(trimmed.slice(start, end + 1)));
    }
    return JSON.parse(jsonrepair(trimmed));
  }
}

function taskKeywordFallback(taskIntent: string) {
  const terms = taskIntent.match(/[\p{L}\p{N}_.-]{2,}/gu) ?? [];
  return uniqueStrings(terms, 8);
}

export function buildRuleBasedBrainRecallPlan(
  request: BrainMemoryRequest,
  warning?: string,
): BrainRecallPlan {
  const text = [
    request.taskIntent,
    request.action?.kind,
    request.action?.description,
    request.platformState?.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFKC");
  const highRisk =
    request.platformState?.riskLevel === "high" ||
    request.platformState?.highRiskAction ||
    request.action?.kind === "trade" ||
    request.action?.kind === "external_message" ||
    request.action?.kind === "config_change";
  const includeCandidates =
    request.action?.kind === "review" || request.action?.kind === "write_memory";
  const memoryTypes = new Set<BrainMemoryType>();
  const canonicalKinds = new Set<BrainCanonicalKind>();
  if (
    highRisk ||
    /risk|boundary|\u7981\u6b62|\u8fb9\u754c|\u98ce\u9669|\u8d8a\u6743/.test(
      text,
    )
  ) {
    memoryTypes.add("boundary");
    canonicalKinds.add("boundary");
  }
  if (/plan|\u7b56\u7565|\u8ba1\u5212|\u6267\u884c|\u5b89\u6392/.test(text)) {
    memoryTypes.add("plan");
    canonicalKinds.add("plan");
  }
  if (
    /current|state|status|\u5f53\u524d|\u72b6\u6001|\u8d26\u6237|\u6301\u4ed3|\u81ea\u9009\u80a1/.test(
      text,
    )
  ) {
    memoryTypes.add("fact");
    canonicalKinds.add("state");
  }
  if (
    /review|lesson|failure|\u590d\u76d8|\u5931\u8d25|\u6559\u8bad|\u9519\u8bef/.test(
      text,
    )
  ) {
    memoryTypes.add("insight");
    canonicalKinds.add("lesson");
  }
  if (
    /preference|\u504f\u597d|\u4e60\u60ef|\u559c\u6b22|\u4e0d\u559c\u6b22/.test(
      text,
    )
  ) {
    memoryTypes.add("preference");
    canonicalKinds.add("preference");
  }
  return {
    interfaceVersion: "brain-recall-plan.v1",
    mode: warning ? "fallback_rules" : "rules",
    statuses: includeCandidates
      ? (["candidate", "active", "verified", "weakened"] as BrainMemoryStatus[])
      : (["active", "verified", "weakened"] as BrainMemoryStatus[]),
    memoryTypes: memoryTypes.size > 0 ? Array.from(memoryTypes) : undefined,
    canonicalKinds:
      canonicalKinds.size > 0 ? Array.from(canonicalKinds) : undefined,
    scopes: normalizeScopes(undefined, request.requester),
    minConfidence: highRisk ? 60 : undefined,
    searchTerms: taskKeywordFallback(request.taskIntent),
    includeCandidates,
    maxItems: clampInteger(request.maxItems, 12, 1, 24),
    memoryLimit: clampInteger(request.memoryLimit, 200, 20, 500),
    routes: defaultRecallRoutes({ text, highRisk, includeCandidates }),
    rationale: ["rule_based_recall_plan"],
    warnings: warning ? [warning] : [],
  };
}

export function sanitizeBrainRecallPlan(
  request: BrainMemoryRequest,
  raw: RawRecallPlan,
): BrainRecallPlan {
  const includeCandidates = Boolean(raw.includeCandidates);
  const text = [
    request.taskIntent,
    request.action?.kind,
    request.action?.description,
    request.platformState?.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFKC");
  const highRisk =
    request.platformState?.riskLevel === "high" ||
    request.platformState?.highRiskAction ||
    request.action?.kind === "trade" ||
    request.action?.kind === "external_message" ||
    request.action?.kind === "config_change";
  return {
    interfaceVersion: "brain-recall-plan.v1",
    mode: "llm",
    statuses: normalizeStatuses(raw.statuses, includeCandidates),
    memoryTypes: normalizeMemoryTypes(raw.memoryTypes),
    canonicalKinds: normalizeCanonicalKinds(raw.canonicalKinds),
    scopes: normalizeScopes(raw.scopes, request.requester),
    minConfidence:
      typeof raw.minConfidence === "number"
        ? Math.max(0, Math.min(100, Math.round(raw.minConfidence)))
        : undefined,
    updatedAfter: isoUpdatedAfter(raw.updatedAfter),
    searchTerms: uniqueStrings(raw.searchTerms ?? [], 12),
    includeCandidates,
    maxItems: clampInteger(raw.maxItems, request.maxItems ?? 12, 1, 24),
    memoryLimit: clampInteger(raw.memoryLimit, request.memoryLimit ?? 200, 20, 500),
    routes:
      normalizeRecallRoutes(raw.routes) ??
      defaultRecallRoutes({ text, highRisk, includeCandidates }),
    rationale: asStringArray(raw.rationale).slice(0, 8),
    warnings: asStringArray(raw.warnings).slice(0, 8),
    queryRetry: normalizeQueryRetry(raw.queryRetry, request.taskIntent),
  };
}

function normalizeQueryRetry(value: unknown, original: string): BrainRecallPlan["queryRetry"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 240) : "";
  const searchTerms = uniqueStrings(asStringArray(raw.searchTerms).filter(term => term.length <= 80), 6);
  if (!query || query.length > 500 || !reason || !searchTerms.length ||
      query.normalize("NFKC").toLowerCase() === original.trim().normalize("NFKC").toLowerCase()) return undefined;
  return { query, searchTerms, reason };
}

function buildRecallPlannerPrompt(request: BrainMemoryRequest) {
  return [
    "You are the recall planner for a unified memory platform.",
    "Use your language understanding to convert the request into precise memory recall parameters.",
    "Return valid JSON only. Do not include markdown or explanations.",
    "Do not decide final permissions. The Brain platform will enforce permissions after this plan.",
    "Prefer narrow, high-signal recall. Do not include raw chat/history unless the task explicitly asks for audit or evidence.",
    "Use candidate memories only for review/write-memory tasks. Use active/verified/weakened for normal execution.",
    "For high-risk tasks, include boundary memories and raise minConfidence when appropriate.",
    "Allowed memoryTypes: fact, preference, boundary, relationship, plan, task, insight, system.",
    "Allowed canonicalKinds: boundary, preference, state, plan, commitment, lesson, profile, fact.",
    "Allowed statuses: candidate, active, verified, weakened.",
    "Allowed routes: brain_memory, knowledge_store, memory_graph, evidence_read.",
    "Route purpose must be one of: canonical, evidence, derived_index, fallback.",
    "Always include brain_memory as enabled canonical route. Use knowledge_store for documents, memory_graph for entity expansion, and evidence_read for audit/high-risk/source verification.",
    "Optionally prepare queryRetry: {query, searchTerms, reason} for ONE retry if retrieval is empty or the evidence checker finds insufficient coverage. The application decides whether to execute it. Omit it if no faithful alternative exists.",
    "The alternative must preserve the original intent, named entities, dates, negations and constraints. Use only known aliases or equivalent wording; never invent a person, project, date or answer. It cannot change permissions or filters.",
    "",
    "Required JSON shape:",
    JSON.stringify({
      statuses: ["active", "verified", "weakened"],
      memoryTypes: ["boundary", "plan"],
      canonicalKinds: ["boundary", "state"],
      scopes: [{ type: "work", workId: "optional" }],
      minConfidence: 60,
      updatedAfter: "2026-08-20T00:00:00.000Z",
      searchTerms: ["short", "domain", "entities"],
      includeCandidates: false,
      maxItems: 12,
      memoryLimit: 200,
      routes: [
        {
          route: "brain_memory",
          purpose: "canonical",
          enabled: true,
          reason: "canonical long-term memory",
        },
      ],
      rationale: ["why these recall channels are needed"],
      warnings: ["planner caveats"],
    }),
    "",
    "Memory request:",
    JSON.stringify(request),
  ].join("\n");
}

export async function buildBrainRecallPlan(
  request: BrainMemoryRequest,
): Promise<BrainRecallPlan> {
  if (getBrainRecallPlannerMode() === "rules") return buildRuleBasedBrainRecallPlan(request);
  let config: Awaited<ReturnType<typeof resolveRecallPlannerProviderConfig>>;
  try {
    config = await resolveRecallPlannerProviderConfig(request.requester.userId);
  } catch {
    return buildRuleBasedBrainRecallPlan(request, "llm_recall_planner_configuration_unavailable");
  }
  if (!config) {
    return buildRuleBasedBrainRecallPlan(
      request,
      "llm_recall_planner_not_configured",
    );
  }

  try {
    const text = await generateRecallPlanText(config, buildRecallPlannerPrompt(request));
    return sanitizeBrainRecallPlan(
      request,
      extractJsonObject(text) as RawRecallPlan,
    );
  } catch (error) {
    return buildRuleBasedBrainRecallPlan(
      request,
      `llm_recall_planner_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
