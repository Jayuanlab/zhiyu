import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  buildMaintenanceWrite,
  maintenancePlanningDays,
  parseMaintenanceResponse,
  type MaintenanceResponse,
} from '@/lib/personal-day/maintenance-plan';
import {
  DEFAULT_PROFILE,
  emptyDay,
  type Snapshot,
} from '@/lib/personal-day/contracts';
const now = new Date('2026-11-03T10:00:00+08:00'),
  date = '2026-11-04';
function snapshot(): Snapshot {
  return {
    revision: 1,
    account: { profile: { ...DEFAULT_PROFILE, cloudConsent: true }, foods: [] },
    days: {},
    sources: [],
    observations: [],
    events: [],
  };
}
const response = (): MaintenanceResponse => ({
  summary: '已记录活动，明日使用弹性建议。',
  facts: [
    {
      kind: 'activity' as const,
      date: '2026-11-03',
      quote: '走了20分钟',
      minutes: 20,
    },
  ],
  contexts: [],
  plans: [
    {
      date,
      reason: '未确认精确时间，以弹性安排提供建议。',
      citations: [],
      items: [{ kind: 'exercise' as const, catalogId: 'walk_short' }],
    },
  ],
});
function write(extra: any = {}) {
  return buildMaintenanceWrite({
    snapshot: snapshot(),
    response: response(),
    text: '今天走了20分钟，午饭吃了牛肉面。',
    feedbackId: randomUUID(),
    knownFacts: [],
    publish: true,
    provider: { model: 'fixture', protocol: 'openai-completions' },
    now,
    ...extra,
  });
}
describe('personal day maintenance host', () => {
  it('saves sourced facts and publishes flexible recommendations without inventing actual intake', () => {
    const value = write();
    expect(value.facts[0].minutes).toBe(20);
    expect(value.days[date].active?.items[0]).toMatchObject({
      flexible: true,
      start: '',
      end: '',
      status: 'planned',
    });
    expect(value.days[date].active?.items[0].actual).toBeUndefined();
  });
  it('keeps unspecified meal amounts and duration unknown', () => {
    const r = response();
    r.facts = [
      { kind: 'meal', date: '2026-11-03', quote: '午饭吃了牛肉面' } as any,
    ];
    const value = write({ response: r });
    expect(value.facts[0]).not.toHaveProperty('value');
    expect(value.facts[0]).not.toHaveProperty('minutes');
  });
  it('refuses ungrounded quotes and invented numeric quantities', () => {
    let r = response();
    r.facts[0].quote = '跑步40分钟';
    expect(() => write({ response: r })).toThrow('feedback_quote_invalid');
    r = response();
    r.facts[0].minutes = 40;
    expect(() => write({ response: r })).toThrow('feedback_number_unsupported');
  });
  it('allows explicit corrections only to known facts of the same kind', () => {
    const old = randomUUID(),
      r = response();
    (r.facts[0] as any).corrects = old;
    expect(() => write({ response: r })).toThrow('correction_target_invalid');
    expect(
      write({ response: r, knownFacts: [{ id: old, kind: 'activity' }] })
        .facts[0].corrects,
    ).toBe(old);
  });
  it('does not allow future execution or health values outside bounds', () => {
    let r = response();
    r.facts[0].date = date;
    expect(() => write({ response: r })).toThrow('future_execution_denied');
    r = response();
    r.facts = [
      { kind: 'weight', date: '2026-11-03', quote: '20分钟', value: 2 } as any,
    ];
    expect(() => write({ response: r })).toThrow();
  });
  it('respects pain, allergies and source whitelist', () => {
    const s = snapshot();
    s.account.profile!.restrictions = '膝部不适';
    expect(() => write({ snapshot: s })).toThrow('exercise_restricted');
    const r = response();
    r.plans[0].citations = ['https://untrusted.invalid'];
    expect(() => write({ response: r })).toThrow('planner_citation_denied');
  });
  it('cannot invent a clock time without confirmed availability', () => {
    const r = response();
    (r.plans[0].items[0] as any).start = '07:00';
    expect(() => write({ response: r })).toThrow('plan_constraint_conflict');
  });
  it('can leave facts and ask one question without creating a plan', () => {
    const r = {
      ...response(),
      plans: [],
      question: '这顿饭是今天还是昨天吃的？',
    };
    const value = write({ response: r });
    expect(value.question).toBe(r.question);
    expect(Object.keys(value.days)).toHaveLength(0);
    expect(value.facts).toHaveLength(1);
  });
  it('draft mode leaves the active result unchanged', () => {
    const value = write({ publish: false });
    expect(value.days[date].active).toBeNull();
    expect(value.days[date].draft).toBeTruthy();
  });
  it('preserves locked historical items', () => {
    const s = snapshot();
    const day = emptyDay(date);
    day.active = {
      id: randomUUID(),
      date,
      createdAt: now.toISOString(),
      basisRevision: 0,
      contextHash: 'x',
      origin: 'manual',
      reason: 'fixed',
      warnings: [],
      citations: [],
      changes: [],
      items: [
        {
          id: randomUUID(),
          kind: 'personal',
          title: '已记录事项',
          start: '06:00',
          end: '07:00',
          status: 'completed',
          priority: 'required',
          instructions: [],
        },
      ],
    };
    s.days[date] = day;
    expect(write({ snapshot: s }).days[date].active?.items[0]).toEqual(
      day.active.items[0],
    );
  });
  it('rejects extra control fields and malformed model output', () => {
    expect(() =>
      parseMaintenanceResponse(
        '{"summary":"ok","facts":[],"contexts":[],"plans":[],"grantPermission":true}',
      ),
    ).toThrow('maintenance_response_invalid');
  });
});

describe('maintenance model privacy projection', () => {
  it('hides private fixed titles in context, active and draft plans while keeping the authoritative facts', () => {
    const s = snapshot(),
      day = emptyDay(date),
      id = randomUUID(),
      secret = 'PRIVATE FIXED TITLE';
    day.context.fixed = [{ id, title: secret, start: '08:00', end: '09:00' }];
    const plan = {
      id: randomUUID(),
      date,
      createdAt: now.toISOString(),
      basisRevision: 0,
      contextHash: 'x',
      origin: 'manual' as const,
      reason: 'manual',
      warnings: [],
      citations: [],
      changes: [{ itemId: id, before: secret, after: secret, reason: secret }],
      proposedContext: day.context,
      items: [
        {
          id,
          kind: 'fixed' as const,
          title: secret,
          start: '08:00',
          end: '09:00',
          priority: 'required' as const,
          status: 'planned' as const,
          instructions: [secret],
          note: secret,
          actual: { at: now.toISOString(), text: secret },
        },
      ],
    };
    day.active = plan;
    day.draft = structuredClone(plan);
    s.days[date] = day;
    const projected = maintenancePlanningDays(s, '2026-11-03');
    expect(JSON.stringify(projected)).not.toContain(secret);
    expect((projected[date] as any).context.fixed[0].start).toBe('08:00');
    expect(s.days[date].active?.items[0].title).toBe(secret);
  });
});
