import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type {
  Loop,
  Workshop,
  WorkshopDirective,
  WorkshopEvent,
  WorkshopRun,
} from "@/lib/db/schema";

const now = new Date("2026-07-07T00:00:00.000Z");
const events = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const completeWorkshopRunMock = vi.hoisted(() => vi.fn());
const createOutboxDraftMock = vi.hoisted(() => vi.fn());
const executeWorkshopAgentMock = vi.hoisted(() => vi.fn());
const listActiveDirectivesMock = vi.hoisted(() => vi.fn());
const getOwnedWorkshopDirectiveMock = vi.hoisted(() => vi.fn());
const listLoopsForWorkshopMock = vi.hoisted(() => vi.fn());
const planWorkshopDirectiveMock = vi.hoisted(() => vi.fn());
const proposeWorkshopLoopFromNaturalLanguageMock = vi.hoisted(() => vi.fn());
const loadWebEvidenceMock = vi.hoisted(() => vi.fn());
const fenceMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/ai/jina-page-reader', () => ({ loadWebEvidence: loadWebEvidenceMock }));
vi.mock('@/lib/work-runtime/run-output',()=>({captureRunOutput:vi.fn(async(_lease,value)=>value),readCapturedRunOutput:vi.fn(async()=>null)}));
vi.mock('@/lib/work-runtime/run-plan',()=>({readCapturedRunPlan:vi.fn(async()=>null),captureRunPlan:vi.fn(async(_lease,value)=>value),applyRunPlanStep:vi.fn(async(_lease,_step,write)=>write({append:appendWorkshopEventMock}))}));
vi.mock('@/lib/work-runtime/execution-lease',()=>({withExecutionWrite:fenceMock,withExecutionBusinessWrite:fenceMock,renewExecutionLease:vi.fn(async()=>new Date())}));
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import { readCapturedRunPlan } from '@/lib/work-runtime/run-plan';
import { readCapturedRunOutput } from '@/lib/work-runtime/run-output';
import {captureCompletedWorkshopRunEvidence} from '@/lib/harness-evolution/capture-service';
import { listWorkshopEvents } from '@/lib/workshops/service';
import { writeBrainMemory, createBrainMemoryCandidate } from '@/lib/brain/service';
import { scheduleWorkshopWakeupFromSuggestion } from '@/lib/workshops/heartbeat';
import type { WorkshopExecutionResult } from '@/lib/workshops/executor';
import { buildWorkPresentation } from '@/lib/workshops/work-presentation';

vi.mock("@/lib/loops/service", () => ({
  listLoopsForWorkshop: listLoopsForWorkshopMock,
}));

vi.mock("@/lib/workshops/directive-planner", () => ({
  planWorkshopDirective: planWorkshopDirectiveMock,
}));

vi.mock("@/lib/workshops/executor", () => ({
  executeWorkshopAgent: executeWorkshopAgentMock,
}));

vi.mock("@/lib/workshops/heartbeat", () => ({
  scheduleWorkshopWakeupFromSuggestion: vi.fn(),
}));

vi.mock("@/lib/workshops/loop-service", () => ({
  proposeWorkshopLoopFromNaturalLanguage:
    proposeWorkshopLoopFromNaturalLanguageMock,
}));

vi.mock("@/lib/workshops/outbox-wechat", () => ({
  autoSendWorkshopOutboxIfWhitelisted: vi.fn(),
}));

vi.mock("@/lib/workshops/service", () => ({
  addWorkshopMemory: vi.fn(),
  appendWorkshopEvent: appendWorkshopEventMock,
  completeWorkshopRun: completeWorkshopRunMock,
  createOutboxDraft: createOutboxDraftMock,
  createWorkshopRun: vi.fn(),
  getWorkshop: vi.fn(),
  listActiveDirectives: listActiveDirectivesMock,
  getOwnedWorkshopDirective: getOwnedWorkshopDirectiveMock,
  listRecentSourceEventIds: vi.fn(async () => []),
  listWorkshopEvents: vi.fn(async () => []),
  listWorkshopMemories: vi.fn(async () => []),
  listWorkshopOutbox: vi.fn(async () => []),
  listWorkshopSources: vi.fn(async () => []),
}));

vi.mock("@/lib/harness-evolution/capture-service",()=>({captureCompletedWorkshopRunEvidence:vi.fn(),prepareRunHarnessCaptureContext:vi.fn()}));
vi.mock("@/lib/brain/service",()=>({createBrainStateSnapshot:vi.fn(),createBrainMemoryCandidate:vi.fn(),writeBrainMemory:vi.fn()}));

import {
  executeWorkshopRunLifecycle,
  startWorkshopRun,
  selectDirectivesForWorkshopRun,
} from "@/lib/workshops/runtime";

it('rejects the retired detached start entry',async()=>{
  await expect(startWorkshopRun({userId:'owner',workshopId:'work'})).rejects.toThrow('legacy_workshop_start_retired_use_work_runtime');
});

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "Research workshop",
    mission: "Plan and run durable research work.",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: {},
    modelConfig: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

function directive(
  overrides: Partial<WorkshopDirective> = {},
): WorkshopDirective {
  return {
    id: "directive-1",
    workshopId: "workshop-1",
    runId: null,
    content: "每个交易日开盘前生成关注列表",
    priority: 0,
    scope: "current_run",
    status: "active",
    createdAt: now,
    ...overrides,
  } as WorkshopDirective;
}

function run(overrides: Partial<WorkshopRun> = {}): WorkshopRun {
  return {
    id: "run-1",
    workshopId: "workshop-1",
    status: "running",
    triggerReason: {},
    inputSnapshot: {},
    outputSummary: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    ...overrides,
  } as WorkshopRun;
}

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-existing",
    userId: "user-1",
    workshopId: "workshop-1",
    name: "盘前关注列表",
    description: "Every trading day before market open, generate a watchlist.",
    goal: "Generate a watchlist before market open on each trading day.",
    status: "paused",
    triggerConfig: {},
    contextConfig: {},
    actionPolicy: {},
    verificationConfig: {},
    approvalPolicy: {},
    retryPolicy: {},
    escalationPolicy: {},
    createdAt: now,
    updatedAt: now,
  } as Loop;
}

async function executeWithDirective() {
  await executeWorkshopRunLifecycle({
    userId: "user-1",
    workshop: workshop(),
    run: run(),
    triggerReason: {
      type: "directive",
      directiveId: "directive-1",
      content: "每个交易日开盘前生成关注列表",
    },
  });
}

function groundedResearchFixture() {
  const bodyEventId = '8379608f-bdc1-4dc7-adfc-905c52592778';
  const evidenceId = '0d6f1520-4e28-4f4d-adc5-3ae7fb4440dd';
  const url = 'https://arxiv.org/html/2501.12948v1';
  const quotes = {
    method: 'The method estimates a baseline from the sampled group scores instead of an additional value model.',
    experiment: 'Model-Qwen-32B scores 72.6% on AIME 2024 under the specified evaluation conditions.',
    limitation: 'The study does not measure training latency, and external validity remains limited to the tested tasks.',
  };
  const content = Object.values(quotes).join('\n\n');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const config = { researchEvidenceContract: { version: 'primary-reading/v1', taskKeywords: ['deepseek'],
    reportDelivery: 'grounded-report/v1', requiredPrimarySources: [{ id: 'r1', label: 'R1', urls: [url] }] } };
  const receipt = { id: bodyEventId, runId: 'run-1', type: 'source_checked', metadata: {
    receiptAuthority: 'runtime', toolName: 'webReadPage', method: 'jina_defuddle', ok: true,
    url, finalUrl: url, finalUrlVerified: false, evidenceId, contentHash, offset: 0,
    contentLength: content.length, totalChars: content.length, nextOffset: null, qualityScore: 80,
  } };
  const snapshot = { evidenceId, contentHash, url, content };
  const researchEvidence = { reportVersion: 'grounded-report/v1', works: [{ sourceId: 'r1', supportedClaims: [
    { kind: 'method', claim: '该方法从 group scores 估计 baseline。', locator: 'Section 2', quote: quotes.method, evidenceEventId: bodyEventId },
    { kind: 'experiment', claim: 'Model-Qwen-32B 在 AIME 2024 得分 72.6%。', locator: 'Table 1', quote: quotes.experiment, evidenceEventId: bodyEventId },
    { kind: 'limitation', claim: '该研究未测量 training latency。', locator: 'Section 4', quote: quotes.limitation, evidenceEventId: bodyEventId },
  ] }], gaps: [] };
  const result: WorkshopExecutionResult = { status: 'success', output: 'The model raw output is retained separately.',
    structured: { researchEvidence }, toolCallCount: 1, durationMs: 100,
    researchEvidenceContext: { modelConfig: config, taskText: 'Focus on DeepSeek' } };
  return { config, receipt, snapshot, result, researchEvidence, bodyEventId };
}

describe("workshop runtime directive planning", () => {
  beforeEach(() => {
    fenceMock.mockReset();
    fenceMock.mockResolvedValue(undefined);
    vi.mocked(captureCompletedWorkshopRunEvidence).mockClear();
    vi.mocked(listWorkshopEvents).mockReset().mockResolvedValue([]);
    vi.mocked(writeBrainMemory).mockClear();
    vi.mocked(createBrainMemoryCandidate).mockClear();
    vi.mocked(scheduleWorkshopWakeupFromSuggestion).mockClear();
    loadWebEvidenceMock.mockReset();
    events.length = 0;
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock.mockImplementation(async (input) => {
      events.push(input);
      return {
        id: `event-${events.length}`,
        seq: events.length,
        createdAt: now,
        ...input,
      } as WorkshopEvent;
    });
    completeWorkshopRunMock.mockReset();
    completeWorkshopRunMock.mockResolvedValue(undefined);
    createOutboxDraftMock.mockReset();
    createOutboxDraftMock.mockResolvedValue({ id: "outbox-1" });
    executeWorkshopAgentMock.mockReset();
    executeWorkshopAgentMock.mockResolvedValue({
      status: "success",
      output: "run completed",
      structured: null,
      toolCallCount: 0,
      durationMs: 1,
    });
    listActiveDirectivesMock.mockReset();
    listActiveDirectivesMock.mockResolvedValue([directive()]);
    getOwnedWorkshopDirectiveMock.mockReset();
    getOwnedWorkshopDirectiveMock.mockImplementation(async ({ workshopId, directiveId }) =>
      (await listActiveDirectivesMock(workshopId)).find((item: WorkshopDirective) => item.id === directiveId) ?? null);
    listLoopsForWorkshopMock.mockReset();
    listLoopsForWorkshopMock.mockResolvedValue([]);
    planWorkshopDirectiveMock.mockReset();
    proposeWorkshopLoopFromNaturalLanguageMock.mockReset();
    proposeWorkshopLoopFromNaturalLanguageMock.mockResolvedValue({
      loop: {
        id: "loop-1",
        name: "盘前关注列表",
        description: "Create watchlist before market open.",
      },
      draft: {},
    });
  });

  it("persists the same host canonical report for fresh and captured output using the pinned contract", async () => {
    const evidence = groundedResearchFixture();
    const main = directive({ content: 'Focus on DeepSeek' });
    const trigger = { type: 'directive', directiveId: main.id, content: main.content };
    const lease = { userId: 'user-1', workshopId: 'workshop-1', runId: 'run-1', workerId: 'worker', token: 1 };
    listActiveDirectivesMock.mockResolvedValue([main]);
    planWorkshopDirectiveMock.mockResolvedValue({ action: 'run_once', confidence: 1, reason: 'Test', model: 'fake' });
    vi.mocked(listWorkshopEvents).mockImplementation(async (_workshopId, options) =>
      options?.runId ? [evidence.receipt] as unknown as WorkshopEvent[] : []);
    loadWebEvidenceMock.mockResolvedValue({ directory: 'owned-snapshot', snapshot: evidence.snapshot });
    executeWorkshopAgentMock.mockResolvedValue(evidence.result);
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({ modelConfig: evidence.config }),
      run: run({ triggerReason: trigger }), executionLease: lease });
    const fresh = completeWorkshopRunMock.mock.calls.at(-1)![0];
    expect(fresh).toMatchObject({ status: 'completed', directiveIds: [main.id], metadata: {
      researchDelivery: { status: 'delivered', verificationStatus: 'verified', semanticStatus: 'not_independently_verified', version: 'reader-report/v1', issues: [] },
      researchEvidence: { status: 'sufficient', coverage: [{ sourceId: 'r1', status: 'complete',
        evidenceId: evidence.snapshot.evidenceId, contentHash: evidence.snapshot.contentHash,
        coveredChars: evidence.snapshot.content.length, totalChars: evidence.snapshot.content.length, eventIds: [evidence.bodyEventId] }],
      verifiedEventIds: [evidence.bodyEventId] },
      presentation: { source: 'host_research_reader', schemaVersion: 1, evidenceEventIds: [evidence.bodyEventId] },
    } });
    expect(fresh.metadata.researchDelivery.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fresh.metadata.presentation.reportMarkdown).toContain('72\\.6%');
    expect(fresh.metadata.presentation.reportMarkdown).toContain(evidence.snapshot.url);
    expect(fresh.metadata.presentation.researchBriefMarkdown).toContain('group scores');
    expect(fresh.metadata.presentation.researchBriefMarkdown).toContain('training latency');
    expect(fresh.metadata.presentation.evidenceMarkdown).toContain(evidence.bodyEventId.replaceAll('-', '\\-'));
    expect(fresh.metadata.presentation.evidenceMarkdown).toContain('sampled group scores');
    expect(fresh.metadata.presentation.researchBriefMarkdown.length).toBeLessThanOrEqual(64_000);
    expect(fresh.metadata.presentation.evidenceMarkdown.length).toBeLessThanOrEqual(64_000);
    const projectCompletion = (completion: { status: string; outputSummary: string; metadata: Record<string, unknown> }) =>
      buildWorkPresentation({ run: { id: 'run-1', status: completion.status, outputSummary: completion.outputSummary },
        events: [...events.map((event, index) => ({ id: `persisted-${index + 1}`, runId: 'run-1', seq: index + 1,
          createdAt: now, type: String(event.type), title: String(event.title), metadata: event.metadata as Record<string, unknown> })),
        { id: 'completion-event', runId: 'run-1', seq: events.length + 1, createdAt: now,
          type: `run_${completion.status}`, title: 'Persisted completion', body: completion.outputSummary,
          // The real completion service forwards these metadata unchanged;
          // its runtime research authority is the preceding verified receipt.
          metadata: completion.metadata }] });
    const freshPresentation = projectCompletion(fresh);
    expect(freshPresentation).toMatchObject({ status: 'completed', reportKind: 'grounded_research',
      researchBriefMarkdown: fresh.metadata.presentation.researchBriefMarkdown,
      evidenceMarkdown: fresh.metadata.presentation.evidenceMarkdown,
      reportMarkdown: fresh.metadata.presentation.reportMarkdown });
    expect(fresh.metadata.presentation.warnings.join(' ')).toContain('独立抽查');
    expect(fresh.outputSummary).not.toBe(evidence.result.output);
    expect(loadWebEvidenceMock).toHaveBeenCalledWith('workshop:workshop-1', evidence.snapshot.evidenceId, evidence.snapshot.url);
    expect(events.find(event => event.type === 'research_report_delivered')?.metadata).toMatchObject({
      receiptAuthority: 'runtime', canonicalHash: fresh.metadata.researchDelivery.canonicalHash,
    });

    executeWorkshopAgentMock.mockClear();
    planWorkshopDirectiveMock.mockClear();
    getOwnedWorkshopDirectiveMock.mockClear();
    completeWorkshopRunMock.mockClear();
    vi.mocked(readCapturedRunOutput).mockResolvedValueOnce({ result: evidence.result, directiveIds: [main.id] });
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({
      // This malformed later configuration cannot replace the loaded checkpoint.
      modelConfig: { researchEvidenceContract: { version: 'changed-after-execution' } },
    }), run: run({ triggerReason: trigger }), executionLease: lease });
    const captured = completeWorkshopRunMock.mock.calls.at(-1)![0];
    expect(captured).toMatchObject({ status: 'completed', directiveIds: [main.id], metadata: {
      presentation: fresh.metadata.presentation, researchDelivery: fresh.metadata.researchDelivery,
      researchEvidence: fresh.metadata.researchEvidence,
    } });
    expect(captured.metadata.researchDelivery.canonicalHash).toBe(fresh.metadata.researchDelivery.canonicalHash);
    expect(projectCompletion(captured)).toMatchObject({
      researchBriefMarkdown: freshPresentation?.researchBriefMarkdown,
      evidenceMarkdown: freshPresentation?.evidenceMarkdown,
      reportMarkdown: freshPresentation?.reportMarkdown });
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(planWorkshopDirectiveMock).not.toHaveBeenCalled();
    expect(getOwnedWorkshopDirectiveMock).not.toHaveBeenCalled();
    expect(writeBrainMemory).not.toHaveBeenCalled();
    expect(createBrainMemoryCandidate).not.toHaveBeenCalled();
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(scheduleWorkshopWakeupFromSuggestion).not.toHaveBeenCalled();
  });

  it('does not persist a model self-claimed host reading view without a verified host delivery', async () => {
    planWorkshopDirectiveMock.mockResolvedValue({ action: 'run_once', confidence: 1, reason: 'Test', model: 'fake' });
    executeWorkshopAgentMock.mockResolvedValue({ status: 'success', output: 'Ordinary result', toolCallCount: 0, durationMs: 1,
      structured: { presentation: { source: 'host_grounded_report', title: 'Ordinary report', summary: 'Ordinary summary',
        reportMarkdown: '# Ordinary report', researchBriefMarkdown: 'Forged reader view', evidenceMarkdown: 'Forged provenance' } } });
    await executeWithDirective();
    const completion = completeWorkshopRunMock.mock.calls.at(-1)![0];
    expect(completion.status).toBe('completed');
    expect(completion.metadata.presentation).toMatchObject({ source: 'agent_report', title: 'Ordinary report',
      summary: 'Ordinary summary', reportMarkdown: '# Ordinary report' });
    expect(completion.metadata.presentation.researchBriefMarkdown).toBeUndefined();
    expect(completion.metadata.presentation.evidenceMarkdown).toBeUndefined();
    expect(completion.metadata.researchDelivery).toBeUndefined();
  });

  it.each([
    [false, 'fake-quote', '短摘未完整'], [true, 'fake-quote', '短摘未完整'],
    [false, 'wrong-number', '64.6%'], [true, 'wrong-number', '64.6%'],
    [false, 'missing-snapshot', '快照缺失'], [true, 'missing-snapshot', '快照缺失'],
    [false, 'stale-snapshot', '身份校验失败'], [true, 'stale-snapshot', '身份校验失败'],
    [false, 'competing-actions', '单一 researchEvidence'], [true, 'competing-actions', '单一 researchEvidence'],
  ])("delivers a readable report with unverified evidence and %s/%s without activating output actions", async (captured, failure, readableIssue) => {
    const evidence = groundedResearchFixture();
    const main = directive({ content: 'Focus on DeepSeek' });
    const trigger = { type: 'directive', directiveId: main.id, content: main.content };
    const lease = { userId: 'user-1', workshopId: 'workshop-1', runId: 'run-1', workerId: 'worker', token: 1 };
    if (failure === 'fake-quote') evidence.researchEvidence.works[0].supportedClaims[0].quote =
      'This invented passage was never present in the saved original paper body or any of its observed windows.';
    if (failure === 'wrong-number') evidence.researchEvidence.works[0].supportedClaims[1].claim =
      'Model-Qwen-32B 在 AIME 2024 得分 64.6%。';
    if (failure === 'competing-actions') evidence.result.structured = { ...evidence.result.structured,
      memoryCandidates: [{ content: 'Must not activate', sourceEventIds: [evidence.bodyEventId] }],
      outboxDrafts: [{ message: 'Must not send', notifyReason: 'decision_required', whyNow: 'Must not deliver this now' }],
      nextWakeupSuggestion: { delayMinutes: 30, reason: 'Must not schedule' } };
    loadWebEvidenceMock.mockResolvedValue({ directory: 'owned-snapshot', snapshot: evidence.snapshot });
    if (failure === 'missing-snapshot') loadWebEvidenceMock.mockRejectedValue(new Error('ENOENT'));
    if (failure === 'stale-snapshot') loadWebEvidenceMock.mockResolvedValue({ directory: 'owned-snapshot',
      snapshot: { ...evidence.snapshot, evidenceId: 'snapshot-of-earlier-run' } });
    vi.mocked(listWorkshopEvents).mockImplementation(async (_workshopId, options) =>
      options?.runId ? [evidence.receipt] as unknown as WorkshopEvent[] : []);
    listActiveDirectivesMock.mockResolvedValue([main]);
    planWorkshopDirectiveMock.mockResolvedValue({ action: 'run_once', confidence: 1, reason: 'Test', model: 'fake' });
    executeWorkshopAgentMock.mockResolvedValue(evidence.result);
    if (captured) vi.mocked(readCapturedRunOutput).mockResolvedValueOnce({ result: evidence.result, directiveIds: [main.id] });
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({ modelConfig: captured
      ? { researchEvidenceContract: { version: 'changed-after-execution' } } : evidence.config }),
      run: run({ triggerReason: trigger }), executionLease: lease });
    const completed = completeWorkshopRunMock.mock.calls.at(-1)![0];
    expect(completed).toMatchObject({ status: 'completed', directiveIds: [main.id], metadata: {
      researchDelivery: { version: 'reader-report/v1', status: 'delivered', verificationStatus: 'unverified',
        semanticStatus: 'not_independently_verified' }, researchEvidence: { status: 'evidence_insufficient',
        coverage: [{ sourceId: 'r1', status: 'complete', coveredChars: evidence.snapshot.content.length }] },
      presentation: { source: 'host_research_reader', evidenceEventIds: [evidence.bodyEventId] },
    } });
    expect(completed.error).toBeNull();
    expect(completed.metadata.researchDelivery.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.metadata.researchDelivery.issues.join(' ')).toContain(readableIssue);
    expect(completed.metadata.presentation.researchBriefMarkdown).toContain('group scores');
    expect(completed.metadata.presentation.evidenceMarkdown.replaceAll('\\', '')).toContain(readableIssue);
    expect(events.some(event => event.type === 'directive_consumed' || event.type === 'research_report_verified')).toBe(false);
    expect(events.some(event => event.type === 'research_report_delivered')).toBe(true);
    expect(events.some(event => event.type === 'research_evidence_insufficient')).toBe(true);
    expect(writeBrainMemory).not.toHaveBeenCalled();
    expect(createBrainMemoryCandidate).not.toHaveBeenCalled();
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(scheduleWorkshopWakeupFromSuggestion).not.toHaveBeenCalled();
    if (captured) expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("delivers committed Markdown with reading gaps independently preserved (captured=%s)", async captured => {
    const evidence = groundedResearchFixture();
    const main = directive({ content: 'Focus on DeepSeek' });
    const trigger = { type: 'directive', directiveId: main.id, content: main.content };
    const lease = { userId: 'user-1', workshopId: 'workshop-1', runId: 'run-1', workerId: 'worker', token: 1 };
    const markdown = '# Research reading guide\n\nThe useful question is how the reward signal changes the training objective.\n\n## Main observations\n\nGroup scores provide a comparison within a sampled set. This is an interpretation and should be checked against the original paper.\n\n## Reading next\n\nRead the method description first, then inspect the evaluation setup before treating scores as comparable.';
    const authored: WorkshopExecutionResult = { status: 'success', output: markdown, structured: null,
      toolCallCount: 1, durationMs: 10, researchEvidenceContext: { modelConfig: evidence.config, taskText: main.content } };
    listActiveDirectivesMock.mockResolvedValue([main]);
    planWorkshopDirectiveMock.mockResolvedValue({ action: 'run_once', confidence: 1, reason: 'Test', model: 'fake' });
    executeWorkshopAgentMock.mockResolvedValue(authored);
    if (captured) vi.mocked(readCapturedRunOutput).mockResolvedValueOnce({ result: authored, directiveIds: [main.id] });
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({ modelConfig: evidence.config }),
      run: run({ triggerReason: trigger }), executionLease: lease });
    const completed = completeWorkshopRunMock.mock.calls.at(-1)![0];
    expect(completed).toMatchObject({ status: 'completed', error: null, metadata: {
      researchDelivery: { version: 'reader-report/v1', status: 'delivered', verificationStatus: 'unverified' },
      researchEvidence: { status: 'evidence_insufficient', coverage: [{ sourceId: 'r1', status: 'incomplete', coveredChars: 0 }] },
      presentation: { source: 'host_research_reader', researchBriefMarkdown: markdown },
    } });
    expect(completed.metadata.researchDelivery.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.metadata.presentation.evidenceMarkdown).toContain('0/');
    expect(events.find(event => event.type === 'research_report_delivered')?.metadata).toMatchObject({
      receiptAuthority: 'runtime', verificationStatus: 'unverified', canonicalHash: completed.metadata.researchDelivery.canonicalHash });
    expect(events.some(event => event.type === 'research_report_verified')).toBe(false);
    expect(loadWebEvidenceMock).not.toHaveBeenCalled();
    expect(writeBrainMemory).not.toHaveBeenCalled();
    expect(createBrainMemoryCandidate).not.toHaveBeenCalled();
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(scheduleWorkshopWakeupFromSuggestion).not.toHaveBeenCalled();
    if (captured) expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
  });

  it("keeps a missing research report failed and does not treat requested output actions as a deliverable", async () => {
    const evidence = groundedResearchFixture();
    const main = directive({ content: 'Focus on DeepSeek' });
    const trigger = { type: 'directive', directiveId: main.id, content: main.content };
    listActiveDirectivesMock.mockResolvedValue([main]);
    planWorkshopDirectiveMock.mockResolvedValue({ action: 'run_once', confidence: 1, reason: 'Test', model: 'fake' });
    executeWorkshopAgentMock.mockResolvedValue({ status: 'success', output: '', toolCallCount: 0, durationMs: 10,
      researchEvidenceContext: { modelConfig: evidence.config, taskText: main.content }, structured: {
        memoryCandidates: [{ content: 'Do not activate this memory', sourceEventIds: [evidence.bodyEventId] }],
        outboxDrafts: [{ message: 'Do not send this', notifyReason: 'decision_required', whyNow: 'Now' }],
        nextWakeupSuggestion: { delayMinutes: 30, reason: 'Do not schedule' },
      } });
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({ modelConfig: evidence.config }),
      run: run({ triggerReason: trigger }) });
    const completed = completeWorkshopRunMock.mock.calls.at(-1)![0];
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('本轮未形成可交付报告');
    expect(completed.metadata.failureReason).toBe('research_report_missing');
    expect(completed.metadata.researchDelivery).toMatchObject({ version: 'reader-report/v1', status: 'rejected', canonicalHash: null });
    expect(events.some(event => event.type === 'research_report_delivered')).toBe(false);
    expect(writeBrainMemory).not.toHaveBeenCalled();
    expect(createBrainMemoryCandidate).not.toHaveBeenCalled();
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(scheduleWorkshopWakeupFromSuggestion).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects insufficient research before output actions (captured=%s)", async captured => {
    const config = { researchEvidenceContract: { version: 'primary-reading/v1', taskKeywords: ['deepseek'],
      requiredPrimarySources: [{ id: 'r1', label: 'R1', urls: ['https://arxiv.org/html/2501.12948v1'] }] } };
    const result = { status: 'success' as const, output: 'Partial overview', toolCallCount: 8, durationMs: 100,
      researchEvidenceContext: { modelConfig: config, taskText: 'Focus on DeepSeek' },
      structured: { presentation: { reportMarkdown: 'Partial report retained' },
        memoryCandidates: [{ content: 'Must not apply', sourceEventIds: ['secondary'] }],
        outboxDrafts: [{ message: 'Must not send', notifyReason: 'decision_required', whyNow: 'Now' }],
        nextWakeupSuggestion: { reason: 'Must not schedule' } } };
    if (captured) vi.mocked(readCapturedRunOutput).mockResolvedValueOnce({ result, directiveIds: ['directive-1'] });
    executeWorkshopAgentMock.mockResolvedValueOnce(result);
    planWorkshopDirectiveMock.mockResolvedValue({ action: 'run_once', confidence: 1, reason: 'Test', model: 'fake' });
    const main = directive({ content: 'Focus on DeepSeek' });
    listActiveDirectivesMock.mockResolvedValue([main]);
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({ modelConfig: config }),
      run: run({ triggerReason: { type: 'directive', directiveId: main.id, content: main.content } }),
      ...(captured ? { executionLease: { userId: 'user-1', workshopId: 'workshop-1', runId: 'run-1', workerId: 'worker', token: 1 } } : {}) });
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed',
      metadata: expect.objectContaining({ failureReason: 'research_evidence_insufficient',
        presentation: expect.objectContaining({ reportMarkdown: 'Partial report retained' }) }) }));
    expect(writeBrainMemory).not.toHaveBeenCalled();
    expect(createBrainMemoryCandidate).not.toHaveBeenCalled();
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(scheduleWorkshopWakeupFromSuggestion).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'research_evidence_insufficient')).toBe(true);
    if (captured) expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
  });

  it("uses the captured absent contract after later configuration changes", async () => {
    vi.mocked(readCapturedRunOutput).mockResolvedValueOnce({ result: { status: 'success', output: 'Saved result',
      structured: null, toolCallCount: 0, durationMs: 1, researchEvidenceContext: { modelConfig: {}, taskText: 'DeepSeek' } }, directiveIds: [] });
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({ modelConfig: { researchEvidenceContract: { invalid: true } } }),
      run: run(), executionLease: { userId: 'user-1', workshopId: 'workshop-1', runId: 'run-1', workerId: 'worker', token: 1 } });
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
  });

  it("cannot use the planner duplicate shortcut to complete a required reading task", async () => {
    const main = directive({ content: 'Focus on DeepSeek' });
    const modelConfig = { researchEvidenceContract: { version: 'primary-reading/v1', taskKeywords: ['deepseek'],
      requiredPrimarySources: [{ id: 'r1', label: 'R1', urls: ['https://arxiv.org/html/2501.12948v1'] }] } };
    listActiveDirectivesMock.mockResolvedValue([main]);
    planWorkshopDirectiveMock.mockResolvedValue({ action: 'ignore_duplicate', confidence: 1, reason: 'Seen before', model: 'fake' });
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({ modelConfig }),
      run: run({ triggerReason: { type: 'directive', directiveId: main.id, content: main.content } }) });
    expect(executeWorkshopAgentMock).toHaveBeenCalledTimes(1);
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed',
      metadata: expect.objectContaining({ failureReason: 'research_evidence_insufficient' }) }));
  });

  it("completes research only after matching host body coverage and report references", async () => {
    const config = { researchEvidenceContract: { version: 'primary-reading/v1', taskKeywords: ['deepseek'],
      requiredPrimarySources: [{ id: 'r1', label: 'R1', urls: ['https://arxiv.org/html/2501.12948v1'] }] } };
    const receipt = { id: 'body-event', runId: 'run-1', type: 'source_checked', metadata: { receiptAuthority: 'runtime',
      toolName: 'webReadPage', method: 'jina_defuddle', ok: true, url: 'https://arxiv.org/html/2501.12948v1',
      evidenceId: 'body', contentHash: 'a'.repeat(64), offset: 0, contentLength: 4000, totalChars: 4000, nextOffset: null, qualityScore: 80 } };
    vi.mocked(listWorkshopEvents).mockImplementation(async (_workshopId, options) =>
      options?.runId ? [receipt] as unknown as WorkshopEvent[] : []);
    executeWorkshopAgentMock.mockResolvedValue({ status: 'success', output: 'Research report', toolCallCount: 1, durationMs: 100,
      researchEvidenceContext: { modelConfig: config, taskText: 'Focus on DeepSeek' },
      structured: { researchEvidence: { works: [{ sourceId: 'r1', evidenceEventIds: ['body-event'],
        method: 'GRPO method', experiments: 'Original benchmark setup', limitations: 'Original limitations',
        locators: { method: '2.1', experiments: 'Table 1', limitations: '4' }, supportedClaims: [{ claim: 'Observed results', locator: 'Table 1' }] }], gaps: [] } } });
    planWorkshopDirectiveMock.mockResolvedValue({ action: 'run_once', confidence: 1, reason: 'Test', model: 'fake' });
    const main = directive({ content: 'Focus on DeepSeek' });
    listActiveDirectivesMock.mockResolvedValue([main]);
    await executeWorkshopRunLifecycle({ userId: 'user-1', workshop: workshop({ modelConfig: config }),
      run: run({ triggerReason: { type: 'directive', directiveId: main.id, content: main.content } }) });
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed',
      metadata: expect.objectContaining({ researchEvidence: expect.objectContaining({ status: 'sufficient', verifiedEventIds: ['body-event'] }) }) }));
  });

  it("reads the primary directive independently when it is older than fifty active requirements", async () => {
    const main = directive({ id: "older-main", content: "Required business task" });
    listActiveDirectivesMock.mockResolvedValue(Array.from({ length: 50 }, (_, index) => directive({
      id: `newer-${index}`, scope: "persistent", content: `Boundary ${index}`,
    })));
    getOwnedWorkshopDirectiveMock.mockResolvedValue(main);
    planWorkshopDirectiveMock.mockResolvedValue({ action: "run_once", confidence: 1, reason: "Exact task", model: "fake" });
    await executeWorkshopRunLifecycle({ userId: "user-1", workshop: workshop(),
      run: run({ triggerReason: { type: "directive", directiveId: main.id, content: main.content } }) });
    expect(getOwnedWorkshopDirectiveMock).toHaveBeenCalledWith({ userId: "user-1", workshopId: "workshop-1", directiveId: main.id });
    expect(planWorkshopDirectiveMock).toHaveBeenCalledWith(expect.objectContaining({ directive: main }));
    expect(executeWorkshopAgentMock.mock.calls[0][0].directives[0]).toEqual(main);
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", directiveIds: [main.id] }));
  });

  it("does not substitute another directive with the same text when the required ID is missing", async () => {
    listActiveDirectivesMock.mockResolvedValue([directive({ id: "other", content: "Same text" })]);
    getOwnedWorkshopDirectiveMock.mockResolvedValue(null);
    await executeWorkshopRunLifecycle({ userId: "user-1", workshop: workshop(),
      run: run({ triggerReason: { type: "directive", directiveId: "missing", content: "Same text" } }) });
    expect(planWorkshopDirectiveMock).not.toHaveBeenCalled();
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", directiveIds: [],
      metadata: expect.objectContaining({ failureReason: "primary_directive_unavailable" }) }));
  });

  it.each([
    ["inactive", { status: "consumed" }],
    ["foreign Work", { workshopId: "another-work" }],
    ["other run", { runId: "another-run" }],
    ["blank input", { content: " " }],
    ["changed input", { content: "Changed after admission" }],
    ["unknown scope", { scope: "unknown" }],
  ])("blocks a required directive with %s before any planner or executor call", async (_name, patch) => {
    getOwnedWorkshopDirectiveMock.mockResolvedValue(directive(patch as Partial<WorkshopDirective>));
    await executeWorkshopRunLifecycle({ userId: "user-1", workshop: workshop(),
      run: run({ triggerReason: { type: "directive", directiveId: "directive-1", content: directive().content } }) });
    expect(planWorkshopDirectiveMock).not.toHaveBeenCalled();
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", directiveIds: [],
      metadata: expect.objectContaining({ failureReason: "primary_directive_unavailable" }) }));
  });

  it("rejects a directive trigger without its stable ID rather than executing the mission", async () => {
    await executeWorkshopRunLifecycle({ userId: "user-1", workshop: workshop(), run: run({ triggerReason: { type: "directive" } }) });
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: "failed",
      metadata: expect.objectContaining({ failureReason: "primary_directive_id_required" }) }));
  });

  it("restores the captured primary input without replacing it from the recent directive list", async () => {
    listActiveDirectivesMock.mockResolvedValue([directive({ id: "newer", content: "Later task" })]);
    vi.mocked(readCapturedRunPlan).mockResolvedValueOnce({
      directive: { id: "captured-main", content: "Admitted task", scope: "current_run", priority: 0 },
      directiveIds: ["captured-main"],
      plan: { action: "run_once", confidence: 1, reason: "Saved plan", model: "fake" }, duplicateLoop: null,
    });
    await executeWorkshopRunLifecycle({ userId: "user-1", workshop: workshop(), run: run(),
      executionLease: { userId: "user-1", workshopId: "workshop-1", runId: "run-1", workerId: "worker", token: 1 } });
    expect(getOwnedWorkshopDirectiveMock).not.toHaveBeenCalled();
    expect(planWorkshopDirectiveMock).not.toHaveBeenCalled();
    expect(executeWorkshopAgentMock.mock.calls[0][0].directives[0]).toMatchObject({ id: "captured-main", content: "Admitted task" });
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", directiveIds: ["captured-main"] }));
  });

  it("finishes captured output without re-reading a now-missing primary directive or rerunning the model", async () => {
    vi.mocked(readCapturedRunOutput).mockResolvedValueOnce({ result: { status: "success", output: "Saved result",
      structured: null, toolCallCount: 0, durationMs: 1 }, directiveIds: ["captured-main"] });
    await executeWorkshopRunLifecycle({ userId: "user-1", workshop: workshop(),
      run: run({ triggerReason: { type: "directive", directiveId: "captured-main" } }),
      executionLease: { userId: "user-1", workshopId: "workshop-1", runId: "run-1", workerId: "worker", token: 1 } });
    expect(getOwnedWorkshopDirectiveMock).not.toHaveBeenCalled();
    expect(planWorkshopDirectiveMock).not.toHaveBeenCalled();
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", outputSummary: "Saved result" }));
  });

  it("uses the persisted directive trigger instead of a replacement conversation input", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({ action: "run_once", confidence: 1, reason: "Exact task", model: "fake" });
    await executeWorkshopRunLifecycle({ userId: "user-1", workshop: workshop(),
      run: run({ triggerReason: { type: "directive", directiveId: "directive-1", content: directive().content } }),
      triggerReason: { type: "conversation", content: "Replacement input", inputFiles: [], parentRunId: null } });
    expect(getOwnedWorkshopDirectiveMock).toHaveBeenCalled();
    expect(executeWorkshopAgentMock.mock.calls[0][0].conversation).toBeUndefined();
    expect(executeWorkshopAgentMock.mock.calls[0][0].directives[0].id).toBe("directive-1");
  });

  it("converts create_loop_task decisions into paused loop proposals", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "create_loop_task",
      confidence: 0.93,
      reason: "This is durable trading-day work.",
      taskIntent:
        "Every trading day before market open, generate a watchlist.",
      model: "planner-model",
    });

    await executeWithDirective();

    expect(proposeWorkshopLoopFromNaturalLanguageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workshopId: "workshop-1",
        runId: "run-1",
        intent:
          "Every trading day before market open, generate a watchlist.",
        proposedBy: "workshop_agent",
        proposalReason: "This is durable trading-day work.",
      }),
    );
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "directive_planned",
    ]);
  });

  it("skips create_loop_task proposals when a similar workshop loop already exists", async () => {
    listLoopsForWorkshopMock.mockResolvedValue([loop()]);
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "create_loop_task",
      confidence: 0.93,
      reason: "This is durable trading-day work.",
      taskIntent:
        "Every trading day before market open, generate a watchlist.",
      model: "planner-model",
    });

    await executeWithDirective();

    expect(proposeWorkshopLoopFromNaturalLanguageMock).not.toHaveBeenCalled();
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
        outputSummary: "Skipped duplicate task proposal: 盘前关注列表",
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "directive_planned",
      "directive_duplicate_ignored",
    ]);
  });

  it("passes run_once planning context into the full workshop agent", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "run_once",
      confidence: 0.86,
      reason: "This should be handled in the current run.",
      model: "planner-model",
    });

    await executeWithDirective();

    expect(executeWorkshopAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "directive_planned",
            metadata: expect.objectContaining({
              action: "run_once",
            }),
          }),
        ]),
      }),
    );
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'completed'}));
  });

  it("keeps old current-run directives out of a newly triggered run", async () => {
    const staleDirective = directive({
      id: "directive-old",
      content: "分析机器人ETF鹏华",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const currentDirective = directive({
      id: "directive-1",
      content: "分析汇川技术",
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
    });
    const persistentDirective = directive({
      id: "directive-persistent",
      content: "长期保持交易更激进，少观察，多执行。",
      scope: "persistent",
    });

    expect(
      selectDirectivesForWorkshopRun({
        directives: [staleDirective, currentDirective, persistentDirective],
        runId: "run-1",
        trigger: {
          directiveId: "directive-1",
          content: "分析汇川技术",
        },
      }).map((item) => item.content),
    ).toEqual(["分析汇川技术", "长期保持交易更激进，少观察，多执行。"]);

    listActiveDirectivesMock.mockResolvedValue([
      staleDirective,
      currentDirective,
      persistentDirective,
    ]);
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "run_once",
      confidence: 0.86,
      reason: "This should be handled in the current run.",
      model: "planner-model",
    });

    await executeWorkshopRunLifecycle({
      userId: "user-1",
      workshop: workshop(),
      run: run(),
      triggerReason: {
        type: "directive",
        directiveId: "directive-1",
        content: "分析汇川技术",
      },
    });

    expect(planWorkshopDirectiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directive: expect.objectContaining({ content: "分析汇川技术" }),
        activeDirectives: expect.arrayContaining([
          expect.objectContaining({ content: "分析汇川技术" }),
          expect.objectContaining({
            content: "长期保持交易更激进，少观察，多执行。",
          }),
        ]),
      }),
    );
    expect(executeWorkshopAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: [
          expect.objectContaining({ content: "分析汇川技术" }),
          expect.objectContaining({
            content: "长期保持交易更激进，少观察，多执行。",
          }),
        ],
      }),
    );
    expect(executeWorkshopAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: expect.not.arrayContaining([
          expect.objectContaining({ content: "分析机器人ETF鹏华" }),
        ]),
      }),
    );
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({
      workshopId: "workshop-1",
      runId: "run-1",
      directiveIds: ["directive-1"],
    }));
  });

  it("logs planned subtasks and passes them into the full workshop agent", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "spawn_subtask",
      confidence: 0.88,
      reason: "The directive needs decomposition.",
      subtasks: [
        {
          title: "Collect market catalysts",
          goal: "Find important catalysts before market open.",
        },
        {
          title: "Rank watchlist candidates",
          goal: "Prioritize symbols by conviction.",
        },
      ],
      model: "planner-model",
    });

    await executeWithDirective();

    expect(executeWorkshopAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "directive_planned" }),
          expect.objectContaining({
            type: "directive_subtasks_planned",
            body: "Collect market catalysts\nRank watchlist candidates",
          }),
        ]),
      }),
    );
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'completed'}));
  });

  it("turns clarification decisions into owner-visible outbox drafts", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "ask_clarification",
      confidence: 0.8,
      reason: "Recipient is missing.",
      clarificationQuestion: "要把关注列表发给谁？",
      model: "planner-model",
    });

    await executeWithDirective();

    expect(createOutboxDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        runId: "run-1",
        message: "要把关注列表发给谁？",
        status: "draft",
        confidence: 80,
        riskLevel: "low",
        boundaryResult: expect.objectContaining({
          status: "needs_owner_input",
          directiveId: "directive-1",
          plannerAction: "ask_clarification",
        }),
      }),
    );
    expect(proposeWorkshopLoopFromNaturalLanguageMock).not.toHaveBeenCalled();
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      "directive_planned",
      "directive_needs_clarification",
    ]);
  });

  it("falls back to the full workshop agent when planning fails", async () => {
    planWorkshopDirectiveMock.mockRejectedValue(new Error("planner unavailable"));

    await executeWithDirective();

    expect(executeWorkshopAgentMock).toHaveBeenCalledTimes(1);
    expect(proposeWorkshopLoopFromNaturalLanguageMock).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toContain(
      "directive_plan_failed",
    );
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'completed'}));
  });

  it('matches explicit directive identity and never borrows another run input',()=>{
    const selected=selectDirectivesForWorkshopRun({runId:'run-1',trigger:{directiveId:'wanted',content:'same'},directives:[
      directive({id:'wanted',content:'same'}),directive({id:'duplicate-text',content:'same'}),directive({id:'wanted',content:'same',runId:'another-run'}),
    ]});
    expect(selected.map(item=>item.id)).toEqual(['wanted']);
  });

  it('propagates the same capability through executor and completion',async()=>{
    listActiveDirectivesMock.mockResolvedValue([]);
    const lease={userId:'user-1',workshopId:'workshop-1',runId:'run-1',workerId:'worker',token:1};
    executeWorkshopAgentMock.mockImplementation(async input=>{
      expect(input.executionLease).toEqual(lease);
      expect(resolveExecutionLease()).toEqual(lease);
      return {status:'success',output:'ok',structured:null,toolCallCount:0,durationMs:1};
    });
    completeWorkshopRunMock.mockImplementation(async input=>{
      expect(input.lease).toEqual(lease);
      expect(resolveExecutionLease()).toEqual(lease);
    });
    await executeWorkshopRunLifecycle({userId:'user-1',workshop:workshop(),run:run(),executionLease:lease});
    expect(executeWorkshopAgentMock).toHaveBeenCalledOnce();
    expect(completeWorkshopRunMock).toHaveBeenCalledOnce();
    expect(resolveExecutionLease()).toBeUndefined();
  });

  it('rejects a mismatched capability before dispatch',async()=>{
    await expect(executeWorkshopRunLifecycle({userId:'user-1',workshop:workshop(),run:run(),executionLease:{userId:'other',workshopId:'workshop-1',runId:'run-1',workerId:'worker',token:1}})).rejects.toMatchObject({code:'invalid_lease'});
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).not.toHaveBeenCalled();
  });

  it('does not turn lease loss after model output into failed completion',async()=>{
    listActiveDirectivesMock.mockResolvedValue([]);
    const controller=new AbortController();
    executeWorkshopAgentMock.mockImplementation(async()=>{
      fenceMock.mockRejectedValue(new ExecutionLeaseError('lease_lost'));
      return {status:'success',output:'late',structured:{outboxDrafts:[{message:'late'}]},toolCallCount:0,durationMs:1};
    });
    await expect(executeWorkshopRunLifecycle({userId:'user-1',workshop:workshop(),run:run(),abortController:controller,executionLease:{userId:'user-1',workshopId:'workshop-1',runId:'run-1',workerId:'worker',token:1}})).rejects.toMatchObject({code:'lease_lost'});
    expect(controller.signal.aborted).toBe(true);
    expect(completeWorkshopRunMock).not.toHaveBeenCalled();
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(captureCompletedWorkshopRunEvidence).not.toHaveBeenCalled();
  });

  it('discards structured actions from an unsuccessful model result',async()=>{
    listActiveDirectivesMock.mockResolvedValue([]);
    executeWorkshopAgentMock.mockResolvedValue({status:'error',output:'partial',error:'failed',structured:{outboxDrafts:[{message:'must not send'}],nextWakeupSuggestion:{delayMinutes:30}},toolCallCount:1,durationMs:2});
    await executeWorkshopRunLifecycle({userId:'user-1',workshop:workshop(),run:run()});
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'failed',outputSummary:'partial',error:'failed'}));
  });

  it('reports failure to atomic completion without an independent completion event',async()=>{
    planWorkshopDirectiveMock.mockResolvedValue({action:'run_once',confidence:1,reason:'test'});
    executeWorkshopAgentMock.mockRejectedValue(new Error('executor failed'));
    await executeWithDirective();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'failed',error:'executor failed',directiveIds:['directive-1']}));
    expect(events.some(event=>event.type==='run_completed'||event.type==='run_failed')).toBe(false);
  });
});
