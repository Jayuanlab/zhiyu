'use client';
import { useEffect, useState } from 'react';
import { Button, Input } from '@openzhiyu/ui';
import type { dayAutomationStatus } from '@/lib/personal-day/automation';
type Status = Awaited<ReturnType<typeof dayAutomationStatus>>;
export function DayAutomationPanel({
  revision,
  actorId,
  busy,
  onSaved,
  onError,
}: {
  revision: number;
  actorId: string;
  busy: string;
  onSaved: () => Promise<void>;
  onError: (text: string) => void;
}) {
  const [status, setStatus] = useState<Status>(null),
    [time, setTime] = useState('21:00'),
    [mode, setMode] = useState('catalog'),
    [enabled, setEnabled] = useState(false),
    [saving, setSaving] = useState(false),
    [loadError, setLoadError] = useState('');
  async function load() {
    const response = await fetch('/api/personal-day/automation', {
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw Error('持续任务状态暂不可用。');
    setStatus(result.automation);
    if (result.automation) {
      setTime(result.automation.time);
      setMode(result.automation.mode);
      setEnabled(result.automation.enabled);
    } else setEnabled(false);
  }
  useEffect(() => {
    void load().catch((e) => setLoadError(e.message));
  }, [revision]);
  async function save() {
    setSaving(true);
    onError('');
    try {
      const response = await fetch('/api/personal-day/automation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Personal-Day-Actor': actorId,
        },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedRevision: revision,
          time,
          mode,
          enabled,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(
          result.error === 'health_cloud_consent_required'
            ? '请先在身体档案中同意模型数据使用。'
            : result.error === 'version_conflict'
              ? '数据已变化，请刷新后重试。'
              : '持续任务配置未完成，请查看关联车间或刷新重试。',
        );
      await onSaved();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : '持续任务配置失败');
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="rounded-xl border p-5">
      <summary className="cursor-pointer font-semibold">
        明日草稿持续任务{' '}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {status?.enabled ? '已配置，具体运行见下方状态' : '默认关闭'}
        </span>
      </summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          复用健康车间的
          Loop，只生成明日草稿，由你核对采用。需要先保存明日时间条件；没有条件时明确返回需要补充。电脑或本地服务停止时不能执行。
        </p>
        {loadError && (
          <p role="alert" className="text-sm">
            {loadError}
          </p>
        )}
        <div className="grid grid-cols-3 gap-4">
          <label className="space-y-2 text-sm">
            <span className="block">每天生成时段（北京时间）</span>
            <Input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm">
            <span className="block">生成方式</span>
            <select
              className="h-10 w-full rounded-md border bg-background px-3"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="catalog">目录排布，不调用模型</option>
              <option value="pi">Pi 模型，需数据授权并使用额度</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            开启持续任务
          </label>
        </div>
        <Button
          variant="outline"
          disabled={Boolean(busy) || saving || (!status && !enabled)}
          onClick={() => void save()}
        >
          {saving ? '正在保存…' : '保存持续任务设置'}
        </Button>
        {status && (
          <div className="space-y-2 border-t pt-4 text-sm">
            <Button
              variant="ghost"
              disabled={saving || Boolean(busy)}
              onClick={() =>
                void load()
                  .then(() => setLoadError(''))
                  .catch((e) => setLoadError(e.message))
              }
            >
              查询运行状态
            </Button>
            {'worker' in status && (
              <p>
                后台服务：
                {status.worker.state === 'online'
                  ? '在线'
                  : status.worker.state === 'offline'
                    ? '离线，自动任务暂不运行'
                    : '状态未知，请检查后台'}
                {status.worker.heartbeatAt
                  ? ` · 最近心跳 ${new Date(status.worker.heartbeatAt).toLocaleString('zh-CN')}`
                  : ''}
              </p>
            )}
            <p>
              关联 Loop：
              {status.state === 'active'
                ? '可调度'
                : status.state === 'paused'
                  ? '已暂停'
                  : status.state}{' '}
              · {'loopState' in status ? status.loopState : '状态不可用'}
            </p>
            <p>
              最近运行：
              {'lastRunAt' in status && status.lastRunAt
                ? new Date(status.lastRunAt).toLocaleString('zh-CN')
                : '尚无运行记录'}
              {'lastRunStatus' in status && status.lastRunStatus
                ? ` · ${status.lastRunStatus}`
                : ''}
            </p>
            <p>
              下次运行：
              {'nextRunAt' in status && status.nextRunAt
                ? new Date(status.nextRunAt).toLocaleString('zh-CN')
                : status.state === 'paused'
                  ? '已暂停，不安排下次运行'
                  : '等待调度器计算；请查看关联车间'}
            </p>
            {'updatedAt' in status && status.updatedAt && (
              <p>
                最近状态更新：
                {new Date(status.updatedAt).toLocaleString('zh-CN')}
              </p>
            )}
            {'lastError' in status && status.lastError && (
              <p role="alert">失败原因：{String(status.lastError)}</p>
            )}
            <a
              className="underline"
              href={`/workshop?workshopId=${status.workId}`}
            >
              查看关联车间、Loop 与运行记录
            </a>
          </div>
        )}
      </div>
    </details>
  );
}
