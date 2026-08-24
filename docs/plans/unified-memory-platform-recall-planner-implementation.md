# Unified Memory Platform Recall Planner Implementation

This document records the second implementation phase of the unified memory platform.

## Goal

The platform should not require each agent, workshop, or tool to manually assemble memory filters. A requester submits a `BrainMemoryRequest` that describes:

- who is requesting memory;
- what state the requester is currently in;
- what action it is about to perform;
- what task intent needs memory support.

The memory platform then uses LLM understanding to generate a structured `BrainRecallPlan`, and only then applies deterministic Brain controls.

## Implemented Interface

New module:

- `apps/web/lib/brain/recall-planner.ts`

New request contract:

```ts
type BrainMemoryRequest = {
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
    kind?: "answer" | "plan" | "execute" | "review" | "write_memory" | "external_message" | "trade" | "config_change";
    description?: string;
  };
  maxItems?: number;
  memoryLimit?: number;
};
```

New plan contract:

```ts
type BrainRecallPlan = {
  interfaceVersion: "brain-recall-plan.v1";
  mode: "llm" | "fallback_rules";
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
  routes: Array<{
    route: "brain_memory" | "knowledge_store" | "memory_graph" | "evidence_read";
    purpose: "canonical" | "evidence" | "derived_index" | "fallback";
    enabled: boolean;
    reason: string;
  }>;
  rationale: string[];
  warnings: string[];
};
```

## LLM Boundary

The LLM is used for understanding and planning only. It may generate:

- memory statuses to consider;
- memory types;
- canonical kinds;
- scopes;
- search terms;
- confidence and freshness filters;
- candidate inclusion policy;
- recall routes for Brain Memory, Knowledge Store, Memory Graph, and evidence reads;
- recall size.

The LLM does not make the final permission decision. The Brain platform still enforces:

- read permissions;
- denied-over-allowed behavior;
- status filtering;
- candidate review rules;
- canonical deduplication;
- context logging.

## Model Configuration

The planner resolves OpenAI-compatible configuration in this order:

1. `BRAIN_RECALL_PLANNER_LLM_API_KEY`, `BRAIN_RECALL_PLANNER_LLM_BASE_URL`, `BRAIN_RECALL_PLANNER_LLM_MODEL`
2. `MEMORY_RECALL_LLM_API_KEY`, `MEMORY_RECALL_LLM_BASE_URL`, `MEMORY_RECALL_LLM_MODEL`
3. `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`
4. the user's saved OpenAI-compatible provider setting

If no provider is configured, or if the LLM call fails, the planner returns a conservative `fallback_rules` plan with a warning.

## Runtime Integration

New high-level service:

- `buildBrainContextFromMemoryRequest`

Flow:

```text
BrainMemoryRequest
  -> buildBrainRecallPlan
  -> BrainRecallPlan
  -> buildBrainContextPackFromStore
  -> permission filter
  -> canonical dedup
  -> ContextPack + recallPlan
```

Integrated callers:

- workshop prompt construction now uses `buildBrainContextFromMemoryRequest`;
- `workshopSearchMemory` now uses `buildBrainContextFromMemoryRequest`.

## Deterministic Store Changes

`buildBrainContextPackFromStore` now accepts `canonicalKinds`. Candidate memories can be filtered by canonical memory category after initial store retrieval, and context logs record:

- generated filters;
- candidate count;
- filtered candidate count;
- planner mode and warnings.

Brain memory storage now has first-class canonical fields:

- `canonical_kind`;
- `canonical_group_id`;
- indexes for canonical group admission and canonical kind/status recall.

New writes synchronize these fields from canonical metadata. Existing rows are backfilled from `metadata.canonicalKind` and `metadata.canonicalGroupId` by the added PG/SQLite migrations.

`ContextPack` now also includes a `selection` summary:

```ts
selection: {
  selectedCount: number;
  deniedCount: number;
  omittedCount: number;
  duplicateCanonicalGroupCount: number;
  selectedCanonicalKinds: Partial<Record<BrainCanonicalKind, number>>;
}
```

This gives tools and pages a stable explanation surface without inspecting every selected memory item.

`buildBrainContextFromMemoryRequest` now also returns:

- `explanation`: a reusable `brain-context-explanation.v1` summary for Context Inspector surfaces. It includes selected, denied, omitted, duplicate canonical group count, selected canonical kind distribution, warning messages, and evidence-ref count.
- `routeResults`: lightweight execution results for non-canonical routes. Knowledge and Graph routes execute as evidence/derived-index lookups. Evidence-read routes are planned until a concrete evidence id is selected. Route results do not enter the canonical ContextPack.

## Quality Telemetry

Recall quality logs now expose planner-level telemetry:

- `recallPlannerMode`: `llm`, `fallback_rules`, or `unknown`;
- `recallPlannerWarningCount`;
- `routeUsage` aggregated from enabled RecallPlan routes.
- `duplicateCanonicalGroupCount`.

The aggregate recall-quality report now includes:

- `plannerModeCounts`;
- total duplicate canonical group omissions;
- total recall planner warnings;
- duplicate canonical group counts by requester.

This closes the first observability loop for LLM-generated recall parameters: the platform can now see whether recall is mostly driven by LLM planning, whether it is falling back to rules, and whether canonical deduplication is actively suppressing duplicate context.

## UI Explainability

Workshop run configuration events now write a compact `metadata.memoryRecall` object:

- `backend`: `brain` or `legacy`;
- `contextLogId`;
- `recallPlan`;
- `selection`.

The workshop work-log UI renders this object on `agent_configured` events as a Memory recall card. The card shows:

- backend and planner mode;
- selected, denied, omitted, and canonical-deduplicated counts;
- selected canonical kind distribution;
- statuses, memory types, canonical kinds, and search terms used by the generated plan;
- enabled RecallPlan routes and route purposes;
- planner warnings.

This makes recall behavior visible in the normal operating surface instead of hiding it in logs or database metadata.

Workshop loop detail data now also exposes linked `memoryRecall` summaries from loop events, so loop detail surfaces can render the same recall explanation without reparsing raw event metadata.

## Canonical Admission

Brain memory writes now run a canonical admission check before inserting a new long-term memory row.

Admission behavior:

- Build the incoming memory's canonical metadata first.
- Query existing candidate/active/verified/weakened memories in the same owner and scope.
- If another memory has the same `canonicalGroupId`, do not create a second row by default.
- If the existing memory has equal or stronger lifecycle status, return the existing memory with a `metadata.canonicalAdmission.action = "reused_existing"` marker.
- If the incoming memory has a stronger lifecycle status, merge into the existing memory id and write one updated row with `metadata.canonicalAdmission.action = "merged_existing"`.

This prevents future duplicate long-term memories while still allowing a reviewed or better-evidenced write to promote an existing candidate.

Workshop memory tools now expose canonical metadata on Brain-backed memory objects:

- canonical kind;
- canonical group id;
- facets;
- derived refs;
- admission action when present.

This gives memory stewardship and review surfaces the data needed to explain duplicate suppression, reuse, and merge behavior.

## Legacy Tool Downgrade

Workshop and Loop execution now default to the Brain memory platform path:

- `workshopSearchMemory` remains the default durable memory recall tool.
- `workshopGetMemoryEvidence` remains the evidence expansion tool.
- `searchUnifiedMemory`, `searchMemoryPath`, `getRawMessages`, and `searchRawMessages` are removed from the default Workshop/Loop allowed tool lists.
- native Loop prompt construction calls `buildBrainContextFromMemoryRequest` before assembling workshop memory context;
- if Brain selects memories, Loop consumes the Brain `ContextPack` projected into the existing workshop memory context shape;
- if Brain returns no selected items or recall fails, Loop explicitly marks `memoryRecall.backend = legacy` with a fallback reason before using legacy workshop memory context.

The generic chat `searchUnifiedMemory` tool is not removed because it still supports broad discovery and uploaded knowledge search. It is now Brain-first:

- first call `buildBrainContextFromMemoryRequest`;
- return Brain `ContextPack` and `RecallPlan` as the authoritative long-term memory projection;
- run legacy multi-source discovery only for non-memory sources or fallback;
- label legacy results as discovery/fallback rather than canonical long-term memory.

The Claude agent prompt now describes `searchUnifiedMemory` as Brain-first recall. Raw message tools are documented as evidence lookup, not canonical long-term memory recall.

The legacy unified search output now carries explicit result semantics:

- output-level `resultKind = legacy_discovery`;
- source-level semantics for memory, insights, knowledge, interactions, and graph;
- result metadata labels such as `canonical_context_candidate`, `evidence_source`, `derived_index`, `legacy_discovery`, and `fallback_evidence`.

## Recall Feedback Taxonomy

Recall quality feedback now distinguishes broad failure classes instead of only generic outcomes.

Supported outcomes:

- `used`;
- `irrelevant`;
- `missing`;
- `too_broad`;
- `too_narrow`;
- `missed_boundary`;
- `wrong_scope`;
- `stale_state`;
- `stale`;
- `incorrect`;
- `conflicting`.

Quality reports aggregate the new outcomes and expose whether the platform has evidence to assess:

- missing/too-narrow recall;
- ranking/noise problems;
- stale state recall.

Harness evidence diagnosis maps the new outcomes into memory failure classes so recall problems can feed later closed-loop improvement without directly changing memory facts or permissions.

## Tests

Added:

- `apps/web/tests/unit/brain-recall-planner.test.ts`
- `apps/web/tests/unit/brain-evidence-reader.test.ts`
- `apps/web/tests/unit/runtime-status.test.ts`

Covered behavior:

- high-risk actions generate conservative boundary recall in fallback mode;
- candidate memories are included only for review/write-memory style tasks.
- runtime status snapshots always include Brain canonical storage health for
  the requesting user, even when connector counts are served from cache.
- evidence reading resolves connector-origin raw message refs into auditable
  `raw_message` evidence summaries.

Existing context-pack tests continue to cover canonical group deduplication.

## Next Work

- Add raw evidence reader adapters for fixture/test evidence refs if they are promoted into production Brain memories.
- After running the production migration, run `USER_ID=<uuid> pnpm db:brain:check`
  from the repo root, or inspect `/api/runtime/status`, to verify canonical
  storage readiness, coverage, warnings, and sample query latency.

## Operational And Conditional Follow-Up

The core convergence path is now implemented in the repo. The remaining items are operational or conditional:

1. Evidence reader coverage: `evidence_read` now converts selected ContextPack evidence refs into executable route results with selected memory ids, owner metadata, and resolved evidence summaries for workshop/work events, chat interaction events, and raw message refs such as `legacy-raw-message:<id>`. Harness evidence remains a separate structured quality-control evidence system. Fixture/test refs need adapters only if they are promoted into production Brain memories.
2. Storage operations: canonical fields, migration SQL, migration journal entries, runtime status telemetry, and the `pnpm db:brain:check` verification command exist. Production rollout still needs the migration to be executed in the target environment and verified for the target user/database.

Recently closed:

- `/memory` is now a first-class unified memory search page. It calls `/api/memory/search`, lets the user choose recall sources, and renders semantic labels for canonical Brain candidates, legacy discovery, evidence sources, and derived indexes.
- Workshop memory cards render canonical kind/group, admission action/reason, reused/merged ids, and evidence refs.
- The memory tab loads aggregate recall-quality telemetry from `/api/workshops/:id/memory-recall-quality` and renders `routeUsage`, planner modes, feedback counts, empty recall rate, and coverage.
- `workshopInspectMemoryRecallQuality` and the product API share the same aggregation service.
- `ContextPack` items now retain `ownerType` and `ownerId`, so evidence route results can point domain readers at the owning surface without coupling Brain to every raw event store.
- Brain evidence reading is centralized in `lib/brain/evidence-reader.ts`, currently resolving `workshop_event` and `interaction_event` evidence refs directly from local storage.
- Brain evidence reading also resolves raw message evidence refs from `raw_messages` for connector-origin observations.
- Runtime status now exposes `brain.canonicalStorage` with migration readiness, canonical coverage, warnings, and sample canonicalKind query latency.
- `pnpm db:brain:check` provides a release-check command for the same Brain canonical storage readiness signal.
