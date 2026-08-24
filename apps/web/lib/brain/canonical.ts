import { createHash } from "node:crypto";
import type { BrainMemory, BrainMemoryType, BrainScope } from "./types";

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
  const facets = {
    ...(typeof existing.facets === "object" &&
    existing.facets !== null &&
    !Array.isArray(existing.facets)
      ? (existing.facets as BrainMemoryFacets)
      : {}),
    ...(input.facets ?? {}),
    memoryType: input.memoryType,
    scopeType: input.scope.type,
  };
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
