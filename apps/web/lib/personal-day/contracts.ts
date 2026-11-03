import { z } from 'zod';

export class DayError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly detail?: string,
  ) {
    super(code);
  }
}
const short = z.string().trim().max(200);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(value + 'T12:00:00Z');
    return (
      Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value
    );
  });
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const profileSchema = z
  .object({
    age: z.number().int().min(18).max(120),
    heightCm: z.number().min(50).max(250),
    weightKg: z.number().min(20).max(400),
    goal: z.enum(['habit', 'fitness', 'muscle', 'fat_loss']),
    experience: z.enum(['beginner', 'regular']),
    equipment: z.array(z.enum(['none', 'chair', 'gym'])).max(3),
    allergies: z.array(short).max(20),
    dislikes: z.array(short).max(20),
    restrictions: z.string().trim().max(1000),
    mealStyle: z.enum(['cook', 'outside', 'mixed']),
    budgetYuan: z.number().min(0).max(10000),
    notes: z.string().trim().max(1000),
    cloudConsent: z.boolean(),
    sourceConsent: z.boolean(),
  })
  .strict();
export type HealthProfile = z.infer<typeof profileSchema>;
export const DEFAULT_PROFILE: HealthProfile = {
  age: 30,
  heightCm: 170,
  weightKg: 65,
  goal: 'habit',
  experience: 'beginner',
  equipment: ['none'],
  allergies: [],
  dislikes: [],
  restrictions: '',
  mealStyle: 'mixed',
  budgetYuan: 80,
  notes: '',
  cloudConsent: false,
  sourceConsent: false,
};
export const windowSchema = z
  .object({ start: timeSchema, end: timeSchema })
  .strict()
  .refine((w) => w.start < w.end, '结束时间必须晚于开始时间');
export const contextSchema = z
  .object({
    date: dateSchema,
    timezone: z.literal('Asia/Shanghai'),
    location: z.enum(['home', 'gym', 'travel']),
    windows: z.array(windowSchema).max(12),
    fixed: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: short.min(1),
            start: timeSchema,
            end: timeSchema,
          })
          .strict()
          .refine((w) => w.start < w.end),
      )
      .max(30),
    meals: z.enum(['cook', 'outside', 'mixed']),
    readiness: z.enum(['normal', 'tired', 'pain', 'unknown']),
    notes: z.string().trim().max(1000),
  })
  .strict();
export type DayContext = z.infer<typeof contextSchema>;
export const defaultContext = (date: string): DayContext => ({
  date,
  timezone: 'Asia/Shanghai',
  location: 'home',
  windows: [],
  fixed: [],
  meals: 'mixed',
  readiness: 'unknown',
  notes: '',
});
export const foodSchema = z
  .object({
    id: z.string().uuid(),
    name: short.min(1),
    state: z.enum(['raw', 'cooked', 'packaged']),
    allergens: z.array(short).max(20),
    kcal: z.number().min(0).max(1000).nullable(),
    protein: z.number().min(0).max(100).nullable(),
    carbs: z.number().min(0).max(100).nullable(),
    fat: z.number().min(0).max(100).nullable(),
    source: short.min(1),
    basis: z.literal('per100g'),
    verified: z.boolean(),
  })
  .strict();
export type Food = z.infer<typeof foodSchema>;
export const itemStatusSchema = z.enum([
  'planned',
  'in_progress',
  'completed',
  'partial',
  'skipped',
  'canceled',
]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;
export type MealIngredient = {
  name: string;
  grams: number;
  state: 'raw' | 'cooked' | 'packaged';
  foodId?: string;
};
export type DayItem = {
  id: string;
  kind: 'exercise' | 'meal' | 'fixed' | 'personal';
  title: string;
  start: string;
  end: string;
  priority: 'required' | 'optional';
  status: ItemStatus;
  exerciseId?: string;
  recipeId?: string;
  ingredients?: MealIngredient[];
  instructions: string[];
  note?: string;
  flexible?: boolean;
  actual?: {
    at: string;
    minutes?: number;
    text: string;
    ingredients?: MealIngredient[];
    training?: TrainingRecord[];
  };
};
export const trainingRecordSchema = z
  .object({
    name: short.min(1),
    sets: z.number().int().min(1).max(100),
    reps: z.number().int().min(0).max(1000).optional(),
    loadKg: z.number().min(0).max(1000).optional(),
    effort: z.number().min(0).max(10).optional(),
  })
  .strict();
export type TrainingRecord = z.infer<typeof trainingRecordSchema>;
export type Plan = {
  id: string;
  createdAt: string;
  date: string;
  basisRevision: number;
  contextHash: string;
  proposedContext?: DayContext;
  origin: 'pi' | 'manual' | 'catalog';
  provider?: { model: string; protocol: string; revision?: string };
  reason: string;
  items: DayItem[];
  warnings: string[];
  citations: string[];
  changes: { itemId: string; before: string; after: string; reason: string }[];
};
export type DayState = {
  context: DayContext;
  active: Plan | null;
  draft: Plan | null;
  paused: boolean;
  pendingChange?: string;
  deferred: { id: string; title: string; fromDate: string; reason: string }[];
};
export type Source = {
  id: string;
  name: string;
  hash: string;
  format: string;
  status: 'review' | 'approved' | 'revoked' | 'failed';
  text: string;
  principles: string[];
  createdAt: string;
  error?: string;
  warnings: string[];
  originalBase64?: string;
};
export type Observation = {
  id: string;
  kind: 'weight' | 'sleep' | 'readiness' | 'execution' | 'correction';
  at: string;
  value: number | null;
  unit: string;
  note: string;
  date: string;
  source: 'user';
  /** Day-level reports keep receipt time in at; date is the reported occurrence date. */
  timePrecision?: 'day' | 'instant';
  corrects?: string;
};
export type Account = {
  profile: HealthProfile | null;
  foods: Food[];
  maintenance?: { workId: string; enabled: boolean };
  automation?: {
    workId: string;
    loopId: string;
    time: string;
    mode: 'pi' | 'catalog';
    enabled: boolean;
  };
};
export type Snapshot = {
  revision: number;
  account: Account;
  days: Record<string, DayState>;
  sources: Source[];
  observations: Observation[];
  events: { id: string; kind: string; at: string; payload: any }[];
};
const base = {
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
};
const manualItem = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['exercise', 'meal', 'fixed', 'personal']),
    title: short.min(1),
    start: timeSchema,
    end: timeSchema,
    priority: z.enum(['required', 'optional']),
    exerciseId: short.optional(),
    recipeId: short.optional(),
    instructions: z.array(short).max(15),
    note: short.optional(),
  })
  .strict()
  .refine((v) => v.start < v.end);
export const commandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...base,
      operation: z.literal('profile_save'),
      profile: profileSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('context_save'),
      context: contextSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('generate'),
      date: dateSchema,
      mode: z.enum(['pi', 'catalog']),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('manual_plan'),
      date: dateSchema,
      items: z.array(manualItem).max(30),
      reason: short,
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('adopt'),
      date: dateSchema,
      planId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('record'),
      date: dateSchema,
      itemId: z.string().uuid(),
      status: itemStatusSchema,
      note: z.string().trim().max(1000),
      minutes: z.number().min(0).max(1440).optional(),
      ingredients: z
        .array(
          z
            .object({
              name: short.min(1),
              grams: z.number().positive().max(10000),
              state: z.enum(['raw', 'cooked', 'packaged']),
              foodId: z.string().uuid().optional(),
            })
            .strict(),
        )
        .max(20)
        .optional(),
      training: z.array(trainingRecordSchema).max(30).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('record_correct'),
      date: dateSchema,
      itemId: z.string().uuid(),
      previousAt: z.string().datetime({ offset: true }),
      status: z.enum(['completed', 'partial', 'skipped', 'canceled']),
      note: z.string().trim().min(1).max(1000),
      minutes: z.number().min(0).max(1440).optional(),
      ingredients: z
        .array(
          z
            .object({
              name: short.min(1),
              grams: z.number().positive().max(10000),
              state: z.enum(['raw', 'cooked', 'packaged']),
              foodId: z.string().uuid().optional(),
            })
            .strict(),
        )
        .max(20)
        .optional(),
      training: z.array(trainingRecordSchema).max(30).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('observation'),
      kind: z.enum(['weight', 'sleep', 'readiness', 'correction']),
      at: z.string().datetime({ offset: true }),
      value: z.number().nullable(),
      note: z.string().trim().max(1000),
      corrects: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('pause'),
      date: dateSchema,
      paused: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('defer'),
      date: dateSchema,
      itemId: z.string().uuid(),
      target: dateSchema,
      reason: short.min(1),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('source_review'),
      sourceId: z.string().uuid(),
      approved: z.boolean(),
      principles: z.array(z.string().trim().min(1).max(1000)).max(20),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('source_extract'),
      sourceId: z.string().uuid(),
      consent: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('release_command'),
      targetId: z.string().uuid(),
    })
    .strict(),
  z
    .object({ ...base, operation: z.literal('food_save'), food: foodSchema })
    .strict(),
  z
    .object({ ...base, operation: z.literal('keep_plan'), date: dateSchema })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('restore'),
      date: dateSchema,
      eventId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('erase'),
      confirmation: z.literal('删除个人日计划全部数据'),
    })
    .strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export function businessDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function nextDate(date: string, offset = 1) {
  const d = new Date(date + 'T12:00:00+08:00');
  d.setUTCDate(d.getUTCDate() + offset);
  return businessDate(d);
}
export function minute(time: string) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
export function clock(value: number) {
  return (
    String(Math.floor(value / 60)).padStart(2, '0') +
    ':' +
    String(value % 60).padStart(2, '0')
  );
}
export function currentMinute(now = new Date()) {
  return minute(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
}
export function emptyDay(date: string): DayState {
  return {
    context: defaultContext(date),
    active: null,
    draft: null,
    paused: false,
    deferred: [],
  };
}
