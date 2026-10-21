vi.mock("@/lib/memory/sources/host-context", () => ({ admitHostSourceRows: vi.fn(async () => undefined) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loop, Workshop, WorkshopDirective, WorkshopEvent } from '@/lib/db/schema';
import { buildBrainContextPack } from '@/lib/brain/context';
import type { BrainMemoryRequest } from '@/lib/brain/recall-planner';
import { prepareLoopContextWindow } from '@/lib/loops/context-window';
import { parseLoopSpec } from '@/lib/loops/spec';

const fixture = vi.hoisted(() => ({
  workshop: null as Workshop | null,
  directives: [] as WorkshopDirective[],
  events: [] as WorkshopEvent[],
  brainAvailable: true,
}));
vi.mock('@/lib/db/client', () => ({ db: {} }));
vi.mock('@/lib/workshops/service', () => ({
  getWorkshop: vi.fn(async () => fixture.workshop),
  listWorkshopSources: vi.fn(async () => []),
  listWorkshopMemories: vi.fn(async () => []),
  listActiveDirectives: vi.fn(async () => fixture.directives),
  listWorkshopEvents: vi.fn(async () => fixture.events),
  appendWorkshopEvent: vi.fn(),
}));
vi.mock('@/lib/workshops/boundary-policy', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/workshops/boundary-policy')>(),
  workshopBoundaryToLoopPolicies: () => ({ actionPolicy: { allowed: ['read'], denied: [], requiresApproval: [] },
    approvalPolicy: { externalWrites: 'require_approval' }, metadata: {} }),
}));
vi.mock('@/lib/memory/retrieval/recall', () => ({ buildBrainContextFromMemoryRequest: vi.fn(async (request: BrainMemoryRequest) => {
  if (!fixture.brainAvailable) throw Error('Scoped Brain unavailable');
  return { ...buildBrainContextPack({ requester: request.requester, taskIntent: request.taskIntent, memories: [] }),
    recallPlan: { mode: 'fallback_rules', routes: [], warnings: [] }, explanation: {}, routeResults: [] };
}) }));

import { buildNativeLoopPrompt, loadWorkshopContextForLoop } from '@/lib/loops/native-executor';
import { listWorkshopEvents } from '@/lib/workshops/service';

const now = new Date('2026-10-18T00:00:00Z');
const loopSpec = parseLoopSpec({ goal: 'CURRENT_LOOP_GOAL',
  trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' }, context: { sources: [] },
  actions: { allowed: ['read'], requiresApproval: [], denied: [] }, verification: { type: 'structured_check' } });
const loop: Loop = { id: 'loop-fixture', userId: 'owner', workshopId: 'work-fixture', name: 'Project beta review',
  goal: 'CURRENT_LOOP_GOAL', actionPolicy: loopSpec.actions, approvalPolicy: loopSpec.approval,
  contextConfig: loopSpec.context, triggerConfig: loopSpec.trigger, status: 'active', description: null,
  retryPolicy: {}, verificationConfig: loopSpec.verification, escalationPolicy: {}, createdAt: now, updatedAt: now };

beforeEach(() => {
  vi.clearAllMocks();
  fixture.brainAvailable = true;
  fixture.workshop = { id: 'work-fixture', userId: 'owner', name: 'Fixture Work', mission: 'Review current evidence',
    status: 'active', autonomyLevel: 'draft', boundaryPolicy: {}, modelConfig: {}, createdAt: now, updatedAt: now } as Workshop;
  fixture.directives = [{ id: 'owner-directive', workshopId: 'work-fixture', runId: null, content: 'PERSISTENT_OWNER_DIRECTIVE',
    priority: 1, scope: 'persistent', status: 'active', createdAt: now } as WorkshopDirective];
  fixture.events = [{ id: 'project-alpha-event', workshopId: 'work-fixture', runId: 'old-alpha-run', loopId: null, loopRunId: null,
    seq: 1, type: 'source_checked', title: 'Historical source', body: 'PROJECT_ALPHA_PRIVATE_AMBIENT_BODY', metadata: {},
    visibility: 'user', createdAt: now } as WorkshopEvent];
});

describe('Loop automatic ambient event applicability', () => {
  it.each([
    { bound: true, brainAvailable: true }, { bound: true, brainAvailable: false },
    { bound: false, brainAvailable: true }, { bound: false, brainAvailable: false },
  ])('scopes event bodies through the real loader and prompt: %j', async ({ bound, brainAvailable }) => {
    fixture.brainAvailable = brainAvailable;
    if (bound) fixture.workshop!.modelConfig = {
      memoryApplicability: { schemaVersion: 'memory-applicability.v1', scenarioKeys: ['project:beta'] },
    };
    const result = await loadWorkshopContextForLoop({ userId: 'owner', loop });
    const prompt = buildNativeLoopPrompt({ loop, loopSpec, contextWindow: prepareLoopContextWindow({ loopSpec, state: null }),
      workshopContext: result!.promptContext, sessionDir: 'D:/fixture', language: 'en', maxToolCalls: 10 });
    expect(prompt.includes('PROJECT_ALPHA_PRIVATE_AMBIENT_BODY')).toBe(!bound);
    expect(prompt.includes('ambient_event_applicability_unverified')).toBe(bound);
    expect(prompt).toContain('PERSISTENT_OWNER_DIRECTIVE');
    expect(prompt).toContain('CURRENT_LOOP_GOAL');
    expect(listWorkshopEvents).toHaveBeenCalledTimes(bound ? 0 : 1);
    expect(fixture.events[0].body).toBe('PROJECT_ALPHA_PRIVATE_AMBIENT_BODY');
  });
});
