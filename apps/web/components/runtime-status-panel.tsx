"use client";

import useSWR from 'swr';
import Link from 'next/link';
import type { RuntimeWorkerStatus } from '@/lib/runtime/worker-status';

type Snapshot = { generatedAt: string; worker: RuntimeWorkerStatus };
const names: Record<string, string> = {
  'loop-admission': '持续任务排队', 'loop-execution': '持续任务执行器',
  'work-execution': '车间执行器', 'heartbeat-admission': '车间定时唤醒',
  'interaction-processing': '消息理解', 'interaction-ingestion': '消息采集',
  'outbox-recovery': '外发结果核对', 'paper-matching': '模拟盘撮合',
};
const phases: Record<string, string> = { idle: '等待检查', running: '本轮处理中',
  stopping: '正在停止，结果待确认', success: '最近一轮成功', error: '最近一轮异常',
  settled_after_abort: '本轮已结束，曾请求中止' };
const reasons: Record<string, string> = {
  loop_migration_required: '有已到期的旧任务尚未归属车间，无法排队。请到自动任务页面迁入车间，或停用不再需要的旧任务。',
  loop_admission_failed: '部分持续任务未能排队，请检查任务状态；其他符合条件的任务会继续调度。',
  paper_migration_required: '模拟账户尚未完成迁移或配置，撮合未启动',
  interaction_processing_needs_review: '消息理解结果可能部分写入，已暂停这些任务的自动重试，等待核对',
  deadline_exceeded: '处理超时，正在核对是否结束',
  previous_run_unsettled: '上一轮尚未结束，跳过重复启动',
};
const date = (value: number | string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无记录';
async function readStatus(url: string): Promise<Snapshot> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('runtime_status_unavailable');
  return response.json();
}

export function RuntimeStatusPanel() {
  const { data, error, isValidating, mutate } = useSWR<Snapshot>('/api/runtime/bootstrap', readStatus, {
    refreshInterval: 15000, refreshWhenHidden: false, refreshWhenOffline: false,
    dedupingInterval: 5000, shouldRetryOnError: false,
  });
  const worker = data?.worker;
  const unknown = !!error || !worker || worker.state === 'unavailable';
  const label = unknown ? '后台状态待确认' : worker.online ?
    worker.phase === 'stopping' ? '后台正在停止' : worker.desiredStatus === 'paused' ? '后台在线 · 已暂停新调度' : '后台在线' : '后台离线';
  return <section aria-label="后台运行状态" className="min-w-0 rounded-lg border bg-background p-4 text-sm [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div role="status"><strong>{label}</strong><span className="ml-3 text-muted-foreground">{error ? '网页连接待确认' : data ? 'Web 在线' : '正在读取状态'}</span></div>
      <button type="button" className="rounded border px-3 py-1.5 disabled:opacity-50" disabled={isValidating} onClick={() => void mutate().catch(() => {})}>{isValidating ? '读取中…' : '刷新后台状态'}</button>
    </div>
    <p className="mt-2 text-muted-foreground">{unknown ? '暂时无法确认后台运行情况，请刷新重试。' : worker.online ?
      worker.desiredStatus === 'paused' ? '已暂停领取新任务；正在处理的操作仍需等待结果。' : '模块运行不等于某个任务正在执行；具体任务结果请查看车间记录。' :
      '后台未启动、已停止或心跳已过期。打开页面不会启动后台，请检查本机服务。'}</p>
    {data && <p className="mt-2 text-xs text-muted-foreground">{error ? '上次查询' : '查询时间'}：{date(data.generatedAt)} · 最近心跳：{date(worker?.heartbeatAt ?? null)}{worker?.heartbeatAgeMs != null ? `（查询时距今 ${Math.floor(worker.heartbeatAgeMs / 1000)} 秒）` : ''}</p>}
    {!!worker?.modules.some(module => module.lastError) && <p className="mt-2 text-destructive">{unknown || !worker.online ? '上次记录中' : '当前'}有 {worker.modules.filter(module => module.lastError).length} 个模块异常，请展开查看原因。</p>}
    {worker?.modules.some(module=>module.lastError==='interaction_processing_needs_review')&&<Link href="/interaction-reviews" className="mt-2 inline-block underline">查看消息理解待核对任务</Link>}
    {!!worker?.modules.length && <details className="mt-3">
      <summary className="cursor-pointer">查看 {worker.modules.length} 个模块{unknown || !worker.online ? '的上次状态（非实时）' : '状态'}</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {worker.modules.map(module => <article key={module.name} className="min-w-0 rounded border p-3">
          <h3 className="font-medium">{names[module.name] ?? module.name}</h3>
          <p className="mt-1">{phases[module.phase] ?? '状态待确认'}</p>
          {module.lastError && <p className="mt-1 text-destructive">{reasons[module.lastError] ?? `处理异常：${module.lastError}`}</p>}
          {module.name==='loop-admission'&&module.lastError&&<a href="/loops" className="mt-2 inline-block underline">{module.lastError==='loop_migration_required'?'处理未迁入车间的旧任务':'查看持续任务'}</a>}
          {module.skipReason && <p className="mt-1 text-muted-foreground">{reasons[module.skipReason] ?? module.skipReason}</p>}
          <p className="mt-2 text-xs">最近开始：{date(module.lastStartedAt)}</p>
          <p className="mt-1 text-xs">最近成功：{date(module.lastSuccessAt)}</p>
          <p className="mt-1 text-xs">下次检查：{unknown || !worker.online || worker.desiredStatus !== 'running' ? '待恢复调度后确认' : module.inFlight ? '等待本轮结束' : date(module.nextRunAt)}</p>
        </article>)}
      </div>
    </details>}
  </section>;
}
