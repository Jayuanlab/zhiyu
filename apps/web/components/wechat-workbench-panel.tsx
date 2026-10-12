"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@openzhiyu/ui";
import { RemixIcon } from "@/components/remix-icon";
import { Spinner } from "@/components/spinner";
import { MemoryDependencyPanel, MemoryDependencyRecovery } from "./memory-dependency-panel";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";

interface WechatWorkbenchDigest {
  generatedAt: string;
  lastSourceObservedAt: string | null;
  lastSourceCollectedAt: string | null;
  lastIngestSucceededAt: string | null;
  attentionItems: Array<{id: string; kind: "task" | "risk" | "reply" | "memory"; priority: number; item: Record<string, unknown>}>;
  pagination: Record<string, {total: number; returned: number; hasMore: boolean; cursor: string | null}>;
  counts: {
    pendingTasks: number;
    replyNeededEvents: number;
    riskNotes: number;
    memoryCandidates: number;
  };
  pendingTasks: Array<Record<string, unknown>>;
  replyNeededEvents: Array<Record<string, unknown>>;
  riskNotes: Array<Record<string, unknown>>;
  memoryCandidates: Array<Record<string, unknown>>;
}

interface WechatScenarioList {
  count: number;
  scenarios: Array<Record<string, unknown>>;
}

export function WechatWorkbenchPanel({
  className,
  onOpenReview,
}: {
  className?: string;
  onOpenReview: () => void;
}) {
  const [digest, setDigest] = useState<WechatWorkbenchDigest | null>(null);
  const [scenarios, setScenarios] = useState<WechatScenarioList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewingKey, setReviewingKey] = useState<string | null>(null);
  const [evidenceForKey, setEvidenceForKey] = useState<string | null>(null);
  const [evidenceEvents, setEvidenceEvents] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [timeReviewFor, setTimeReviewFor] = useState<string | null>(null);
  const [correctedTime, setCorrectedTime] = useState("");

  const loadWorkbench = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const [digestRes, scenariosRes] = await Promise.all([
        fetch(`/api/interactions/todo-digest?limit=12&sinceDays=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
          credentials: "include",
        }),
        fetch("/api/interactions/scenarios?limit=8", {
          credentials: "include",
        }),
      ]);
      if (!digestRes.ok) throw new Error("无法读取微信待办摘要");
      const next = await digestRes.json() as WechatWorkbenchDigest;
      setDigest(previous => cursor && previous ? {...next, attentionItems: [...new Map([...previous.attentionItems, ...next.attentionItems].map(item => [`${item.kind}:${item.id}`, item])).values()].sort((a,b) => a.priority - b.priority)} : next);
      if (!scenariosRes.ok) throw new Error("无法读取微信场景状态");
      setScenarios(await scenariosRes.json());
    } catch (loadError) {
      console.error("[WechatWorkbenchPanel] load failed:", loadError);
      setError(
        loadError instanceof Error ? loadError.message : "微信代看数据加载失败",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkbench();
  }, [loadWorkbench]);

  const counts = digest?.counts ?? {
    pendingTasks: null,
    replyNeededEvents: null,
    riskNotes: null,
    memoryCandidates: null,
  };
  const priorityItems = (digest?.attentionItems ?? []).map(entry => {
    const item = entry.item;
    const state = (item.taskState ?? {}) as Record<string, unknown>;
    return {
      id: entry.id, kind: entry.kind, reviewKind: entry.kind === "task" ? "task" : entry.kind === "memory" ? "memory" : null,
      title: itemTitle(item, ["title", "subject", "contentPreview", "content", "summary", "text"], entry.kind),
      meta: itemMeta(item), sourceEventIds: entry.kind === "reply" ? [entry.id] : stringArrayField(item.sourceEventIds),
      version: Number(state.version ?? 0), taskState: state,
    };
  });
  const nextCursor = Object.values(digest?.pagination ?? {}).find(page => page.hasMore)?.cursor ?? null;
  const scenarioItems = (scenarios?.scenarios ?? []).slice(0, 8);
  const updatedAt = digest?.generatedAt
    ? formatCompactDate(digest.generatedAt)
    : "尚未生成";

  async function reviewItem(
    item: (typeof priorityItems)[number],
    status: "confirmed" | "dismissed" | "done" | "snoozed" | "timeConfirmed",
    at?: string | null,
  ) {
    if (!item.reviewKind) return;
    const key = `${item.reviewKind}:${item.id}:${status}`;
    setReviewingKey(key);
    try {
      const response = await fetch("/api/interactions/wiki", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          kind: item.reviewKind,
          id: item.id,
          status,
          ...(item.reviewKind === "task" ? {
            action: ({confirmed: "confirmEvidence", dismissed: "dismiss", done: "completeTask", snoozed: "snooze", timeConfirmed: "correctTime"})[status],
            commandId: crypto.randomUUID(), expectedVersion: item.version,
            at: status === "snoozed" ? new Date(Date.now() + 24 * 3600_000).toISOString() : at,
          } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string" ? payload.error : "审核失败",
        );
      }
      toast({
        type: "success",
        description: ({confirmed: item.reviewKind === "task" ? "信息已确认，任务尚未完成" : "记忆已确认", dismissed: "已忽略", done: "任务已完成", snoozed: "已稍后处理一天", timeConfirmed: "期限已纠正"})[status],
      });
      await loadWorkbench();
      setTimeReviewFor(null);
    } catch (reviewError) {
      console.error("[WechatWorkbenchPanel] review failed:", reviewError);
      toast({
        type: "error",
        description:
          reviewError instanceof Error ? reviewError.message : "审核失败",
      });
    } finally {
      setReviewingKey(null);
    }
  }

  async function toggleEvidence(item: (typeof priorityItems)[number]) {
    if (evidenceForKey === item.id) {
      setEvidenceForKey(null);
      setEvidenceEvents([]);
      return;
    }
    if (item.sourceEventIds.length === 0) return;
    setEvidenceForKey(item.id);
    setLoadingEvidence(true);
    setEvidenceEvents([]);
    try {
      const response = await fetch("/api/interactions/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          eventIds: item.sourceEventIds,
          maxEvents: 20,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string" ? payload.error : "证据读取失败",
        );
      }
      setEvidenceEvents(Array.isArray(payload.events) ? payload.events : []);
    } catch (evidenceError) {
      console.error("[WechatWorkbenchPanel] evidence read failed:", evidenceError);
      toast({
        type: "error",
        description:
          evidenceError instanceof Error
            ? evidenceError.message
            : "微信证据读取失败",
      });
    } finally {
      setLoadingEvidence(false);
    }
  }

  return (
    <section className={cn("w-full", className)} id="wechat-workbench">
      <MemoryDependencyRecovery onSaved={() => loadWorkbench()} />
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
        <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <RemixIcon
                name="chat_check"
                size="size-4"
                className="text-emerald-600"
              />
              <h2 className="text-sm font-semibold text-foreground">
                微信代看
              </h2>
              <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                只读审核
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              消息先作为原始观测沉淀，再整理成待办、风险、场景和记忆候选。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => void loadWorkbench()}
              disabled={loading}
            >
              {loading ? (
                <Spinner size={14} />
              ) : (
                <RemixIcon name="refresh" size="size-4" />
              )}
              刷新
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5"
              onClick={onOpenReview}
            >
              <RemixIcon name="arrow_right_up" size="size-4" />
              去审核
            </Button>
          </div>
        </div>

        <div className="grid gap-px bg-border/60 sm:grid-cols-4">
          <WechatMetric label="待办" value={counts.pendingTasks} />
          <WechatMetric label="待回复" value={counts.replyNeededEvents} />
          <WechatMetric label="风险" value={counts.riskNotes} tone="risk" />
          <WechatMetric label="记忆候选" value={counts.memoryCandidates} />
        </div>
        <p className="px-4 py-2 text-xs leading-5 text-muted-foreground">
          待回复为最近 7 天的消息；待办、风险和记忆为主人的全部未解决积压。
          最新消息：{digest?.lastSourceObservedAt ? formatCompactDate(digest.lastSourceObservedAt) : "未知"}；
          最近收到：{digest?.lastSourceCollectedAt ? formatCompactDate(digest.lastSourceCollectedAt) : "未知"}；
          最近摄取成功：{digest?.lastIngestSucceededAt ? formatCompactDate(digest.lastIngestSucceededAt) : "未提供"}。
          {digest ? ` 共 ${Object.values(digest.counts).reduce((sum, value) => sum + value, 0)} 条，当前展示 ${priorityItems.length} 条。` : " 总量待读取。"}
        </p>

        {error ? (
          <div className="border-t border-border/60 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-0 border-t border-border/60 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
          <div className="min-w-0 border-border/60 px-4 py-3 lg:border-r">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                需要处理
              </h3>
              <span className="text-[11px] text-muted-foreground">
                摘要计算 {updatedAt}
              </span>
            </div>
            {loading && !digest ? (
              <WechatPanelLoading />
            ) : priorityItems.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/70 px-3 py-10 text-center text-sm text-muted-foreground">
                {error ? "状态未能完整读取，请重试。" : "当前没有未解决积压或最近 7 天需回复消息。"}
              </p>
            ) : (
              <ul className="space-y-2">
                {priorityItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex min-w-0 items-start gap-2 rounded-md border border-border/60 bg-background px-3 py-2"
                  >
                    <span className="mt-0.5 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {({risk: "风险", task: "待办", reply: "待回复", memory: "记忆"})[item.kind]}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm text-foreground">
                        {item.title}
                      </p>
                      {item.meta ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {item.meta}
                        </p>
                      ) : null}
                      {item.reviewKind === "task" ? <p className="mt-1 text-xs text-muted-foreground">
                        {item.taskState.verificationStatus === "confirmed" ? "信息已确认" : "信息待核对"} · {item.taskState.needsTimeReview ? "期限待确认" : "期限已确认"}
                        {typeof item.taskState.dueAt === "string" ? ` · ${formatCompactDate(item.taskState.dueAt)}` : ""}
                        {typeof item.taskState.snoozedUntil === "string" ? ` · 稍后至 ${formatCompactDate(item.taskState.snoozedUntil)}` : ""}
                      </p> : null}
                      {item.reviewKind === "task" ? <MemoryDependencyPanel entityKind="interaction_task" entityId={item.id} onSaved={() => loadWorkbench()} /> : null}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {item.sourceEventIds.length > 0 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => toggleEvidence(item)}
                          >
                            <RemixIcon name="quote_text" size="size-3.5" />
                            {evidenceForKey === item.id
                              ? "收起证据"
                              : "看证据"}
                          </Button>
                        ) : null}
                        {item.reviewKind ? (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              disabled={Boolean(reviewingKey)}
                              onClick={() => reviewItem(item, "confirmed")}
                            >
                              {reviewingKey ===
                              `${item.reviewKind}:${item.id}:confirmed` ? (
                                <Spinner size={12} />
                              ) : (
                                <RemixIcon name="check" size="size-3.5" />
                              )}
                              信息正确
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                              disabled={Boolean(reviewingKey)}
                              onClick={() => reviewItem(item, "dismissed")}
                            >
                              {reviewingKey ===
                              `${item.reviewKind}:${item.id}:dismissed` ? (
                                <Spinner size={12} />
                              ) : (
                                <RemixIcon name="close" size="size-3.5" />
                              )}
                              忽略
                            </Button>
                            {item.reviewKind === "task" ? <>
                              <Button size="sm" variant="outline" disabled={Boolean(reviewingKey)} onClick={() => reviewItem(item, "done")}>已完成</Button>
                              <Button size="sm" variant="ghost" disabled={Boolean(reviewingKey)} onClick={() => reviewItem(item, "snoozed")}>稍后处理一天</Button>
                              <Button size="sm" variant="ghost" onClick={() => {setTimeReviewFor(item.id); setCorrectedTime("");}}>核对期限</Button>
                            </> : null}
                          </>
                        ) : null}
                      </div>
                      {timeReviewFor === item.id ? <div className="mt-2 flex flex-wrap items-center gap-2">
                        <label className="text-xs">期限（北京时间）<input type="datetime-local" value={correctedTime} onChange={event => setCorrectedTime(event.target.value)} className="ml-2 rounded border p-1" /></label>
                        <Button size="sm" disabled={!correctedTime || Boolean(reviewingKey)} onClick={() => reviewItem(item, "timeConfirmed", `${correctedTime}:00+08:00`)}>保存期限</Button>
                        <Button size="sm" variant="ghost" disabled={Boolean(reviewingKey)} onClick={() => reviewItem(item, "timeConfirmed", null)}>无固定期限</Button>
                      </div> : null}
                      {evidenceForKey === item.id ? (
                        <WechatEvidencePreview
                          events={evidenceEvents}
                          loading={loadingEvidence}
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {nextCursor ? <Button className="mt-3" variant="outline" disabled={loading} onClick={() => void loadWorkbench(nextCursor)}>加载更多事项（含风险）</Button> : null}
          </div>

          <div className="min-w-0 px-4 py-3">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
              场景状态
            </h3>
            {loading && !scenarios ? (
              <WechatPanelLoading />
            ) : scenarioItems.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/70 px-3 py-10 text-center text-sm text-muted-foreground">
                还没有形成联系人、群聊或项目场景。
              </p>
            ) : (
              <ul className="space-y-2">
                {scenarioItems.map((scenario) => (
                  <li
                    key={itemId(scenario, "scenario")}
                    className="rounded-md border border-border/60 bg-background px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-foreground">
                        {scenarioTitle(scenario)}
                      </p>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {scenarioTypeLabel(scenario)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {scenarioSummary(scenario)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function WechatMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | null;
  tone?: "default" | "risk";
}) {
  return (
    <div className="bg-card px-4 py-3">
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "risk" && (value ?? 0) > 0 ? "text-amber-700" : "text-foreground",
        )}
      >
        {value ?? "—"}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function WechatPanelLoading() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-10 text-sm text-muted-foreground">
      <Spinner size={16} />
      <span>正在读取微信沉淀状态</span>
    </div>
  );
}

function WechatEvidencePreview({
  events,
  loading,
}: {
  events: Array<Record<string, unknown>>;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Spinner size={12} />
        <span>正在读取原始消息</span>
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        没有可显示的授权证据。
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-border/60 bg-muted/30 p-2">
      {events.slice(0, 6).map((event) => {
        const sender = eventSenderLabel(event);
        const conversation =
          firstText(event, ["conversationName", "conversationId"]) || "微信消息";
        const messageTime = formatCompactDate(
          firstText(event, ["messageTime", "occurredAt", "createdAt"]),
        );
        return (
          <div
            key={itemId(event, "evidence")}
            className="rounded border border-border/50 bg-background px-2 py-1.5"
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-foreground">
                  {sender}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {conversation}
                </div>
              </div>
              {messageTime ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {messageTime}
                </span>
              ) : null}
            </div>
            <p className="line-clamp-3 text-xs text-foreground">
              {firstText(event, ["contentPreview", "content", "text"]) ||
                "消息内容为空"}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function itemId(item: Record<string, unknown>, prefix: string) {
  return typeof item.id === "string"
    ? item.id
    : `${prefix}-${JSON.stringify(item).slice(0, 32)}`;
}

function itemTitle(
  item: Record<string, unknown>,
  keys: string[],
  fallback: string,
) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function itemMeta(item: Record<string, unknown>) {
  const parts = [
    firstText(item, ["conversationName", "conversationId", "sourceName"]),
    formatCompactDate(firstText(item, ["sourceObservedAt", "messageTime", "occurredAt", "createdAt", "updatedAt"])),
  ].filter(Boolean);
  return parts.join(" · ");
}

function firstText(item: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringArrayField(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function eventSenderLabel(event: Record<string, unknown>) {
  const sender = firstText(event, ["senderDisplayName", "senderName", "senderId"]);
  if (sender) return sender;
  const direction = firstText(event, ["direction"]);
  if (direction === "outbound") return "我";
  if (direction === "inbound") return "对方";
  return "未知发送人";
}

function formatCompactDate(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function scenarioContent(scenario: Record<string, unknown>) {
  const value = scenario.content;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scenarioTitle(scenario: Record<string, unknown>) {
  const content = scenarioContent(scenario);
  return (
    firstText(content, ["title", "scenarioTitle"]) ||
    firstText(scenario, ["title"]) ||
    firstText(content, ["scenarioKey"]) ||
    "未命名场景"
  );
}

function scenarioSummary(scenario: Record<string, unknown>) {
  const content = scenarioContent(scenario);
  return (
    firstText(content, ["currentState", "summary"]) ||
    firstText(scenario, ["summary"]) ||
    "已有微信消息沉淀为场景状态。"
  );
}

function scenarioTypeLabel(scenario: Record<string, unknown>) {
  const type = firstText(scenarioContent(scenario), ["scenarioType"]);
  const labels: Record<string, string> = {
    person: "联系人",
    group: "群聊",
    project: "项目",
    topic: "主题",
    transaction: "事务",
    family: "家庭",
    work: "工作",
  };
  return labels[type] ?? "场景";
}
