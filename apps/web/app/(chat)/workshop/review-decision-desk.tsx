"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import { Button } from "@openzhiyu/ui";
import type { ReviewAssistantDecision, ReviewAssistantItem, ReviewAssistantResponse } from "@/lib/workshops/review-assistant";
import { cn } from "@/lib/utils";

export type ReviewDecisionDeskProps = {
  workId: string;
  actorId?: string;
  refreshKey: string | number;
  onSelectReview: (id: string) => void;
};

type View = "priority" | "following" | "all";
type Following = { version: 1; ids: string[] };
const CATEGORY_ORDER: ReviewAssistantItem["category"][] = ["required", "optional", "anomaly"];
const CATEGORY_LABELS = { required: "待你决定", optional: "可选改进", anomaly: "异常" };
const PRIORITY_LABELS = { first: "优先查看", normal: "正常查看", later: "可以稍后" };
const DECISION_LABELS: Record<ReviewAssistantDecision["outcome"], string> = {
  closed_for_now: "暂不跟进", owner_review: "交你审核", investigate: "先核查事实",
};

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待核实" : date.toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function errorMessage(status: number, payload: unknown) {
  const code = payload && typeof payload === "object" ? (payload as Record<string, unknown>).error : null;
  if (code === "actor_changed") return "登录身份已变化，请刷新页面后重试。";
  if (code === "source_changed" || status === 409) return "待办内容刚刚发生变化，请先刷新事项，再请 AI 帮你看。";
  if (status === 401 || status === 403) return "登录身份或访问权限已变化，请刷新页面后重试。";
  if (status === 404) return "当前智能体已不存在或无法访问，请重新选择智能体。";
  if (status === 429) return "AI 正在处理其他请求，请稍后重试。";
  return "暂时无法读取决策事项，请稍后刷新重试。";
}

function checkedResponse(value: unknown, workId: string): ReviewAssistantResponse {
  const data = value as ReviewAssistantResponse | null;
  if (!data || data.version !== 1 || data.workId !== workId || typeof data.fingerprint !== "string" ||
    !["rules", "ai"].includes(data.mode) || !data.coverage || !Array.isArray(data.items) ||
    !data.items.every((item) => item && typeof item.id === "string" && typeof item.title === "string" &&
      CATEGORY_ORDER.includes(item.category) && Array.isArray(item.evidence) && Array.isArray(item.missingInfo) &&
      (item.knownFacts === undefined || Array.isArray(item.knownFacts) && item.knownFacts.every((fact) => typeof fact === "string")) &&
      (item.nextStep === undefined || typeof item.nextStep === "string")) ||
    data.decisions !== undefined && (!Array.isArray(data.decisions) || !data.decisions.every(decision =>
      decision && typeof decision.itemId === "string" && typeof decision.reason === "string" &&
      Array.isArray(decision.knownFacts) && Array.isArray(decision.evidence) && Array.isArray(decision.missingInfo)))) {
    throw new Error("事项返回内容不完整，请刷新后重新核对。");
  }
  return data;
}

async function readAssistant(url: string, workId: string) {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    if (!response.ok) throw new Error(errorMessage(response.status, payload));
    return checkedResponse(payload, workId);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("读取事项用时过长，请刷新重试。");
    }
    throw error instanceof Error && error.message.includes("请") ? error :
      new Error("暂时无法读取决策事项，请检查连接后重试。");
  }
}

function readFollowing(storageKey: string): string[] {
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return [];
  const value = JSON.parse(raw) as Following;
  if (value.version !== 1 || !Array.isArray(value.ids) ||
    !value.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)) {
    throw new Error("invalid_following");
  }
  return [...new Set(value.ids)].slice(-200);
}

function isPriority(item: ReviewAssistantItem, decision?: ReviewAssistantDecision) {
  if (decision?.outcome === "investigate") return false;
  return item.category === "required" || item.category === "anomaly" || item.priority === "first";
}

export function ReviewDecisionDesk(props: ReviewDecisionDeskProps) {
  const { data: session, status } = useSession();
  const actorId = props.actorId ?? session?.user?.id;
  if (!actorId) return <section aria-label="老板决策台" className="rounded-md border bg-background p-4">
    <h2 className="text-base font-semibold">AI 决策记录</h2>
    <p className="mt-2 text-sm text-muted-foreground">{status === "loading" ? "正在确认当前身份…" : "请登录后查看当前智能体的决策事项。"}</p>
  </section>;
  return <ReviewDecisionDeskSession key={`${actorId}:${props.workId}`} {...props} actorId={actorId} />;
}

function ReviewDecisionDeskSession({ workId, actorId, refreshKey, onSelectReview }: ReviewDecisionDeskProps & { actorId: string }) {
  const url = `/api/workshops/${encodeURIComponent(workId)}/review-assistant`;
  const storageKey = `zhiyu.review-following.v1.${actorId}.${workId}`;
  const [assisting, setAssisting] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const deferredRefreshRef = useRef(false);
  const { data, error: readError, isLoading, isValidating, mutate } = useSWR<ReviewAssistantResponse>(
    [url, actorId], ([requestUrl]: [string, string]) => readAssistant(requestUrl, workId), {
      refreshInterval: assisting ? 0 : 30000,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: !assisting,
      isPaused: () => Boolean(requestRef.current),
      errorRetryCount: 1,
      errorRetryInterval: 5000,
      onSuccess: () => setLastCheckedAt(new Date().toISOString()),
    },
  );
  const [view, setView] = useState<View>("priority");
  const [following, setFollowing] = useState<string[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const refreshRef = useRef(refreshKey);

  useEffect(() => {
    mountedRef.current = true;
    const restore = () => {
      try { setFollowing(readFollowing(storageKey)); setStorageWarning(null); }
      catch { setStorageWarning("上次关注列表未能读取。仍可查看所有事项，重新关注后会保存新的列表。"); }
      setStorageReady(true);
    };
    restore();
    const onStorage = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) restore(); };
    window.addEventListener("storage", onStorage);
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      window.removeEventListener("storage", onStorage);
    };
  }, [storageKey]);

  useEffect(() => {
    if (refreshRef.current === refreshKey) return;
    refreshRef.current = refreshKey;
    if (requestRef.current) { deferredRefreshRef.current = true; return; }
    void mutate().catch(() => {});
  }, [refreshKey, mutate]);

  function toggleFollowing(id: string) {
    const next = following.includes(id) ? following.filter((value) => value !== id) : [...following, id].slice(-200);
    setFollowing(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ version: 1, ids: next } satisfies Following));
      setStorageWarning(null);
    } catch { setStorageWarning("关注暂时只在当前页面生效，浏览器未能保存；刷新后请重新核对。"); }
  }

  async function requestAssistance() {
    if (requestRef.current || !data || readError) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setAssisting(true);
    setAssistError(null);
    const timeout = window.setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Work-Actor": actorId },
        body: JSON.stringify({ fingerprint: data.fingerprint }), signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessage(response.status, payload));
      const result = checkedResponse(payload, workId);
      if (mountedRef.current) {
        let changed = false;
        await mutate((current) => {
          if (current && current.fingerprint !== data.fingerprint) { changed = true; return current; }
          return result;
        }, { revalidate: false });
        setLastCheckedAt(new Date().toISOString());
        if (changed && mountedRef.current) setAssistError("待办内容在 AI 整理期间发生了变化，已保留最新事项，请重新分析。");
      }
    } catch (error) {
      if (mountedRef.current) setAssistError(controller.signal.aborted
        ? "AI 整理用时过长，结果尚未确认。请先刷新事项，再重试。"
        : error instanceof Error && error.message.includes("请") ? error.message : "AI 暂时无法完成整理，可以继续查看事项，稍后再试。");
    } finally {
      window.clearTimeout(timeout);
      requestRef.current = null;
      if (mountedRef.current) {
        setAssisting(false);
        if (deferredRefreshRef.current) {
          deferredRefreshRef.current = false;
          void mutate().catch(() => {});
        }
      }
    }
  }

  async function restoreDecision(decision: ReviewAssistantDecision) {
    if (!decision.decisionEventId || restoringId) return;
    setRestoringId(decision.itemId);
    setAssistError(null);
    try {
      const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Work-Actor": actorId },
        body: JSON.stringify({ itemId: decision.itemId, decisionEventId: decision.decisionEventId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessage(response.status, payload));
      await mutate(checkedResponse(payload, workId), { revalidate: false });
    } catch (error) { setAssistError(error instanceof Error ? error.message : "恢复待办失败，请刷新后重试。"); }
    finally { setRestoringId(null); }
  }

  const items = data?.items ?? [];
  const decisions = data?.decisions ?? [];
  const decisionByItem = new Map(decisions.map(decision => [decision.itemId, decision]));
  const followedIds = new Set(following);
  const counts = {
    required: items.filter((item) => item.category === "required").length,
    optional: items.filter((item) => item.category === "optional").length,
    anomaly: items.filter((item) => item.category === "anomaly").length,
    priority: items.filter(item => isPriority(item, decisionByItem.get(item.id))).length,
    following: items.filter((item) => followedIds.has(item.id)).length,
  };
  const unattended = items.filter((item) => isPriority(item, decisionByItem.get(item.id)) && !followedIds.has(item.id)).length;
  const visibleItems = items.filter((item) => view === "all" || (view === "following" ? followedIds.has(item.id) : isPriority(item, decisionByItem.get(item.id))));

  return <section aria-label="老板决策台" className="min-w-0 rounded-md border border-border bg-background">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-5">
      <div className="max-w-2xl">
        <h2 className="text-base font-semibold text-foreground">AI 决策记录</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">AI 处理可判断的事项并留下依据；需要你审核的事项会单独显示。</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={isValidating || assisting}
          onClick={() => { setAssistError(null); void mutate().catch(() => {}); }}>刷新事项</Button>
        <Button type="button" size="sm" disabled={!data || !items.length || Boolean(readError) || assisting || isValidating}
          onClick={() => void requestAssistance()}>{assisting ? "AI 正在决策…" : "AI 帮我决策"}</Button>
      </div>
    </header>
    <div className="space-y-4 px-4 py-4 sm:px-5">
      {readError ? <p role="alert" className="text-sm leading-6 text-rose-800">{readError instanceof Error ? readError.message : "事项读取失败，请刷新重试。"}{data ? " 下方保留上次读取的内容，状态可能已经变化。" : ""}</p> : null}
      {assistError ? <p role="alert" className="text-sm leading-6 text-amber-900">{assistError}</p> : null}
      {data?.warning ? <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{data.warning}</p> : null}
      {isLoading ? <p role="status" className="py-4 text-sm text-muted-foreground">正在核对待办事项…</p> : null}
      {data ? <>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs leading-5 text-muted-foreground">
          <p><span className="font-medium text-foreground">{decisions.length ? "AI 已作出决定" : "待 AI 决策"}</span>
            {data.mode === "ai" ? ` · 已分析 ${data.coverage.analyzed} 项` : " · 尚未使用 AI 分析"}
            {decisions.length ? ` · 留存 ${decisions.length} 条决策记录` : ""}</p>
          <p className="flex flex-wrap gap-x-3">
            {data.mode === "ai" ? <span>AI 整理于 {timeLabel(data.generatedAt)}</span> : null}
            {lastCheckedAt ? <span>事项核对于 {timeLabel(lastCheckedAt)}</span> : <span>正在核对事项状态</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-y py-3 text-xs text-muted-foreground" aria-label="事项分类概况">
          {CATEGORY_ORDER.map((category) => <span key={category}>{CATEGORY_LABELS[category]} <strong className="ml-1 text-sm font-semibold text-foreground">{counts[category]}</strong></span>)}
          <span className="ml-auto">暂不跟进的事项已从待办移出，可在下方查看依据并恢复。</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1" role="group" aria-label="筛选决策事项">
            {(["priority", "following", "all"] as const).map((option) => <button key={option} type="button"
              aria-pressed={view === option} onClick={() => setView(option)}
              className={cn("rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600",
                view === option ? "bg-violet-100 text-violet-900" : "text-muted-foreground hover:bg-muted")}>
              {option === "priority" ? "优先看" : option === "following" ? "我关注" : "全部"} {option === "all" ? items.length : counts[option]}
            </button>)}
          </div>
          {unattended > 0 ? <p className="text-xs leading-5 text-amber-900">还有 {unattended} 项优先事项未关注，仍待处理。</p> : null}
        </div>
        {data.coverage.note ? <p className={cn("text-xs leading-5", data.coverage.hasMore || data.coverage.analyzed < items.length && data.mode === "ai"
          ? "text-amber-900" : "text-muted-foreground")}>{data.coverage.note}</p> : null}
        {assisting ? <p role="status" className="text-xs leading-5 text-violet-800">AI 正在核对事项并写入决策记录，完成后显示处理结果。</p> : null}
        {!items.length ? <div className="py-5 text-sm leading-6 text-muted-foreground">
          <p className="font-medium text-foreground">当前没有待查看的事项记录。</p>
          <p>智能体提出改进、需要你的决定或发现异常时，会在这里说明。</p>
        </div> : !visibleItems.length ? <div className="py-5 text-sm leading-6 text-muted-foreground">
          <p>{view === "following" ? "你还没有关注当前列表中的事项。" : "当前没有需要优先查看的事项。"}</p>
          <button type="button" className="mt-1 text-violet-800 underline underline-offset-4" onClick={() => setView("all")}>查看全部 {items.length} 项</button>
        </div> : CATEGORY_ORDER.map((category) => {
          const group = visibleItems.filter((item) => item.category === category);
          if (!group.length) return null;
          return <div key={category} className="space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground">{CATEGORY_LABELS[category]} · {group.length}</h3>
            {group.map((item) => <ReviewDecisionCard key={item.id} item={item} decision={decisionByItem.get(item.id)} followed={followedIds.has(item.id)}
              canFollow={storageReady} onFollow={() => toggleFollowing(item.id)} onSelect={() => onSelectReview(item.id)} />)}
          </div>;
        })}
        {decisions.length ? <section aria-label="AI 决策记录" className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-semibold">近期 AI 决策</h3>
          <p className="text-xs leading-5 text-muted-foreground">这里保留当时的处理结论和依据；暂不跟进的待办可以恢复。</p>
          {decisions.map(decision => <article key={`${decision.decisionEventId}:${decision.itemId}`} className="rounded-md border p-3 text-xs leading-5" aria-label={`AI 决策：${decision.title}`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{decision.title}</h4>
              <div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => onSelectReview(decision.itemId)}>查看原始事项</Button>
                {decision.applied && decision.decisionEventId ? <Button type="button" size="sm" variant="outline" disabled={Boolean(restoringId)} onClick={() => void restoreDecision(decision)}>{restoringId === decision.itemId ? "正在恢复…" : "恢复待办"}</Button> : null}</div></div>
            <p className="mt-2">决定：{decision.outcome === "closed_for_now" ?
              decision.applied ? "暂不跟进当前车间的这条事项。" : "这条事项已恢复待办，原决定保留供追溯。" :
              decision.outcome === "owner_review" ? "交你审核原始改动，AI 不会替你执行受保护的操作。" : "先核查事实；当前尚未派发核查任务。"}</p>
            <p className="mt-1">依据：{decision.reason}</p>
            {decision.knownFacts.length ? <ul className="mt-1 list-disc pl-4 text-muted-foreground">{decision.knownFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul> : null}
            {decision.evidence.length ? <details className="mt-2"><summary className="cursor-pointer">来源记录摘要</summary><ul className="mt-1 list-disc pl-4">{decision.evidence.map((fact, index) => <li key={index}>{fact}</li>)}</ul></details> : null}
            {decision.missingInfo.length ? <details className="mt-2"><summary className="cursor-pointer">仍需核对的内容</summary><ul className="mt-1 list-disc pl-4">{decision.missingInfo.map((fact, index) => <li key={index}>{fact}</li>)}</ul></details> : null}
            {decision.decidedAt ? <p className="mt-2 text-muted-foreground">决定于 {timeLabel(decision.decidedAt)} · 来源更新于 {timeLabel(decision.sourceUpdatedAt)}</p> : null}
          </article>)}
        </section> : null}
      </> : null}
      {storageWarning ? <p role="status" className="text-xs leading-5 text-amber-900">{storageWarning}</p> : null}
    </div>
  </section>;
}

function ReviewDecisionCard({ item, decision, followed, canFollow, onFollow, onSelect }: {
  item: ReviewAssistantItem;
  decision?: ReviewAssistantDecision;
  followed: boolean;
  canFollow: boolean;
  onFollow: () => void;
  onSelect: () => void;
}) {
  return <article className="min-w-0 rounded-md border border-border px-4 py-4" aria-label={item.title}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h4 className="break-words text-base font-semibold leading-6 text-foreground">{item.title}</h4>
        <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{PRIORITY_LABELS[item.priority]} · {item.prioritySource === "ai" ? "AI 判断" : "事项分流规则"}</p>
      </div>
      <button type="button" aria-pressed={followed} aria-label={`${followed ? "取消关注" : "关注"}：${item.title}`}
        disabled={!canFollow} onClick={onFollow}
        className={cn("shrink-0 rounded-md border px-2.5 py-1.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 disabled:opacity-50",
          followed ? "border-violet-200 bg-violet-50 text-violet-900" : "border-border text-muted-foreground hover:bg-muted")}>
        {followed ? "已关注" : "关注"}
      </button>
    </div>
    <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm leading-6 lg:grid-cols-[7rem_minmax(0,1fr)]">
      <dt className="text-xs font-medium text-muted-foreground lg:pt-0.5">这是什么事</dt>
      <dd className="break-words text-foreground">{item.what}</dd>
      <dt className="text-xs font-medium text-muted-foreground lg:pt-0.5">为什么找你</dt>
      <dd className="break-words text-foreground">{item.whyOwner}</dd>
      <dt className="text-xs font-medium text-muted-foreground lg:pt-0.5">需要决定什么</dt>
      <dd className="break-words text-foreground">{item.decision}</dd>
    </dl>
    <div className={cn("mt-3 rounded-md px-3 py-2.5 text-xs leading-6", item.aiAssisted ? "bg-violet-50/70" : "bg-muted/50")}>
      <p className="font-medium text-foreground">{decision ? `AI 决定 · ${DECISION_LABELS[decision.outcome]}` : item.aiAssisted ? "AI 判断待留痕" : "待 AI 决策"}</p>
      <dl className="mt-2 space-y-2">
        {item.knownFacts?.length ? <div>
          <dt className="font-medium text-foreground">已知情况</dt>
          <dd className="text-muted-foreground">
            <ul className="list-disc space-y-0.5 pl-4">
              {item.knownFacts.map((fact, index) => <li key={`${index}:${fact}`} className="break-words">{fact}</li>)}
            </ul>
          </dd>
        </div> : null}
        <div>
          <dt className="font-medium text-foreground">{decision ? "决策依据" : "判断依据"}</dt>
          <dd className="break-words text-muted-foreground">{decision?.reason ?? item.reason}</dd>
        </div>
        {item.missingInfo.length ? <div>
          <dt className="font-medium text-amber-900">还需核对</dt>
          <dd className="text-amber-900">
            <ul className="list-disc space-y-0.5 pl-4">
              {item.missingInfo.map((missing, index) => <li key={`${index}:${missing}`} className="break-words">{missing}</li>)}
            </ul>
          </dd>
        </div> : null}
        {item.nextStep ? <div>
          <dt className="font-medium text-foreground">后续处理</dt>
          <dd className="break-words text-foreground">{item.nextStep}</dd>
        </div> : null}
      </dl>
    </div>
    <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
      <details className="min-w-0 flex-1 text-xs leading-6 text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600">查看影响和依据</summary>
        <p className="mt-2 break-words"><span className="font-medium text-foreground">可能影响：</span>{item.impact}</p>
        {item.evidence.length ? <ul className="mt-1 list-disc space-y-1 pl-5">
          {item.evidence.map((evidence, index) => <li key={`${index}:${evidence}`} className="break-words">{evidence}</li>)}
        </ul> : <p className="mt-1">当前没有可展示的依据，请打开事项核对原始记录。</p>}
        <p className="mt-2">来源更新于 {timeLabel(item.sourceUpdatedAt)} · {item.aiAssisted ? "AI 根据关联记录给出建议，详情中可核对原文。" : "以上为事项规则整理，可请 AI 进一步分析。"}</p>
      </details>
      <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onSelect}>查看这件事</Button>
    </div>
  </article>;
}
