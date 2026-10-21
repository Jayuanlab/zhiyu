import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLoopContextProfile } from '@/lib/ai/context-profile';

afterEach(() => vi.unstubAllEnvs());
const loop = { contextConfig: {}, triggerConfig: { type: 'cron' } };
const researcher = { modelConfig: { role: 'agent_frontier_researcher', researchReportStyle: 'freeform_project_value' } };
describe('research Loop context defaults', () => {
  it('reserves full context for source research instead of the scheduled polling default', () => {
    expect(resolveLoopContextProfile(loop as any, researcher)).toBe('full');
  });
  it('keeps the cheap scheduled default for ordinary controllers', () => {
    expect(resolveLoopContextProfile(loop as any, { modelConfig: {} })).toBe('cheap');
  });
  it('honors explicit Loop, Work and environment budgets before role defaults', () => {
    vi.stubEnv('LOOP_CONTEXT_PROFILE', 'audit');
    expect(resolveLoopContextProfile(loop as any, researcher)).toBe('audit');
    const work = { modelConfig: { ...researcher.modelConfig, loopContextProfile: 'normal' } };
    expect(resolveLoopContextProfile(loop as any, work)).toBe('normal');
    expect(resolveLoopContextProfile({ ...loop, contextConfig: { contextProfile: 'cheap' } } as any, work)).toBe('cheap');
  });
});
