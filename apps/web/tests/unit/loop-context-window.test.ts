import { describe, expect, it } from "vitest";
import type {
  LoopState,
  Workshop,
  WorkshopDirective,
  WorkshopEvent,
  WorkshopMemory,
  WorkshopSource,
} from "@/lib/db/schema";
import {
  prepareLoopContextWindow,
  prepareLoopWorkshopContext,
} from "@/lib/loops/context-window";
import { parseLoopSpec } from "@/lib/loops/spec";
import { buildWorkshopMemoryContextPack, type WorkshopMemoryContextPack } from '@/lib/workshops/memory-context';

const loopSpec = parseLoopSpec({
  goal: "Send a daily report",
  trigger: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
  context: { sources: [] },
  actions: { allowed: ["wechatDesktopSendMessage"], requiresApproval: [], denied: [] },
  verification: {
    type: "structured_check",
    requiredSources: ["wechatDesktopSendMessage"],
  },
});

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "loop-1",
    currentPhase: "idle",
    memorySummary: null,
    openQuestions: [],
    lastObservation: null,
    nextAction: null,
    blockedReason: null,
    stateJson: {},
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  } as LoopState;
}

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "Market watcher",
    mission: "Track market risks and brief the owner.",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: {
      externalMessages: "draft",
      allowedRecipients: ["Alice"],
    },
    modelConfig: {},
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  } as Workshop;
}

function source(overrides: Partial<WorkshopSource> = {}): WorkshopSource {
  return {
    id: "source-1",
    workshopId: "workshop-1",
    type: "note",
    name: "Watchlist",
    uri: null,
    content: "Important source context",
    config: {},
    enabled: true,
    lastCheckedAt: null,
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  } as WorkshopSource;
}

function memory(overrides: Partial<WorkshopMemory> = {}): WorkshopMemory {
  return {
    id: "memory-1",
    workshopId: "workshop-1",
    kind: "finding",
    content: "Owner prefers concise morning briefings.",
    confidence: 80,
    tags: ["briefing"],
    sourceEventIds: ["event-1"],
    expiresAt: null,
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  } as WorkshopMemory;
}

function directive(
  overrides: Partial<WorkshopDirective> = {},
): WorkshopDirective {
  return {
    id: "directive-1",
    workshopId: "workshop-1",
    runId: null,
    content: "Always include opposing risks.",
    priority: 1,
    scope: "persistent",
    status: "active",
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  } as WorkshopDirective;
}

function event(overrides: Partial<WorkshopEvent> = {}): WorkshopEvent {
  return {
    id: "event-1",
    workshopId: "workshop-1",
    runId: null,
    loopId: "loop-1",
    loopRunId: "loop-run-1",
    seq: 1,
    type: "source_checked",
    title: "Checked source",
    body: "Useful recent event context",
    metadata: {},
    visibility: "user",
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  } as WorkshopEvent;
}

describe("loop context window", () => {
  it("keeps small durable state unchanged", () => {
    const result = prepareLoopContextWindow({
      loopSpec,
      state: state({
        stateJson: {
          loopSpec,
          lastLoopRunId: "run-1",
        },
      }),
      maxChars: 10_000,
    });

    expect(result.compacted).toBe(false);
    expect(result.durableState.stateJson).toMatchObject({
      lastLoopRunId: "run-1",
    });
  });

  it("compacts oversized state while preserving essential loop state", () => {
    const result = prepareLoopContextWindow({
      loopSpec,
      state: state({
        memorySummary: "important memory",
        openQuestions: Array.from({ length: 20 }, (_, index) => ({
          id: index,
        })),
        stateJson: {
          loopSpec,
          lastLoopRunId: "run-2",
          nextScheduledRunAt: "2026-06-30T01:00:00.000Z",
          noisyScratchpad: "x".repeat(20_000),
        },
      }),
      maxChars: 3_000,
    });

    expect(result.compacted).toBe(true);
    expect(result.durableState.memorySummary).toBe("important memory");
    expect(result.durableState.openQuestions).toHaveLength(8);
    expect(result.durableState.stateJson).toMatchObject({
      lastLoopRunId: "run-2",
      nextScheduledRunAt: "2026-06-30T01:00:00.000Z",
    });
    expect(result.durableState.stateJson.loopSpec).toBeTruthy();
    expect(result.omittedStateKeys).toContain("noisyScratchpad");
    expect(result.durableState.stateJson._contextCompaction).toMatchObject({
      omittedStateKeys: ["noisyScratchpad"],
    });
  });

  it("prepares bounded workshop context for workshop-owned loops", () => {
    const result = prepareLoopWorkshopContext({
      workshop: workshop(),
      sources: [
        source({ id: "enabled-source", name: "Enabled source" }),
        source({
          id: "disabled-source",
          name: "Disabled source",
          enabled: false,
        }),
      ],
      memories: [memory()],
      directives: [
        directive({ id: "persistent-directive", scope: "persistent" }),
        directive({
          id: "current-run-directive",
          scope: "current_run",
          content: "Only for an unrelated live run.",
        }),
      ],
      events: [event()],
      maxChars: 10_000,
    });

    expect(result.compacted).toBe(false);
    expect(result.workshop).toMatchObject({
      id: "workshop-1",
      name: "Market watcher",
    });
    expect(result.boundaryPolicy).toContain("External messages: draft");
    expect(result.sources.map((item) => item.id)).toEqual(["enabled-source"]);
    expect(result.directives.map((item) => item.id)).toEqual([
      "persistent-directive",
    ]);
    expect(result.memories[0]).toMatchObject({
      kind: "finding",
      tags: ["briefing"],
    });
    expect(result.memoryContext).toMatchObject({
      controlModel: "engineering_cybernetics_v1",
    });
    expect(result.memoryContext.taskRelevantMemories[0]).toMatchObject({
      kind: "finding",
    });
    expect(result.recentEvents[0]).toMatchObject({
      loopId: "loop-1",
      loopRunId: "loop-run-1",
    });
  });

  it("compacts oversized workshop context", () => {
    const result = prepareLoopWorkshopContext({
      workshop: workshop({ mission: "x".repeat(1000) }),
      sources: Array.from({ length: 30 }, (_, index) =>
        source({
          id: `source-${index}`,
          content: `source-${index} ${"x".repeat(2_000)}`,
        }),
      ),
      memories: Array.from({ length: 50 }, (_, index) =>
        memory({
          id: `memory-${index}`,
          content: `memory-${index} ${"y".repeat(2_000)}`,
        }),
      ),
      directives: Array.from({ length: 2 }, (_, index) =>
        directive({
          id: `directive-${index}`,
          content: `directive-${index} Keep this complete owner instruction.`,
        }),
      ),
      events: Array.from({ length: 40 }, (_, index) =>
        event({
          id: `event-${index}`,
          seq: index + 1,
          body: `event-${index} ${"w".repeat(2_000)}`,
        }),
      ),
      maxChars: 5_000,
    });

    expect(result.compacted).toBe(true);
    expect(result.sources.length).toBeLessThanOrEqual(10);
    expect(result.memories.length).toBeLessThanOrEqual(20);
    expect(result.directives).toHaveLength(2);
    expect(result.recentEvents.length).toBeLessThanOrEqual(20);
    expect(result.omittedSections).toEqual(
      expect.arrayContaining([
        "sources",
        "memories",
        "recentEvents",
      ]),
    );
    expect(result.compactedChars).toBe(JSON.stringify(result).length);
    expect(result.compactedChars).toBeLessThanOrEqual(5_000);
  });
});

function context(): WorkshopMemoryContextPack {
  return buildWorkshopMemoryContextPack({ workshop: workshop(), memories: [], directives: [], events: [], taskIntent: 'Research current source limitations' });
}
function contextItem(id: string, content: string, extra: Partial<WorkshopMemoryContextPack['taskRelevantMemories'][number]> = {}) {
  return { id, revisionVersion: `bmrv1:${'a'.repeat(64)}`, kind: 'finding', status: 'active', content,
    confidence: 80, tags: [], sourceEventIds: ['original-event'], score: 80, reasons: ['brain_context'], ...extra };
}
const noisyRecall = { backend: 'brain' as const, contextLogId: 'owner-memory-context-log',
  contextPack: { selected: [], optionalTrace: 'auxiliary index detail '.repeat(2_000) } };

describe('complete owner corrections through Loop context compaction', () => {
  it('keeps actual safety qualifiers and revision cues ahead of scoring reasons through both compaction passes without inventing warnings', () => {
    const selected = context();
    const qualifiers = ['warning:owner_statement_control_feedback_not_verified_fact', 'warning:observation_time_unknown',
      'warning:memory_update_pending', 'warning:content_reports_conflict'];
    const revisions = ['relevant_recent_revision', 'reserved_relevant_revision'];
    const generic = ['brain_context', 'confidence', 'freshness:fresh_24h', 'token_match:13', 'profile:research', 'extra_score'];
    selected.taskRelevantMemories = [contextItem('current-correction', 'Full current correction with limited authority.',
      { supersedes: ['old-memory'], confidence: 25, reasons: [...generic, ...revisions, ...qualifiers] }),
      contextItem('ordinary', 'Independent ordinary note.', { reasons: generic })];
    const original = structuredClone(selected);
    const result = prepareLoopWorkshopContext({ workshop: workshop(), sources: [], memories: [], directives: [], events: [],
      memoryContext: selected, memoryRecall: noisyRecall, maxChars: 20_000 });
    expect(result.omittedSections).toContain('memoryRecallDetails');
    const current = result.memoryContext.taskRelevantMemories.find(item => item.id === 'current-correction');
    expect(current).toMatchObject({ confidence: 25, content: 'Full current correction with limited authority.',
      reasons: [...qualifiers, ...revisions] });
    expect(result.memoryContext.taskRelevantMemories.find(item => item.id === 'ordinary')?.reasons).toEqual(generic.slice(0, 5));
    expect(result.compactedChars).toBe(JSON.stringify(result).length);
    expect(result.compactedChars).toBeLessThanOrEqual(20_000);
    expect(selected).toEqual(original);
  });
  it('preserves a 323-character current replacement through the second compaction pass and prioritizes it beyond the ordinary item limit', () => {
    const correction = 'Corrected current source conditions. '.padEnd(259, 'x') + ' The former claim is withdrawn; verify the current source first.';
    expect(correction).toHaveLength(323);
    const selected = context();
    selected.taskRelevantMemories = [...Array.from({ length: 9 }, (_, index) => contextItem(`ordinary-${index}`, 'ordinary '.repeat(180))),
      contextItem('current-correction', correction, { supersedes: ['old-memory'] })];
    selected.correctionMemoryIds = ['current-correction'];
    const original = structuredClone(selected);
    const result = prepareLoopWorkshopContext({ workshop: workshop(), sources: [], memories: [], directives: [], events: [],
      memoryContext: selected, memoryRecall: noisyRecall, maxChars: 20_000 });
    expect(result.compacted).toBe(true);
    expect(result.omittedSections).toContain('memoryRecallDetails');
    const delivered = result.memoryContext.taskRelevantMemories.find(item => item.id === 'current-correction');
    expect(delivered).toMatchObject({ content: correction, revisionVersion: `bmrv1:${'a'.repeat(64)}`, supersedes: ['old-memory'], status: 'active' });
    expect((delivered as any).contentStatus).toBe('full');
    expect(result.memoryContext.taskRelevantMemories[0].id).toBe('current-correction');
    const ordinary = result.memoryContext.taskRelevantMemories.find(item => item.id.startsWith('ordinary'));
    expect(ordinary?.content).toContain('[truncated');
    expect((ordinary as any)?.contentStatus).toBe('snippet');
    expect(result.compactedChars).toBe(JSON.stringify(result).length);
    expect(result.compactedChars).toBeLessThanOrEqual(20_000);
    expect(selected).toEqual(original);
  });
  it('replaces an oversized authoritative body with an explicit exact-version full-read requirement, never a shortened active rule', () => {
    const selected = context();
    const huge = 'Do not act until the full conditions are checked. '.repeat(1_000);
    selected.taskRelevantMemories = [contextItem('large-correction', huge, { supersedes: ['old-rule'] })];
    const result = prepareLoopWorkshopContext({ workshop: workshop(), sources: [], memories: [], directives: [], events: [],
      memoryContext: selected, memoryRecall: noisyRecall, maxChars: 4_000 });
    const item = result.memoryContext.taskRelevantMemories[0] as any;
    expect(item).toMatchObject({ id: 'large-correction', content: '', contentStatus: 'omitted_requires_read',
      originalStatus: 'active', status: 'requires_full_read', originalContentChars: huge.length,
      revisionVersion: `bmrv1:${'a'.repeat(64)}`, readRequired: { tool: 'workshopReadMemory', memoryId: 'large-correction',
        expectedRevisionVersion: `bmrv1:${'a'.repeat(64)}` } });
    expect(item.readRequired.instruction).toContain('stop and ask the owner');
    expect(JSON.stringify(result)).not.toContain(huge.slice(0, 200));
    expect(result.omittedSections).toContain('authoritativeMemoryBodiesRequireRead');
    expect(result.compactedChars).toBeLessThanOrEqual(4_000);
  });
  it('keeps the complete Work role, persistent owner instructions and permission boundaries under pressure', () => {
    const mission = 'Research only. '.repeat(190) + 'ROLE_TAIL_DO_NOT_PUBLISH';
    const command = 'Read all current conditions before publishing. '.repeat(30) + 'DIRECTIVE_TAIL_REQUIRES_OWNER';
    const work = workshop({ mission, boundaryPolicy: { externalMessages: 'draft', allowedRecipients: ['Alice'],
      hardDeniedActions: ['externalPublisher', 'realMoneyTransfer'], requiresApprovalActions: ['ownerApprovedSend'] },
      modelConfig: { allowedTools: ['webReadPage'], disallowedTools: ['externalPublisher'], requiresApprovalTools: ['ownerApprovedSend'] } });
    const originalWork = structuredClone(work);
    const selected = context(); selected.taskRelevantMemories = [contextItem('rule', 'Complete current boundary.', { kind: 'boundary' })];
    const clean = prepareLoopWorkshopContext({ workshop: work, sources: [], memories: [], directives: [directive({ content: command })],
      events: [], memoryContext: selected, maxChars: 100_000 });
    const pressured = prepareLoopWorkshopContext({ workshop: work, sources: [], memories: [], directives: [directive({ content: command })],
      events: [], memoryContext: selected, memoryRecall: noisyRecall, maxChars: 10_000 });
    expect(pressured.workshop.mission).toBe(mission);
    expect(pressured.directives[0].content).toBe(command);
    expect(pressured.boundaryPolicy).toBe(clean.boundaryPolicy);
    expect(pressured.boundaryPolicy).toContain('External messages: draft');
    expect(pressured.boundaryPolicy).toContain('Alice');
    expect(pressured.boundaryPolicy).toContain('always blocked');
    expect(pressured.omittedSections).not.toContain('workshopMission');
    expect(pressured.omittedSections).not.toContain('directives');
    expect(pressured.compactedChars).toBeLessThanOrEqual(10_000);
    expect(work).toEqual(originalWork);
  });
  it('rejects protected core that cannot fit rather than shortening instructions or increasing the budget', () => {
    expect(() => prepareLoopWorkshopContext({ workshop: workshop({ mission: 'Protected role. '.repeat(500) }), sources: [], memories: [],
      directives: [directive({ content: 'Required owner instruction. '.repeat(1_000) })], events: [], maxChars: 5_000 }))
      .toThrow('loop_workshop_required_context_budget_exceeded');
  });
  it('preserves primary recall failure signals when optional recall diagnostics are compacted', () => {
    const selected = context(); selected.taskRelevantMemories = [contextItem('rule', 'Current complete correction.', { supersedes: ['old'] })];
    const result = prepareLoopWorkshopContext({ workshop: workshop(), sources: [], memories: [], directives: [], events: [],
      memoryContext: selected, memoryRecall: { ...noisyRecall, routeResults: [{ route: 'brain_memory', status: 'failed', error: 'unavailable' }] }, maxChars: 4_000 });
    expect(result.memoryRecall.routeResults).toEqual([{ route: 'brain_memory', status: 'failed', error: 'primary_memory_route_error' }]);
  });
  it('retains only real selected identity receipts under pressure without copying previews or inventing a selection', () => {
    const selected = context(); selected.taskRelevantMemories = [contextItem('actual-current', 'Complete current correction.', { supersedes: ['old'] })];
    const recall = { ...noisyRecall, contextPack: { ...noisyRecall.contextPack, selected: [
      { id: 'actual-current', revisionVersion: 'bmrv1:current-source-version', contentPreview: 'Optional preview body' },
    ] } };
    const before = structuredClone(recall);
    const result = prepareLoopWorkshopContext({ workshop: workshop(), sources: [], memories: [], directives: [], events: [],
      memoryContext: selected, memoryRecall: recall, maxChars: 4_000 });
    expect(result.memoryRecall.contextPack).toEqual({ selected: [{ id: 'actual-current', revisionVersion: 'bmrv1:current-source-version' }] });
    expect(result.memoryRecall.contextLogId).toBe(recall.contextLogId);
    expect(result.memoryRecall.backend).toBe('brain');
    expect(result.compactedChars).toBeLessThanOrEqual(4_000);
    expect(recall).toEqual(before);
  });
});

describe('compact recall-planner completion receipts', () => {
  const provider = { source: 'env_anthropic_compatible', model: 'qwen3.7-plus', protocol: 'anthropic-messages',
    finishReason: 'end_turn', thinkingMode: 'disabled', migrated: true };
  function prepare(recallPlan: unknown, maxChars = 4_000) {
    const selected = context();
    selected.taskRelevantMemories = [contextItem('current-correction', 'Current owner correction. '.padEnd(323, 'x'),
      { confidence: 25, supersedes: ['superseded-memory'] })];
    selected.correctionMemoryIds = ['current-correction'];
    const recall = { ...noisyRecall, recallPlan, contextPack: { ...noisyRecall.contextPack,
      selected: [{ id: 'current-correction', revisionVersion: `bmrv1:${'a'.repeat(64)}` }] } };
    const before = structuredClone(recall);
    const result = prepareLoopWorkshopContext({ workshop: workshop(), sources: [], memories: [], directives: [], events: [],
      memoryContext: selected, memoryRecall: recall, maxChars });
    expect(result.omittedSections).toContain('memoryRecallDetails');
    expect(result.compactedChars).toBe(JSON.stringify(result).length);
    expect(result.compactedChars).toBeLessThanOrEqual(maxChars);
    expect(recall).toEqual(before);
    return result;
  }

  it('retains actual LLM terminal identity without query, rationale, endpoint, or response bodies', () => {
    const secret = 'PRIVATE_QUERY_OR_RESPONSE_BODY';
    const result = prepare({ mode: 'llm', provider: { ...provider, baseUrl: `https://example.test/?query=${secret}`,
      configuredBaseUrl: secret, rawResponse: secret }, degraded: false, warnings: [],
      searchTerms: [secret], rationale: [secret], queryRetry: { query: secret }, response: secret });
    expect(result.memoryRecall.recallPlan).toEqual({ mode: 'llm', provider, degraded: false,
      fallbackReason: null, warnings: [], warningCount: 0 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.memoryContext.taskRelevantMemories[0]).toMatchObject({ content: 'Current owner correction. '.padEnd(323, 'x'),
      confidence: 25, status: 'active', revisionVersion: `bmrv1:${'a'.repeat(64)}` });
    expect(result.memoryRecall.contextPack).toEqual({ selected: [{ id: 'current-correction', revisionVersion: `bmrv1:${'a'.repeat(64)}` }] });
  });

  it('keeps rule fallback and its real warning code without inventing an LLM completion', () => {
    const result = prepare({ mode: 'fallback_rules', provider: { ...provider, finishReason: undefined }, degraded: true,
      fallbackReason: 'llm_recall_planner_failed:PRIVATE_QUERY_OR_RESPONSE_BODY',
      warnings: ['llm_recall_planner_failed:PRIVATE_QUERY_OR_RESPONSE_BODY'] });
    expect(result.memoryRecall.recallPlan).toMatchObject({ mode: 'fallback_rules', degraded: true,
      fallbackReason: 'llm_recall_planner_failed', warnings: ['llm_recall_planner_failed'], warningCount: 1,
      provider: { ...provider, finishReason: null } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_QUERY_OR_RESPONSE_BODY');
  });

  it.each([undefined, { mode: 'llm' }])('does not synthesize a provider or successful terminal for incomplete recall metadata: %j', recallPlan => {
    const result = prepare(recallPlan);
    expect(result.memoryRecall.recallPlan).toEqual({ mode: recallPlan ? 'llm' : 'unknown', provider: null,
      degraded: null, fallbackReason: null, warnings: null, warningCount: null });
  });

  it('bounds arbitrary planner warnings and invalid provider fields without enlarging the context window', () => {
    const privateText = 'PRIVATE_QUERY_OR_RESPONSE_BODY'.repeat(1_000);
    const result = prepare({ mode: 'fallback_rules', degraded: 'false', fallbackReason: privateText,
      provider: { source: privateText, model: privateText, protocol: privateText, finishReason: privateText,
        thinkingMode: privateText, migrated: 'true', responseBody: privateText }, warnings: Array(100).fill(privateText) });
    expect(result.memoryRecall.recallPlan).toMatchObject({ mode: 'fallback_rules', degraded: null,
      fallbackReason: 'details_omitted', warningCount: 100, warnings: Array(4).fill('details_omitted'),
      provider: { source: null, model: null, protocol: null, finishReason: null, thinkingMode: null, migrated: null } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_QUERY_OR_RESPONSE_BODY');
    expect(result.maxChars).toBe(4_000);
  });
});
