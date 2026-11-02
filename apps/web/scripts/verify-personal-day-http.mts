/** Real HTTP acceptance against ONLY the disposable fixture on 3516. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const meta = JSON.parse(
  await readFile('../../.runtime/personal-day-fixture.json', 'utf8'),
);
assert.match(meta.database, /^zhiyu_test_[a-f0-9]{32}$/);
assert.equal(meta.productionWrites, false);
const base = 'http://127.0.0.1:3516',
  checks: string[] = [];
let view: any;
const ok = (name: string) => {
  checks.push(name);
  console.log('PASS ' + name);
};
async function req(path: string, init: RequestInit = {}, status = 200) {
  const r = await fetch(base + path, {
    ...init,
    signal: AbortSignal.timeout(180000),
    headers: {
      Origin: base,
      'X-Personal-Day-Actor': meta.owner,
      ...init.headers,
    },
  });
  const text = await r.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  assert.equal(
    r.status,
    status,
    `${path} ${JSON.stringify(body).slice(0, 250)}`,
  );
  return { r, body };
}
async function refresh() {
  view = (await req('/api/personal-day')).body;
  assert.equal(view.actorId, meta.owner);
  return view;
}
async function post(operation: string, extra: any = {}, status = 200) {
  const cmd = {
    commandId: randomUUID(),
    expectedRevision: view.revision,
    operation,
    ...extra,
  };
  const result = await req(
    '/api/personal-day',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    },
    status,
  );
  await refresh();
  return { cmd, ...result };
}
await refresh();
if (view.revision > 0) {
  await post('erase', { confirmation: '删除个人日计划全部数据' });
}
assert.equal(view.account.profile, null);
assert.deepEqual(view.days, {});
ok('empty authenticated owner; no generated profile');
assert.match(
  (await req('/api/personal-day')).r.headers.get('cache-control')!,
  /no-store/,
);
await req(
  '/api/personal-day',
  { headers: { Origin: 'https://evil.example.invalid' } },
  403,
);
await req(
  '/api/personal-day',
  { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  403,
);
await req(
  '/api/personal-day',
  { headers: { 'X-Personal-Day-Actor': meta.other } },
  409,
);
ok('same-origin and stale-actor boundaries');
await post('profile_save', { ownerId: meta.other }, 400);
ok('owner forgery rejected');
const model = (await req('/api/preferences/models')).body;
await req('/api/preferences/models', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    expectedRevision: model.revision ?? 0,
    document: {
      connections: [
        {
          id: 'daily_fixture',
          name: 'Synthetic loopback Pi fixture',
          protocol: 'openai_compatible',
          baseUrl: meta.providerBaseUrl,
          model: 'daily-fixture',
          enabled: true,
        },
      ],
      defaults: {
        openai_compatible: 'daily_fixture',
        anthropic_compatible: null,
      },
      defaultConnectionId: 'daily_fixture',
      conversationProtocol: 'auto',
      assignments: {},
    },
    secretUpdates: { daily_fixture: 'fixture-key-not-a-real-secret' },
  }),
});
const profile = {
  age: 30,
  heightCm: 170,
  weightKg: 65,
  goal: 'habit',
  experience: 'beginner',
  equipment: ['none', 'chair'],
  allergies: [],
  dislikes: [],
  restrictions: '',
  mealStyle: 'mixed',
  budgetYuan: 80,
  notes: 'SYNTHETIC-PRIVATE-PROFILE',
  cloudConsent: false,
  sourceConsent: false,
};
const saved = await post('profile_save', { profile });
const rev = view.revision;
const replay = await req('/api/personal-day', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(saved.cmd),
});
assert.equal(replay.body.replayed, true);
await refresh();
assert.equal(view.revision, rev);
await req(
  '/api/personal-day',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...saved.cmd,
      profile: { ...profile, weightKg: 70 },
    }),
  },
  409,
);
await post(
  'pause',
  { date: view.today, paused: true, expectedRevision: 0 },
  409,
);
ok('durable command replay, changed-body conflict, version fence');
for (const date of [view.today, view.tomorrow])
  await post('context_save', {
    context: {
      date,
      timezone: 'Asia/Shanghai',
      location: 'home',
      windows: [{ start: '07:00', end: '23:00' }],
      fixed: [
        {
          id: randomUUID(),
          title: 'SYNTHETIC-PRIVATE-APPOINTMENT',
          start: '10:00',
          end: '11:00',
        },
      ],
      meals: 'cook',
      readiness: 'normal',
      notes: '',
    },
  });
await post(
  'generate',
  { date: view.tomorrow, mode: 'pi', reason: 'test consent' },
  403,
);
ok('cloud health consent mandatory');
await post('generate', {
  date: view.today,
  mode: 'catalog',
  reason: 'Synthetic local catalog acceptance',
});
assert.equal(view.days[view.today].draft.origin, 'catalog');
assert.ok(
  view.days[view.today].draft.items.some((i: any) => i.kind === 'meal'),
);
ok('local bounded daily exercise and meal draft');
await post('adopt', {
  date: view.today,
  planId: view.days[view.today].draft.id,
});
const meal = view.days[view.today].active.items.find(
  (i: any) => i.kind === 'meal',
);
const exercise = view.days[view.today].active.items.find(
  (i: any) => i.kind === 'exercise',
);
const food = {
  id: randomUUID(),
  name: '夹具米饭',
  state: 'cooked',
  allergens: [],
  kcal: 130,
  protein: 2,
  carbs: 28,
  fat: 0.3,
  source: 'Synthetic nutrition label',
  basis: 'per100g',
  verified: true,
};
await post('food_save', { food });
await post('record', {
  date: view.today,
  itemId: meal.id,
  status: 'completed',
  note: 'Synthetic actual meal',
  ingredients: [
    { name: '夹具米饭', grams: 200, state: 'cooked', foodId: food.id },
  ],
  minutes: 20,
});
assert.equal(view.summary[view.today].kcal, 260);
const previousAt = view.days[view.today].active.items.find(
  (i: any) => i.id === meal.id,
).actual.at;
await post(
  'record',
  { date: view.today, itemId: meal.id, status: 'completed', note: 'duplicate' },
  409,
);
await post('record_correct', {
  date: view.today,
  itemId: meal.id,
  previousAt,
  status: 'completed',
  note: 'Correction: synthetic meal weighed 150g',
  ingredients: [
    { name: '夹具米饭', grams: 150, state: 'cooked', foodId: food.id },
  ],
  minutes: 20,
});
assert.equal(view.summary[view.today].kcal, 195);
ok('actual meal labels and additive correction preserve original fact');
await post('record', {
  date: view.today,
  itemId: exercise.id,
  status: 'partial',
  note: 'Synthetic one set',
  minutes: 5,
  training: [
    { name: 'Synthetic sit to stand', sets: 1, reps: 5, loadKg: 0, effort: 3 },
  ],
});
assert.equal(
  view.days[view.today].active.items.find((i: any) => i.id === exercise.id)
    .actual.training[0].reps,
  5,
);
ok('structured actual training record');
await post('profile_save', {
  profile: { ...profile, cloudConsent: true, sourceConsent: true },
});
const raw =
  '# Synthetic fitness notes\n根据已知时间安排，完成情况以实际记录为准。\n';
const form = new FormData();
form.append(
  'file',
  new File([raw], 'synthetic-fitness.md', { type: 'text/markdown' }),
);
form.append('commandId', randomUUID());
form.append('expectedRevision', String(view.revision));
await req('/api/personal-day/sources', { method: 'POST', body: form });
await refresh();
assert.equal(view.sources.length, 1);
assert.equal(view.sources[0].originalBase64, undefined);
const source = view.sources[0];
const original = await req(
  '/api/personal-day/sources/' + source.id + '?download=1',
);
assert.equal(original.body, raw);
await post('source_extract', { sourceId: source.id, consent: true });
assert.equal(view.sources[0].status, 'review');
assert.ok(view.sources[0].principles.length);
await post('source_review', {
  sourceId: source.id,
  principles: view.sources[0].principles,
  approved: true,
});
ok('original source preserved, Pi extraction, explicit principle adoption');
await post('generate', {
  date: view.today,
  mode: 'pi',
  reason: '临时加班到20点，今晚不做饭，改外食。',
});
const draft = view.days[view.today].draft;
assert.equal(draft.origin, 'pi');
assert.equal(draft.provider.protocol, 'openai-completions');
assert.ok(
  draft.items.some((i: any) => i.id === meal.id && i.status === 'completed'),
);
assert.ok(
  draft.items.some((i: any) => i.id === exercise.id && i.status === 'partial'),
);
assert.equal(
  view.days[view.today].pendingChange,
  '临时加班到20点，今晚不做饭，改外食。',
);
assert.ok(
  draft.items
    .filter((i: any) => i.status === 'planned' && i.kind !== 'fixed')
    .every((i: any) => i.start >= '20:00'),
);
assert.ok(
  draft.items.some(
    (i: any) => i.recipeId === 'outside_dinner' && i.status === 'planned',
  ),
);
await post('adopt', { date: view.today, planId: draft.id });
assert.equal(view.days[view.today].context.meals, 'outside');
assert.equal(view.days[view.today].pendingChange, undefined);
ok(
  'Pi replan shrinks future availability and preserves completed/partial facts',
);
await post('generate', {
  date: view.tomorrow,
  mode: 'pi',
  reason: 'Synthetic tomorrow draft',
});
const stale = view.days[view.tomorrow].draft.id;
await post('observation', {
  kind: 'weight',
  at: new Date().toISOString(),
  value: 64,
  note: 'Synthetic scale',
});
await post('adopt', { date: view.tomorrow, planId: stale }, 409);
const obs = view.observations.find((o: any) => o.kind === 'weight');
await post('observation', {
  kind: 'correction',
  at: new Date().toISOString(),
  value: 64.2,
  note: 'Synthetic scale correction',
  corrects: obs.id,
});
assert.equal(view.assessment.effectiveWeightKg, 64.2);
ok('stale draft denied, weight correction projected from immutable facts');
const nowItem = {
  id: randomUUID(),
  kind: 'personal',
  title: 'Synthetic reading',
  start: '22:20',
  end: '22:35',
  priority: 'optional',
  instructions: [],
};
await post('manual_plan', {
  date: view.today,
  items: [
    ...view.days[view.today].active.items
      .filter((i: any) => i.status === 'planned')
      .map(({ status, actual, ingredients, ...i }: any) => i),
    nowItem,
  ],
  reason: 'Synthetic defer candidate',
});
await post('adopt', {
  date: view.today,
  planId: view.days[view.today].draft.id,
});
await post('defer', {
  date: view.today,
  itemId: nowItem.id,
  target: view.tomorrow,
  reason: 'Synthetic time constraint',
});
assert.ok(
  view.days[view.tomorrow].deferred.some((i: any) => i.id === nowItem.id),
);
assert.equal(view.days[view.tomorrow].draft, null);
ok('defer is atomic, tomorrow candidate pool without invented time');
await post('generate', {
  date: view.tomorrow,
  mode: 'catalog',
  reason: 'Synthetic pause',
});
await post('pause', { date: view.tomorrow, paused: true });
assert.equal(view.days[view.tomorrow].paused, true);
assert.equal(view.days[view.tomorrow].draft, null);
await post('pause', { date: view.tomorrow, paused: false });
ok('pause invalidates candidate and remains reversible');
const configure = {
  commandId: randomUUID(),
  expectedRevision: view.revision,
  time: '21:00',
  mode: 'catalog',
  enabled: true,
};
await req('/api/personal-day/automation', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(configure),
});
await refresh();
const auto = (await req('/api/personal-day/automation')).body.automation;
assert.equal(auto.state, 'active');
assert.ok(auto.nextRunAt);
ok('automation uses existing Work/Loop and reports next run');
const work = (await req('/api/workshops/' + auto.workId)).body;
const run = (
  await req(`/api/workshops/${auto.workId}/loops/${auto.loopId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Work-Actor': meta.owner },
    body: JSON.stringify({
      commandId: randomUUID(),
      expectedVersion: work.commandVersion,
      wait: true,
      mode: 'native_agent',
      createOutboxDrafts: false,
    }),
  })
).body;
assert.equal(
  run.result.status,
  'success',
  JSON.stringify(run.result).slice(0, 1200),
);
await refresh();
assert.ok(view.days[view.tomorrow].draft);
assert.equal(view.days[view.tomorrow].active, null);
assert.equal(
  (await req('/api/personal-day/automation')).body.automation.lastRunStatus,
  'success',
);
ok(
  'real Work lease and Loop execution persist a draft without adopting or sending',
);
const afterFirstRevision = view.revision;
const latestWork = (await req('/api/workshops/' + auto.workId)).body;
const secondRun = (
  await req(`/api/workshops/${auto.workId}/loops/${auto.loopId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Work-Actor': meta.owner },
    body: JSON.stringify({
      commandId: randomUUID(),
      expectedVersion: latestWork.commandVersion,
      wait: true,
      mode: 'native_agent',
      createOutboxDrafts: false,
    }),
  })
).body;
assert.equal(secondRun.result.status, 'success');
await refresh();
assert.equal(view.revision, afterFirstRevision);
assert.equal(
  secondRun.result.result.personalDayReceipt.state,
  'existing_plan_preserved',
);
ok('repeated Loop run retains durable role dispatch and existing draft');
await req('/api/personal-day/automation', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    commandId: randomUUID(),
    expectedRevision: view.revision,
    time: '21:00',
    mode: 'catalog',
    enabled: false,
  }),
});
await refresh();
assert.equal(
  (await req('/api/personal-day/automation')).body.automation.state,
  'paused',
);
ok('automation pause through Work command boundary');
const exp = await req('/api/personal-day/export');
assert.ok(
  exp.body.data.events.some(
    (e: any) => e.payload.correctsActualAt === previousAt,
  ),
);
assert.ok(exp.body.data.sources[0].originalBase64);
ok('private export retains source, raw facts and correction audit');
await writeFile(
  '../../.runtime/personal-day-http-' + meta.mode + '.json',
  JSON.stringify(
    {
      at: new Date().toISOString(),
      checks,
      passed: checks.length,
      database: meta.database,
      externalProvidersCalled: false,
      productionWrites: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    passed: checks.length,
    mode: meta.mode,
    externalProvidersCalled: false,
    productionWrites: false,
  }),
);
