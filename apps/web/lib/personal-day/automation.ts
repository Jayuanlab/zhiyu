import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createWork,
  createWorkLoop,
  updateWorkLoop,
  getWorkSummarySnapshot,
} from '@/lib/work-runtime';
import { getWorkshop } from '@/lib/workshops/service';
import { getWorkCommand } from '@/lib/work-runtime/command-ledger';
import {
  getLoopInWorkshop,
  getLoopState,
  listLoopRuns,
} from '@/lib/loops/service';
import { getEffectiveNextLoopRun } from '@/lib/loops/schedule';
import { resolveExecutionLease } from '@/lib/work-runtime/execution-context';
import { withLinkedLoopWrite } from '@/lib/work-runtime/loop-execution';
import type { Loop } from '@/lib/db/schema';
import type { JobExecutionResult } from '@/lib/cron/types';
import { DayError, businessDate, nextDate, timeSchema } from './contracts';
import { readDaySnapshot, dayTransaction, failDayCommand } from './store';
import { executeDayCommand } from './service';
import { assertDailyAutomationBoundary } from './boundary';
import { getRuntimeWorkerStatus } from '@/lib/runtime/worker-status';
const idFrom = (text: string) => {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const schema = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    time: timeSchema,
    mode: z.enum(['pi', 'catalog']),
    enabled: z.boolean(),
  })
  .strict();
export async function configureDayAutomation(owner: string, value: unknown) {
  const input = schema.parse(value),
    command = { ...input, operation: 'automation_configure' };
  const reserved = await dayTransaction(
    owner,
    command,
    (snapshot) => {
      if (!snapshot.account.profile) throw new DayError('profile_required');
      if (
        input.enabled &&
        input.mode === 'pi' &&
        !snapshot.account.profile.cloudConsent
      )
        throw new DayError('health_cloud_consent_required', 403);
      return { result: snapshot };
    },
    { reserve: true },
  );
  if (reserved.replayed) return reserved;
  try {
    const before = reserved.result as Awaited<
      ReturnType<typeof readDaySnapshot>
    >;
    let automation = before.account.automation;
    if (!automation) {
      if (!input.enabled) throw new DayError('automation_not_created');
      const work = await createWork({
        commandId: idFrom(owner + ':personal-day-work:v1'),
        source: 'owner',
        reason: '用户在个人日计划页面明确开启明日草稿持续任务。',
        input: {
          userId: owner,
          name: '个人日计划',
          mission:
            '按所有者的长期目标与每日已知条件，协作健身与饮食规划，只通过关联 Loop 的宿主领域控制器保存草稿，采用始终交给主人。只读取获授权的健康字段，不发送消息、不操作日历、不执行命令、不改写原始事实。',
          status: 'active',
          autonomyLevel: 'draft',
          boundaryPolicy: {
            mode: 'draft',
            externalMessages: 'blocked',
            hardDeniedActions: [
              'personalDayAdopt',
              'sendMessage',
              'bash',
              'delete',
            ],
            deniedPrecedence: true,
          },
          modelConfig: {
            role: 'personal_daily_planner',
            agentRuntime: 'pi',
            allowedTools: ['personalDayDraft'],
            disallowedTools: [
              'personalDayAdopt',
              'sendMessage',
              'bash',
              'delete',
            ],
            maxTurns: 1,
          },
        },
      });
      const baseline = await getWorkSummarySnapshot({
        userId: owner,
        workId: work.id,
      });
      if (!baseline) throw new DayError('automation_work_unavailable');
      const loopCommandId = idFrom(owner + ':personal-day-loop:v1');
      const existingLoopCommand = await getWorkCommand(owner, loopCommandId);
      const created = await createWorkLoop({
        userId: owner,
        workId: work.id,
        commandId: loopCommandId,
        expectedVersion:
          existingLoopCommand?.expectedVersion ??
          baseline.detail.commandVersion,
        type: 'template',
        templateId: 'personal-day-plan',
        templateInput: {
          timezone: 'Asia/Shanghai',
          cronExpression: '0 21 * * *',
        },
        source: 'owner',
        reason: '明确开启只生成草稿的持续任务。',
      });
      if (!('loop' in created))
        throw new DayError('automation_loop_unavailable');
      automation = {
        workId: work.id,
        loopId: created.loop.id,
        time: input.time,
        mode: input.mode,
        enabled: input.enabled,
      };
    }
    const baseline = await getWorkSummarySnapshot({
      userId: owner,
      workId: automation.workId,
    });
    if (!baseline) throw new DayError('automation_work_unavailable');
    const [hour, minutes] = input.time.split(':').map(Number);
    await updateWorkLoop({
      userId: owner,
      workId: automation.workId,
      loopId: automation.loopId,
      commandId: idFrom(input.commandId + ':loop-update'),
      expectedVersion: baseline.detail.commandVersion,
      source: 'owner',
      reason: '用户修改明日草稿时段、模式或启停状态。',
      patch: {
        status: input.enabled ? 'active' : 'paused',
        triggerConfig: {
          type: 'cron',
          expression: `${minutes} ${hour} * * *`,
          timezone: 'Asia/Shanghai',
        },
      },
    });
    const next = {
      ...automation,
      time: input.time,
      mode: input.mode,
      enabled: input.enabled,
    };
    return await dayTransaction(
      owner,
      command,
      (snapshot) => ({
        account: { ...snapshot.account, automation: next },
        event: { kind: 'automation_configured', payload: next },
        result: next,
      }),
      { finish: true },
    );
  } catch (error) {
    await failDayCommand(
      owner,
      input.commandId,
      error instanceof DayError
        ? error.code
        : 'automation_configuration_failed',
    );
    throw error;
  }
}
export async function dayAutomationStatus(owner: string) {
  const snapshot = await readDaySnapshot(owner),
    binding = snapshot.account.automation;
  if (!binding) return null;
  const loop = await getLoopInWorkshop({
    userId: owner,
    workshopId: binding.workId,
    loopId: binding.loopId,
  });
  if (!loop)
    return { ...binding, state: 'unavailable', warning: '关联 Loop 不可用' };
  const [state, runs, worker] = await Promise.all([
    getLoopState(loop.id),
    listLoopRuns(loop.id, { limit: 1 }),
    getRuntimeWorkerStatus(owner),
  ]);
  return {
    ...binding,
    worker: {
      state: worker.state,
      heartbeatAt: worker.heartbeatAt,
      warning: worker.warning,
    },
    state: loop.status,
    lastRunAt: runs[0]?.startedAt ?? null,
    nextRunAt:
      loop.status === 'active'
        ? getEffectiveNextLoopRun({
            triggerConfig: loop.triggerConfig,
            stateJson: (state?.stateJson ?? {}) as any,
            baseline: state?.updatedAt ?? loop.updatedAt ?? loop.createdAt,
          })
        : null,
    lastError: runs[0]?.error ?? null,
    lastRunStatus: runs[0]?.status ?? null,
    updatedAt: state?.updatedAt ?? null,
    loopState: state?.currentPhase ?? 'idle',
  };
}
export async function pauseAutomationForErase(
  owner: string,
  commandId: string,
) {
  const snapshot = await readDaySnapshot(owner),
    binding = snapshot.account.automation;
  if (!binding) return;
  const baseline = await getWorkSummarySnapshot({
    userId: owner,
    workId: binding.workId,
  });
  if (!baseline) throw new DayError('automation_work_unavailable');
  await updateWorkLoop({
    userId: owner,
    workId: binding.workId,
    loopId: binding.loopId,
    commandId: idFrom(commandId + ':erase-pause'),
    expectedVersion: baseline.detail.commandVersion,
    source: 'owner',
    reason: '用户删除个人日计划数据，先停止后续草稿任务。',
    patch: { status: 'paused' },
  });
}
/** Runs inside the existing Work lease and Loop runtime, not a second scheduler. */
export async function executePersonalDayLoop(input: {
  owner: string;
  loop: Loop;
  runId: string;
  signal: AbortSignal;
}): Promise<JobExecutionResult> {
  const started = Date.now(),
    lease = resolveExecutionLease();
  if (
    !lease ||
    lease.userId !== input.owner ||
    lease.workshopId !== input.loop.workshopId
  )
    throw new DayError('execution_lease_required', 403);
  await withLinkedLoopWrite(input.loop.id, async () => undefined);
  const work = await getWorkshop(input.owner, input.loop.workshopId!);
  assertDailyAutomationBoundary(work, input.loop);
  const snapshot = await readDaySnapshot(input.owner),
    binding = snapshot.account.automation,
    date = nextDate(businessDate());
  if (
    !binding?.enabled ||
    binding.loopId !== input.loop.id ||
    binding.workId !== work!.id
  )
    throw new DayError('automation_paused', 409);
  const day = snapshot.days[date];
  let receipt: any = { state: 'needs_input', date },
    summary = '尚未确认明日时间条件，未生成草稿。';
  if (day?.paused) {
    receipt = { state: 'paused', date };
    summary = '明日计划已暂停，未生成草稿。';
  } else if (day?.active || day?.draft) {
    receipt = {
      state: 'existing_plan_preserved',
      date,
      planId: day.active?.id ?? day.draft?.id,
    };
    summary = '已有明日安排或待采用草稿，已保留，没有重复生成。';
  } else if (day?.context.windows.length && snapshot.account.profile) {
    input.signal.throwIfAborted();
    const result = await executeDayCommand(
      input.owner,
      {
        operation: 'generate',
        commandId: idFrom(input.runId + ':daily-draft'),
        expectedRevision: snapshot.revision,
        date,
        mode: binding.mode,
        reason: '用户授权的持续任务：仅生成明日草稿，等待用户核对采用。',
      },
      input.signal,
    );
    receipt = { state: 'draft_saved', date, ...result.result };
    summary = '明日个人日计划草稿已保存，等待用户采用。';
  }
  return {
    status: 'success',
    duration: Date.now() - started,
    output: summary,
    result: {
      summary,
      nextActions: ['在个人日计划页核对明日草稿或补充已知条件。'],
      personalDayReceipt: receipt,
      actionsExecuted:
        receipt.state === 'draft_saved' ? ['personalDayDraft'] : [],
    },
  };
}
