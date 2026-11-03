import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DayError,
  businessDate,
  nextDate,
  emptyDay,
  dateSchema,
  timeSchema,
  windowSchema,
  type Snapshot,
  type DayState,
  type Observation,
} from './contracts';
import {
  itemFromChoice,
  validateItems,
  lockedItem,
  contextHash,
} from './planner';
import { CATALOG_CITATIONS } from './catalog';
const quote = z.string().trim().min(1).max(2000);
export const maintenanceResponseSchema = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    facts: z
      .array(
        z
          .object({
            kind: z.enum(['weight', 'sleep', 'activity', 'meal', 'readiness']),
            date: dateSchema,
            quote,
            value: z.number().optional(),
            minutes: z.number().min(0).max(1440).optional(),
            corrects: z.string().uuid().optional(),
          })
          .strict(),
      )
      .max(30),
    contexts: z
      .array(
        z
          .object({
            date: dateSchema,
            quote,
            windows: z.array(windowSchema).max(12).optional(),
            readiness: z
              .enum(['normal', 'tired', 'pain', 'unknown'])
              .optional(),
            location: z.enum(['home', 'gym', 'travel']).optional(),
            meals: z.enum(['cook', 'outside', 'mixed']).optional(),
          })
          .strict(),
      )
      .max(2),
    plans: z
      .array(
        z
          .object({
            date: dateSchema,
            reason: z.string().min(1).max(2000),
            citations: z.array(z.string().max(300)).max(12),
            items: z
              .array(
                z
                  .object({
                    kind: z.enum(['exercise', 'meal']),
                    catalogId: z.string().max(100),
                    start: timeSchema.optional(),
                  })
                  .strict(),
              )
              .max(8),
          })
          .strict(),
      )
      .max(2),
    question: z.string().trim().max(1000).optional(),
  })
  .strict();
export type MaintenanceResponse = z.infer<typeof maintenanceResponseSchema>;
export const maintenanceHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function maintenanceId(text: string) {
  const h = maintenanceHash(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function parseMaintenanceResponse(text: string) {
  try {
    return maintenanceResponseSchema.parse(
      JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')),
    );
  } catch {
    throw new DayError('maintenance_response_invalid', 502);
  }
}
/** The model proposes an interpretation. Host code alone may change state. */
export function buildMaintenanceWrite(input: {
  snapshot: Snapshot;
  response: MaintenanceResponse;
  text: string;
  feedbackId: string;
  knownFacts: any[];
  publish: boolean;
  provider: any;
  now?: Date;
}) {
  const { snapshot, response, text, feedbackId } = input,
    now = input.now ?? new Date(),
    today = businessDate(now),
    tomorrow = nextDate(today),
    profile = snapshot.account.profile;
  if (!profile) throw new DayError('profile_required');
  const quoted = (value: string) => {
    if (!text.includes(value))
      throw new DayError('feedback_quote_invalid', 502);
  };
  const numeric = (quote: string, value: number) => {
    const units: Record<string, number> = {
      零: 0,
      〇: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    const values = (quote.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    for (const match of quote.matchAll(/[零〇一二两三四五六七八九十百]+/g)) {
      let sum = 0,
        current = 0;
      for (const char of match[0]) {
        if (char === '十' || char === '百') {
          sum += (current || 1) * (char === '十' ? 10 : 100);
          current = 0;
        } else current = units[char];
      }
      values.push(sum + current);
    }
    if (!values.includes(value))
      throw new DayError('feedback_number_unsupported', 502);
  };
  const facts = response.facts.map((fact, index) => {
    quoted(fact.quote);
    if (fact.date > today) throw new DayError('future_execution_denied');
    if (fact.value !== undefined) {
      numeric(fact.quote, fact.value);
      if (
        !['weight', 'sleep'].includes(fact.kind) ||
        (fact.kind === 'weight' && (fact.value < 20 || fact.value > 400)) ||
        (fact.kind === 'sleep' && (fact.value < 0 || fact.value > 24))
      )
        throw new DayError('observation_value_invalid');
    }
    if (['weight', 'sleep'].includes(fact.kind) && fact.value === undefined)
      throw new DayError('observation_value_invalid');
    if (fact.minutes !== undefined) {
      numeric(fact.quote, fact.minutes);
      if (fact.kind !== 'activity')
        throw new DayError('feedback_number_unsupported');
    }
    if (
      fact.corrects &&
      !input.knownFacts.some(
        (old) => old.id === fact.corrects && old.kind === fact.kind,
      )
    )
      throw new DayError('correction_target_invalid');
    return {
      ...fact,
      id: maintenanceId(feedbackId + ':fact:' + index),
      feedbackId,
      at: now.toISOString(),
    };
  });
  const observations: Observation[] = facts
    .filter((f) => ['weight', 'sleep', 'readiness'].includes(f.kind))
    .map((f) => ({
      id: f.id,
      kind: f.kind as 'weight' | 'sleep' | 'readiness',
      date: f.date,
      at: f.at,
      value: f.value ?? null,
      unit: f.kind === 'weight' ? 'kg' : f.kind === 'sleep' ? 'hours' : 'note',
      note: f.quote,
      source: 'user',
      timePrecision: 'day',
      ...(f.corrects ? { corrects: f.corrects } : {}),
    }));
  const days: Record<string, DayState> = {};
  const dayFor = (date: string) => {
    if (date !== today && date !== tomorrow)
      throw new DayError('day_outside_planning_horizon');
    return (days[date] ??= structuredClone(
      snapshot.days[date] ?? emptyDay(date),
    ));
  };
  if (
    new Set(response.contexts.map((c) => c.date)).size !==
      response.contexts.length ||
    new Set(response.plans.map((c) => c.date)).size !== response.plans.length
  )
    throw new DayError('maintenance_response_invalid');
  for (const context of response.contexts) {
    quoted(context.quote);
    const day = dayFor(context.date);
    const { date, quote, ...patch } = context;
    day.context = { ...day.context, ...patch };
    if (day.active)
      day.pendingChange = '已记录新的当天条件，等待车间调整剩余建议。';
  }
  const citations = new Set<string>([
    ...CATALOG_CITATIONS.flatMap((c) => [c.id, c.url]),
    ...snapshot.sources
      .filter((s) => s.status === 'approved' && profile.sourceConsent)
      .map((s) => 'source:' + s.id),
  ]);
  for (const proposal of response.plans) {
    if (proposal.citations.some((c) => !citations.has(c)))
      throw new DayError('planner_citation_denied');
    const day = dayFor(proposal.date);
    if (day.paused) throw new DayError('day_paused', 409);
    const previous = day.active?.items ?? [],
      locked = previous.filter((item) => lockedItem(item, proposal.date, now));
    const selected = proposal.items.map((choice) => {
      const item = itemFromChoice(
        { ...choice, start: choice.start ?? '00:00' },
        snapshot,
        day.context,
      );
      if (!choice.start) {
        item.start = '';
        item.end = '';
        item.flexible = true;
        item.note = '时间未确认，按当天情况安排；此处为建议，不是完成记录。';
      }
      return item;
    });
    if (
      new Set(proposal.items.map((i) => i.catalogId)).size !==
      proposal.items.length
    )
      throw new DayError('plan_items_invalid');
    const items = [
      ...locked,
      ...selected,
      ...day.context.fixed
        .filter((f) => !locked.some((i) => i.id === f.id))
        .map((f) => ({
          ...f,
          kind: 'fixed' as const,
          status: 'planned' as const,
          priority: 'required' as const,
          instructions: [],
        })),
    ];
    validateItems(items, day.context, profile, previous, now);
    const comparable = (list: any[]) => list.map(({ id, ...item }) => item);
    if (
      day.active &&
      day.active.contextHash === contextHash(day.context) &&
      JSON.stringify(day.active.citations) ===
        JSON.stringify(proposal.citations) &&
      JSON.stringify(comparable(day.active.items)) ===
        JSON.stringify(comparable(items))
    ) {
      delete day.pendingChange;
      continue;
    }
    const plan = {
      id: randomUUID(),
      date: proposal.date,
      createdAt: now.toISOString(),
      basisRevision: snapshot.revision + 1,
      contextHash: contextHash(day.context),
      origin: 'pi' as const,
      provider: input.provider,
      reason: proposal.reason,
      items,
      citations: proposal.citations,
      warnings: [
        '未报告的执行、食物份量与身体状态均保留为未知；建议份量不代表实际摄入。',
      ],
      changes: [],
    };
    if (input.publish) {
      day.active = plan;
      day.draft = null;
      delete day.pendingChange;
    } else {
      day.draft = plan;
      day.pendingChange = '车间处于草稿模式，建议尚未生效。';
    }
  }
  return {
    days,
    facts,
    observations,
    summary: response.summary,
    question: response.question || null,
    planDates: response.plans.map((p) => p.date),
  };
}

/** The model receives occupied times, not private titles from any stored plan version. */
export function maintenancePlanningDays(snapshot: Snapshot, today: string) {
  const context = (value: any) => ({
    ...value,
    fixed: (value.fixed ?? []).map((f: any) => ({ ...f, title: '固定事项' })),
  });
  const plan = (value: any) =>
    value
      ? {
          ...value,
          ...(value.proposedContext
            ? { proposedContext: context(value.proposedContext) }
            : {}),
          items: value.items.map((item: any) =>
            item.kind === 'fixed'
              ? {
                  ...item,
                  title: '固定事项',
                  instructions: [],
                  note: undefined,
                  actual: undefined,
                }
              : item,
          ),
          changes: (value.changes ?? []).map((change: any) =>
            value.items.some(
              (item: any) => item.id === change.itemId && item.kind === 'fixed',
            )
              ? {
                  ...change,
                  before: '固定事项',
                  after: '固定事项',
                  reason: '固定时间约束',
                }
              : change,
          ),
        }
      : null;
  return Object.fromEntries(
    Object.entries(snapshot.days)
      .filter(([date]) => date >= today)
      .map(([date, day]) => [
        date,
        {
          ...day,
          context: context(day.context),
          active: plan(day.active),
          draft: plan(day.draft),
        },
      ]),
  );
}
