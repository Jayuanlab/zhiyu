/** One live Pi call with wholly synthetic health input, no domain writes. */
import { config } from 'dotenv';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
if (!process.argv.includes('--execute'))
  throw Error('explicit_execution_required');
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });
if (process.env.AUTH_MODE !== 'local_owner')
  throw Error('local_owner_required');
const { createDevSession } = await import('@/lib/auth/dev-auth');
const {
  loadModelConfiguration,
  completeConfiguredText,
  modelConfigurationProvider,
} = await import('@/lib/ai/model-configuration');
const { maintenanceMission, maintenanceModelContract } = await import(
  '@/lib/personal-day/maintenance'
);
const { parseMaintenanceResponse, buildMaintenanceWrite } = await import(
  '@/lib/personal-day/maintenance-plan'
);
const { EXERCISES, RECIPES, CATALOG_CITATIONS } = await import(
  '@/lib/personal-day/catalog'
);
const { DEFAULT_PROFILE, businessDate, nextDate } = await import(
  '@/lib/personal-day/contracts'
);
const { closePostgresDb } = await import('@/lib/db/adapters/postgres');
const snapshot = {
  revision: 0,
  account: {
    profile: {
      ...DEFAULT_PROFILE,
      cloudConsent: true,
      notes: '完全虚构的接口验收样例，不对应真实用户。',
    },
    foods: [],
  },
  days: {},
  sources: [],
  observations: [],
  events: [],
};
const feedback =
  '今天走了20分钟，午饭吃了牛肉面。明天的时间还不确定，请给我弹性的活动和饮食建议。';
const started = Date.now();
let capturedText = '';
try {
  const c = await loadModelConfiguration({
    userId: createDevSession().user.id,
    purpose: 'agent',
  });
  if (!c) throw Error('model_not_configured');
  const provider = modelConfigurationProvider(c);
  const result = await completeConfiguredText(c, {
    system: maintenanceMission + '\n' + maintenanceModelContract,
    prompt: JSON.stringify({
      task: 'personal_day_maintenance',
      today: businessDate(),
      tomorrow: nextDate(businessDate()),
      feedbackDate: businessDate(),
      feedback,
      profile: snapshot.account.profile,
      observations: [],
      knownFacts: [],
      days: {},
      sources: [],
      catalog: {
        exercises: EXERCISES,
        recipes: RECIPES,
        citations: CATALOG_CITATIONS,
      },
    }),
    json: true,
    maxTokens: 5500,
    signal: AbortSignal.timeout(90000),
  });
  capturedText = result.text;
  const parsed = parseMaintenanceResponse(result.text);
  const write = buildMaintenanceWrite({
    snapshot,
    response: parsed,
    text: feedback,
    feedbackId: randomUUID(),
    knownFacts: [],
    publish: true,
    provider,
  });
  const proof = {
    passed: true,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    provider: {
      model: provider.model,
      protocol: provider.protocol,
      revision: provider.revision,
    },
    facts: write.facts.map((f) => ({ kind: f.kind, minutes: f.minutes })),
    planDates: write.planDates,
    flexible: Object.values(write.days)
      .flatMap((d) => d.active?.items ?? [])
      .every((i) => i.flexible),
    domainWrites: false,
    realHealthDataUsed: false,
    externalModelCalls: 1,
  };
  await writeFile(
    '../../.runtime/maintenance-selected-model.json',
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
} catch (error) {
  await writeFile(
    '../../.runtime/maintenance-selected-model-response.json',
    JSON.stringify({ text: capturedText }, null, 2),
  );
  const proof = {
    passed: false,
    durationMs: Date.now() - started,
    error: (error as Error).message,
    domainWrites: false,
    realHealthDataUsed: false,
  };
  await writeFile(
    '../../.runtime/maintenance-selected-model.json',
    JSON.stringify(proof, null, 2),
  );
  console.error(JSON.stringify(proof));
  process.exitCode = 1;
} finally {
  await closePostgresDb();
}
