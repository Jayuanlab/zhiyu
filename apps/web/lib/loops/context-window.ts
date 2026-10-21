import type {
  LoopState,
  Workshop,
  WorkshopDirective,
  WorkshopEvent,
  WorkshopMemory,
  WorkshopSource,
} from "@/lib/db/schema";
import {
  getContextProfileBudget,
  type ContextProfile,
} from "@/lib/ai/context-profile";
import {
  formatWorkshopBoundaryPolicy,
  getWorkshopBoundaryPolicy,
} from "@/lib/workshops/boundary-policy";
import {
  buildWorkshopMemoryContextPack,
  type WorkshopMemoryContextPack,
} from "@/lib/workshops/memory-context";
import type { LoopSpec } from "./spec";

export interface LoopContextWindowResult {
  durableState: {
    currentPhase: string;
    memorySummary: string | null;
    openQuestions: unknown[];
    lastObservation: string | null;
    nextAction: string | null;
    blockedReason: string | null;
    stateJson: Record<string, unknown>;
  };
  compacted: boolean;
  originalChars: number;
  compactedChars: number;
  maxChars: number;
  contextProfile: ContextProfile;
  omittedStateKeys: string[];
}

export interface LoopWorkshopContextResult {
  workshop: {
    id: string;
    name: string;
    mission: string;
    status: string;
    autonomyLevel: string;
  };
  boundaryPolicy: string;
  sources: Array<{
    id: string;
    type: string;
    name: string;
    uri: string | null;
    content: string | null;
    contentAvailable: boolean;
    lastCheckedAt: string | null;
  }>;
  memories: Array<{
    id: string;
    kind: string;
    confidence: number;
    tags: string[];
    sourceEventIds: string[];
    contentAvailable: boolean;
  }>;
  memoryContext: WorkshopMemoryContextPack;
  memoryRecall: {
    backend: "brain" | "legacy";
    contextLogId?: string;
    recallPlan?: unknown;
    selection?: unknown;
    explanation?: unknown;
    contextPack?: unknown;
    routeResults?: unknown;
    fallbackReason?: string | null;
    error?: string | null;
  };
  directives: Array<{
    id: string;
    scope: string;
    priority: number;
    content: string;
  }>;
  recentEvents: Array<{
    id: string;
    seq: number;
    type: string;
    title: string;
    body: string | null;
    loopId: string | null;
    loopRunId: string | null;
    createdAt: string;
  }>;
  compacted: boolean;
  originalChars: number;
  compactedChars: number;
  maxChars: number;
  contextProfile: ContextProfile;
  omittedSections: string[];
}

const DEFAULT_LOOP_CONTEXT_MAX_CHARS = 24_000;
const DEFAULT_WORKSHOP_CONTEXT_MAX_CHARS = 18_000;
const MAX_OPEN_QUESTIONS = 8;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 20;

const ESSENTIAL_STATE_KEYS = new Set([
  "businessCheckpoint",
  "loopSpec",
  "templateId",
  "lastLoopRunId",
  "lastExecutionId",
  "lastExecutionMode",
  "lastJobStatus",
  "lastVerificationPassed",
  "lastCheckerPassed",
  "lastOutcomeAction",
  "attemptsRemaining",
  "lastApprovalRequiresApproval",
  "lastApprovalDenied",
  "lastActionGuardBlocked",
  "lastActionGuardMode",
  "nextScheduledRunAt",
  "lastScheduledRunAt",
  "schedulerStatus",
  "schedulerError",
  "approvalReplayHistory",
  "pendingApprovalContinuations",
  "consumedApprovalContinuations",
]);

function parsePositiveIntEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonChars(value: unknown) {
  try {
    return JSON.stringify(value ?? {}).length;
  } catch {
    return String(value).length;
  }
}

function truncateString(value: string, maxChars = MAX_STRING_CHARS) {
  return value.length > maxChars
    ? `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`
    : value;
}

function dateToIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function normalizeSourceEventIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

const HIGH_VALUE_EVENT_TYPES = new Set([
  "blocked",
  "budget_exceeded",
  "decision",
  "degraded",
  "directive_planned",
  "error",
  "memory_written",
  "permission_decision",
  "source_checked",
  "tool_error",
  "watchlist_proposal",
  "workshop_agent_change_proposed",
  "workshop_insight_change_proposed",
]);

const LOW_VALUE_EVENT_TYPES = new Set([
  "agent_text",
  "context_budget_report",
  "loop_run_completed",
  "loop_run_started",
  "run_completed",
  "run_started",
  "tool_result",
]);

function selectPromptEvents(
  events: WorkshopEvent[],
  maxEvents: number,
): WorkshopEvent[] {
  const selected = new Map<string, WorkshopEvent>();
  for (const event of events) {
    if (HIGH_VALUE_EVENT_TYPES.has(event.type)) {
      selected.set(event.id, event);
    }
  }
  for (const event of events.slice(-maxEvents)) {
    if (!LOW_VALUE_EVENT_TYPES.has(event.type)) {
      selected.set(event.id, event);
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-maxEvents);
}

function compactMemoryContext(
  context: WorkshopMemoryContextPack,
  maxItems: number,
  maxContentChars: number,
): WorkshopMemoryContextPack {
  const compactReasons = (reasons: string[]) => {
    // Safety qualifiers and current-revision provenance govern how a memory may
    // be used. Keep their actual values before optional ranking explanations.
    const warnings = reasons.filter(reason => reason.startsWith('warning:'));
    const isRevision = (reason: string) => reason === 'relevant_recent_revision' || reason === 'reserved_relevant_revision';
    const revisions = reasons.filter(isRevision);
    const generic = reasons.filter(reason => !reason.startsWith('warning:') && !isRevision(reason));
    return [...warnings, ...revisions, ...generic.slice(0, Math.max(0, 5 - warnings.length - revisions.length))];
  };
  const compactItems = (items: WorkshopMemoryContextPack["coreState"]) => {
    const protectedItems = items.filter(item => isProtectedMemory(item, context));
    const ordinary = items.filter(item => !isProtectedMemory(item, context));
    return [...protectedItems, ...ordinary.slice(0, Math.max(0, maxItems - protectedItems.length))].map((item) => ({
      ...item,
      // A correction's last sentence may reverse its meaning. Keep it whole or
      // replace the whole body with an explicit read requirement at the budget gate.
      content: isProtectedMemory(item, context) ? item.content : truncateString(item.content, maxContentChars),
      ...(isProtectedMemory(item, context) ? { contentStatus: 'full' as const } : {}),
      ...(!isProtectedMemory(item, context) && item.content.length > maxContentChars
        ? { contentStatus: 'snippet' as const, originalContentChars: item.content.length } : {}),
      sourceEventIds: item.sourceEventIds.slice(0, 5),
      reasons: compactReasons(item.reasons),
    }));
  };

  return {
    ...context,
    taskIntent: truncateString(context.taskIntent, maxContentChars),
    coreState: compactItems(context.coreState),
    taskRelevantMemories: compactItems(context.taskRelevantMemories),
    recentLessons: compactItems(context.recentLessons),
    riskBoundaries: compactItems(context.riskBoundaries),
    evidenceRefs: context.evidenceRefs.slice(0, 20),
    openQuestions: context.openQuestions
      .slice(0, 5)
      .map((item) => truncateString(item, maxContentChars)),
  };
}

type MemoryContextItem = WorkshopMemoryContextPack['taskRelevantMemories'][number];
const MEMORY_SECTIONS = ['riskBoundaries', 'taskRelevantMemories', 'coreState', 'recentLessons'] as const;
function isProtectedMemory(item: MemoryContextItem, context: WorkshopMemoryContextPack) {
  return item.kind === 'boundary' || Boolean(item.supersedes?.length) || context.correctionMemoryIds?.includes(item.id) === true
    || context.riskBoundaries.some(boundary => boundary.id === item.id);
}

type WorkshopContextPayload = Omit<LoopWorkshopContextResult,
  'compacted' | 'originalChars' | 'compactedChars' | 'maxChars' | 'contextProfile' | 'omittedSections'>;
function workshopContextResult(payload: WorkshopContextPayload, metadata: {
  compacted: boolean; originalChars: number; maxChars: number; contextProfile: ContextProfile; omittedSections: string[];
}): LoopWorkshopContextResult {
  const result = { ...payload, ...metadata, compactedChars: 0 };
  // Count the delivered wrapper as well as its payload; the length of this
  // counter stabilizes after at most a few decimal-digit changes.
  for (let pass = 0; pass < 4; pass++) {
    const measured = jsonChars(result);
    if (measured === result.compactedChars) break;
    result.compactedChars = measured;
  }
  return result;
}

/** Retain completion evidence, never planner queries or arbitrary response text. */
function compactRecallPlan(value: unknown) {
  const plan = asRecord(value);
  const allowed = (item: unknown, choices: readonly string[]) =>
    typeof item === 'string' && choices.includes(item) ? item : null;
  const reason = (item: unknown) => {
    if (typeof item !== 'string') return null;
    const code = item.split(':', 1)[0];
    return ['llm_recall_planner_configuration_unavailable', 'llm_recall_planner_not_configured',
      'llm_recall_planner_failed'].includes(code) ? code : 'details_omitted';
  };
  const rawProvider = asRecord(plan.provider);
  const provider = plan.provider && typeof plan.provider === 'object' && !Array.isArray(plan.provider) ? {
    source: allowed(rawProvider.source, ['env_openai_compatible', 'env_anthropic_compatible',
      'user_openai_compatible', 'user_anthropic_compatible']),
    model: typeof rawProvider.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,159}$/.test(rawProvider.model)
      ? rawProvider.model : null,
    protocol: allowed(rawProvider.protocol, ['openai-completions', 'anthropic-messages']),
    finishReason: allowed(rawProvider.finishReason, ['stop', 'end_turn', 'stop_sequence', 'tool_use', 'length',
      'max_tokens', 'content_filter', 'error', 'aborted', 'unknown']),
    thinkingMode: allowed(rawProvider.thinkingMode, ['disabled', 'enabled', 'adaptive']),
    migrated: typeof rawProvider.migrated === 'boolean' ? rawProvider.migrated : null,
  } : null;
  return {
    mode: allowed(plan.mode, ['rules', 'llm', 'fallback_rules', 'jev']) ?? 'unknown', provider,
    degraded: typeof plan.degraded === 'boolean' ? plan.degraded : null,
    fallbackReason: reason(plan.fallbackReason),
    // Free-form warnings may repeat a query or an upstream response. Preserve
    // their presence/count and safe host codes, with explicit detail omission.
    warnings: Array.isArray(plan.warnings) ? plan.warnings.slice(0, 4).map(reason) : null,
    warningCount: Array.isArray(plan.warnings) ? plan.warnings.length : null,
  };
}

/** Preserve control meaning before optional context. Never return an oversized
 * or silently shortened authoritative memory as though it were complete. */
function fitWorkshopContext(payload: WorkshopContextPayload, metadata: {
  originalChars: number; maxChars: number; contextProfile: ContextProfile; omittedSections: string[];
}): LoopWorkshopContextResult {
  const omitted = metadata.omittedSections;
  const mark = (section: string) => { if (!omitted.includes(section)) omitted.push(section); };
  const result = () => workshopContextResult(payload, { ...metadata, omittedSections: omitted, compacted: true });
  const over = () => result().compactedChars > metadata.maxChars;
  // These are index/progress aids, not the current accepted correction body.
  while (over() && payload.recentEvents.length) { payload.recentEvents.shift(); mark('recentEvents'); }
  if (over()) {
    const originalPack = asRecord(payload.memoryRecall.contextPack);
    const selected = Array.isArray(originalPack.selected) ? originalPack.selected.map(entry => {
      const receipt = asRecord(entry);
      if (typeof receipt.id !== 'string' || !receipt.id.trim()
        || receipt.revisionVersion !== undefined && typeof receipt.revisionVersion !== 'string')
        throw new Error('loop_workshop_memory_selection_receipt_invalid');
      return { id: receipt.id, ...(receipt.revisionVersion === undefined ? {} : { revisionVersion: receipt.revisionVersion }) };
    }) : undefined;
    payload.memoryRecall = { backend: payload.memoryRecall.backend, contextLogId: payload.memoryRecall.contextLogId,
      recallPlan: compactRecallPlan(payload.memoryRecall.recallPlan),
      fallbackReason: payload.memoryRecall.fallbackReason, error: payload.memoryRecall.error,
      ...(selected === undefined ? {} : { contextPack: { selected } }),
      routeResults: Array.isArray(payload.memoryRecall.routeResults) ? payload.memoryRecall.routeResults
        .filter(route => route && typeof route === 'object' && route.route === 'brain_memory')
        .map(route => ({ route: 'brain_memory', status: route.status,
          ...(route.error ? { error: 'primary_memory_route_error' } : {}) })) : payload.memoryRecall.routeResults === undefined ? undefined : null };
    mark('memoryRecallDetails');
  }
  while (over() && payload.sources.length) { payload.sources.pop(); mark('sources'); }
  while (over() && payload.memories.length) { payload.memories.pop(); mark('memories'); }
  if (over()) {
    const seen = new Set<string>();
    for (const section of MEMORY_SECTIONS) payload.memoryContext[section] = payload.memoryContext[section].filter(item => {
      if (seen.has(item.id)) { mark('duplicateMemoryContextEntries'); return false; }
      seen.add(item.id); return true;
    });
  }
  for (const section of [...MEMORY_SECTIONS].reverse()) {
    while (over()) {
      const index = payload.memoryContext[section].findLastIndex(item => !isProtectedMemory(item, payload.memoryContext));
      if (index < 0) break;
      payload.memoryContext[section].splice(index, 1); mark('ordinaryMemoryContext');
    }
  }
  // Only memory bodies may be deferred. Owner directives, the Work role/mission
  // and action/approval boundaries are protected core and are never shortened.
  while (over()) {
    const options = MEMORY_SECTIONS.flatMap(section => payload.memoryContext[section].map((item, index) => ({
      section, index, size: item.content.length,
    }))).filter(option => option.size > 0).sort((left, right) => right.size - left.size);
    const option = options.find(candidate =>
      (payload.memoryContext[candidate.section][candidate.index] as MemoryContextItem & { contentStatus?: string }).contentStatus !== 'omitted_requires_read');
    if (!option) break;
    const item = payload.memoryContext[option.section][option.index];
    payload.memoryContext[option.section][option.index] = { ...item, content: '', status: 'requires_full_read',
      contentStatus: 'omitted_requires_read', originalStatus: item.status, originalContentChars: item.content.length,
      readRequired: { tool: 'workshopReadMemory', input: { limit: 50, includeCandidates: false }, memoryId: item.id,
        expectedRevisionVersion: item.revisionVersion ?? null,
        instruction: 'Full current memory body was omitted for budget. Read the exact ID and version before relying on it; if unavailable, stop and ask the owner. An empty body is not an empty rule.' },
    } as MemoryContextItem;
    mark('authoritativeMemoryBodiesRequireRead');
  }
  const fitted = result();
  if (fitted.compactedChars > metadata.maxChars) throw new Error('loop_workshop_required_context_budget_exceeded');
  return fitted;
}

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) return "[truncated nested object]";

  if (Array.isArray(value)) {
    return value.slice(Math.max(0, value.length - MAX_ARRAY_ITEMS)).map((item) =>
      compactValue(item, depth + 1),
    );
  }

  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      compactValue(item, depth + 1),
    ]),
  );
}

function compactStateJson(input: {
  stateJson: Record<string, unknown>;
  loopSpec: LoopSpec;
  maxChars: number;
}): { stateJson: Record<string, unknown>; omittedStateKeys: string[] } {
  const compacted: Record<string, unknown> = {};
  const omittedStateKeys: string[] = [];

  for (const [key, value] of Object.entries(input.stateJson)) {
    if (ESSENTIAL_STATE_KEYS.has(key)) {
      compacted[key] = key === 'businessCheckpoint' ? value : compactValue(value);
    } else {
      omittedStateKeys.push(key);
    }
  }

  if (!compacted.loopSpec) {
    compacted.loopSpec = input.loopSpec;
  }

  if(jsonChars(compacted)>input.maxChars&&'businessCheckpoint' in compacted){
    delete compacted.businessCheckpoint;omittedStateKeys.push('businessCheckpoint');
  }
  let remainingChars = input.maxChars - jsonChars(compacted);
  if (remainingChars > 0) {
    for (const [key, value] of Object.entries(input.stateJson)) {
      if (key in compacted) continue;
      if(key==='businessCheckpoint')continue;
      const nextValue = compactValue(value);
      const nextChars = jsonChars({ [key]: nextValue });
      if (nextChars <= remainingChars) {
        compacted[key] = nextValue;
        remainingChars -= nextChars;
        const index = omittedStateKeys.indexOf(key);
        if (index >= 0) omittedStateKeys.splice(index, 1);
      }
    }
  }

  if (omittedStateKeys.length > 0) {
    compacted._contextCompaction = {
      omittedStateKeys,
      reason: "State exceeded Loop prompt context budget",
    };
  }

  return { stateJson: compacted, omittedStateKeys };
}

export function prepareLoopContextWindow(input: {
  state: LoopState | null;
  loopSpec: LoopSpec;
  maxChars?: number;
  contextProfile?: ContextProfile;
}): LoopContextWindowResult {
  const contextProfile = input.contextProfile ?? "normal";
  const profileBudget = getContextProfileBudget(contextProfile);
  const maxChars =
    input.maxChars ??
    parsePositiveIntEnv(
      "LOOP_CONTEXT_MAX_CHARS",
      profileBudget.loopStateMaxChars || DEFAULT_LOOP_CONTEXT_MAX_CHARS,
    );
  const rawStateJson = asRecord(input.state?.stateJson);
  const originalState = {
    currentPhase: input.state?.currentPhase ?? "idle",
    memorySummary: input.state?.memorySummary ?? null,
    openQuestions: Array.isArray(input.state?.openQuestions)
      ? input.state.openQuestions
      : [],
    lastObservation: input.state?.lastObservation ?? null,
    nextAction: input.state?.nextAction ?? null,
    blockedReason: input.state?.blockedReason ?? null,
    stateJson: rawStateJson,
  };
  const originalChars = jsonChars(originalState);

  if (originalChars <= maxChars) {
    return {
      durableState: originalState,
      compacted: false,
      originalChars,
      compactedChars: originalChars,
      maxChars,
      contextProfile,
      omittedStateKeys: [],
    };
  }

  const { stateJson, omittedStateKeys } = compactStateJson({
    stateJson: rawStateJson,
    loopSpec: input.loopSpec,
    maxChars: Math.max(1_000, maxChars - 2_000),
  });
  const durableState = {
    currentPhase: originalState.currentPhase,
    memorySummary: originalState.memorySummary
      ? truncateString(originalState.memorySummary, 4_000)
      : null,
    openQuestions: originalState.openQuestions.slice(-MAX_OPEN_QUESTIONS),
    lastObservation: originalState.lastObservation
      ? truncateString(originalState.lastObservation)
      : null,
    nextAction: originalState.nextAction
      ? truncateString(originalState.nextAction)
      : null,
    blockedReason: originalState.blockedReason
      ? truncateString(originalState.blockedReason)
      : null,
    stateJson,
  };

  return {
    durableState,
    compacted: true,
    originalChars,
    compactedChars: jsonChars(durableState),
    maxChars,
    contextProfile,
    omittedStateKeys,
  };
}

export function prepareLoopWorkshopContext(input: {
  workshop: Workshop;
  sources: WorkshopSource[];
  memories: WorkshopMemory[];
  directives: WorkshopDirective[];
  events: WorkshopEvent[];
  taskIntent?: string | null;
  memoryContext?: WorkshopMemoryContextPack;
  memoryRecall?: LoopWorkshopContextResult["memoryRecall"];
  maxChars?: number;
  contextProfile?: ContextProfile;
}): LoopWorkshopContextResult {
  const contextProfile = input.contextProfile ?? "normal";
  const profileBudget = getContextProfileBudget(contextProfile);
  const maxChars =
    input.maxChars ??
    parsePositiveIntEnv(
      "LOOP_WORKSHOP_CONTEXT_MAX_CHARS",
      profileBudget.workshopContextMaxChars ||
        DEFAULT_WORKSHOP_CONTEXT_MAX_CHARS,
    );
  const memoryContext =
    input.memoryContext ??
    buildWorkshopMemoryContextPack({
      workshop: input.workshop,
      memories: input.memories,
      directives: input.directives,
      events: input.events,
      taskIntent: input.taskIntent,
    });
  const base = {
    workshop: {
      id: input.workshop.id,
      name: input.workshop.name,
      mission: input.workshop.mission,
      status: input.workshop.status,
      autonomyLevel: input.workshop.autonomyLevel,
    },
    boundaryPolicy: formatWorkshopBoundaryPolicy(
      getWorkshopBoundaryPolicy(input.workshop),
    ),
    sources: input.sources
      .filter((source) => source.enabled)
      .slice(0, profileBudget.sourceLimit)
      .map((source) => ({
        id: source.id,
        type: source.type,
        name: source.name,
        uri: source.uri ? truncateString(source.uri, 700) : null,
        content: null,
        contentAvailable: Boolean(source.content),
        lastCheckedAt: dateToIso(source.lastCheckedAt),
      })),
    memories: input.memories.slice(0, profileBudget.memoryRefLimit).map((memory) => ({
      id: memory.id,
      kind: memory.kind,
      confidence: memory.confidence,
      tags: normalizeTags(memory.tags),
      sourceEventIds: normalizeSourceEventIds(memory.sourceEventIds),
      contentAvailable: Boolean(memory.content),
    })),
    memoryContext,
    memoryRecall: input.memoryRecall ?? {
      backend: "legacy" as const,
      fallbackReason: "legacy_context_builder",
    },
    directives: input.directives
      .filter((directive) => directive.scope === "persistent")
      .map((directive) => ({
        id: directive.id,
        scope: directive.scope,
        priority: directive.priority,
        content: directive.content,
      })),
    recentEvents: selectPromptEvents(input.events, profileBudget.eventLimit).map((event) => ({
      id: event.id,
      seq: event.seq,
      type: event.type,
      title: event.title,
      body: event.body ? truncateString(event.body, 500) : null,
      loopId: event.loopId ?? null,
      loopRunId: event.loopRunId ?? null,
      createdAt: dateToIso(event.createdAt) ?? "",
    })),
  };
  const originalChars = jsonChars(base);

  const unchanged = workshopContextResult(base, { compacted: false, originalChars, maxChars, contextProfile, omittedSections: [] });
  if (unchanged.compactedChars <= maxChars) return unchanged;

  let compacted = {
    ...base,
    workshop: {
      ...base.workshop,
    },
    sources: base.sources.slice(0, Math.max(3, Math.ceil(profileBudget.sourceLimit / 2))).map((source) => ({
      ...source,
      content: null,
    })),
    memories: base.memories.slice(
      0,
      Math.max(5, Math.ceil(profileBudget.memoryRefLimit / 2)),
    ),
    memoryContext: compactMemoryContext(base.memoryContext, 8, 400),
    directives: base.directives,
    recentEvents: base.recentEvents.slice(
      -Math.max(8, Math.ceil(profileBudget.eventLimit / 2)),
    ).map((event) => ({
      ...event,
      body: event.body ? truncateString(event.body, 240) : null,
    })),
  };
  let compactedChars = jsonChars(compacted);
  const omittedSections = [
    input.sources.some((source) => !source.enabled) ? "disabledSources" : null,
    base.sources.length > compacted.sources.length ? "sources" : null,
    base.memories.length > compacted.memories.length ? "memories" : null,
    base.directives.length > compacted.directives.length
      ? "directives"
      : null,
    base.recentEvents.length > compacted.recentEvents.length
      ? "recentEvents"
      : null,
  ].filter((section): section is string => Boolean(section));

  if (compactedChars > maxChars) {
    for (const section of [
      "sourceContent",
      "memories",
      "recentEvents",
    ]) {
      if (!omittedSections.includes(section)) omittedSections.push(section);
    }
    compacted = {
      ...compacted,
      workshop: {
        ...compacted.workshop,
      },
      sources: compacted.sources.slice(0, 5).map((source) => ({
        ...source,
        content: null,
      })),
      memories: compacted.memories.slice(0, 10),
      memoryContext: compactMemoryContext(compacted.memoryContext, 5, 220),
      directives: compacted.directives,
      recentEvents: compacted.recentEvents.slice(-10).map((event) => ({
        ...event,
        body: event.body ? truncateString(event.body, 160) : null,
      })),
    };
    compactedChars = jsonChars(compacted);
  }

  return fitWorkshopContext(compacted, { originalChars, maxChars, contextProfile, omittedSections });
}
