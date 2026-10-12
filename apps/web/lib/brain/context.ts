import {
  getBrainMemoryCanonicalMetadata,
  type BrainCanonicalKind,
  type BrainDerivedMemoryRef,
  type BrainMemoryFacets,
} from "./canonical";
import { canReadMemory } from "./policy";
import { getBrainMemoryRevisionVersion } from "./memory-revision-version";
import type { InformationReadiness } from './information-needs';
import type {
  BrainAccessGrant,
  BrainMemory,
  BrainRequester,
  BrainSourceFilters,
} from "./types";

export type BrainContextPackItem = {
  id: string;
  /** Exact stored revision selected by the server; older packs may lack it. */
  revisionVersion?: string;
  ownerType: BrainMemory["ownerType"];
  ownerId: string;
  memoryType: BrainMemory["memoryType"];
  subject: string;
  content: string;
  evidenceRefs: string[];
  score: number;
  reasons: string[];
  freshness?: {
    updatedAt: string;
    observedAt?: string;
    basis?: "observation" | "legacy_update_time" | "unknown";
    ageHours: number | null;
    bucket:
      | "fresh_24h"
      | "recent_3d"
      | "recent_7d"
      | "recent_30d"
      | "historical"
      | "unknown";
  };
  warnings?: Array<"content_reports_conflict" | "historical_for_current_state" | "observation_time_unknown" | "memory_update_pending">;
  canonicalKind?: BrainCanonicalKind;
  canonicalGroupId?: string;
  facets?: BrainMemoryFacets;
  derivedRefs?: BrainDerivedMemoryRef[];
};

export type BrainContextPack = {
  informationReadiness?: InformationReadiness;
  interfaceVersion: "brain-context.v1";
  contextLogId?: string;
  selection: {
    selectedCount: number;
    deniedCount: number;
    omittedCount: number;
    duplicateCanonicalGroupCount: number;
    selectedCanonicalKinds: Partial<Record<BrainCanonicalKind, number>>;
  };
  items: BrainContextPackItem[];
  denied: Array<{ id: string; reason: string }>;
  omitted: Array<{ id: string; reason: string }>;
  warnings?: Array<{
    code: "potential_state_conflict" | "evidence_unavailable" | "observation_time_unknown" | "memory_update_pending";
    memoryIds: string[];
    message: string;
    requiresCurrentObservation: true;
  }>;
};

export type BrainRecallProfile = {
  id: string;
  matchTerms: string[];
  memoryTypeBoosts: Partial<Record<BrainMemory["memoryType"], number>>;
};

export type BrainContextExplanation = {
  interfaceVersion: "brain-context-explanation.v1";
  contextLogId?: string;
  selectedCount: number;
  deniedCount: number;
  omittedCount: number;
  duplicateCanonicalGroupCount: number;
  selectedCanonicalKinds: Partial<Record<BrainCanonicalKind, number>>;
  warnings: string[];
  evidenceRefCount: number;
};

export type BrainContextTraceSummary = {
  informationReadiness?: InformationReadiness;
  interfaceVersion: "brain-context-trace.v1";
  contextLogId?: string;
  selection: BrainContextPack["selection"];
  selected: Array<{
    id: string;
    revisionVersion?: string;
    ownerType: BrainContextPackItem["ownerType"];
    ownerId: string;
    memoryType: BrainContextPackItem["memoryType"];
    subject: string;
    contentPreview: string;
    score: number;
    reasons: string[];
    warnings: BrainContextPackItem["warnings"];
    evidenceRefCount: number;
    canonicalKind?: BrainContextPackItem["canonicalKind"];
    canonicalGroupId?: string;
  }>;
  omitted: BrainContextPack["omitted"];
  denied: BrainContextPack["denied"];
  warnings: BrainContextPack["warnings"];
};

const ACTIVE_STATUSES = new Set(["active", "verified", "weakened"]);
const MAX_TOKEN_COUNT = 240;
const VOLATILE_MEMORY_TYPES = new Set<BrainMemory["memoryType"]>([
  "fact",
  "plan",
  "task",
  "insight",
]);
const CURRENT_STATE_TERMS = [
  "current",
  "today",
  "latest",
  "now",
  "\u5f53\u524d",
  "\u4eca\u65e5",
  "\u6700\u65b0",
  "\u73b0\u5728",
  "\u672c\u6b21",
];
const CONFLICT_TERMS = [
  "conflict",
  "mismatch",
  "inconsistent",
  "not persisted",
  "\u51b2\u7a81",
  "\u5dee\u5f02",
  "\u4e0d\u4e00\u81f4",
  "\u672a\u6301\u4e45\u5316",
];
const CORE_RECALL_PROFILES: BrainRecallProfile[] = [
  {
    id: "planning",
    matchTerms: [
      "plan",
      "daily",
      "weekly",
      "todo",
      "\u8ba1\u5212",
      "\u4eca\u65e5",
      "\u6bcf\u65e5",
      "\u6267\u884c",
      "\u672a\u5b8c\u6210",
    ],
    memoryTypeBoosts: {
      plan: 35,
      task: 30,
    },
  },
  {
    id: "risk",
    matchTerms: [
      "risk",
      "boundary",
      "warning",
      "\u98ce\u9669",
      "\u8fb9\u754c",
      "\u9884\u8b66",
      "\u7981\u6b62",
      "\u4e0d\u5f97",
      "\u4e0d\u80fd",
    ],
    memoryTypeBoosts: {
      boundary: 45,
    },
  },
  {
    id: "review",
    matchTerms: [
      "review",
      "lesson",
      "failure",
      "failed",
      "postmortem",
      "\u590d\u76d8",
      "\u5931\u8d25",
      "\u6559\u8bad",
      "\u9519\u8bef",
    ],
    memoryTypeBoosts: {
      insight: 25,
      boundary: 15,
      plan: 10,
    },
  },
];

function normalizedList(values: string[] | undefined) {
  return new Set(
    (values ?? [])
      .map((value) => value.trim().toLowerCase().normalize("NFKC"))
      .filter(Boolean),
  );
}

function facetValues(
  facets: BrainMemoryFacets,
  key: "sourceKind" | "privacyClass" | "riskLevel" | "scenarioKeys",
) {
  const value = facets[key];
  if (Array.isArray(value)) {
    return value
      .map((item) => item.trim().toLowerCase().normalize("NFKC"))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim().toLowerCase().normalize("NFKC")];
  }
  return [];
}

function intersects(required: Set<string>, values: string[]) {
  if (required.size === 0) return true;
  return values.some((value) => required.has(value));
}

function sourceFilterOmitReason(
  facets: BrainMemoryFacets,
  filters: BrainSourceFilters | undefined,
) {
  if (!filters) return null;
  const sourceKinds = normalizedList(filters.sourceKinds);
  if (
    sourceKinds.size > 0 &&
    !intersects(sourceKinds, facetValues(facets, "sourceKind"))
  ) {
    return "source_filter:source_kind";
  }
  const privacyClasses = normalizedList(filters.privacyClasses);
  if (
    privacyClasses.size > 0 &&
    !intersects(privacyClasses, facetValues(facets, "privacyClass"))
  ) {
    return "source_filter:privacy_class";
  }
  const excludedPrivacyClasses = normalizedList(filters.excludePrivacyClasses);
  if (
    excludedPrivacyClasses.size > 0 &&
    intersects(excludedPrivacyClasses, facetValues(facets, "privacyClass"))
  ) {
    return "source_filter:privacy_class_excluded";
  }
  const riskLevels = normalizedList(filters.riskLevels);
  if (
    riskLevels.size > 0 &&
    !intersects(riskLevels, facetValues(facets, "riskLevel"))
  ) {
    return "source_filter:risk_level";
  }
  const scenarioKeys = normalizedList(filters.scenarioKeys);
  if (
    scenarioKeys.size > 0 &&
    !intersects(scenarioKeys, facetValues(facets, "scenarioKeys"))
  ) {
    return "source_filter:scenario_key";
  }
  return null;
}

function tokenize(text: string) {
  const normalized = text.toLowerCase().normalize("NFKC");
  const latin = normalized.match(/[a-z0-9_.-]{2,}/g) ?? [];
  const chinese = chineseNgrams(normalized);
  return uniqueStrings([...latin, ...chinese]).slice(0, MAX_TOKEN_COUNT);
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function textIncludesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function matchingRecallProfiles(
  taskIntent: string,
  profiles: BrainRecallProfile[],
) {
  const normalized = taskIntent.toLowerCase().normalize("NFKC");
  return profiles.filter((profile) =>
    textIncludesAny(
      normalized,
      profile.matchTerms.map((term) => term.toLowerCase().normalize("NFKC")),
    ),
  );
}

function freshnessForMemory(memory: BrainMemory, now: Date) {
  const observationTime = typeof memory.metadata?.observationTime === "string"
    ? memory.metadata.observationTime : undefined;
  const observationUnknown = memory.metadata?.observationTimeUnknown === true;
  const basis = observationUnknown ? "unknown" as const
    : observationTime ? "observation" as const : "legacy_update_time" as const;
  const observedAt = new Date(observationTime ?? memory.updatedAt);
  if (observationUnknown || Number.isNaN(observedAt.getTime())) {
    return {
      score: 0,
      freshness: {
        updatedAt: memory.updatedAt,
        basis: "unknown" as const,
        ageHours: null,
        bucket: "unknown" as const,
      },
    };
  }

  const ageHours = Math.max(
    0,
    (now.getTime() - observedAt.getTime()) / 3_600_000,
  );
  const bucket =
    ageHours <= 24
      ? ("fresh_24h" as const)
      : ageHours <= 72
        ? ("recent_3d" as const)
        : ageHours <= 168
          ? ("recent_7d" as const)
          : ageHours <= 720
            ? ("recent_30d" as const)
            : ("historical" as const);
  const score = !VOLATILE_MEMORY_TYPES.has(memory.memoryType)
    ? 0
    : bucket === "fresh_24h"
      ? 60
      : bucket === "recent_3d"
        ? 35
        : bucket === "recent_7d"
          ? 15
          : bucket === "recent_30d"
            ? 5
            : -20;

  return {
    score,
    freshness: {
      updatedAt: memory.updatedAt,
      observedAt: observedAt.toISOString(),
      basis,
      ageHours: Math.round(ageHours * 10) / 10,
      bucket,
    },
  };
}

function isCurrentStateIntent(taskIntent: string) {
  const normalized = taskIntent.toLowerCase().normalize("NFKC");
  return textIncludesAny(normalized, CURRENT_STATE_TERMS);
}

function contentReportsConflict(memory: BrainMemory) {
  const normalized = `${memory.subject} ${memory.content}`
    .toLowerCase()
    .normalize("NFKC");
  return textIncludesAny(normalized, CONFLICT_TERMS);
}

function profileScore(memory: BrainMemory, profiles: BrainRecallProfile[]) {
  let score = 0;
  const reasons: string[] = [];
  for (const profile of profiles) {
    const boost = profile.memoryTypeBoosts[memory.memoryType] ?? 0;
    if (boost === 0) continue;
    score += boost;
    reasons.push(`profile:${profile.id}`);
  }
  return { score, reasons };
}

function scoreMemory(
  memory: BrainMemory,
  taskIntent: string,
  recallProfiles: BrainRecallProfile[],
  now: Date,
) {
  const intentTokens = new Set(tokenize(taskIntent));
  const memoryTokens = new Set(
    tokenize(
      [
        memory.memoryType,
        memory.subject,
        memory.content,
        ...(memory.tags ?? []),
      ].join(" "),
    ),
  );
  const reasons: string[] = [];
  const freshness = freshnessForMemory(memory, now);
  let score = memory.confidence;
  reasons.push("confidence");
  if (memory.memoryType === "boundary") {
    score += 120;
    reasons.push("type:boundary");
  }
  if (memory.memoryType === "plan") {
    score += 60;
    reasons.push("type:plan");
  }
  if (memory.status === "verified") {
    score += 30;
    reasons.push("status:verified");
  }
  if (memory.status === "weakened") {
    score -= 40;
    reasons.push("status:weakened");
  }
  score += freshness.score;
  if (freshness.score !== 0) {
    reasons.push(`freshness:${freshness.freshness.bucket}`);
  }
  const profiles = matchingRecallProfiles(taskIntent, recallProfiles);
  const profile = profileScore(memory, profiles);
  score += profile.score;
  reasons.push(...profile.reasons);
  let matchedTokens = 0;
  for (const token of intentTokens) {
    if (memoryTokens.has(token)) {
      matchedTokens += 1;
      score += 15;
    }
  }
  if (matchedTokens > 0) {
    reasons.push(`token_match:${matchedTokens}`);
    const revision = memory.metadata?.revision;
    if (revision && typeof revision === "object" && !Array.isArray(revision)) {
      const createdAt = new Date(String((revision as Record<string, unknown>).createdAt ?? ""));
      const revisionAge = now.getTime() - createdAt.getTime();
      if (revisionAge >= 0 && revisionAge <= 7 * 24 * 3_600_000 && memory.status !== "candidate") {
        score += 45;
        reasons.push("relevant_recent_revision");
      }
    }
  }
  return {
    score,
    reasons: uniqueStrings(reasons),
    freshness: freshness.freshness,
  };
}

export function buildBrainContextPack(input: {
  memories: BrainMemory[];
  requester: BrainRequester;
  taskIntent: string;
  grants?: BrainAccessGrant[];
  accessMode?: "strict" | "owner_override";
  includeCandidates?: boolean;
  now?: Date;
  maxItems?: number;
  recallProfiles?: BrainRecallProfile[];
  sourceFilters?: BrainSourceFilters;
}): BrainContextPack {
  const {
    memories,
    requester,
    taskIntent,
    grants = [],
    accessMode = "strict",
    includeCandidates = false,
    now = new Date(),
    maxItems = 12,
    recallProfiles = [],
    sourceFilters,
  } = input;
  const activeRecallProfiles = [...CORE_RECALL_PROFILES, ...recallProfiles];

  const denied: BrainContextPack["denied"] = [];
  const omitted: BrainContextPack["omitted"] = [];
  const scored: BrainContextPackItem[] = [];

  for (const memory of memories) {
    const access = canReadMemory({
      memory,
      requester,
      grants,
      accessMode,
      now,
    });
    if (!access.allowed) {
      denied.push({ id: memory.id, reason: access.reason });
      continue;
    }

    if (memory.status === "candidate" && !includeCandidates) {
      omitted.push({ id: memory.id, reason: "candidate_requires_review" });
      continue;
    }
    if (memory.status === "superseded" || memory.status === "deleted") {
      omitted.push({ id: memory.id, reason: memory.status });
      continue;
    }
    if (!ACTIVE_STATUSES.has(memory.status) && memory.status !== "candidate") {
      omitted.push({ id: memory.id, reason: "inactive_status" });
      continue;
    }

    const canonical = getBrainMemoryCanonicalMetadata(memory);
    const sourceOmitReason = sourceFilterOmitReason(
      canonical.facets,
      sourceFilters,
    );
    if (sourceOmitReason) {
      omitted.push({ id: memory.id, reason: sourceOmitReason });
      continue;
    }

    const scoredMemory = scoreMemory(
      memory,
      taskIntent,
      activeRecallProfiles,
      now,
    );
    const warnings: BrainContextPackItem["warnings"] = [];
    if (memory.metadata?.pendingMemoryUpdate) warnings.push("memory_update_pending");
    if (memory.metadata?.revision && scoredMemory.freshness.bucket === "unknown") {
      warnings.push("observation_time_unknown");
    }
    if (contentReportsConflict(memory)) {
      warnings.push("content_reports_conflict");
    }
    if (
      isCurrentStateIntent(taskIntent) &&
      VOLATILE_MEMORY_TYPES.has(memory.memoryType) &&
      scoredMemory.freshness.ageHours !== null &&
      scoredMemory.freshness.ageHours > 24
    ) {
      warnings.push("historical_for_current_state");
    }
    scored.push({
      id: memory.id,
      revisionVersion: (() => {
        // Admission annotations are ephemeral and must not change the stored revision.
        const metadata = { ...memory.metadata };
        delete metadata.pendingMemoryUpdate;
        return getBrainMemoryRevisionVersion({ ...memory, metadata });
      })(),
      ownerType: memory.ownerType,
      ownerId: memory.ownerId,
      memoryType: memory.memoryType,
      subject: memory.subject,
      content: memory.content,
      evidenceRefs: memory.evidenceRefs,
      score: scoredMemory.score,
      reasons: scoredMemory.reasons,
      freshness: scoredMemory.freshness,
      warnings,
      canonicalKind: canonical.canonicalKind,
      canonicalGroupId: canonical.canonicalGroupId,
      facets: canonical.facets,
      derivedRefs: canonical.derivedRefs,
    });
  }

  scored.sort((a, b) => Number(b.memoryType === "boundary") - Number(a.memoryType === "boundary") ||
    b.score - a.score || a.id.localeCompare(b.id));

  const selectedCanonicalGroups = new Set<string>();
  const selectedIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const items: BrainContextPackItem[] = [];
  function selectItem(item: BrainContextPackItem): boolean {
    if (items.length >= maxItems || selectedIds.has(item.id)) return false;
    if (
      item.canonicalGroupId &&
      selectedCanonicalGroups.has(item.canonicalGroupId)
    ) {
      if (!duplicateIds.has(item.id)) {
        omitted.push({ id: item.id, reason: "duplicate_canonical_group" });
        duplicateIds.add(item.id);
      }
      return false;
    }
    if (item.canonicalGroupId) {
      selectedCanonicalGroups.add(item.canonicalGroupId);
    }
    items.push(item);
    selectedIds.add(item.id);
    return true;
  }
  // Boundaries keep the first claim on the budget. Reserve at most two of the
  // remaining slots for relevant, recent, already-authorized corrections.
  for (const item of scored.filter(item => item.memoryType === "boundary")) selectItem(item);
  let reservedRevisions = 0;
  for (const item of scored) {
    if (reservedRevisions >= 2 || items.length >= maxItems) break;
    if (item.memoryType !== "boundary" && item.reasons.includes("relevant_recent_revision") && selectItem(item)) {
      item.reasons.push("reserved_relevant_revision");
      reservedRevisions += 1;
    }
  }
  for (const item of scored) {
    if (items.length >= maxItems) break;
    selectItem(item);
  }
  const currentStateWarnings: NonNullable<BrainContextPack["warnings"]> = [];
  const pendingUpdateIds = items.filter(item => item.warnings?.includes("memory_update_pending")).map(item => item.id);
  if (pendingUpdateIds.length) currentStateWarnings.push({
    code: "memory_update_pending", memoryIds: pendingUpdateIds,
    message: "A current accepted memory has an unreviewed update proposal. The proposal is excluded from normal recall; verify the relevant source before relying on the accepted text as current fact.",
    requiresCurrentObservation: true,
  });
  if (isCurrentStateIntent(taskIntent)) {
    const volatileItems = items.filter((item) =>
      VOLATILE_MEMORY_TYPES.has(item.memoryType),
    );
    const distinctDates = new Set(
      volatileItems
        .map((item) => (item.freshness?.observedAt ?? item.freshness?.updatedAt)?.slice(0, 10))
        .filter((date): date is string => Boolean(date)),
    );
    const unknownTimeIds = volatileItems.filter(item => item.warnings?.includes("observation_time_unknown")).map(item => item.id);
    if (unknownTimeIds.length > 0) {
      currentStateWarnings.push({code: "observation_time_unknown", memoryIds: unknownTimeIds,
        message: "A revised memory has no trusted observation time. Obtain a current authorized observation before acting.",
        requiresCurrentObservation: true});
    }
    const hasReportedConflict = volatileItems.some((item) =>
      item.warnings?.includes("content_reports_conflict"),
    );
    const hasTimeVersions =
      distinctDates.size > 1 &&
      new Set(volatileItems.map((item) => item.subject.toLowerCase())).size <
        volatileItems.length;
    if (hasReportedConflict || hasTimeVersions) {
      const reportedConflictIds = volatileItems
        .filter((item) => item.warnings?.includes("content_reports_conflict"))
        .map((item) => item.id);
      currentStateWarnings.push({
        code: "potential_state_conflict",
        memoryIds:
          reportedConflictIds.length > 0
            ? reportedConflictIds
            : volatileItems.map((item) => item.id),
        message:
          "Selected memories contain a reported mismatch or multiple time-versioned states. Treat them as historical evidence and verify the current state with an authorized observation tool before acting.",
        requiresCurrentObservation: true,
      });
    }
  }
  const selectedCanonicalKinds: Partial<Record<BrainCanonicalKind, number>> = {};
  for (const item of items) {
    if (!item.canonicalKind) continue;
    selectedCanonicalKinds[item.canonicalKind] =
      (selectedCanonicalKinds[item.canonicalKind] ?? 0) + 1;
  }

  return {
    interfaceVersion: "brain-context.v1",
    selection: {
      selectedCount: items.length,
      deniedCount: denied.length,
      omittedCount: omitted.length,
      duplicateCanonicalGroupCount: omitted.filter(
        (item) => item.reason === "duplicate_canonical_group",
      ).length,
      selectedCanonicalKinds,
    },
    items,
    denied,
    omitted,
    warnings: currentStateWarnings,
  };
}

export function explainBrainContextPack(
  pack: BrainContextPack,
): BrainContextExplanation {
  return {
    interfaceVersion: "brain-context-explanation.v1",
    contextLogId: pack.contextLogId,
    selectedCount: pack.selection.selectedCount,
    deniedCount: pack.selection.deniedCount,
    omittedCount: pack.selection.omittedCount,
    duplicateCanonicalGroupCount: pack.selection.duplicateCanonicalGroupCount,
    selectedCanonicalKinds: pack.selection.selectedCanonicalKinds,
    warnings: (pack.warnings ?? []).map((warning) => warning.message),
    evidenceRefCount: new Set(
      pack.items.flatMap((item) => item.evidenceRefs),
    ).size,
  };
}

export function summarizeBrainContextPackForTrace(
  pack: BrainContextPack,
): BrainContextTraceSummary {
  return {
    interfaceVersion: "brain-context-trace.v1",
    informationReadiness: pack.informationReadiness,
    contextLogId: pack.contextLogId,
    selection: pack.selection,
    selected: pack.items.map((item) => ({
      id: item.id,
      revisionVersion: item.revisionVersion,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      memoryType: item.memoryType,
      subject: item.subject,
      contentPreview:
        item.content.length > 220
          ? `${item.content.slice(0, 220)}...`
          : item.content,
      score: item.score,
      reasons: item.reasons.slice(0, 8),
      warnings: item.warnings,
      evidenceRefCount: item.evidenceRefs.length,
      canonicalKind: item.canonicalKind,
      canonicalGroupId: item.canonicalGroupId,
    })),
    omitted: pack.omitted.slice(0, 30),
    denied: pack.denied.slice(0, 30),
    warnings: pack.warnings,
  };
}
