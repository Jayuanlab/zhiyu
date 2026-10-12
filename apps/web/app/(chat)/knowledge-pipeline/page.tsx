"use client";

import { RemixIcon } from "@/components/remix-icon";
import { Spinner } from "@/components/spinner";
import { MemoryDependencyPanel, MemoryDependencyRecovery } from "@/components/memory-dependency-panel";
import { toast } from "@/components/toast";
import { cn, fetcher } from "@/lib/utils";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@openzhiyu/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";

type SourcePolicy = "sync" | "summary" | "mention_only" | "ignore";

type WechatSource = {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  isGroup: boolean;
  unread: number;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  policy: SourcePolicy;
  enabled: boolean;
  configured: boolean;
};

type SourcesResponse = {
  sources: WechatSource[];
  meta: Record<string, unknown> | null;
};

type WikiResponse = {
  notes: Array<{
    id: string;
    noteType?: string;
    title: string;
    body: string;
    confidence?: number;
    model?: string | null;
    sourceEventIds?: string[];
    metadata?: Record<string, unknown>;
    createdAt: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    dueAt?: string | null;
    assigneeName?: string | null;
    requesterName?: string | null;
    confidence?: number;
    sourceEventIds?: string[];
    metadata?: Record<string, unknown>;
    createdAt: string;
  }>;
  memories: Array<{
    id: string;
    memoryType?: string;
    subject: string;
    content: string;
    status: string;
    confidence: number;
    tags?: string[];
    sourceEventIds?: string[];
    lastVerifiedAt?: string | null;
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }>;
};

type WikiKind = "note" | "task" | "memory";
type WikiResultView = "tasks" | "memoryReview" | "memories" | "notes";
type PipelineView = "memory" | "sources" | "graph";

type WikiTimelineItem = {
  id: string;
  kind: WikiKind;
  title: string;
  body: string;
  createdAt: string;
  status: string;
  confidence?: number;
  generatedBy: string;
  sourceEventIds: string[];
  metadata?: Record<string, unknown>;
  model?: string | null;
  noteType?: string;
  dueAt?: string | null;
  assigneeName?: string | null;
  requesterName?: string | null;
  memoryType?: string;
  tags?: string[];
  lastVerifiedAt?: string | null;
  expiresAt?: string | null;
};

type KnowledgePipelineStatusResponse = {
  scheduler?: {
    isRunning?: boolean;
    checkInterval?: number;
    userId?: string | null;
    isProcessing?: boolean;
    lastTickStartedAt?: string | null;
    lastTickCompletedAt?: string | null;
    lastTickStatus?: "idle" | "running" | "success" | "error" | "skipped";
    lastTickError?: string | null;
    lastTickResult?: Record<string, unknown> | null;
  };
  ingestion?: {
    isEnabled: boolean;
    isRunning: boolean;
    intervalMs: number;
    nextRunAt: string | null;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastStatus: "idle" | "running" | "success" | "error";
    lastReason: string | null;
    lastError: string | null;
    runCount: number;
    lastResult: {
      insertedCount: number;
      duplicateCount: number;
      eventCount: number;
      processingJobsCreated: number;
      queuedEventCount: number;
      sourceResults?: Array<{
        sourceId: string;
        sourceName: string;
        messageCount: number;
        insertedCount: number;
        duplicateCount: number;
        eventCount: number;
      }>;
    } | null;
  };
  processing?: {
    completed: number;
    failed: number;
    skipped: number;
  };
};

type GraphEntity = {
  id: string;
  name: string;
  entityType: string;
  aliases?: string[];
  description?: string | null;
  metadata?: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
};

type GraphRelation = {
  id: string;
  subjectEntityId: string;
  objectEntityId: string;
  relationType: string;
  claim: string;
  confidence: number;
  evidenceStrength: string;
  status: string;
  metadata?: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
};

type GraphEvidence = {
  id: string;
  relationId: string;
  sourceType: string;
  sourceId: string;
  eventId?: string | null;
  quote?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type InteractionEventEvidence = {
  id: string;
  platform: string;
  source: string;
  conversationId: string;
  conversationName: string;
  conversationType: string;
  senderId?: string | null;
  senderName?: string | null;
  senderDisplayName?: string | null;
  direction: string;
  contentType: string;
  content: string;
  contentPreview: string;
  messageTime: string;
  processedStatus: string;
  importance: string;
};

type InteractionEventsResponse = {
  events: InteractionEventEvidence[];
};

type InteractionGraphResponse = {
  entities: GraphEntity[];
  relations: GraphRelation[];
  evidence: GraphEvidence[];
  stats: {
    entityCount: number;
    relationCount: number;
    evidenceCount: number;
    activeRelationCount: number;
  };
};

type GraphRelationRow = {
  relation: GraphRelation;
  subject: GraphEntity;
  object: GraphEntity;
  evidence: GraphEvidence[];
};

type OwnerKnowledgeDashboardResponse = {
  interfaceVersion: "owner-context.v1";
  generatedAt: string;
  stats: {
    rawEventCount: number;
    taskCount: number;
    candidateCount: number;
    confirmedMemoryCount: number;
    noteCount: number;
    graphEntityCount: number;
    graphRelationCount: number;
  };
  warnings?: string[];
};

type ReprocessWikiResponse = {
  processedEventIds?: string[];
  notes?: unknown[];
  tasks?: unknown[];
  memories?: unknown[];
  sources?: Array<{
    sourceId: string;
    sourceName: string;
    eventCount: number;
  }>;
  cleared?: {
    deletedCount?: number;
    deletedNotes?: number;
    deletedTasks?: number;
    deletedMemories?: number;
  } | null;
  error?: string;
  sinceDays?: number;
  since?: string | null;
};

const policyLabels: Record<SourcePolicy, string> = {
  sync: "同步",
  summary: "只摘要",
  mention_only: "仅 @",
  ignore: "忽略",
};

const policyDescriptions: Record<SourcePolicy, string> = {
  sync: "同步原始消息，并参与摘要、任务和记忆提取",
  summary: "只保留摘要和高价值片段",
  mention_only: "只在明确提到你时进入管道",
  ignore: "不进入后台同步",
};

const SOURCE_PAGE_SIZE = 20;
const WIKI_RESULT_PAGE_SIZE = 20;
const WIKI_RESULT_LIMIT = 1000;

function formatDateTime(value: string | null) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(value?: number) {
  if (!value || value <= 0) return "未配置";
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return `${hours} 小时`;
}

function sourceTypeLabel(value: string) {
  if (value === "group") return "群聊";
  if (value === "official_account") return "公众号";
  if (value === "folded") return "折叠";
  if (value === "friend" || value === "private" || value === "dm") {
    return "私聊";
  }
  return value || "未知";
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    candidate: "待确认",
    confirmed: "已确认",
    done: "已完成",
    dismissed: "已忽略",
    archived: "已归档",
    pending: "待处理",
  };
  return labels[value] ?? value;
}

function entityTypeLabel(value: string) {
  const labels: Record<string, string> = {
    person: "人",
    group: "群",
    project: "项目",
    topic: "主题",
    risk: "风险",
    memory_topic: "记忆主题",
    preference: "偏好",
    company: "公司",
    stock: "股票",
    other: "其他",
  };
  return labels[value] ?? value;
}

function relationTypeLabel(value: string) {
  const labels: Record<string, string> = {
    mentions: "提到",
    summary: "摘要",
    fact: "事实",
    decision: "决策",
    commitment: "承诺",
    risk: "风险",
    contradiction: "矛盾",
    recommendation: "建议",
    memory_person: "人物记忆",
    memory_project: "项目记忆",
    memory_preference: "偏好记忆",
    memory_risk: "风险记忆",
    memory_other: "长期上下文",
  };
  return labels[value] ?? value.replace(/^memory_/, "记忆：");
}

function evidenceSourceLabel(value: string) {
  const labels: Record<string, string> = {
    interaction_event: "原始消息",
    interaction_memory: "已确认记忆",
  };
  return labels[value] ?? value;
}

function eventSenderLabel(event: InteractionEventEvidence) {
  return (
    event.senderDisplayName ||
    event.senderName ||
    event.conversationName ||
    "未知发送人"
  );
}

function eventDirectionLabel(value: string) {
  const labels: Record<string, string> = {
    incoming: "对方",
    outgoing: "我",
    unknown: "未知",
  };
  return labels[value] ?? value;
}

function memoryLifecycleLabel(item: WikiTimelineItem) {
  if (item.kind !== "memory") return statusLabel(item.status);
  const expiresAt = item.expiresAt ? new Date(item.expiresAt) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt < new Date()) {
    return "已过期";
  }
  if (item.status === "confirmed") return "使用中";
  if (item.status === "candidate") return "待确认";
  return statusLabel(item.status);
}

function canEnterPipeline(source: WechatSource) {
  return source.enabled && source.policy !== "ignore";
}

function SourcePolicySelect({
  source,
  saving,
  idSuffix,
  showLabel = false,
  fullWidth = false,
  onChange,
}: {
  source: WechatSource;
  saving: boolean;
  idSuffix: string;
  showLabel?: boolean;
  fullWidth?: boolean;
  onChange: (source: WechatSource, policy: SourcePolicy) => void;
}) {
  const selectId = `source-policy-${idSuffix}-${source.sourceId}`;

  return (
    <div className={cn(showLabel ? "space-y-1.5" : "flex items-center gap-2")}>
      {showLabel ? (
        <label
          htmlFor={selectId}
          className="block text-xs font-medium text-muted-foreground"
        >
          同步策略
        </label>
      ) : null}
      <div className={cn("flex items-center gap-2", fullWidth && "w-full")}>
        <select
          id={selectId}
          name={selectId}
          aria-label={`同步策略：${source.sourceName}`}
          value={source.policy}
          disabled={saving}
          title={
            source.configured
              ? policyDescriptions[source.policy]
              : "尚未选择同步策略"
          }
          onChange={(event) =>
            onChange(source, event.target.value as SourcePolicy)
          }
          className={cn(
            "h-9 rounded-md border border-border bg-white px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            fullWidth ? "w-full" : "min-w-32",
          )}
        >
          <option value="unconfigured" disabled>
            未选择
          </option>
          {(["sync", "summary", "mention_only", "ignore"] as const).map(
            (policy) => (
              <option key={policy} value={policy}>
                {policyLabels[policy]}
              </option>
            ),
          )}
        </select>
        {saving ? <Spinner size={12} /> : null}
      </div>
    </div>
  );
}

function metadataGeneratedBy(metadata: Record<string, unknown> | undefined) {
  const generatedBy = metadata?.generatedBy;
  return typeof generatedBy === "string" ? generatedBy : "";
}

function generatedKindLabel(metadata: Record<string, unknown> | undefined) {
  const generatedBy = metadataGeneratedBy(metadata);
  if (generatedBy.includes("processor_llm")) return "模型提取";
  if (generatedBy.includes("summary_note")) return "基础摘要";
  return "手动整理";
}

function countBy<T>(items: T[], getKey: (item: T) => string | undefined) {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = getKey(item) || "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function maxCount(counts: Record<string, number>) {
  return Math.max(1, ...Object.values(counts));
}

function confidenceTone(value: number | undefined) {
  const confidence = Number(value ?? 0);
  if (confidence >= 80) return "bg-emerald-500";
  if (confidence >= 60) return "bg-blue-500";
  return "bg-amber-500";
}

function wikiCardKey(item: Pick<WikiTimelineItem, "kind" | "id">) {
  return `${item.kind}:${item.id}`;
}

function wikiKindLabel(kind: WikiKind) {
  if (kind === "note") return "摘要";
  if (kind === "task") return "任务";
  return "记忆";
}

function wikiKindIcon(kind: WikiKind) {
  if (kind === "note") return "sticky_note";
  if (kind === "task") return "list_checks";
  return "brain";
}

const wikiResultViewLabels: Record<WikiResultView, string> = {
  tasks: "待办任务",
  memoryReview: "待确认上下文",
  memories: "已确认上下文",
  notes: "资料笔记",
};

function schedulerTickStatusLabel(value?: string) {
  const labels: Record<string, string> = {
    idle: "未扫描",
    running: "扫描中",
    success: "正常",
    error: "异常",
    skipped: "跳过",
  };
  return labels[value ?? ""] ?? "未知";
}

function taskStatusRank(status: string) {
  if (status === "candidate" || status === "pending") return 0;
  if (status === "confirmed") return 1;
  if (status === "done") return 2;
  if (status === "dismissed") return 3;
  return 4;
}

function compareWikiItems(a: WikiTimelineItem, b: WikiTimelineItem) {
  if (a.kind === "task" && b.kind === "task") {
    const statusDiff = taskStatusRank(a.status) - taskStatusRank(b.status);
    if (statusDiff !== 0) return statusDiff;
    const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
  }
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

function formatConfidence(value: number | undefined) {
  if (typeof value !== "number") return "未记录";
  return `${Math.trunc(value)}%`;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : "";
}

function formatMetadataValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(", ");
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return "";
}

function previewRows(item: WikiTimelineItem) {
  const rows = [
    ["类型", wikiKindLabel(item.kind)],
    ["状态", statusLabel(item.status)],
    ["置信度", formatConfidence(item.confidence)],
    ["生成方式", item.generatedBy],
    ["来源消息", `${item.sourceEventIds.length} 条`],
    ["创建时间", formatDateTime(item.createdAt)],
  ];

  if (item.kind === "note") {
    rows.push(["摘要类型", item.noteType || item.status]);
    rows.push([
      "模型",
      item.model || metadataString(item.metadata, "model") || "未记录",
    ]);
  }

  if (item.kind === "task") {
    rows.push(["截止时间", formatDateTime(item.dueAt ?? null)]);
    rows.push(["负责人", item.assigneeName || "未记录"]);
    rows.push(["请求人", item.requesterName || "未记录"]);
  }

  if (item.kind === "memory") {
    rows.push(["记忆类型", item.memoryType || "未记录"]);
    rows.push(["标签", item.tags?.length ? item.tags.join(", ") : "未记录"]);
    rows.push(["验证时间", formatDateTime(item.lastVerifiedAt ?? null)]);
    rows.push(["过期时间", formatDateTime(item.expiresAt ?? null)]);
  }

  return rows;
}

export default function KnowledgePipelinePage() {
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view");
  const activeView: PipelineView =
    requestedView === "sources"
      ? "sources"
      : requestedView === "graph"
        ? "graph"
        : "memory";
  const [savingSourceId, setSavingSourceId] = useState<string | null>(null);
  const [recordingWechat, setRecordingWechat] = useState(false);
  const [query, setQuery] = useState("");
  const [sourcePage, setSourcePage] = useState(1);
  const [wikiResultView, setWikiResultView] =
    useState<WikiResultView>("tasks");
  const [wikiPage, setWikiPage] = useState(1);
  const [selectedWikiKey, setSelectedWikiKey] = useState<string | null>(null);
  const [selectedGraphRelationId, setSelectedGraphRelationId] = useState<
    string | null
  >(null);
  const [deletingWikiKey, setDeletingWikiKey] = useState<string | null>(null);
  const [clearingMemories, setClearingMemories] = useState(false);
  const [clearingWikiItems, setClearingWikiItems] = useState(false);
  const [regeneratingWiki, setRegeneratingWiki] = useState(false);
  const [memoryClearMessage, setMemoryClearMessage] = useState<string | null>(
    null,
  );
  const { data, error, isLoading, mutate } = useSWR<SourcesResponse>(
    activeView === "sources"
      ? "/api/knowledge-pipeline/wechat/sources?limit=200"
      : null,
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: wiki, isLoading: isWikiLoading, mutate: mutateWiki } = useSWR<WikiResponse>(
    activeView === "memory"
      ? `/api/interactions/wiki?limit=${WIKI_RESULT_LIMIT}`
      : null,
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: ownerKnowledge, mutate: mutateOwnerKnowledge } =
    useSWR<OwnerKnowledgeDashboardResponse>(
      activeView === "memory"
        ? `/api/owner-context?view=dashboard&limit=${WIKI_RESULT_LIMIT}`
        : null,
      fetcher,
      { revalidateOnFocus: false },
    );
  const {
    data: graph,
    error: graphError,
    isLoading: isGraphLoading,
    mutate: mutateGraph,
  } = useSWR<InteractionGraphResponse>(
    activeView === "graph"
      ? "/api/interactions/graph?entityLimit=240&relationLimit=200"
      : null,
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: pipelineStatus, mutate: mutatePipelineStatus } =
    useSWR<KnowledgePipelineStatusResponse>(
      "/api/knowledge-pipeline/status",
      fetcher,
      {
        refreshInterval: 10_000,
        revalidateOnFocus: false,
      },
    );

  const sources = data?.sources ?? [];
  const ingestionStatus = pipelineStatus?.ingestion;
  const filteredSources = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sources;
    return sources.filter((source) =>
      [source.sourceName, source.sourceId, source.sourceType]
        .join(" ")
        .toLowerCase()
        .includes(keyword),
    );
  }, [sources, query]);

  useEffect(() => {
    setSourcePage(1);
  }, [query]);

  const totalSourcePages = Math.max(
    1,
    Math.ceil(filteredSources.length / SOURCE_PAGE_SIZE),
  );
  const currentSourcePage = Math.min(sourcePage, totalSourcePages);
  const pagedSources = useMemo(() => {
    const start = (currentSourcePage - 1) * SOURCE_PAGE_SIZE;
    return filteredSources.slice(start, start + SOURCE_PAGE_SIZE);
  }, [filteredSources, currentSourcePage]);
  const sourceRangeStart =
    filteredSources.length === 0
      ? 0
      : (currentSourcePage - 1) * SOURCE_PAGE_SIZE + 1;
  const sourceRangeEnd = Math.min(
    currentSourcePage * SOURCE_PAGE_SIZE,
    filteredSources.length,
  );

  const counts = useMemo(() => {
    const enabled = sources.filter(canEnterPipeline).length;
    const ignored = sources.filter(
      (source) => source.configured && source.policy === "ignore",
    ).length;
    const groups = sources.filter(
      (source) => source.sourceType === "group",
    ).length;
    const unread = sources.reduce(
      (sum, source) => sum + (source.unread ?? 0),
      0,
    );
    return { enabled, ignored, groups, unread };
  }, [sources]);

  const wikiStats = useMemo(() => {
    const notes = wiki?.notes ?? [];
    const tasks = wiki?.tasks ?? [];
    const memories = wiki?.memories ?? [];
    const noteGeneration = countBy(notes, (note) =>
      generatedKindLabel(note.metadata),
    );
    const taskStatus = countBy(tasks, (task) => task.status);
    const memoryStatus = countBy(memories, (memory) => memory.status);
    const timeline: WikiTimelineItem[] = [
      ...notes.map((note) => ({
        id: note.id,
        kind: "note" as const,
        title: note.title,
        body: note.body,
        createdAt: note.createdAt,
        status: note.noteType ?? generatedKindLabel(note.metadata),
        confidence: note.confidence,
        generatedBy: generatedKindLabel(note.metadata),
        sourceEventIds: note.sourceEventIds ?? [],
        metadata: note.metadata,
        model: note.model,
        noteType: note.noteType,
      })),
      ...tasks.map((task) => ({
        id: task.id,
        kind: "task" as const,
        title: task.title,
        body: task.description ?? "",
        createdAt: task.createdAt,
        status: task.status,
        confidence: task.confidence,
        generatedBy: generatedKindLabel(task.metadata),
        sourceEventIds: task.sourceEventIds ?? [],
        metadata: task.metadata,
        dueAt: task.dueAt,
        assigneeName: task.assigneeName,
        requesterName: task.requesterName,
      })),
      ...memories.map((memory) => ({
        id: memory.id,
        kind: "memory" as const,
        title: memory.subject,
        body: memory.content,
        createdAt: memory.createdAt,
        status: memory.status,
        confidence: memory.confidence,
        generatedBy: generatedKindLabel(memory.metadata),
        sourceEventIds: memory.sourceEventIds ?? [],
        metadata: memory.metadata,
        memoryType: memory.memoryType,
        tags: memory.tags,
        lastVerifiedAt: memory.lastVerifiedAt,
        expiresAt: memory.expiresAt,
      })),
    ].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return {
      notes,
      tasks,
      memories,
      noteGeneration,
      taskStatus,
      memoryStatus,
      timeline,
      total: notes.length + tasks.length + memories.length,
      llmCount: timeline.filter((item) => item.generatedBy === "模型提取")
        .length,
      fallbackCount: timeline.filter((item) => item.generatedBy === "基础摘要")
        .length,
    };
  }, [wiki]);

  const wikiLists = useMemo(
    () => ({
      tasks: wikiStats.timeline
        .filter((item) => item.kind === "task")
        .sort(compareWikiItems),
      memoryReview: wikiStats.timeline
        .filter((item) => item.kind === "memory" && item.status === "candidate")
        .sort(compareWikiItems),
      memories: wikiStats.timeline
        .filter((item) => item.kind === "memory" && item.status === "confirmed")
        .sort(compareWikiItems),
      notes: wikiStats.timeline
        .filter((item) => item.kind === "note")
        .sort(compareWikiItems),
    }),
    [wikiStats.timeline],
  );
  const activeWikiItems = wikiLists[wikiResultView];
  const totalWikiPages = Math.max(
    1,
    Math.ceil(activeWikiItems.length / WIKI_RESULT_PAGE_SIZE),
  );
  const currentWikiPage = Math.min(wikiPage, totalWikiPages);
  const pagedWikiItems = useMemo(() => {
    const start = (currentWikiPage - 1) * WIKI_RESULT_PAGE_SIZE;
    return activeWikiItems.slice(start, start + WIKI_RESULT_PAGE_SIZE);
  }, [activeWikiItems, currentWikiPage]);
  const wikiRangeStart =
    activeWikiItems.length === 0
      ? 0
      : (currentWikiPage - 1) * WIKI_RESULT_PAGE_SIZE + 1;
  const wikiRangeEnd = Math.min(
    currentWikiPage * WIKI_RESULT_PAGE_SIZE,
    activeWikiItems.length,
  );

  const selectedWikiItem = useMemo(() => {
    if (!selectedWikiKey) return null;
    return (
      wikiStats.timeline.find(
        (item) => wikiCardKey(item) === selectedWikiKey,
      ) ?? null
    );
  }, [selectedWikiKey, wikiStats.timeline]);
  const selectedEvidenceIds = selectedWikiItem?.sourceEventIds ?? [];
  const {
    data: selectedEvidence,
    error: selectedEvidenceError,
    isLoading: isSelectedEvidenceLoading,
  } = useSWR<InteractionEventsResponse>(
    activeView === "memory" && selectedEvidenceIds.length > 0
      ? `/api/interactions/events?ids=${selectedEvidenceIds
          .map((id) => encodeURIComponent(id))
          .join(",")}`
      : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const graphView = useMemo(() => {
    const entities = graph?.entities ?? [];
    const relations = graph?.relations ?? [];
    const evidence = graph?.evidence ?? [];
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const evidenceByRelation = new Map<string, GraphEvidence[]>();
    for (const item of evidence) {
      const bucket = evidenceByRelation.get(item.relationId) ?? [];
      bucket.push(item);
      evidenceByRelation.set(item.relationId, bucket);
    }

    const degreeByEntity = new Map<string, number>();
    const relationRows = relations
      .map((relation) => {
        const subject = entityById.get(relation.subjectEntityId);
        const object = entityById.get(relation.objectEntityId);
        if (!subject || !object) return null;
        degreeByEntity.set(subject.id, (degreeByEntity.get(subject.id) ?? 0) + 1);
        degreeByEntity.set(object.id, (degreeByEntity.get(object.id) ?? 0) + 1);
        return {
          relation,
          subject,
          object,
          evidence: evidenceByRelation.get(relation.id) ?? [],
        };
      })
      .filter((item): item is {
        relation: GraphRelation;
        subject: GraphEntity;
        object: GraphEntity;
        evidence: GraphEvidence[];
      } => Boolean(item));

    const keyword = query.trim().toLowerCase();
    const filteredRelations = keyword
      ? relationRows.filter((item) =>
          [
            item.subject.name,
            item.object.name,
            item.relation.claim,
            item.relation.relationType,
            item.subject.aliases?.join(" "),
            item.object.aliases?.join(" "),
          ]
            .join(" ")
            .toLowerCase()
            .includes(keyword),
        )
      : relationRows;

    const topEntities = entities
      .map((entity) => ({
        ...entity,
        degree: degreeByEntity.get(entity.id) ?? 0,
      }))
      .sort((a, b) => {
        const degreeDelta = b.degree - a.degree;
        if (degreeDelta !== 0) return degreeDelta;
        return (
          new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
        );
      })
      .slice(0, 24);

    const relationTypeCounts = countBy(relations, (relation) =>
      relationTypeLabel(relation.relationType),
    );

    return {
      entities,
      relations,
      relationRows,
      filteredRelations,
      topEntities,
      relationTypeCounts,
    };
  }, [graph, query]);

  const selectedGraphRelation = useMemo(() => {
    if (!selectedGraphRelationId) return null;
    return (
      graphView.relationRows.find(
        (item) => item.relation.id === selectedGraphRelationId,
      ) ?? null
    );
  }, [graphView.relationRows, selectedGraphRelationId]);

  useEffect(() => {
    setWikiPage(1);
  }, [wikiResultView]);

  useEffect(() => {
    if (activeWikiItems.length === 0) {
      if (selectedWikiKey) setSelectedWikiKey(null);
      return;
    }

    if (
      selectedWikiKey &&
      activeWikiItems.some((item) => wikiCardKey(item) === selectedWikiKey)
    ) {
      return;
    }

    setSelectedWikiKey(wikiCardKey(activeWikiItems[0]));
  }, [activeWikiItems, selectedWikiKey]);

  useEffect(() => {
    if (activeView !== "graph") return;
    if (graphView.filteredRelations.length === 0) {
      if (selectedGraphRelationId) setSelectedGraphRelationId(null);
      return;
    }

    if (
      selectedGraphRelationId &&
      graphView.filteredRelations.some(
        (item) => item.relation.id === selectedGraphRelationId,
      )
    ) {
      return;
    }

    setSelectedGraphRelationId(graphView.filteredRelations[0].relation.id);
  }, [activeView, graphView.filteredRelations, selectedGraphRelationId]);

  async function updateSourcePolicy(
    source: WechatSource,
    policy: SourcePolicy,
  ) {
    setSavingSourceId(source.sourceId);
    try {
      await fetch("/api/knowledge-pipeline/wechat/sources", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: source.sourceId,
          sourceName: source.sourceName,
          sourceType: source.sourceType,
          policy,
          enabled: policy !== "ignore",
          lastMessageAt: source.lastMessageAt,
        }),
      }).then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error ?? "更新来源策略失败");
        }
      });
      await mutate();
    } catch (err) {
      toast({
        type: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSourceId(null);
    }
  }

  function updateSourceSelection(source: WechatSource, enabled: boolean) {
    const policy = enabled
      ? source.policy === "ignore"
        ? "sync"
        : source.policy
      : "ignore";
    return updateSourcePolicy(source, policy);
  }

  async function recordWechatMessages() {
    setRecordingWechat(true);
    try {
      const result = await fetch("/api/knowledge-pipeline/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run-now",
          limit: 50,
        }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error ?? "同步微信消息失败");
        }
        return payload as KnowledgePipelineStatusResponse;
      });
      await Promise.all([mutate(), mutateWiki(), mutatePipelineStatus()]);
      const lastResult = result.ingestion?.lastResult;
      const scannedSources = lastResult?.sourceResults ?? [];
      const sourcesWithNewMessages = scannedSources.filter(
        (source) => source.insertedCount > 0,
      );
      const sourceSummary =
        scannedSources.length > 0
          ? `扫描 ${scannedSources.length} 个来源${
              sourcesWithNewMessages.length > 0
                ? `，新增来自 ${sourcesWithNewMessages.map((source) => source.sourceName).join("、")}`
                : "，没有来源产生新消息"
            }`
          : "";
      const processing = result.processing;
      const processingSummary = processing
        ? `，处理任务完成 ${processing.completed} 个，失败 ${processing.failed} 个`
        : "";
      toast({
        type: "success",
        description: `已补跑 ${lastResult?.insertedCount ?? 0} 条新消息，跳过 ${lastResult?.duplicateCount ?? 0} 条重复消息，入队 ${lastResult?.queuedEventCount ?? 0} 条${processingSummary}${sourceSummary ? `。${sourceSummary}` : ""}`,
      });
    } catch (err) {
      toast({
        type: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRecordingWechat(false);
    }
  }

  async function deleteSelectedWikiItem(item: WikiTimelineItem) {
    const message = `删除这条${wikiKindLabel(item.kind)}？\n\n删除后它不会再参与工作台召回或任务提醒。原始聊天消息不会被删除。`;
    if (!window.confirm(message)) return;

    const cardKey = wikiCardKey(item);
    setDeletingWikiKey(cardKey);
    try {
      await fetch("/api/interactions/wiki", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: item.kind,
          id: item.id,
          reason: "user_deleted_from_preview",
        }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error ?? "删除知识失败");
        }
      });
      setSelectedWikiKey(null);
      await mutateWiki();
      await mutateOwnerKnowledge();
      toast({
        type: "success",
        description: `已删除这条${wikiKindLabel(item.kind)}`,
      });
    } catch (err) {
      toast({
        type: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeletingWikiKey(null);
    }
  }

  async function updateWikiItemStatus(item: WikiTimelineItem, status: string) {
    if (item.kind !== "task" && item.kind !== "memory") return;
    const label = wikiKindLabel(item.kind);
    const previousKey = wikiCardKey(item);
    setDeletingWikiKey(previousKey);
    try {
      const response = await fetch("/api/interactions/wiki", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: item.kind,
          id: item.id,
          status,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `更新${label}状态失败`);
      }
      await mutateWiki();
      await mutateOwnerKnowledge();
      toast({
        type: "success",
        description: `${label}已标记为${statusLabel(status)}`,
      });
    } catch (err) {
      toast({
        type: "error",
        description:
          err instanceof Error ? err.message : `更新${label}状态失败`,
      });
    } finally {
      setDeletingWikiKey(null);
    }
  }

  async function clearMemories() {
    setMemoryClearMessage(null);
    const message =
      "清空所有长期上下文？\n\n这会让当前通过微信等外部消息沉淀出的长期上下文不再参与召回。原始聊天消息、摘要和任务不会被删除。";
    if (!window.confirm(message)) return;

    setClearingMemories(true);
    try {
      const result = await fetch("/api/interactions/wiki", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear_memories",
          reason: "user_cleared_memories",
        }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error ?? "清空长期上下文失败");
        }
        return payload as { deletedCount?: number };
      });
      setSelectedWikiKey(null);
      await mutateWiki();
      await mutateOwnerKnowledge();
      const deletedCount = result.deletedCount ?? 0;
      const description =
        deletedCount > 0
          ? `已清空 ${deletedCount} 条长期上下文，后续召回不会再使用它们。摘要和任务卡片会保留在可视化里。`
          : wikiStats.notes.length + wikiStats.tasks.length > 0
            ? "当前没有可清空的长期上下文。可视化里剩余的是摘要或任务卡片。"
            : "当前没有可清空的长期上下文";
      setMemoryClearMessage(description);
      toast({
        type: deletedCount > 0 ? "success" : "info",
        description,
      });
    } catch (err) {
      toast({
        type: "error",
        description: err instanceof Error ? err.message : String(err),
      });
      setMemoryClearMessage(
        err instanceof Error ? err.message : "清空长期上下文失败",
      );
    } finally {
      setClearingMemories(false);
    }
  }

  async function clearWikiItems() {
    setMemoryClearMessage(null);
    const message =
      "清空全部知识成果？\n\n这会清空当前摘要、任务和记忆，让它们不再参与召回。原始聊天消息不会被删除。";
    if (!window.confirm(message)) return;

    setClearingWikiItems(true);
    try {
      const result = await fetch("/api/owner-context", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset_owner_knowledge",
          reason: "user_reset_owner_knowledge",
        }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error ?? "重置主人知识库失败");
        }
        return payload as {
          deletedCount?: number;
          deletedNotes?: number;
          deletedTasks?: number;
          deletedMemories?: number;
        };
      });
      setSelectedWikiKey(null);
      await mutateWiki();
      await mutateOwnerKnowledge();
      const deletedCount = result.deletedCount ?? 0;
      const description =
        deletedCount > 0
          ? `已清空 ${deletedCount} 张卡片：摘要 ${result.deletedNotes ?? 0}、任务 ${result.deletedTasks ?? 0}、记忆 ${result.deletedMemories ?? 0}`
          : "当前没有可清空的知识成果";
      setMemoryClearMessage(description);
      toast({
        type: deletedCount > 0 ? "success" : "info",
        description,
      });
    } catch (err) {
      toast({
        type: "error",
        description: err instanceof Error ? err.message : String(err),
      });
      setMemoryClearMessage(
        err instanceof Error ? err.message : "重置主人知识库失败",
      );
    } finally {
      setClearingWikiItems(false);
    }
  }

  async function regenerateWiki() {
    setMemoryClearMessage(null);
    const message =
      "重新整理近一周上下文？\n\n这会基于已选择联系人最近一周的已同步消息，重新生成摘要、任务和长期上下文。现有知识成果会先被清空，原始聊天消息不会被删除。";
    if (!window.confirm(message)) return;

    setRegeneratingWiki(true);
    try {
      const result = await fetch("/api/interactions/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "selected_sources",
          clearExisting: true,
          sinceDays: 7,
          limit: 500,
          perSourceLimit: 200,
          chunkSize: 40,
          fallbackToSummary: true,
        }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error ?? "重新整理上下文失败");
        }
        return payload as ReprocessWikiResponse;
      });

      setSelectedWikiKey(null);
      await mutateWiki();
      await mutateOwnerKnowledge();
      const noteCount = result.notes?.length ?? 0;
      const taskCount = result.tasks?.length ?? 0;
      const memoryCount = result.memories?.length ?? 0;
      const eventCount = result.processedEventIds?.length ?? 0;
      const sourceCount = result.sources?.length ?? 0;
      const description =
        eventCount > 0
          ? `已基于 ${sourceCount} 个来源最近一周的 ${eventCount} 条已同步消息重新生成：摘要 ${noteCount}、任务 ${taskCount}、记忆 ${memoryCount}`
          : "当前启用来源最近一周还没有可重新解析的已同步消息";
      setMemoryClearMessage(description);
      toast({
        type: eventCount > 0 ? "success" : "info",
        description,
      });
    } catch (err) {
      toast({
        type: "error",
        description: err instanceof Error ? err.message : String(err),
      });
      setMemoryClearMessage(
        err instanceof Error ? err.message : "重新整理上下文失败",
      );
    } finally {
      setRegeneratingWiki(false);
    }
  }

  const candidateCount =
    (wiki?.tasks?.filter((task) => task.status === "candidate").length ?? 0) +
    (wiki?.memories?.filter((memory) => memory.status === "candidate").length ??
      0);
  const ownerContextReady =
    ownerKnowledge?.interfaceVersion === "owner-context.v1";
  const schedulerStatus = pipelineStatus?.scheduler;
  const schedulerRunning = schedulerStatus?.isRunning === true;
  const pipelineStateLabel = !ingestionStatus?.isEnabled
    ? "已暂停"
    : ingestionStatus?.isRunning
      ? "采集中"
      : schedulerStatus?.isProcessing
        ? "调度扫描中"
      : schedulerRunning
        ? "后台运行中"
        : "等待启动";
  const pipelineStateDetail = !ingestionStatus?.isEnabled
    ? "已通过环境变量关闭自动采集"
    : schedulerRunning
      ? schedulerStatus?.lastTickStartedAt
        ? `每 ${formatDuration(ingestionStatus?.intervalMs)} 检查一次微信来源，上次扫描 ${formatDateTime(schedulerStatus.lastTickStartedAt)}`
        : `每 ${formatDuration(ingestionStatus?.intervalMs)} 检查一次微信来源，等待首次扫描`
      : "本地调度器启动后会自动采集";
  const lastIngestionResult = ingestionStatus?.lastResult;

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-[#F8FAF9] text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 pb-10 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-[var(--product-jade)]">
              <span
                className="h-px w-6 bg-[var(--product-jade)]"
                aria-hidden="true"
              />
              主人上下文层
            </div>
            <h1 className="mt-3 text-2xl font-semibold text-foreground sm:text-3xl">
              主人知识库
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              微信消息先保留为原始事实，再提炼成待办、资料、关系和长期上下文。每条结论都能回到来源，工作台按场景读取这里。
            </p>
          </div>
          <Button
            className="h-9 gap-2 px-3"
            onClick={recordWechatMessages}
            disabled={recordingWechat || counts.enabled === 0}
            title={
              counts.enabled === 0
                ? "先在微信来源中选择至少一个会话"
                : "手动补跑已选择来源的新消息"
            }
          >
            {recordingWechat ? (
              <Spinner size={14} />
            ) : (
              <RemixIcon name="refresh" size="size-4" />
            )}
            手动补跑
          </Button>
        </header>

        <MemoryDependencyRecovery />

        <nav
          aria-label="主人知识库视图"
          className="flex w-fit items-center rounded-md bg-muted/60 p-1"
        >
          <Link
            href="/knowledge-pipeline?view=memory"
            aria-current={activeView === "memory" ? "page" : undefined}
            className={cn(
              "rounded px-3 py-1.5 text-sm no-underline transition-colors",
              activeView === "memory"
                ? "bg-white font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            上下文成果
          </Link>
          <Link
            href="/knowledge-pipeline?view=graph"
            aria-current={activeView === "graph" ? "page" : undefined}
            className={cn(
              "rounded px-3 py-1.5 text-sm no-underline transition-colors",
              activeView === "graph"
                ? "bg-white font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            关系图谱
          </Link>
          <Link
            href="/knowledge-pipeline?view=sources"
            aria-current={activeView === "sources" ? "page" : undefined}
            className={cn(
              "rounded px-3 py-1.5 text-sm no-underline transition-colors",
              activeView === "sources"
                ? "bg-white font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            微信来源
          </Link>
        </nav>

        <section className="rounded-md border border-border bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  后台采集
                </h2>
                <Badge
                  variant={
                    ingestionStatus?.lastStatus === "error"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {pipelineStateLabel}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {pipelineStateDetail}
              </p>
              {ingestionStatus?.lastError ? (
                <p className="mt-2 line-clamp-2 text-xs text-destructive">
                  {ingestionStatus.lastError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:min-w-[820px] lg:grid-cols-6">
              <div className="rounded-md bg-muted/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">上次采集</div>
                <div className="mt-1 font-medium">
                  {formatDateTime(ingestionStatus?.lastCompletedAt ?? null)}
                </div>
              </div>
              <div className="rounded-md bg-muted/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">下次采集</div>
                <div className="mt-1 font-medium">
                  {formatDateTime(ingestionStatus?.nextRunAt ?? null)}
                </div>
              </div>
              <div className="rounded-md bg-muted/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">最近新增</div>
                <div className="mt-1 font-medium">
                  {lastIngestionResult?.insertedCount ?? 0} 条
                </div>
              </div>
              <div className="rounded-md bg-muted/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">已入队</div>
                <div className="mt-1 font-medium">
                  {lastIngestionResult?.queuedEventCount ?? 0} 条
                </div>
              </div>
              <div className="rounded-md bg-muted/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">调度心跳</div>
                <div className="mt-1 font-medium">
                  {schedulerRunning ? "存活" : "未运行"}
                </div>
              </div>
              <div className="rounded-md bg-muted/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">最近扫描</div>
                <div
                  className={cn(
                    "mt-1 font-medium",
                    schedulerStatus?.lastTickStatus === "error"
                      ? "text-destructive"
                      : "",
                  )}
                  title={schedulerStatus?.lastTickError ?? undefined}
                >
                  {schedulerTickStatusLabel(schedulerStatus?.lastTickStatus)}
                </div>
              </div>
            </div>
          </div>
          {schedulerStatus?.lastTickError ? (
            <p className="mt-3 line-clamp-2 text-xs text-destructive">
              调度器最近错误：{schedulerStatus.lastTickError}
            </p>
          ) : null}
        </section>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error instanceof Error ? error.message : "加载主人知识库失败"}
          </div>
        ) : null}
        {graphError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {graphError instanceof Error ? graphError.message : "加载关系图谱失败"}
          </div>
        ) : null}

        {activeView === "memory" ? (
          <>
            <section className="grid grid-cols-2 border-y border-border lg:grid-cols-4">
              <div className="border-b border-r border-border px-4 py-4 lg:border-b-0">
                <div className="text-xs text-muted-foreground">已选择来源</div>
                <div className="mt-2 text-2xl font-semibold">
                  {counts.enabled}
                </div>
              </div>
              <div className="border-b border-border px-4 py-4 lg:border-b-0 lg:border-r">
                <div className="text-xs text-muted-foreground">待办任务</div>
                <div className="mt-2 text-2xl font-semibold">
                  {wikiStats.tasks.length}
                </div>
              </div>
              <div className="border-r border-border px-4 py-4">
                <div className="text-xs text-muted-foreground">待确认</div>
                <div className="mt-2 text-2xl font-semibold">
                  {candidateCount}
                </div>
              </div>
              <div className="px-4 py-4">
                <div className="text-xs text-muted-foreground">已确认上下文</div>
                <div className="mt-2 text-2xl font-semibold">
                  {ownerKnowledge?.stats.confirmedMemoryCount ??
                    wikiStats.memoryStatus.confirmed ??
                    0}
                </div>
              </div>
            </section>

            <section className="border-t border-border pt-5">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">上下文成果</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    默认先处理待办任务，再确认长期上下文和资料笔记。每类结果都可以分页看完。
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={ownerContextReady ? "secondary" : "outline"}>
                    {ownerContextReady ? "主人上下文已接入" : "上下文接入中"}
                  </Badge>
                  <Badge variant="outline">共 {wikiStats.total} 条</Badge>
                  <Badge variant="secondary">
                    模型提取 {wikiStats.llmCount}
                  </Badge>
                  <Badge variant="secondary">
                    基础摘要 {wikiStats.fallbackCount}
                  </Badge>
                  <Button
                    variant="outline"
                    className="h-8 gap-1.5 px-2 text-xs"
                    disabled={
                      clearingMemories ||
                      clearingWikiItems ||
                      regeneratingWiki ||
                      counts.enabled === 0
                    }
                    onClick={regenerateWiki}
                    title="用已选择联系人最近一周的已同步消息重新整理上下文"
                  >
                    {regeneratingWiki ? (
                      <Spinner size={12} />
                    ) : (
                      <RemixIcon name="wand_sparkles" size="size-3.5" />
                    )}
                    重新整理近一周
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-8"
                        aria-label="管理主人知识库"
                        title="管理主人知识库"
                        disabled={
                          clearingMemories ||
                          clearingWikiItems ||
                          regeneratingWiki
                        }
                      >
                        <RemixIcon name="more_2" size="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem
                        onSelect={() => clearMemories()}
                        className="text-destructive focus:text-destructive"
                      >
                        <RemixIcon name="delete_bin" size="size-4" />
                        清空长期上下文
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => clearWikiItems()}
                        className="text-destructive focus:text-destructive"
                      >
                        <RemixIcon name="delete_bin" size="size-4" />
                        重置主人知识库
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {memoryClearMessage ? (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  <RemixIcon name="info" size="size-4" className="mt-0.5" />
                  <span>{memoryClearMessage}</span>
                </div>
              ) : null}

              {ownerKnowledge?.warnings?.length ? (
                <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  {ownerKnowledge.warnings.map((warning) => (
                    <div key={warning} className="flex gap-2">
                      <RemixIcon
                        name="information"
                        size="size-3.5"
                        className="mt-0.5 shrink-0"
                      />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="mt-4 grid gap-3 md:grid-cols-4">
                {(
                  [
                    {
                      view: "tasks" as const,
                      label: "待办任务",
                      count: wikiStats.tasks.length,
                      hint: "优先处理别人交代、需要回复或你承诺过的事。",
                      icon: "list_checks",
                      tone: "border-[var(--product-amber)]",
                    },
                    {
                      view: "memoryReview" as const,
                      label: "待确认上下文",
                      count: wikiStats.memoryStatus.candidate ?? 0,
                      hint: "模型提炼出的长期上下文候选，确认后才进入召回。",
                      icon: "checkbox_circle",
                      tone: "border-[var(--product-gold)]",
                    },
                    {
                      view: "memories" as const,
                      label: "已确认上下文",
                      count:
                        ownerKnowledge?.stats.confirmedMemoryCount ??
                        wikiStats.memoryStatus.confirmed ??
                        0,
                      hint: "已经确认、会进入工作台长期召回的人、项目、偏好和边界。",
                      icon: "brain",
                      tone: "border-[var(--product-jade)]",
                    },
                    {
                      view: "notes" as const,
                      label: "资料笔记",
                      count: wikiStats.notes.length,
                      hint: "保留摘要、风险、背景和关系线索，用来回看上下文。",
                      icon: "sticky_note",
                      tone: "border-[var(--product-cobalt)]",
                    },
                  ]
                ).map((item) => {
                  const selected = wikiResultView === item.view;
                  return (
                    <button
                      key={item.view}
                      type="button"
                      onClick={() => setWikiResultView(item.view)}
                      aria-pressed={selected}
                      className={cn(
                        "min-w-0 rounded-md border bg-background p-4 text-left outline-none transition",
                        "hover:border-primary/60 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-primary/30",
                        selected
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              "flex size-8 shrink-0 items-center justify-center rounded-md border-l-2 bg-muted/50",
                              item.tone,
                            )}
                          >
                            <RemixIcon name={item.icon} size="size-4" />
                          </span>
                          <span className="truncate text-sm font-medium">
                            {item.label}
                          </span>
                        </div>
                        <span className="text-xl font-semibold tabular-nums">
                          {item.count}
                        </span>
                      </div>
                      <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {item.hint}
                      </p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]">
                <div className="min-w-0 rounded-md border border-border bg-background">
                  <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="text-base font-semibold">
                        {wikiResultViewLabels[wikiResultView]}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {activeWikiItems.length > 0
                          ? `${wikiRangeStart}-${wikiRangeEnd} / ${activeWikiItems.length}，每页 ${WIKI_RESULT_PAGE_SIZE} 条`
                          : "当前没有这一类成果"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        className="h-8 gap-1 px-2 text-xs"
                        disabled={currentWikiPage <= 1}
                        onClick={() =>
                          setWikiPage(Math.max(1, currentWikiPage - 1))
                        }
                      >
                        <RemixIcon name="arrow_left_s" size="size-4" />
                        上一页
                      </Button>
                      <span className="min-w-16 text-center text-xs text-muted-foreground">
                        {currentWikiPage} / {totalWikiPages}
                      </span>
                      <Button
                        variant="outline"
                        className="h-8 gap-1 px-2 text-xs"
                        disabled={currentWikiPage >= totalWikiPages}
                        onClick={() =>
                          setWikiPage(
                            Math.min(totalWikiPages, currentWikiPage + 1),
                          )
                        }
                      >
                        下一页
                        <RemixIcon name="arrow_right_s" size="size-4" />
                      </Button>
                    </div>
                  </div>

                  {isWikiLoading ? (
                    <div className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-muted-foreground">
                      <Spinner size={16} />
                      加载上下文成果
                    </div>
                  ) : activeWikiItems.length === 0 ? (
                    <div className="px-4 py-12 text-center text-sm leading-6 text-muted-foreground">
                      {wikiResultView === "tasks"
                        ? "还没有待办任务。后台从聊天里识别到明确请求、承诺或需回复事项后，会优先出现在这里。"
                        : wikiResultView === "memoryReview"
                          ? "还没有待确认上下文。后台从聊天里提炼出稳定信息后，会先出现在这里等待你确认。"
                          : wikiResultView === "memories"
                            ? "还没有已确认上下文。确认后的长期知识会进入这里，并参与工作台召回。"
                          : "还没有资料笔记。聊天摘要、风险和项目背景会沉淀到这里。"}
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {pagedWikiItems.map((item) => {
                        const cardKey = wikiCardKey(item);
                        const selected = cardKey === selectedWikiKey;
                        const busy = deletingWikiKey === cardKey;
                        return (
                          <div
                            key={cardKey}
                            className={cn(
                              "grid gap-3 p-4 transition md:grid-cols-[minmax(0,1fr)_auto]",
                              selected ? "bg-primary/5" : "bg-background",
                            )}
                          >
                            <button
                              type="button"
                              aria-pressed={selected}
                              onClick={() => setSelectedWikiKey(cardKey)}
                              className="min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={cn(
                                    "size-2 rounded-full",
                                    confidenceTone(item.confidence),
                                  )}
                                />
                                <Badge variant="outline">
                                  {memoryLifecycleLabel(item)}
                                </Badge>
                                <Badge variant="secondary">
                                  {formatConfidence(item.confidence)}
                                </Badge>
                                {item.kind === "task" && item.dueAt ? (
                                  <Badge variant="outline">
                                    截止 {formatDateTime(item.dueAt)}
                                  </Badge>
                                ) : null}
                                <span className="ml-auto hidden text-xs text-muted-foreground md:inline">
                                  {formatDateTime(item.createdAt)}
                                </span>
                              </div>
                              <div className="mt-2 text-sm font-medium leading-6">
                                {item.title}
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                {item.body || item.status}
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                <span>{item.generatedBy}</span>
                                <span>来源 {item.sourceEventIds.length} 条</span>
                                {item.kind === "memory" && item.memoryType ? (
                                  <span>{item.memoryType}</span>
                                ) : null}
                                {item.kind === "task" && item.requesterName ? (
                                  <span>请求人 {item.requesterName}</span>
                                ) : null}
                              </div>
                            </button>

                            <div className="flex flex-wrap items-center gap-2 md:justify-end">
                              {item.kind === "task" ? (
                                <>
                                  {item.status !== "done" ? (
                                    <Button
                                      variant="outline"
                                      className="h-8 gap-1 px-2 text-xs"
                                      disabled={busy}
                                      onClick={() =>
                                        updateWikiItemStatus(item, "done")
                                      }
                                      title="标记为已完成"
                                    >
                                      {busy ? (
                                        <Spinner size={12} />
                                      ) : (
                                        <RemixIcon name="check" size="size-3.5" />
                                      )}
                                      完成
                                    </Button>
                                  ) : null}
                                  {item.status !== "dismissed" ? (
                                    <Button
                                      variant="outline"
                                      className="h-8 gap-1 px-2 text-xs"
                                      disabled={busy}
                                      onClick={() =>
                                        updateWikiItemStatus(item, "dismissed")
                                      }
                                      title="忽略这条任务"
                                    >
                                      <RemixIcon name="close" size="size-3.5" />
                                      忽略
                                    </Button>
                                  ) : null}
                                  {item.status === "done" ||
                                  item.status === "dismissed" ? (
                                    <Button
                                      variant="outline"
                                      className="h-8 gap-1 px-2 text-xs"
                                      disabled={busy}
                                      onClick={() =>
                                        updateWikiItemStatus(item, "candidate")
                                      }
                                      title="恢复为待确认"
                                    >
                                      恢复
                                    </Button>
                                  ) : null}
                                </>
                              ) : null}

                              {item.kind === "memory" ? (
                                <>
                                  {item.status !== "confirmed" ? (
                                    <Button
                                      variant="outline"
                                      className="h-8 gap-1 px-2 text-xs"
                                      disabled={busy}
                                      onClick={() =>
                                        updateWikiItemStatus(item, "confirmed")
                                      }
                                      title="确认进入长期上下文"
                                    >
                                      {busy ? (
                                        <Spinner size={12} />
                                      ) : (
                                        <RemixIcon name="check" size="size-3.5" />
                                      )}
                                      确认
                                    </Button>
                                  ) : null}
                                  {item.status !== "dismissed" ? (
                                    <Button
                                      variant="outline"
                                      className="h-8 gap-1 px-2 text-xs"
                                      disabled={busy}
                                      onClick={() =>
                                        updateWikiItemStatus(item, "dismissed")
                                      }
                                      title="忽略这条记忆候选"
                                    >
                                      <RemixIcon name="close" size="size-3.5" />
                                      忽略
                                    </Button>
                                  ) : null}
                                </>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="min-h-[420px] rounded-md border border-border bg-background">
                  {selectedWikiItem ? (
                    <div className="flex h-full flex-col">
                      <div className="border-b border-border p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <RemixIcon
                              name={wikiKindIcon(selectedWikiItem.kind)}
                              size="size-5"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">
                                {wikiKindLabel(selectedWikiItem.kind)}
                              </Badge>
                              <Badge variant="secondary">
                                {selectedWikiItem.generatedBy}
                              </Badge>
                              <Badge variant="outline">
                                {memoryLifecycleLabel(selectedWikiItem)}
                              </Badge>
                            </div>
                            <h3 className="mt-2 text-base font-semibold leading-6">
                              {selectedWikiItem.title}
                            </h3>
                          </div>
                          <Button
                            variant="outline"
                            className="h-8 shrink-0 gap-1.5 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10"
                            disabled={
                              deletingWikiKey === wikiCardKey(selectedWikiItem)
                            }
                            onClick={() =>
                              deleteSelectedWikiItem(selectedWikiItem)
                            }
                            title="删除这条知识，不删除原始聊天消息"
                          >
                            {deletingWikiKey ===
                            wikiCardKey(selectedWikiItem) ? (
                              <Spinner size={12} />
                            ) : (
                              <RemixIcon name="delete_bin" size="size-3.5" />
                            )}
                            删除
                          </Button>
                        </div>
                      </div>

                      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                        <div>
                          <div className="mb-2 text-xs font-medium text-muted-foreground">
                            完整内容
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-6">
                            {selectedWikiItem.body || "暂无正文"}
                          </p>
                        </div>

                        {selectedWikiItem.kind === "note" || selectedWikiItem.kind === "task" ? (
                          <MemoryDependencyPanel entityKind={selectedWikiItem.kind === "note" ? "wiki_note" : "interaction_task"} entityId={selectedWikiItem.id} />
                        ) : null}

                        <div className="grid gap-2 sm:grid-cols-2">
                          {previewRows(selectedWikiItem).map(
                            ([label, value]) => (
                              <div
                                key={label}
                                className="rounded-md bg-muted/40 px-3 py-2"
                              >
                                <div className="text-xs text-muted-foreground">
                                  {label}
                                </div>
                                <div className="mt-1 break-words text-sm font-medium">
                                  {value}
                                </div>
                              </div>
                            ),
                          )}
                        </div>

                        {selectedWikiItem.sourceEventIds.length > 0 ? (
                          <div>
                            <div className="mb-2 text-xs font-medium text-muted-foreground">
                              原始证据
                            </div>
                            {isSelectedEvidenceLoading ? (
                              <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
                                <Spinner size={14} />
                                加载原始消息
                              </div>
                            ) : selectedEvidenceError ? (
                              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                                {selectedEvidenceError instanceof Error
                                  ? selectedEvidenceError.message
                                  : "加载原始证据失败"}
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {(selectedEvidence?.events ?? []).map(
                                  (event) => (
                                    <div
                                      key={event.id}
                                      className="rounded-md border border-border bg-background p-3"
                                    >
                                      <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant="secondary">
                                          {eventDirectionLabel(event.direction)}
                                        </Badge>
                                        <span className="text-sm font-medium">
                                          {eventSenderLabel(event)}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                          {event.conversationName}
                                        </span>
                                      </div>
                                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                                        {event.content ||
                                          event.contentPreview ||
                                          "无文本内容"}
                                      </p>
                                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                        <span>
                                          {formatDateTime(event.messageTime)}
                                        </span>
                                        <span>{event.contentType}</span>
                                        <span
                                          className="max-w-full truncate font-mono"
                                          title={event.id}
                                        >
                                          {event.id}
                                        </span>
                                      </div>
                                    </div>
                                  ),
                                )}
                                {selectedWikiItem.sourceEventIds
                                  .filter(
                                    (eventId) =>
                                      !(selectedEvidence?.events ?? []).some(
                                        (event) => event.id === eventId,
                                      ),
                                  )
                                  .map((eventId) => (
                                    <div
                                      key={eventId}
                                      className="truncate rounded-md bg-muted/40 px-2 py-1.5 font-mono text-xs text-muted-foreground"
                                      title={eventId}
                                    >
                                      未找到原始消息：{eventId}
                                    </div>
                                  ))}
                              </div>
                            )}
                          </div>
                        ) : null}

                        {selectedWikiItem.metadata &&
                        Object.keys(selectedWikiItem.metadata).length > 0 ? (
                          <div>
                            <div className="mb-2 text-xs font-medium text-muted-foreground">
                              元信息
                            </div>
                            <div className="space-y-1">
                              {Object.entries(selectedWikiItem.metadata).map(
                                ([key, value]) => (
                                  <div
                                    key={key}
                                    className="grid gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs sm:grid-cols-[120px_minmax(0,1fr)]"
                                  >
                                    <span className="text-muted-foreground">
                                      {key}
                                    </span>
                                    <span className="break-words">
                                      {formatMetadataValue(value) || "未记录"}
                                    </span>
                                  </div>
                                ),
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full min-h-[420px] items-center justify-center px-4 text-center text-sm text-muted-foreground">
                      选择一条成果后，可以在这里查看完整内容和全部来源事件。
                    </div>
                  )}
                </div>
              </div>
            </section>
          </>
        ) : activeView === "graph" ? (
          <section className="space-y-5">
            <div className="grid grid-cols-2 border-y border-border lg:grid-cols-4">
              <div className="border-b border-r border-border px-4 py-4 lg:border-b-0">
                <div className="text-xs text-muted-foreground">实体</div>
                <div className="mt-2 text-2xl font-semibold">
                  {graph?.stats.entityCount ?? 0}
                </div>
              </div>
              <div className="border-b border-border px-4 py-4 lg:border-b-0 lg:border-r">
                <div className="text-xs text-muted-foreground">关系</div>
                <div className="mt-2 text-2xl font-semibold">
                  {graph?.stats.relationCount ?? 0}
                </div>
              </div>
              <div className="border-r border-border px-4 py-4">
                <div className="text-xs text-muted-foreground">活跃关系</div>
                <div className="mt-2 text-2xl font-semibold">
                  {graph?.stats.activeRelationCount ?? 0}
                </div>
              </div>
              <div className="px-4 py-4">
                <div className="text-xs text-muted-foreground">证据</div>
                <div className="mt-2 text-2xl font-semibold">
                  {graph?.stats.evidenceCount ?? 0}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold">关系图谱</h2>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                  把微信和外部交互沉淀成“人、群、项目、风险、承诺”之间的关系。选中一条关系后，可以查看它来自哪些原始消息或已确认记忆。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 md:flex-none">
                  <RemixIcon
                    name="search"
                    size="size-4"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    name="memory-graph-search"
                    aria-label="搜索关系图谱"
                    autoComplete="off"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索人、项目、关系…"
                    className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 md:w-64"
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => mutateGraph()}
                  disabled={isGraphLoading}
                  aria-label="刷新关系图谱"
                  title="刷新关系图谱"
                >
                  <RemixIcon name="refresh" size="size-4" />
                </Button>
              </div>
            </div>

            {isGraphLoading ? (
              <div className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-16 text-sm text-muted-foreground">
                <Spinner size={16} />
                加载关系图谱
              </div>
            ) : graphView.relations.length === 0 ? (
              <div className="rounded-md border border-border bg-card px-4 py-16 text-center text-sm leading-6 text-muted-foreground">
                还没有可视化关系。后台处理新微信消息、确认长期上下文后，实体和关系会出现在这里。
              </div>
            ) : (
              <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
                <aside className="min-w-0 space-y-4">
                  <div className="rounded-md border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-base font-semibold">核心实体</h3>
                      <Badge variant="outline">
                        {graphView.topEntities.length}
                      </Badge>
                    </div>
                    <div className="mt-3 max-h-[520px] space-y-2 overflow-y-auto pr-1">
                      {graphView.topEntities.map((entity) => (
                        <button
                          key={entity.id}
                          type="button"
                          onClick={() => setQuery(entity.name)}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-left outline-none transition hover:border-primary/50 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-primary/30"
                          title={`搜索 ${entity.name}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-sm font-medium">
                              {entity.name}
                            </span>
                            <Badge variant="secondary">
                              {entity.degree}
                            </Badge>
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span>{entityTypeLabel(entity.entityType)}</span>
                            <span>{formatDateTime(entity.lastSeenAt)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-md border border-border bg-card p-4">
                    <h3 className="text-base font-semibold">关系类型</h3>
                    <div className="mt-3 space-y-2">
                      {Object.entries(graphView.relationTypeCounts).map(
                        ([label, count]) => (
                          <div
                            key={label}
                            className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm"
                          >
                            <span>{label}</span>
                            <span className="font-medium tabular-nums">
                              {count}
                            </span>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                </aside>

                <div className="min-w-0 rounded-md border border-border bg-card">
                  <div className="flex flex-col gap-1 border-b border-border p-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="text-base font-semibold">关系流</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {graphView.filteredRelations.length} /{" "}
                        {graphView.relationRows.length} 条关系
                      </p>
                    </div>
                    {query.trim() ? (
                      <Button
                        variant="outline"
                        className="h-8 gap-1 px-2 text-xs"
                        onClick={() => setQuery("")}
                      >
                        <RemixIcon name="close" size="size-3.5" />
                        清除筛选
                      </Button>
                    ) : null}
                  </div>

                  {graphView.filteredRelations.length === 0 ? (
                    <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                      没有匹配的关系。
                    </div>
                  ) : (
                    <div className="max-h-[720px] divide-y divide-border overflow-y-auto">
                      {graphView.filteredRelations.map((item) => {
                        const selected =
                          item.relation.id === selectedGraphRelationId;
                        return (
                          <button
                            key={item.relation.id}
                            type="button"
                            onClick={() =>
                              setSelectedGraphRelationId(item.relation.id)
                            }
                            aria-pressed={selected}
                            className={cn(
                              "grid w-full gap-3 p-4 text-left outline-none transition md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
                              selected ? "bg-primary/5" : "bg-background",
                              "hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-primary/30",
                            )}
                          >
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold">
                                {item.subject.name}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {entityTypeLabel(item.subject.entityType)}
                              </div>
                            </div>
                            <div className="flex items-center justify-start gap-2 md:justify-center">
                              <span className="h-px w-8 bg-border" />
                              <Badge variant="outline">
                                {relationTypeLabel(item.relation.relationType)}
                              </Badge>
                              <span className="h-px w-8 bg-border" />
                            </div>
                            <div className="min-w-0 md:text-right">
                              <div className="truncate text-sm font-semibold">
                                {item.object.name}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {entityTypeLabel(item.object.entityType)}
                              </div>
                            </div>
                            <div className="min-w-0 md:col-span-3">
                              <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                                {item.relation.claim}
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <Badge variant="secondary">
                                  置信 {item.relation.confidence}%
                                </Badge>
                                <Badge variant="outline">
                                  证据 {item.evidence.length}
                                </Badge>
                                <span>
                                  更新 {formatDateTime(item.relation.updatedAt)}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <aside className="min-w-0 rounded-md border border-border bg-card">
                  {selectedGraphRelation ? (
                    <div className="flex h-full min-h-[520px] flex-col">
                      <div className="border-b border-border p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            {relationTypeLabel(
                              selectedGraphRelation.relation.relationType,
                            )}
                          </Badge>
                          <Badge variant="secondary">
                            {statusLabel(selectedGraphRelation.relation.status)}
                          </Badge>
                          <Badge variant="outline">
                            {selectedGraphRelation.relation.confidence}%
                          </Badge>
                        </div>
                        <h3 className="mt-3 text-base font-semibold leading-6">
                          {selectedGraphRelation.subject.name} →{" "}
                          {selectedGraphRelation.object.name}
                        </h3>
                      </div>

                      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                        <div>
                          <div className="mb-2 text-xs font-medium text-muted-foreground">
                            关系结论
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-6">
                            {selectedGraphRelation.relation.claim}
                          </p>
                        </div>

                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                          <div className="rounded-md bg-muted/40 px-3 py-2">
                            <div className="text-xs text-muted-foreground">
                              主体
                            </div>
                            <div className="mt-1 break-words text-sm font-medium">
                              {selectedGraphRelation.subject.name}
                            </div>
                          </div>
                          <div className="rounded-md bg-muted/40 px-3 py-2">
                            <div className="text-xs text-muted-foreground">
                              客体
                            </div>
                            <div className="mt-1 break-words text-sm font-medium">
                              {selectedGraphRelation.object.name}
                            </div>
                          </div>
                          <div className="rounded-md bg-muted/40 px-3 py-2">
                            <div className="text-xs text-muted-foreground">
                              证据强度
                            </div>
                            <div className="mt-1 break-words text-sm font-medium">
                              {selectedGraphRelation.relation.evidenceStrength}
                            </div>
                          </div>
                          <div className="rounded-md bg-muted/40 px-3 py-2">
                            <div className="text-xs text-muted-foreground">
                              最近更新
                            </div>
                            <div className="mt-1 break-words text-sm font-medium">
                              {formatDateTime(
                                selectedGraphRelation.relation.updatedAt,
                              )}
                            </div>
                          </div>
                        </div>

                        <div>
                          <div className="mb-2 text-xs font-medium text-muted-foreground">
                            证据
                          </div>
                          {selectedGraphRelation.evidence.length > 0 ? (
                            <div className="space-y-2">
                              {selectedGraphRelation.evidence.map((item) => (
                                <div
                                  key={item.id}
                                  className="rounded-md border border-border bg-background p-3"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant="secondary">
                                      {evidenceSourceLabel(item.sourceType)}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground">
                                      {formatDateTime(item.createdAt)}
                                    </span>
                                  </div>
                                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                                    {item.quote || "未记录引用内容"}
                                  </p>
                                  <div
                                    className="mt-2 truncate font-mono text-xs text-muted-foreground"
                                    title={item.sourceId}
                                  >
                                    {item.sourceId}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-md bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
                              这条关系暂无证据记录。
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-h-[520px] items-center justify-center px-4 text-center text-sm text-muted-foreground">
                      选择一条关系后，可以查看完整结论和证据。
                    </div>
                  )}
                </aside>
              </div>
            )}
          </section>
        ) : (
          <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-3">
              <div className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-end md:justify-between">
                <div>
                  <h2 className="text-base font-semibold">微信来源</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    选择哪些微信会话可以进入主人知识库。未选择来源时，系统不会同步任何聊天。
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-0 flex-1 md:flex-none">
                    <RemixIcon
                      name="search"
                      size="size-4"
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <input
                      name="wechat-source-search"
                      aria-label="搜索微信会话"
                      autoComplete="off"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索会话…"
                      className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 md:w-56"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => mutate()}
                    disabled={isLoading}
                    aria-label="刷新来源"
                  >
                    <RemixIcon name="refresh" size="size-4" />
                  </Button>
                  <Button
                    className="h-9 gap-2 px-3 text-sm"
                    onClick={recordWechatMessages}
                    disabled={recordingWechat || counts.enabled === 0}
                    title={
                      counts.enabled === 0
                        ? "先选择至少一个可同步来源"
                        : "按当前来源策略手动补跑微信新消息"
                    }
                  >
                    {recordingWechat ? (
                      <Spinner size={14} />
                    ) : (
                      <RemixIcon name="download_cloud_2" size="size-4" />
                    )}
                    手动补跑
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-md border border-border bg-card">
                <div className="hidden min-w-[820px] grid-cols-[48px_minmax(220px,1fr)_80px_70px_110px_180px] border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
                  <div>选择</div>
                  <div>会话</div>
                  <div>类型</div>
                  <div>未读</div>
                  <div>最近</div>
                  <div>策略</div>
                </div>
                {isLoading ? (
                  <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                    <Spinner size={16} />
                    加载微信来源
                  </div>
                ) : filteredSources.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    暂无可配置来源
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {pagedSources.map((source) => (
                      <div key={source.sourceId}>
                        <div className="space-y-3 px-3 py-4 md:hidden">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {source.sourceName}
                            </span>
                            <Badge variant="outline">
                              {sourceTypeLabel(source.sourceType)}
                            </Badge>
                          </div>
                          <div className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                            {source.lastMessagePreview || source.sourceId}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>未读 {source.unread}</span>
                            <span>
                              最近 {formatDateTime(source.lastMessageAt)}
                            </span>
                            <span>
                              {source.configured ? "已设置" : "未设置"}
                            </span>
                          </div>
                          <label className="flex items-center gap-2 text-sm font-medium">
                            <input
                              type="checkbox"
                              checked={canEnterPipeline(source)}
                              disabled={savingSourceId === source.sourceId}
                              onChange={(event) =>
                                updateSourceSelection(
                                  source,
                                  event.target.checked,
                                )
                              }
                            />
                            选择此联系人
                          </label>
                          <SourcePolicySelect
                            source={source}
                            saving={savingSourceId === source.sourceId}
                            idSuffix="mobile"
                            showLabel
                            fullWidth
                            onChange={updateSourcePolicy}
                          />
                        </div>

                        <div className="hidden min-w-[820px] grid-cols-[48px_minmax(220px,1fr)_80px_70px_110px_180px] items-center gap-0 px-4 py-3 md:grid">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${source.sourceName}`}
                            checked={canEnterPipeline(source)}
                            disabled={savingSourceId === source.sourceId}
                            onChange={(event) =>
                              updateSourceSelection(
                                source,
                                event.target.checked,
                              )
                            }
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {source.sourceName}
                              </span>
                              {source.configured ? (
                                <Badge variant="outline">已设置</Badge>
                              ) : (
                                <Badge variant="secondary">未设置</Badge>
                              )}
                            </div>
                            <div className="mt-1 truncate text-xs text-muted-foreground">
                              {source.lastMessagePreview || source.sourceId}
                            </div>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {sourceTypeLabel(source.sourceType)}
                          </div>
                          <div className="text-sm">{source.unread}</div>
                          <div className="text-sm text-muted-foreground">
                            {formatDateTime(source.lastMessageAt)}
                          </div>
                          <SourcePolicySelect
                            source={source}
                            saving={savingSourceId === source.sourceId}
                            idSuffix="desktop"
                            onChange={updateSourcePolicy}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {filteredSources.length > 0 ? (
                  <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      {sourceRangeStart}-{sourceRangeEnd} /{" "}
                      {filteredSources.length} · 每页 {SOURCE_PAGE_SIZE}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        className="h-8 gap-1 px-2 text-xs"
                        disabled={currentSourcePage <= 1}
                        onClick={() =>
                          setSourcePage(Math.max(1, currentSourcePage - 1))
                        }
                      >
                        <RemixIcon name="arrow_left_s" size="size-4" />
                        上一页
                      </Button>
                      <span className="min-w-16 text-center text-xs">
                        {currentSourcePage} / {totalSourcePages}
                      </span>
                      <Button
                        variant="outline"
                        className="h-8 gap-1 px-2 text-xs"
                        disabled={currentSourcePage >= totalSourcePages}
                        onClick={() =>
                          setSourcePage(
                            Math.min(totalSourcePages, currentSourcePage + 1),
                          )
                        }
                      >
                        下一页
                        <RemixIcon name="arrow_right_s" size="size-4" />
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <aside className="space-y-3">
              <div className="rounded-md border border-border bg-card p-4">
                <h2 className="text-base font-semibold">同步规则</h2>
                <div className="mt-3 space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">运行方式</span>
                    <Badge variant="secondary">手动同步</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">默认范围</span>
                    <span>最近会话</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">白名单优先</span>
                    <span>开启</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">忽略折叠会话</span>
                    <span>开启</span>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold">候选知识</h2>
                  <Badge variant="outline">{candidateCount}</Badge>
                </div>
                <div className="mt-3 space-y-2">
                  {wiki?.memories?.slice(0, 4).map((memory) => (
                    <div
                      key={memory.id}
                      className="border-l-2 border-[var(--product-jade)] py-1 pl-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {memory.subject}
                        </span>
                        <Badge variant="secondary">
                          {statusLabel(memory.status)}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {memory.content}
                      </p>
                    </div>
                  ))}
                  {!wiki || wiki.memories.length === 0 ? (
                    <p className="text-sm leading-6 text-muted-foreground">
                      微信消息处理后，会在这里出现待确认的长期知识。
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="rounded-md border border-border bg-card p-4">
                <h2 className="text-base font-semibold">最近摘要</h2>
                <div className="mt-3 space-y-2">
                  {wiki?.notes?.slice(0, 4).map((note) => (
                    <div
                      key={note.id}
                      className="border-l-2 border-[var(--product-cobalt)] py-1 pl-3"
                    >
                      <div className="truncate text-sm font-medium">
                        {note.title}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {note.body}
                      </p>
                    </div>
                  ))}
                  {!wiki || wiki.notes.length === 0 ? (
                    <p className="text-sm leading-6 text-muted-foreground">
                      沉淀流程生成摘要或页面更新后，会出现在这里。
                    </p>
                  ) : null}
                </div>
              </div>
            </aside>
          </section>
        )}
      </div>
    </main>
  );
}
