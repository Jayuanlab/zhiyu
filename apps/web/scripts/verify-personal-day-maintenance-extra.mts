import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const meta = JSON.parse(
  await readFile('../../.runtime/personal-day-fixture.json', 'utf8'),
);
assert.match(meta.database, /^zhiyu_test_[a-f0-9]{32}$/);
assert.equal(meta.productionWrites, false);
const env = JSON.parse(
  await readFile(meta.root + '/private-environment.json', 'utf8'),
);
Object.assign(process.env, env, {
  NODE_ENV: 'test',
  ZHIYU_TEST_MODE: 'integration',
  ZHIYU_TEST_DATABASE_URL: env.POSTGRES_URL,
});
const { consumeOwnedWorkRuns } = await import(
  '@/lib/work-runtime/run-consumer'
);
const { consumeOwnedLoopRuns } = await import(
  '@/lib/work-runtime/loop-consumer'
);
const { acceptWorkLoopExecution } = await import(
  '@/lib/work-runtime/loop-command'
);
const {
  getWorkSummarySnapshot,
  updateWork,
  updateWorkLoop,
  clearWorkLoopBlocker,
} = await import('@/lib/work-runtime');
const { getLoopInWorkshop } = await import('@/lib/loops/service');
const { readDaySnapshot } = await import('@/lib/personal-day/store');
const { executeDayCommand } = await import('@/lib/personal-day/service');
const { executeDailyMaintenanceRun } = await import(
  '@/lib/personal-day/maintenance'
);
const { withExecutionContext } = await import(
  '@/lib/work-runtime/execution-context'
);
const { completeWorkshopRun, getWorkshop } = await import(
  '@/lib/workshops/service'
);
const { ownedFeedback } = await import('@/lib/personal-day/feedback-store');
const { closePostgresDb } = await import('@/lib/db/adapters/postgres');
const { emptyDay, businessDate, nextDate } = await import(
  '@/lib/personal-day/contracts'
);
const checks: string[] = [],
  base = 'http://127.0.0.1:3516',
  ok = (name: string) => {
    checks.push(name);
    console.log('PASS ' + name);
  };
async function req(path: string, body?: any, status = 200) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Personal-Day-Actor': meta.owner,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(180000),
  });
  const result = await r.json();
  assert.equal(r.status, status, JSON.stringify(result));
  return result;
}
let data = await req('/api/personal-day');
const workId = data.account.maintenance.workId;
const today = businessDate(),
  tomorrow = nextDate(today);
async function command(operation: string, extra: any) {
  const result = await req('/api/personal-day', {
    operation,
    commandId: randomUUID(),
    expectedRevision: data.revision,
    ...extra,
  });
  data = await req('/api/personal-day');
  return result;
}
async function consume() {
  return consumeOwnedWorkRuns({
    userId: meta.owner,
    workerId: 'personal-day-extra-fixture',
    workshopIds: [workId],
    limit: 10,
    leaseMs: 180000,
  });
}
try {
  if (!process.argv.includes('--only-stale')) {
    await command('context_save', {
      context: { ...emptyDay(tomorrow).context, readiness: 'normal' },
    });
    const form = new FormData();
    form.set(
      'file',
      new File(
        ['# Synthetic reference\n按实际情况安排运动，保留休息。'],
        'maintenance-reference.md',
        { type: 'text/markdown' },
      ),
    );
    form.set('commandId', randomUUID());
    form.set('expectedRevision', String(data.revision));
    const upload = await fetch(base + '/api/personal-day/sources', {
      method: 'POST',
      headers: { Origin: base, 'X-Personal-Day-Actor': meta.owner },
      body: form,
    });
    assert.equal(upload.status, 200);
    const source = (await upload.json()).result;
    data = await req('/api/personal-day');
    const sourceId = data.sources.find(
      (s: any) => s.name === 'maintenance-reference.md',
    ).id;
    await req(
      '/api/personal-day',
      {
        operation: 'source_extract',
        commandId: randomUUID(),
        expectedRevision: data.revision,
        sourceId,
        consent: true,
      },
      202,
    );
    assert.ok((await consume()).some((r) => r.state === 'completed'));
    data = await req('/api/personal-day');
    assert.equal(
      data.sources.find((s: any) => s.id === sourceId).status,
      'review',
    );
    assert.equal(
      data.sources.find((s: any) => s.id === sourceId).principles.length,
      1,
    );
    ok(
      'source extraction runs in the associated Work and commits its receipt with the candidate',
    );
    await command('source_review', {
      sourceId,
      approved: true,
      principles: data.sources.find((s: any) => s.id === sourceId).principles,
    });
    assert.ok((await consume()).some((r) => r.state === 'completed'));
    data = await req('/api/personal-day');
    assert.equal(
      data.sources.find((s: any) => s.id === sourceId).status,
      'approved',
    );
    ok(
      'owner adoption of source principles triggers the same maintenance queue',
    );
    await req('/api/personal-day/automation', {
      commandId: randomUUID(),
      expectedRevision: data.revision,
      time: '21:00',
      mode: 'pi',
      enabled: true,
    });
    data = await req('/api/personal-day');
    assert.equal(data.account.automation.workId, workId);
    let baseline = await getWorkSummarySnapshot({ userId: meta.owner, workId });
    await clearWorkLoopBlocker({
      userId: meta.owner,
      workId,
      loopId: data.account.automation.loopId,
      commandId: randomUUID(),
      expectedVersion: baseline!.detail.commandVersion,
      source: 'owner',
      reason: 'isolated acceptance after boundary classification repair',
      patch: {},
    });
    baseline = await getWorkSummarySnapshot({ userId: meta.owner, workId });
    await acceptWorkLoopExecution({
      userId: meta.owner,
      workId,
      loopId: data.account.automation.loopId,
      commandId: randomUUID(),
      expectedVersion: baseline!.detail.commandVersion,
      source: 'owner',
      reason: 'synthetic scheduled maintenance acceptance',
      mode: 'native_agent',
      triggeredBy: 'manual',
    });
    const loops = await consumeOwnedLoopRuns({
      userId: meta.owner,
      workerId: 'personal-day-loop-fixture',
      workshopIds: [workId],
      limit: 5,
      leaseMs: 180000,
    });
    console.log('LOOP ' + JSON.stringify(loops));
    assert.ok(loops.some((r) => r.state === 'completed'));
    data = await req('/api/personal-day');
    assert.ok(data.days[tomorrow].active);
    const status = await req('/api/personal-day/automation');
    assert.equal(status.automation.lastRunStatus, 'success');
    assert.ok(status.automation.nextRunAt);
    ok(
      'daily Loop reuses the same Work controller and publishes without clock-time prerequisites',
    );
    const initial = await req(
      '/api/personal-day/maintenance',
      { operation: 'refresh', causeId: randomUUID() },
      202,
    );
    assert.equal(initial.status, 'queued');
    assert.ok((await consume()).some((r) => r.state === 'completed'));
    data = await req('/api/personal-day');
    assert.ok(data.days[today].active);
    assert.ok(data.days[tomorrow].active);
    ok(
      'initial plan request enters the Work queue immediately after setup, before the next scheduled Loop',
    );
    await command('context_save', {
      context: {
        ...data.days[tomorrow].context,
        fixed: [
          {
            id: randomUUID(),
            title: 'SYNTHETIC_PRIVATE_FIXED_TITLE',
            start: '08:00',
            end: '09:00',
          },
        ],
      },
    });
    assert.ok((await consume()).some((r) => r.state === 'completed'));
    const privateId = randomUUID();
    await req(
      '/api/personal-day/maintenance',
      {
        operation: 'feedback',
        id: privateId,
        date: today,
        text: '今天走了12分钟。',
      },
      202,
    );
    assert.ok((await consume()).some((r) => r.state === 'completed'));
    data = await req('/api/personal-day');
    assert.ok(
      data.days[tomorrow].active.items.some(
        (i: any) => i.title === 'SYNTHETIC_PRIVATE_FIXED_TITLE',
      ),
    );
    assert.equal(
      (await ownedFeedback(meta.owner, privateId)).row.status,
      'processed',
    );
    ok(
      'Pi request hides fixed titles from stored active plans while authoritative titles remain intact',
    );
  }
  const id = randomUUID();
  await req(
    '/api/personal-day/maintenance',
    { operation: 'feedback', id, date: today, text: '今天走了20分钟。' },
    202,
  );
  const results = await consumeOwnedWorkRuns(
    {
      userId: meta.owner,
      workerId: 'personal-day-stale-fixture',
      workshopIds: [workId],
      limit: 5,
      leaseMs: 180000,
    },
    async (input) =>
      withExecutionContext(input.executionLease!, async () => {
        try {
          await executeDailyMaintenanceRun({
            owner: input.userId,
            work: input.workshop,
            run: input.run,
            signal: new AbortController().signal,
            planner: async (_config, request) => {
              assert.ok(request.system.startsWith(input.workshop.mission));
              const s = await readDaySnapshot(meta.owner);
              await executeDayCommand(meta.owner, {
                operation: 'profile_save',
                commandId: randomUUID(),
                expectedRevision: s.revision,
                profile: {
                  ...s.account.profile!,
                  notes: 'SYNTHETIC EDIT DURING INTERPRETATION',
                },
              });
              return {
                text: JSON.stringify({
                  summary: 'stale',
                  facts: [
                    {
                      kind: 'activity',
                      date: today,
                      quote: '走了20分钟',
                      minutes: 20,
                    },
                  ],
                  contexts: [],
                  plans: [],
                }),
              };
            },
          });
          assert.fail('stale response accepted');
        } catch (error) {
          assert.match((error as Error).message, /version_conflict/);
          await completeWorkshopRun({
            userId: input.userId,
            workshopId: workId,
            runId: input.run.id,
            lease: input.executionLease,
            status: 'failed',
            error: 'version_conflict',
          });
        }
      }),
  );
  assert.ok(results.some((r) => r.state === 'failed'));
  assert.equal((await ownedFeedback(meta.owner, id)).row.status, 'failed');
  assert.equal((await ownedFeedback(meta.owner, id)).result, null);
  ok(
    'concurrent profile edits reject late interpretation without partial facts or plans',
  );
  const configId = randomUUID();
  await req(
    '/api/personal-day/maintenance',
    {
      operation: 'feedback',
      id: configId,
      date: today,
      text: '今天走了10分钟。',
    },
    202,
  );
  const changed = await consumeOwnedWorkRuns(
    {
      userId: meta.owner,
      workerId: 'personal-day-config-fixture',
      workshopIds: [workId],
      limit: 5,
      leaseMs: 180000,
    },
    async (input) =>
      withExecutionContext(input.executionLease!, async () => {
        try {
          await executeDailyMaintenanceRun({
            owner: input.userId,
            work: input.workshop,
            run: input.run,
            signal: new AbortController().signal,
            planner: async (_config, request) => {
              assert.ok(request.system.startsWith(input.workshop.mission));
              const baseline = await getWorkSummarySnapshot({
                userId: meta.owner,
                workId,
              });
              await updateWork({
                userId: meta.owner,
                workId,
                commandId: randomUUID(),
                expectedVersion: baseline!.detail.commandVersion,
                source: 'owner',
                reason: 'synthetic configuration edit during interpretation',
                patch: {
                  mission:
                    input.workshop.mission + '\nSYNTHETIC WORK MISSION EDIT',
                },
              });
              return {
                text: JSON.stringify({
                  summary: 'old configuration',
                  facts: [
                    {
                      kind: 'activity',
                      date: today,
                      quote: '走了10分钟',
                      minutes: 10,
                    },
                  ],
                  contexts: [],
                  plans: [],
                }),
              };
            },
          });
          assert.fail('configuration-stale response accepted');
        } catch (error) {
          assert.match((error as Error).message, /maintenance_config_changed/);
          await completeWorkshopRun({
            userId: input.userId,
            workshopId: workId,
            runId: input.run.id,
            lease: input.executionLease,
            status: 'failed',
            error: 'maintenance_config_changed',
          });
        }
      }),
  );
  assert.ok(changed.some((r) => r.state === 'failed'));
  assert.equal((await ownedFeedback(meta.owner, configId)).result, null);
  ok(
    'actual Work mission is loaded and a concurrent configuration edit rejects the late result',
  );
  data = await req('/api/personal-day');
  const originalWork = await getWorkshop(meta.owner, workId),
    originalLoop = await getLoopInWorkshop({
      userId: meta.owner,
      workshopId: workId,
      loopId: data.account.automation.loopId,
    }),
    originalTime = data.account.automation.time;
  async function ownerWorkPatch(patch: any) {
    const base = await getWorkSummarySnapshot({ userId: meta.owner, workId });
    return updateWork({
      userId: meta.owner,
      workId,
      commandId: randomUUID(),
      expectedVersion: base!.detail.commandVersion,
      source: 'owner',
      reason: 'synthetic explicit owner policy edit',
      patch,
    });
  }
  async function ownerLoopPatch(patch: any) {
    const base = await getWorkSummarySnapshot({ userId: meta.owner, workId });
    return updateWorkLoop({
      userId: meta.owner,
      workId,
      loopId: originalLoop!.id,
      commandId: randomUUID(),
      expectedVersion: base!.detail.commandVersion,
      source: 'owner',
      reason: 'synthetic explicit owner loop policy edit',
      patch,
    });
  }
  await ownerWorkPatch({
    boundaryPolicy: {
      ...(originalWork!.boundaryPolicy as any),
      hardDeniedActions: ['personalDayAdopt', 'sendMessage', 'bash', 'delete'],
    },
    modelConfig: {
      ...(originalWork!.modelConfig as any),
      disallowedTools: ['personalDayAdopt', 'sendMessage', 'bash', 'delete'],
    },
  });
  for (const enabled of [false, true]) {
    data = await req('/api/personal-day');
    await req('/api/personal-day/maintenance', {
      operation: 'configure',
      commandId: randomUUID(),
      expectedRevision: data.revision,
      enabled,
    });
  }
  const protectedWork = await getWorkshop(meta.owner, workId);
  assert.ok(
    (protectedWork!.boundaryPolicy as any).hardDeniedActions.includes(
      'personalDayAdopt',
    ),
  );
  assert.ok(
    (protectedWork!.modelConfig as any).disallowedTools.includes(
      'personalDayAdopt',
    ),
  );
  ok('pause and enable retain owner hard denials and disallowed tools');
  const policy = {
    allowed: ['personalDayMaintain'],
    requiresApproval: ['personalDayDraft'],
    denied: ['personalDayPublish', 'personalDayAdopt', 'sendMessage'],
  };
  const context = { sources: [], instructions: 'SYNTHETIC OWNER LOOP RULE' };
  await ownerLoopPatch({
    name: 'SYNTHETIC OWNER LOOP NAME',
    goal: 'SYNTHETIC OWNER LOOP GOAL',
    actionPolicy: policy,
    contextConfig: context,
  });
  const protectedLoop = await getLoopInWorkshop({
    userId: meta.owner,
    workshopId: workId,
    loopId: originalLoop!.id,
  });
  data = await req('/api/personal-day');
  await req('/api/personal-day/automation', {
    commandId: randomUUID(),
    expectedRevision: data.revision,
    time: '20:35',
    mode: 'pi',
    enabled: true,
  });
  const afterSchedule = await getLoopInWorkshop({
    userId: meta.owner,
    workshopId: workId,
    loopId: originalLoop!.id,
  });
  assert.deepEqual(afterSchedule!.actionPolicy, protectedLoop!.actionPolicy);
  assert.deepEqual(afterSchedule!.contextConfig, protectedLoop!.contextConfig);
  assert.equal(afterSchedule!.goal, protectedLoop!.goal);
  assert.equal(afterSchedule!.name, protectedLoop!.name);
  const deniedId = randomUUID();
  await req(
    '/api/personal-day/maintenance',
    {
      operation: 'feedback',
      id: deniedId,
      date: today,
      text: '今天走了11分钟。',
    },
    202,
  );
  assert.ok((await consume()).some((r) => r.state === 'failed'));
  assert.equal(
    (await ownedFeedback(meta.owner, deniedId)).row.error,
    'maintenance_boundary_denied',
  );
  ok(
    'schedule edits preserve owner action policies and custom instructions; denied publication still fails',
  );
  await ownerWorkPatch({
    boundaryPolicy: originalWork!.boundaryPolicy as any,
    modelConfig: originalWork!.modelConfig as any,
  });
  await ownerLoopPatch({
    name: originalLoop!.name,
    goal: originalLoop!.goal,
    actionPolicy: originalLoop!.actionPolicy,
    contextConfig: originalLoop!.contextConfig,
  });
  data = await req('/api/personal-day');
  await req('/api/personal-day/automation', {
    commandId: randomUUID(),
    expectedRevision: data.revision,
    time: originalTime,
    mode: 'pi',
    enabled: true,
  });
  await writeFile(
    '../../.runtime/maintenance-extra-' + meta.mode + '.json',
    JSON.stringify(
      {
        passed: true,
        checks,
        at: new Date().toISOString(),
        productionWrites: false,
        externalProvidersCalled: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closePostgresDb();
}
