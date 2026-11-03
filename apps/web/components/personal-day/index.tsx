'use client';
import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@openzhiyu/ui';
import { RemixIcon } from '@/components/remix-icon';
import {
  DEFAULT_PROFILE,
  emptyDay,
  businessDate,
  minute,
  clock,
  type HealthProfile,
  type DayContext,
  type DayItem,
  type Food,
  type MealIngredient,
  type TrainingRecord,
  type Command,
} from '@/lib/personal-day/contracts';
import { nutritionSummary } from '@/lib/personal-day/catalog';
import type { dailyView } from '@/lib/personal-day/service';
import { DayAutomationPanel } from './automation';
type View = Awaited<ReturnType<typeof dailyView>>;
const selectClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';
const areaClass = 'min-h-24 w-full rounded-md border bg-background p-3 text-sm';
const errors: Record<string, string> = {
  another_command_pending: '另一项生成或资料处理尚未结束，请查询进行中的操作。',
  command_still_running: '原操作仍在有效处理时间内，请稍后查询。',
  interrupted_command_released:
    '中断标记已解除；需要时请明确重新发起，系统不会自动重发。',
  source_extract_invalid: '模型没有返回合规的原则候选，资料未被自动采用。',
  plan_duration_too_short:
    '时间不足以容纳这项活动及准备，请使用合适的目录选项。',
  profile_required: '请先保存身体档案。',
  day_context_required: '请先保存这一天的时间与就餐条件。',
  version_conflict: '数据已变化，请刷新并按最新记录操作。',
  command_conflict: '该操作标识已用于其他输入，请查询原操作。',
  command_pending: '这次生成仍在处理，可查询原操作，请勿重复提交。',
  command_failed: '原操作已失败，请查看原因后明确重试。',
  model_not_configured: '尚未配置默认模型，请到模型配置中心选择默认连接。',
  health_cloud_consent_required:
    '请在身体档案中确认健康信息发送至当前模型服务的范围。',
  generation_timed_out: '生成等待已超时，可查询原操作结果。',
  generation_failed: '模型调用失败；原有记录仍保留。',
  planner_response_invalid: '模型没有返回合规的日计划，未产生可采用安排。',
  plan_constraint_conflict:
    '方案与当前时间、地点或限制有冲突，请调整条件后重试。',
  plan_time_conflict: '安排存在时间重叠，请修改时间。',
  plan_time_expired: '候选中有已过时的安排，请按当前时间重新规划。',
  draft_stale: '生成后数据发生变化，旧草稿不能采用，请重新生成。',
  execution_fact_locked: '已确认的执行事实已锁定；如有错误，请补充更正记录。',
  day_needs_review: '这一天已暂停或条件变化，请先核对剩余安排。',
  day_paused: '日计划已暂停，请先恢复。',
  exercise_restricted: '该训练不符合当前状态或限制，未采用。',
  meal_restricted: '该餐食不符合过敏、偏好或就餐条件，未采用。',
  fixed_item_locked: '固定事项不能由模型移动或删除。',
  availability_expansion_denied: '模型不能擅自扩大你确认的空闲时间。',
  readiness_change_denied:
    '模型不能擅自改写你确认的身体状态，请在当天条件中亲自更正。',
  planner_citation_denied: '模型引用了未采用的资料，已拒绝。',
  item_cannot_defer: '餐食、固定事项和已开始事项不能直接挪到明天。',
  future_execution_denied: '明日安排不能提前记为实际完成。',
  source_conversion_failed:
    '文件未成功转换。扫描 PDF 可能需要 OCR，请换用可提取文字的资料。',
  source_principles_required: '请核对并填写至少一条适用原则。',
  source_already_approved: '该资料原则正在采用中；如需重新提取，请先撤销采用。',
  source_size_limit: '请选择 5 MB 以内的非空资料。',
  source_text_limit: '资料文字过多，请按章节拆分后导入。',
  source_format_unsupported: '支持 Markdown、TXT、PDF、DOCX 和 EPUB。',
  daily_service_unavailable:
    '服务暂时不可用，记录未显示成功。请刷新或稍后重试。',
  restore_not_available: '没有可恢复的旧安排，或历史已超出当前读取范围。',
  day_outside_planning_horizon: '当前只为今日和明日生成或调整计划。',
};
export function errorText(error: unknown) {
  return error instanceof Error
    ? (errors[error.message] ?? error.message)
    : '操作失败，请重试。';
}
async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...init?.headers },
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok)
    throw Error(
      data.error === 'invalid_input'
        ? `填写内容不完整或格式有误：${data.fields?.join('、') ?? ''}`
        : (data.error ?? 'daily_service_unavailable'),
    );
  return data;
}
function Field({
  label,
  children,
  hint,
}: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="space-y-2 text-sm">
      <span className="block font-medium">{label}</span>
      {children}
      {hint && (
        <span className="block text-xs leading-5 text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}
function Note({
  children,
  warning = false,
}: { children: React.ReactNode; warning?: boolean }) {
  return (
    <div
      className={`rounded-lg border p-3 text-sm leading-6 ${warning ? 'border-amber-500/35 bg-amber-500/5' : 'bg-muted/25'}`}
    >
      {children}
    </div>
  );
}
const split = (value: string) =>
  value
    .split(/[、,，\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
const statusNames = {
  planned: '待执行',
  in_progress: '进行中',
  completed: '已完成',
  partial: '部分完成',
  skipped: '确认没做',
  canceled: '已取消',
};
export function PersonalDay() {
  const [data, setData] = useState<View | null>(null),
    [tab, setTab] = useState('plan'),
    [date, setDate] = useState(''),
    [sub, setSub] = useState('today'),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reason, setReason] = useState('根据已确认条件安排这一天。'),
    [lastCommand, setLastCommand] = useState(''),
    [record, setRecord] = useState<DayItem | null>(null),
    [manualOpen, setManualOpen] = useState(false),
    [erase, setErase] = useState('');
  async function reload() {
    const value = await api<View>('/api/personal-day');
    setData(value);
    setDate((d) => d || value.today);
  }
  useEffect(() => {
    void reload().catch((e) => setError(errorText(e)));
    const id = sessionStorage.getItem('personal-day-last-command');
    if (id) setLastCommand(id);
  }, []);
  async function send(payload: Record<string, unknown>, label = '正在保存') {
    if (!data || busy) return false;
    setBusy(label);
    setError('');
    setNotice('');
    const id = crypto.randomUUID();
    setLastCommand(id);
    sessionStorage.setItem('personal-day-last-command', id);
    try {
      await api('/api/personal-day', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Personal-Day-Actor': data.actorId,
        },
        body: JSON.stringify({
          commandId: id,
          expectedRevision: data.revision,
          ...payload,
        }),
      });
      await reload();
      setNotice(
        payload.operation === 'generate'
          ? '草稿已生成，请核对后采用。'
          : payload.operation === 'adopt'
            ? '已采用，后续按这一版安排执行。'
            : '已保存。',
      );
      return true;
    } catch (e) {
      setError(errorText(e));
      await reload().catch(() => {});
      return false;
    } finally {
      setBusy('');
    }
  }
  async function query() {
    if (!lastCommand) return;
    try {
      const result = await api('/api/personal-day/commands/' + lastCommand);
      setNotice(
        result.state === 'completed'
          ? '原操作已完成，已重新读取。'
          : result.state === 'failed'
            ? '原操作失败：' +
              (errors[result.result?.error] ??
                result.result?.error ??
                '请重新尝试')
            : '操作仍在处理；不会自动重复提交。',
      );
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }
  const day = data?.days[date] ?? emptyDay(date),
    active = day.active,
    draft = day.draft,
    profile = data?.account.profile;
  const chooseDate = (value: 'today' | 'tomorrow' | 'history') => {
    setSub(value);
    if (data && value !== 'history')
      setDate(value === 'today' ? data.today : data.tomorrow);
  };
  const tabs = [
    ['plan', '日计划', 'calendar_2'],
    ['profile', '身体档案', 'user_3'],
    ['exercise', '训练', 'walk'],
    ['diet', '饮食', 'restaurant'],
    ['sources', '资料与依据', 'book_2'],
    ['progress', '进展与记录', 'line_chart'],
  ];
  return (
    <div className="space-y-6 pb-8" aria-busy={Boolean(busy)}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs text-muted-foreground">
            生活 / 个人日计划
          </p>
          <h1 className="text-2xl font-semibold">
            把明天安排好，让今天可以调整
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            身体档案、训练与饮食共享一份真实记录。计划变化时，保留已经完成的部分。
          </p>
        </div>
        <Button
          variant="outline"
          disabled={Boolean(busy)}
          onClick={() => void reload().catch((e) => setError(errorText(e)))}
        >
          刷新
        </Button>
      </header>
      <nav
        className="flex flex-wrap gap-2 border-b pb-4"
        aria-label="个人日计划分区"
      >
        {tabs.map(([id, name, icon]) => (
          <Button
            key={id}
            variant={tab === id ? 'default' : 'ghost'}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            <RemixIcon name={icon} />
            {name}
          </Button>
        ))}
      </nav>
      {error && (
        <div role="alert">
          <Note warning>{error}</Note>
        </div>
      )}
      {notice && (
        <div role="status">
          <Note>{notice}</Note>
        </div>
      )}
      {busy && (
        <Note>
          {busy}…{' '}
          {lastCommand && (
            <button className="ml-2 underline" onClick={() => void query()}>
              查询本次操作
            </button>
          )}
        </Note>
      )}
      {!data && !error && (
        <p className="text-sm text-muted-foreground">正在读取个人日计划…</p>
      )}
      {data && (
        <>
          {data.pendingCommands.map(
            (command: { id: string; createdAt: string; stale: boolean }) => (
              <Note key={command.id} warning>
                <p>
                  有一项尚未确认完成的操作 ·{' '}
                  {new Date(command.createdAt).toLocaleString('zh-CN')}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setLastCommand(command.id);
                      void api('/api/personal-day/commands/' + command.id)
                        .then((result) => {
                          setNotice(
                            result.state === 'pending'
                              ? '仍在处理或中断待确认；不会自动重复提交。'
                              : '原操作已返回结果。',
                          );
                          return reload();
                        })
                        .catch((e) => setError(errorText(e)));
                    }}
                  >
                    查询该操作
                  </Button>
                  {command.stale && (
                    <Button
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void send({
                          operation: 'release_command',
                          targetId: command.id,
                        })
                      }
                    >
                      解除中断标记（不会自动重试）
                    </Button>
                  )}
                </div>
              </Note>
            ),
          )}
          {tab === 'profile' && (
            <ProfileForm
              key={profile ? data.revision : 'empty'}
              profile={profile ?? null}
              busy={busy}
              onSave={(value) =>
                send({ operation: 'profile_save', profile: value })
              }
            />
          )}
          {!profile && tab !== 'profile' && (
            <Note>
              <div className="space-y-3">
                <p>
                  先建立身体档案，确认目标、饮食限制和数据使用范围，再安排训练与饮食。这里不会预填你的身体事实。
                </p>
                <Button onClick={() => setTab('profile')}>建立身体档案</Button>
              </div>
            </Note>
          )}
          {(tab === 'plan' || tab === 'exercise' || tab === 'diet') && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-2" aria-label="计划日期">
                  <Button
                    variant={sub === 'today' ? 'default' : 'outline'}
                    onClick={() => chooseDate('today')}
                  >
                    今日 · {data.today}
                  </Button>
                  <Button
                    variant={sub === 'tomorrow' ? 'default' : 'outline'}
                    onClick={() => chooseDate('tomorrow')}
                  >
                    明日 · {data.tomorrow}
                  </Button>
                  {tab === 'plan' && (
                    <Button
                      variant={sub === 'history' ? 'default' : 'outline'}
                      onClick={() => chooseDate('history')}
                    >
                      调整记录
                    </Button>
                  )}
                </div>
                {sub !== 'history' && profile && (
                  <Button
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void send({
                        operation: 'pause',
                        date,
                        paused: !day.paused,
                      })
                    }
                  >
                    {day.paused ? '恢复日计划' : '暂停日计划'}
                  </Button>
                )}
              </div>
              {sub === 'history' ? (
                <History
                  data={data}
                  busy={busy}
                  onRestore={(eventId, date) =>
                    send({ operation: 'restore', eventId, date })
                  }
                />
              ) : (
                <>
                  {day.paused && (
                    <Note warning>
                      这一天已暂停。可以继续记录实际情况，恢复后再安排新的执行。
                    </Note>
                  )}
                  {day.pendingChange && (
                    <Note warning>
                      {day.pendingChange}{' '}
                      已完成记录保留；采用调整前请核对受影响的安排。
                      <Button
                        className="mt-2"
                        variant="outline"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void send({ operation: 'keep_plan', date })
                        }
                      >
                        放弃调整，核对后沿用原安排
                      </Button>
                    </Note>
                  )}
                  {tab === 'plan' && profile && (
                    <ContextForm
                      key={date + ':' + JSON.stringify(day.context)}
                      context={day.context}
                      busy={busy}
                      onSave={(context) =>
                        send({ operation: 'context_save', context })
                      }
                    />
                  )}
                  {tab === 'plan' && profile && (
                    <DayAutomationPanel
                      revision={data.revision}
                      actorId={data.actorId}
                      busy={busy}
                      onSaved={reload}
                      onError={setError}
                    />
                  )}
                  {profile && (
                    <section className="space-y-4 rounded-xl border p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="font-semibold">
                          {active
                            ? '情况变了，调整剩余安排'
                            : '生成这一天的安排'}
                        </h2>
                        <span className="text-xs text-muted-foreground">
                          同一次操作可查询，刷新不会自动重发
                        </span>
                      </div>
                      <Field
                        label="安排要求或发生了什么变化"
                        hint="例如：今晚加班到 21 点，只能在家活动，晚饭改外食。使用目录排布时，请先把上方时间与条件填准确。"
                      >
                        <textarea
                          className={areaClass}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={1000}
                        />
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={Boolean(busy) || day.paused}
                          onClick={() =>
                            void send(
                              {
                                operation: 'generate',
                                date,
                                mode: 'pi',
                                reason,
                              },
                              'Pi 正在生成并核对日计划',
                            )
                          }
                        >
                          Pi 生成{active ? '调整草稿' : '日计划'}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={Boolean(busy) || day.paused}
                          onClick={() =>
                            void send(
                              {
                                operation: 'generate',
                                date,
                                mode: 'catalog',
                                reason,
                              },
                              '正在按已确认窗口排布',
                            )
                          }
                        >
                          按目录排布（不调用模型）
                        </Button>
                        <Button
                          variant="outline"
                          disabled={Boolean(busy) || day.paused}
                          onClick={() => setManualOpen(true)}
                        >
                          手动添加安排
                        </Button>
                        {lastCommand && (
                          <Button variant="ghost" onClick={() => void query()}>
                            查询上次操作
                          </Button>
                        )}
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        Pi
                        使用配置中心的默认智能体模型。健康信息仅在你同意后发送；生成会使用模型服务额度。目录排布有明确来源标识，不会伪装成
                        AI 结果。
                      </p>
                    </section>
                  )}
                  {draft && (
                    <PlanPanel
                      title="待采用的草稿"
                      plan={draft}
                      day={day}
                      data={data}
                      filter={tab}
                      draft
                      onAdopt={() =>
                        void send({
                          operation: 'adopt',
                          date,
                          planId: draft.id,
                        })
                      }
                      busy={busy}
                      onRecord={() => {}}
                      onStart={() => {}}
                      onDefer={() => {}}
                    />
                  )}
                  {active ? (
                    <PlanPanel
                      title="当前已采用安排"
                      plan={active}
                      day={day}
                      data={data}
                      filter={tab}
                      busy={busy}
                      onRecord={setRecord}
                      onStart={(item) =>
                        void send({
                          operation: 'record',
                          date,
                          itemId: item.id,
                          status: 'in_progress',
                          note: '',
                        })
                      }
                      onDefer={(item) =>
                        void send({
                          operation: 'defer',
                          date,
                          itemId: item.id,
                          target: data.tomorrow,
                          reason: '用户明确加入明日待评估。',
                        })
                      }
                    />
                  ) : (
                    <Note>
                      这一天还没有已采用的计划。可以先保存已知时间条件，再生成或手动安排。没有确认的空闲时间会保持未知。
                    </Note>
                  )}
                  {day.deferred.length > 0 && (
                    <section className="space-y-3 rounded-xl border p-5">
                      <h2 className="font-semibold">明日待评估事项</h2>
                      {day.deferred.map((item) => (
                        <p key={item.id} className="text-sm">
                          {item.title} · 来自 {item.fromDate}
                          。尚未排定，生成时结合新的时间和状态评估。
                        </p>
                      ))}
                    </section>
                  )}
                  {tab === 'exercise' && (
                    <section className="space-y-4">
                      <h2 className="font-semibold">动作与活动目录</h2>
                      {data.catalog.exercises.map((e) => (
                        <div key={e.id} className="border-b pb-4">
                          <h3 className="text-sm font-medium">
                            {e.name} · 约 {e.minutes} 分钟
                          </h3>
                          <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            {e.steps.join(' ')}
                          </p>
                          <a
                            className="text-xs underline"
                            href={e.source}
                            target="_blank"
                            rel="noreferrer"
                          >
                            查看动作参考
                          </a>
                        </div>
                      ))}
                    </section>
                  )}
                  {tab === 'diet' && (
                    <FoodLibrary
                      data={data}
                      busy={busy}
                      onSave={(food) => send({ operation: 'food_save', food })}
                    />
                  )}
                </>
              )}
            </>
          )}
          {tab === 'sources' && (
            <Sources
              data={data}
              busy={busy}
              onCommand={send}
              onUploaded={reload}
              onBusy={setBusy}
              onError={setError}
            />
          )}
          {tab === 'progress' && (
            <Progress data={data} busy={busy} onCommand={send} />
          )}
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground">
            <span>
              本机私有记录 · 数据版本 {data.revision} · 当前只具体安排今日与明日
            </span>
            <a href="/api/personal-day/export" className="underline">
              导出个人日计划数据
            </a>
          </footer>
          {tab === 'profile' && (
            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer text-sm">
                数据删除与备份说明
              </summary>
              <p className="my-3 text-sm leading-6 text-muted-foreground">
                删除会清除本模块在线数据库中的档案、计划、原始记录和资料。部署备份按本机备份策略保留；已经发送给模型服务的数据无法通过本地删除撤回。可先导出。
              </p>
              <Field label="输入“删除个人日计划全部数据”确认">
                <Input
                  value={erase}
                  onChange={(e) => setErase(e.target.value)}
                />
              </Field>
              <Button
                className="mt-3"
                variant="destructive"
                disabled={Boolean(busy) || erase !== '删除个人日计划全部数据'}
                onClick={() =>
                  void send({ operation: 'erase', confirmation: erase }).then(
                    (ok) => {
                      if (ok) setErase('');
                    },
                  )
                }
              >
                删除本模块在线数据
              </Button>
            </details>
          )}
        </>
      )}
      {record && data && (
        <RecordDialog
          item={record}
          foods={data.account.foods}
          busy={busy}
          onClose={() => setRecord(null)}
          onSave={(values) =>
            send({
              operation:
                record.actual &&
                ['completed', 'partial', 'skipped', 'canceled'].includes(
                  record.status,
                )
                  ? 'record_correct'
                  : 'record',
              ...(record.actual &&
              ['completed', 'partial', 'skipped', 'canceled'].includes(
                record.status,
              )
                ? { previousAt: record.actual.at }
                : {}),
              date,
              itemId: record.id,
              ...values,
            }).then((ok) => {
              if (ok) setRecord(null);
              return ok;
            })
          }
        />
      )}
      {manualOpen && data && (
        <ManualDialog
          data={data}
          date={date}
          busy={busy}
          onClose={() => setManualOpen(false)}
          onSave={(items) =>
            send({
              operation: 'manual_plan',
              date,
              items,
              reason: '用户手动安排',
            }).then((ok) => {
              if (ok) setManualOpen(false);
              return ok;
            })
          }
        />
      )}
    </div>
  );
}

export function ProfileForm({
  profile,
  busy,
  onSave,
}: {
  profile: HealthProfile | null;
  busy: string;
  onSave: (v: HealthProfile) => Promise<boolean>;
}) {
  const [value, setValue] = useState({ ...DEFAULT_PROFILE, ...profile }),
    [age, setAge] = useState(profile ? String(profile.age) : ''),
    [height, setHeight] = useState(profile ? String(profile.heightCm) : ''),
    [weight, setWeight] = useState(profile ? String(profile.weightKg) : ''),
    [allergies, setAllergies] = useState(profile?.allergies.join('、') ?? ''),
    [dislikes, setDislikes] = useState(profile?.dislikes.join('、') ?? '');
  const patch = (key: keyof HealthProfile, v: any) =>
    setValue((old) => ({ ...old, [key]: v }));
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({
          ...value,
          age: Number(age),
          heightCm: Number(height),
          weightKg: Number(weight),
          allergies: split(allergies),
          dislikes: split(dislikes),
        });
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">身体档案与规划边界</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          以一般成年人的日常健身和膳食管理为范围。有特殊运动或治疗饮食要求时，先保留明确限制，系统不会自动开出训练处方。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-5">
        <Field label="年龄">
          <Input
            required
            type="number"
            min={18}
            max={120}
            value={age}
            onChange={(e) => setAge(e.target.value)}
          />
        </Field>
        <Field label="当前目标">
          <select
            className={selectClass}
            value={value.goal}
            onChange={(e) => patch('goal', e.target.value)}
          >
            <option value="habit">建立习惯</option>
            <option value="fitness">改善体能</option>
            <option value="muscle">增肌方向</option>
            <option value="fat_loss">减脂方向</option>
          </select>
        </Field>
        <Field label="身高（厘米）">
          <Input
            required
            type="number"
            min={50}
            max={250}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
          />
        </Field>
        <Field
          label="档案体重（公斤）"
          hint="作为用户录入的基线；后续测量在进展页单独记录。"
        >
          <Input
            required
            type="number"
            step="0.1"
            min={20}
            max={400}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
        </Field>
        <Field label="训练经验">
          <select
            className={selectClass}
            value={value.experience}
            onChange={(e) => patch('experience', e.target.value)}
          >
            <option value="beginner">刚开始或重新开始</option>
            <option value="regular">有规律训练经验</option>
          </select>
        </Field>
        <Field label="主要就餐方式">
          <select
            className={selectClass}
            value={value.mealStyle}
            onChange={(e) => patch('mealStyle', e.target.value)}
          >
            <option value="mixed">做饭与外食结合</option>
            <option value="cook">主要自己做饭</option>
            <option value="outside">主要外食</option>
          </select>
        </Field>
        <Field
          label="过敏与不耐受"
          hint="多个条件用顿号或逗号分开；与不喜欢的食物分别保存。"
        >
          <Input
            value={allergies}
            onChange={(e) => setAllergies(e.target.value)}
            placeholder="如：鸡蛋、大豆"
          />
        </Field>
        <Field label="不喜欢的食物">
          <Input
            value={dislikes}
            onChange={(e) => setDislikes(e.target.value)}
          />
        </Field>
        <Field
          label="每日餐食预算（元）"
          hint="作为规划约束说明；本机目录没有实时价格，不宣称预算已被精确核验。"
        >
          <Input
            type="number"
            min={0}
            value={value.budgetYuan}
            onChange={(e) => patch('budgetYuan', Number(e.target.value))}
          />
        </Field>
        <Field label="现有器械">
          <div className="flex flex-wrap gap-4 py-2">
            {[
              ['none', '无需器械'],
              ['chair', '稳固椅子'],
              ['gym', '健身房'],
            ].map(([id, name]) => (
              <label className="flex items-center gap-2" key={id}>
                <input
                  type="checkbox"
                  checked={value.equipment.includes(id as any)}
                  onChange={(e) =>
                    patch(
                      'equipment',
                      e.target.checked
                        ? [...value.equipment, id]
                        : value.equipment.filter((i) => i !== id),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </div>
        </Field>
      </div>
      <Field
        label="明确的运动或健康限制"
        hint="存在限制或当日疼痛时，自动规划不安排训练。请先与专业要求核对，可保留日常记录与餐食规划。"
      >
        <textarea
          className={areaClass}
          value={value.restrictions}
          onChange={(e) => patch('restrictions', e.target.value)}
          maxLength={1000}
        />
      </Field>
      <Field label="其他生活偏好">
        <textarea
          className={areaClass}
          value={value.notes}
          onChange={(e) => patch('notes', e.target.value)}
          maxLength={1000}
        />
      </Field>
      <Note>
        <div className="space-y-3">
          <p>
            档案、计划、资料与原始记录的正文在本机数据库加密保存。调用 Pi
            时，规划所需的身体信息、限制和执行摘要会发送到模型配置中心选定的服务；结构化固定事项的标题会隐藏；你在反馈中主动提供的文字会发送给已配置模型。
          </p>
          <label className="flex items-start gap-2">
            <input
              className="mt-1"
              type="checkbox"
              checked={value.cloudConsent}
              onChange={(e) => patch('cloudConsent', e.target.checked)}
            />
            允许将规划所需的健康信息发送至当前模型服务
          </label>
          <label className="flex items-start gap-2">
            <input
              className="mt-1"
              type="checkbox"
              checked={value.sourceConsent}
              onChange={(e) => patch('sourceConsent', e.target.checked)}
            />
            允许将我审核采用的资料原则用于云模型规划
          </label>
          <a className="block underline" href="/?page=ai-api-settings">
            查看当前模型服务与配置
          </a>
        </div>
      </Note>
      <Button
        type="submit"
        disabled={Boolean(busy) || !age || !height || !weight}
      >
        保存身体档案
      </Button>
    </form>
  );
}

function parseLines(text: string, context: DayContext, fixed = false) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line
        .replace(/：/g, ':')
        .match(/^(\d{2}:\d{2})\s*[-~至]\s*(\d{2}:\d{2})\s*(.*)$/);
      if (!match) throw Error('时间请按 18:00-20:00 填写，一行一个窗口。');
      if (!fixed) return { start: match[1], end: match[2] };
      const title = match[3] || '固定事项',
        old = context.fixed.find(
          (f) =>
            f.start === match[1] && f.end === match[2] && f.title === title,
        );
      return {
        id: old?.id ?? crypto.randomUUID(),
        start: match[1],
        end: match[2],
        title,
      };
    });
}
function ContextForm({
  context,
  busy,
  onSave,
}: {
  context: DayContext;
  busy: string;
  onSave: (v: DayContext) => Promise<boolean>;
}) {
  const [value, setValue] = useState(context),
    [windows, setWindows] = useState(
      context.windows.map((w) => `${w.start}-${w.end}`).join('\n'),
    ),
    [fixed, setFixed] = useState(
      context.fixed.map((f) => `${f.start}-${f.end} ${f.title}`).join('\n'),
    ),
    [localError, setLocalError] = useState('');
  return (
    <details open={!context.windows.length} className="rounded-xl border p-5">
      <summary className="cursor-pointer font-semibold">
        {context.date} · 已知时间与当天条件{' '}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {context.windows.length
            ? `${context.windows.length} 个已确认窗口`
            : '尚未确认可用时间'}
        </span>
      </summary>
      <form
        className="mt-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setLocalError('');
            void onSave({
              ...value,
              windows: parseLines(windows, context) as DayContext['windows'],
              fixed: parseLines(fixed, context, true) as DayContext['fixed'],
            });
          } catch (error) {
            setLocalError(errorText(error));
          }
        }}
      >
        <div className="grid grid-cols-2 gap-5">
          <Field
            label="确定有空的时间"
            hint="一行一个窗口，例如 07:00-08:00。请计入吃饭、准备和活动所需时间；未知就留空。"
          >
            <textarea
              className={areaClass}
              value={windows}
              onChange={(e) => setWindows(e.target.value)}
              placeholder="07:00-08:00&#10;18:00-21:00"
            />
          </Field>
          <Field
            label="必须保留的固定事项"
            hint="例如 18:00-19:00 通勤。模型只会收到不可用时间。"
          >
            <textarea
              className={areaClass}
              value={fixed}
              onChange={(e) => setFixed(e.target.value)}
            />
          </Field>
          <Field label="当天地点">
            <select
              className={selectClass}
              value={value.location}
              onChange={(e) =>
                setValue({ ...value, location: e.target.value as any })
              }
            >
              <option value="home">在家 / 附近</option>
              <option value="gym">可去健身房</option>
              <option value="travel">外出 / 旅行</option>
            </select>
          </Field>
          <Field label="当天如何吃饭">
            <select
              className={selectClass}
              value={value.meals}
              onChange={(e) =>
                setValue({ ...value, meals: e.target.value as any })
              }
            >
              <option value="mixed">做饭与外食都可</option>
              <option value="cook">可以自己做饭</option>
              <option value="outside">只能外食 / 现成食物</option>
            </select>
          </Field>
          <Field label="当天状态">
            <select
              className={selectClass}
              value={value.readiness}
              onChange={(e) =>
                setValue({ ...value, readiness: e.target.value as any })
              }
            >
              <option value="unknown">尚未确认</option>
              <option value="normal">状态正常</option>
              <option value="tired">疲劳，保守安排</option>
              <option value="pain">有疼痛或不适，暂停自动训练</option>
            </select>
          </Field>
          <Field label="补充条件">
            <Input
              value={value.notes}
              onChange={(e) => setValue({ ...value, notes: e.target.value })}
              maxLength={1000}
            />
          </Field>
        </div>
        {localError && (
          <div role="alert">
            <Note warning>{localError}</Note>
          </div>
        )}
        <Button variant="outline" type="submit" disabled={Boolean(busy)}>
          保存当天条件
        </Button>
      </form>
    </details>
  );
}

function PlanPanel({
  title,
  plan,
  day,
  data,
  filter,
  draft = false,
  busy,
  onAdopt,
  onRecord,
  onStart,
  onDefer,
}: {
  title: string;
  plan: NonNullable<View['days'][string]['active']>;
  day: View['days'][string];
  data: View;
  filter: string;
  draft?: boolean;
  busy: string;
  onAdopt?: () => void;
  onRecord: (i: DayItem) => void;
  onStart: (i: DayItem) => void;
  onDefer: (i: DayItem) => void;
}) {
  const items = plan.items.filter((i) =>
      filter === 'exercise'
        ? i.kind === 'exercise'
        : filter === 'diet'
          ? i.kind === 'meal'
          : true,
    ),
    nutrition = nutritionSummary(items, data.account.foods),
    actualNutrition = nutritionSummary(
      items.filter(
        (i) => i.actual && ['completed', 'partial'].includes(i.status),
      ),
      data.account.foods,
    ),
    [showDone, setShowDone] = useState(false);
  const done = items.filter((i) =>
      ['completed', 'skipped', 'canceled'].includes(i.status),
    ),
    remaining = items.filter(
      (i) => !['completed', 'skipped', 'canceled'].includes(i.status),
    );
  return (
    <section
      className={`space-y-4 rounded-xl border p-5 ${draft ? 'border-primary/40' : ''}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {plan.date} ·{' '}
            {plan.origin === 'pi'
              ? 'Pi 模型候选'
              : plan.origin === 'catalog'
                ? '本机目录排布'
                : '用户手动安排'}
            {plan.provider && ` · ${plan.provider.model}`} ·{' '}
            {new Date(plan.createdAt).toLocaleString('zh-CN')}
          </p>
        </div>
        {draft && (
          <Button
            disabled={
              Boolean(busy) ||
              day.paused ||
              plan.basisRevision !== data.revision
            }
            onClick={onAdopt}
          >
            {plan.basisRevision !== data.revision
              ? '数据已变化，请重新生成'
              : '采用这份草稿'}
          </Button>
        )}
      </div>
      <p className="text-sm leading-6">{plan.reason}</p>
      {draft && plan.proposedContext && (
        <Note>
          <p className="font-medium">本次采用也将更新以下当天条件</p>
          <p>
            空闲时间：
            {plan.proposedContext.windows
              .map((w) => `${w.start}–${w.end}`)
              .join('、') || '无可用窗口'}
            ；地点：
            {
              { home: '家中', gym: '健身房', travel: '外出' }[
                plan.proposedContext.location
              ]
            }
            ；就餐：
            {
              { cook: '自己做饭', outside: '外食', mixed: '做饭与外食结合' }[
                plan.proposedContext.meals
              ]
            }
            。
          </p>
          <p>尚未采用时，上述条件和候选安排均未生效。</p>
        </Note>
      )}
      {plan.warnings.length > 0 && (
        <Note>
          {plan.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </Note>
      )}
      {draft && plan.changes.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-sm font-medium">
            这次具体调整了什么
          </summary>
          <ul className="mt-3 space-y-2 text-sm">
            {plan.changes.map((c) => (
              <li key={c.itemId}>
                {c.before} → {c.after}
              </li>
            ))}
          </ul>
        </details>
      )}
      {remaining.length === 0 && (
        <p className="text-sm text-muted-foreground">
          没有待执行安排。未确认时间或无法满足条件的事项会保持未安排。
        </p>
      )}
      {remaining.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          date={plan.date}
          today={data.today}
          draft={draft}
          busy={busy}
          disabled={day.paused || Boolean(day.pendingChange)}
          onRecord={onRecord}
          onStart={onStart}
          onDefer={onDefer}
        />
      ))}
      {done.length > 0 && (
        <>
          <Button variant="ghost" onClick={() => setShowDone(!showDone)}>
            {showDone ? '收起' : '查看'}已确认记录（{done.length}）
          </Button>
          {showDone &&
            done.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                date={plan.date}
                today={data.today}
                draft={draft}
                busy={busy}
                disabled
                onRecord={onRecord}
                onStart={onStart}
                onDefer={onDefer}
              />
            ))}
        </>
      )}
      {items.some((i) => i.kind === 'meal') && (
        <div className="border-t pt-4 text-sm">
          <p className="font-medium">餐食营养核对 · 计划与已记录部分</p>
          <p className="mt-2 text-muted-foreground">
            实际已记录：{actualNutrition.kcal?.toFixed(0) ?? '未知'}{' '}
            kcal，蛋白质 {actualNutrition.protein?.toFixed(1) ?? '未知'} g。
            {actualNutrition.complete
              ? '已核对完整'
              : '存在未核对或未记录内容，不代表完整摄入。'}
          </p>
          <p className="mt-2 text-muted-foreground">
            {nutrition.known === 0
              ? '尚无已关联且核对的食物标签数据，不能给出可靠营养合计。'
              : `${nutrition.complete ? '已核对合计' : '仅已知部分合计'}：${nutrition.kcal?.toFixed(0) ?? '未知'} kcal，蛋白质 ${nutrition.protein?.toFixed(1) ?? '未知'} g，碳水 ${nutrition.carbs?.toFixed(1) ?? '未知'} g，脂肪 ${nutrition.fat?.toFixed(1) ?? '未知'} g。`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            已关联 {nutrition.known}/{nutrition.count}{' '}
            项食材；生重、熟重与包装状态分别核对。可在饮食页维护食物标签，并记录实际食材。
          </p>
        </div>
      )}
      {plan.citations.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs">采用的资料依据</summary>
          <ul className="mt-2 space-y-2 text-xs">
            {plan.citations.map((id) => {
              const guideline = data.catalog.guidelines.find(
                  (s) => s.id === id,
                ),
                source = data.sources.find((s) => s.id === id);
              return (
                <li key={id}>
                  {guideline ? (
                    <a
                      className="underline"
                      href={guideline.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {guideline.title}
                    </a>
                  ) : source ? (
                    `${source.name} · ${source.status === 'approved' ? '已采用原则' : '已撤销或待核对'}`
                  ) : (
                    '资料当前不可用'
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
function ItemRow({
  item,
  date,
  today,
  draft,
  busy,
  disabled,
  onRecord,
  onStart,
  onDefer,
}: {
  item: DayItem;
  date: string;
  today: string;
  draft: boolean;
  busy: string;
  disabled: boolean;
  onRecord: (i: DayItem) => void;
  onStart: (i: DayItem) => void;
  onDefer: (i: DayItem) => void;
}) {
  const terminal = ['completed', 'skipped', 'canceled'].includes(item.status),
    overdue =
      date === today &&
      item.status === 'planned' &&
      minute(item.start) <=
        minute(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(new Date()),
        );
  return (
    <article className="space-y-3 border-l-2 pl-4">
      <div className="flex flex-wrap justify-between gap-2">
        <div>
          <span className="mr-3 text-sm tabular-nums text-muted-foreground">
            {item.start}–{item.end}
          </span>
          <span className="font-medium">{item.title}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {overdue ? '已过计划时间，完成情况待确认' : statusNames[item.status]}
        </span>
      </div>
      {item.instructions.length > 0 && (
        <p className="text-sm leading-6 text-muted-foreground">
          {item.instructions.join(' ')}
        </p>
      )}
      {item.ingredients && (
        <p className="text-sm">
          {item.ingredients
            .map(
              (i) =>
                `${i.name} ${i.grams}g（${i.state === 'raw' ? '生重' : i.state === 'cooked' ? '熟重' : '包装'}）`,
            )
            .join('、')}
        </p>
      )}
      {item.actual && (
        <p className="text-xs text-muted-foreground">
          实际记录：
          {item.actual.minutes !== undefined
            ? `${item.actual.minutes} 分钟 · `
            : ''}
          {item.actual.text || '已确认状态'} ·{' '}
          {new Date(item.actual.at).toLocaleString('zh-CN')}
        </p>
      )}
      {item.actual?.training?.map((entry, index) => (
        <p className="text-xs text-muted-foreground" key={index}>
          {entry.name} · {entry.sets} 组
          {entry.reps !== undefined ? ` × ${entry.reps} 次` : ''}
          {entry.loadKg !== undefined ? ` · ${entry.loadKg} kg` : ''}
          {entry.effort !== undefined ? ` · 主观用力 ${entry.effort}/10` : ''}
        </p>
      ))}
      {!draft && terminal && item.actual && date <= today && (
        <Button
          variant="ghost"
          disabled={Boolean(busy)}
          onClick={() => onRecord(item)}
        >
          更正执行：{item.title}
        </Button>
      )}
      {item.note && <Note>{item.note}</Note>}
      {!draft && !terminal && item.kind !== 'fixed' && (
        <div className="flex flex-wrap gap-2">
          {date === today && item.status === 'planned' && (
            <Button
              variant="outline"
              disabled={Boolean(busy) || disabled}
              onClick={() => onStart(item)}
            >
              开始：{item.title}
            </Button>
          )}
          {date <= today && (
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => onRecord(item)}
            >
              记录：{item.title}
            </Button>
          )}
          {date === today &&
            item.status === 'planned' &&
            item.kind !== 'meal' && (
              <Button
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() => onDefer(item)}
              >
                加入明日待评估
              </Button>
            )}
        </div>
      )}
    </article>
  );
}

function RecordDialog({
  item,
  foods,
  busy,
  onSave,
  onClose,
}: {
  item: DayItem;
  foods: Food[];
  busy: string;
  onSave: (value: any) => Promise<boolean>;
  onClose: () => void;
}) {
  const correction = Boolean(
    item.actual &&
      ['completed', 'partial', 'skipped', 'canceled'].includes(item.status),
  );
  const [status, setStatus] = useState<string>(
      correction ? item.status : 'completed',
    ),
    [minutes, setMinutes] = useState(
      item.actual?.minutes === undefined ? '' : String(item.actual.minutes),
    ),
    [note, setNote] = useState(''),
    [training, setTraining] = useState<TrainingRecord[]>(
      item.actual?.training ?? [],
    ),
    [ingredients, setIngredients] = useState<MealIngredient[]>(
      item.actual?.ingredients ?? item.ingredients ?? [],
    );
  const change = (index: number, patch: Partial<MealIngredient>) =>
    setIngredients((previous) =>
      previous.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {correction ? '更正执行记录' : '记录实际执行'}
          </DialogTitle>
          <DialogDescription>
            {item.title}
            。记录事实与计划分开保存，不会因为没做就自动增加明天负担。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave({
              status,
              note,
              ...(!['skipped', 'canceled'].includes(status) && minutes !== ''
                ? { minutes: Number(minutes) }
                : {}),
              ...(!['skipped', 'canceled'].includes(status) &&
              item.kind === 'meal'
                ? { ingredients }
                : {}),
              ...(!['skipped', 'canceled'].includes(status) &&
              item.kind === 'exercise'
                ? { training }
                : {}),
            });
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <Field label="实际状态">
              <select
                className={selectClass}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="completed">已完成</option>
                <option value="partial">部分完成</option>
                <option value="skipped">确认没做</option>
                <option value="canceled">取消本次</option>
              </select>
            </Field>
            <Field label="实际用时（分钟，可选）">
              <Input
                type="number"
                min={0}
                max={1440}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </Field>
          </div>
          <Field label="实际情况与感受">
            <textarea
              className={areaClass}
              required={correction}
              placeholder={
                correction
                  ? '说明填错了什么以及本次更正依据，原始记录会保留。'
                  : ''
              }
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />
          </Field>
          {!['skipped', 'canceled'].includes(status) &&
            item.kind === 'exercise' && (
              <section className="space-y-3">
                <h3 className="text-sm font-medium">实际动作（可选）</h3>
                {training.map((entry, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-2 gap-3 rounded-lg border p-3"
                  >
                    <Field label={`动作 ${index + 1} 名称`}>
                      <Input
                        required
                        value={entry.name}
                        onChange={(e) =>
                          setTraining((previous) =>
                            previous.map((v, i) =>
                              i === index ? { ...v, name: e.target.value } : v,
                            ),
                          )
                        }
                      />
                    </Field>
                    {(['sets', 'reps', 'loadKg', 'effort'] as const).map(
                      (key) => (
                        <Field
                          key={key}
                          label={
                            {
                              sets: '组数',
                              reps: '每组次数（可选）',
                              loadKg: '负重 kg（可选）',
                              effort: '主观用力 0–10（可选）',
                            }[key]
                          }
                        >
                          <Input
                            type="number"
                            min={key === 'sets' ? 1 : 0}
                            max={
                              key === 'effort'
                                ? 10
                                : key === 'sets'
                                  ? 100
                                  : 1000
                            }
                            step={key === 'sets' || key === 'reps' ? 1 : 0.5}
                            required={key === 'sets'}
                            value={entry[key] ?? ''}
                            onChange={(e) =>
                              setTraining((previous) =>
                                previous.map((v, i) =>
                                  i === index
                                    ? {
                                        ...v,
                                        [key]:
                                          e.target.value === ''
                                            ? undefined
                                            : Number(e.target.value),
                                      }
                                    : v,
                                ),
                              )
                            }
                          />
                        </Field>
                      ),
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setTraining((v) => v.filter((_, i) => i !== index))
                      }
                    >
                      移除此动作
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setTraining((v) => [...v, { name: '', sets: 1 }])
                  }
                >
                  添加实际动作
                </Button>
              </section>
            )}
          {item.kind === 'meal' &&
            !['skipped', 'canceled'].includes(status) && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">实际吃的食材</h3>
                {ingredients.map((ingredient, index) => (
                  <div
                    className="grid grid-cols-2 gap-3 rounded-lg border p-3"
                    key={index}
                  >
                    <Field label={`食材 ${index + 1} 名称`}>
                      <Input
                        value={ingredient.name}
                        onChange={(e) =>
                          change(index, {
                            name: e.target.value,
                            foodId: undefined,
                          })
                        }
                      />
                    </Field>
                    <Field label={`食材 ${index + 1} 克数`}>
                      <Input
                        type="number"
                        min={1}
                        value={ingredient.grams}
                        onChange={(e) =>
                          change(index, { grams: Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label={`食材 ${index + 1} 状态`}>
                      <select
                        className={selectClass}
                        value={ingredient.state}
                        onChange={(e) =>
                          change(index, {
                            state: e.target.value as any,
                            foodId: undefined,
                          })
                        }
                      >
                        <option value="raw">生重</option>
                        <option value="cooked">熟重</option>
                        <option value="packaged">包装</option>
                      </select>
                    </Field>
                    <Field label={`食材 ${index + 1} 营养数据关联`}>
                      <select
                        className={selectClass}
                        value={ingredient.foodId ?? ''}
                        onChange={(e) =>
                          change(index, { foodId: e.target.value || undefined })
                        }
                      >
                        <option value="">未核对，保持未知</option>
                        {foods
                          .filter(
                            (f) => f.verified && f.state === ingredient.state,
                          )
                          .map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name} · {f.source}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setIngredients((v) => v.filter((_, i) => i !== index))
                      }
                    >
                      移除此食材
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setIngredients((v) => [
                      ...v,
                      { name: '', grams: 100, state: 'cooked' },
                    ])
                  }
                >
                  添加实际食材
                </Button>
              </div>
            )}
          <div className="flex gap-2">
            <Button type="submit" disabled={Boolean(busy)}>
              保存执行记录
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={onClose}
            >
              取消
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function manualProjection(item: DayItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    start: item.start,
    end: item.end,
    priority: item.priority,
    instructions: item.instructions,
    ...(item.exerciseId ? { exerciseId: item.exerciseId } : {}),
    ...(item.recipeId ? { recipeId: item.recipeId } : {}),
    ...(item.note ? { note: item.note } : {}),
  };
}
function ManualDialog({
  data,
  date,
  busy,
  onSave,
  onClose,
}: {
  data: View;
  date: string;
  busy: string;
  onSave: (items: any[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState('personal'),
    [title, setTitle] = useState(''),
    [start, setStart] = useState('18:00'),
    [end, setEnd] = useState('18:30'),
    [choice, setChoice] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>手动添加安排</DialogTitle>
          <DialogDescription>
            添加后生成草稿，采用前会核对当前时间和冲突。需要新的时间窗口时，先保存当天条件。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const exercise = data.catalog.exercises.find(
                (v) => v.id === choice,
              ),
              recipe = data.catalog.recipes.find((v) => v.id === choice),
              entry = {
                id: crypto.randomUUID(),
                kind,
                title:
                  kind === 'exercise'
                    ? exercise?.name
                    : kind === 'meal'
                      ? recipe?.name
                      : title,
                start,
                end:
                  kind === 'exercise' && exercise
                    ? clock(minute(start) + exercise.minutes)
                    : kind === 'meal' && recipe
                      ? clock(minute(start) + recipe.minutes)
                      : end,
                priority: 'optional',
                instructions: [],
                ...(kind === 'exercise' ? { exerciseId: choice } : {}),
                ...(kind === 'meal' ? { recipeId: choice } : {}),
              };
            void onSave([
              ...(data.days[date]?.active?.items ?? []).map(manualProjection),
              entry,
            ]);
          }}
        >
          <Field label="事项类型">
            <select
              className={selectClass}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setChoice('');
              }}
            >
              <option value="personal">个人事项</option>
              <option value="exercise">目录训练</option>
              <option value="meal">目录餐食</option>
            </select>
          </Field>
          {kind === 'personal' ? (
            <Field label="事项名称">
              <Input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
          ) : (
            <Field label="选择已核对的目录选项">
              <select
                required
                className={selectClass}
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">请选择</option>
                {(kind === 'exercise'
                  ? data.catalog.exercises
                  : data.catalog.recipes
                ).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.minutes} 分钟
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="开始时间">
              <Input
                required
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            {kind === 'personal' && (
              <Field label="结束时间">
                <Input
                  required
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </Field>
            )}
          </div>
          <Button disabled={Boolean(busy)} type="submit">
            生成手动安排草稿
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FoodLibrary({
  data,
  busy,
  onSave,
}: { data: View; busy: string; onSave: (v: Food) => Promise<boolean> }) {
  const [name, setName] = useState(''),
    [state, setState] = useState<'raw' | 'cooked' | 'packaged'>('cooked'),
    [source, setSource] = useState(''),
    [values, setValues] = useState({
      kcal: '',
      protein: '',
      carbs: '',
      fat: '',
    }),
    [verified, setVerified] = useState(false);
  return (
    <section className="space-y-4 rounded-xl border p-5">
      <h2 className="font-semibold">我的食物标签与成分数据</h2>
      <p className="text-sm leading-6 text-muted-foreground">
        录入你实际使用的包装标签或有来源的成分数据，每 100
        克为统一基准。生重、熟重和包装状态分开；没有核对的字段保持空白。
      </p>
      {data.account.foods.map((food) => (
        <p className="text-sm" key={food.id}>
          {food.name} ·{' '}
          {food.state === 'raw'
            ? '生重'
            : food.state === 'cooked'
              ? '熟重'
              : '包装'}{' '}
          · {food.verified ? '用户已核对' : '待核对'} · {food.source}
        </p>
      ))}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({
            id: crypto.randomUUID(),
            name,
            state,
            source,
            basis: 'per100g',
            allergens: [],
            verified,
            kcal: values.kcal === '' ? null : Number(values.kcal),
            protein: values.protein === '' ? null : Number(values.protein),
            carbs: values.carbs === '' ? null : Number(values.carbs),
            fat: values.fat === '' ? null : Number(values.fat),
          }).then((ok) => {
            if (ok) {
              setName('');
              setSource('');
              setVerified(false);
              setValues({ kcal: '', protein: '', carbs: '', fat: '' });
            }
          });
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="食物名称">
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="计量状态">
            <select
              className={selectClass}
              value={state}
              onChange={(e) => setState(e.target.value as any)}
            >
              <option value="cooked">熟重</option>
              <option value="raw">生重</option>
              <option value="packaged">包装</option>
            </select>
          </Field>
          {[
            ['kcal', '每 100 克热量（kcal）'],
            ['protein', '每 100 克蛋白质（g）'],
            ['carbs', '每 100 克碳水（g）'],
            ['fat', '每 100 克脂肪（g）'],
          ].map(([key, label]) => (
            <Field label={label} key={key}>
              <Input
                type="number"
                min={0}
                step="0.1"
                value={values[key as keyof typeof values]}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [key]: e.target.value }))
                }
              />
            </Field>
          ))}
        </div>
        <Field label="数据来源或包装品牌">
          <Input
            required
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="包装营养成分表 / 可核对的成分来源"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          我已核对计量状态和数据来源
        </label>
        <Button disabled={Boolean(busy)} type="submit" variant="outline">
          保存食物数据
        </Button>
      </form>
    </section>
  );
}

export function Sources({
  data,
  busy,
  onCommand,
  onUploaded,
  onBusy,
  onError,
}: {
  data: View;
  busy: string;
  onCommand: (v: any, label?: string) => Promise<boolean>;
  onUploaded: () => Promise<void>;
  onBusy: (v: string) => void;
  onError: (v: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [selected, setSelected] = useState(''),
    [principles, setPrinciples] = useState(''),
    [fullText, setFullText] = useState(''),
    [extractConsent, setExtractConsent] = useState(false);
  const savedPrinciples =
    data.sources.find((s) => s.id === selected)?.principles.join('\n') ?? '';
  useEffect(() => {
    setPrinciples(savedPrinciples);
  }, [selected, savedPrinciples]);
  async function upload() {
    if (!file) return;
    onBusy('正在本机转换资料');
    onError('');
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('commandId', crypto.randomUUID());
      form.set('expectedRevision', String(data.revision));
      const result = await api('/api/personal-day/sources', {
        method: 'POST',
        headers: { 'X-Personal-Day-Actor': data.actorId },
        body: form,
      });
      await onUploaded();
      if (result.result?.status === 'failed')
        onError('资料未转换成功，请查看文件状态。');
      setFile(null);
    } catch (error) {
      onError(errorText(error));
    } finally {
      onBusy('');
    }
  }
  async function choose(id: string) {
    setSelected(id);
    const source = data.sources.find((s) => s.id === id);
    setPrinciples(source?.principles.join('\n') ?? '');
    setFullText(source?.text ?? '');
    if (source?.textTruncated) {
      try {
        setFullText((await api('/api/personal-day/sources/' + id)).text);
      } catch (error) {
        onError(errorText(error));
      }
    }
  }
  const source = data.sources.find((s) => s.id === selected);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">
          导入你的资料，并明确采用哪些原则
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          文件上传与转换在本机进行。正文与原件加密保存。核对原文、适用条件和冲突后再采用；采用资料不等于医学验证。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="选择健身饮食资料"
          type="file"
          accept=".md,.txt,.pdf,.docx,.epub"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <Button disabled={Boolean(busy) || !file} onClick={() => void upload()}>
          导入资料（最多 5 MB）
        </Button>
      </div>
      <div className="grid grid-cols-[minmax(220px,1fr)_minmax(0,2fr)] gap-6">
        <div className="space-y-2">
          {data.sources.length === 0 && (
            <Note>
              还没有导入私人资料。基础指南仍可参考，文件与理论原则不会被假装为已经读取。
            </Note>
          )}
          {data.sources.map((s) => (
            <button
              className={`w-full rounded-lg border p-4 text-left ${selected === s.id ? 'border-primary' : 'hover:bg-muted/30'}`}
              key={s.id}
              onClick={() => void choose(s.id)}
            >
              <p className="break-all text-sm font-medium">{s.name}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {s.status === 'approved'
                  ? '已采用原则'
                  : s.status === 'failed'
                    ? '转换失败'
                    : s.status === 'revoked'
                      ? '已撤销'
                      : '待核对原文与原则'}
              </p>
            </button>
          ))}
        </div>
        {source && (
          <section className="min-w-0 space-y-4">
            <h3 className="font-semibold">{source.name}</h3>
            <p className="break-all text-xs text-muted-foreground">
              文件校验：{source.hash}
            </p>
            <a
              href={`/api/personal-day/sources/${source.id}?download=1`}
              className="text-sm underline"
            >
              下载原始文件
            </a>
            {source.status === 'failed' ? (
              <Note warning>
                {errors[source.error ?? ''] ?? '文件转换失败，未纳入依据。'}{' '}
                {source.warnings.join(' ')}
              </Note>
            ) : (
              <>
                <details>
                  <summary className="cursor-pointer text-sm">
                    查看转换后的原文（{source.totalChars} 字符）
                  </summary>
                  <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-4 text-sm">
                    {fullText}
                  </pre>
                </details>
                <Field
                  label="经你核对的适用原则"
                  hint="一行一条，写明原文位置、适用条件及限制。空白不能采用；撤销后后续规划不再引用。"
                >
                  <textarea
                    className={areaClass + ' min-h-48'}
                    value={principles}
                    onChange={(e) => setPrinciples(e.target.value)}
                  />
                </Field>
                <Note>
                  <label className="flex items-start gap-2">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={extractConsent}
                      onChange={(e) => setExtractConsent(e.target.checked)}
                    />
                    允许把当前资料前 12000
                    字符发送给配置中心的模型服务，提取待审核原则（会使用模型额度）。
                  </label>
                  <Button
                    className="mt-3"
                    variant="outline"
                    disabled={
                      Boolean(busy) ||
                      !extractConsent ||
                      source.status === 'approved' ||
                      !data.account.profile?.cloudConsent
                    }
                    onClick={() =>
                      void onCommand(
                        {
                          operation: 'source_extract',
                          sourceId: source.id,
                          consent: true,
                        },
                        'Pi 正在提取待审核原则',
                      )
                    }
                  >
                    Pi 提取原则候选
                  </Button>
                  <p className="mt-2 text-xs">
                    提取后仍需你核对原文与适用条件，再点击采用。
                    {source.status === 'approved' &&
                      ' 当前已采用，请先撤销采用再重新提取。'}
                    {!data.account.profile?.cloudConsent &&
                      ' 请先在身体档案中确认模型数据使用范围。'}
                  </p>
                </Note>
                {source.warnings.map((w) => (
                  <p className="text-xs text-muted-foreground" key={w}>
                    {w}
                  </p>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={Boolean(busy) || !principles.trim()}
                    onClick={() =>
                      void onCommand({
                        operation: 'source_review',
                        sourceId: source.id,
                        approved: true,
                        principles: principles
                          .split('\n')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  >
                    采用已核对原则
                  </Button>
                  <Button
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void onCommand({
                        operation: 'source_review',
                        sourceId: source.id,
                        approved: false,
                        principles: source.principles,
                      })
                    }
                  >
                    撤销采用
                  </Button>
                </div>
              </>
            )}
          </section>
        )}
      </div>
      <Note>
        资料中的指令不会获得系统权限；引用只允许来自已采用的原则。过敏、明确限制和当前条件始终优先。
      </Note>
    </div>
  );
}

function History({
  data,
  busy,
  onRestore,
}: {
  data: View;
  busy: string;
  onRestore: (id: string, date: string) => Promise<boolean>;
}) {
  const events = data.events.filter((e) =>
    [
      'adopt',
      'draft_generated',
      'restore',
      'context_save',
      'defer',
      'pause',
      'change_reported',
    ].includes(e.kind),
  );
  return (
    <section className="space-y-4">
      <h2 className="font-semibold">调整记录</h2>
      {events.length === 0 && (
        <Note>
          还没有计划调整。采用、条件变化、延期和暂停都会留下独立记录。
        </Note>
      )}
      {events.map((event) => (
        <article key={event.id} className="rounded-lg border p-4">
          <div className="flex flex-wrap justify-between gap-2">
            <p className="text-sm font-medium">
              {
                {
                  adopt: '采用日计划',
                  draft_generated: '生成草稿',
                  restore: '提出恢复候选',
                  context_save: '更新当天条件',
                  defer: '加入明日待评估',
                  pause: '暂停 / 恢复',
                  change_reported: '报告临时变化',
                }[event.kind]
              }
            </p>
            <time className="text-xs text-muted-foreground">
              {new Date(event.at).toLocaleString('zh-CN')}
            </time>
          </div>
          <p className="mt-2 text-sm">
            {event.payload.reason ??
              event.payload.after?.reason ??
              event.payload.plan?.reason ??
              event.payload.context?.date ??
              event.payload.target ??
              ''}
          </p>
          {(
            event.payload.after?.changes ??
            event.payload.plan?.changes ??
            []
          ).map((change: any) => (
            <p
              className="mt-2 text-xs text-muted-foreground"
              key={change.itemId}
            >
              {change.before} → {change.after}
            </p>
          ))}
          {event.kind === 'adopt' &&
            event.payload.before &&
            [data.today, data.tomorrow].includes(event.payload.before.date) && (
              <Button
                className="mt-3"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() =>
                  void onRestore(event.id, event.payload.before.date)
                }
              >
                恢复仍可行的旧安排（先出草稿）
              </Button>
            )}
        </article>
      ))}
    </section>
  );
}

export function Progress({
  data,
  busy,
  onCommand,
}: {
  data: View;
  busy: string;
  onCommand: (v: any, label?: string) => Promise<boolean>;
}) {
  const [kind, setKind] = useState('weight'),
    [value, setValue] = useState(''),
    [note, setNote] = useState(''),
    [corrects, setCorrects] = useState('');
  const measurements = data.observations.filter((o) => o.kind === 'weight'),
    days = Object.values(data.days),
    completed = days
      .flatMap((d) => d.active?.items ?? [])
      .filter((i) => i.status === 'completed').length;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">实际记录与每日收尾</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          只统计已经确认的执行。没记录的保持未知，未完成事项不会自动变成明天的欠账。
        </p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Note>
          <p>有计划记录的日期</p>
          <strong className="text-xl">
            {days.filter((d) => d.active).length}
          </strong>
        </Note>
        <Note>
          <p>确认完成的事项</p>
          <strong className="text-xl">{completed}</strong>
        </Note>
        <Note>
          <p>实际体重测量记录</p>
          <strong className="text-xl">{measurements.length}</strong>
        </Note>
      </div>
      <Note>
        当前用于规划的体重：{data.assessment.effectiveWeightKg ?? '未知'} kg ·{' '}
        {data.assessment.weightSource}。
        {data.assessment.latestWeight &&
          ` 测量日期：${data.assessment.latestWeight.timePrecision === 'day' ? data.assessment.latestWeight.date : new Date(data.assessment.latestWeight.at).toLocaleString('zh-CN')}。`}
        {data.assessment.latestSleep &&
          ` 最近睡眠记录：${data.assessment.latestSleep.value} 小时，${data.assessment.latestSleep.timePrecision === 'day' ? data.assessment.latestSleep.date : new Date(data.assessment.latestSleep.at).toLocaleString('zh-CN')}。`}
        <p>更正会更新当前理解，原始测量和执行事件继续保留。</p>
      </Note>
      <form
        className="space-y-4 rounded-xl border p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void onCommand({
            operation: 'observation',
            kind,
            at: new Date().toISOString(),
            value: value === '' ? null : Number(value),
            note,
            ...(corrects ? { corrects } : {}),
          }).then((ok) => {
            if (ok) {
              setValue('');
              setNote('');
              setCorrects('');
            }
          });
        }}
      >
        <h3 className="font-medium">记录一次实际情况</h3>
        <div className="grid grid-cols-2 gap-4">
          <Field label="记录类型">
            <select
              className={selectClass}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="weight">体重（公斤）</option>
              <option value="sleep">昨晚睡眠（小时）</option>
              <option value="readiness">身体感受或日终反馈</option>
              <option value="correction">补充更正</option>
            </select>
          </Field>
          <Field label="实际数值（感受可留空）">
            <Input
              type="number"
              step="0.1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
        </div>
        {kind === 'correction' && (
          <Field label="更正哪条记录">
            <select
              required
              className={selectClass}
              value={corrects}
              onChange={(e) => setCorrects(e.target.value)}
            >
              <option value="">选择原记录</option>
              {data.observations
                .filter((o) => !o.corrects && o.kind !== 'execution')
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {new Date(o.at).toLocaleString('zh-CN')} · {o.kind} ·{' '}
                    {o.value ?? o.note}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="测量条件、感受或更正说明">
          <textarea
            className={areaClass}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
          />
        </Field>
        <Button type="submit" disabled={Boolean(busy)}>
          保存实际记录
        </Button>
      </form>
      <section className="space-y-3">
        <h3 className="font-semibold">原始记录时间线</h3>
        <p className="text-xs text-muted-foreground">
          {data.coverage.window} 更正追加保存，原记录保留关联。
        </p>
        {data.observations.length === 0 ? (
          <Note>
            还没有测量或执行记录。档案体重是录入基线，尚不能据此形成测量趋势。
          </Note>
        ) : (
          data.observations.slice(0, 50).map((o) => (
            <article className="border-b pb-3 text-sm" key={o.id}>
              <p>
                {new Date(o.at).toLocaleString('zh-CN')} ·{' '}
                {
                  {
                    weight: '体重',
                    sleep: '睡眠',
                    readiness: '状态反馈',
                    execution: '执行记录',
                    correction: '更正记录',
                  }[o.kind]
                }{' '}
                ·{' '}
                {o.value === null
                  ? '未填写数值'
                  : `${o.value} ${{ kg: '公斤', hours: '小时', minutes: '分钟', note: '数值' }[o.unit] ?? o.unit}`}
              </p>
              <p className="mt-1 text-muted-foreground">
                {o.note || '用户确认记录'}
                {o.corrects && ` · 更正关联 ${o.corrects}`}
              </p>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
