"use client";

import { RemixIcon } from "@/components/remix-icon";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { Badge, Button } from "@openzhiyu/ui";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { feedbackRecoveryKey, readPendingRecallFeedback, type PendingRecallFeedback } from '@/lib/brain/feedback-recovery';

type MemorySource = "memory" | "insights" | "knowledge" | "interactions" | "graph";

type SourceSemantics =
  | "canonical_context_candidate"
  | "legacy_discovery"
  | "evidence_source"
  | "derived_index"
  | "fallback_evidence";

type SearchResult = {
  type: "memory" | "insight" | "knowledge" | "interaction" | "graph";
  id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

type SearchWarning = {
  source: MemorySource;
  code: string;
  message: string;
};

type SourceStatus = {
  source: MemorySource;
  status: "ok" | "degraded" | "unavailable";
  elapsedMs: number;
  resultCount: number;
  warningCount: number;
  semantics: SourceSemantics;
};

type SearchResponse = {
  query: string;
  sources: MemorySource[];
  resultKind?:
    | "canonical_context"
    | "mixed_context"
    | "legacy_discovery"
    | "empty";
  sourceSemantics: Record<MemorySource, SourceSemantics>;
  sourceStatuses?: SourceStatus[];
  contextTrace?: BrainContextTrace;
  results: SearchResult[];
  count: number;
  warnings: SearchWarning[];
  cache?: {
    hit: boolean;
    stale: boolean;
    refreshing: boolean;
    warning?: string;
  };
};

type ResultSourceFilter = MemorySource | "all";

type BrainContextTrace = {
  interfaceVersion: "brain-context-trace.v1";
  contextLogId?: string;
  selection: {
    selectedCount: number;
    deniedCount: number;
    omittedCount: number;
    duplicateCanonicalGroupCount: number;
    selectedCanonicalKinds: Record<string, number>;
  };
  selected: Array<{
    id: string;
    memoryType: string;
    subject: string;
    contentPreview: string;
    score: number;
    reasons: string[];
    evidenceRefCount: number;
    canonicalKind?: string;
    canonicalGroupId?: string;
  }>;
  omitted: Array<{ id: string; reason: string }>;
  denied: Array<{ id: string; reason: string }>;
  warnings?: Array<{ code: string; message: string; memoryIds: string[] }>;
};

type RecallFeedbackOutcome =
  | "used"
  | "irrelevant"
  | "stale"
  | "missing"
  | "wrong_scope"
  | "missed_boundary";

const RECALL_FEEDBACK_OPTIONS: Array<{
  outcome: RecallFeedbackOutcome;
  label: string;
  reason: string;
}> = [
  {
    outcome: "used",
    label: "有用",
    reason: "The recalled Brain context was useful for this task.",
  },
  {
    outcome: "irrelevant",
    label: "无关",
    reason: "The recalled Brain context was irrelevant to this task.",
  },
  {
    outcome: "stale",
    label: "过期",
    reason: "The recalled Brain context looked stale for this task.",
  },
  {
    outcome: "missing",
    label: "缺记忆",
    reason: "Important memory was missing from this recall.",
  },
  {
    outcome: "wrong_scope",
    label: "范围错",
    reason: "The recalled Brain context came from the wrong scope.",
  },
  {
    outcome: "missed_boundary",
    label: "缺边界",
    reason: "Important boundary memory was missing from this recall.",
  },
];

const SOURCE_OPTIONS: Array<{
  id: MemorySource;
  label: string;
  description: string;
}> = [
  { id: "memory", label: "Brain", description: "长期记忆" },
  { id: "insights", label: "Insights", description: "摘要和待办" },
  { id: "knowledge", label: "Knowledge", description: "资料证据" },
  { id: "interactions", label: "Interactions", description: "沟通记忆" },
  { id: "graph", label: "Graph", description: "关系图谱" },
];

const SEMANTIC_LABELS: Record<SourceSemantics, string> = {
  canonical_context_candidate: "规范记忆候选",
  legacy_discovery: "旧系统发现",
  evidence_source: "原始证据",
  derived_index: "派生索引",
  fallback_evidence: "兜底证据",
};

const TYPE_LABELS: Record<SearchResult["type"], string> = {
  memory: "Brain",
  insight: "Insight",
  knowledge: "Knowledge",
  interaction: "Interaction",
  graph: "Graph",
};

const SOURCE_STATUS_LABELS: Record<SourceStatus["status"], string> = {
  ok: "正常",
  degraded: "降级",
  unavailable: "不可用",
};

const SOURCE_STATUS_BADGE_VARIANTS: Record<
  SourceStatus["status"],
  "default" | "secondary" | "destructive"
> = {
  ok: "default",
  degraded: "secondary",
  unavailable: "destructive",
};

const SOURCE_SEMANTICS_GUIDE: Array<{
  semantic: SourceSemantics;
  title: string;
  role: string;
  description: string;
}> = [
  {
    semantic: "canonical_context_candidate",
    title: "Brain canonical",
    role: "长期记忆主事实",
    description:
      "默认进入 ContextPack 选择链路，用于智能体长期状态、边界、结论和经验的主召回入口。",
  },
  {
    semantic: "legacy_discovery",
    title: "Legacy discovery",
    role: "发现与兜底",
    description:
      "来自旧记忆、摘要或交互理解结果，适合帮助发现线索；进入长期上下文前应被 Brain 规范化或作为证据引用。",
  },
  {
    semantic: "evidence_source",
    title: "Evidence source",
    role: "原始证据",
    description:
      "资料、文档或原始记录，只证明事实来源；默认不等于长期记忆结论。",
  },
  {
    semantic: "derived_index",
    title: "Derived index",
    role: "关系索引",
    description:
      "由实体、关系或图谱派生出来的索引，适合扩展召回路径，不单独作为最终事实。",
  },
  {
    semantic: "fallback_evidence",
    title: "Fallback evidence",
    role: "降级证据",
    description:
      "主召回不可用或需要补证时使用，必须带 warning 或 trace，不应静默替代 canonical memory。",
  },
];

const RESULT_KIND_LABELS: Record<
  NonNullable<SearchResponse["resultKind"]>,
  string
> = {
  canonical_context: "Brain canonical",
  mixed_context: "Brain + evidence",
  legacy_discovery: "Legacy/evidence",
  empty: "No active source",
};

function metadataPreview(metadata: Record<string, unknown>) {
  const keys = [
    "sourceSemantics",
    "source",
    "memoryType",
    "subject",
    "status",
    "scope",
    "ownerType",
    "ownerId",
    "platform",
    "channel",
    "person",
    "documentName",
    "relationType",
    "confidence",
    "evidenceStrength",
  ];
  const picked = Object.fromEntries(
    keys
      .filter((key) => metadata[key] !== undefined)
      .map((key) => [key, metadata[key]]),
  );
  return Object.keys(picked).length > 0 ? JSON.stringify(picked) : "{}";
}

function sourceForResult(type: SearchResult["type"]): MemorySource {
  if (type === "insight") return "insights";
  if (type === "knowledge") return "knowledge";
  if (type === "interaction") return "interactions";
  if (type === "graph") return "graph";
  return "memory";
}

function sourceLabel(source: MemorySource) {
  return SOURCE_OPTIONS.find((option) => option.id === source)?.label ?? source;
}

function sortSearchResults(results: SearchResult[]) {
  return [...results].sort((a, b) => {
    const scoreDelta = b.similarity - a.similarity;
    if (scoreDelta !== 0) return scoreDelta;
    return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
  });
}

function mergeSourceRetryResponse(
  current: SearchResponse,
  source: MemorySource,
  retry: SearchResponse,
): SearchResponse {
  const nextStatuses = new Map(
    (current.sourceStatuses ?? []).map((status) => [
      status.source,
      status,
    ]),
  );
  for (const status of retry.sourceStatuses ?? []) {
    nextStatuses.set(status.source, status);
  }
  const nextResults = sortSearchResults([
    ...current.results.filter(
      (result) => sourceForResult(result.type) !== source,
    ),
    ...retry.results,
  ]);

  return {
    ...current,
    sourceSemantics: {
      ...current.sourceSemantics,
      ...retry.sourceSemantics,
    },
    sourceStatuses: Array.from(nextStatuses.values()),
    results: nextResults,
    count: nextResults.length,
    warnings: [
      ...current.warnings.filter((warning) => warning.source !== source),
      ...retry.warnings,
    ],
    cache: undefined,
  };
}

function SearchResultArticle({
  result,
  sourceSemantics,
}: {
  result: SearchResult;
  sourceSemantics: Record<MemorySource, SourceSemantics>;
}) {
  const source = sourceForResult(result.type);
  const semantic =
    sourceSemantics[source] ?? (result.metadata.sourceSemantics as SourceSemantics);

  return (
    <article className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{TYPE_LABELS[result.type]}</Badge>
          <Badge variant="secondary">
            {SEMANTIC_LABELS[semantic] ?? semantic}
          </Badge>
          <span className="text-xs text-muted-foreground">
            score {result.similarity.toFixed(3)}
          </span>
        </div>
        <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">
          {result.id}
        </code>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6">{result.content}</p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">metadata</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-3">
          {metadataPreview(result.metadata)}
        </pre>
      </details>
    </article>
  );
}

function BrainTracePanel({
  trace,
  pendingFeedbackOutcome,
  feedbackDisabled,
  onFeedback,
}: {
  trace: BrainContextTrace;
  pendingFeedbackOutcome: RecallFeedbackOutcome | null;
  feedbackDisabled: boolean;
  onFeedback: (outcome: RecallFeedbackOutcome, reason: string) => void;
}) {
  const evidenceCount = trace.selected.reduce(
    (total, item) => total + item.evidenceRefCount,
    0,
  );
  const canonicalKinds = Object.entries(
    trace.selection.selectedCanonicalKinds ?? {},
  );

  return (
    <section className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Brain ContextPack trace</h3>
          <p className="text-xs text-muted-foreground">
            selected {trace.selection.selectedCount} · omitted{" "}
            {trace.selection.omittedCount} · denied{" "}
            {trace.selection.deniedCount}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">
            duplicate {trace.selection.duplicateCanonicalGroupCount}
          </Badge>
          <Badge variant="secondary">evidence {evidenceCount}</Badge>
          {trace.warnings?.length ? (
            <Badge variant="destructive">warning {trace.warnings.length}</Badge>
          ) : null}
        </div>
      </div>
      {canonicalKinds.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {canonicalKinds.map(([kind, count]) => (
            <Badge key={kind} variant="secondary">
              {kind}: {count}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
        <span className="text-xs text-muted-foreground">反馈这次召回</span>
        {RECALL_FEEDBACK_OPTIONS.map((option) => (
          <button
            key={option.outcome}
            type="button"
            onClick={() => onFeedback(option.outcome, option.reason)}
            disabled={pendingFeedbackOutcome !== null || feedbackDisabled}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pendingFeedbackOutcome === option.outcome ? (
              <RemixIcon
                name="loader_4"
                size="size-3"
                className="animate-spin"
              />
            ) : null}
            {option.label}
          </button>
        ))}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">selected / omitted / denied</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div className="grid content-start gap-2">
            <div className="font-medium text-foreground">selected</div>
            {trace.selected.slice(0, 8).map((item) => (
              <div key={item.id} className="border-b pb-2 last:border-b-0">
                <div className="font-medium text-foreground">{item.subject}</div>
                <div className="mt-1 line-clamp-2">{item.contentPreview}</div>
                <div className="mt-1">
                  {item.memoryType} · score {Math.round(item.score)}
                </div>
              </div>
            ))}
          </div>
          <div className="grid content-start gap-2">
            <div className="font-medium text-foreground">omitted</div>
            {trace.omitted.slice(0, 10).map((item) => (
              <div key={item.id} className="border-b pb-2 last:border-b-0">
                {item.id}: {item.reason}
              </div>
            ))}
          </div>
          <div className="grid content-start gap-2">
            <div className="font-medium text-foreground">denied</div>
            {trace.denied.slice(0, 10).map((item) => (
              <div key={item.id} className="border-b pb-2 last:border-b-0">
                {item.id}: {item.reason}
              </div>
            ))}
          </div>
        </div>
      </details>
    </section>
  );
}

function SourceSemanticsGuide() {
  return (
    <section className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">记忆来源语义</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            Brain canonical 是长期记忆主入口；其他来源用于发现、证据、索引或降级兜底。智能体最终消费的是经过去重、边界过滤和 trace 记录的 ContextPack。
          </p>
        </div>
        <Badge variant="secondary">canonical first</Badge>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        {SOURCE_SEMANTICS_GUIDE.map((item) => (
          <div
            key={item.semantic}
            className="grid content-start gap-2 rounded-md border bg-background p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{item.title}</span>
              <Badge variant="secondary">{item.role}</Badge>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {item.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function UnifiedMemoryPage() {
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<MemorySource[]>(["memory"]);
  const [limit, setLimit] = useState(10);
  const [threshold, setThreshold] = useState(0.35);
  const [includeArchivedInsights, setIncludeArchivedInsights] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retryingSources, setRetryingSources] = useState<MemorySource[]>([]);
  const [pendingFeedbackOutcome, setPendingFeedbackOutcome] =
    useState<RecallFeedbackOutcome | null>(null);
  const feedbackRequestIds = useRef(new Map<string, string>());
  const feedbackSending = useRef(false);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);
  const [feedbackOwner, setFeedbackOwner] = useState('');
  const [pendingFeedback, setPendingFeedback] = useState<PendingRecallFeedback | null>(null);
  const [feedbackStorageError, setFeedbackStorageError] = useState(false);
  async function loadFeedbackOwner() {
    const identity = await fetch('/api/identity', {cache:'no-store'});
    if (!identity.ok) throw Error('Identity unavailable');
    const body = await identity.json();
    if (typeof body.actorId !== 'string' || !body.actorId) throw Error('Identity unavailable');
    return body.actorId as string;
  }
  async function restoreFeedback() {
    try {
      const owner = await loadFeedbackOwner();
      const saved = readPendingRecallFeedback(sessionStorage, owner);
      setFeedbackOwner(owner); setPendingFeedback(saved); setFeedbackStorageError(false);
      if (saved) setFeedbackNotice('有一条反馈尚未确认，请重试原反馈；无需重新召回。');
    } catch {
      setFeedbackStorageError(true);
      setFeedbackNotice('无法读取身份或反馈恢复记录，已暂停提交。请检查登录与浏览器存储后重新读取。');
    }
  }
  useEffect(() => { void restoreFeedback(); }, []);
  const [resultSourceFilter, setResultSourceFilter] =
    useState<ResultSourceFilter>("all");
  const [collapsedResultSources, setCollapsedResultSources] = useState<
    MemorySource[]
  >([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);

  const sourceSummary = useMemo(() => {
    if (!response) return [];
    const statusBySource = new Map(
      (response.sourceStatuses ?? []).map((status) => [
        status.source,
        status,
      ]),
    );
    return response.sources.map((source) => ({
      source,
      label:
        SEMANTIC_LABELS[response.sourceSemantics[source]] ??
        response.sourceSemantics[source],
      count: response.results.filter(
        (result) => sourceForResult(result.type) === source,
      ).length,
      status: statusBySource.get(source),
    }));
  }, [response]);

  const filteredResults = useMemo(() => {
    if (!response) return [];
    if (resultSourceFilter === "all") return response.results;
    return response.results.filter(
      (result) => sourceForResult(result.type) === resultSourceFilter,
    );
  }, [response, resultSourceFilter]);

  const resultFilterOptions = useMemo(() => {
    if (!response) return [];
    return [
      {
        id: "all" as const,
        label: "全部",
        count: response.results.length,
      },
      ...sourceSummary.map((item) => ({
        id: item.source,
        label: sourceLabel(item.source),
        count: item.status?.resultCount ?? item.count,
      })),
    ];
  }, [response, sourceSummary]);

  const resultGroups = useMemo(() => {
    if (!response) return [];
    return sourceSummary
      .map((item) => ({
        source: item.source,
        label: sourceLabel(item.source),
        count: item.status?.resultCount ?? item.count,
        status: item.status,
        results: response.results.filter(
          (result) => sourceForResult(result.type) === item.source,
        ),
      }))
      .filter((group) => group.count > 0 || group.status);
  }, [response, sourceSummary]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      toast({ type: "error", description: "请输入要召回的记忆需求。" });
      return;
    }
    setLoading(true);
    try {
      const result = await fetch("/api/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          sources,
          limit,
          threshold,
          includeArchivedInsights,
        }),
      });
      const body = await result.json();
      if (!result.ok) {
        throw new Error(body?.message ?? body?.error ?? "Memory search failed");
      }
      setResponse(body as SearchResponse);
      setResultSourceFilter("all");
      setCollapsedResultSources([]);
    } catch (error) {
      toast({
        type: "error",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }

  function toggleSource(source: MemorySource) {
    setSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : [...current, source],
    );
  }

  function toggleResultSourceCollapse(source: MemorySource) {
    setCollapsedResultSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : [...current, source],
    );
  }

  async function retrySource(source: MemorySource) {
    if (!response) return;
    setRetryingSources((current) =>
      current.includes(source) ? current : [...current, source],
    );
    try {
      const result = await fetch("/api/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: response.query,
          sources: [source],
          limit,
          threshold,
          includeArchivedInsights,
        }),
      });
      const body = await result.json();
      if (!result.ok) {
        throw new Error(body?.message ?? body?.error ?? "Memory search failed");
      }
      setResponse((current) =>
        current
          ? mergeSourceRetryResponse(current, source, body as SearchResponse)
          : (body as SearchResponse),
      );
      toast({
        type: "success",
        description: `${source} 已重新召回。`,
      });
    } catch (error) {
      toast({
        type: "error",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRetryingSources((current) =>
        current.filter((item) => item !== source),
      );
    }
  }

  async function submitRecallFeedback(
    outcome: RecallFeedbackOutcome,
    reason: string,
  ) {
    if (!response?.contextTrace || feedbackSending.current || pendingFeedback || feedbackStorageError || !feedbackOwner) return;
    const requestKey = JSON.stringify([response.contextTrace.contextLogId, response.query, outcome, reason]);
    const feedbackId = feedbackRequestIds.current.get(requestKey) ?? crypto.randomUUID();
    feedbackRequestIds.current.set(requestKey, feedbackId);
    await sendRecallFeedback({feedbackId, query:response.query, outcome, reason,
      sources:response.sources, contextLogId:response.contextTrace.contextLogId});
  }
  async function sendRecallFeedback(payload: PendingRecallFeedback) {
    if (feedbackSending.current || !feedbackOwner || feedbackStorageError) return;
    feedbackSending.current = true;
    setFeedbackNotice(null);
    setPendingFeedbackOutcome(payload.outcome as RecallFeedbackOutcome);
    let prepared = false;
    try {
      const owner = await loadFeedbackOwner();
      if (owner !== feedbackOwner) {
        setResponse(null); feedbackRequestIds.current.clear();
        await restoreFeedback();
        setFeedbackNotice('当前登录用户已变化，原用户反馈未发送。请重新召回后再反馈。');
        return;
      }
      sessionStorage.setItem(feedbackRecoveryKey(owner), JSON.stringify(payload));
      setPendingFeedback(payload); prepared = true;
      const result = await fetch("/api/memory/recall-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await result.json();
      if (!result.ok) {
        if ([400,401,403,404,409].includes(result.status)) {
          sessionStorage.removeItem(feedbackRecoveryKey(owner));setPendingFeedback(null);
          setFeedbackNotice('反馈被拒绝，未收到保存回执。请检查登录并重新召回后反馈。');
          return;
        }
        throw new Error(
          body?.message ?? body?.error ?? "Failed to record recall feedback",
        );
      }
      if (body.feedbackId !== payload.feedbackId) throw Error('Receipt mismatch');
      sessionStorage.removeItem(feedbackRecoveryKey(owner));setPendingFeedback(null);
      toast({
        type: "success",
        description: "已记录这次召回反馈。",
      });
      setFeedbackNotice("已记录这次召回反馈；重复点击同一选项不会重复计数。");
    } catch (error) {
      if (!prepared) {
        setFeedbackStorageError(true);
        setFeedbackNotice('无法确认身份或保存恢复记录，反馈未发送。请检查登录与浏览器存储后重新读取。');
      } else setFeedbackNotice("暂未确认反馈是否保存。请重试原反馈，同一请求不会重复计数。");
      toast({
        type: "error",
        description: "暂未确认反馈是否保存，请重试原选项。",
      });
    } finally {
      feedbackSending.current = false;
      setPendingFeedbackOutcome(null);
    }
  }

  return (
    <main className="h-full min-h-0 overflow-y-auto overscroll-contain bg-background text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-6 px-5 py-6 md:px-8">
        <div className="flex flex-col gap-2 border-b pb-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RemixIcon name="brain" size="size-4" />
            <span>Unified Memory</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-normal">统一记忆召回</h1>
          <a href="/memory/backfill" className="w-fit text-sm underline">记忆索引维护</a>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            输入当前任务或问题，平台会从 Brain、资料、历史沟通、摘要和关系索引中召回相关上下文，并标注每条结果的语义来源。
          </p>
        </div>

        <SourceSemanticsGuide />

        <form
          onSubmit={submit}
          className="grid gap-4 rounded-lg border bg-card p-4 shadow-sm"
        >
          <label className="grid gap-2">
            <span className="text-sm font-medium">召回需求</span>
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              rows={4}
              className="min-h-28 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="例如：盘中模拟交易员现在要复盘今日交易，需要召回哪些边界、计划、证据和历史结论？"
            />
          </label>

          <div className="grid gap-4 lg:grid-cols-[1fr_220px_220px]">
            <div className="grid gap-2">
              <span className="text-sm font-medium">来源</span>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {SOURCE_OPTIONS.map((source) => {
                  const active = sources.includes(source.id);
                  return (
                    <button
                      key={source.id}
                      type="button"
                      onClick={() => toggleSource(source.id)}
                      className={cn(
                        "rounded-md border px-3 py-2 text-left transition-colors",
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "bg-background hover:bg-muted",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm font-medium">
                        <span>{source.label}</span>
                        {active ? <RemixIcon name="check" size="size-4" /> : null}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {source.description}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="grid content-start gap-2">
              <span className="text-sm font-medium">数量</span>
              <input
                type="number"
                min={1}
                max={50}
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
                className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>

            <label className="grid content-start gap-2">
              <span className="text-sm font-medium">阈值 {threshold.toFixed(2)}</span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
                className="h-10"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={includeArchivedInsights}
                onChange={(event) =>
                  setIncludeArchivedInsights(event.target.checked)
                }
                className="size-4 rounded border"
              />
              包含已归档 insight
            </label>
            <Button type="submit" disabled={loading || sources.length === 0}>
              {loading ? (
                <RemixIcon name="loader_4" size="size-4" className="mr-2 animate-spin" />
              ) : (
                <RemixIcon name="search" size="size-4" className="mr-2" />
              )}
              开始召回
            </Button>
          </div>
        </form>
        {feedbackNotice || pendingFeedback || feedbackStorageError ? (
          <section aria-label="反馈恢复" className="grid gap-2 rounded-lg border bg-card p-3">
            {feedbackNotice ? <p role="status" aria-label="召回反馈状态" className="text-sm text-muted-foreground">{feedbackNotice}</p> : null}
            {pendingFeedback ? <>
              <p className="break-words text-sm">待确认反馈：{pendingFeedback.query} · {pendingFeedback.outcome}</p>
              <button type="button" disabled={pendingFeedbackOutcome !== null || feedbackStorageError} onClick={() => void sendRecallFeedback(pendingFeedback)} className="w-fit rounded-md border px-3 py-2 text-sm disabled:opacity-50">重试原反馈</button>
            </> : null}
            {feedbackStorageError ? <button type="button" onClick={() => void restoreFeedback()} className="w-fit rounded-md border px-3 py-2 text-sm">重新读取反馈状态</button> : null}
          </section>
        ) : null}

        {response ? (
          <section className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">召回结果</h2>
                <p className="text-sm text-muted-foreground">
                  {response.count} 条结果，查询：{response.query}
                  {response.cache?.hit
                    ? ` · cache ${response.cache.stale ? "stale" : "hit"}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {response.resultKind ? (
                  <Badge variant="secondary">
                    kind: {RESULT_KIND_LABELS[response.resultKind]}
                  </Badge>
                ) : null}
                {sourceSummary.map((item) => (
                  <Badge key={item.source} variant="secondary">
                    {item.source}: {item.label} ·{" "}
                    {item.status?.resultCount ?? item.count}
                  </Badge>
                ))}
              </div>
            </div>

            {response.sourceStatuses?.length ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {response.sourceStatuses.map((status) => (
                  <div
                    key={status.source}
                    className="grid gap-2 rounded-lg border bg-card p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{status.source}</span>
                      <Badge
                        variant={SOURCE_STATUS_BADGE_VARIANTS[status.status]}
                      >
                        {SOURCE_STATUS_LABELS[status.status]}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {SEMANTIC_LABELS[status.semantics] ?? status.semantics}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{status.elapsedMs}ms</span>
                      <span>{status.resultCount} 条</span>
                      {status.warningCount > 0 ? (
                        <span>{status.warningCount} warning</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => retrySource(status.source)}
                      disabled={retryingSources.includes(status.source)}
                      className="inline-flex h-8 items-center justify-center gap-2 rounded-md border bg-background px-2 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {retryingSources.includes(status.source) ? (
                        <RemixIcon
                          name="loader_4"
                          size="size-3.5"
                          className="animate-spin"
                        />
                      ) : (
                        <RemixIcon name="refresh" size="size-3.5" />
                      )}
                      重试
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {response.contextTrace ? (
              <BrainTracePanel
                trace={response.contextTrace}
                pendingFeedbackOutcome={pendingFeedbackOutcome}
                feedbackDisabled={!!pendingFeedback || feedbackStorageError || !feedbackOwner}
                onFeedback={submitRecallFeedback}
              />
            ) : null}

            {response.warnings.length > 0 ? (
              <div className="grid gap-2 break-words rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {response.warnings.map((warning) => (
                  <div key={`${warning.source}-${warning.code}`}>
                    <span className="font-medium">{warning.source}</span>:{" "}
                    {warning.message}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
              {resultFilterOptions.map((option) => {
                const active = resultSourceFilter === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setResultSourceFilter(option.id)}
                    className={cn(
                      "inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "bg-background hover:bg-muted",
                    )}
                  >
                    <span>{option.label}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {option.count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-3">
              {filteredResults.length === 0 ? (
                <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
                  {response.results.length === 0
                    ? "没有找到匹配记忆。可以降低阈值、扩大来源，或把需求描述得更贴近任务状态。"
                    : "当前来源没有结果，可以切换到全部或重试该来源。"}
                </div>
              ) : resultSourceFilter === "all" ? (
                resultGroups.map((group) => {
                  const collapsed = collapsedResultSources.includes(group.source);
                  const hasResults = group.results.length > 0;
                  return (
                    <section
                      key={group.source}
                      className="grid gap-3"
                    >
                      <button
                        type="button"
                        onClick={() => toggleResultSourceCollapse(group.source)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/60"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <RemixIcon
                            name={collapsed ? "chevron_right" : "chevron_down"}
                            size="size-4"
                            className="text-muted-foreground"
                          />
                          <span className="font-medium">{group.label}</span>
                          <Badge variant="secondary">{group.count} 条</Badge>
                          {group.status ? (
                            <Badge
                              variant={
                                SOURCE_STATUS_BADGE_VARIANTS[group.status.status]
                              }
                            >
                              {SOURCE_STATUS_LABELS[group.status.status]}
                            </Badge>
                          ) : null}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {collapsed ? "展开" : "折叠"}
                        </span>
                      </button>
                      {collapsed ? null : hasResults ? (
                        <div className="grid gap-3">
                          {group.results.map((result) => (
                            <SearchResultArticle
                              key={`${result.type}-${result.id}`}
                              result={result}
                              sourceSemantics={response.sourceSemantics}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
                          当前来源没有结果，可以重试该来源或调整召回条件。
                        </div>
                      )}
                    </section>
                  );
                })
              ) : (
                filteredResults.map((result) => {
                  return (
                    <SearchResultArticle
                      key={`${result.type}-${result.id}`}
                      result={result}
                      sourceSemantics={response.sourceSemantics}
                    />
                  );
                })
              )}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
