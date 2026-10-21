import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workshop, WorkshopMemory } from "@/lib/db/schema";
import type { buildBrainContextFromMemoryRequest } from "@/lib/memory/retrieval/recall";
import { buildInformationReadiness } from "@/lib/memory/retrieval/information-needs";

const mocks = vi.hoisted(() => ({
  brain: vi.fn(), work: vi.fn(), memories: vi.fn(), directives: vi.fn(), events: vi.fn(),
}));
vi.mock("@/lib/workshops/service", async original => ({
  ...await original<typeof import("@/lib/workshops/service")>(),
  getWorkshop: mocks.work, listWorkshopMemories: mocks.memories,
  listActiveDirectives: mocks.directives, listWorkshopEvents: mocks.events,
}));
vi.mock("@/lib/memory/retrieval/recall", async original => ({
  ...await original<typeof import("@/lib/memory/retrieval/recall")>(), buildBrainContextFromMemoryRequest: mocks.brain,
}));

import { createWorkshopToolDefinitions } from "@/lib/workshops/mcp-tools";

type BrainResult = Awaited<ReturnType<typeof buildBrainContextFromMemoryRequest>>;
const workId = "11111111-1111-4111-a111-111111111111";
const userId = "22222222-2222-4222-a222-222222222222";
const work: Workshop = {
  id: workId, userId, name: "Research", mission: "Inspect authorized evidence", status: "active", autonomyLevel: "draft",
  modelConfig: { allowedTools: ["workshopSearchMemory"] }, boundaryPolicy: {},
  createdAt: new Date("2026-10-20T00:00:00Z"), updatedAt: new Date("2026-10-20T00:00:00Z"),
};
const legacy = {
  id: "legacy-memory", workshopId: workId, kind: "fact", content: "legacy-only secret marker", status: "verified",
  confidence: 90, tags: [], sourceEventIds: [], expiresAt: null, createdAt: work.createdAt, updatedAt: work.updatedAt,
} as WorkshopMemory;

function brain(overrides: Partial<BrainResult> = {}): BrainResult {
  const pack = {
    interfaceVersion: "brain-context.v1" as const, contextLogId: "context-log", items: [], denied: [], omitted: [], warnings: [],
    selection: { selectedCount: 0, deniedCount: 0, omittedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} },
  };
  return {
    ...pack,
    explanation: { interfaceVersion: "brain-context-explanation.v1", selectedCount: 0, deniedCount: 0, omittedCount: 0,
      duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {}, warnings: [], evidenceRefCount: 0 },
    recallPlan: { interfaceVersion: "brain-recall-plan.v1", mode: "llm", statuses: ["active", "verified", "weakened"],
      searchTerms: [], includeCandidates: false, maxItems: 8, memoryLimit: 200, routes: [], rationale: [], warnings: [] },
    routeResults: [], informationReadiness: buildInformationReadiness({ taskIntent: "current task", pack }),
    queryRetryTrace: { attempted: false }, ...overrides,
  } as BrainResult;
}
function invoke(currentWork = work) {
  const definition = createWorkshopToolDefinitions({ runtime: "pi", workshop: currentWork, workshopId: workId, runId: "run" })
    .find(tool => tool.name === "workshopSearchMemory");
  expect(definition).toBeDefined();
  return definition!.handler;
}
async function search() {
  const result = await invoke()({ query: "current task", limit: 8 }, {});
  const data = result.data as Record<string, any>;
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(data);
  return data;
}
function expectNoLegacyRead() {
  expect(mocks.memories).not.toHaveBeenCalled();
  expect(mocks.directives).not.toHaveBeenCalled();
  expect(mocks.events).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.work.mockResolvedValue(work);
  mocks.brain.mockResolvedValue(brain());
  mocks.memories.mockResolvedValue([legacy]);
  mocks.directives.mockResolvedValue([]);
  mocks.events.mockResolvedValue([]);
});

describe("registered workshopSearchMemory preserves authorized Brain recall", () => {
  it("keeps an empty successful Brain response instead of silently substituting legacy records", async () => {
    const data = await search();
    expect(data.memoryBackend).toBe("brain");
    expect(data.results).toEqual([]);
    expect(data.memoryContext.taskRelevantMemories).toEqual([]);
    expect(data.coverage).toMatchObject({ brainStatus: "responded", resultKind: "empty", deniedCount: 0,
      sourceHealth: "no_degradation_reported", fallbackReason: null, fallbackScope: null, answerCompleteness: "not_verified" });
    expect(JSON.stringify(data)).not.toContain(legacy.content);
    expectNoLegacyRead();
  });

  it("preserves denials and review gaps without reading around them", async () => {
    const recalled = brain({
      denied: [{ id: "denied-memory", reason: "no_matching_grant" }],
      omitted: [{ id: "candidate-memory", reason: "candidate_requires_review" }],
      selection: { selectedCount: 0, deniedCount: 1, omittedCount: 1, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} },
    });
    mocks.brain.mockResolvedValue(recalled);
    const data = await search();
    expect(data.memoryBackend).toBe("brain");
    expect(data.brainContext.denied).toEqual(recalled.denied);
    expect(data.brainContext.omitted).toEqual(recalled.omitted);
    expect(data.results).toEqual([]);
    expect(data.coverage).toMatchObject({ brainStatus: "responded", resultKind: "empty", deniedCount: 1, omittedCount: 1,
      sourceHealth: "no_degradation_reported", fallbackReason: null });
    expectNoLegacyRead();
  });

  it("uses the selected Brain pack without loading or exposing unused legacy memory", async () => {
    const item = { id: "brain-memory", memoryType: "plan", ownerType: "work", ownerId: workId, subject: "current task",
      content: "selected canonical plan", score: 80, reasons: ["token_match:1"], evidenceRefs: [] };
    mocks.brain.mockResolvedValue(brain({ items: [item] as BrainResult["items"] }));
    const data = await search();
    expect(data.memoryBackend).toBe("brain");
    expect(data.results).toEqual([item]);
    expect(data.memoryContext.taskRelevantMemories[0]).toMatchObject({ id: item.id, content: item.content });
    expect(JSON.stringify(data)).not.toContain(legacy.content);
    expectNoLegacyRead();
  });

  it("keeps a degraded but returned Brain result as Brain rather than treating it as empty healthy coverage", async () => {
    const recalled = brain();
    recalled.recallPlan = { ...recalled.recallPlan, mode: "fallback_rules", warnings: ["llm_recall_planner_failed:timeout"] };
    recalled.routeResults = [{ route: "knowledge_store", purpose: "evidence", status: "failed", reason: "source failed",
      count: 0, results: [], error: "recall_source_incomplete" }];
    mocks.brain.mockResolvedValue(recalled);
    const data = await search();
    expect(data.memoryBackend).toBe("brain");
    expect(data.brainContext.recallPlan.mode).toBe("fallback_rules");
    expect(data.brainContext.routeResults).toEqual(recalled.routeResults);
    expect(data.coverage).toMatchObject({ brainStatus: "responded", resultKind: "empty", sourceHealth: "degraded",
      plannerMode: "fallback_rules", routeGaps: [{ route: "knowledge_store", status: "failed" }], fallbackReason: null });
    expectNoLegacyRead();
  });

  it("uses only the current Work's existing fallback readers after an actual Brain error", async () => {
    mocks.brain.mockRejectedValue(new Error("private SQL https://provider.invalid/?credential=secret"));
    const data = await search();
    expect(data.memoryBackend).toBe("legacy");
    expect(data.brainContext).toBeNull();
    expect(data.brainContextError).toBe("memory_context_unavailable");
    expect(JSON.stringify(data)).not.toMatch(/private SQL|provider\.invalid|credential=secret/);
    expect(data.results).toEqual(data.memoryContext.taskRelevantMemories);
    expect(data.coverage).toMatchObject({ requester: { type: "work", id: workId }, brainStatus: "unavailable", resultKind: "selected",
      sourceHealth: "unavailable", deniedCount: null, omittedCount: null, fallbackReason: "brain_recall_error",
      fallbackScope: { type: "work", workId }, answerCompleteness: "not_verified" });
    expect(data.memoryContext.informationReadiness).toMatchObject({
      assessment: "evidence_inventory_only", sourceWarnings: ["brain_memory:failed"],
    });
    expect(mocks.memories).toHaveBeenCalledExactlyOnceWith(workId, 100);
    expect(mocks.directives).toHaveBeenCalledExactlyOnceWith(workId, 50);
    expect(mocks.events).toHaveBeenCalledExactlyOnceWith(workId, { limit: 40, order: "latest" });
    expect(mocks.brain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requester: { type: "work", userId, id: workId, workshopId: workId }, taskIntent: "current task", maxItems: 8,
    }));
  });

  it("keeps required missing, stale and unverified needs distinct in the returned Brain inventory", async () => {
    const recalled = brain();
    recalled.informationReadiness = {
      ...recalled.informationReadiness,
      needs: [
        { id: "missing-source", category: "task", question: "Pending task source", required: true, status: "missing",
          memoryIds: [], evidenceRefs: [], nextAction: "targeted_recall" },
        { id: "stale-state", category: "platform", question: "Current execution state", required: true, status: "stale",
          memoryIds: [], evidenceRefs: [], nextAction: "refresh_source" },
        { id: "unverified-lesson", category: "experience", question: "Prior lesson", required: true, status: "unverified",
          memoryIds: [], evidenceRefs: [], nextAction: "verify_source" },
      ],
      unresolvedRequired: ["missing-source", "stale-state", "unverified-lesson"],
    };
    mocks.brain.mockResolvedValue(recalled);
    const data = await search();
    expect(data.memoryContext.informationReadiness).toEqual(recalled.informationReadiness);
    expect(data.coverage.requiredGaps).toEqual([
      { id: "missing-source", status: "missing" }, { id: "stale-state", status: "stale" },
      { id: "unverified-lesson", status: "unverified" },
    ]);
    expectNoLegacyRead();
  });

  it("does not turn an explicitly scoped-out route into a provider failure", async () => {
    const recalled = brain();
    recalled.routeResults = [{ route: "knowledge_store", purpose: "evidence", status: "skipped",
      reason: "Source is outside the caller's explicit discovery scope.", count: 0, results: [] }];
    mocks.brain.mockResolvedValue(recalled);
    const data = await search();
    expect(data.coverage).toMatchObject({ sourceHealth: "no_degradation_reported",
      routeGaps: [{ route: "knowledge_store", status: "skipped" }], fallbackReason: null });
    expectNoLegacyRead();
  });

  it("keeps failed primary coverage explicit even if the same-Work fallback is empty", async () => {
    mocks.brain.mockRejectedValue(new Error("brain unavailable"));
    mocks.memories.mockResolvedValue([]);
    const data = await search();
    expect(data.results).toEqual([]);
    expect(data.coverage).toMatchObject({ resultKind: "empty", brainStatus: "unavailable", sourceHealth: "unavailable",
      fallbackReason: "brain_recall_error", answerCompleteness: "not_verified" });
    expect(data.memoryContext.informationReadiness.sourceWarnings).toContain("brain_memory:failed");
  });

  it("does not report a successful fallback when its current-Work reader also fails", async () => {
    mocks.brain.mockRejectedValue(new Error("brain unavailable"));
    mocks.memories.mockRejectedValue(new Error("legacy reader unavailable"));
    await expect(invoke()({ query: "current task", limit: 8 }, {})).rejects.toThrow("legacy reader unavailable");
    expect(mocks.memories).toHaveBeenCalledExactlyOnceWith(workId, 100);
  });

  it("rejects changed Work ownership before either source is queried", async () => {
    const handler = invoke();
    mocks.work.mockResolvedValue({ ...work, id: "another-work" });
    await expect(handler({ query: "current task", limit: 8 }, {})).rejects.toThrow("Work ownership mismatch");
    expect(mocks.brain).not.toHaveBeenCalled();
    expectNoLegacyRead();
  });

  it("rejects a current explicit tool denial before Brain or legacy reads", async () => {
    const handler = invoke();
    mocks.work.mockResolvedValue({ ...work, modelConfig: { ...work.modelConfig, disallowedTools: ["workshopSearchMemory"] } });
    await expect(handler({ query: "current task", limit: 8 }, {})).rejects.toThrow("Tool denied");
    expect(mocks.brain).not.toHaveBeenCalled();
    expectNoLegacyRead();
  });

  it("passes the saved Work scenario binding to Brain rather than inferring it from the query", async () => {
    const bound = { ...work, modelConfig: { ...work.modelConfig,
      memoryApplicability: { schemaVersion: "memory-applicability.v1", scenarioKeys: ["project:alpha"] } } };
    mocks.work.mockResolvedValue(bound);
    await invoke(bound)({ query: "project beta latest task", limit: 8 }, {});
    expect(mocks.brain).toHaveBeenCalledWith(expect.objectContaining({ sourceFilters: { scenarioKeys: ["project:alpha"] } }));
    expectNoLegacyRead();
  });

  it("withholds legacy material when Brain fails for a scenario-bound Work", async () => {
    const bound = { ...work, modelConfig: { ...work.modelConfig,
      memoryApplicability: { schemaVersion: "memory-applicability.v1", scenarioKeys: ["project:alpha"] } } };
    mocks.work.mockResolvedValue(bound);
    mocks.brain.mockRejectedValue(new Error("private SQL https://provider.invalid/?credential=secret"));
    const result = await invoke(bound)({ query: "current task", limit: 8 }, {});
    expect(result.data).toMatchObject({ memoryBackend: "unavailable", results: [], brainContextError: "memory_context_unavailable",
      coverage: { sourceFilters: { scenarioKeys: ["project:alpha"] }, sourceHealth: "unavailable",
        fallbackReason: "brain_recall_error_scenario_bound", fallbackScope: null } });
    expect(JSON.stringify(result)).not.toContain(legacy.content);
    expect(JSON.stringify(result)).not.toMatch(/private SQL|provider\.invalid|credential=secret/);
    expectNoLegacyRead();
  });

  it("rejects a malformed saved binding before Brain or legacy queries", async () => {
    const bound = { ...work, modelConfig: { ...work.modelConfig,
      memoryApplicability: { schemaVersion: "memory-applicability.v1", scenarioKeys: [] } } };
    mocks.work.mockResolvedValue(bound);
    await expect(invoke(bound)({ query: "current task", limit: 8 }, {})).rejects.toThrow("Invalid Work memory applicability binding");
    expect(mocks.brain).not.toHaveBeenCalled();
    expectNoLegacyRead();
  });
});
