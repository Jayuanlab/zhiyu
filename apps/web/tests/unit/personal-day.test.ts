import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('@/lib/personal-day/store', () => ({
  dayTransaction: vi.fn(),
  readDaySnapshot: vi.fn(),
  failDayCommand: vi.fn(),
}));
vi.mock('@/lib/ai/model-configuration', () => ({
  loadModelConfiguration: vi.fn(),
  completeConfiguredText: vi.fn(),
  modelConfigurationProvider: vi.fn(),
}));
import {
  generatePlan,
  validateItems,
  contextHash,
  planningInput,
  foodAllowed,
} from '@/lib/personal-day/planner';
import { applyDayCommand } from '@/lib/personal-day/service';
import {
  DEFAULT_PROFILE,
  emptyDay,
  commandSchema,
  businessDate,
  nextDate,
  type Snapshot,
  type DayItem,
  type Plan,
  type Command,
} from '@/lib/personal-day/contracts';
import { nutritionSummary } from '@/lib/personal-day/catalog';
import { healthAssessment } from '@/lib/personal-day/assessment';
const now = new Date('2026-11-03T10:00:00+08:00'),
  date = '2026-11-04';
let snapshot: Snapshot;
beforeEach(() => {
  snapshot = {
    revision: 2,
    account: {
      profile: {
        ...DEFAULT_PROFILE,
        cloudConsent: true,
        equipment: ['none', 'chair'],
      },
      foods: [],
    },
    days: {
      [date]: {
        ...emptyDay(date),
        context: {
          ...emptyDay(date).context,
          windows: [{ start: '07:00', end: '21:00' }],
          readiness: 'normal',
        },
      },
    },
    sources: [],
    observations: [],
    events: [],
  };
});
const request = <T extends Command['operation']>(
  operation: T,
  extra: any = {},
) =>
  ({
    operation,
    commandId: randomUUID(),
    expectedRevision: snapshot.revision,
    ...extra,
  }) as Extract<Command, { operation: T }>;
const item = (extra: Partial<DayItem> = {}): DayItem => ({
  id: randomUUID(),
  kind: 'personal',
  title: '个人事项',
  start: '18:00',
  end: '18:30',
  priority: 'optional',
  status: 'planned',
  instructions: [],
  ...extra,
});
const plan = (items: DayItem[]): Plan => ({
  id: randomUUID(),
  date,
  createdAt: now.toISOString(),
  basisRevision: 2,
  contextHash: contextHash(snapshot.days[date].context),
  origin: 'manual',
  reason: 'fixture',
  items,
  warnings: [],
  citations: [],
  changes: [],
});
const port = (response: any) =>
  vi.fn(async () => ({
    text: JSON.stringify(response),
    provider: { model: 'fixture', protocol: 'anthropic-messages' },
  }));
describe('personal day domain and bounded planning', () => {
  it('offers external meal alternatives for an explicit cook-to-outside replan', () => {
    snapshot.days[date].context.meals = 'cook';
    expect(
      planningInput(snapshot, date, 'temporary change', now).mealChoices.some(
        (r) => r.id === 'outside_dinner',
      ),
    ).toBe(true);
  });
  it('does not let a model replace a painful or unknown readiness observation', async () => {
    snapshot.days[date].context.readiness = 'pain';
    await expect(
      generatePlan(
        snapshot,
        date,
        'change',
        'pi',
        async () => ({
          text: JSON.stringify({
            summary: 'unsafe relaxation',
            items: [],
            citations: [],
            proposedContext: {
              ...snapshot.days[date].context,
              readiness: 'normal',
            },
          }),
          provider: { model: 'fixture', protocol: 'fixture' },
        }),
        undefined,
        now,
      ),
    ).rejects.toThrow('readiness_change_denied');
  });
  it('keeps missing individual nutrition fields unknown rather than zero', () => {
    const food = {
      id: randomUUID(),
      name: 'label',
      state: 'cooked' as const,
      allergens: [],
      kcal: 100,
      protein: null,
      carbs: null,
      fat: 0,
      source: 'verified fixture',
      basis: 'per100g' as const,
      verified: true,
    };
    expect(
      nutritionSummary(
        [
          item({
            kind: 'meal',
            ingredients: [
              { name: 'label', grams: 100, state: 'cooked', foodId: food.id },
            ],
          }),
        ],
        [food],
      ),
    ).toMatchObject({
      kcal: 100,
      protein: null,
      carbs: null,
      fat: 0,
      complete: false,
    });
  });
  it('applies measurement corrections while retaining immutable raw facts', () => {
    const observation = {
      id: randomUUID(),
      kind: 'weight' as const,
      at: now.toISOString(),
      value: 65,
      unit: 'kg',
      note: 'raw',
      date: businessDate(now),
      source: 'user' as const,
    };
    snapshot.observations = [
      observation,
      {
        ...observation,
        id: randomUUID(),
        kind: 'correction',
        at: new Date(now.getTime() + 1).toISOString(),
        value: 64,
        corrects: observation.id,
        note: 'correction',
      },
    ];
    expect(healthAssessment(snapshot).effectiveWeightKg).toBe(64);
    expect(observation.value).toBe(65);
  });
  it('does not attach default food or duration to a skipped meal', () => {
    const today = businessDate(now),
      meal = item({ kind: 'meal' });
    snapshot.days[today] = {
      ...emptyDay(today),
      active: { ...plan([meal]), date: today },
    };
    const result = applyDayCommand(
      snapshot,
      request('record', {
        date: today,
        itemId: meal.id,
        status: 'skipped',
        note: 'no meal',
        minutes: 30,
        ingredients: [{ name: 'rice', grams: 100, state: 'cooked' }],
      }),
      now,
    );
    expect(result.days![today].active!.items[0].actual).not.toHaveProperty(
      'ingredients',
    );
    expect(result.days![today].active!.items[0].actual).not.toHaveProperty(
      'minutes',
    );
  });
  it('allows an audited correction of terminal execution, refuses a stale reference', () => {
    const today = businessDate(now),
      meal = item({
        kind: 'meal',
        status: 'completed',
        actual: { at: now.toISOString(), text: 'raw', minutes: 10 },
      });
    snapshot.days[today] = {
      ...emptyDay(today),
      active: { ...plan([meal]), date: today },
    };
    const cmd = request('record_correct', {
      date: today,
      itemId: meal.id,
      previousAt: now.toISOString(),
      status: 'completed',
      note: 'corrected duration',
      minutes: 15,
    });
    const result = applyDayCommand(snapshot, cmd, now);
    expect(result.days![today].active!.items[0].actual!.minutes).toBe(15);
    expect((result.event!.payload as any).before.actual.minutes).toBe(10);
    expect(meal.actual!.minutes).toBe(10);
    expect(() =>
      applyDayCommand(
        snapshot,
        { ...cmd, previousAt: '2020-01-01T00:00:00Z' },
        now,
      ),
    ).toThrow('execution_fact_changed');
  });
  it('creates a feasible catalogue draft with reproducible provenance and no model calls', async () => {
    const model = port({});
    const draft = await generatePlan(
      snapshot,
      date,
      '安排明天',
      'catalog',
      model,
      undefined,
      now,
    );
    expect(draft.origin).toBe('catalog');
    expect(draft.items.some((i) => i.kind === 'meal')).toBe(true);
    expect(draft.items.some((i) => i.kind === 'exercise')).toBe(true);
    validateItems(
      draft.items,
      snapshot.days[date].context,
      snapshot.account.profile!,
      [],
      now,
    );
    expect(model).not.toHaveBeenCalled();
    expect(draft.basisRevision).toBe(3);
  });
  it('does not invent free time', async () => {
    snapshot.days[date].context.windows = [];
    const draft = await generatePlan(
      snapshot,
      date,
      '未知时间',
      'catalog',
      undefined,
      undefined,
      now,
    );
    expect(draft.items).toEqual([]);
    expect(draft.warnings.join()).toContain('未替你编造');
  });
  it('requires cloud consent before dispatching health data', async () => {
    snapshot.account.profile!.cloudConsent = false;
    const model = port({});
    await expect(
      generatePlan(snapshot, date, '安排', 'pi', model, undefined, now),
    ).rejects.toThrow('health_cloud_consent_required');
    expect(model).not.toHaveBeenCalled();
  });
  it('rejects arbitrary model-authored tools, catalogues and citations', async () => {
    await expect(
      generatePlan(
        snapshot,
        date,
        '安排',
        'pi',
        port({
          summary: 'ok',
          items: [],
          citations: [],
          tools: ['sendMessage'],
        }),
        undefined,
        now,
      ),
    ).rejects.toThrow('planner_response_invalid');
    await expect(
      generatePlan(
        snapshot,
        date,
        '安排',
        'pi',
        port({
          summary: 'ok',
          items: [
            { kind: 'exercise', catalogId: 'dangerous-lift', start: '18:00' },
          ],
          citations: [],
        }),
        undefined,
        now,
      ),
    ).rejects.toThrow('exercise_restricted');
    await expect(
      generatePlan(
        snapshot,
        date,
        '安排',
        'pi',
        port({ summary: 'ok', items: [], citations: ['foreign-private-book'] }),
        undefined,
        now,
      ),
    ).rejects.toThrow('planner_citation_denied');
  });
  it('rejects overlapping output and preserves fixed commitments', async () => {
    const fixed = {
      id: randomUUID(),
      title: '私密会议主题',
      start: '18:00',
      end: '19:00',
    };
    snapshot.days[date].context.fixed = [fixed];
    await expect(
      generatePlan(
        snapshot,
        date,
        '安排',
        'pi',
        port({
          summary: 'ok',
          items: [
            { kind: 'exercise', catalogId: 'walk_short', start: '18:00' },
          ],
          citations: [],
        }),
        undefined,
        now,
      ),
    ).rejects.toThrow('plan_constraint_conflict');
    expect(
      JSON.stringify(planningInput(snapshot, date, '安排', now).context.fixed),
    ).not.toContain('私密');
  });
  it('will not enlarge availability or remove a fixed commitment', async () => {
    const context = snapshot.days[date].context;
    await expect(
      generatePlan(
        snapshot,
        date,
        '改动',
        'pi',
        port({
          summary: 'ok',
          items: [],
          citations: [],
          proposedContext: {
            ...context,
            windows: [{ start: '06:00', end: '22:00' }],
          },
        }),
        undefined,
        now,
      ),
    ).rejects.toThrow('availability_expansion_denied');
    context.fixed = [
      { id: randomUUID(), title: '事项', start: '18:00', end: '19:00' },
    ];
    await expect(
      generatePlan(
        snapshot,
        date,
        '改动',
        'pi',
        port({
          summary: 'ok',
          items: [],
          citations: [],
          proposedContext: { ...context, fixed: [] },
        }),
        undefined,
        now,
      ),
    ).rejects.toThrow('fixed_item_locked');
  });
  it('keeps completed, partial and in-progress facts during a replan', async () => {
    const done = item({
        status: 'completed',
        start: '07:00',
        end: '07:30',
        actual: { at: now.toISOString(), text: '实际完成' },
      }),
      partial = item({ status: 'partial', start: '08:00', end: '08:30' }),
      running = item({ status: 'in_progress', start: '09:00', end: '09:30' });
    snapshot.days[date].active = plan([done, partial, running]);
    const draft = await generatePlan(
      snapshot,
      date,
      '变化',
      'pi',
      port({ summary: '已保留事实', items: [], citations: [] }),
      undefined,
      now,
    );
    expect(draft.items).toEqual([done, partial, running]);
  });
  it('preserves feasible future items rather than rewriting everything', async () => {
    const existing = item();
    snapshot.days[date].active = plan([existing]);
    const draft = await generatePlan(
      snapshot,
      date,
      '加班',
      'pi',
      port({ summary: '保留', items: [], citations: [] }),
      undefined,
      now,
    );
    expect(draft.items).toEqual([existing]);
  });
  it('never treats an unrecorded past slot as failed or completed', async () => {
    const today = businessDate(now),
      past = item({ start: '08:00', end: '08:30' });
    snapshot.days[today] = {
      ...snapshot.days[date],
      context: { ...snapshot.days[date].context, date: today },
      active: { ...plan([past]), date: today },
    };
    const draft = await generatePlan(
      snapshot,
      today,
      '重排',
      'pi',
      port({ summary: '保留待确认', items: [], citations: [] }),
      undefined,
      now,
    );
    expect(draft.items[0].status).toBe('planned');
  });
  it('enforces allergies and blocks unknown outside meal ingredients', () => {
    snapshot.account.profile!.allergies = ['egg'];
    expect(foodAllowed(['鸡蛋'], snapshot.account.profile!)).toBe(false);
    expect(foodAllowed(['成分待核对'], snapshot.account.profile!)).toBe(false);
  });
  it('does not schedule training under explicit restrictions or pain', async () => {
    snapshot.account.profile!.restrictions = '专业人员要求暂停训练';
    const draft = await generatePlan(
      snapshot,
      date,
      '安排',
      'catalog',
      undefined,
      undefined,
      now,
    );
    expect(draft.items.some((i) => i.kind === 'exercise')).toBe(false);
  });
  it('rejects stale adoption after any fact mutation', () => {
    snapshot.days[date].draft = plan([]);
    snapshot.revision = 3;
    expect(() =>
      applyDayCommand(
        snapshot,
        request('adopt', { date, planId: snapshot.days[date].draft!.id }),
        now,
      ),
    ).toThrow('draft_stale');
  });
  it('adopts only an exact reviewed draft and writes the previous plan into the event', () => {
    const draft = plan([item()]);
    snapshot.days[date].draft = draft;
    const result = applyDayCommand(
      snapshot,
      request('adopt', { date, planId: draft.id }),
      now,
    );
    expect(result.days![date].active!.id).toBe(draft.id);
    expect((result.event!.payload as any).after.id).toBe(draft.id);
    expect(result.days![date].draft).toBe(null);
  });
  it('does not allow future execution to masquerade as facts', () => {
    const entry = item();
    snapshot.days[date].active = plan([entry]);
    expect(() =>
      applyDayCommand(
        snapshot,
        request('record', {
          date,
          itemId: entry.id,
          status: 'completed',
          note: '',
        }),
        now,
      ),
    ).toThrow('future_execution_denied');
  });
  it('records actual completion separately from the original plan event', () => {
    const today = businessDate(now),
      entry = item({ start: '09:00', end: '09:30' });
    snapshot.days[today] = {
      ...snapshot.days[date],
      active: { ...plan([entry]), date: today },
      context: { ...snapshot.days[date].context, date: today },
    };
    const result = applyDayCommand(
      snapshot,
      request('record', {
        date: today,
        itemId: entry.id,
        status: 'partial',
        note: '只做了一部分',
        minutes: 10,
      }),
      now,
    );
    expect(result.event?.kind).toBe('execution');
    expect((result.event!.payload as any).before.status).toBe('planned');
    expect(result.days![today].active!.items[0].status).toBe('partial');
    expect(snapshot.days[today].active!.items[0].status).toBe('planned');
  });
  it('defers only eligible unfinished items into a candidate pool, atomically affecting both days', () => {
    const today = businessDate(now),
      entry = item();
    snapshot.days[today] = {
      ...snapshot.days[date],
      active: { ...plan([entry]), date: today },
      context: { ...snapshot.days[date].context, date: today },
    };
    const result = applyDayCommand(
      snapshot,
      request('defer', {
        date: today,
        target: date,
        itemId: entry.id,
        reason: '今晚忙',
      }),
      now,
    );
    expect(result.days![date].deferred[0].title).toBe(entry.title);
    expect(result.days![date].active).toBeNull();
    expect(result.days![today].active!.items[0].status).toBe('canceled');
  });
  it('does not turn meals into next-day debt', () => {
    const entry = item({ kind: 'meal' });
    snapshot.days[date].active = plan([entry]);
    expect(() =>
      applyDayCommand(
        snapshot,
        request('defer', {
          date,
          target: nextDate(date),
          itemId: entry.id,
          reason: '补吃',
        }),
        now,
      ),
    ).toThrow('item_cannot_defer');
  });
  it('keeps numeric nutrition unknown until data and weight state are verified', () => {
    const meal = item({
      kind: 'meal',
      ingredients: [{ name: '米饭', grams: 200, state: 'cooked' }],
    });
    expect(nutritionSummary([meal], []).complete).toBe(false);
    const food = {
      id: randomUUID(),
      name: '米饭',
      state: 'cooked' as const,
      allergens: [],
      kcal: 130,
      protein: 2,
      carbs: 28,
      fat: 0.3,
      source: 'synthetic-label-fixture',
      basis: 'per100g' as const,
      verified: true,
    };
    meal.ingredients![0].foodId = food.id;
    expect(nutritionSummary([meal], [food])).toMatchObject({
      complete: true,
      kcal: 260,
      protein: 4,
    });
    expect(nutritionSummary([meal], [{ ...food, state: 'raw' }]).known).toBe(0);
  });
  it('pauses adoption without preventing actual records', () => {
    snapshot.days[date].paused = true;
    snapshot.days[date].draft = plan([]);
    expect(() =>
      applyDayCommand(
        snapshot,
        request('adopt', { date, planId: snapshot.days[date].draft!.id }),
        now,
      ),
    ).toThrow('day_paused');
  });
  it('rejects owner forgery and invalid calendar dates at the command boundary', () => {
    expect(
      commandSchema.safeParse({
        ...request('pause', { date, paused: true }),
        ownerId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse(
        request('pause', { date: '2026-02-30', paused: true }),
      ).success,
    ).toBe(false);
  });
  it('requires a source review before imported text can be used', () => {
    snapshot.sources = [
      {
        id: randomUUID(),
        name: 'book',
        hash: 'a'.repeat(64),
        format: '.md',
        text: '原文',
        status: 'review',
        principles: [],
        createdAt: now.toISOString(),
        warnings: [],
      },
    ];
    snapshot.account.profile!.sourceConsent = true;
    expect(planningInput(snapshot, date, '安排', now).principles).toEqual([]);
    const result = applyDayCommand(
      snapshot,
      request('source_review', {
        sourceId: snapshot.sources[0].id,
        approved: true,
        principles: ['第1段：原则和条件'],
      }),
      now,
    );
    snapshot.sources = result.sources!;
    expect(planningInput(snapshot, date, '安排', now).principles).toHaveLength(
      1,
    );
  });
});
