import type {
  Workshop,
  WorkshopDirective,
  WorkshopEvent,
  WorkshopMemory,
} from "@/lib/db/schema";

import { formatInformationReadiness, type InformationReadiness } from '@/lib/brain/information-needs';
const RECENCY_WINDOW_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_TOKEN_COUNT = 240;

export type WorkshopMemoryContextItem = {
  id: string;
  kind: string;
  status: string;
  content: string;
  confidence: number;
  tags: string[];
  sourceEventIds: string[];
  score: number;
  reasons: string[];
};

export type WorkshopMemoryContextPack = {
  informationReadiness?: InformationReadiness;
  controlModel: "engineering_cybernetics_v1";
  taskIntent: string;
  coreState: WorkshopMemoryContextItem[];
  taskRelevantMemories: WorkshopMemoryContextItem[];
  recentLessons: WorkshopMemoryContextItem[];
  riskBoundaries: WorkshopMemoryContextItem[];
  evidenceRefs: string[];
  openQuestions: string[];
  omittedReason: string | null;
  stats: {
    totalMemories: number;
    activeMemories: number;
    candidateMemories: number;
    verifiedMemories: number;
    weakenedMemories: number;
    dismissedMemories: number;
    expiredMemories: number;
    selectedMemories: number;
  };
};

function truncate(value: string, max = 420) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function dateValue(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizeTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeSourceEventIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function chineseNgrams(text: string) {
  const chars = [...text.replace(/[^\u4e00-\u9fff]/g, "")];
  const result: string[] = [];
  for (const size of [2, 3, 4]) {
    for (let index = 0; index <= chars.length - size; index += 1) {
      result.push(chars.slice(index, index + size).join(""));
      if (result.length >= MAX_TOKEN_COUNT) return result;
    }
  }
  return result;
}

function tokens(text: string) {
  const normalized = text.toLowerCase();
  const latin = normalized.match(/[a-z0-9_.-]{2,}/g) ?? [];
  const chinese = chineseNgrams(normalized);
  return unique([...latin, ...chinese]).slice(0, MAX_TOKEN_COUNT);
}

function overlapScore(queryTokens: Set<string>, memoryText: string) {
  if (queryTokens.size === 0) return 0;
  let matches = 0;
  const memoryTokens = tokens(memoryText);
  for (const token of memoryTokens) {
    if (queryTokens.has(token)) matches += 1;
  }
  return Math.min(35, (matches / Math.max(1, queryTokens.size)) * 35);
}

function kindWeight(kind: string) {
  switch (kind) {
    case "boundary":
      return 18;
    case "preference":
      return 15;
    case "mistake":
      return 14;
    case "watchlist":
      return 13;
    case "source_note":
      return 12;
    case "finding":
      return 9;
    case "hypothesis":
      return 5;
    default:
      return 4;
  }
}

function recencyScore(memory: WorkshopMemory, now: Date) {
  const createdAt = dateValue(memory.updatedAt ?? memory.createdAt);
  if (!createdAt) return 0;
  const age = Math.max(0, now.getTime() - createdAt);
  if (age >= RECENCY_WINDOW_MS) return 0;
  return Math.round((1 - age / RECENCY_WINDOW_MS) * 6);
}

function tagScore(queryText: string, tags: string[]) {
  if (tags.length === 0) return 0;
  const normalized = queryText.toLowerCase();
  return Math.min(
    12,
    tags.filter((tag) => normalized.includes(tag.toLowerCase())).length * 4,
  );
}

function isRiskBoundary(memory: WorkshopMemory) {
  const tags = normalizeTags(memory.tags).join(" ").toLowerCase();
  const text = `${memory.kind} ${tags} ${memory.content}`.toLowerCase();
  return (
    memory.kind === "boundary" ||
    memory.kind === "mistake" ||
    /risk|forbid|forbidden|boundary|stop-loss|drawdown|loss|must not/.test(
      text,
    ) ||
    /风险|边界|禁止|不得|不能|止损|清仓|减仓|亏损|回撤|失效/.test(text)
  );
}

function isRecentLesson(memory: WorkshopMemory) {
  const tags = normalizeTags(memory.tags).join(" ").toLowerCase();
  const text = `${memory.kind} ${tags} ${memory.content}`.toLowerCase();
  return (
    memory.kind === "mistake" ||
    memory.kind === "source_note" ||
    /lesson|failure|failed|error|stale|fallback|data.source/.test(text) ||
    /经验|教训|失败|错误|报错|失效|不稳定|数据源|乱码|接口/.test(text)
  );
}

function isCoreState(memory: WorkshopMemory) {
  return memory.kind === "boundary" || memory.kind === "preference";
}

function memoryStatus(memory: WorkshopMemory) {
  const status = (memory as WorkshopMemory & { status?: unknown }).status;
  return typeof status === "string" ? status : "confirmed";
}

function isRecallableMemoryStatus(status: string) {
  return ["active", "verified", "confirmed", "weakened"].includes(status);
}

function statusScore(status: string) {
  switch (status) {
    case "verified":
      return 14;
    case "active":
      return 8;
    case "confirmed":
      return 6;
    case "weakened":
      return -10;
    default:
      return 0;
  }
}

function buildTaskIntent(input: {
  workshop: Workshop;
  directives: WorkshopDirective[];
  events: WorkshopEvent[];
  taskIntent?: string | null;
}) {
  const explicit = input.taskIntent?.trim();
  if (explicit) return explicit;
  const directiveText = input.directives
    .slice(0, 6)
    .map((directive) => directive.content)
    .join("\n");
  const eventText = input.events
    .slice(-8)
    .map((event) => `${event.type}: ${event.title} ${event.body ?? ""}`)
    .join("\n");
  return [input.workshop.name, input.workshop.mission, directiveText, eventText]
    .filter(Boolean)
    .join("\n");
}

function scoreMemory(input: {
  memory: WorkshopMemory;
  taskText: string;
  queryTokens: Set<string>;
  now: Date;
}): WorkshopMemoryContextItem {
  const tags = normalizeTags(input.memory.tags);
  const confidence = Number.isFinite(input.memory.confidence)
    ? input.memory.confidence
    : 50;
  const reasons: string[] = [];
  const content = input.memory.content;
  const status = memoryStatus(input.memory);

  let score = kindWeight(input.memory.kind);
  if (score >= 12) reasons.push(`kind:${input.memory.kind}`);
  score += statusScore(status);
  reasons.push(`status:${status}`);

  const overlap = overlapScore(
    input.queryTokens,
    `${input.memory.kind} ${tags.join(" ")} ${content}`,
  );
  if (overlap > 0) {
    score += overlap;
    reasons.push("task_match");
  }

  const tagMatch = tagScore(input.taskText, tags);
  if (tagMatch > 0) {
    score += tagMatch;
    reasons.push("tag_match");
  }

  const confidenceScore = Math.max(0, Math.min(100, confidence)) / 10;
  score += confidenceScore;
  if (confidence >= 75) reasons.push("high_confidence");

  const recent = recencyScore(input.memory, input.now);
  score += recent;
  if (recent > 0) reasons.push("recent");

  if (isRiskBoundary(input.memory)) {
    score += 8;
    reasons.push("risk_control");
  }
  if (isRecentLesson(input.memory)) {
    score += 5;
    reasons.push("feedback_lesson");
  }

  return {
    id: input.memory.id,
    kind: input.memory.kind,
    status,
    content: truncate(content),
    confidence,
    tags,
    sourceEventIds: normalizeSourceEventIds(input.memory.sourceEventIds),
    score: Math.round(score),
    reasons: unique(reasons),
  };
}

function byScoreDesc(a: WorkshopMemoryContextItem, b: WorkshopMemoryContextItem) {
  return b.score - a.score || b.confidence - a.confidence;
}

function takeUnique(
  items: WorkshopMemoryContextItem[],
  limit: number,
): WorkshopMemoryContextItem[] {
  const seen = new Set<string>();
  const result: WorkshopMemoryContextItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

export function buildWorkshopMemoryContextPack(input: {
  workshop: Workshop;
  directives: WorkshopDirective[];
  events?: WorkshopEvent[];
  memories: WorkshopMemory[];
  taskIntent?: string | null;
  now?: Date;
  maxRelevant?: number;
}): WorkshopMemoryContextPack {
  const now = input.now ?? new Date();
  const events = input.events ?? [];
  const taskIntent = buildTaskIntent({
    workshop: input.workshop,
    directives: input.directives,
    events,
    taskIntent: input.taskIntent,
  });
  const queryTokens = new Set(tokens(taskIntent));
  const candidateMemories = input.memories.filter(
    (memory) => memoryStatus(memory) === "candidate",
  ).length;
  const verifiedMemories = input.memories.filter(
    (memory) => memoryStatus(memory) === "verified",
  ).length;
  const weakenedMemories = input.memories.filter(
    (memory) => memoryStatus(memory) === "weakened",
  ).length;
  const dismissedMemories = input.memories.filter(
    (memory) => memoryStatus(memory) === "dismissed",
  ).length;
  const recallableMemories = input.memories.filter((memory) =>
    isRecallableMemoryStatus(memoryStatus(memory)),
  );
  const activeMemories = recallableMemories.filter((memory) => {
    const expiresAt = dateValue(memory.expiresAt);
    return expiresAt === null || expiresAt > now.getTime();
  });
  const expiredMemories = recallableMemories.length - activeMemories.length;
  const scored = activeMemories
    .map((memory) =>
      scoreMemory({ memory, taskText: taskIntent, queryTokens, now }),
    )
    .sort(byScoreDesc);

  const coreState = takeUnique(
    scored.filter((item) =>
      activeMemories.some(
        (memory) => memory.id === item.id && isCoreState(memory),
      ),
    ),
    4,
  );
  const riskBoundaries = takeUnique(
    scored.filter((item) =>
      activeMemories.some(
        (memory) => memory.id === item.id && isRiskBoundary(memory),
      ),
    ),
    5,
  );
  const recentLessons = takeUnique(
    scored.filter((item) =>
      activeMemories.some(
        (memory) => memory.id === item.id && isRecentLesson(memory),
      ),
    ),
    5,
  );
  const taskRelevantMemories = takeUnique(scored, input.maxRelevant ?? 8);
  const selectedIds = new Set(
    [
      ...coreState,
      ...taskRelevantMemories,
      ...recentLessons,
      ...riskBoundaries,
    ].map((item) => item.id),
  );
  const evidenceRefs = unique(
    [...coreState, ...taskRelevantMemories, ...recentLessons, ...riskBoundaries]
      .flatMap((item) => item.sourceEventIds)
      .filter(Boolean),
  ).slice(0, 16);
  const openQuestions: string[] = [];
  if (activeMemories.length === 0) {
    openQuestions.push(
      "No active durable workshop memory is available; rely on current sources and log reusable findings.",
    );
  }
  if (riskBoundaries.length === 0) {
    openQuestions.push(
      "No explicit risk or boundary memory was recalled for this run.",
    );
  }

  return {
    controlModel: "engineering_cybernetics_v1",
    taskIntent: truncate(taskIntent, 700),
    coreState,
    taskRelevantMemories,
    recentLessons,
    riskBoundaries,
    evidenceRefs,
    openQuestions,
    omittedReason:
      scored.length > taskRelevantMemories.length
        ? `Selected ${taskRelevantMemories.length} of ${scored.length} active memories by control relevance.`
        : null,
    stats: {
      totalMemories: input.memories.length,
      activeMemories: activeMemories.length,
      candidateMemories,
      verifiedMemories,
      weakenedMemories,
      dismissedMemories,
      expiredMemories,
      selectedMemories: selectedIds.size,
    },
  };
}

function itemLine(item: WorkshopMemoryContextItem) {
  const tags = item.tags.length > 0 ? ` tags=${item.tags.join(",")}` : "";
  const refs =
    item.sourceEventIds.length > 0
      ? ` sourceEventIds=${item.sourceEventIds.slice(0, 5).join(",")}`
      : "";
  return `- [${item.kind}, status=${item.status}, score=${item.score}, confidence=${item.confidence}%${tags}] ${item.content}${refs}`;
}

function section(title: string, items: WorkshopMemoryContextItem[]) {
  return [
    `${title}:`,
    items.length > 0 ? items.map(itemLine).join("\n") : "- None recalled.",
  ].join("\n");
}

export function formatWorkshopMemoryContextPack(
  pack: WorkshopMemoryContextPack,
) {
  return [
    `Control model: ${pack.controlModel}`,
    `Task intent estimate: ${pack.taskIntent || "unspecified"}`,
    pack.informationReadiness ? formatInformationReadiness(pack.informationReadiness) : 'Information readiness unavailable in legacy memory fallback; verify required information from current authorized sources.',
    section("Core state", pack.coreState),
    section("Task relevant memories", pack.taskRelevantMemories),
    section("Recent lessons and feedback", pack.recentLessons),
    section("Risk boundaries", pack.riskBoundaries),
    "Evidence refs:",
    pack.evidenceRefs.length > 0 ? `- ${pack.evidenceRefs.join("\n- ")}` : "- None.",
    "Open questions:",
    pack.openQuestions.length > 0
      ? `- ${pack.openQuestions.join("\n- ")}`
      : "- None.",
    pack.omittedReason ? `Omitted: ${pack.omittedReason}` : null,
    `Stats: total=${pack.stats.totalMemories}, active=${pack.stats.activeMemories}, candidate=${pack.stats.candidateMemories}, verified=${pack.stats.verifiedMemories}, weakened=${pack.stats.weakenedMemories}, dismissed=${pack.stats.dismissedMemories}, expired=${pack.stats.expiredMemories}, selected=${pack.stats.selectedMemories}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
