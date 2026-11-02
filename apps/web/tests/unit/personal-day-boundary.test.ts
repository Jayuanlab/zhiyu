import { describe, it, expect } from 'vitest';
import { assertDailyAutomationBoundary } from '@/lib/personal-day/boundary';
import { classifyLoopAction } from '@/lib/loops/approval';
const work = () =>
  ({
    status: 'active',
    autonomyLevel: 'draft',
    boundaryPolicy: {
      mode: 'draft',
      externalMessages: 'blocked',
      hardDeniedActions: ['personalDayAdopt', 'sendMessage', 'bash', 'delete'],
    },
    modelConfig: {
      role: 'personal_daily_planner',
      allowedTools: ['personalDayDraft'],
      disallowedTools: ['personalDayAdopt', 'bash'],
    },
  }) as any;
const loop = () =>
  ({
    actionPolicy: {
      allowed: ['personalDayDraft'],
      denied: ['personalDayAdopt'],
    },
    approvalPolicy: { defaultMode: 'allow', externalWrites: 'deny' },
  }) as any;
describe('personal daily automation capability boundary', () => {
  it('classifies exactly the bounded local draft operation', () => {
    expect(classifyLoopAction('personalDayDraft')).toBe('write_internal');
    expect(classifyLoopAction('personalDayDraftAnything')).not.toBe(
      'write_internal',
    );
  });
  it('allows a draft-only controller inside its explicit boundary', () =>
    expect(() => assertDailyAutomationBoundary(work(), loop())).not.toThrow());
  it.each(['personalDayDraft', '*', 'personalDay*'])(
    'denied %s overrides allowed',
    (name) => {
      const w = work();
      w.modelConfig.disallowedTools.push(name);
      expect(() => assertDailyAutomationBoundary(w, loop())).toThrow(
        'automation_boundary_denied',
      );
    },
  );
  it('does not perform an operation requiring human approval', () => {
    const l = loop();
    l.actionPolicy.requiresApproval = ['personalDayDraft'];
    expect(() => assertDailyAutomationBoundary(work(), l)).toThrow(
      'automation_boundary_denied',
    );
  });
  it('refuses another role or observe-only controller', () => {
    const w = work();
    w.modelConfig.role = 'trader';
    expect(() => assertDailyAutomationBoundary(w, loop())).toThrow();
    w.modelConfig.role = 'personal_daily_planner';
    w.boundaryPolicy.mode = 'observe';
    expect(() => assertDailyAutomationBoundary(w, loop())).toThrow();
  });
});
