/** One bounded live-model call, synthetic health input, no domain writes. */
import { config } from 'dotenv';
import { writeFile } from 'node:fs/promises';
if (!process.argv.includes('--execute'))
  throw Error('explicit_execution_required');
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });
if (process.env.AUTH_MODE !== 'local_owner')
  throw Error('local_owner_required');
const { createDevSession } = await import('@/lib/auth/dev-auth');
const { generatePlan } = await import('@/lib/personal-day/planner');
const { piDayPlanner } = await import('@/lib/personal-day/service');
const { DEFAULT_PROFILE, emptyDay, businessDate, nextDate, DayError } =
  await import('@/lib/personal-day/contracts');
const { closePostgresDb } = await import('@/lib/db/adapters/postgres');
const owner = createDevSession().user.id,
  date = nextDate(businessDate()),
  day = emptyDay(date);
day.context = {
  ...day.context,
  windows: [
    { start: '07:00', end: '08:00' },
    { start: '12:00', end: '13:00' },
    { start: '18:00', end: '20:00' },
  ],
  readiness: 'normal',
  meals: 'cook',
};
const snapshot = {
  revision: 0,
  account: {
    profile: {
      ...DEFAULT_PROFILE,
      cloudConsent: true,
      notes: '虚构接口验收样例，不对应真实用户。',
    },
    foods: [],
  },
  days: { [date]: day },
  sources: [],
  observations: [],
  events: [],
};
const started = Date.now();
try {
  const plan = await generatePlan(
    snapshot,
    date,
    '为虚构样例生成明日训练和三餐草稿，只选给定目录并符合时间窗口。',
    'pi',
    (input, signal) =>
      piDayPlanner(Object.assign(input, { ownerId: owner }), signal),
  );
  const proof = {
    passed: true,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    model: plan.provider,
    items: plan.items.map((i) => ({
      kind: i.kind,
      catalogId: i.exerciseId ?? i.recipeId,
      start: i.start,
      end: i.end,
    })),
    warnings: plan.warnings,
    externalModelCalls: 1,
    realHealthDataUsed: false,
    domainWrites: false,
  };
  await writeFile(
    '../../.runtime/personal-day-selected-model.json',
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
} catch (error) {
  const proof = {
    passed: false,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    error:
      error instanceof DayError ? error.code : 'selected_model_call_failed',
    externalModelCalls: 1,
    realHealthDataUsed: false,
    domainWrites: false,
  };
  await writeFile(
    '../../.runtime/personal-day-selected-model.json',
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
  process.exitCode = 1;
} finally {
  await closePostgresDb();
}
