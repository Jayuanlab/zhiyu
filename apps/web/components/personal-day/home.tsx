'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input } from '@openzhiyu/ui';
import type { dailyView } from '@/lib/personal-day/service';
import type { maintenanceView } from '@/lib/personal-day/maintenance';
import {
  ProfileForm,
  Sources,
  FoodLibrary,
  Progress,
  errorText,
} from './index';
import { DayAutomationPanel } from './automation';
type View = Awaited<ReturnType<typeof dailyView>>;
type Maintenance = Awaited<ReturnType<typeof maintenanceView>>;
const statusText: Record<string, string> = {
  received: '已收到，等待交给车间',
  queued: '已排队，等待车间处理',
  processed: '已处理',
  needs_input: '需要补充一句信息',
  failed: '暂未处理成功',
};
const hints: Record<string, string> = {
  maintenance_boundary_denied: '车间当前权限禁止维护，请在车间核对权限。',
  maintenance_publish_denied: '车间当前不允许发布计划。',
  maintenance_not_enabled: '维护已暂停，原反馈仍保留。',
  maintenance_config_changed: '处理期间车间配置改变，结果未写入。',
  maintenance_response_invalid: '模型返回格式不符合约定，原记录保留。',
  feedback_quote_invalid: '模型未能提供原文依据，未写入。',
  feedback_number_unsupported: '模型提出的数值缺少原文依据，未写入。',
  work_result_missing: '车间已结束，但缺少保存回执；请重试或进入车间核对。',
  maintenance_failed: '模型处理失败，原反馈和原计划保留。',
  work_run_cancelled: '本次任务已取消。',
  work_run_interrupted: '本次任务已中断。',
  work_run_failed: '车间任务失败，请查看运行记录。',
  maintenance_work_required: '请通过关联车间执行理解与规划。',
};
async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: 'no-store' }),
    value = await response.json();
  if (!response.ok)
    throw Error(
      hints[value.error] ??
        errorText(Error(value.error ?? 'daily_service_unavailable')),
    );
  return value;
}
function useDaily() {
  const [data, setData] = useState<View | null>(null),
    [maintenance, setMaintenance] = useState<Maintenance | null>(null),
    [error, setError] = useState('');
  const reload = useCallback(async () => {
    const [d, m] = await Promise.all([
      request('/api/personal-day'),
      request('/api/personal-day/maintenance'),
    ]);
    setData(d);
    setMaintenance(m);
    setError('');
  }, []);
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (!document.hidden) void reload().catch((e) => setError(e.message));
    }, 10000);
    return () => clearInterval(timer);
  }, [reload]);
  const post = async (body: any) =>
    request('/api/personal-day/maintenance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personal-Day-Actor': data?.actorId ?? '',
      },
      body: JSON.stringify(body),
    });
  return { data, maintenance, error, setError, reload, post };
}
export function PersonalDayHome() {
  const { data, maintenance, error, setError, reload, post } = useDaily(),
    [date, setDate] = useState(''),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const sendId = useRef<string | null>(null),
    retries = useRef<Record<string, string>>({});
  const selected = date || data?.today || '',
    day = data?.days[selected],
    plan = day?.active,
    feedback =
      maintenance?.feedback.filter(
        (f) =>
          f.date === selected &&
          !['loop', 'source', 'maintenance'].includes(f.origin),
      ) ?? [];
  async function connect() {
    if (!data) return;
    setBusy(true);
    try {
      const result = await post({
        operation: 'configure',
        commandId: crypto.randomUUID(),
        expectedRevision: data.revision,
        enabled: false,
      });
      const id = result.result?.workId;
      if (id) window.location.href = '/workshop?workId=' + id;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!data || !text.trim() || busy) return;
    setBusy(true);
    setError('');
    sendId.current ??= crypto.randomUUID();
    try {
      const result = await post({
        operation: 'feedback',
        id: sendId.current,
        date: selected,
        text: text.trim(),
      });
      setText('');
      sendId.current = null;
      setNotice(
        result.status === 'queued'
          ? '反馈已收到，已交给车间处理。'
          : '反馈原文已保存，车间恢复后可继续处理。',
      );
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string) {
    setBusy(true);
    try {
      retries.current[id] ??= crypto.randomUUID();
      await post({ operation: 'retry', id, retryId: retries.current[id] });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main
      className="mx-auto w-full max-w-5xl space-y-6 p-7"
      aria-label="个人日计划首页"
    >
      <header className="flex items-start justify-between gap-6">
        <div>
          <p className="text-xs tracking-widest text-muted-foreground">
            每一天，按自己的节奏
          </p>
          <h1 className="mt-2 text-2xl font-semibold">个人日计划</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            看今天的安排，说说实际情况。车间会维护记录和后续计划。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void reload().catch((e) => setError(e.message))}
          >
            刷新
          </Button>
          {maintenance?.binding ? (
            <Button variant="outline" asChild>
              <a href={'/workshop?workId=' + maintenance.binding.workId}>
                进入维护车间
              </a>
            </Button>
          ) : (
            <Button disabled={busy || !data} onClick={() => void connect()}>
              设置我的日计划
            </Button>
          )}
        </div>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          {error}
        </p>
      )}
      {!data ? (
        <p role="status">正在读取日计划…</p>
      ) : (
        <>
          <nav className="flex items-center gap-3" aria-label="计划日期">
            <Button
              variant={selected === data.today ? 'default' : 'outline'}
              onClick={() => setDate(data.today)}
            >
              今天
            </Button>
            <Button
              variant={selected === data.tomorrow ? 'default' : 'outline'}
              onClick={() => setDate(data.tomorrow)}
            >
              明天
            </Button>
            <Input
              aria-label="查看日期"
              className="w-40"
              type="date"
              value={selected}
              onChange={(e) => setDate(e.target.value)}
            />
            <span className="ml-auto text-xs text-muted-foreground">
              {maintenance?.binding?.enabled
                ? maintenance.work?.status === 'active'
                  ? '由维护车间持续照看'
                  : '车间已暂停，反馈仍可保存'
                : '尚未开启自动维护'}
              {maintenance?.binding?.enabled &&
              maintenance.worker.state !== 'online'
                ? ' · 后台暂未在线，处理需等待'
                : ''}
            </span>
          </nav>
          {!maintenance?.binding && (
            <section className="rounded-xl border bg-muted/20 p-7">
              <h2 className="font-semibold">让一个车间照看你的每天</h2>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
                先在车间填写身体档案、目标与限制，确认模型使用范围，再开启维护。已有档案和历史会沿用。之后只需在这里反馈实际情况。
              </p>
            </section>
          )}
          <section className="rounded-xl border p-6" aria-label="当日有效计划">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-semibold">{selected} 的安排</h2>
              <span className="text-xs text-muted-foreground">
                {day?.pendingChange
                  ? '原计划待核对'
                  : plan
                    ? '当前有效计划'
                    : '尚无有效计划'}
              </span>
            </div>
            {day?.pendingChange && (
              <p className="mb-4 rounded-lg bg-amber-500/10 p-3 text-sm">
                {day.pendingChange}
              </p>
            )}
            {day?.paused && (
              <p className="mb-4 text-sm">这一天已暂停规划，已有结果仍保留。</p>
            )}
            {!day?.pendingChange && plan?.items.length ? (
              <div className="grid grid-cols-2 gap-4">
                {plan.items.map((item) => (
                  <article key={item.id} className="rounded-lg border p-4">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>
                        {item.kind === 'exercise'
                          ? '活动与训练'
                          : item.kind === 'meal'
                            ? '饮食建议'
                            : '已知事项'}
                      </span>
                      <span>
                        {item.flexible
                          ? '弹性安排 · 时间未确认'
                          : item.start + '—' + item.end}
                      </span>
                    </div>
                    <h3 className="mt-3 font-medium">{item.title}</h3>
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        查看建议详情
                      </summary>
                      <ul className="mt-3 list-disc space-y-2 pl-5">
                        {item.instructions.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ul>
                      {item.ingredients && (
                        <p className="mt-3 text-xs leading-6 text-muted-foreground">
                          参考份量：
                          {item.ingredients
                            .map(
                              (i) =>
                                `${i.name} ${i.grams}g（${i.state === 'raw' ? '生重' : i.state === 'cooked' ? '熟重' : '包装食品'}）`,
                            )
                            .join('、')}
                          。实际摄入以反馈为准。
                        </p>
                      )}
                    </details>
                  </article>
                ))}
              </div>
            ) : (
              <p className="py-5 text-sm leading-7 text-muted-foreground">
                {day?.pendingChange
                  ? '当天条件已变化，原计划保留供追溯；请等待车间维护后查看新的建议。'
                  : plan
                    ? '这一天暂不安排额外活动。可在下方补充实际情况。'
                    : maintenance?.binding?.enabled
                      ? '可以在下面说说今天的情况和明天已知的安排，车间会据此维护计划。时间不确定时可给出弹性建议。'
                      : '完成车间设置后，日计划会显示在这里。'}
              </p>
            )}
            {plan && (
              <details className="mt-5 border-t pt-4 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  为什么这样安排 / 当前版本
                </summary>
                <p className="mt-3 whitespace-pre-wrap leading-7">
                  {plan.reason}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  更新于 {new Date(plan.createdAt).toLocaleString('zh-CN')} ·{' '}
                  {plan.origin} {plan.provider?.model}
                </p>
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  依据：{plan.citations.join(' · ') || '未引用额外资料'}
                </p>
              </details>
            )}
          </section>
          <section
            className="rounded-xl border p-6"
            aria-label="每日自然语言反馈"
          >
            <h2 className="font-semibold">说说这一天</h2>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                aria-label="每日反馈"
                className="min-h-28 w-full resize-y rounded-lg border bg-background p-4 text-sm leading-7"
                maxLength={6000}
                value={text}
                disabled={busy || !maintenance?.binding}
                onChange={(e) => {
                  setText(e.target.value);
                  sendId.current = null;
                }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="比如：今天走了20分钟，午饭吃了牛肉面，晚上有点累。明天晚上7点以后有空。"
              />
              <div className="flex items-center justify-between gap-5">
                <p className="text-xs text-muted-foreground">
                  不必逐项打卡，没提到的内容会保留为未知。Ctrl + Enter 发送。
                </p>
                <Button
                  type="submit"
                  disabled={busy || !text.trim() || !maintenance?.binding}
                >
                  {busy ? '正在提交…' : '发送反馈'}
                </Button>
              </div>
            </form>
            {notice && (
              <p role="status" className="mt-3 text-sm">
                {notice}
              </p>
            )}
            <div className="mt-6 space-y-4">
              {feedback.map((f) => (
                <article className="rounded-lg bg-muted/25 p-4" key={f.id}>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <time>{new Date(f.createdAt).toLocaleString('zh-CN')}</time>
                    <span role="status">
                      {'runStatus' in f && f.runStatus === 'running'
                        ? '车间正在整理反馈'
                        : (statusText[f.status] ?? f.status)}
                    </span>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7">
                    {f.text}
                  </p>
                  {f.result?.summary && (
                    <p className="mt-3 border-l-2 pl-3 text-sm leading-7">
                      {f.result.summary}
                    </p>
                  )}
                  {f.result?.question && (
                    <p className="mt-2 text-sm font-medium">
                      {f.result.question}
                    </p>
                  )}
                  {f.result?.facts?.length > 0 && (
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        查看整理记录与原文依据
                      </summary>
                      <ul className="mt-3 space-y-2">
                        {f.result.facts.map((fact: any) => (
                          <li key={fact.id}>
                            {fact.date} · {fact.corrects ? '更正记录 · ' : ''}
                            {fact.quote}
                            {fact.minutes === undefined &&
                            fact.kind === 'activity'
                              ? '（时长未知）'
                              : ''}
                            {fact.kind === 'meal'
                              ? '（未补记份量及实际热量）'
                              : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {f.result?.receipt && (
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        本轮依据与运行版本
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap leading-6">
                        {f.result.modelSummary}
                      </p>
                      <p className="mt-2 break-all">
                        模型：{f.result.receipt.provider?.model} ·{' '}
                        {f.result.receipt.provider?.protocol} ·{' '}
                        {f.result.receipt.provider?.revision}
                      </p>
                      <p className="mt-1 break-all">
                        车间配置：{f.result.receipt.configHash}
                      </p>
                      <a
                        className="mt-2 inline-block underline"
                        href={'/workshop?workId=' + f.workId + '&tab=run'}
                      >
                        查看车间运行记录
                      </a>
                    </details>
                  )}
                  {f.error && (
                    <p role="alert" className="mt-3 text-sm">
                      {hints[f.error] ?? errorText(Error(f.error))}
                    </p>
                  )}
                  {['received', 'failed'].includes(f.status) && (
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      disabled={
                        busy ||
                        maintenance?.work?.status !== 'active' ||
                        !maintenance.binding?.enabled
                      }
                      onClick={() => void retry(f.id)}
                    >
                      {f.status === 'received' ? '继续处理' : '重试处理'}
                    </Button>
                  )}
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
function MaintenanceRecords({
  data,
  maintenance,
  busy,
  onCommand,
}: {
  data: View;
  maintenance: Maintenance;
  busy: string;
  onCommand: (value: any) => Promise<boolean>;
}) {
  const facts = maintenance.feedback.flatMap((f) => f.result?.facts ?? []),
    corrected = new Set(facts.map((f: any) => f.corrects).filter(Boolean)),
    current = facts.filter((f: any) => !corrected.has(f.id));
  return (
    <div className="space-y-5">
      <h2 className="font-semibold">反馈整理的实际记录</h2>
      <p className="text-sm text-muted-foreground">
        当前读取范围内有{' '}
        {current.filter((f: any) => f.kind === 'activity').length} 条活动记录、
        {current.filter((f: any) => f.kind === 'meal').length}{' '}
        条饮食记录。未报告的事项与份量保留未知，记录条数不代表完成率。
      </p>
      <p className="text-sm">
        当前用于规划的体重：{data.assessment.effectiveWeightKg ?? '未知'} kg ·{' '}
        {data.assessment.weightSource}
      </p>
      {facts.map((fact: any) => (
        <article key={fact.id} className="rounded-lg border p-4 text-sm">
          <p className="text-xs text-muted-foreground">
            {fact.date} ·{' '}
            {
              (
                {
                  activity: '活动',
                  meal: '饮食',
                  weight: '体重',
                  sleep: '睡眠',
                  readiness: '身体感受',
                } as any
              )[fact.kind]
            }
            {corrected.has(fact.id) ? ' · 已有更正，当前理解采用更正记录' : ''}
            {fact.corrects ? ' · 更正关联 ' + fact.corrects : ''}
          </p>
          <p className="mt-2 whitespace-pre-wrap leading-7">{fact.quote}</p>
          {fact.minutes !== undefined && (
            <p className="mt-2 text-xs">明确报告的时长：{fact.minutes} 分钟</p>
          )}
        </article>
      ))}
      {!facts.length && (
        <p className="text-sm text-muted-foreground">
          尚无车间整理的反馈记录。可在首页计划下直接说明实际情况。
        </p>
      )}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm">
          原有逐项记录与手动测量 / 纠错
        </summary>
        <div className="mt-5">
          <Progress data={data} busy={busy} onCommand={onCommand} />
        </div>
      </details>
      <p className="text-xs text-muted-foreground">
        {maintenance.coverage} 更正与原文一并保留，可在首页继续说明。
      </p>
    </div>
  );
}
function MaintenanceRecovery({
  data,
  busy,
  onCommand,
}: { data: View; busy: string; onCommand: (value: any) => Promise<boolean> }) {
  const [erase, setErase] = useState('');
  const changes = data.events.flatMap((e) =>
    e.kind === 'feedback_processed'
      ? (e.payload.planChanges ?? [])
          .filter((c: any) => c.before)
          .map((c: any) => ({ ...c, eventId: e.id, at: e.at }))
      : [],
  );
  return (
    <div className="mt-5 space-y-4">
      <p className="text-xs text-muted-foreground">
        恢复只取仍符合当前限制的未执行建议，保留实际记录；先生成恢复建议，再由你确认生效。
      </p>
      {changes.slice(0, 8).map((change: any) => (
        <div
          key={change.eventId + change.date}
          className="flex items-center justify-between gap-4 rounded border p-3 text-sm"
        >
          <span>
            {change.date} · 变更前版本（
            {new Date(change.at).toLocaleString('zh-CN')}）
          </span>
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() =>
              void onCommand({
                operation: 'restore',
                date: change.date,
                eventId: change.eventId,
              })
            }
          >
            取回可行建议
          </Button>
        </div>
      ))}
      {Object.entries(data.days)
        .filter(([, day]) => day.draft)
        .map(([date, day]) => (
          <div key={date} className="rounded border p-4">
            <p>
              {date} · 待核对建议：
              {day.draft?.items.map((i) => i.title).join('、')}
            </p>
            <Button
              className="mt-3"
              disabled={Boolean(busy)}
              onClick={() =>
                void onCommand({
                  operation: 'adopt',
                  date,
                  planId: day.draft!.id,
                })
              }
            >
              确认设为当前计划
            </Button>
          </div>
        ))}
      <details className="border-t pt-3">
        <summary className="cursor-pointer">删除个人日计划数据</summary>
        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          删除档案、原始反馈、计划、资料和领域历史，先暂停每日任务。车间原有对话和执行审计独立保留；首页反馈原文不写入通用车间日志。此操作不可恢复。
        </p>
        <Input
          className="mt-3"
          aria-label="删除确认文字"
          placeholder="输入：删除个人日计划全部数据"
          value={erase}
          onChange={(e) => setErase(e.target.value)}
        />
        <Button
          className="mt-3"
          variant="destructive"
          disabled={Boolean(busy) || erase !== '删除个人日计划全部数据'}
          onClick={() =>
            void onCommand({ operation: 'erase', confirmation: erase })
          }
        >
          删除全部个人日计划数据
        </Button>
      </details>
    </div>
  );
}
export function PersonalDayManagement({ workId }: { workId: string }) {
  const { data, maintenance, error, setError, reload, post } = useDaily(),
    [tab, setTab] = useState('profile'),
    [busy, setBusy] = useState(''),
    [notice, setNotice] = useState('');
  if (!data || !maintenance)
    return <p className="p-5 text-sm">{error || '正在读取维护资料…'}</p>;
  if (maintenance.binding?.workId !== workId)
    return (
      <p className="p-5 text-sm">
        此车间尚未绑定个人日计划。请从首页建立关联，避免出现两份数据。
      </p>
    );
  async function command(value: any, label = '正在保存') {
    if (!data || busy) return false;
    setBusy(label);
    setError('');
    try {
      const response = await request('/api/personal-day', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Personal-Day-Actor': data.actorId,
        },
        body: JSON.stringify({
          ...value,
          commandId: crypto.randomUUID(),
          expectedRevision: data.revision,
        }),
      });
      setNotice(
        value.operation === 'source_extract'
          ? '任务已交给车间；处理完成后这里会显示原则候选。'
          : '已保存；已开启维护时，车间会核对相关计划。',
      );
      await reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  }
  async function enable() {
    if (!data || !maintenance) return;
    setBusy('正在保存维护授权');
    try {
      const enabled = !maintenance.binding?.enabled,
        activationId = crypto.randomUUID();
      let initial: any = null;
      await post({
        operation: 'configure',
        commandId: activationId,
        expectedRevision: data.revision,
        enabled,
      });
      if (enabled) {
        const fresh = await request('/api/personal-day');
        await request('/api/personal-day/automation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Personal-Day-Actor': data.actorId,
          },
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            expectedRevision: fresh.revision,
            time: data.account.automation?.time ?? '21:00',
            mode: 'pi',
            enabled: true,
          }),
        });
        initial = await post({ operation: 'refresh', causeId: activationId });
      }
      setNotice(
        enabled
          ? initial?.status === 'queued'
            ? '维护已开启，初次计划已交给车间；每日持续任务也已配置。'
            : '维护授权已保存，初次计划尚待处理；请检查车间暂停或后台状态。'
          : '维护已暂停；原文和计划继续保留。',
      );
      await reload();
    } catch (e) {
      setError((e as Error).message);
      await reload().catch(() => {});
    } finally {
      setBusy('');
    }
  }
  return (
    <details
      className="my-5 rounded-xl border p-5"
      open={!data.account.profile || !maintenance.binding.enabled}
    >
      <summary className="cursor-pointer font-semibold">
        个人日计划 · 档案与维护设置
      </summary>
      <div className="mt-5 space-y-5">
        <p className="text-sm leading-7 text-muted-foreground">
          本车间维护首页同一份数据。修改工作方式、模型和权限请使用车间设置；每次任务读取当时实际配置。资料中的原则须由你核对采用。
        </p>
        <div className="rounded-lg bg-muted/30 p-4 text-sm leading-7">
          <p>
            开启后允许：理解你主动提交的健康反馈、保存带原文依据的记录、自动更新今日剩余和明日计划。默认每天21:00维护明日安排，使用当前模型服务；本地服务需在线。
          </p>
          <Button
            className="mt-3"
            disabled={
              Boolean(busy) ||
              (!maintenance.binding.enabled &&
                (!data.account.profile || !data.account.profile.cloudConsent))
            }
            onClick={() => void enable()}
          >
            {maintenance.binding.enabled ? '暂停维护' : '开启维护与每日计划'}
          </Button>
          <a className="ml-5 underline" href="/?page=home">
            回首页看计划与反馈
          </a>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <nav className="flex gap-2" aria-label="个人日计划维护资料">
          {[
            ['profile', '身体档案'],
            ['sources', '知识与依据'],
            ['foods', '食物资料'],
            ['progress', '详细记录'],
            ['automation', '每日持续任务'],
          ].map(([key, label]) => (
            <Button
              key={key}
              variant={tab === key ? 'default' : 'outline'}
              onClick={() => setTab(key)}
            >
              {label}
            </Button>
          ))}
        </nav>
        {tab === 'profile' && (
          <ProfileForm
            key={data.actorId}
            profile={data.account.profile}
            busy={busy}
            onSave={(profile) =>
              command({ operation: 'profile_save', profile })
            }
          />
        )}
        {tab === 'sources' && (
          <Sources
            data={data}
            busy={busy}
            onCommand={command}
            onUploaded={reload}
            onBusy={setBusy}
            onError={setError}
          />
        )}
        {tab === 'foods' && (
          <FoodLibrary
            data={data}
            busy={busy}
            onSave={(food) => command({ operation: 'food_save', food })}
          />
        )}
        {tab === 'progress' && (
          <MaintenanceRecords
            data={data}
            maintenance={maintenance}
            busy={busy}
            onCommand={command}
          />
        )}
        {tab === 'automation' && (
          <DayAutomationPanel
            revision={data.revision}
            actorId={data.actorId}
            busy={busy}
            onSaved={reload}
            onError={setError}
          />
        )}
        <details className="border-t pt-4 text-sm">
          <summary className="cursor-pointer">数据与人工接管</summary>
          <p className="mt-3 leading-7">
            反馈理解不对时，在首页继续说明更正；原文不改写。可在此车间暂停、调整工作方式和权限，查看任务日志。保存规则不代表已有计划已重新生成。
          </p>
          <a
            className="mt-3 inline-block underline"
            href="/api/personal-day/export"
          >
            导出完整个人日计划数据
          </a>
          <MaintenanceRecovery data={data} busy={busy} onCommand={command} />
        </details>
      </div>
    </details>
  );
}
