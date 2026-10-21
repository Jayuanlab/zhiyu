"use client";

import { RemixIcon } from "@/components/remix-icon";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { Badge, Button } from "@openzhiyu/ui";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { feedbackRecoveryKey, readPendingRecallFeedback, type PendingRecallFeedback } from "@/lib/memory/governance/feedback-recovery";
import { MemoryPendingRevisionList, MemoryRetiredRevisionList, MemoryRevisionControl, MemoryRevisionRecovery } from "@/components/memory-revision-dialog";
import { MemoryUpdatesPanel, MemoryUpdateRecovery } from "@/components/memory-update-dialog";
import { MemoryDependencyImpactList } from "@/components/memory-dependency-panel";
import { MemoryUseDetails } from '@/components/memory-use-details';
import { MemoryContextPreview } from '@/components/memory-context-preview';
import { MemoryFilesContinuity } from '@/components/memory-files-continuity';
import { MemorySourceGovernance } from '@/components/memory-source-governance';
import { MemoryWorkspace } from '@/components/memory-workspace';
import { MemoryLifecycleRecords } from '@/components/memory-lifecycle-records';
import { MemoryRecentRecords, RECENT_MEMORY_ENDPOINT } from '@/components/memory-recent-records';
import { useSWRConfig } from 'swr';

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
  { id: "memory", label: "长期记忆", description: "已保存的理解与经验" },
  { id: "insights", label: "摘要与待办", description: "历史整理线索" },
  { id: "knowledge", label: "知识资料", description: "文档和资料证据" },
  { id: "interactions", label: "沟通记录", description: "沟通理解与记忆" },
  { id: "graph", label: "关系图谱", description: "实体与关系索引" },
];

const SEMANTIC_LABELS: Record<SourceSemantics, string> = {
  canonical_context_candidate: "已保存记忆线索",
  legacy_discovery: "发现线索",
  evidence_source: "原始证据",
  derived_index: "派生索引",
  fallback_evidence: "兜底证据",
};

const TYPE_LABELS: Record<SearchResult["type"], string> = {
  memory: "长期记忆",
  insight: "摘要与待办",
  knowledge: "知识资料",
  interaction: "沟通记录",
  graph: "关系图谱",
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
    title: "长期记忆",
    role: "已保存的解释与边界",
    description:
      "发现已保存的理解、经验和边界；按任务召回时再核对版本、权限与适用性，保存不等于事实已独立核实。",
  },
  {
    semantic: "legacy_discovery",
    title: "历史线索",
    role: "发现与兜底",
    description:
      "来自记忆、摘要或交互理解结果的线索；需要按任务重新核对，或展开相应原始证据。",
  },
  {
    semantic: "evidence_source",
    title: "来源资料",
    role: "原始证据",
    description:
      "资料、文档或原始记录，只证明事实来源；默认不等于长期记忆结论。",
  },
  {
    semantic: "derived_index",
    title: "派生索引",
    role: "关系索引",
    description:
      "由实体、关系或图谱派生出来的索引，适合扩展召回路径，不单独作为最终事实。",
  },
  {
    semantic: "fallback_evidence",
    title: "补充证据",
    role: "降级证据",
    description:
      "主召回不可用或需要补证时使用，需说明降级原因与读取记录，再按任务核对。",
  },
];

const RESULT_KIND_LABELS: Record<
  NonNullable<SearchResponse["resultKind"]>,
  string
> = {
  canonical_context: "已保存记忆线索",
  mixed_context: "记忆线索与来源资料",
  legacy_discovery: "历史线索与来源资料",
  empty: "暂无可用来源",
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
  onMemoryUpdated,
}: {
  result: SearchResult;
  sourceSemantics: Record<MemorySource, SourceSemantics>;
  onMemoryUpdated?: () => void | Promise<void>;
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
            匹配度 {result.similarity.toFixed(3)}
          </span>
        </div>
        <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">
          {result.id}
        </code>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6">{result.content}</p>
      {result.type === "memory" && result.metadata.source === "brain_memory" ? (
        <div>
          <MemoryUseDetails applicability={result.metadata.scenarioApplicability} useSemantics={result.metadata.useSemantics}
            status={typeof result.metadata.status === 'string' ? result.metadata.status : undefined} />
          <MemoryRevisionControl memoryId={result.id} onSaved={onMemoryUpdated} />
        </div>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">记录详情与来源信息</summary>
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
          <h3 className="text-sm font-semibold">记忆查询记录</h3>
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
            长期记忆保存理解、经验与边界；资料和索引用于寻找并核对来源。按任务召回会重新检查权限、版本与适用性，并记录本次实际采用的内容。
          </p>
        </div>
        <Badge variant="secondary">按任务核对</Badge>
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
  const { mutate: refreshCachedRecords } = useSWRConfig();
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
  async function refreshMemories() {
    await Promise.all([retrySource("memory"), refreshCachedRecords([RECENT_MEMORY_ENDPOINT, feedbackOwner])]);
  }

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
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 px-5 py-5 md:px-8">
        <MemoryRevisionRecovery onSaved={refreshMemories} />
        <MemoryUpdateRecovery onSaved={refreshMemories} />
        <MemoryWorkspace
          review={<>
            <div><h2 className="text-lg font-semibold">决定什么继续被记住</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">核对更新提案、待核实修订及受影响的旧记忆。展开列表后读取当前状态；尚未读取不表示没有待处理项。</p></div>
            <MemoryUpdatesPanel showRecovery={false} onSaved={refreshMemories} />
            <MemoryPendingRevisionList onSaved={refreshMemories} />
            <MemoryDependencyImpactList onSaved={refreshMemories} />
            <MemoryRetiredRevisionList onSaved={refreshMemories} />
            <details className="rounded-lg border bg-card p-4 text-sm"><summary className="cursor-pointer font-medium">历史整理与索引维护</summary><p className="my-3 text-xs leading-5 text-muted-foreground">旧记录的分类整理单独审核，不改变原始消息，也不替代记忆内容审核。</p><a href="/memory/backfill" className="underline underline-offset-4">打开记忆索引维护</a></details>
          </>}
          files={<MemoryFilesContinuity ownerId={feedbackOwner} />}
          activity={<>
            <MemoryLifecycleRecords ownerId={feedbackOwner} onSaved={refreshMemories} />
            <div><h2 className="text-lg font-semibold">核对一次读取的依据</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">需要排查“从哪里记住、读了哪些内容”时再查看。回执证明当时的读取或准入，不代表模型已采用，也不代表动作已完成。</p></div>
            <MemorySourceGovernance ownerId={feedbackOwner} />
            <details className="rounded-lg border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">理解不同来源的作用</summary><div className="mt-3"><SourceSemanticsGuide /></div></details>
          </>}
          search={<>
        <form
          onSubmit={submit}
          aria-label="查找记忆"
          className="grid min-w-0 gap-3 rounded-lg border bg-card p-5 shadow-sm"
        >
          <div><h2 className="text-lg font-semibold">想找回什么？</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">用问题、主题或任务描述查找。找到内容后，再按当前任务核对是否适用。</p></div>
          <label className="grid gap-2">
            <span className="text-sm font-medium">问题或任务</span>
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              rows={2}
              className="min-h-20 resize-y rounded-md border bg-background px-3 py-2 text-sm leading-6 outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="例如：这个项目有哪些已确认的约束？哪些处理经验适用于当前任务？"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-5 text-muted-foreground">已选择 {sources.length} 类来源 · 查找不会自动修改记忆</p>
            <Button type="submit" disabled={loading || sources.length === 0}>
              {loading ? (
                <RemixIcon name="loader_4" size="size-4" className="mr-2 animate-spin" />
              ) : (
                <RemixIcon name="search" size="size-4" className="mr-2" />
              )}
              查找记忆
            </Button>
          </div>
          {!response && !query ? <div className="flex flex-wrap gap-2" aria-label="检索示例">{["我的写作偏好", "项目的约束与边界", "过去的处理经验"].map(example => <button key={example} type="button" onClick={() => setQuery(example)} className="rounded-full border bg-muted/30 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-[var(--product-jade)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{example}</button>)}</div> : null}

          <div className="grid gap-4">
            <div className="grid gap-2">
              <span className="text-sm font-medium">来源</span>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {SOURCE_OPTIONS.map((source) => {
                  const active = sources.includes(source.id);
                  return (
                    <button
                      key={source.id}
                      type="button"
                      aria-pressed={active}
                      title={source.description}
                      onClick={() => toggleSource(source.id)}
                      className={cn(
                        "min-w-0 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "bg-background hover:bg-muted",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm font-medium">
                        <span>{source.label}</span>
                        {active ? <RemixIcon name="check" size="size-4" /> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <details className="rounded-md border border-dashed p-3"><summary className="cursor-pointer text-xs text-muted-foreground">检索设置 · 最多 {limit} 条 · 匹配阈值 {threshold.toFixed(2)}</summary><div className="mt-3 grid gap-3 md:grid-cols-2">
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
            <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={includeArchivedInsights} onChange={event => setIncludeArchivedInsights(event.target.checked)} className="size-4 rounded border" />包含已归档摘要</label>
            </details>
          </div>

        </form>
        {!response ? <MemoryRecentRecords ownerId={feedbackOwner} onSaved={() => retrySource("memory")} /> : null}
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
                <h2 className="text-lg font-semibold">查找结果</h2>
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
                    {RESULT_KIND_LABELS[response.resultKind]}
                  </Badge>
                ) : null}
                {sourceSummary.map((item) => (
                  <Badge key={item.source} variant="secondary">
                    {SOURCE_OPTIONS.find(source => source.id === item.source)?.label}: {item.label} ·{" "}
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
                      <span className="font-medium">{SOURCE_OPTIONS.find(source => source.id === status.source)?.label}</span>
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
                        <span>{status.warningCount} 项提示</span>
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
                              onMemoryUpdated={refreshMemories}
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
                      onMemoryUpdated={refreshMemories}
                    />
                  );
                })
              )}
            </div>
          </section>
        ) : null}
        <MemoryContextPreview taskIntent={query} feedbackDisabled={pendingFeedbackOutcome !== null || !!pendingFeedback || feedbackStorageError || !feedbackOwner}
          onFeedback={(contextLogId, taskQuery, outcome) => {
            const requestKey = `context:${contextLogId}:${outcome}`;
            const feedbackId = feedbackRequestIds.current.get(requestKey) ?? crypto.randomUUID();
            feedbackRequestIds.current.set(requestKey, feedbackId);
            void sendRecallFeedback({ feedbackId, contextLogId, query: taskQuery, outcome, reason: "Owner feedback on the explicitly admitted task context", sources: ["memory"] });
          }} />
          </>}
        />
      </div>
    </main>
  );
}
