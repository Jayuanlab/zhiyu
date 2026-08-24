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
  const compactItems = (items: WorkshopMemoryContextPack["coreState"]) =>
    items.slice(0, maxItems).map((item) => ({
      ...item,
      content: truncateString(item.content, maxContentChars),
      sourceEventIds: item.sourceEventIds.slice(0, 5),
      reasons: item.reasons.slice(0, 5),
    }));

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
      compacted[key] = compactValue(value);
    } else {
      omittedStateKeys.push(key);
    }
  }

  if (!compacted.loopSpec) {
    compacted.loopSpec = input.loopSpec;
  }

  let remainingChars = input.maxChars - jsonChars(compacted);
  if (remainingChars > 0) {
    for (const [key, value] of Object.entries(input.stateJson)) {
      if (key in compacted) continue;
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
      mission: truncateString(input.workshop.mission, 2_000),
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
      .slice(0, profileBudget.directiveLimit)
      .map((directive) => ({
        id: directive.id,
        scope: directive.scope,
        priority: directive.priority,
        content: truncateString(directive.content, 900),
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

  if (originalChars <= maxChars) {
    return {
      ...base,
      compacted: false,
      originalChars,
      compactedChars: originalChars,
      maxChars,
      contextProfile,
      omittedSections: [],
    };
  }

  let compacted = {
    ...base,
    workshop: {
      ...base.workshop,
      mission: truncateString(base.workshop.mission, 1_000),
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
    directives: base.directives.slice(
      0,
      Math.max(5, Math.ceil(profileBudget.directiveLimit / 2)),
    ).map((directive) => ({
      ...directive,
      content: truncateString(directive.content, 500),
    })),
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
      "workshopMission",
      "sourceContent",
      "memories",
      "directives",
      "recentEvents",
    ]) {
      if (!omittedSections.includes(section)) omittedSections.push(section);
    }
    compacted = {
      ...compacted,
      workshop: {
        ...compacted.workshop,
        mission: truncateString(compacted.workshop.mission, 700),
      },
      sources: compacted.sources.slice(0, 5).map((source) => ({
        ...source,
        content: null,
      })),
      memories: compacted.memories.slice(0, 10),
      memoryContext: compactMemoryContext(compacted.memoryContext, 5, 220),
      directives: compacted.directives.slice(0, 8).map((directive) => ({
        ...directive,
        content: truncateString(directive.content, 240),
      })),
      recentEvents: compacted.recentEvents.slice(-10).map((event) => ({
        ...event,
        body: event.body ? truncateString(event.body, 160) : null,
      })),
    };
    compactedChars = jsonChars(compacted);
  }

  return {
    ...compacted,
    compacted: true,
    originalChars,
    compactedChars,
    maxChars,
    contextProfile,
    omittedSections,
  };
}
