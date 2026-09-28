"use client";

import type {OwnerWorkOverview, OwnerWorkOverviewResponse} from "@/lib/workshops/owner-overview";
import {cn} from "@/lib/utils";

type Work = {id: string; name: string; status: string};

const stateLabel: Record<OwnerWorkOverview["execution"]["state"], string> = {
  running: "正在执行", queued: "等待执行", waiting_colleague: "等待同事",
  needs_verification: "待验证回复", scheduled: "等待下次工作", idle: "空闲",
  paused: "已暂停", archived: "已归档", uncertain: "状态待核对",
};

function formatWhen(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("zh-CN", {month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit"}).format(new Date(value));
}

function decisionCount(item: OwnerWorkOverview) {
  return item.attention.review + item.attention.loopApproval + item.attention.outboxApproval;
}

function hasInvestigation(item: OwnerWorkOverview) {
  const a = item.attention;
  return a.reviewOther + a.loopBlocker + a.outboxBlocked + a.outboxUnknown + a.collaboration + a.runNeedsReview > 0 ||
    item.execution.state === "uncertain";
}

export function OwnerTeamRoster({works, overview, selectedId, onSelect, error, onRefresh}: {
  works: Work[];
  overview: OwnerWorkOverviewResponse | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  error: boolean;
  onRefresh: () => void;
}) {
  const byId = new Map(overview?.works.map((item) => [item.workId, item]) ?? []);
  const decisions = overview?.works.filter((item) => decisionCount(item) > 0).length ?? null;
  const investigations = overview?.works.filter(hasInvestigation).length ?? null;
  const running = overview?.works.filter((item) => item.execution.state === "running").length ?? null;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b pb-3 text-xs text-muted-foreground" aria-label="团队工作概况">
      <span>有事等你决定 <strong className="font-semibold text-foreground">{decisions ?? "待读取"}</strong> 位</span>
      <span>有建议或异常可看 <strong className="font-semibold text-foreground">{investigations ?? "待读取"}</strong> 位</span>
      <span>正在执行 <strong className="font-semibold text-foreground">{running ?? "待读取"}</strong> 位</span>
      {overview?.asOf ? <span className="ml-auto">核对于 {formatWhen(overview.asOf)}</span> : null}
    </div>
    {error ? <div role="alert" className="flex items-center gap-2 text-xs text-amber-800">
      当前工作状态读取失败，不能确认员工是否正在执行。
      <button type="button" className="underline" onClick={onRefresh}>重新读取</button>
    </div> : null}
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
      {works.map((work) => {
        const item = error ? null : byId.get(work.id);
        const selected = selectedId === work.id;
        const decision = item ? decisionCount(item) : 0;
        const investigate = item ? hasInvestigation(item) : false;
        return <button key={work.id} type="button" onClick={() => onSelect(work.id)}
          aria-pressed={selected} data-workshop-id={work.id}
          className={cn("min-w-0 rounded-md border px-3 py-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600",
            selected ? "border-violet-500 bg-violet-50/60" : "border-border bg-background hover:bg-muted/50")}>
          <span className="flex items-start justify-between gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{work.name}</span>
            <span className={cn("shrink-0 text-[11px] font-medium",
              item?.execution.state === "running" ? "text-emerald-700" :
                item?.execution.state === "uncertain" ? "text-amber-700" : "text-muted-foreground")}>
              {item ? stateLabel[item.execution.state] : "状态未确认"}
            </span>
          </span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {item ? item.execution.title : "正在读取当前工作"}
          </span>
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {decision > 0 ? <span className="font-medium text-amber-800">等你决定 {decision} 项</span> : null}
            {investigate ? <span className="font-medium text-muted-foreground">有建议或异常可看</span> : null}
            {item?.execution.nextAt ? <span className="text-muted-foreground">下次 {formatWhen(item.execution.nextAt)}</span> : null}
            {!item ? <span className="text-muted-foreground">请稍后或重新读取</span> : null}
          </span>
        </button>;
      })}
    </div>
  </div>;
}

export function OwnerEmployeeStatus({item, error, onRefresh}: {
  item: OwnerWorkOverview | null;
  error: boolean;
  onRefresh: () => void;
}) {
  if (!item || error) return <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm">
    <p className="font-medium">当前工作状态未确认</p>
    <p className="mt-1 text-muted-foreground">不能根据上次交付判断员工现在是否在运行。</p>
    <button type="button" className="mt-2 text-xs underline" onClick={onRefresh}>重新读取工作状态</button>
  </div>;
  const a = item.attention;
  const decisions = decisionCount(item);
  return <div className="space-y-4" aria-label="员工当前工作">
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold",
        item.execution.state === "running" ? "bg-emerald-100 text-emerald-800" :
          item.execution.state === "uncertain" ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-700")}>
        {stateLabel[item.execution.state]}
      </span>
      {item.execution.sinceAt ? <span className="text-xs text-muted-foreground">状态起于 {formatWhen(item.execution.sinceAt)}</span> : null}
    </div>
    <div>
      <p className="text-xs font-medium text-muted-foreground">现在</p>
      <h2 className="mt-1 text-2xl font-semibold leading-tight text-foreground">{item.execution.title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.execution.detail}</p>
    </div>
    <div className="grid gap-3 border-y py-4 sm:grid-cols-2">
      <div><p className="text-xs font-medium text-muted-foreground">下一步</p>
        <p className="mt-1 text-sm">{
          item.execution.state === "running" || item.execution.state === "queued" ? "等待本轮执行结果" :
            item.execution.state === "waiting_colleague" ? "收到同事回复后继续" :
              item.execution.state === "needs_verification" ? "核对回复并决定是否继续" :
                item.execution.state === "uncertain" ? "先核对运行或调度状态" :
                  item.execution.state === "paused" || item.execution.state === "archived" ? "当前不会自动执行" :
                    item.execution.nextAt
                      ? `${item.execution.nextLabel ?? "下一次工作"} · ${formatWhen(item.execution.nextAt)}`
                      : "暂无已确认的下一次安排"}</p>
      </div>
      <div><p className="text-xs font-medium text-muted-foreground">老板关注</p>
        <p className="mt-1 text-sm">{decisions > 0 ? `有 ${decisions} 件事等你决定` : "目前没有必须由你批准的事项"}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">先看下方决策台了解事情，再选你关注的展开。</p>
      </div>
    </div>
    {(a.reviewOther + a.loopBlocker + a.outboxBlocked + a.outboxUnknown + a.collaboration + a.runNeedsReview > 0) ?
      <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-900">
        待查看：{[
          a.reviewOther ? `${a.reviewOther} 条改进建议或待核查记录` : null,
          a.loopBlocker ? `${a.loopBlocker} 项工作受阻` : null,
          a.outboxUnknown ? `${a.outboxUnknown} 项发送状态未知` : null,
          a.outboxBlocked ? `${a.outboxBlocked} 项待发受阻` : null,
          a.collaboration ? `${a.collaboration} 项同事协作异常` : null,
          a.runNeedsReview ? `${a.runNeedsReview} 次运行需复核` : null,
        ].filter(Boolean).join(" · ")}。这些不自动等于需要老板批准。
      </div> : null}
    {a.drafts > 0 ? <p className="text-xs text-muted-foreground">另有 {a.drafts} 份草稿；草稿不计入老板待审核。</p> : null}
  </div>;
}
