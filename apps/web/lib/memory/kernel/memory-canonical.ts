import { createHash } from "node:crypto";
import type { BrainMemory, BrainMemoryType, BrainScope } from "./memory-types";

export type BrainCanonicalKind =
  | "boundary"
  | "preference"
  | "state"
  | "plan"
  | "commitment"
  | "lesson"
  | "profile"
  | "fact";

export type BrainMemoryFacetValue = string | string[] | boolean | number | null;

export type BrainMemoryFacets = Record<string, BrainMemoryFacetValue>;

export type BrainScenarioApplicability = {
  status: "global" | "scoped" | "unknown";
  scenarioKeys: string[];
  basis: "typed_scenario_keys" | "owner_confirmed" | "legacy_unknown" | "unconfirmed_global";
};

const SCENARIO_TYPES = new Set(["person", "group", "project", "topic", "transaction", "family", "work"]);

/** Applicability is a relevance constraint, never an access grant or a Work ID. */
export function normalizeBrainScenarioKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.flatMap((item) => {
    if (typeof item !== "string" || item.length > 256) return [];
    const normalized = item.trim().normalize("NFKC").toLowerCase();
    const separator = normalized.indexOf(":");
    const type = normalized.slice(0, separator);
    const key = normalized.slice(separator + 1).trim();
    return separator > 0 && SCENARIO_TYPES.has(type) && key ? [`${type}:${key}`] : [];
  })).slice(0, 64);
}

export function brainScenarioKeysFromHints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeBrainScenarioKeys(value.flatMap((hint) => {
    if (!hint || typeof hint !== "object" || Array.isArray(hint)) return [];
    const record = hint as Record<string, unknown>;
    return typeof record.type === "string" && typeof record.key === "string"
      ? [`${record.type}:${record.key}`] : [];
  }));
}

/** Model-derived interaction hints can establish a local scenario, never global applicability. */
export function buildInteractionScenarioApplicabilityFacets(scenarioHints: unknown): BrainMemoryFacets {
  const scenarioKeys = brainScenarioKeysFromHints(scenarioHints);
  return { scenarioKeys, scenarioApplicability: scenarioKeys.length ? "scoped" : "unknown" };
}

export function getBrainMemoryScenarioApplicability(
  memory: Pick<BrainMemory, "metadata" | "evidenceRefs">,
): BrainScenarioApplicability {
  const metadata = memory.metadata ?? {};
  const facets = metadata.facets && typeof metadata.facets === "object" && !Array.isArray(metadata.facets)
    ? metadata.facets as BrainMemoryFacets : {};
  const storedKeys = normalizeBrainScenarioKeys(facets.scenarioKeys);
  const scenarioKeys = storedKeys.length ? storedKeys : brainScenarioKeysFromHints(metadata.scenarioHints);
  // An explicit project/scenario always wins over a conflicting global claim.
  if (scenarioKeys.length) return { status: "scoped", scenarioKeys, basis: "typed_scenario_keys" };
  if (facets.scenarioApplicability === "global") {
    const refs = Array.isArray(facets.scenarioApplicabilityEvidenceRefs) ? facets.scenarioApplicabilityEvidenceRefs : [];
    if (facets.scenarioApplicabilityAuthority === "owner_confirmed" &&
      refs.some(ref => typeof ref === "string" && memory.evidenceRefs.includes(ref))) {
      return { status: "global", scenarioKeys: [], basis: "owner_confirmed" };
    }
    return { status: "unknown", scenarioKeys: [], basis: "unconfirmed_global" };
  }
  return { status: "unknown", scenarioKeys: [], basis: "legacy_unknown" };
}

/** Reusable by runtime request binding; never guesses a project from task text. */
export function matchBrainMemoryScenarioApplicability(
  memory: Pick<BrainMemory, "metadata" | "evidenceRefs">,
  input: { scenarioKeys?: string[] },
) {
  const applicability = getBrainMemoryScenarioApplicability(memory);
  const requested = normalizeBrainScenarioKeys(input.scenarioKeys);
  if (applicability.status === "global") return { applicability, matched: true, reason: "global" as const };
  if (applicability.status === "unknown") return { applicability, matched: false, reason: "unknown" as const };
  if (!requested.length) return { applicability, matched: false, reason: "scenario_context_required" as const };
  // Shared people/topics are navigation hints, not a way to cross project boundaries.
  const projectKeys = applicability.scenarioKeys.filter(key => key.startsWith("project:"));
  const anchors = projectKeys.length ? projectKeys : applicability.scenarioKeys;
  const matched = anchors.some(key => requested.includes(key));
  return { applicability, matched, reason: matched ? "scenario_match" as const : "scenario_mismatch" as const };
}

export type BrainDerivedMemoryRef = {
  source:
    | "workshop_memory"
    | "interaction_memory"
    | "graph"
    | "snapshot"
    | "legacy"
    | string;
  id: string;
  relation?: "derived_from" | "mirrors" | "indexes" | "summarizes" | string;
};

export type BrainMemoryCanonicalMetadata = {
  canonicalKind: BrainCanonicalKind;
  canonicalGroupId: string;
  facets: BrainMemoryFacets;
  derivedRefs: BrainDerivedMemoryRef[];
};

export type BrainMemoryMetadata = Partial<BrainMemoryCanonicalMetadata> &
  Record<string, unknown>;

export type BrainCanonicalInput = {
  memoryType: BrainMemoryType;
  subject: string;
  content: string;
  scope: BrainScope;
  ownerType: BrainMemory["ownerType"];
  ownerId: string;
  evidenceRefs: string[];
  tags?: string[];
  metadata?: BrainMemoryMetadata;
  canonicalKind?: BrainCanonicalKind;
  canonicalGroupId?: string;
  facets?: BrainMemoryFacets;
  derivedRefs?: BrainDerivedMemoryRef[];
};

const CANONICAL_KIND_BY_MEMORY_TYPE: Record<
  BrainMemoryType,
  BrainCanonicalKind
> = {
  boundary: "boundary",
  preference: "preference",
  plan: "plan",
  task: "commitment",
  relationship: "profile",
  insight: "lesson",
  system: "boundary",
  fact: "fact",
};

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function scopeKey(scope: BrainScope) {
  switch (scope.type) {
    case "global":
      return "global";
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "workshop":
      return `workshop:${scope.workshopId}`;
    case "work":
      return `work:${scope.workId}`;
  }
}

function normalizedText(value: string) {
  return value.trim().toLowerCase().normalize("NFKC");
}

export function inferBrainCanonicalKind(input: {
  memoryType: BrainMemoryType;
  subject: string;
  content: string;
  tags?: string[];
}): BrainCanonicalKind {
  const text = normalizedText(
    [input.memoryType, input.subject, input.content, ...(input.tags ?? [])].join(
      " ",
    ),
  );
  if (
    input.memoryType === "fact" &&
    /current|state|status|snapshot|\u6301\u4ed3|\u8d26\u6237|\u5f53\u524d|\u72b6\u6001|\u5feb\u7167|\u81ea\u9009\u80a1\u6c60/.test(
      text,
    )
  ) {
    return "state";
  }
  if (
    input.memoryType === "insight" &&
    /lesson|failure|failed|mistake|postmortem|\u590d\u76d8|\u5931\u8d25|\u6559\u8bad|\u9519\u8bef|\u5931\u6548/.test(
      text,
    )
  ) {
    return "lesson";
  }
  return CANONICAL_KIND_BY_MEMORY_TYPE[input.memoryType] ?? "fact";
}

export function buildCanonicalGroupId(input: {
  evidenceRefs: string[];
  scope: BrainScope;
  canonicalKind: BrainCanonicalKind;
  subject: string;
  ownerType: BrainMemory["ownerType"];
  ownerId: string;
}) {
  const evidenceRefs = uniqueStrings(input.evidenceRefs).sort();
  if (evidenceRefs.length > 0) {
    return `evidence:${input.canonicalKind}:${stableHash(
      evidenceRefs.join("|"),
    )}`;
  }
  return `semantic:${stableHash(
    [
      scopeKey(input.scope),
      input.ownerType,
      input.ownerId,
      input.canonicalKind,
      normalizedText(input.subject),
    ].join("|"),
  )}`;
}

export function buildBrainMemoryMetadata(
  input: BrainCanonicalInput,
): BrainMemoryMetadata {
  const existing = input.metadata ?? {};
  const canonicalKind =
    input.canonicalKind ??
    existing.canonicalKind ??
    inferBrainCanonicalKind(input);
  const canonicalGroupId =
    input.canonicalGroupId ??
    existing.canonicalGroupId ??
    buildCanonicalGroupId({
      evidenceRefs: input.evidenceRefs,
      scope: input.scope,
      canonicalKind,
      subject: input.subject,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
    });
  const facets: BrainMemoryFacets = {
    ...(typeof existing.facets === "object" &&
    existing.facets !== null &&
    !Array.isArray(existing.facets)
      ? (existing.facets as BrainMemoryFacets)
      : {}),
    ...(input.facets ?? {}),
    memoryType: input.memoryType,
    scopeType: input.scope.type,
  };
  const applicability = getBrainMemoryScenarioApplicability({
    metadata: { ...existing, facets }, evidenceRefs: input.evidenceRefs,
  });
  // Read-time normalization does not migrate historical rows or manufacture grants.
  facets.scenarioKeys = applicability.scenarioKeys;
  facets.scenarioApplicability = applicability.status;
  const derivedRefs = [
    ...((Array.isArray(existing.derivedRefs)
      ? existing.derivedRefs
      : []) as BrainDerivedMemoryRef[]),
    ...(input.derivedRefs ?? []),
  ];

  return {
    ...existing,
    canonicalKind,
    canonicalGroupId,
    facets,
    derivedRefs,
  };
}

export function getBrainMemoryCanonicalMetadata(
  memory: Pick<
    BrainMemory,
    | "memoryType"
    | "subject"
    | "content"
    | "scope"
    | "ownerType"
    | "ownerId"
    | "evidenceRefs"
    | "tags"
    | "metadata"
  >,
): BrainMemoryCanonicalMetadata {
  const metadata = buildBrainMemoryMetadata({
    memoryType: memory.memoryType,
    subject: memory.subject,
    content: memory.content,
    scope: memory.scope,
    ownerType: memory.ownerType,
    ownerId: memory.ownerId,
    evidenceRefs: memory.evidenceRefs,
    tags: memory.tags,
    metadata: memory.metadata,
  });
  return {
    canonicalKind: metadata.canonicalKind as BrainCanonicalKind,
    canonicalGroupId: String(metadata.canonicalGroupId),
    facets: (metadata.facets ?? {}) as BrainMemoryFacets,
    derivedRefs: Array.isArray(metadata.derivedRefs)
      ? (metadata.derivedRefs as BrainDerivedMemoryRef[])
      : [],
  };
}
