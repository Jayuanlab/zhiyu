import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  attempt: 1, mode: 'full' as 'full' | 'summary_only',
  tasks: [] as Array<{ title: string; sourceEventIds: string[] }>,
  createTask: vi.fn(), fail: vi.fn(), generate: vi.fn(), save: vi.fn(),
}));
vi.mock('ai', async original => ({ ...await original<typeof import('ai')>(), generateText: fixture.generate }));
vi.mock('@/lib/ai', () => ({ getModelProvider: vi.fn() }));
vi.mock('@/lib/ai/user-llm-api-settings', () => ({ getUserLlmProviderConfig: vi.fn() }));
vi.mock('@/lib/interactions/service', () => ({
  getInteractionEventsByIds: async () => [{ id: 'event-a', content: 'Current source', platform: 'wechat', conversationId: 'conversation-a', conversationType: 'group' }],
  createInteractionTask: fixture.createTask,
  createInteractionNote: vi.fn(), createInteractionSummaryNoteFromEvents: vi.fn(), createInteractionBrainMemory: vi.fn(),
  promoteInteractionMemoryCandidates: async () => ({ updatedCount: 0 }),
}));
vi.mock('@/lib/interactions/processing-jobs', () => ({
  claimInteractionProcessingJob: async () => ({ id: 'saved-job', attempts: fixture.attempt, eventIds: ['event-a'], processingMode: fixture.mode }),
  beginInteractionProcessingWrites: async () => {}, assertInteractionProcessingWrites: async () => {},
  applyInteractionProcessingWrites: async (_attempt: unknown, work: () => Promise<unknown>) => work(),
  failInteractionProcessingJob: fixture.fail,
}));
vi.mock('@/lib/interactions/processing-plans', () => ({
  interactionPlanContext: async () => 'saved-context', saveInteractionProcessingPlan: fixture.save,
  readInteractionProcessingPlan: async () => ({ payload: { version: 1, mode: 'llm', contextHash: 'saved-context',
    processingMode: fixture.mode, model: 'saved-model', plan: { notes: [], tasks: fixture.tasks, memories: [] } } }),
}));
vi.mock('@/lib/interactions/scenarios', () => ({ buildInteractionScenarioSnapshots: () => [], createInteractionScenarioSnapshots: async () => [] }));
vi.mock('@/lib/interactions/graph', () => ({ indexInteractionAnalysisToGraph: vi.fn() }));
vi.mock('@/lib/knowledge-pipeline/source-policies', () => ({ listInteractionSourcePolicies: async () => [] }));

import { processInteractionEvents } from '@/lib/interactions/processor';

beforeEach(() => {
  vi.clearAllMocks(); fixture.attempt = 1; fixture.mode = 'full';
  fixture.tasks = [{ title: 'Unsupported source is skipped', sourceEventIds: ['foreign-event'] },
    { title: 'Valid candidate', sourceEventIds: ['foreign-event', 'event-a', 'event-a'] }];
  fixture.createTask.mockImplementation(async input => ({ ...input, id: 'created-task', status: 'candidate' }));
});
afterEach(() => vi.unstubAllEnvs());

describe('Interaction host uses extracted understanding', () => {
  it('binds the saved plan position to a stable task command across attempts while restricting its evidence', async () => {
    for (const attempt of [1, 2]) {
      fixture.attempt = attempt;
      const result = await processInteractionEvents({ userId: 'owner', eventIds: ['event-a'], processingJobId: 'saved-job' });
      expect(result.mode).toBe('llm'); expect(result.tasks).toHaveLength(1);
    }
    expect(fixture.createTask).toHaveBeenCalledTimes(2);
    for (const [input] of fixture.createTask.mock.calls) {
      expect(input).toMatchObject({ userId: 'owner', commandId: 'interaction-plan:saved-job:task:1',
        title: 'Valid candidate', sourceEventIds: ['event-a'], metadata: { processingJobId: 'saved-job' } });
      expect(input).not.toHaveProperty('status');
    }
    expect(fixture.generate).not.toHaveBeenCalled(); expect(fixture.fail).not.toHaveBeenCalled();
  });

  it('keeps summary-only policy from creating tasks even when the saved model plan proposes them', async () => {
    fixture.mode = 'summary_only';
    const result = await processInteractionEvents({ userId: 'owner', eventIds: ['event-a'], processingJobId: 'saved-job', processingMode: 'summary_only' });
    expect(result.mode).toBe('llm'); expect(result.tasks).toEqual([]);
    expect(fixture.createTask).not.toHaveBeenCalled(); expect(fixture.generate).not.toHaveBeenCalled();
  });
});
