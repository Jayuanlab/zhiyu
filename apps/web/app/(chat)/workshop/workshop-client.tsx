"use client";
import { BrainRecallRetryDetails } from '@/components/brain-recall-retry-details';
import { latestWorkshopConclusion } from '@/lib/workshops/conclusion';
import type { WorkPresentationV1 } from '@/lib/workshops/work-presentation';
import { WorkPresentationArea } from './work-presentation-area';
import { WorkConversation } from './work-conversation';
import { ReviewDecisionDesk } from './review-decision-desk';
import { buildReviewAssistantItem } from '@/lib/workshops/review-assistant';
import { RuntimeStatusPanel } from '@/components/runtime-status-panel';
import {createWorkCommandClient, type PendingWorkRequest} from '@/lib/work-runtime/client-command';
import { workshopApiErrorMessage } from '@/lib/workshops/api-error-message';
import { loopExecutionView } from '@/lib/workshops/loop-execution-view';
import {refreshDraft,editDraft,acceptDraft,type VersionedDraft} from '@/lib/work-runtime/versioned-draft';
import { mergeDashboardSummary, isOlderProjection } from "@/lib/workshops/projection-view";
import {canDismissOutbox,isOutboxLocked,isOutboxUnsettled,outboxStatusLabel} from '@/lib/workshops/outbox-view';
import {OutboxResolutionPanel} from './outbox-resolution-panel';
import {RunReviewPanel} from './run-review-panel';
import {useWorkshopLocation,type WorkshopTab} from './use-workshop-location';
import {useWorkshopTextDrafts} from './use-workshop-text-drafts';
import {useWorkshopReviewLocation} from './use-workshop-review-location';
import {useWorkshopReads} from './use-workshop-reads';
import {CollaborationPanel} from './collaboration-panel';
import {OwnerTeamRoster, OwnerEmployeeStatus} from './owner-workview';
import type {OwnerWorkOverviewResponse} from '@/lib/workshops/owner-overview';

import { RemixIcon } from "@/components/remix-icon";
import { Markdown } from "@/components/markdown";
import { PanelState } from "@/components/workbench/panel-state";
import { EmptyState } from "@/components/workbench/empty-state";
import { cn } from "@/lib/utils";
import { HarnessEvolutionPanel } from "./harness-evolution-panel";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@openzhiyu/ui";
import {
  getWorkshopBoundaryPolicy,
  parseRecipientList,
  serializeWorkshopBoundaryPolicy,
  type WorkshopBoundaryMode,
  type WorkshopBoundaryPolicy,
  type WorkshopExternalMessagePolicy,
} from "@/lib/workshops/boundary-policy";
import { workDisplayLabel } from "@/lib/workshops/display-labels";
import {
  getWorkshopLiveRefreshPlan,
  type WorkshopLiveRefreshPanel,
  type WorkshopLiveRefreshPlan,
} from "@/lib/workshops/live-refresh-policy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {RunHistoryView} from "./run-history-view";
import {useWorkshopRunHistory} from "@/hooks/use-workshop-run-history";
import type {WorkshopEvent} from "@/lib/workshops/run-history-types";

type Workshop = {
  id: string;
  name: string;
  mission: string;
  status: string;
  autonomyLevel: WorkshopBoundaryMode;
  boundaryPolicy: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  updatedAt: string;
  createdAt: string;
};

type WorkshopPageState = {
  workshops: WorkshopPageStateItem[];
  selectedWorkshopId: string | null;
  meta: {
    generatedAt: string;
    hit: boolean;
    stale: boolean;
    refreshing: boolean;
    warnings: string[];
  };
};

type WorkshopPageStateItem = {
    id: string;
    workshop: Workshop;
    name?: string;
    mission?: string;
    status?: string;
    updatedAt?: string;
    summary: {
      attentionCount?: number | null;
      activeLoops: number;
      pendingApprovals: number;
      blockedLoops: number;
      pendingOutbox: number;
      latestEventTitle: string | null;
      latestConclusion?: WorkshopEvent | null;
      latestEventBody?: string | null;
      latestEventAt?: string | null;
      nextWorkAt: string | null;
    };
    cache: {
      hit: boolean;
      stale: boolean;
      refreshing: boolean;
      warning?: string;
    };
};


type WorkshopReviewItem = {
  id: string;
  workshopId: string;
  sourceEventId: string | null;
  kind: string;
  status: "pending" | "approved" | "rejected" | "dismissed" | "superseded";
  title: string;
  summary: string | null;
  riskLevel: "low" | "medium" | "high" | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

type WorkshopReviewItemsResponse = {
  items: WorkshopReviewItem[];
};

type WorkshopAgentChangeAction = "apply" | "reject" | "recreate";

type WorkshopSource = {
  id: string;
  type: string;
  name: string;
  uri: string | null;
  content: string | null;
  enabled: boolean;
  createdAt: string;
};

type WorkshopMemory = {
  id: string;
  kind: string;
  content: string;
  confidence: number;
  tags: string[];
  createdAt: string;
  status?: string;
  sourceEventIds?: string[];
  canonical?: {
    kind?: string;
    groupId?: string;
    facets?: Record<string, unknown>;
    derivedRefs?: unknown[];
    admission?: Record<string, unknown> | null;
  } | null;
};

type WorkshopLoop = {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  status: string;
  updatedAt: string;
  createdAt: string;
};

type WorkshopDashboardLoop = {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  dashboardStatus: string;
  status: string;
  triggerConfig: Record<string, unknown>;
  currentPhase: string | null;
  nextAction: string | null;
  blockedReason: string | null;
  lastObservation: string | null;
  stateJson: Record<string, unknown>;
  nextScheduledRunAt: string | null;
  schedulerStatus: string | null;
  spaceSummary?: {
    triggerLabel: string;
    contextLabel?: string;
    permissionLabel: string;
    deliveryLabel: string | null;
    externalWriteMode?: string;
  };
  latestRun: {
    id?: string;
    status: string;
    startedAt?: string;
    completedAt?: string | null;
    outputSummary: string | null;
    error: string | null;
    verificationPassed?: boolean | null;
    checkerAction?: string | null;
    checkerType?: string | null;
    requiresApproval: boolean;
    denied?: boolean;
    actionGuardMode?: string | null;
    actionGuardBlocked: boolean;
    modelCheckerEnabled?: boolean;
    modelCheckerReason?: string | null;
    executionTrace?: {
      events: Array<{
        type: string;
        title: string;
        detail: string | null;
        toolName: string | null;
        status: string | null;
        timestamp: string | null;
        metadata?: Record<string, unknown>;
        runtimeSnapshot?: {
          engine: string;
          adapter: string;
          model: string;
          modelTier: string;
          runtimeHash: string;
          policyHash: string;
          allowedToolCount: number;
          extra?: unknown | null;
        } | null;
      }>;
      toolCallCount: number;
      failedToolCallCount: number;
      permissionDecisionCount: number;
      durationMs: number | null;
    };
  } | null;
};

type WorkshopLoopRun = NonNullable<WorkshopDashboardLoop["latestRun"]>;

type WorkshopOutbox = {
  updatedAt?: string;
  id: string;
  runId: string | null;
  channel: string;
  recipientName: string | null;
  message: string;
  status: string;
  confidence: number;
  riskLevel: string;
  boundaryResult: Record<string, unknown>;
  createdAt: string;
};

type DouyinDraftSummary = {
  id: string;
  title: string;
  status: string;
  description?: string | null;
  topics?: string[];
  video_path: string;
  cover_path?: string | null;
  scheduled_at?: string | null;
  ai_generated?: boolean;
  account_label?: string | null;
  source?: Record<string, unknown>;
  updated_at: string;
};

type DouyinDraftListResponse = {
  ok: boolean;
  drafts: DouyinDraftSummary[];
  error?: string;
};

type InteractionEvent = {
  id: string;
  platform: string;
  source: string;
  conversationId: string | null;
  conversationName: string;
  conversationType: string;
  senderName: string | null;
  senderDisplayName: string | null;
  direction: string;
  contentType: string;
  contentPreview: string;
  messageTime: string;
  collectedAt: string;
  processedStatus: string;
  importance: string;
};

type InteractionNote = {
  id: string;
  noteType: string;
  title: string;
  body: string;
  confidence: number;
  sourceEventIds: string[];
  createdAt: string;
};

type InteractionTask = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueAt: string | null;
  confidence: number;
  sourceEventIds: string[];
  createdAt: string;
};

type InteractionMemory = {
  id: string;
  memoryType: string;
  subject: string;
  content: string;
  status: string;
  confidence: number;
  tags: string[];
  sourceEventIds: string[];
  createdAt: string;
};

type InteractionWiki = {
  notes: InteractionNote[];
  tasks: InteractionTask[];
  memories: InteractionMemory[];
};

type WorkshopLoopApprovalRequest = {
  id: string;
  loopId: string;
  loopRunId: string | null;
  status: string;
  source: string;
  actionName: string;
  capability: string | null;
  reason: string | null;
  message: string | null;
  actionPayload?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  resolutionNote?: string | null;
};

type WorkshopMemoryRecallSummary = {
  eventId: string;
  createdAt: string;
  backend: string;
  contextLogId: string | null;
  recallPlan: unknown;
  explanation: unknown;
  contextPack: unknown;
  routeResults: unknown;
  fallbackReason: string | null;
  error: string | null;
};

type WorkshopLoopDetail = {
  loop: WorkshopDashboardLoop & {
    contextConfig?: Record<string, unknown>;
    actionPolicy?: Record<string, unknown>;
    verificationConfig?: Record<string, unknown>;
    approvalPolicy?: Record<string, unknown>;
    retryPolicy?: Record<string, unknown>;
    escalationPolicy?: Record<string, unknown>;
    runs: WorkshopLoopRun[];
  };
  events: WorkshopEvent[];
  memoryRecall: WorkshopMemoryRecallSummary[];
  approvalRequests: WorkshopLoopApprovalRequest[];
  outbox: WorkshopOutbox[];
};

type WorkshopHeartbeat = {
  workshopId: string;
  enabled: boolean;
  mode: string;
  nextWakeupAt: string | null;
  lastWakeupAt: string | null;
  lastHeartbeatAt: string | null;
  schedulerStatus: string;
  schedulerError: string | null;
  consecutiveFailures: number;
  leaseUntil: string | null;
  heartbeatPolicy: Record<string, unknown>;
};

type WorkshopDashboard = {
  projection?: { asOf: string; version: string; eventCursor: number };
  status: string;
  counts: {
    loops: number;
    activeLoops: number;
    pendingLoopProposals: number;
    pendingOutbox: number;
    pendingApprovals: number;
    outboxDrafts?: number;
    outboxReady?: number;
    outboxBlocked?: number;
    attentionCount?: number;
    blockedLoops: number;
    errorLoops: number;
    sources: number;
    memories: number;
    directives: number;
  };
  nextWork: {
    source: "heartbeat" | "loop" | null;
    at: string | null;
    label: string;
  };
  contextCost?: {
    recentReportCount: number;
    estimatedInputCostUsd: number | null;
    avgEstimatedPromptTokens: number | null;
    latestRuntime: {
      eventId: string;
      createdAt: string;
      engine: string;
      adapter: string | null;
      source: string | null;
      piProtocol: string | null;
      model: string | null;
      modelTier: string | null;
      modelSource: string | null;
      runtimeHash: string | null;
      promptHash: string | null;
      allowedToolsHash: string | null;
      policyHash: string | null;
      allowedToolCount: number | null;
    } | null;
    latestReport: {
      eventId: string;
      createdAt: string;
      profile: string | null;
      modelTier: string | null;
      modelSource: string | null;
      model: string | null;
      toolProfile: string | null;
      promptChars: number | null;
      estimatedPromptTokens: number | null;
      estimatedInputCostUsd: number | null;
    } | null;
    largestSection: {
      name: string;
      chars: number;
      estimatedTokens: number;
    } | null;
    profileCounts: Record<string, number>;
    runtimeEngineCounts: Record<string, number>;
    modelTierCounts: Record<string, number>;
    toolProfileCounts: Record<string, number>;
    sectionStats: Array<{
      name: string;
      reportCount: number;
      totalChars: number;
      avgChars: number;
      maxChars: number;
      avgEstimatedTokens: number;
      maxEstimatedTokens: number;
      overBudgetCount: number;
      latestChars: number | null;
      latestEstimatedTokens: number | null;
      latestOverBudget: boolean | null;
      latestPromptShare: number | null;
    }>;
  };
  recentFinding: WorkshopEvent | null;
  latestEvent: WorkshopEvent | null;
  latestConclusion?: WorkshopEvent | null;
  pendingOutbox: WorkshopOutbox[];
  pendingLoopProposals: WorkshopDashboardLoop[];
  blockedLoops: WorkshopDashboardLoop[];
  loops: WorkshopDashboardLoop[];
};

type HeartbeatPolicyForm = {
  enabled: boolean;
  allowAgentSuggestedWakeup: boolean;
  minIntervalMinutes: number;
  defaultDelayMinutes: number;
  maxIntervalMinutes: number;
  missedRunGraceMinutes: number;
  leaseMinutes: number;
  maxConsecutiveFailures: number;
};

type WorkshopDetail = {
  commandVersion?: number;
  workshop: Workshop;
  heartbeat: WorkshopHeartbeat | null;
  loops: WorkshopLoop[];
  events: WorkshopEvent[];
  sources: WorkshopSource[];
  memories: WorkshopMemory[];
  outbox: WorkshopOutbox[];
  dashboard: WorkshopDashboard | null;
};

type WorkLogSnapshot = {
  workshopId: string;
  events: WorkshopEvent[];
};

type AgentWorkStep = {
  id: string;
  title: string;
  reason: string;
  dataSources: string[];
  result: string | null;
  evidenceEvents: WorkshopEvent[];
};

type AgentThoughtStep = {
  id: string;
  summary: string;
  description: string | null;
  sourceLabel: string | null;
  stepType: string | null;
};

type AgentWorkRecord = {
  id: string;
  runLabel: string;
  startedAt: string | null;
  latestRecordedAt: string | null;
  goal: string;
  currentState: string[];
  questions: string[];
  thoughtSteps: AgentThoughtStep[];
  steps: AgentWorkStep[];
  reasoningSummary: string | null;
  conclusion: string | null;
  actions: string[];
  ownerAttention: string | null;
  nextFocus: string[];
  evidenceSources: string[];
  rawEvents: WorkshopEvent[];
};

type WorkLogTimelineItem = {
  id: string;
  seqLabel: string;
  title: string;
  label: string;
  createdAt: string;
  body: string | null;
  status: "default" | "completed" | "error" | "running";
};

type RunningWorkflow = {
  id: string;
  loopName: string;
  startedAt: string | null;
  events: WorkshopEvent[];
};

type MemoryRecallQualityReport = {
  summary: {
    recallCount: number;
    emptyRecallCount: number;
    emptyRecallRate: number;
    selectedMemoryCount: number;
    deniedMemoryCount: number;
    omittedMemoryCount: number;
    duplicateCanonicalGroupCount: number;
    feedbackCount: number;
  };
  plannerModeCounts: Record<string, number>;
  routeUsage: Array<{ route: string; count: number }>;
  feedbackOutcomes: Record<string, number>;
  traceQuality?: {
    traceCount: number;
    selectedMemoryCount: number;
    omittedMemoryCount: number;
    deniedMemoryCount: number;
    noEvidenceSelectedCount: number;
    warningCount: number;
    topSelectedMemoryTypes: Array<{ value: string; count: number }>;
    topSelectedCanonicalKinds: Array<{ value: string; count: number }>;
    topSelectedReasons: Array<{ value: string; count: number }>;
    topOmittedReasons: Array<{ value: string; count: number }>;
    topDeniedReasons: Array<{ value: string; count: number }>;
    topOmittedMemoryIds: Array<{ value: string; count: number }>;
    topDeniedMemoryIds: Array<{ value: string; count: number }>;
  };
  traceQualityByRequester?: Array<{
    requesterType: string;
    requesterId: string | null;
    issueScore: number;
    traceCount: number;
    selectedMemoryCount: number;
    omittedMemoryCount: number;
    deniedMemoryCount: number;
    noEvidenceSelectedCount: number;
    warningCount: number;
    topOmittedReasons: Array<{ value: string; count: number }>;
    topDeniedReasons: Array<{ value: string; count: number }>;
    topSelectedReasons: Array<{ value: string; count: number }>;
  }>;
  traceQualityByLoop?: Array<{
    workshopId: string | null;
    loopId: string | null;
    issueScore: number;
    traceCount: number;
    selectedMemoryCount: number;
    omittedMemoryCount: number;
    deniedMemoryCount: number;
    noEvidenceSelectedCount: number;
    warningCount: number;
    topOmittedReasons: Array<{ value: string; count: number }>;
    topDeniedReasons: Array<{ value: string; count: number }>;
    topSelectedReasons: Array<{ value: string; count: number }>;
  }>;
  traceQualityByRun?: Array<{
    workshopId: string | null;
    loopId: string | null;
    runId: string | null;
    loopRunId: string | null;
    issueScore: number;
    traceCount: number;
    selectedMemoryCount: number;
    omittedMemoryCount: number;
    deniedMemoryCount: number;
    noEvidenceSelectedCount: number;
    warningCount: number;
    topOmittedReasons: Array<{ value: string; count: number }>;
    topDeniedReasons: Array<{ value: string; count: number }>;
    topSelectedReasons: Array<{ value: string; count: number }>;
  }>;
  feedbackTraceDiagnosticsByLoop?: Array<{
    workshopId: string | null;
    loopId: string | null;
    feedbackCount: number;
    diagnosticScore: number;
    feedbackOutcomes: Record<string, number>;
    traceQuality: {
      traceCount: number;
      noEvidenceSelectedCount: number;
      warningCount: number;
      topOmittedReasons: Array<{ value: string; count: number }>;
      topDeniedReasons: Array<{ value: string; count: number }>;
      topSelectedReasons: Array<{ value: string; count: number }>;
    };
  }>;
  feedbackTraceDiagnosticsByRun?: Array<{
    workshopId: string | null;
    loopId: string | null;
    runId: string | null;
    loopRunId: string | null;
    feedbackCount: number;
    diagnosticScore: number;
    feedbackOutcomes: Record<string, number>;
    traceQuality: {
      traceCount: number;
      noEvidenceSelectedCount: number;
      warningCount: number;
      topOmittedReasons: Array<{ value: string; count: number }>;
      topDeniedReasons: Array<{ value: string; count: number }>;
      topSelectedReasons: Array<{ value: string; count: number }>;
    };
  }>;
  period: {
    days: number;
    since: string;
    generatedAt: string;
  };
  coverage: {
    workshops: number;
    contextLogs: number;
    feedbackEvents: number;
    contextTraceEvents?: number;
    interpretation: string;
  };
};

type AgentToolAvailability =
  | "allow"
  | "require_approval"
  | "deny"
  | "chat_only"
  | "workshop_only"
  | "loop_only"
  | "disabled"
  | "unknown";

type AgentToolSource =
  | "claude_builtin"
  | "pi_builtin"
  | "business_tools"
  | "workshop_tools"
  | "skill"
  | "user_mcp";

type AgentToolRisk = "low" | "medium" | "high" | "critical";

type AgentToolConfirmation = {
  surface:
    | "chat_confirm"
    | "workshop_task_tab"
    | "workshop_outbox_tab"
    | "workshop_review_tab"
    | "loop_approval"
    | "boundary_policy";
  label: string;
  description: string;
};

type AgentToolMatrixItem = {
  id: string;
  name: string;
  displayName: string;
  source: AgentToolSource;
  serverName?: string;
  description: string;
  capabilities: string[];
  risk: AgentToolRisk;
  runtimeScopes: string[];
  availability: AgentToolAvailability;
  decisionReason: string;
  confirmation?: AgentToolConfirmation;
  effectivePolicy?: Record<string, unknown>;
};

type AgentToolMatrixResponse = {
  runtime: string;
  workshopId?: string;
  generatedAt: string;
  tools: AgentToolMatrixItem[];
  counts: {
    total: number;
    allow: number;
    requireApproval: number;
    deny: number;
    disabled: number;
    unknown: number;
    bySource: Record<AgentToolSource, number>;
    byRisk: Record<AgentToolRisk, number>;
  };
};

type WorkshopWorkModel = {
  manifest: {
    id: string;
    name: string;
    role: string;
    mission: string;
    status: string;
    autonomyLevel: string;
    version: string;
    updatedAt: string;
  };
  controlContract: {
    controlledObjects: string[];
    observations: string[];
    allowedActions: string[];
    approvalRequiredActions: string[];
    deniedActions: string[];
    boundaryMode: string;
    externalMessagePolicy: string;
    feedbackSignals: string[];
    conflicts: Array<{ kind: string; tool: string }>;
  };
  skillBindings: {
    primarySkills: string[];
    loopSkillMap: Record<string, string>;
    availableSkills: string[];
    missingSkills: string[];
  };
  loopBindings: Array<{
    id: string;
    name: string;
    status: string;
    triggerType: string;
    nextScheduledRunAt: string | null;
    requiredFields: string[];
    skillName: string | null;
    skillStatus: "bound" | "missing" | "unmapped";
    hasActionPolicy: boolean;
    hasVerification: boolean;
  }>;
  memoryPolicy: {
    defaultReadableKinds: string[];
    evidenceRequiredForHighImpact: boolean;
    writeReusableFindingsToMemory: boolean;
  };
  artifactPolicy: {
    eventTypes: string[];
    proposalTypes: string[];
    outboxEnabled: boolean;
  };
  presentationContract: {
    audience: "owner";
    reportFormat: "markdown";
    purpose: string;
    requiredSections: string[];
    expectedArtifacts: string[];
    evidenceSource: "run_events";
    artifactSource: "run_receipts";
    statusSource: "run_lifecycle";
    source: "manifest" | "default";
  };
  feedback: {
    nextWakeupAt: string | null;
    heartbeatStatus: string | null;
    pendingReviewSurfaces: string[];
    feedbackSignals: string[];
  };
  observability: {
    missing: string[];
    warnings: string[];
  };
  runtime: {
    engine: "claude" | "pi";
    source: "config" | "env" | "default";
    piGreyReadiness: {
      schemaVersion: "workshop-pi-runtime-grey-readiness.v1";
      requested: boolean;
      eligible: boolean;
      status:
        | "not_requested"
        | "eligible"
        | "needs_tool_migration"
        | "blocked";
      summary: {
        schemaVersion: "workshop-runtime-tool-classification.v1";
        total: number;
        counts: Record<
          "read" | "internal_write" | "proposal" | "external_effect" | "high_risk",
          number
        >;
        decisions: Record<"allow" | "require_approval" | "deny", number>;
      };
      allowedTools: string[];
      migratedWriteTools: string[];
      policyScopedMigratedWriteTools: string[];
      needsMigrationTools: Array<{
        toolName: string;
        risk: string;
        reason: string;
      }>;
      blockedTools: Array<{
        toolName: string;
        risk: string;
        reason: string;
      }>;
      reasons: string[];
      nextSteps: Array<{
        code:
          | "request_pi_runtime"
          | "run_isolated_grey"
          | "migrate_tools"
          | "remove_or_split_blocked_tools";
        label: string;
        detail: string;
        toolNames?: string[];
      }>;
    };
  };
  changeControl: {
    proposalSurface: "workshop_review_tab";
    highRiskChanges: string[];
    mediumRiskChanges: string[];
    lowRiskChanges: string[];
  };
};

type WorkshopWorkVersion = {
  id: string;
  workshopId: string;
  version: string;
  source: string;
  changeEventId: string | null;
  snapshot: Record<string, unknown>;
  patch: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
};

type WorkshopWorkResponse = {
  work: WorkshopWorkModel;
  versions?: WorkshopWorkVersion[];
};

type LoadedWorkshopPanels = {
  dashboard: boolean;
  work: boolean;
  sources: boolean;
  memories: boolean;
  outbox: boolean;
};

type WorkshopManifestReview = {
  ok: boolean;
  manifestName: string | null;
  title: string | null;
  summary: {
    loops: number;
    sources: number;
    requestedTools: number;
    requestedSkills: number;
    deniedTools: number;
  };
  issues: Array<{
    severity: "error" | "warning";
    path: string;
    message: string;
  }>;
  requestedTools: string[];
  deniedTools: string[];
  requestedSkills: string[];
  creationReport: {
    title: string;
    body: string;
  } | null;
};

function sortWorkshopEvents(events: WorkshopEvent[]) {
  return [...events].sort(
    (a, b) =>
      a.seq - b.seq ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function mergeWorkshopEvents(
  events: WorkshopEvent[],
  nextEvent: WorkshopEvent,
) {
  if (events.some((event) => event.id === nextEvent.id)) {
    return events;
  }
  return sortWorkshopEvents([...events, nextEvent]);
}

function mergeWorkshopEventLists(
  left: WorkshopEvent[],
  right: WorkshopEvent[],
) {
  const byId = new Map<string, WorkshopEvent>();
  for (const event of [...left, ...right]) {
    byId.set(event.id, event);
  }
  return sortWorkshopEvents([...byId.values()]);
}

const WORKSHOP_TEMPLATES = [
  {
    id: "a-share-research",
    label: "A 股研",
    name: "每日 A 股复",
    mission:
      "你是我的 A 股研究分析师。每个交易日复盘市场结构、情绪和主线，整理有可靠来源的公司变化，并给出明日观察清单触发条件失效条件和风险。不得执行交易",
  },
  {
    id: "daily-brief",
    label: "每日箢",
    name: "每日信息箢",
    mission:
      "每天汇我关心的信息源，去重并按重要排序，给出事实、影响待办和原始来源。没有重要变化时明确说明，不为凑数生成内容",
  },
  {
    id: "customer-follow-up",
    label: "客户跟进",
    name: "客户跟进车间",
    mission:
      "持续整理客户沟中的明确需求承诺负责人和截止时间，生成跟进建议与回复草稿任何外发都必须先进入待确认",
  },
  {
    id: "competitor-radar",
    label: "竞品雷达",
    name: "竞品雷达车间",
    mission:
      "持续跟踪指定竞品的产品价格渠道和团队变化，保留来源与时间，区分事实和判断，只在出现实质变化时提醒",
  },
] as const;

const DEFAULT_WORKSHOP_MANIFEST_YAML = `apiVersion: openzhiyu.ai/v1alpha1
kind: Workshop
metadata:
  name: watchlist-hunter
  title: 自选股猎手
spec:
  mission: >
    发现候选、维护自选股池，输出可审计调整提案。
  role: watchlist_selector
  autonomyLevel: auto
  control:
    object: paper_trading_watchlist
    objective: maintain_a_small_explainable_auditable_candidate_set
    mode: internal_watchlist_control
    feedback:
      - market_candidate_discovery
      - current_watchlist_review
      - watchlist_change_proposals
      - proposal_application_results
      - data_quality_warnings
      - workshop_memory
    invariants:
      - 只维护内部模拟盘使用的自选股池和候选池。
      - 不做任何模拟盘或真实盘交易。
      - 候选发现是观测，不等于加入交易池。
      - 自选股调整必须通过 quantPaperProposeWatchlistChange 形成可审计提案。
      - 数据源降级必须显式暴露 provider、detail、warning。
  modelConfig:
    role: watchlist_selector
    # 默认使用 Claude 兼容运行时。需要灰度 Pi 时取消下一行注释：
    # agentRuntimeEngine: pi
    # Pi 支持 anthropic-messages、openai-responses 或 openai-completions；未填写时默认 anthropic-messages。
    # piModelProtocol: anthropic-messages
    primarySkills:
      - watchlist-selection-control
    allowedTools:
      - quantMarketDiscoverCandidates
      - quantPaperGetWatchlist
      - quantPaperGetAccount
      - quantPaperProposeWatchlistChange
      - aStockTrendSystem
      - aStockSignals
      - aStockMarketMood
      - workshopReadMemory
      - workshopSearchMemory
      - workshopGetMemoryEvidence
      - workshopLogEvent
      - workshopWriteMemory
    disallowedTools:
      - quantPaperPlaceOrder
      - quantPaperCancelOrder
      - realBrokerOrder
      - externalPayment
      - wechatSendMessage
      - outboxSend
    observationTools:
      - quantPaperGetWatchlist
      - quantPaperGetAccount
      - quantMarketDiscoverCandidates
      - aStockTrendSystem
      - aStockSignals
      - aStockMarketMood
    loopSkillMap:
      交易日收盘后自选股筛选: watchlist-selection-control
    explorationPolicy:
      minThemesPerRun: 2
      requireConcreteProposalWhenBetterReplacementFound: true
      noProposalRequiresBlocker: true
  boundaryPolicy:
    mode: auto
    externalMessages: blocked
    deniedPrecedence: true
    hardDeniedActions:
      - bash
      - shell
      - exec
      - Bash
      - Edit
      - Write
      - rm
      - delete
      - remove
      - drop
      - truncate
      - placeOrder
      - executeOrder
      - submitOrder
      - buy
      - sell
      - trade
      - makePayment
      - payInvoice
      - transferMoney
      - wireTransfer
      - wechatDesktopSendMessage
      - douyinPublishApprovedDraft
      - quantPaperPlaceOrder
      - quantPaperCancelOrder
      - deleteLoopTask
    customInstructions: |
      这是自选股猎手车间。它维护候选池和核心/交易自选股池，为操盘交易员提供可交易学习样本。
      允许读取当前自选股、扫描市场候选、读取趋势/信号/市场情绪，并在证据足够时调用 quantPaperProposeWatchlistChange 生成可审计的自选股调整提案。
      禁止任何模拟盘下单、撤单、真实交易、真实资金划转、真实券商连接或对外发送交易指令。
      不得调用 quantPaperPlaceOrder 或 quantPaperCancelOrder。
      每次不提案时必须写清楚具体 blocker，不能只写“维持现状”。
      对外消息默认禁止。
  sources:
    - name: quantPaperGetWatchlist
      type: connector
      purpose: 读取当前模拟盘自选股和最新报价快照。
    - name: quantMarketDiscoverCandidates
      type: connector
      purpose: 按主题或风格方向扫描市场候选，形成候选池观测。
    - name: quantPaperProposeWatchlistChange
      type: connector
      purpose: 创建可审计的自选股调整提案，校验通过后应用。
    - name: aStockTrendSystem
      type: connector
      purpose: 读取自选股和候选股趋势结构、相对强弱和风控状态。
    - name: aStockSignals
      type: connector
      purpose: 读取资金、信号和候选辅助证据。
    - name: aStockMarketMood
      type: connector
      purpose: 读取市场情绪、行业热度、涨跌停和风险背景。
    - name: watchlistMemory
      type: memory
      query: 自选股 猎手 候选 提案 blocker 学习
  loops:
    - name: post-close-watchlist-selection
      title: 交易日收盘后自选股筛选
      description: 交易日 16:20 扫描候选、复核自选股，并在证据足够时自动应用自选股调整。
      skill: watchlist-selection-control
      status: active
      trigger:
        type: cron
        expression: "20 16 * * 1-5"
        timezone: Asia/Shanghai
        tradingCalendar: a-share
        tradingDayOnly: true
      goal: |
        维护候选池和核心/交易自选股池，为操盘交易员提供可交易学习样本。
        每次至少扫描两个主题或风格方向，调用 quantMarketDiscoverCandidates。
        发现明显优于现有弱标的的候选时，必须调用 quantPaperProposeWatchlistChange。
        如果连续维持现状，必须写清楚阻止提案的具体原因：估值、趋势、流动性、数据质量、持仓保护或证据不足。
      context:
        sources:
          - type: connector
            name: quantPaperGetWatchlist
          - type: connector
            name: quantMarketDiscoverCandidates
          - type: connector
            name: aStockTrendSystem
          - type: connector
            name: aStockSignals
          - type: connector
            name: aStockMarketMood
          - type: memory
            name: watchlistMemory
            query: 自选股 猎手 候选 提案 blocker 学习
        instructions: |
          不要只复述当前自选股；每次必须做候选发现。
          候选不是立刻交易，但高质量候选要通过 quantPaperProposeWatchlistChange 晋升到 active core/trading watchlist。
          保持持仓和未成交委托标的受保护，不从行情跟踪宇宙移除。
      actionPolicy:
        allowed:
          - quantMarketDiscoverCandidates
          - quantPaperGetWatchlist
          - quantPaperGetAccount
          - quantPaperProposeWatchlistChange
          - aStockTrendSystem
          - aStockSignals
          - aStockMarketMood
          - workshopReadMemory
          - workshopSearchMemory
          - workshopGetMemoryEvidence
          - workshopLogEvent
          - workshopWriteMemory
        requiresApproval: []
        denied:
          - quantPaperPlaceOrder
          - quantPaperCancelOrder
          - realBrokerOrder
          - externalPayment
          - wechatSendMessage
          - outboxSend
      verification:
        type: structured_check
        requiredFields:
          - marketScanSummary
          - currentWatchlistReview
          - candidatePool
          - watchlistDecision
          - proposalOrBlocker
        requiredSources:
          - quantPaperGetWatchlist
          - quantPaperGetAccount
          - quantMarketDiscoverCandidates
        successCriteria:
          - 每次至少调用 quantMarketDiscoverCandidates 做候选发现
          - 有明确 add/remove/replace 时调用 quantPaperProposeWatchlistChange
          - 无提案时记录具体 blocker，不允许只写维持现状
          - 不调用任何模拟盘下单、撤单或真实交易工具
      approvalPolicy:
        defaultMode: allow
        externalWrites: deny
      retryPolicy:
        maxAttempts: 2
        onFailure: summarize_and_block
      escalationPolicy:
        onBlocked: notify_user
        onNeedsApproval: notify_user
  creationReport:
    title: 自选股猎手车间声明
    body: |
      创建一个内部自选股猎手车间。
      被控对象是内部模拟盘使用的候选池和核心/交易自选股池。
      控制动作包括读取自选股、扫描候选、写入车间事件、写入车间记忆、生成可审计自选股调整提案。
      禁止模拟盘下单、撤单、真实交易、真实资金划转、真实券商连接和对外发送交易指令。
      已配置交易日收盘后自选股筛选 Loop。
    requiredEvents:
      - 车间已创建
      - 自选股猎手候选发现与提案闭环已配置
    requiredFields:
      - marketScanSummary
      - currentWatchlistReview
      - candidatePool
      - watchlistDecision
      - proposalOrBlocker
  applyPolicy:
    idempotency:
      key: metadata.name
      loopKey: loops.name
      behavior: upsert
    dryRunSupported: true
    diffSupported: true
    versionSnapshot: true
    auditEvent: true
`;

const SIDE_PANEL_TAB_VALUES = [
  "run", "attention", "review", "outbox", "collaboration", "sources", "memory", "loops", "evolution",
] as const satisfies readonly WorkshopTab[];
type SidePanelTab = WorkshopTab;
type SidePanelDirection = "previous" | "next";
type DetailSection = "work" | "attention" | "collaboration" | "knowledge" | "management";

function detailSectionForTab(tab: SidePanelTab): DetailSection {
  if (tab === "run") return "work";
  if (tab === "attention" || tab === "review" || tab === "outbox") return "attention";
  if (tab === "collaboration") return "collaboration";
  if (tab === "memory" || tab === "sources") return "knowledge";
  return "management";
}

const decisionReviewKinds = new Set([
  "watchlist_proposal", "agent_change_proposal", "insight_change_proposal",
  "memory_recall_change_plan", "memory_recall_governance_proposal", "loop_change_proposal",
]);

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDateKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateTime(value: string | null) {
  if (!value) return "暂无安排";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无安排";
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function dashboardStatusLabel(status: string) {
  const labels: Record<string, string> = {
    active: "已启用",
    draft: "草稿",
    paused: "已暂停",
    archived: "已归档",
    blocked: "受阻",
    needs_approval: "待审核",
    error: "异常",
  };
  return labels[status] ?? status;
}

function dashboardStatusTone(status: string) {
  if (status === "needs_approval") return "text-amber-600 dark:text-amber-300";
  if (status === "blocked" || status === "error") {
    return "text-destructive";
  }
  if (status === "paused" || status === "archived") {
    return "text-muted-foreground";
  }
  return "text-emerald-600 dark:text-emerald-300";
}

type AttentionCategory =
  | "billing"
  | "credential"
  | "provider"
  | "missing_config"
  | "schema_invalid"
  | "tool_missing"
  | "permission"
  | "data_source"
  | "verification_failed"
  | "human_decision"
  | "review"
  | "review_observation";

type WorkshopAttentionItem =
  | {
      id: string;
      source: "loop";
      category: AttentionCategory;
      severity: "blocking" | "warning";
      title: string;
      scope: string;
      userMessage: string;
      impact: string;
      technicalReason: string;
      loop: WorkshopDashboardLoop;
    }
  | {
      id: string;
      source: "review";
      category: "review" | "review_observation";
      severity: "warning";
      title: string;
      scope: string;
      userMessage: string;
      impact: string;
      technicalReason: string;
      event?: WorkshopEvent;
      reviewId?: string;
    }
  | {
      id: string;
      source: "outbox";
      category: "permission";
      severity: "warning";
      title: string;
      scope: string;
      userMessage: string;
      impact: string;
      technicalReason: string;
      outbox: WorkshopOutbox;
    };

function attentionMeta(category: AttentionCategory) {
  const map: Record<
    AttentionCategory,
    {
      label: string;
      icon: string;
      tone: string;
      userMessage: string;
      impact: string;
    }
  > = {
    billing: {
      label: "模型欠费",
      icon: "credit_card",
      tone: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      userMessage: "模型服务返回余额不足。通常需要充值当前 Key，或切换到可用模型。",
      impact: "模型没有启动，本次通常不会执行工具动作，可以在处理后安全重试。",
    },
    credential: {
      label: "凭证失效",
      icon: "key",
      tone: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      userMessage: "当前 API Key、账号权限或连接凭证不可用。",
      impact: "智能体无法调用外部服务，需要更新凭证后再运行。",
    },
    provider: {
      label: "服务异常",
      icon: "cloud",
      tone: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      userMessage: "模型或上游服务连接失败、超时或限流。",
      impact: "本次运行可能没有进入业务工具阶段，建议先重试一次或切换服务。",
    },
    missing_config: {
      label: "缺少配置",
      icon: "settings",
      tone: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      userMessage: "Loop 或车间缺少必要参数。",
      impact: "运行缺少稳定输入，应该补齐配置后再恢复自动执行。",
    },
    schema_invalid: {
      label: "格式错误",
      icon: "file_json",
      tone: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      userMessage: "YAML、Loop spec 或结构化输出不符合当前 schema。",
      impact: "系统无法可靠解析配置或结果，需要修改字段后再重跑。",
    },
    tool_missing: {
      label: "工具缺失",
      icon: "tools",
      tone: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      userMessage: "Loop 依赖了不存在、未注册或当前不可用的工具。",
      impact: "智能体无法完成对应控制动作，需要替换工具、补工具或修改 Loop。",
    },
    permission: {
      label: "权限边界",
      icon: "shield",
      tone: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      userMessage: "动作被边界、审批或 denied 优先规则拦住。",
      impact: "这是安全阻塞，需要你审批、调整边界或让任务保持暂停。",
    },
    data_source: {
      label: "数据源异常",
      icon: "database_2",
      tone: "border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      userMessage: "行情、记忆、连接器或其他观测源不可用或质量降级。",
      impact: "结论可信度会下降，可以重试数据源，或允许降级运行。",
    },
    verification_failed: {
      label: "校验失败",
      icon: "list_checks",
      tone: "border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300",
      userMessage: "运行结果没有满足 requiredFields、requiredSources 或 checker 条件。",
      impact: "结果不能被当作完成态，需要修输出契约或重跑。",
    },
    human_decision: {
      label: "需要决策",
      icon: "question",
      tone: "border-border bg-muted text-muted-foreground",
      userMessage: "系统没有足够把握自动推进，需要主人选择下一步。",
      impact: "选择处理方式后，Loop 才能继续形成闭环。",
    },
    review: {
      label: "等待审核",
      icon: "clipboard_list",
      tone: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      userMessage: "有配置、内容或动作提案等待你确认。",
      impact: "审核完成后，相关任务才能继续推进或从待处理中移除。",
    },
    review_observation: {
      label: "待核查",
      icon: "search",
      tone: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      userMessage: "这是一条待评估的观察记录，目前没有需要批准的控制动作。",
      impact: "可以核查证据或暂不处理；系统不会因此自动修改策略。",
    },
  };
  return map[category];
}

function loopBlockerText(loop: WorkshopDashboardLoop) {
  return [
    loop.blockedReason,
    loop.nextAction,
    loop.latestRun?.error,
    loop.latestRun?.outputSummary,
    loop.latestRun?.modelCheckerReason,
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n");
}

function classifyLoopBlocker(loop: WorkshopDashboardLoop): AttentionCategory {
  const text = loopBlockerText(loop).toLowerCase();
  if (/402|insufficient balance|余额|欠费|balance/.test(text)) return "billing";
  if (/401|403|unauthorized|forbidden|api key|apikey|invalid key|凭证|密钥|key/.test(text)) {
    return "credential";
  }
  if (/quantRuleEvaluate|unknown tool|tool.*not|not registered|工具不存在|未注册|缺少.*工具/.test(text)) {
    return "tool_missing";
  }
  if (/unrecognized_keys|schema|invalid yaml|invalid spec|zod|字段|格式|yaml/.test(text)) {
    return "schema_invalid";
  }
  if (/denied|not allowed|requires approval|approval|boundary|权限|审批|边界|禁止/.test(text)) {
    return "permission";
  }
  if (/data_quality|data source|eastmoney|tencent|astock|行情|数据源|召回为空|source/.test(text)) {
    return "data_source";
  }
  if (/verification|requiredfields|requiredsources|checker|校验|缺少.*字段/.test(text)) {
    return "verification_failed";
  }
  if (/timeout|timed out|econnrefused|refused|rate limit|429|5\d\d|provider|connect|超时|拒绝连接/.test(text)) {
    return "provider";
  }
  if (/missing|required|未配置|缺少|parameter|参数/.test(text)) return "missing_config";
  return "human_decision";
}

function buildLoopAttentionItem(loop: WorkshopDashboardLoop): WorkshopAttentionItem {
  const category = classifyLoopBlocker(loop);
  const meta = attentionMeta(category);
  const technicalReason =
    loopBlockerText(loop) || loop.goal || loop.description || "Loop blocked without a detailed reason.";
  return {
    id: `loop:${loop.id}`,
    source: "loop",
    category,
    severity: loop.dashboardStatus === "blocked" ? "blocking" : "warning",
    title: loop.name,
    scope: "Loop 阻塞",
    userMessage: meta.userMessage,
    impact: meta.impact,
    technicalReason,
    loop,
  };
}

function buildReviewAttentionItem(
  id: string,
  title: string,
  scope: string,
  event?: WorkshopEvent,
  requiresDecision = true,
  summary?: string,
  reviewId?: string,
): WorkshopAttentionItem {
  const category = requiresDecision ? "review" : "review_observation";
  return {
    id,
    source: "review",
    category,
    severity: "warning",
    title,
    scope,
    userMessage: attentionMeta(category).userMessage,
    impact: attentionMeta(category).impact,
    technicalReason: summary ?? event?.body ?? event?.title ?? "待核查记录。",
    event,
    reviewId,
  };
}

function buildOutboxAttentionItem(outbox: WorkshopOutbox): WorkshopAttentionItem {
  const boundary = outbox.boundaryResult?.boundary as
    | { violations?: string[]; warnings?: string[] }
    | undefined;
  return {
    id: `outbox:${outbox.id}`,
    source: "outbox",
    category: "permission",
    severity: "warning",
    title: outbox.recipientName ?? "待发消息",
    scope: "外发边界",
    userMessage: "这条外部消息被边界拦截，需要你确认是否修改边界或保持阻塞。",
    impact: "不会自动发送，除非你调整边界并重新处理。",
    technicalReason:
      boundary?.violations?.join("\n") ||
      boundary?.warnings?.join("\n") ||
      "Outbox draft is blocked by boundary.",
    outbox,
  };
}

function outboxStatusFromEvent(event: WorkshopEvent) {
  switch (event.type) {
    case "outbox_draft":
      return stringValue(event.metadata?.status) ?? "draft";
    case "outbox_preview_ready":
      return "pending_approval";
    case "outbox_sent":
      return "sent";
    case "outbox_blocked":
    case "outbox_auto_send_blocked":
      return "blocked";
    case "outbox_auto_send_failed":
    case "work_outbox_send_failed":
      return "draft";
    default:
      return null;
  }
}

function outboxBoundaryPatchFromEvent(event: WorkshopEvent) {
  const metadata = objectValue(event.metadata);
  const patch: Record<string, unknown> = {};
  const boundary = objectValue(metadata.boundary);
  const sent = objectValue(metadata.sent);
  const preview = metadata.preview;
  if (Object.keys(boundary).length > 0) patch.boundary = boundary;
  if (Object.keys(sent).length > 0) patch.sent = sent;
  if (preview !== undefined) {
    patch.wechatPreview = { preview };
  }
  if (
    event.type === "outbox_auto_send_failed" ||
    event.type === "work_outbox_send_failed"
  ) {
    patch.autoSend = {
      status: "failed",
      error: event.body ?? event.title,
      failedAt: event.createdAt,
    };
  }
  return patch;
}

function patchOutboxListFromEvent(
  current: WorkshopOutbox[],
  event: WorkshopEvent,
) {
  const metadata = objectValue(event.metadata);
  const outboxId = stringValue(metadata.outboxId);
  const status = outboxStatusFromEvent(event);
  if (!outboxId || !status) {
    return { outbox: current, applied: false };
  }

  const boundaryPatch = outboxBoundaryPatchFromEvent(event);
  const existingIndex = current.findIndex((item) => item.id === outboxId);
  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    const next = [...current];
    next[existingIndex] = {
      ...existing,
      status,
      recipientName:
        stringValue(metadata.recipientName) ?? existing.recipientName,
      boundaryResult:
        Object.keys(boundaryPatch).length > 0
          ? { ...(existing.boundaryResult ?? {}), ...boundaryPatch }
          : existing.boundaryResult,
    };
    return { outbox: next, applied: true };
  }

  if (event.type !== "outbox_draft") {
    return { outbox: current, applied: false };
  }

  const drafted: WorkshopOutbox = {
    id: outboxId,
    runId: event.runId,
    channel: stringValue(metadata.channel) ?? "wechat_desktop",
    recipientName: stringValue(metadata.recipientName),
    message: event.body ?? event.title,
    status,
    confidence: numberValue(metadata.confidence) ?? 0,
    riskLevel: stringValue(metadata.riskLevel) ?? "medium",
    boundaryResult: {},
    createdAt: event.createdAt,
  };

  return { outbox: [drafted, ...current], applied: true };
}

function patchMemoryListFromEvent(
  current: WorkshopMemory[],
  event: WorkshopEvent,
) {
  const metadata = objectValue(event.metadata);
  const memoryId = stringValue(metadata.memoryId);
  if (!memoryId) {
    return { memories: current, applied: false };
  }

  const existingIndex = current.findIndex((item) => item.id === memoryId);
  if (event.type === "memory_reviewed") {
    if (existingIndex < 0) return { memories: current, applied: false };
    const status = stringValue(metadata.status);
    if (!status) return { memories: current, applied: false };
    const next = [...current];
    next[existingIndex] = { ...next[existingIndex], status };
    return { memories: next, applied: true };
  }

  if (event.type !== "memory_written") {
    return { memories: current, applied: false };
  }

  const content = event.body ?? event.title;
  const written: WorkshopMemory = {
    id: memoryId,
    kind: stringValue(metadata.kind) ?? "finding",
    content,
    confidence: numberValue(metadata.confidence) ?? 0,
    tags: stringListValue(metadata.tags),
    createdAt: event.createdAt,
    status: stringValue(metadata.status) ?? "active",
    sourceEventIds: stringListValue(metadata.sourceEventIds),
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = { ...next[existingIndex], ...written };
    return { memories: next, applied: true };
  }

  return { memories: [written, ...current], applied: true };
}

function patchSourceListFromEvent(
  current: WorkshopSource[],
  event: WorkshopEvent,
) {
  if (event.type !== "source_added") {
    return { sources: current, applied: false };
  }
  const metadata = objectValue(event.metadata);
  const sourceId = stringValue(metadata.sourceId);
  if (!sourceId) {
    return { sources: current, applied: false };
  }

  const source: WorkshopSource = {
    id: sourceId,
    type: stringValue(metadata.type) ?? "note",
    name: event.body ?? event.title,
    uri: stringValue(metadata.uri),
    content: null,
    enabled: true,
    createdAt: event.createdAt,
  };
  const existingIndex = current.findIndex((item) => item.id === sourceId);
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = { ...next[existingIndex], ...source };
    return { sources: next, applied: true };
  }
  return { sources: [source, ...current], applied: true };
}

function loopRunStatusFromEvent(event: WorkshopEvent) {
  if (event.type === "loop_run_started") return "running";
  if (event.type === "loop_run_completed") return "success";
  if (event.type === "loop_run_failed") {
    return stringValue(event.metadata?.status) ?? "error";
  }
  return null;
}

function loopDashboardStatusFromEvent(
  event: WorkshopEvent,
  existing: WorkshopDashboardLoop,
) {
  if (event.type === "loop_run_started") return "active";
  if (event.type === "loop_run_completed") return "active";
  if (event.type === "loop_run_failed") return "error";
  return existing.dashboardStatus;
}

function loopLatestRunFromEvent(
  event: WorkshopEvent,
  existing: WorkshopDashboardLoop,
): WorkshopLoopRun | null {
  const status = loopRunStatusFromEvent(event);
  if (!status) return null;
  const metadata = objectValue(event.metadata);
  const previous = existing.latestRun;
  const isStarted = event.type === "loop_run_started";
  const isFailed = event.type === "loop_run_failed";
  const summary =
    stringValue(metadata.summary) ??
    (isStarted ? null : event.body ?? previous?.outputSummary ?? null);
  const duration = numberValue(metadata.duration);
  return {
    ...(previous ?? {
      outputSummary: null,
      error: null,
      requiresApproval: false,
      actionGuardBlocked: false,
    }),
    id: event.loopRunId ?? previous?.id,
    status,
    startedAt: isStarted ? event.createdAt : previous?.startedAt,
    completedAt: isStarted ? null : event.createdAt,
    outputSummary: isFailed ? previous?.outputSummary ?? null : summary,
    error: isFailed ? event.body ?? event.title : null,
    requiresApproval: previous?.requiresApproval ?? false,
    actionGuardBlocked: previous?.actionGuardBlocked ?? false,
    executionTrace: previous?.executionTrace
      ? {
          ...previous.executionTrace,
          durationMs: duration ?? previous.executionTrace.durationMs,
        }
      : previous?.executionTrace,
  };
}

function patchLoopFromEvent(
  loop: WorkshopDashboardLoop,
  event: WorkshopEvent,
) {
  if (!event.loopId || event.loopId !== loop.id) {
    return { loop, applied: false };
  }
  const latestRun = loopLatestRunFromEvent(event, loop);
  if (!latestRun) return { loop, applied: false };
  return {
    loop: {
      ...loop,
      dashboardStatus: loopDashboardStatusFromEvent(event, loop),
      latestRun,
      lastObservation:
        event.type === "loop_run_started"
          ? loop.lastObservation
          : event.body ?? loop.lastObservation,
      blockedReason:
        event.type === "loop_run_failed"
          ? event.body ?? event.title
          : event.type === "loop_run_completed"
            ? null
            : loop.blockedReason,
    },
    applied: true,
  };
}

function patchLoopListFromEvent(
  loops: WorkshopDashboardLoop[],
  event: WorkshopEvent,
) {
  if (!event.loopId) return { loops, applied: false };
  const index = loops.findIndex((loop) => loop.id === event.loopId);
  if (index < 0) return { loops, applied: false };
  const patch = patchLoopFromEvent(loops[index], event);
  if (!patch.applied) return { loops, applied: false };
  const next = [...loops];
  next[index] = patch.loop;
  return { loops: next, applied: true };
}

function patchWorkshopDashboardFromEvent(
  current: WorkshopDashboard | null,
  event: WorkshopEvent,
) {
  if (!current) return { dashboard: current, applied: false };
  const loopPatch = patchLoopListFromEvent(current.loops, event);
  if (!loopPatch.applied) return { dashboard: current, applied: false };
  const loops = loopPatch.loops;
  const pendingLoopProposals = loops.filter(isPendingLoopProposal);
  const blockedLoops = loops.filter((loop) =>
    ["blocked", "error"].includes(loop.dashboardStatus),
  );
  return {
    dashboard: {
      ...current,
      latestEvent: event,
      pendingLoopProposals,
      blockedLoops,
      loops,
    },
    applied: true,
  };
}

function patchLoopDetailFromEvent(
  current: WorkshopLoopDetail | null,
  event: WorkshopEvent,
) {
  if (!current || !event.loopId || current.loop.id !== event.loopId) {
    return { detail: current, applied: false };
  }
  const patch = patchLoopFromEvent(current.loop, event);
  if (!patch.applied) return { detail: current, applied: false };
  const latestRun = patch.loop.latestRun;
  const runs =
    latestRun?.id
      ? [
          latestRun,
          ...current.loop.runs.filter((run) => run.id !== latestRun.id),
        ]
      : current.loop.runs;
  return {
    detail: {
      ...current,
      loop: {
        ...patch.loop,
        runs,
      },
      events: mergeWorkshopEvents(current.events, event),
    },
    applied: true,
  };
}

function isPlatformBugAttentionItem(item: WorkshopAttentionItem) {
  if (item.source !== "loop") return false;
  const text = item.technicalReason.toLowerCase();
  return (
    (item.category === "schema_invalid" &&
      /zod|unrecognized_keys|invalid_type|parsestructuredoutput|structured output|schema validation failed|json parse failed/.test(
        text,
      )) ||
    /enoent|node_modules|module not found|err_invalid_state|controller is already closed/.test(
      text,
    )
  );
}

function attentionUserMessage(item: WorkshopAttentionItem) {
  if (!isPlatformBugAttentionItem(item)) return item.userMessage;
  return "这是平台运行时、schema 或结果解析器没有兜住的异常，不应该要求你在业务页面手工处理。";
}

function attentionImpact(item: WorkshopAttentionItem) {
  if (!isPlatformBugAttentionItem(item)) return item.impact;
  return "应归类为平台 bug：修复解析/兼容/依赖问题后，再用重试验证任务是否恢复。";
}

function toolAvailabilityLabel(value: AgentToolAvailability) {
  const labels: Record<AgentToolAvailability, string> = {
    allow: "可用",
    require_approval: "霢确认",
    deny: "禁止",
    chat_only: "仅对",
    workshop_only: "仅车",
    loop_only: "仅任",
    disabled: "未开",
    unknown: "待探",
  };
  return labels[value] ?? value;
}

function toolAvailabilityClass(value: AgentToolAvailability) {
  if (value === "allow") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (value === "require_approval") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (value === "deny") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted text-muted-foreground";
}

function toolSourceLabel(value: AgentToolSource) {
  const labels: Record<AgentToolSource, string> = {
    claude_builtin: "Claude / Pi",
    pi_builtin: "Pi",
    business_tools: "业务 MCP",
    workshop_tools: "车间 MCP",
    skill: "Skill",
    user_mcp: "自定义 MCP",
  };
  return labels[value] ?? value;
}

function toolRiskLabel(value: AgentToolRisk) {
  const labels: Record<AgentToolRisk, string> = {
    low: "低风",
    medium: "中风",
    high: "高风",
    critical: "关键风险",
  };
  return labels[value] ?? value;
}

function toolCapabilityLabel(value: string) {
  const labels: Record<string, string> = {
    file_read: "读文",
    file_write: "写文",
    code_exec: "命令",
    web_read: "联网",
    memory_read: "读记",
    memory_write: "写记",
    knowledge_read: "知识",
    message_read: "读消",
    external_draft: "草稿",
    external_send: "外发",
    task_create: "建任",
    task_manage: "管任",
    market_data: "行情",
    browser: "浏览",
    document: "文档",
    spreadsheet: "表格",
    presentation: "幻灯",
    time: "时间",
    unknown: "复合",
  };
  return labels[value] ?? value;
}

function interactionStatusLabel(value: string) {
  const labels: Record<string, string> = {
    candidate: "候",
    confirmed: "已确",
    done: "已完",
    dismissed: "已忽",
    archived: "已归",
  };
  return labels[value] ?? value;
}

function canConfirmInteractionItem(status: string) {
  return status === "candidate";
}

function isPendingLoopProposal(loop: { stateJson?: Record<string, unknown> }) {
  const activationStatus = loop.stateJson?.ownerActivationStatus;
  return (
    loop.stateJson?.requiresOwnerActivation === true &&
    (activationStatus === undefined || activationStatus === "pending")
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringListValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function MemoryRecallQualityReviewDetails({
  item,
  actionId,
  onConfirmAction,
  onConfirmBatch,
}: {
  item: WorkshopReviewItem;
  actionId: string | null;
  onConfirmAction: (item: WorkshopReviewItem, action: string) => void;
  onConfirmBatch: (item: WorkshopReviewItem) => void;
}) {
  if (item.kind !== "memory_recall_quality") return null;
  const metadata = objectValue(item.metadata);
  const recommendedActions = stringListValue(metadata.recommendedActions);
  const governanceActionDetails = Array.isArray(
    metadata.governanceActionDetails,
  )
    ? metadata.governanceActionDetails.map((entry) => objectValue(entry))
    : [];
  const topDiagnosticAction =
    governanceActionDetails
      .map((entry) => stringValue(entry.label))
      .find((label): label is string =>
        label ? recommendedActions.includes(label) : false,
      ) ?? null;
  const canBatchConfirm = Boolean(topDiagnosticAction);
  const evidenceHints = stringListValue(metadata.evidenceHints);
  const blockedActions = stringListValue(metadata.blockedActions);
  const feedbackTraceDiagnostics = objectValue(
    metadata.feedbackTraceDiagnostics,
  );
  const diagnosticLoops = Array.isArray(feedbackTraceDiagnostics.loops)
    ? feedbackTraceDiagnostics.loops.map((item) => objectValue(item)).slice(0, 4)
    : [];
  const diagnosticRuns = Array.isArray(feedbackTraceDiagnostics.runs)
    ? feedbackTraceDiagnostics.runs.map((item) => objectValue(item)).slice(0, 4)
    : [];
  const issueCount = numberValue(metadata.issueCount);
  const issueKind = stringValue(metadata.issueKind);
  const issueLabels: Record<string, string> = {
    missing_or_too_narrow: "需要的记忆没有找到", ranking_or_scope: "找到了不相关的记忆",
    freshness: "记忆可能已经过时", no_evidence_selected: "所选记忆未附来源链接",
    trace_warnings: "记忆查找过程有异常提示", duplicate_canonical_groups: "重复候选已被过滤",
  };
  const actionLabels: Record<string, string> = {
    "Review requester intent and recall profile scope.": "核对任务真正需要什么，再检查记忆查找范围是否合适。",
    "Check whether required memories were denied by boundary policy before proposing any grant.": "先确认缺少的记忆是否被权限限制拦住，再考虑是否需要申请访问。",
    "Add or repair evidence-backed canonical memories if the source facts are missing.": "如果事实确实缺失，提出补充或修复记忆的建议，并附上来源。",
    "Inspect top selected reasons and requester-specific recall parameters.": "核对这些记忆为什么被选中，以及查找条件是否符合当前任务。",
    "Reclassify memories whose canonical kind or subject does not match the requester task.": "检查记忆的分类和主题，提出修正不匹配分类的建议。",
    "Tune deduplication or ranking rules before increasing context size.": "先减少重复、改善相关性排序，再考虑给智能体更多上下文。",
    "Review whether stale memories should be superseded, downgraded to evidence, or refreshed from source.": "核对过时记忆，判断应更新、替换，还是只保留为历史参考。",
    "Check source freshness and replacement rules for the affected canonical group.": "核对这组记忆的来源是否最新，以及新事实如何替换旧事实。",
    "Attach source evidence references to selected canonical memories.": "为正在使用的记忆补充可追溯的来源证据。",
    "Downgrade memories that cannot be traced back to source observations.": "对找不到来源的记忆，提出降低可信程度的建议。",
    "Require evidence-backed recall for high-impact requester tasks.": "对影响较大的任务，要求采用有来源证据的记忆。",
    "Inspect trace warnings and group them by requester before changing recall rules.": "先按使用记忆的智能体或任务整理异常，再决定是否调整查找规则。",
    "Repair planner fallback or degraded source warnings if they recur.": "如果查找降级或资料来源异常反复出现，提出针对原因的修复建议。",
    "Merge or link duplicate canonical groups after confirming they represent the same fact.": "确认重复记忆确实描述同一事实，再提出合并或关联建议。",
    "Tune deduplication keys so repeated facts do not inflate prompt context.": "改善重复识别，避免同一事实多次占用智能体的上下文。",
    "Keep the original source evidence attached to the surviving canonical memory.": "整理重复记忆时，保留原始来源及证据。",
    "Compare feedback outcomes with trace reasons to decide whether the fix is ranking, scope, evidence, freshness, or boundary.": "对照实际反馈与查找记录，判断问题出在相关性、范围、证据、时效还是权限。",
  };
  const describeAction = (action: string) => actionLabels[action] ??
    (action.startsWith("Create deduplicated ")
      ? `把相关任务中“${issueLabels[issueKind ?? ""] ?? "记忆使用"}”的同类问题整理成治理建议，避免重复提案。`
      : "这条建议尚无通俗说明，请先展开原始建议核对内容，再决定是否提出治理建议。");

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <p className="text-xs leading-5 text-muted-foreground">选择下面的方向，会提出一项待确认的记忆治理建议，供下一步审核；当前操作不会直接改写记忆或扩大访问权限。</p>
      <div className="flex flex-wrap items-center gap-2">
        {issueKind ? <Badge variant="outline">{issueLabels[issueKind] ?? "记忆使用待核对"}</Badge> : null}
        {issueCount !== null ? (
          <Badge variant="secondary">记录 {issueCount} 次相关信号</Badge>
        ) : null}
        <Badge variant="outline">需后续审核，不自动修改</Badge>
      </div>
      {topDiagnosticAction ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 p-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">
              建议先从这里检查
            </p>
            <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
              {describeAction(topDiagnosticAction)}
            </p>
          </div>
          <Button
            size="sm"
            className="h-8 gap-1.5 px-2 text-[11px]"
            disabled={Boolean(actionId)}
            onClick={() => onConfirmAction(item, topDiagnosticAction)}
          >
            <RemixIcon
              name={
                actionId === `governance:${item.id}:${topDiagnosticAction}`
                  ? "loader"
                  : "check"
              }
              size="size-3.5"
            />
            提出这项治理建议
          </Button>
          {canBatchConfirm ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-2 text-[11px]"
              disabled={Boolean(actionId)}
              onClick={() => onConfirmBatch(item)}
            >
              <RemixIcon
                name={
                  actionId === `governance-batch:${item.id}`
                    ? "loader"
                    : "check_double"
                }
                size="size-3.5"
              />
              为同类问题批量提出建议
            </Button>
          ) : null}
        </div>
      ) : null}
      {recommendedActions.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-foreground">
            可以选择的改善方向
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
            {recommendedActions.map((action) => (
              <li key={action}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">{describeAction(action)}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    disabled={Boolean(actionId)}
                    onClick={() => onConfirmAction(item, action)}
                  >
                    <RemixIcon
                      name={
                        actionId === `governance:${item.id}:${action}`
                          ? "loader"
                          : "check"
                      }
                      size="size-3.5"
                    />
                    提出治理建议
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="rounded-md border border-border p-3 text-xs leading-5">
        <summary className="cursor-pointer font-medium text-foreground">查看原始建议、技术诊断和操作限制</summary>
        <div className="mt-3 space-y-3">
        {issueKind ? <p className="break-words text-muted-foreground">原始问题类型：{issueKind}</p> : null}
        {recommendedActions.length ? <div>
          <p className="font-medium text-foreground">建议原文（与上方顺序对应）</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4 text-muted-foreground">
            {recommendedActions.map((action) => <li key={action} className="break-words">{action}</li>)}
          </ol>
        </div> : null}
      {evidenceHints.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {evidenceHints.map((hint) => (
            <Badge key={hint} variant="outline" className="text-[11px]">
              {hint}
            </Badge>
          ))}
        </div>
      ) : null}
      {diagnosticLoops.length > 0 || diagnosticRuns.length > 0 ? (
        <div className="space-y-2 rounded-md bg-muted/50 p-2">
          <p className="text-xs font-medium text-foreground">
            反馈与查找记录
          </p>
          {diagnosticLoops.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">
                持续任务记录
              </p>
              {diagnosticLoops.map((item, index) => (
                <p
                  key={`${stringValue(item.loopId) ?? "loop"}-${index}`}
                  className="text-xs leading-5 text-muted-foreground"
                >
                  <span className="font-medium text-foreground">
                    {stringValue(item.loopId) ?? "unknown"}{" "}
                  </span>
                  诊断分数 {numberValue(item.diagnosticScore) ?? 0}，反馈数{" "}
                  {numberValue(item.feedbackCount) ?? 0}
                  {stringValue(item.topOutcomes)
                    ? `, ${stringValue(item.topOutcomes)}`
                    : ""}
                  {stringValue(item.topReason)
                    ? `, ${stringValue(item.topReason)}`
                    : ""}
                </p>
              ))}
            </div>
          ) : null}
          {diagnosticRuns.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">
                单次执行记录
              </p>
              {diagnosticRuns.map((item, index) => {
                const runLabel =
                  stringValue(item.runId) ??
                  stringValue(item.loopId) ??
                  "unknown";
                const diagnosticKey = [
                  runLabel,
                  stringValue(item.topOutcomes),
                  stringValue(item.topReason),
                  numberValue(item.diagnosticScore),
                  numberValue(item.feedbackCount),
                ].join(":");
                return (
                  <p
                    key={diagnosticKey}
                    className="text-xs leading-5 text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">
                      {runLabel}{" "}
                    </span>
                    诊断分数 {numberValue(item.diagnosticScore) ?? 0}，反馈数{" "}
                    {numberValue(item.feedbackCount) ?? 0}
                    {stringValue(item.topOutcomes)
                      ? `, ${stringValue(item.topOutcomes)}`
                      : ""}
                    {stringValue(item.topReason)
                      ? `, ${stringValue(item.topReason)}`
                      : ""}
                  </p>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {blockedActions.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-destructive">
            操作限制原文
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
            {blockedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      ) : null}
        </div>
      </details>
    </div>
  );
}

function MemoryRecallChangePlanReviewDetails({
  item,
}: {
  item: WorkshopReviewItem;
}) {
  if (item.kind !== "memory_recall_change_plan") return null;
  const metadata = objectValue(item.metadata);
  const dryRunSteps = stringListValue(metadata.dryRunSteps);
  const rollbackPlan = stringListValue(metadata.rollbackPlan);
  const evidenceHints = stringListValue(metadata.evidenceHints);
  const blockedActions = stringListValue(metadata.blockedActions);
  const planKind = stringValue(metadata.planKind);
  const issueKind = stringValue(metadata.issueKind);

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {planKind ? <Badge variant="secondary">{planKind}</Badge> : null}
        {issueKind ? <Badge variant="outline">{issueKind}</Badge> : null}
        <Badge variant="outline">dry-run only</Badge>
        <Badge variant="outline">no memory mutation</Badge>
      </div>
      {dryRunSteps.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-foreground">Dry-run steps</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
            {dryRunSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {rollbackPlan.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-foreground">
            Rollback audit
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
            {rollbackPlan.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {evidenceHints.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {evidenceHints.map((hint) => (
            <Badge key={hint} variant="outline" className="text-[11px]">
              {hint}
            </Badge>
          ))}
        </div>
      ) : null}
      {blockedActions.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-destructive">Guardrails</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
            {blockedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function metadataStringList(value: unknown): string[] {
  return stringListValue(value);
}

function sourceNamesFromSpec(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => objectValue(item).name ?? objectValue(item).id)
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function truncateList(values: string[], fallback: string, max = 3) {
  if (values.length === 0) return fallback;
  const visible = values.slice(0, max).join("、");
  return values.length > max
    ? `${visible} +${values.length - max} 项`
    : visible;
}

function booleanLabel(value: boolean | null | undefined) {
  if (value === true) return "通过";
  if (value === false) return "未通过";
  return "暂无";
}

function durationLabel(value: number | null | undefined) {
  if (!value || value < 0) return "暂无";
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 100) / 10}s`;
}

function compactNumberLabel(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value));
}

function BrainContextTraceDetails({ contextPack }: { contextPack: unknown }) {
  const pack = objectValue(contextPack);
  const selected = Array.isArray(pack.selected)
    ? pack.selected.map((item) => objectValue(item)).slice(0, 5)
    : [];
  const omitted = Array.isArray(pack.omitted)
    ? pack.omitted.map((item) => objectValue(item)).slice(0, 6)
    : [];
  const denied = Array.isArray(pack.denied)
    ? pack.denied.map((item) => objectValue(item)).slice(0, 6)
    : [];
  if (selected.length === 0 && omitted.length === 0 && denied.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {selected.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-foreground">
            selected ContextPack
          </div>
          {selected.map((item, index) => {
            const id = stringValue(item.id) ?? `selected-${index}`;
            const reasons = stringListValue(item.reasons).slice(0, 4);
            return (
              <div
                key={id}
                className="rounded-md border border-border bg-background p-2"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">
                    {stringValue(item.memoryType) ?? "memory"}
                  </Badge>
                  {stringValue(item.canonicalKind) ? (
                    <Badge variant="secondary">
                      {stringValue(item.canonicalKind)}
                    </Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    score {compactNumberLabel(numberValue(item.score))}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    evidence{" "}
                    {compactNumberLabel(numberValue(item.evidenceRefCount))}
                  </span>
                </div>
                <div className="mt-1 text-xs font-medium text-foreground">
                  {stringValue(item.subject) ?? id}
                </div>
                {stringValue(item.contentPreview) ? (
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {stringValue(item.contentPreview)}
                  </p>
                ) : null}
                {stringValue(item.canonicalGroupId) ? (
                  <div className="mt-1 break-all text-xs text-muted-foreground">
                    group: {stringValue(item.canonicalGroupId)}
                  </div>
                ) : null}
                {reasons.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {reasons.map((reason) => (
                      <span
                        key={reason}
                        className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {reason}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {omitted.length > 0 || denied.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {omitted.length > 0 ? (
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-xs font-medium text-foreground">
                omitted
              </div>
              <div className="mt-1 space-y-1">
                {omitted.map((item, index) => (
                  <div
                    key={`${stringValue(item.id) ?? index}`}
                    className="break-all text-xs text-muted-foreground"
                  >
                    {stringValue(item.id) ?? "unknown"}:{" "}
                    {stringValue(item.reason) ?? "unknown"}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {denied.length > 0 ? (
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-xs font-medium text-foreground">denied</div>
              <div className="mt-1 space-y-1">
                {denied.map((item, index) => (
                  <div
                    key={`${stringValue(item.id) ?? index}`}
                    className="break-all text-xs text-muted-foreground"
                  >
                    {stringValue(item.id) ?? "unknown"}:{" "}
                    {stringValue(item.reason) ?? "unknown"}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function approvalContinuationStatus(request: WorkshopLoopApprovalRequest) {
  const continuation = objectValue(request.actionPayload?.continuation);
  return stringValue(continuation.status);
}

function canResumeApproval(request: WorkshopLoopApprovalRequest) {
  return (
    request.status === "approved" &&
    approvalContinuationStatus(request) === "ready"
  );
}

function isOwnerInputOutbox(item: WorkshopOutbox) {
  return stringValue(item.boundaryResult?.status) === "needs_owner_input";
}

function canPreviewOutbox(item: WorkshopOutbox) {
  return !isOwnerInputOutbox(item) && !isOutboxLocked(item.status);
}

function canSendOutbox(item: WorkshopOutbox) {
  return (
    !isOwnerInputOutbox(item) &&
    (item.status === "pending_approval" || item.status === "approved")
  );
}

function MemoryRecallEventCard({ event }: { event: WorkshopEvent }) {
  const metadata = objectValue(event.metadata);
  const memoryRecall = objectValue(metadata.memoryRecall);
  const backend = stringValue(memoryRecall.backend);
  if (!backend) return null;

  const recallPlan = objectValue(memoryRecall.recallPlan);
  const selection = objectValue(memoryRecall.selection);
  const plannerMode = stringValue(recallPlan.mode) ?? "unknown";
  const statuses = stringListValue(recallPlan.statuses);
  const memoryTypes = stringListValue(recallPlan.memoryTypes);
  const canonicalKinds = stringListValue(recallPlan.canonicalKinds);
  const searchTerms = stringListValue(recallPlan.searchTerms);
  const warnings = stringListValue(recallPlan.warnings);
  const routeResults = Array.isArray(memoryRecall.routeResults)
    ? memoryRecall.routeResults
        .map((routeResult) => objectValue(routeResult))
        .map((routeResult) => {
          const route = stringValue(routeResult.route);
          const status = stringValue(routeResult.status);
          const count = numberValue(routeResult.count) ?? 0;
          return route && status ? `${route}:${status}(${count})` : null;
        })
        .filter((item): item is string => Boolean(item))
    : [];
  const routes = Array.isArray(recallPlan.routes)
    ? recallPlan.routes
        .map((route) => objectValue(route))
        .filter((route) => route.enabled !== false)
        .map((route) => {
          const name = stringValue(route.route);
          const purpose = stringValue(route.purpose);
          return name ? `${name}${purpose ? `:${purpose}` : ""}` : null;
        })
        .filter((route): route is string => Boolean(route))
    : [];
  const selectedCount = numberValue(selection.selectedCount) ?? 0;
  const deniedCount = numberValue(selection.deniedCount) ?? 0;
  const omittedCount = numberValue(selection.omittedCount) ?? 0;
  const duplicateCount =
    numberValue(selection.duplicateCanonicalGroupCount) ?? 0;
  const selectedCanonicalKinds = objectValue(selection.selectedCanonicalKinds);
  const canonicalKindRows = Object.entries(selectedCanonicalKinds)
    .map(([kind, count]) => ({
      kind,
      count: numberValue(count) ?? 0,
    }))
    .filter((item) => item.count > 0);

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">Memory recall</Badge>
        <Badge variant={backend === "brain" ? "default" : "secondary"}>
          {backend}
        </Badge>
        <Badge variant={plannerMode === "llm" ? "default" : "secondary"}>
          planner: {plannerMode}
        </Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[
          ["selected", selectedCount],
          ["denied", deniedCount],
          ["omitted", omittedCount],
          ["deduped", duplicateCount],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-md border border-border bg-background p-2"
          >
            <div className="text-muted-foreground">{label}</div>
            <div className="mt-1 font-semibold text-foreground">{value}</div>
          </div>
        ))}
      </div>
      {canonicalKindRows.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {canonicalKindRows.map((item) => (
            <span
              key={item.kind}
              className="rounded-md bg-background px-2 py-1 text-xs text-muted-foreground"
            >
              {item.kind}: {item.count}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
        {statuses.length > 0 ? (
          <div>
            <span className="font-medium text-foreground">statuses: </span>
            {statuses.join(", ")}
          </div>
        ) : null}
        {memoryTypes.length > 0 ? (
          <div>
            <span className="font-medium text-foreground">memoryTypes: </span>
            {memoryTypes.join(", ")}
          </div>
        ) : null}
        {canonicalKinds.length > 0 ? (
          <div>
            <span className="font-medium text-foreground">
              canonicalKinds:{" "}
            </span>
            {canonicalKinds.join(", ")}
          </div>
        ) : null}
        {searchTerms.length > 0 ? (
          <div>
            <span className="font-medium text-foreground">searchTerms: </span>
            {searchTerms.slice(0, 10).join(", ")}
          </div>
        ) : null}
        {routes.length > 0 ? (
          <div>
            <span className="font-medium text-foreground">routes: </span>
            {routes.join(", ")}
          </div>
        ) : null}
        {routeResults.length > 0 ? (
          <div>
            <span className="font-medium text-foreground">
              routeResults:{" "}
            </span>
            {routeResults.join(", ")}
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <div className="text-amber-700 dark:text-amber-300">
            <span className="font-medium">warnings: </span>
            {warnings.join("; ")}
          </div>
        ) : null}
      </div>
      <BrainRecallRetryDetails trace={recallPlan.queryRetryTrace} />
      <BrainContextTraceDetails contextPack={memoryRecall.contextPack} />
    </div>
  );
}

function LoopMemoryRecallPanel({
  memoryRecall,
}: {
  memoryRecall: WorkshopMemoryRecallSummary[];
}) {
  if (memoryRecall.length === 0) return null;

  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <RemixIcon name="brain" size="size-4" />
          Memory recall
        </div>
        <Badge variant="outline">{memoryRecall.length}</Badge>
      </div>
      <div className="space-y-2">
        {memoryRecall.slice(0, 5).map((item) => {
          const recallPlan = objectValue(item.recallPlan);
          const explanation = objectValue(item.explanation);
          const plannerMode = stringValue(recallPlan.mode) ?? "unknown";
          const selectedCount =
            numberValue(explanation.selectedCount) ??
            numberValue(objectValue(item.explanation).selected) ??
            0;
          const deniedCount = numberValue(explanation.deniedCount) ?? 0;
          const omittedCount = numberValue(explanation.omittedCount) ?? 0;
          const duplicateCount =
            numberValue(explanation.duplicateCanonicalGroupCount) ?? 0;
          const routes = Array.isArray(recallPlan.routes)
            ? recallPlan.routes
                .map((route) => objectValue(route))
                .filter((route) => route.enabled !== false)
                .map((route) => {
                  const name = stringValue(route.route);
                  const purpose = stringValue(route.purpose);
                  return name ? `${name}${purpose ? `:${purpose}` : ""}` : null;
                })
                .filter((route): route is string => Boolean(route))
            : [];
          const routeResults = Array.isArray(item.routeResults)
            ? item.routeResults
                .map((routeResult) => objectValue(routeResult))
                .map((routeResult) => {
                  const route = stringValue(routeResult.route);
                  const status = stringValue(routeResult.status);
                  const count = numberValue(routeResult.count) ?? 0;
                  return route && status ? `${route}:${status}(${count})` : null;
                })
                .filter((routeResult): routeResult is string =>
                  Boolean(routeResult),
                )
            : [];
          const warnings = stringListValue(explanation.warnings);

          return (
            <div
              key={`${item.eventId}-${item.createdAt}`}
              className="min-w-0 rounded-md bg-muted/40 px-3 py-2 text-xs leading-5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={item.backend === "brain" ? "default" : "secondary"}
                >
                  {item.backend}
                </Badge>
                <Badge variant={plannerMode === "llm" ? "default" : "outline"}>
                  planner: {plannerMode}
                </Badge>
                <span className="text-muted-foreground">
                  {formatDateTime(item.createdAt)}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["selected", selectedCount],
                  ["denied", deniedCount],
                  ["omitted", omittedCount],
                  ["deduped", duplicateCount],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md bg-background p-2">
                    <div className="text-muted-foreground">{label}</div>
                    <div className="font-medium text-foreground">{value}</div>
                  </div>
                ))}
              </div>
              <div className="mt-2 space-y-1 text-muted-foreground">
                {routes.length > 0 ? (
                  <p>
                    <span className="font-medium text-foreground">routes: </span>
                    {routes.join(", ")}
                  </p>
                ) : null}
                {routeResults.length > 0 ? (
                  <p>
                    <span className="font-medium text-foreground">
                      routeResults:{" "}
                    </span>
                    {routeResults.join(", ")}
                  </p>
                ) : null}
                {item.fallbackReason ? (
                  <p>
                    <span className="font-medium text-foreground">
                      fallback:{" "}
                    </span>
                    {item.fallbackReason}
                  </p>
                ) : null}
                {item.error ? (
                  <p className="text-destructive">
                    <span className="font-medium">error: </span>
                    {item.error}
                  </p>
                ) : null}
                {warnings.length > 0 ? (
                  <p className="text-amber-700 dark:text-amber-300">
                    <span className="font-medium">warnings: </span>
                    {warnings.join("; ")}
                  </p>
                ) : null}
              </div>
              <BrainRecallRetryDetails trace={recallPlan.queryRetryTrace} />
              <BrainContextTraceDetails contextPack={item.contextPack} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MemoryCanonicalSummary({ memory }: { memory: WorkshopMemory }) {
  const canonical = memory.canonical ?? null;
  if (!canonical) return null;
  const admission = objectValue(canonical.admission);
  const admissionAction = stringValue(admission.action);
  const admissionReason = stringValue(admission.reason);
  const existingMemoryId = stringValue(admission.existingMemoryId);
  const mergedMemoryId = stringValue(admission.mergedMemoryId);
  const derivedCount = Array.isArray(canonical.derivedRefs)
    ? canonical.derivedRefs.length
    : 0;

  return (
    <div className="mt-3 space-y-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-1.5">
        {canonical.kind ? (
          <Badge variant="outline">canonical: {canonical.kind}</Badge>
        ) : null}
        {canonical.groupId ? (
          <Badge variant="outline" className="max-w-full truncate">
            group: {canonical.groupId}
          </Badge>
        ) : null}
        {admissionAction ? (
          <Badge variant="secondary">admission: {admissionAction}</Badge>
        ) : null}
        {derivedCount > 0 ? (
          <Badge variant="secondary">derived: {derivedCount}</Badge>
        ) : null}
      </div>
      {admissionReason ||
      existingMemoryId ||
      mergedMemoryId ||
      memory.sourceEventIds?.length ? (
        <div className="space-y-1 rounded-md bg-muted/40 p-2">
          {admissionReason ? (
            <p>
              <span className="font-medium text-foreground">reason: </span>
              {admissionReason}
            </p>
          ) : null}
          {existingMemoryId ? (
            <p>
              <span className="font-medium text-foreground">reused: </span>
              {existingMemoryId}
            </p>
          ) : null}
          {mergedMemoryId ? (
            <p>
              <span className="font-medium text-foreground">merged: </span>
              {mergedMemoryId}
            </p>
          ) : null}
          {memory.sourceEventIds?.length ? (
            <p>
              <span className="font-medium text-foreground">evidence: </span>
              {memory.sourceEventIds.slice(0, 5).join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MemoryRecallQualitySummary({
  report,
}: {
  report: MemoryRecallQualityReport | null;
}) {
  if (!report) return null;
  const summary = report.summary;
  const plannerRows = Object.entries(report.plannerModeCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const feedbackRows = Object.entries(report.feedbackOutcomes)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const traceQuality = report.traceQuality;
  const traceReasonRows = traceQuality
    ? [
        ["selected", traceQuality.topSelectedReasons],
        ["omitted", traceQuality.topOmittedReasons],
        ["denied", traceQuality.topDeniedReasons],
      ]
    : [];
  const traceRequesterRows = report.traceQualityByRequester?.slice(0, 4) ?? [];
  const traceLoopRows = report.traceQualityByLoop?.slice(0, 4) ?? [];
  const traceRunRows = report.traceQualityByRun?.slice(0, 4) ?? [];
  const feedbackLoopRows =
    report.feedbackTraceDiagnosticsByLoop?.slice(0, 4) ?? [];
  const feedbackRunRows =
    report.feedbackTraceDiagnosticsByRun?.slice(0, 4) ?? [];

  return (
    <div role="region" aria-label="记忆质量信息" className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <RemixIcon name="pulse" size="size-4" />
          Recall quality
        </div>
        <Badge variant="outline">{report.period.days}d</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[
          ["recalls", summary.recallCount],
          ["empty", summary.emptyRecallCount],
          ["feedback", summary.feedbackCount],
          ["deduped", summary.duplicateCanonicalGroupCount],
          ["traces", traceQuality?.traceCount ?? 0],
          ["noEvidence", traceQuality?.noEvidenceSelectedCount ?? 0],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md bg-muted/40 p-2">
            <div className="text-muted-foreground">{label}</div>
            <div className="font-medium text-foreground">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">emptyRate: </span>
          {Math.round(summary.emptyRecallRate * 100)}%
        </p>
        {report.routeUsage.length > 0 ? (
          <p>
            <span className="font-medium text-foreground">routes: </span>
            {report.routeUsage
              .slice(0, 8)
              .map((item) => `${item.route}(${item.count})`)
              .join(", ")}
          </p>
        ) : null}
        {plannerRows.length > 0 ? (
          <p>
            <span className="font-medium text-foreground">planner: </span>
            {plannerRows
              .map(([mode, count]) => `${mode}(${count})`)
              .join(", ")}
          </p>
        ) : null}
        {feedbackRows.length > 0 ? (
          <p>
            <span className="font-medium text-foreground">feedback: </span>
            {feedbackRows
              .slice(0, 8)
              .map(([outcome, count]) => `${outcome}(${count})`)
              .join(", ")}
          </p>
        ) : null}
        {traceQuality && traceQuality.traceCount > 0 ? (
          <div className="space-y-1 rounded-md bg-muted/40 p-2">
            <p className="font-medium text-foreground">ContextPack trace</p>
            <p>
              selected {traceQuality.selectedMemoryCount}, omitted{" "}
              {traceQuality.omittedMemoryCount}, denied{" "}
              {traceQuality.deniedMemoryCount}, warnings{" "}
              {traceQuality.warningCount}
            </p>
            {traceQuality.topSelectedCanonicalKinds.length > 0 ? (
              <p>
                <span className="font-medium text-foreground">
                  canonical:{" "}
                </span>
                {traceQuality.topSelectedCanonicalKinds
                  .slice(0, 6)
                  .map((item) => `${item.value}(${item.count})`)
                  .join(", ")}
              </p>
            ) : null}
            {traceReasonRows.map(([label, rows]) =>
              rows.length > 0 ? (
                <p key={label as string}>
                  <span className="font-medium text-foreground">
                    {label as string}:{" "}
                  </span>
                  {(rows as Array<{ value: string; count: number }>)
                    .slice(0, 5)
                    .map((item) => `${item.value}(${item.count})`)
                    .join(", ")}
                </p>
              ) : null,
            )}
            {traceRequesterRows.length > 0 ? (
              <div className="space-y-1 pt-1">
                <p className="font-medium text-foreground">requesters</p>
                {traceRequesterRows.map((item) => {
                  const reason =
                    item.topOmittedReasons[0] ??
                    item.topDeniedReasons[0] ??
                    item.topSelectedReasons[0] ??
                    null;
                  return (
                    <p key={`${item.requesterType}:${item.requesterId ?? ""}`}>
                      <span className="font-medium text-foreground">
                        {item.requesterType}:{item.requesterId ?? "unknown"}{" "}
                      </span>
                      score {item.issueScore}, traces {item.traceCount}, noEvidence{" "}
                      {item.noEvidenceSelectedCount}
                      {reason ? `, ${reason.value}(${reason.count})` : ""}
                    </p>
                  );
                })}
              </div>
            ) : null}
            {traceLoopRows.length > 0 ? (
              <div className="space-y-1 pt-1">
                <p className="font-medium text-foreground">loops</p>
                {traceLoopRows.map((item) => {
                  const reason =
                    item.topOmittedReasons[0] ??
                    item.topDeniedReasons[0] ??
                    item.topSelectedReasons[0] ??
                    null;
                  return (
                    <p key={`${item.workshopId ?? ""}:${item.loopId ?? ""}`}>
                      <span className="font-medium text-foreground">
                        {item.loopId ?? "unknown"}{" "}
                      </span>
                      score {item.issueScore}, traces {item.traceCount}, noEvidence{" "}
                      {item.noEvidenceSelectedCount}
                      {reason ? `, ${reason.value}(${reason.count})` : ""}
                    </p>
                  );
                })}
              </div>
            ) : null}
            {traceRunRows.length > 0 ? (
              <div className="space-y-1 pt-1">
                <p className="font-medium text-foreground">runs</p>
                {traceRunRows.map((item) => {
                  const reason =
                    item.topOmittedReasons[0] ??
                    item.topDeniedReasons[0] ??
                    item.topSelectedReasons[0] ??
                    null;
                  const runLabel =
                    item.loopRunId ?? item.runId ?? item.loopId ?? "unknown";
                  return (
                    <p
                      key={`${item.workshopId ?? ""}:${item.loopId ?? ""}:${
                        item.runId ?? ""
                      }:${item.loopRunId ?? ""}`}
                    >
                      <span className="font-medium text-foreground">
                        {runLabel}{" "}
                      </span>
                      score {item.issueScore}, traces {item.traceCount}, noEvidence{" "}
                      {item.noEvidenceSelectedCount}
                      {reason ? `, ${reason.value}(${reason.count})` : ""}
                    </p>
                  );
                })}
              </div>
            ) : null}
            {feedbackLoopRows.length > 0 ? (
              <div className="space-y-1 pt-1">
                <p className="font-medium text-foreground">
                  feedback x loops
                </p>
                {feedbackLoopRows.map((item) => {
                  const reason =
                    item.traceQuality.topOmittedReasons[0] ??
                    item.traceQuality.topDeniedReasons[0] ??
                    item.traceQuality.topSelectedReasons[0] ??
                    null;
                  const outcomes = Object.entries(item.feedbackOutcomes)
                    .filter(([, count]) => count > 0)
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .slice(0, 3)
                    .map(([outcome, count]) => `${outcome}(${count})`)
                    .join(", ");
                  return (
                    <p key={`${item.workshopId ?? ""}:${item.loopId ?? ""}`}>
                      <span className="font-medium text-foreground">
                        {item.loopId ?? "unknown"}{" "}
                      </span>
                      score {item.diagnosticScore}, feedback{" "}
                      {item.feedbackCount}
                      {outcomes ? `, ${outcomes}` : ""}
                      {reason ? `, ${reason.value}(${reason.count})` : ""}
                    </p>
                  );
                })}
              </div>
            ) : null}
            {feedbackRunRows.length > 0 ? (
              <div className="space-y-1 pt-1">
                <p className="font-medium text-foreground">
                  feedback x runs
                </p>
                {feedbackRunRows.map((item) => {
                  const reason =
                    item.traceQuality.topOmittedReasons[0] ??
                    item.traceQuality.topDeniedReasons[0] ??
                    item.traceQuality.topSelectedReasons[0] ??
                    null;
                  const outcomes = Object.entries(item.feedbackOutcomes)
                    .filter(([, count]) => count > 0)
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .slice(0, 3)
                    .map(([outcome, count]) => `${outcome}(${count})`)
                    .join(", ");
                  const runLabel =
                    item.loopRunId ?? item.runId ?? item.loopId ?? "unknown";
                  return (
                    <p
                      key={`${item.workshopId ?? ""}:${item.loopId ?? ""}:${
                        item.runId ?? ""
                      }:${item.loopRunId ?? ""}`}
                    >
                      <span className="font-medium text-foreground">
                        {runLabel}{" "}
                      </span>
                      score {item.diagnosticScore}, feedback{" "}
                      {item.feedbackCount}
                      {outcomes ? `, ${outcomes}` : ""}
                      {reason ? `, ${reason.value}(${reason.count})` : ""}
                    </p>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        <p>
          <span className="font-medium text-foreground">coverage: </span>
          {report.coverage.contextLogs} context logs,{" "}
          {report.coverage.feedbackEvents} feedback events,{" "}
          {report.coverage.contextTraceEvents ?? 0} trace events
        </p>
      </div>
    </div>
  );
}

function isWatchlistProposalEvent(event: WorkshopEvent) {
  return (
    event.type === "watchlist_proposal" &&
    event.metadata?.kind === "watchlist_change_proposal"
  );
}

function watchlistProposalResolution(
  events: WorkshopEvent[],
  proposal: WorkshopEvent,
) {
  const proposalId =
    typeof proposal.metadata?.proposalId === "string"
      ? proposal.metadata.proposalId
      : null;
  return events.find((event) => {
    if (
      event.type !== "watchlist_proposal_applied" &&
      event.type !== "watchlist_proposal_rejected"
    ) {
      return false;
    }
    return (
      event.metadata?.sourceProposalEventId === proposal.id ||
      (proposalId && event.metadata?.proposalId === proposalId)
    );
  });
}

function pendingWatchlistProposalEvents(events: WorkshopEvent[]) {
  return events
    .filter(
      (event) =>
        isWatchlistProposalEvent(event) &&
        event.metadata?.status === "pending_approval" &&
        event.metadata?.approvalRequired !== false &&
        !watchlistProposalResolution(events, event),
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        b.seq - a.seq,
    );
}

function isVideoReviewEvent(event: WorkshopEvent) {
  return (
    event.type === "video_review_approved" ||
    event.type === "video_review_rejected" ||
    event.type === "video_review_regenerate_requested"
  );
}

function isAgentChangeProposalEvent(event: WorkshopEvent) {
  return event.type === "workshop_agent_change_proposed";
}

function isAgentChangeResolutionEvent(event: WorkshopEvent) {
  return (
    event.type === "workshop_agent_change_applied" ||
    event.type === "workshop_agent_change_rejected" ||
    event.type === "workshop_agent_change_superseded"
  );
}

function agentChangeProposalResolution(
  events: WorkshopEvent[],
  proposal: WorkshopEvent,
) {
  return events.find(
    (event) =>
      isAgentChangeResolutionEvent(event) &&
      event.metadata?.proposalEventId === proposal.id,
  );
}

function pendingAgentChangeProposalEvents(events: WorkshopEvent[]) {
  return events
    .filter(
      (event) =>
        isAgentChangeProposalEvent(event) &&
        !agentChangeProposalResolution(events, event),
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        b.seq - a.seq,
    );
}

function videoDraftBelongsToWorkshop(
  draft: DouyinDraftSummary,
  workshopId: string,
) {
  const source = objectValue(draft.source);
  if (source.workshopId === workshopId) return true;
  return draft.video_path.includes(workshopId);
}

function videoDraftReviewResolution(
  events: WorkshopEvent[],
  draft: DouyinDraftSummary,
) {
  return events.find(
    (event) =>
      isVideoReviewEvent(event) &&
      stringValue(event.metadata?.draftId) === draft.id,
  );
}

function pendingVideoDrafts(
  drafts: DouyinDraftSummary[],
  events: WorkshopEvent[],
  workshopId: string | null,
) {
  if (!workshopId) return [];
  return drafts
    .filter(
      (draft) =>
        draft.status === "draft" &&
        videoDraftBelongsToWorkshop(draft, workshopId) &&
        !videoDraftReviewResolution(events, draft),
    )
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
}

function workRoleLabel(value: string) {
  const labels: Record<string, string> = {
    paper_trader: "操盘交易员",
    watchlist_selector: "自选股猎手",
    owner_context_steward: "知识库管家",
    investment_publisher: "投研发布官",
    general_workshop: "通用车间",
  };
  return labels[value] ?? value;
}

function compactWorkshopMission(mission: string, maxLength = 42) {
  const text = mission.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}

function workshopDisplayDescription(workshop: Workshop) {
  const modelConfig =
    workshop.modelConfig && typeof workshop.modelConfig === "object"
      ? workshop.modelConfig
      : {};
  const role =
    typeof modelConfig.role === "string" ? modelConfig.role : undefined;
  const manifestName =
    typeof modelConfig.manifestName === "string"
      ? modelConfig.manifestName
      : undefined;

  const summaries: Record<string, string> = {
    watchlist_selector: "发现候选、维护自选股池，输出可审计调整提案。",
    paper_trader: "消费自选股，执行模拟盘计划、交易和复盘。",
    owner_context_steward: "沉淀主人上下文，维护可引用的长期记忆。",
    investment_publisher: "整理投研内容，生成可审核的发布草稿。",
    general_workshop: "持续观测、沉淀记忆，并按边界推进任务。",
  };

  if (role && summaries[role]) return summaries[role];
  if (manifestName === "watchlist-hunter") return summaries.watchlist_selector;
  if (manifestName === "paper-trader") return summaries.paper_trader;

  return compactWorkshopMission(workshop.mission);
}

function skillStatusLabel(value: "bound" | "missing" | "unmapped") {
  const labels = {
    bound: "已绑定",
    missing: "缺失",
    unmapped: "未映射",
  };
  return labels[value];
}

function skillStatusClass(value: "bound" | "missing" | "unmapped") {
  if (value === "bound") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (value === "missing") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function isSystemGovernanceLoopBinding(
  loop: WorkshopWorkModel["loopBindings"][number],
) {
  return (
    loop.name === "Work 自检升级" ||
    loop.requiredFields.includes("workHealthSummary")
  );
}

function loopSkillStatusLabel(loop: WorkshopWorkModel["loopBindings"][number]) {
  return isSystemGovernanceLoopBinding(loop)
    ? "内置治理"
    : skillStatusLabel(loop.skillStatus);
}

function loopSkillStatusClass(loop: WorkshopWorkModel["loopBindings"][number]) {
  if (isSystemGovernanceLoopBinding(loop)) {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  return skillStatusClass(loop.skillStatus);
}

function loopSkillDescription(loop: WorkshopWorkModel["loopBindings"][number]) {
  if (isSystemGovernanceLoopBinding(loop)) {
    return "使用工作自检模板内置治理规则，不需要绑定业务方法论";
  }
  return loop.skillName ? workDisplayLabel(loop.skillName) : "未映射方法论";
}

function CompactTagList({
  values,
  empty,
  max = 8,
  label = workDisplayLabel,
}: {
  values: string[];
  empty: string;
  max?: number;
  label?: (value: string) => string;
}) {
  const visible = values.slice(0, max);
  return values.length === 0 ? (
    <p className="text-sm text-muted-foreground">{empty}</p>
  ) : (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((value) => (
        <span
          key={value}
          className="max-w-full break-all rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          {label(value)}
        </span>
      ))}
      {values.length > max ? (
        <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          +{values.length - max}
        </span>
      ) : null}
    </div>
  );
}

function WorkMetric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-foreground">
        {value}
      </div>
    </div>
  );
}

function piGreyStatusLabel(
  status: WorkshopWorkModel["runtime"]["piGreyReadiness"]["status"],
) {
  const labels = {
    not_requested: "未请求 Pi",
    eligible: "可低风险灰度",
    needs_tool_migration: "需迁移工具",
    blocked: "暂不适合灰度",
  };
  return labels[status];
}

function piGreyStatusClass(
  status: WorkshopWorkModel["runtime"]["piGreyReadiness"]["status"],
) {
  if (status === "eligible") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "blocked") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (status === "needs_tool_migration") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function runtimeEngineLabel(engine: WorkshopWorkModel["runtime"]["engine"]) {
  return engine === "pi" ? "Pi" : "Claude";
}

function runtimeSourceLabel(source: WorkshopWorkModel["runtime"]["source"]) {
  if (source === "config") return "配置指定";
  if (source === "env") return "环境变量指定";
  return "默认";
}

function formatWorkVersion(value: string | null | undefined) {
  if (!value) return "暂无版本";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return formatDateTime(value);
  return value;
}

function recentAgentChangeProposalEvents(events: WorkshopEvent[], limit = 5) {
  return events
    .filter(isAgentChangeProposalEvent)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        b.seq - a.seq,
    )
    .slice(0, limit);
}

function agentChangeStatusLabel(
  proposal: WorkshopEvent,
  resolution: WorkshopEvent | undefined,
  currentWorkVersion: string,
) {
  if (resolution?.type === "workshop_agent_change_applied") return "已应用";
  if (resolution?.type === "workshop_agent_change_rejected") return "已驳回";
  if (resolution?.type === "workshop_agent_change_superseded") return "已重建";
  const proposalVersion = stringValue(proposal.metadata?.workModelVersion);
  if (proposalVersion && proposalVersion !== currentWorkVersion)
    return "已过期";
  return "待审核";
}

function agentChangeStatusClass(status: string) {
  if (status === "已应用") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "已过期") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (status === "待审核") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (status === "已重建") {
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function WorkChangeHistory({
  work,
  events,
}: {
  work: WorkshopWorkModel;
  events: WorkshopEvent[];
}) {
  const proposals = recentAgentChangeProposalEvents(events);
  const staleCount = proposals.filter((proposal) => {
    const resolution = agentChangeProposalResolution(events, proposal);
    const proposalVersion = stringValue(proposal.metadata?.workModelVersion);
    return (
      !resolution &&
      proposalVersion !== null &&
      proposalVersion !== work.manifest.version
    );
  }).length;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">最近配置变更</h4>
        <Badge variant={staleCount > 0 ? "destructive" : "outline"}>
          {proposals.length}
        </Badge>
      </div>
      {staleCount > 0 ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
          有 {staleCount} 个提案基于旧版本创建，需要重新生成提案后再提交。
        </div>
      ) : null}
      <div className="mt-3 space-y-2">
        {proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无配置变更记录。</p>
        ) : (
          proposals.map((proposal) => {
            const resolution = agentChangeProposalResolution(events, proposal);
            const status = agentChangeStatusLabel(
              proposal,
              resolution,
              work.manifest.version,
            );
            const diff = Array.isArray(proposal.metadata?.diff)
              ? proposal.metadata.diff.filter(
                  (item): item is Record<string, unknown> =>
                    Boolean(item) &&
                    typeof item === "object" &&
                    !Array.isArray(item),
                )
              : [];
            const changedFields = diff
              .map((item) => stringValue(item.field))
              .filter((item): item is string => Boolean(item));
            const proposalVersion = stringValue(
              proposal.metadata?.workModelVersion,
            );
            const appliedVersion = stringValue(
              resolution?.metadata?.workVersionAfter,
            );

            return (
              <div
                key={proposal.id}
                className="rounded-md border border-border bg-background p-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-words text-sm font-medium text-foreground">
                      {proposal.title}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {formatDateTime(proposal.createdAt)}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-md border px-2 py-1 text-xs",
                      agentChangeStatusClass(status),
                    )}
                  >
                    {status}
                  </span>
                </div>
                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">基于版本</span>
                    <p className="mt-1 break-all text-foreground">
                      {formatWorkVersion(proposalVersion)}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">应用后版本</span>
                    <p className="mt-1 break-all text-foreground">
                      {formatWorkVersion(appliedVersion)}
                    </p>
                  </div>
                </div>
                <div className="mt-2">
                  <CompactTagList
                    values={changedFields}
                    empty="暂无字段差异"
                    max={6}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function workVersionSourceLabel(source: string) {
  const labels: Record<string, string> = {
    created: "创建",
    manual_update: "手动修改",
    agent_change_apply: "提案应用",
    restore: "版本恢复",
  };
  return labels[source] ?? source;
}

function WorkVersionHistory({
  currentVersion,
  versions,
  restoringVersionId,
  onRestore,
}: {
  currentVersion: string;
  versions: WorkshopWorkVersion[];
  restoringVersionId: string | null;
  onRestore: (version: WorkshopWorkVersion) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">工作版本历史</h4>
        <Badge variant="outline">{versions.length}</Badge>
      </div>
      {versions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          暂无结构化版本快照，下一次创建、修改或应用提案后会自动记录。
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {versions.map((version) => {
            const isCurrent = version.version === currentVersion;
            return (
              <div
                key={version.id}
                className="rounded-md border border-border bg-background p-2 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-all font-medium text-foreground">
                      {formatWorkVersion(version.version)}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {workVersionSourceLabel(version.source)} /{" "}
                      {formatDateTime(version.createdAt)}
                    </div>
                  </div>
                  {isCurrent ? (
                    <Badge variant="secondary">当前</Badge>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline">{version.createdBy}</Badge>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs"
                        disabled={restoringVersionId === version.id}
                        onClick={() => onRestore(version)}
                      >
                        <RemixIcon name="restart" size="size-3.5" />
                        {restoringVersionId === version.id ? "恢复中" : "恢复"}
                      </Button>
                    </div>
                  )}
                </div>
                {Object.keys(version.patch ?? {}).length > 0 ? (
                  <div className="mt-2 rounded-md bg-muted px-2 py-1 text-muted-foreground">
                    变更字段：{Object.keys(version.patch).join(" / ")}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WorkPanel({
  work,
  events,
  versions,
  restoringVersionId,
  onRestoreVersion,
}: {
  work: WorkshopWorkModel | null;
  events: WorkshopEvent[];
  versions: WorkshopWorkVersion[];
  restoringVersionId: string | null;
  onRestoreVersion: (version: WorkshopWorkVersion) => void;
}) {
  if (!work) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        正在读取工作模型...
      </div>
    );
  }

  const problems = [
    ...work.observability.missing.map((item) => `缺失：${item}`),
    ...work.observability.warnings,
  ];
  const piReadiness = work.runtime.piGreyReadiness;
  const piProblemTools = [
    ...piReadiness.blockedTools,
    ...piReadiness.needsMigrationTools,
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {workRoleLabel(work.manifest.role)}
              </Badge>
              <Badge variant="outline">
                {dashboardStatusLabel(work.manifest.status)}
              </Badge>
              <Badge variant="outline">
                边界 {workDisplayLabel(work.controlContract.boundaryMode)}
              </Badge>
            </div>
            <h4 className="mt-2 break-words text-sm font-medium text-foreground">
              {work.manifest.name}
            </h4>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {work.manifest.mission}
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <WorkMetric
            label="版本"
            value={formatWorkVersion(work.manifest.version)}
          />
          <WorkMetric
            label="下次工作"
            value={formatDateTime(work.feedback.nextWakeupAt)}
          />
          <WorkMetric
            label="可用动作"
            value={work.controlContract.allowedActions.length}
          />
          <WorkMetric
            label="需审核"
            value={work.controlContract.approvalRequiredActions.length}
          />
        </div>
      </div>

      <div
        className={cn(
          "rounded-lg border p-3",
          piGreyStatusClass(piReadiness.status),
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-medium">底座迁移</h4>
            <p className="mt-1 text-xs leading-5">
              当前引擎：{runtimeEngineLabel(work.runtime.engine)}
              （{runtimeSourceLabel(work.runtime.source)}）
              。{piReadiness.reasons[0] ?? piGreyStatusLabel(piReadiness.status)}
            </p>
          </div>
          <Badge variant={piReadiness.eligible ? "secondary" : "outline"}>
            {piGreyStatusLabel(piReadiness.status)}
          </Badge>
        </div>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <div className="rounded-md bg-background/60 p-2">
            只读工具 {piReadiness.summary.counts.read}
          </div>
          <div className="rounded-md bg-background/60 p-2">
            已迁移写工具 {piReadiness.migratedWriteTools.length}
          </div>
          <div className="rounded-md bg-background/60 p-2">
            需处理工具 {piProblemTools.length}
          </div>
        </div>
        {piReadiness.migratedWriteTools.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs font-medium">已接入 Pi 的安全写工具</p>
            <div className="mt-2">
              <CompactTagList
                values={piReadiness.migratedWriteTools}
                empty="暂无"
                max={6}
              />
            </div>
          </div>
        ) : null}
        {piReadiness.policyScopedMigratedWriteTools.length > 0 ? (
          <div className="mt-3 rounded-md border border-dashed bg-background/40 p-2 text-xs leading-5">
            <p className="font-medium">策略限定工具</p>
            <p className="mt-1 text-muted-foreground">
              这些工具已有 Pi handler，但只有当前 Work 策略显式点名时才会被执行层放行。
            </p>
            <div className="mt-2">
              <CompactTagList
                values={piReadiness.policyScopedMigratedWriteTools}
                empty="暂无"
                max={4}
              />
            </div>
          </div>
        ) : null}
        {piProblemTools.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs font-medium">暂不纳入低风险灰度的工具</p>
            <div className="mt-2 space-y-1">
              {piProblemTools.slice(0, 6).map((tool) => (
                <p key={`${tool.toolName}:${tool.risk}`} className="break-all text-xs">
                  {tool.toolName}：{workDisplayLabel(tool.risk)}
                </p>
              ))}
              {piProblemTools.length > 6 ? (
                <p className="text-xs">还有 {piProblemTools.length - 6} 个工具。</p>
              ) : null}
            </div>
          </div>
        ) : null}
        {piReadiness.nextSteps.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs font-medium">下一步</p>
            <div className="mt-2 space-y-2">
              {piReadiness.nextSteps.slice(0, 3).map((step) => (
                <div
                  key={step.code}
                  className="rounded-md bg-background/60 p-2 text-xs leading-5"
                >
                  <div className="font-medium">{step.label}</div>
                  <div>{step.detail}</div>
                  {step.toolNames && step.toolNames.length > 0 ? (
                    <div className="mt-1 break-all">
                      工具：{step.toolNames.slice(0, 6).join(" / ")}
                      {step.toolNames.length > 6
                        ? ` / +${step.toolNames.length - 6}`
                        : ""}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {problems.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
            <RemixIcon name="alert" size="size-4" />
            工作区需要处理
          </div>
          <div className="mt-2 space-y-1 text-xs leading-5 text-amber-700 dark:text-amber-300">
            {problems.map((problem) => (
              <p key={problem}>{problem}</p>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
          控制契约、方法论和任务映射当前完整。
        </div>
      )}

      <div className="rounded-lg border border-border p-3">
        <h4 className="text-sm font-medium text-foreground">控制契约</h4>
        <div className="mt-3 space-y-3">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              被控对象
            </div>
            <CompactTagList
              values={work.controlContract.controlledObjects}
              empty="未声明被控对象"
            />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              观测输入
            </div>
            <CompactTagList
              values={work.controlContract.observations}
              empty="未声明观测输入"
              max={10}
            />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              禁止动作
            </div>
            <CompactTagList
              values={work.controlContract.deniedActions}
              empty="暂无显式禁止动作"
              max={10}
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-foreground">方法论</h4>
          <Badge variant="outline">
            {work.skillBindings.primarySkills.length}
          </Badge>
        </div>
        <div className="mt-3">
          <CompactTagList
            values={work.skillBindings.primarySkills}
            empty="未绑定主要方法论"
            max={12}
          />
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-foreground">任务映射</h4>
          <Badge variant="outline">{work.loopBindings.length}</Badge>
        </div>
        <div className="mt-3 space-y-2">
          {work.loopBindings.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无任务</p>
          ) : (
            work.loopBindings.map((loop) => (
              <div
                key={loop.id}
                className="rounded-md border border-border bg-background p-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {loop.name}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {workDisplayLabel(loop.triggerType)} /{" "}
                      {loop.requiredFields.length} 个校验字段
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-md border px-2 py-1 text-xs",
                      loopSkillStatusClass(loop),
                    )}
                  >
                    {loopSkillStatusLabel(loop)}
                  </span>
                </div>
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  {loopSkillDescription(loop)}
                </p>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-foreground">汇报设计</h4>
          <Badge variant="outline">
            {work.presentationContract.source === "manifest" ? "已定制" : "通用模板"}
          </Badge>
        </div>
        <p className="mt-2 text-sm leading-6 text-foreground">
          {work.presentationContract.purpose}
        </p>
        <div className="mt-3 space-y-3">
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">汇报章节</p>
            <CompactTagList values={work.presentationContract.requiredSections}
              empty="暂无章节要求" max={8} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">预期成果</p>
            <CompactTagList values={work.presentationContract.expectedArtifacts}
              empty="按任务实际成果展示" max={8} />
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          结论由运行状态核定，依据来自工作记录，成果来自已登记回执。
        </p>
      </div>

      <div className="rounded-lg border border-border p-3">
        <h4 className="text-sm font-medium text-foreground">变更边界</h4>
        <div className="mt-3 space-y-3">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              高风险，必须审核
            </div>
            <CompactTagList
              values={work.changeControl.highRiskChanges}
              empty="暂无"
              max={8}
            />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              中风险，进入提案
            </div>
            <CompactTagList
              values={work.changeControl.mediumRiskChanges}
              empty="暂无"
              max={8}
            />
          </div>
        </div>
      </div>

      <WorkChangeHistory work={work} events={events} />
      <WorkVersionHistory
        currentVersion={work.manifest.version}
        versions={versions}
        restoringVersionId={restoringVersionId}
        onRestore={onRestoreVersion}
      />
    </div>
  );
}

function workLogEvents(events: WorkshopEvent[]) {
  return events.filter(
    (event) =>
      !(
        event.type === "agent_text" &&
        event.title.toLowerCase().includes("partial")
      ) &&
      (!isWatchlistProposalEvent(event) ||
        Boolean(watchlistProposalResolution(events, event)) ||
        event.metadata?.status !== "pending_approval" ||
        event.metadata?.approvalRequired === false) &&
      (!isAgentChangeProposalEvent(event) ||
        Boolean(agentChangeProposalResolution(events, event))),
  );
}

function proposalStatusText(
  proposal: WorkshopEvent,
  resolution: WorkshopEvent | undefined,
) {
  if (resolution?.type === "watchlist_proposal_applied") return "已应用";
  if (resolution?.type === "watchlist_proposal_rejected") return "已拒绝";
  const status =
    typeof proposal.metadata?.status === "string"
      ? proposal.metadata.status
      : "pending_approval";
  if (status === "invalid") return "校验未过";
  if (status === "pending_approval") return "待确认";
  return status;
}

function WatchlistProposalEventCard({
  event,
  resolution,
  actionId,
  onResolve,
}: {
  event: WorkshopEvent;
  resolution?: WorkshopEvent;
  actionId: string | null;
  onResolve: (eventId: string, action: "apply" | "reject") => void;
}) {
  const metadata = event.metadata ?? {};
  const validation = objectValue(metadata.validation);
  const before = metadataStringList(metadata.before);
  const current = metadataStringList(metadata.current);
  const after = metadataStringList(metadata.after);
  const add = metadataStringList(metadata.add);
  const adds = metadataStringList(metadata.adds);
  const remove = metadataStringList(metadata.remove);
  const removes = metadataStringList(metadata.removes);
  const issues = metadataStringList(validation.issues);
  const warnings = metadataStringList(validation.warnings);
  const reason = stringValue(metadata.reason);
  const risk = stringValue(metadata.risk);
  const canApply =
    !resolution &&
    metadata.status === "pending_approval" &&
    validation.ok === true &&
    after.length > 0;
  const isApplying = actionId === `apply:${event.id}`;
  const isRejecting = actionId === `reject:${event.id}`;

  return (
    <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline">{proposalStatusText(event, resolution)}</Badge>
        {resolution ? (
          <span className="text-xs text-muted-foreground">
            {formatDateTime(resolution.createdAt)}
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <div className="text-muted-foreground">当前列表</div>
          <p className="mt-1 break-words text-foreground">
            {(before.length > 0 ? before : current).join(", ") || "-"}
          </p>
        </div>
        <div>
          <div className="text-muted-foreground">应用后列表</div>
          <p className="mt-1 break-words text-foreground">
            {after.join(", ") || "-"}
          </p>
        </div>
        <div>
          <div className="text-muted-foreground">加入</div>
          <p className="mt-1 break-words text-foreground">
            {(add.length > 0 ? add : adds).join(", ") || "-"}
          </p>
        </div>
        <div>
          <div className="text-muted-foreground">移除</div>
          <p className="mt-1 break-words text-foreground">
            {(remove.length > 0 ? remove : removes).join(", ") || "-"}
          </p>
        </div>
      </div>
      {reason || risk ? (
        <div className="mt-3 space-y-1 text-xs leading-5">
          {reason ? (
            <p>
              <span className="text-muted-foreground">理由</span>
              {reason}
            </p>
          ) : null}
          {risk ? (
            <p>
              <span className="text-muted-foreground">风险</span>
              {risk}
            </p>
          ) : null}
        </div>
      ) : null}
      {issues.length > 0 ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
          {issues.join(" / ")}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-background/60 p-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
          {warnings.join(" / ")}
        </div>
      ) : null}
      {!resolution ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => onResolve(event.id, "apply")}
            disabled={!canApply || Boolean(actionId)}
            className="gap-2"
          >
            <RemixIcon
              name={isApplying ? "loader" : "checkbox_circle"}
              size="size-4"
            />
            确认应用
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onResolve(event.id, "reject")}
            disabled={Boolean(actionId)}
            className="gap-2"
          >
            <RemixIcon name={isRejecting ? "loader" : "close"} size="size-4" />
            拒绝
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function VideoReviewCard({
  draft,
  actionId,
  onResolve,
}: {
  draft: DouyinDraftSummary;
  actionId: string | null;
  onResolve: (
    draftId: string,
    action: "approve" | "reject" | "regenerate",
  ) => void;
}) {
  const source = objectValue(draft.source);
  const sourceEventIds = stringListValue(source.sourceEventIds);
  const isApproving = actionId === `approve:${draft.id}`;
  const isRejecting = actionId === `reject:${draft.id}`;
  const isRegenerating = actionId === `regenerate:${draft.id}`;

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">视频发布审核</Badge>
            <Badge variant="outline">{draft.status}</Badge>
            {draft.ai_generated ? (
              <Badge variant="outline">模型生成</Badge>
            ) : null}
          </div>
          <h4 className="mt-2 break-words text-sm font-medium text-foreground">
            {draft.title}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            更新时间 {formatDateTime(draft.updated_at)}
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(260px,360px),1fr]">
        <div className="overflow-hidden rounded-md border border-border bg-black">
          <video
            controls
            preload="metadata"
            className="aspect-video w-full bg-black"
            src={`/api/douyin/drafts/${encodeURIComponent(draft.id)}/video`}
          />
        </div>
        <div className="space-y-3 text-xs leading-5">
          <div>
            <div className="font-medium text-muted-foreground">发布文案</div>
            <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-foreground">
              {draft.description || "暂无文案"}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <div className="text-muted-foreground">话题</div>
              <p className="mt-1 break-words text-foreground">
                {(draft.topics ?? []).join(" / ") || "-"}
              </p>
            </div>
            <div>
              <div className="text-muted-foreground">发布账号</div>
              <p className="mt-1 break-words text-foreground">
                {draft.account_label || "默认账号"}
              </p>
            </div>
            <div>
              <div className="text-muted-foreground">来源运行</div>
              <p className="mt-1 break-words text-foreground">
                {stringValue(source.runId) ?? "-"}
              </p>
            </div>
            <div>
              <div className="text-muted-foreground">引用事件</div>
              <p className="mt-1 break-words text-foreground">
                {sourceEventIds.length ? `${sourceEventIds.length} 条` : "-"}
              </p>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">本地文件</div>
            <p className="mt-1 break-all text-foreground">{draft.video_path}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => onResolve(draft.id, "approve")}
          disabled={Boolean(actionId)}
          className="gap-2"
        >
          <RemixIcon
            name={isApproving ? "loader" : "checkbox_circle"}
            size="size-4"
          />
          通过并生成上传计划
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onResolve(draft.id, "regenerate")}
          disabled={Boolean(actionId)}
          className="gap-2"
        >
          <RemixIcon
            name={isRegenerating ? "loader" : "refresh"}
            size="size-4"
          />
          要求重生成
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onResolve(draft.id, "reject")}
          disabled={Boolean(actionId)}
          className="gap-2"
        >
          <RemixIcon name={isRejecting ? "loader" : "close"} size="size-4" />
          驳回
        </Button>
      </div>
    </div>
  );
}

function formatDiffValue(value: unknown) {
  if (value === undefined) return "未设置";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function AgentChangeProposalCard({
  event,
  actionId,
  currentWorkVersion,
  onResolve,
  onRefresh,
}: {
  event: WorkshopEvent;
  actionId: string | null;
  currentWorkVersion: string | null;
  onResolve: (eventId: string, action: WorkshopAgentChangeAction) => void;
  onRefresh: () => void;
}) {
  const metadata = event.metadata ?? {};
  const diff = Array.isArray(metadata.diff)
    ? metadata.diff.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const riskLevel = stringValue(metadata.riskLevel) ?? "medium";
  const proposedBy = stringValue(metadata.proposedBy) ?? "chat_agent";
  const proposalVersion = stringValue(metadata.workModelVersion);
  const isStale =
    proposalVersion !== null &&
    currentWorkVersion !== null &&
    proposalVersion !== currentWorkVersion;
  const isApplying = actionId === `apply:${event.id}`;
  const isRejecting = actionId === `reject:${event.id}`;
  const isRecreating = actionId === `recreate:${event.id}`;

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">智能体配置变更</Badge>
            <Badge variant="outline">风险 {riskLevel}</Badge>
            <Badge variant="outline">{proposedBy}</Badge>
            {isStale ? <Badge variant="destructive">已过期</Badge> : null}
          </div>
          <h4 className="mt-2 break-words text-sm font-medium text-foreground">
            {event.title}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatDateTime(event.createdAt)}
          </p>
        </div>
      </div>

      {event.body ? (
        <p className="mt-3 whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-xs leading-5 text-foreground">
          {eventDisplayBody(event)}
        </p>
      ) : null}

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <span className="text-muted-foreground">提案基于版本</span>
          <p className="mt-1 break-all text-foreground">
            {formatWorkVersion(proposalVersion)}
          </p>
        </div>
        <div>
          <span className="text-muted-foreground">当前 Work 版本</span>
          <p className="mt-1 break-all text-foreground">
            {formatWorkVersion(currentWorkVersion)}
          </p>
        </div>
      </div>

      {isStale ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
          这个提案创建后，Work
          配置已经变化。为避免覆盖新配置，不能直接应用。可以基于当前 Work
          版本重新生成一份新提案，再进入审核。
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        {diff.length === 0 ? (
          <div className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
            暂无可展示的字段差异。
          </div>
        ) : (
          diff.map((item, index) => (
            <div
              key={`${String(item.field ?? index)}:${index}`}
              className="rounded-md border border-border bg-muted/20 p-2 text-xs"
            >
              <div className="font-medium text-foreground">
                字段：{String(item.field ?? "-")}
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <div>
                  <div className="text-muted-foreground">修改前</div>
                  <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-foreground">
                    {formatDiffValue(item.before)}
                  </pre>
                </div>
                <div>
                  <div className="text-muted-foreground">修改后</div>
                  <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-foreground">
                    {formatDiffValue(item.after)}
                  </pre>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => onResolve(event.id, "apply")}
          disabled={isStale || Boolean(actionId)}
          className="gap-2"
        >
          <RemixIcon
            name={isApplying ? "loader" : "checkbox_circle"}
            size="size-4"
          />
          应用修改
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onResolve(event.id, "reject")}
          disabled={Boolean(actionId)}
          className="gap-2"
        >
          <RemixIcon name={isRejecting ? "loader" : "close"} size="size-4" />
          驳回
        </Button>
        {isStale ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onResolve(event.id, "recreate")}
            disabled={Boolean(actionId)}
            className="gap-2"
          >
            <RemixIcon
              name={isRecreating ? "loader" : "refresh"}
              size="size-4"
            />
            重新生成提案
          </Button>
        ) : null}
        {isStale ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={Boolean(actionId)}
            className="gap-2"
          >
            <RemixIcon name="refresh" size="size-4" />
            重新读取 Work
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function proposalDetails(loop: WorkshopDashboardLoop) {
  const loopSpec = objectValue(loop.stateJson.loopSpec);
  const context = objectValue(loopSpec.context);
  const actions = objectValue(loopSpec.actions);
  const verification = objectValue(loopSpec.verification);
  const proposalReason =
    stringValue(loop.stateJson.proposalReason) ??
    stringValue(loop.stateJson.proposal_reason);
  const sources = sourceNamesFromSpec(context.sources);
  const successCriteria = stringListValue(verification.successCriteria).slice(
    0,
    3,
  );
  const requiresApproval = stringListValue(actions.requiresApproval);
  const denied = stringListValue(actions.denied);
  const allowed = stringListValue(actions.allowed);
  const actionBoundary = denied.length
    ? `禁止：${denied.slice(0, 3).join("、")}`
    : requiresApproval.length
      ? `需确认：${requiresApproval.slice(0, 3).join("、")}`
      : allowed.length
        ? `允许：${allowed.slice(0, 3).join("、")}`
        : loop.spaceSummary?.permissionLabel;

  return {
    proposalReason,
    triggerLabel: loop.spaceSummary?.triggerLabel ?? loop.status,
    contextLabel:
      sources.length > 0
        ? sources.slice(0, 3).join("")
        : loop.spaceSummary?.contextLabel,
    actionBoundary,
    successCriteria,
  };
}

function LoopProposalDetails({
  loop,
  compact = false,
}: {
  loop: WorkshopDashboardLoop;
  compact?: boolean;
}) {
  const details = proposalDetails(loop);
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div
        className={cn(
          "grid gap-2 text-xs",
          compact ? "grid-cols-1" : "sm:grid-cols-2",
        )}
      >
        <div>
          <span className="text-muted-foreground">触发</span>
          <p className="mt-1 line-clamp-2 text-foreground">
            {details.triggerLabel}
          </p>
        </div>
        <div>
          <span className="text-muted-foreground">边界</span>
          <p className="mt-1 line-clamp-2 text-foreground">
            {details.actionBoundary ?? "按车间边界执行"}
          </p>
        </div>
        {details.contextLabel ? (
          <div>
            <span className="text-muted-foreground">资料</span>
            <p className="mt-1 line-clamp-2 text-foreground">
              {details.contextLabel}
            </p>
          </div>
        ) : null}
        {details.proposalReason ? (
          <div>
            <span className="text-muted-foreground">原因</span>
            <p className="mt-1 line-clamp-2 text-foreground">
              {details.proposalReason}
            </p>
          </div>
        ) : null}
      </div>
      {details.successCriteria.length > 0 ? (
        <div className="space-y-1 text-xs">
          <span className="text-muted-foreground">成功标准</span>
          <ul className="space-y-1 text-foreground">
            {details.successCriteria.map((criterion) => (
              <li key={criterion} className="line-clamp-2">
                {criterion}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function LoopDetailMetric({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">
        {value ?? "暂无"}
      </p>
    </div>
  );
}

function LoopTaskDetailDialog({
  loop: summaryLoop,
  detail,
  loading,
  events,
  open,
  onOpenChange,
  onRun,
  onActivate,
  onReject,
  onPause,
  onResume,
  onDelete,
  onResolveApproval,
  onResumeApproval,
  onPreviewOutbox,
  onSendOutbox,
  onReconcileOutbox,
  running,
  updatingActivation,
  updatingStatus,
  resolvingApprovalId,
  resumingApprovalId,
  outboxActionId,
}: {
  loop: WorkshopDashboardLoop | null;
  detail?: WorkshopLoopDetail | null;
  loading?: boolean;
  events: WorkshopEvent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (loopId: string) => void;
  onActivate: (loopId: string) => void;
  onReject: (loopId: string) => void;
  onPause: (loop: WorkshopDashboardLoop) => void;
  onResume: (loop: WorkshopDashboardLoop) => void;
  onDelete: (loop: WorkshopDashboardLoop) => void;
  onResolveApproval: (
    approvalId: string,
    status: "approved" | "rejected",
  ) => void;
  onResumeApproval: (approvalId: string) => void;
  onPreviewOutbox: (outbox: WorkshopOutbox) => void;
  onSendOutbox: (outboxId: string) => void;
  onReconcileOutbox: (outboxId: string) => void;
  running: boolean;
  updatingActivation: boolean;
  updatingStatus: boolean;
  resolvingApprovalId: string | null;
  resumingApprovalId: string | null;
  outboxActionId: string | null;
}) {
  const loop = detail?.loop ?? summaryLoop;
  if (!loop) return null;

  const isPendingProposal = isPendingLoopProposal(loop);
  const loopSpec = objectValue(loop.stateJson.loopSpec);
  const context = objectValue(loopSpec.context);
  const actions = objectValue(loopSpec.actions);
  const verification = objectValue(loopSpec.verification);
  const sources = sourceNamesFromSpec(context.sources);
  const allowed = stringListValue(actions.allowed);
  const requiresApproval = stringListValue(actions.requiresApproval);
  const denied = stringListValue(actions.denied);
  const successCriteria = stringListValue(verification.successCriteria);
  const trace = loop.latestRun?.executionTrace;
  const detailEvents = detail?.events ?? events;
  const memoryRecall = detail?.memoryRecall ?? [];
  const approvals = detail?.approvalRequests ?? [];
  const outbox = detail?.outbox ?? [];
  const runs = detail?.loop.runs ?? (loop.latestRun ? [loop.latestRun] : []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="z-[131] max-h-[85vh] w-[calc(100vw-2rem)] overflow-x-hidden overflow-y-auto sm:max-w-3xl"
        overlayClassName="z-[130] bg-black/20 backdrop-blur-0"
      >
        <DialogHeader>
          <DialogTitle className="break-words pr-8 leading-6">
            {loop.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            查看任务的运行状态、动作边界、最近运行、审批请求、产物和关联车间事件。
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-5 break-words pb-2">
          {loading ? (
            <PanelState
              state="loading"
              title="任务详情加载中"
              description="任务摘要先保持可见，运行记录、审批请求和产物返回后会局部补齐。"
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {isPendingProposal
                ? "待激活"
                : dashboardStatusLabel(loop.dashboardStatus)}
            </Badge>
            <Badge variant="outline">{loop.status}</Badge>
            {loop.schedulerStatus ? (
              <Badge variant="outline">{loop.schedulerStatus}</Badge>
            ) : null}
          </div>

          <p className="break-words text-sm leading-6 text-muted-foreground">
            {loop.description ?? loop.goal}
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            {isPendingProposal ? (
              <>
                <Button
                  size="sm"
                  onClick={() => onActivate(loop.id)}
                  disabled={updatingActivation}
                  className="gap-2"
                >
                  <RemixIcon
                    name={updatingActivation ? "loader" : "play"}
                    size="size-4"
                  />
                  激活
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReject(loop.id)}
                  disabled={updatingActivation}
                  className="gap-2"
                >
                  <RemixIcon name="close" size="size-4" />
                  拒绝
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    loop.status === "paused" ? onResume(loop) : onPause(loop)
                  }
                  disabled={updatingStatus || loop.status === "archived"}
                  className="gap-2"
                >
                  <RemixIcon
                    name={
                      updatingStatus
                        ? "loader"
                        : loop.status === "paused"
                          ? "play"
                          : "pause"
                    }
                    size="size-4"
                  />
                  {loop.status === "paused" ? "恢复" : "暂停"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRun(loop.id)}
                  disabled={
                    running ||
                    updatingStatus ||
                    loop.status !== "active"
                  }
                  className="gap-2"
                >
                  <RemixIcon name={running ? "loader" : "play"} size="size-4" />
                  {running ? "运行中" : "运行一次"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onDelete(loop)}
                  disabled={updatingStatus}
                  className="gap-2 text-destructive hover:text-destructive"
                >
                  <RemixIcon
                    name={updatingStatus ? "loader" : "delete_bin"}
                    size="size-4"
                  />
                  删除
                </Button>
              </>
            )}
          </div>

          {isPendingProposal ? <LoopProposalDetails loop={loop} /> : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <LoopDetailMetric
              label="触发"
              value={loop.spaceSummary?.triggerLabel ?? loop.status}
            />
            <LoopDetailMetric
              label="下次运行"
              value={formatDateTime(loop.nextScheduledRunAt)}
            />
            <LoopDetailMetric
              label="外部动作"
              value={loop.spaceSummary?.permissionLabel}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <RemixIcon name="shield_check" size="size-4" />
                动作边界
              </div>
              <div className="space-y-1 break-words text-sm leading-6 text-foreground">
                <p>允许：{truncateList(allowed, "未单独声明")}</p>
                <p>需确认：{truncateList(requiresApproval, "未单独声明")}</p>
                <p>禁止：{truncateList(denied, "未单独声明")}</p>
              </div>
            </div>

            <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <RemixIcon name="link" size="size-4" />
                上下文
              </div>
              <div className="space-y-1 break-words text-sm leading-6 text-foreground">
                <p>资料：{truncateList(sources, "按任务说明收集")}</p>
                <p>
                  说明：
                  {stringValue(context.instructions) ??
                    loop.spaceSummary?.contextLabel ??
                    "暂无"}
                </p>
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <RemixIcon name="checkbox_circle" size="size-4" />
              成功标准
            </div>
            {successCriteria.length > 0 ? (
              <ul className="space-y-1 break-words text-sm leading-6 text-foreground">
                {[...new Set(successCriteria)].map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            ) : (
              <PanelState
                state="empty"
                title="暂无明确标准"
                description="该任务还没有结构化验收标准。"
              />
            )}
          </div>

          <div className="min-w-0 space-y-3 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <RemixIcon name="pulse" size="size-4" />
              最新运行
            </div>
            {loop.latestRun ? (
              <>
                <div className="grid gap-3 sm:grid-cols-4">
                  <LoopDetailMetric
                    label="状态"
                    value={loop.latestRun.status}
                  />
                  <LoopDetailMetric
                    label="校验"
                    value={booleanLabel(loop.latestRun.verificationPassed)}
                  />
                  <LoopDetailMetric
                    label="工具调用"
                    value={trace?.toolCallCount ?? 0}
                  />
                  <LoopDetailMetric
                    label="耗时"
                    value={durationLabel(trace?.durationMs)}
                  />
                </div>
                {loop.latestRun.error || loop.latestRun.outputSummary ? (
                  <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                    {loop.latestRun.error ?? loop.latestRun.outputSummary}
                  </p>
                ) : null}
                {trace?.events?.length ? (
                  <div className="space-y-2">
                    {trace.events.map((step, index) => (
                      <div
                        key={`${step.type}-${step.timestamp ?? "no-time"}-${index}`}
                        className="min-w-0 rounded-md bg-muted/40 px-3 py-2 text-xs leading-5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-foreground">
                            {executionTraceStepTitle(step)}
                          </span>
                          {step.status ? (
                            <span className="text-muted-foreground">
                              {step.status}
                            </span>
                          ) : null}
                        </div>
                        {step.detail ? (
                          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                            {executionTraceStepDetail(step)}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <PanelState
                state="empty"
                title="暂无运行记录"
                description="任务运行后，这里会展示最近运行状态、结果和错误。"
              />
            )}
          </div>

          <LoopMemoryRecallPanel memoryRecall={memoryRecall} />

          {runs.length > 1 ? (
            <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <RemixIcon name="list_check" size="size-4" />
                最近运行
              </div>
              <div className="space-y-2">
                {runs.slice(0, 6).map((run) => (
                  <div
                    key={run.id ?? `${run.status}-${run.startedAt}`}
                    className="min-w-0 rounded-md bg-muted/40 px-3 py-2 text-xs leading-5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">
                        {run.status}
                      </span>
                      <span className="text-muted-foreground">
                        {formatDateTime(run.startedAt ?? null)}
                      </span>
                    </div>
                    {run.outputSummary || run.error ? (
                      <p className="mt-1 line-clamp-2 break-words text-muted-foreground">
                        {run.error ?? run.outputSummary}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <RemixIcon name="user_follow" size="size-4" />
              审批请求
            </div>
            {approvals.length > 0 ? (
              <div className="space-y-2">
                {approvals.slice(0, 5).map((request) => {
                  const isResolving = resolvingApprovalId === request.id;
                  const isResuming = resumingApprovalId === request.id;
                  const resumable = canResumeApproval(request);
                  return (
                    <div
                      key={request.id}
                      className="min-w-0 rounded-md bg-muted/40 px-3 py-2 text-xs leading-5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">
                          {request.actionName}
                        </span>
                        <Badge variant="outline">{request.status}</Badge>
                      </div>
                      {request.reason || request.message ? (
                        <p className="mt-1 line-clamp-2 break-words text-muted-foreground">
                          {request.reason ?? request.message}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap justify-end gap-2">
                        {request.status === "pending" ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isResolving}
                              onClick={() =>
                                onResolveApproval(request.id, "rejected")
                              }
                            >
                              拒绝
                            </Button>
                            <Button
                              size="sm"
                              disabled={isResolving}
                              onClick={() =>
                                onResolveApproval(request.id, "approved")
                              }
                            >
                              通过
                            </Button>
                          </>
                        ) : null}
                        {resumable ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isResuming}
                            onClick={() => onResumeApproval(request.id)}
                          >
                            继续执行
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <PanelState
                state="empty"
                title="暂无审批请求"
                description="需要人工确认的高风险动作会出现在这里。"
              />
            )}
          </div>

          <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <RemixIcon name="mail_send" size="size-4" />
              任务产物
            </div>
            {outbox.length > 0 ? (
              <div className="space-y-2">
                {outbox.slice(0, 5).map((item) => {
                  const previewing = outboxActionId === `preview:${item.id}`;
                  const sending = outboxActionId === `send:${item.id}`;
                  return (
                    <div
                      key={item.id}
                      className="min-w-0 rounded-md bg-muted/40 px-3 py-2 text-xs leading-5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">
                          {item.recipientName ?? item.channel}
                        </span>
                        <span className="text-muted-foreground">
                          {outboxStatusLabel(item.status,item.boundaryResult)} / {item.riskLevel}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 break-words text-muted-foreground">
                        {item.message}
                      </p>
                      <div className="mt-2 flex flex-wrap justify-end gap-2">
                        {isOutboxUnsettled(item.status)?<Button size="sm" variant="outline" disabled={Boolean(outboxActionId)} onClick={()=>onReconcileOutbox(item.id)}>查询发送结果</Button>:null}
                        {canPreviewOutbox(item) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={Boolean(outboxActionId)}
                            onClick={() => onPreviewOutbox(item)}
                          >
                            {previewing ? "生成中" : "预览"}
                          </Button>
                        ) : null}
                        {canSendOutbox(item) ? (
                          <Button
                            size="sm"
                            disabled={Boolean(outboxActionId)}
                            onClick={() => onSendOutbox(item.id)}
                          >
                            {sending ? "发中" : "发"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <PanelState
                state="empty"
                title="暂无关联产物"
                description="任务产生的待发草稿或外部动作产物会出现在这里。"
              />
            )}
          </div>

          <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <RemixIcon name="history" size="size-4" />
              车间事件
            </div>
            {detailEvents.length > 0 ? (
              <div className="space-y-2">
                {detailEvents.map((event) => (
                  <div key={event.id} className="text-sm leading-6">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">
                        {eventDisplayTitle(event)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        #{event.seq}
                      </span>
                    </div>
                    {event.body ? (
                      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {eventDisplayBody(event)}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <PanelState
                state="empty"
                title="暂无关联车间事件"
                description="任务运行、审批和结果事件会在这里按时间展示。"
              />
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
            {isPendingProposal ? (
              <>
                <Button
                  onClick={() => onActivate(loop.id)}
                  disabled={updatingActivation}
                  className="gap-2"
                >
                  <RemixIcon
                    name={updatingActivation ? "loader" : "play"}
                    size="size-4"
                  />
                  激活任务
                </Button>
                <Button
                  variant="outline"
                  onClick={() => onReject(loop.id)}
                  disabled={updatingActivation}
                  className="gap-2"
                >
                  <RemixIcon name="close" size="size-4" />
                  拒绝提案
                </Button>
              </>
            ) : (
              <Button
                onClick={() => onRun(loop.id)}
                disabled={running || loop.status !== "active"}
                className="gap-2"
              >
                <RemixIcon name={running ? "loader" : "play"} size="size-4" />
                {running ? "运行中" : "运行一次"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function eventIcon(type: string) {
  if (type.includes("report_quality")) return "article";
  if (type.includes("source")) return "link";
  if (type.includes("watchlist")) return "line_chart";
  if (type.includes("video_review")) return "video";
  if (type.includes("memory")) return "brain";
  if (type.includes("outbox_suppressed")) return "forbid";
  if (type.includes("outbox")) return "chat";
  if (type.includes("directive")) return "arrow_right_s";
  if (type.includes("run")) return "play";
  return "pulse";
}

function eventTypeLabel(type: string) {
  if (type.includes("report_quality_config")) return "配置改进提案";
  if (type.includes("report_quality")) return "报告质量评审";
  if (type.includes("agent_trace_completed")) return "过程完成";
  if (type.includes("agent_trace")) return "运行过程";
  if (type.includes("agent_text")) return "阶段输出";
  if (type.includes("permission_decision")) return "权限判断";
  if (type.includes("tool_error")) return "工具异常";
  if (type.includes("tool_result")) return "工具结果";
  if (type.includes("tool_call")) return "调用工具";
  if (type.includes("source")) return "读取资料";
  if (type.includes("watchlist")) return "自选股提案";
  if (type.includes("memory")) return "更新记忆";
  if (type.includes("outbox_suppressed")) return "跳过发信";
  if (type.includes("outbox")) return "生成待发送草稿";
  if (type.includes("directive")) return "收到新方向";
  if (type.includes("run_started")) return "开始运行";
  if (type.includes("run_completed")) return "运行完成";
  if (type.includes("run_failed") || type === "error") return "运行异常";
  if (type.includes("loop")) return "任务更新";
  if (type.includes("wechat")) return "同步微信";
  return "工作事件";
}

function reviewKindLabel(kind: string) {
  if (kind === "report_quality_config_proposal") return "改进以后的工作汇报";
  if (kind === "watchlist_proposal") return "调整关注的股票";
  if (kind === "agent_change_proposal") return "调整智能体的工作方式";
  if (kind === "loop_change_proposal") return "调整持续任务";
  if (kind === "insight_change_proposal") return "调整已保存的洞察";
  if (kind === "memory_recall_change_plan") return "检查记忆改进方案";
  if (kind === "memory_recall_governance_proposal") return "检查记忆使用问题";
  if (kind === "permission_boundary") return "操作被权限限制拦住";
  if (kind === "service_error") return "工具或服务未正常完成";
  if (kind === "memory_recall_quality") return "记忆使用情况待核查";
  if (kind === "loop_blocker") return "持续任务遇到阻碍";
  return "待了解的工作事项";
}

function ReviewMatterSummary({item, sourceEvent}: {item: WorkshopReviewItem; sourceEvent?: WorkshopEvent | null}) {
  const brief = buildReviewAssistantItem(item, sourceEvent);
  return <dl className="mt-3 space-y-2 text-sm leading-6">
    {[["这是什么事", brief.what], ["为什么找你", brief.whyOwner], ["会有什么影响", brief.impact], ["需要决定什么", brief.decision]].map(([label, value]) =>
      <div key={label} className="grid gap-1 sm:grid-cols-[7.5rem_minmax(0,1fr)]"><dt className="font-medium text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}
  </dl>;
}

const WORK_EVENT_TITLE_LABELS: Record<string, string> = {
  "CC SDK executor configured": "执行器已配置",
  "Agent final output": "智能体最终输出",
  "Agent runtime error": "智能体运行异常",
  "CC SDK execution error": "执行器运行异常",
  "Tool call": "调用工具",
  "Tool completed": "工具调用完成",
  "Tool returned error": "工具调用失败",
  "Loop started": "任务开始运行",
  "Loop completed": "任务运行完成",
  "Loop failed": "任务运行失败",
  "Missed workshop heartbeat skipped": "已跳过错过的车间心跳",
  "Workshop heartbeat reserved": "车间心跳已占用",
  "Scheduled next workshop heartbeat": "已安排下次车间心跳",
  "Heartbeat suggestion ignored": "已忽略心跳建议",
  "WeChat messages recorded": "微信消息已记录",
  "WeChat message status updated": "微信消息状态已更新",
  "WeChat local new messages checked": "微信本地新消息已检查",
  "Interaction processor completed": "社交消息处理完成",
  "Owner Context processor completed": "主人上下文处理完成",
};

function localizedEventTitle(title: string) {
  const mapped = WORK_EVENT_TITLE_LABELS[title];
  if (mapped) return mapped;
  if (title.startsWith("Task created: ")) {
    return `任务已创建：${title.slice("Task created: ".length)}`;
  }
  if (title.startsWith("Task proposed: ")) {
    return `任务已提议：${title.slice("Task proposed: ".length)}`;
  }
  if (title.startsWith("Task activated: ")) {
    return `任务已激活：${title.slice("Task activated: ".length)}`;
  }
  if (title.startsWith("Task rejected: ")) {
    return `任务已拒绝：${title.slice("Task rejected: ".length)}`;
  }
  if (title.startsWith("Fallback source: Eastmoney research API via Bash")) {
    return "备用数据源：通过命令读取东财研报接口";
  }
  if (title.startsWith("Fallback source: Eastmoney via Bash")) {
    return "备用数据源：通过命令读取东财";
  }
  if (title.startsWith("Fallback source: Bash result")) {
    return "备用数据源：命令执行结果";
  }
  if (title.startsWith("Fallback source: ")) {
    return `备用数据源：${workDisplayLabel(
      title.slice("Fallback source: ".length),
    )}`;
  }
  return title;
}

function eventDisplayTitle(event: WorkshopEvent) {
  const toolName = stringValue(event.metadata?.toolName);
  if (event.type === "tool_call") {
    return event.title.startsWith("调用工具：")
      ? event.title
      : `调用工具：${workDisplayLabel(toolName ?? event.title)}`;
  }
  if (event.type === "tool_result") {
    if (event.title.startsWith("工具完成：")) return event.title;
    return `工具完成：${workDisplayLabel(toolName ?? event.title)}`;
  }
  if (event.type === "tool_error") {
    if (event.title.startsWith("工具失败：")) return event.title;
    return `工具失败：${workDisplayLabel(toolName ?? event.title)}`;
  }
  return localizedEventTitle(event.title);
}

function localizedEventBody(body: string) {
  const jsonRcMatch = body.match(
    /^Tool completed with JSON: rc=([^,]+), data=(empty|returned)\.$/,
  );
  if (jsonRcMatch) {
    return `工具已返回 JSON：rc=${jsonRcMatch[1]}，data=${
      jsonRcMatch[2] === "empty" ? "为空" : "已返回"
    }。`;
  }
  const jsonLengthMatch = body.match(
    /^Tool completed with JSON output \((\d+) characters\)\.$/,
  );
  if (jsonLengthMatch) {
    return `工具已返回 JSON 输出（${jsonLengthMatch[1]} 个字符）。`;
  }
  if (
    body ===
    "Generic tool returned data and was captured as a traceable source."
  ) {
    return "通用工具已返回数据，并作为可追溯资料源记录。";
  }
  if (body === "No new WeChat messages were recorded.") {
    return "没有记录到新的微信消息。";
  }
  return body;
}

function eventDisplayBody(event: WorkshopEvent) {
  return event.body ? localizedEventBody(event.body) : null;
}

function findBalancedJsonEnd(text: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function parseStructuredReport(text: string) {
  const tag = text.match(/<structured-output\b[^>]*>/i);
  if (!tag || tag.index === undefined) return null;
  const jsonStart = text.indexOf("{", tag.index + tag[0].length);
  if (jsonStart < 0) return null;
  const jsonEnd = findBalancedJsonEnd(text, jsonStart);
  if (jsonEnd < 0) return null;
  try {
    const data = JSON.parse(text.slice(jsonStart, jsonEnd)) as Record<
      string,
      unknown
    >;
    const before = text.slice(0, tag.index).trim();
    const afterTagEnd = text.indexOf("</structured-output>", jsonEnd);
    const after =
      afterTagEnd >= 0
        ? text.slice(afterTagEnd + "</structured-output>".length).trim()
        : "";
    return { data, cleanText: [before, after].filter(Boolean).join("\n\n") };
  } catch {
    return null;
  }
}

function reportText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reportStringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (item && typeof item === "object") {
            const record = item as Record<string, unknown>;
            return (
              reportText(record.label) ??
              reportText(record.summary) ??
              reportText(record.content) ??
              reportText(record.description)
            );
          }
          return null;
        })
        .filter((item): item is string => Boolean(item))
    : [];
}

function structuredReportMarkdown(data: Record<string, unknown>) {
  const sections: string[] = [];
  const summary = reportText(data.summary);
  const actionTaken = reportText(data.actionTaken);
  const riskAssessment = reportText(data.riskAssessment);
  const accountState = reportText(data.accountState);
  const tradePlanLedger = reportText(data.tradePlanLedger);
  const tradeTriggers = reportText(data.tradeTriggers);
  const nextControlAction = reportText(data.nextControlAction);
  const riskBlockers = reportStringList(data.riskBlockers);
  const suggestedActions = reportStringList(data.suggestedActions);

  if (summary) sections.push(`### 汇报摘要\n${summary}`);
  if (actionTaken) sections.push(`### 已完成动作\n${actionTaken}`);
  if (accountState) sections.push(`### 当前状态\n${accountState}`);
  if (tradePlanLedger || tradeTriggers) {
    sections.push(
      [
        "### 计划与触发条件",
        tradePlanLedger,
        tradeTriggers,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  if (riskAssessment || riskBlockers.length > 0) {
    sections.push(
      [
        "### 风险与限制",
        riskAssessment,
        ...riskBlockers.map((item) => `- ${item}`),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (nextControlAction || suggestedActions.length > 0) {
    sections.push(
      [
        "### 下一步",
        nextControlAction,
        ...suggestedActions.map((item) => `- ${item}`),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return sections.join("\n\n");
}

function humanReadableWorkLogBody(event: WorkshopEvent) {
  const body = eventDisplayBody(event);
  if (!body) return null;
  const parsed = parseStructuredReport(body);
  if (!parsed) {
    return body
      .replace(/<structured-output\b[^>]*>[\s\S]*?<\/structured-output>/gi, "")
      .trim();
  }
  const report = structuredReportMarkdown(parsed.data);
  return report || parsed.cleanText || null;
}

function compactReadableText(value: string | null | undefined, maxLength = 360) {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (
    text.startsWith("{") ||
    text.startsWith("[") ||
    text.includes("<persisted-output>")
  ) {
    return null;
  }
  return text.length > maxLength
    ? `${text.slice(0, maxLength).trim()}...`
    : text;
}

function compactJsonSummary(value: string | null | undefined) {
  const parsed = parseJsonObject(value);
  if (!parsed) return null;
  const fields = [
    ["标的", stringValue(parsed.symbol)],
    ["操作", stringValue(parsed.action) ?? stringValue(parsed.operation)],
    ["状态", stringValue(parsed.status)],
    ["原因", stringValue(parsed.reason) ?? stringValue(parsed.warning)],
    ["数量", numberValue(parsed.count)?.toString()],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (fields.length === 0) return null;
  return fields.map(([label, text]) => `${label}：${text}`).join("；");
}

function readableTraceBody(event: WorkshopEvent) {
  const body = humanReadableWorkLogBody(event);
  return compactReadableText(body) ?? compactJsonSummary(body);
}

function statusForTimelineEvent(event: WorkshopEvent): WorkLogTimelineItem["status"] {
  if (event.type === "tool_error" || event.type.includes("failed")) return "error";
  if (event.type === "tool_call") return "running";
  if (
    event.type === "tool_result" ||
    event.type.includes("completed") ||
    event.type.includes("applied") ||
    event.type.includes("written")
  ) {
    return "completed";
  }
  return "default";
}

function workLogTimelineItems(events: WorkshopEvent[]): WorkLogTimelineItem[] {
  const items: WorkLogTimelineItem[] = [];
  const consumed = new Set<string>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (consumed.has(event.id)) continue;

    if (event.type === "agent_text") {
      const grouped = [event];
      let cursor = index + 1;
      while (cursor < events.length && events[cursor].type === "agent_text") {
        grouped.push(events[cursor]);
        consumed.add(events[cursor].id);
        cursor += 1;
      }
      const body = grouped
        .map((item) => readableTraceBody(item))
        .filter((item): item is string => Boolean(item))
        .join("\n\n");
      items.push({
        id: grouped.map((item) => item.id).join(":"),
        seqLabel:
          grouped.length === 1
            ? `${event.seq}`
            : `${grouped[0].seq}-${grouped.at(-1)?.seq}`,
        title: "智能体阶段摘要",
        label: "阶段输出",
        createdAt: grouped.at(-1)?.createdAt ?? event.createdAt,
        body: body || "这一步产生了模型过程输出，但内容仅作为运行轨迹保存。",
        status: "default",
      });
      continue;
    }

    if (event.type === "tool_call") {
      const toolUseId = stringValue(event.metadata?.toolUseId);
      const pairedIndex =
        toolUseId === null
          ? -1
          : events.findIndex(
              (candidate, candidateIndex) =>
                candidateIndex > index &&
                !consumed.has(candidate.id) &&
                stringValue(candidate.metadata?.toolUseId) === toolUseId &&
                (candidate.type === "tool_result" ||
                  candidate.type === "tool_error"),
            );
      const paired = pairedIndex >= 0 ? events[pairedIndex] : null;
      if (paired) consumed.add(paired.id);
      const inputSummary = readableTraceBody(event);
      const resultSummary = paired ? readableTraceBody(paired) : null;
      const lines = [
        inputSummary ? `输入：${inputSummary}` : null,
        resultSummary
          ? `结果：${resultSummary}`
          : paired
            ? "结果：工具已返回，详细内容保存在原始系统记录中。"
            : "结果：等待工具返回。",
      ].filter((item): item is string => Boolean(item));
      items.push({
        id: paired ? `${event.id}:${paired.id}` : event.id,
        seqLabel: paired ? `${event.seq}-${paired.seq}` : `${event.seq}`,
        title: eventDisplayTitle(event),
        label: paired ? eventTypeLabel(paired.type) : eventTypeLabel(event.type),
        createdAt: paired?.createdAt ?? event.createdAt,
        body: lines.join("\n"),
        status: paired ? statusForTimelineEvent(paired) : "running",
      });
      continue;
    }

    if (event.type === "tool_result" || event.type === "tool_error") {
      items.push({
        id: event.id,
        seqLabel: `${event.seq}`,
        title: eventDisplayTitle(event),
        label: eventTypeLabel(event.type),
        createdAt: event.createdAt,
        body:
          readableTraceBody(event) ??
          "工具已返回，详细内容保存在原始系统记录中。",
        status: statusForTimelineEvent(event),
      });
      continue;
    }

    items.push({
      id: event.id,
      seqLabel: `${event.seq}`,
      title: eventDisplayTitle(event),
      label: eventTypeLabel(event.type),
      createdAt: event.createdAt,
      body: humanReadableWorkLogBody(event),
      status: statusForTimelineEvent(event),
    });
  }

  return items;
}

function markdownEscape(value: string) {
  return value.replace(/([\\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function workLogEventMarkdown(event: WorkshopEvent) {
  const title = eventDisplayTitle(event);
  const body = humanReadableWorkLogBody(event);
  const lines = [
    `## ${markdownEscape(title)}`,
    "",
    `- Time: ${markdownEscape(formatDateTime(event.createdAt))}`,
    `- Type: ${markdownEscape(eventTypeLabel(event.type))}`,
    `- Seq: ${event.seq}`,
  ];
  if (event.runId) lines.push(`- Run: \`${event.runId}\``);
  if (event.loopId) lines.push(`- Loop: \`${event.loopId}\``);
  if (event.loopRunId) lines.push(`- Loop Run: \`${event.loopRunId}\``);
  lines.push("");
  lines.push(body?.trim() ? body.trim() : "_No body._");
  return lines.join("\n");
}

function parseJsonObject(text: string | null | undefined) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return objectValue(parsed);
  } catch {
    return null;
  }
}

function eventNarrativeText(event: WorkshopEvent) {
  return stringValue(event.metadata?.summary) ?? event.body ?? null;
}

function intentForEvidenceEvent(event: WorkshopEvent) {
  const title = eventDisplayTitle(event);
  const body = eventNarrativeText(event);
  const haystack = `${event.title} ${event.type} ${body ?? ""}`.toLowerCase();
  const toolName = stringValue(event.metadata?.toolName);

  if (/行情|quote|price|qt\.gtimg|报价/.test(haystack)) {
    return {
      key: "quote",
      title: "确认标的本体是否满足价格和量能条件",
      reason:
        "买卖判断先看标的本身。价格、涨跌幅和量能没有过线时，后面的主题热度只能作为辅助，不能直接推出买入。",
      source: toolName ?? title,
      result: body,
    };
  }
  if (/趋势|trend|ma\d|kline|均线/.test(haystack)) {
    return {
      key: "trend",
      title: "确认趋势结构是否已经修复",
      reason:
        "单日上涨不等于趋势反转，需要确认均线结构、趋势阶段和评分，避免把弱反弹误判成买点。",
      source: toolName ?? title,
      result: body,
    };
  }
  if (/持仓|holding|basket|fund holdings|etf_holdings/.test(haystack)) {
    return {
      key: "holdings",
      title: "确认主要持仓是否形成共振",
      reason:
        "ETF 的持续性取决于核心成分股是否一起走强，持仓篮子走弱时，ETF 独立上涨的可信度会下降。",
      source: toolName ?? title,
      result: body,
    };
  }
  if (/市场|情绪|mood|热榜|hot|concept|概念|宽度/.test(haystack)) {
    return {
      key: "market",
      title: "确认市场环境和主题方向是否支持",
      reason:
        "即使标的有动作，也要看市场主攻方向和风险偏好，避免在非主线或弱环境里放大仓位。",
      source: toolName ?? title,
      result: body,
    };
  }
  if (/新闻|公告|news|announcement|cninfo|研报/.test(haystack)) {
    return {
      key: "news",
      title: "确认消息面是否解释或改变判断",
      reason:
        "新闻和公告用于解释异动、识别利好是否兑现，以及发现会改变下一轮计划的风险。",
      source: toolName ?? title,
      result: body,
    };
  }
  if (/trade plan|交易计划|ledger|plan/.test(haystack)) {
    return {
      key: "plan",
      title: "读取已有计划，确认本轮判断基线",
      reason:
        "先看之前是否已经有买入、卖出或观察计划，避免每次运行都从零开始重新定义规则。",
      source: toolName ?? title,
      result: body,
    };
  }
  if (/memory|brain|记忆/.test(haystack)) {
    return {
      key: "memory",
      title: "读取或更新长期状态",
      reason:
        "长期智能体需要把持仓状态、上次判断和下次触发线沉淀下来，下一轮才能接着判断。",
      source: toolName ?? title,
      result: body,
    };
  }

  return {
    key: `${event.type}:${toolName ?? event.title}`,
    title,
    reason: "这一步为本轮判断补充事实或保存可追溯证据。",
    source: toolName ?? title,
    result: body,
  };
}

function isEvidenceEvent(event: WorkshopEvent) {
  return (
    event.type === "source_checked" ||
    event.type === "tool_call" ||
    event.type === "tool_result" ||
    event.type === "tool_error"
  );
}

function primaryConclusionEvent(events: WorkshopEvent[]) {
  return latestWorkshopConclusion(events);
}

function thoughtStepsFromEvent(
  event: WorkshopEvent | null | undefined,
): AgentThoughtStep[] {
  const reasoningChain = event?.metadata?.reasoningChain;
  if (!Array.isArray(reasoningChain)) return [];
  return reasoningChain
    .map((item, index) => {
      const record = objectValue(item);
      const summary = stringValue(record.summary);
      if (!summary) return null;
      const description = stringValue(record.description);
      if (
        summary === "Task received" ||
        summary === "Collected information with tools" ||
        summary === "Run completed" ||
        /^Called \d+ tool/i.test(description ?? "")
      ) {
        return null;
      }
      return {
        id: `${event?.id ?? "thought"}:${index}`,
        summary,
        description,
        sourceLabel: stringValue(record.sourceLabel),
        stepType: stringValue(record.stepType),
      } satisfies AgentThoughtStep;
    })
    .filter((item): item is AgentThoughtStep => Boolean(item));
}

function buildAgentWorkStep(events: WorkshopEvent[]): AgentWorkStep[] {
  const byKey = new Map<string, AgentWorkStep>();
  for (const event of events) {
    if (!isEvidenceEvent(event)) continue;
    const intent = intentForEvidenceEvent(event);
    const current = byKey.get(intent.key);
    if (!current) {
      byKey.set(intent.key, {
        id: intent.key,
        title: intent.title,
        reason: intent.reason,
        dataSources: [intent.source],
        result: intent.result,
        evidenceEvents: [event],
      });
      continue;
    }
    if (!current.dataSources.includes(intent.source)) {
      current.dataSources.push(intent.source);
    }
    current.evidenceEvents.push(event);
    current.result = intent.result ?? current.result;
  }
  return [...byKey.values()];
}

function actionTextFromEvent(event: WorkshopEvent) {
  if (event.type === "memory_written") return "已写入长期记忆。";
  if (event.type === "outbox_draft") {
    const recipient =
      stringValue(event.metadata?.recipientName) ??
      stringValue(event.metadata?.recipient) ??
      "收件人";
    return `已生成发信草稿：${recipient}。`;
  }
  if (event.type === "outbox_sent" || event.type === "work_outbox_sent") {
    return event.body ? localizedEventBody(event.body) : "已完成外发通知。";
  }
  if (event.type.includes("proposal_applied")) return eventDisplayTitle(event);
  return null;
}

function inferCurrentState(events: WorkshopEvent[]) {
  const memoryPayload = [...events]
    .reverse()
    .map((event) => parseJsonObject(event.body))
    .find((payload) => payload && Object.keys(payload).length > 0);
  const state: string[] = [];
  if (memoryPayload) {
    const symbol = stringValue(memoryPayload.symbol);
    const positionState =
      stringValue(memoryPayload.positionState) ??
      (numberValue(memoryPayload.positionStateValue) === 0
        ? "空仓"
        : numberValue(memoryPayload.positionStateValue) === 1
          ? "全仓持有"
          : null);
    const session = stringValue(memoryPayload.session);
    const assessment = stringValue(memoryPayload.assessment);
    const trendPhase = stringValue(memoryPayload.trendPhase);
    const trendScore = numberValue(memoryPayload.trendScore);
    if (symbol) state.push(`关注标的：${symbol}`);
    if (positionState) state.push(`持仓状态：${positionState}`);
    if (session) state.push(`任务阶段：${session}`);
    if (assessment) state.push(`本次判断：${assessment}`);
    if (trendPhase || trendScore !== null) {
      state.push(
        `趋势状态：${trendPhase ?? "未知"}${
          trendScore !== null ? ` / score=${trendScore}` : ""
        }`,
      );
    }
  }
  return state.length ? state : ["本轮记录未提供结构化状态，不能据此判断当前持仓或任务进度。"];
}

function inferNextFocus(events: WorkshopEvent[]) {
  const memoryPayload = [...events]
    .reverse()
    .map((event) => parseJsonObject(event.body))
    .find((payload) => payload && Object.keys(payload).length > 0);
  const focus = [
    stringValue(memoryPayload?.nextSessionBuyTrigger),
    stringValue(memoryPayload?.nextSessionSellTrigger),
    stringValue(memoryPayload?.nextSessionDate)
      ? `下一计划日期：${stringValue(memoryPayload?.nextSessionDate)}`
      : null,
  ].filter((item): item is string => Boolean(item));
  return focus;
}

function buildAgentWorkRecord(events: WorkshopEvent[]): AgentWorkRecord {
  const sorted = sortWorkshopEvents(events);
  const first = sorted[0];
  const conclusionEvent = primaryConclusionEvent(sorted);
  const observationEvent = sorted.find((event) => event.type === "observation");
  const conclusion = conclusionEvent ? eventNarrativeText(conclusionEvent) : null;
  const thoughtSteps = thoughtStepsFromEvent(conclusionEvent);
  const reasoningSummary = observationEvent?.body
    ? humanReadableWorkLogBody(observationEvent)
    : conclusion;
  const steps = buildAgentWorkStep(sorted);
  const actions = sorted
    .map(actionTextFromEvent)
    .filter((item): item is string => Boolean(item));
  const hasFailure = sorted.find(
    (event) =>
      event.type.includes("failed") ||
      event.type.includes("blocked") ||
      event.type === "tool_error",
  );
  const evidenceSources = [
    ...new Set(
      sorted
        .filter(isEvidenceEvent)
        .map((event) => intentForEvidenceEvent(event).source),
    ),
  ];
  const runId =
    first?.loopRunId ?? first?.runId ?? first?.loopId ?? first?.id ?? "unknown";

  return {
    id: runId,
    runLabel: runId === "unknown" ? "未关联运行" : runId,
    startedAt:
      sorted.find((event) => event.type === "loop_run_started")?.createdAt ??
      first?.createdAt ??
      null,
    latestRecordedAt: sorted.at(-1)?.createdAt ?? null,
    goal:
      conclusionEvent?.metadata?.goal && typeof conclusionEvent.metadata.goal === "string"
        ? conclusionEvent.metadata.goal
        : "本轮记录未提供明确目标。",
    currentState: inferCurrentState(sorted),
    questions: steps.map((step) => step.title),
    thoughtSteps,
    steps,
    reasoningSummary,
    conclusion,
    actions,
    ownerAttention: hasFailure
      ? "记录中存在异常或阻断，请结合当前状态和原始记录核实。"
      : null,
    nextFocus: inferNextFocus(sorted),
    evidenceSources,
    rawEvents: sorted,
  };
}

function buildAgentWorkRecords(events: WorkshopEvent[]) {
  const groups = new Map<string, WorkshopEvent[]>();
  for (const event of events) {
    const key =
      event.loopRunId ??
      event.runId ??
      event.loopId ??
      formatDateKey(event.createdAt);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(buildAgentWorkRecord)
    .sort((left, right) =>
      (right.latestRecordedAt ?? "").localeCompare(left.latestRecordedAt ?? ""),
    );
}

function eventRunKey(event: WorkshopEvent) {
  return event.loopRunId ?? event.runId ?? null;
}

function isEventAfterRunStart(event: WorkshopEvent, startedAt: string | null) {
  if (!startedAt) return true;
  const eventTime = Date.parse(event.createdAt);
  const startTime = Date.parse(startedAt);
  if (!Number.isFinite(eventTime) || !Number.isFinite(startTime)) {
    return event.createdAt >= startedAt;
  }
  return eventTime >= startTime;
}

function latestRunningWorkflow(
  events: WorkshopEvent[],
  loops: WorkshopDashboardLoop[],
): RunningWorkflow | null {
  const sortedEvents = sortWorkshopEvents(events);
  const loopById = new Map(loops.map((loop) => [loop.id, loop]));
  const runningLoops = loops
    .filter((loop) => loop.latestRun?.status === "running")
    .sort((left, right) =>
      (right.latestRun?.startedAt ?? "").localeCompare(
        left.latestRun?.startedAt ?? "",
      ),
    );

  for (const loop of runningLoops) {
    const runId = loop.latestRun?.id;
    const startedAt = loop.latestRun?.startedAt ?? null;
    const workflowEvents = sortedEvents.filter((event) => {
      if (runId && eventRunKey(event) === runId) return true;
      if (!runId && event.loopId === loop.id) {
        return isEventAfterRunStart(event, startedAt);
      }
      return false;
    });
    return {
      id: runId ?? loop.id,
      loopName: loop.name,
      startedAt,
      events: workflowEvents,
    };
  }

  const grouped = new Map<string, WorkshopEvent[]>();
  for (const event of sortedEvents) {
    const key = eventRunKey(event);
    if (!key) continue;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }

  const runningGroups: RunningWorkflow[] = [];
  for (const [id, group] of grouped.entries()) {
    const hasStarted = group.some((event) => event.type === "loop_run_started");
    const hasStopped = group.some(
      (event) =>
        event.type === "loop_run_completed" || event.type === "loop_run_failed",
    );
    if (!hasStarted || hasStopped) continue;
    const started = group.find((event) => event.type === "loop_run_started");
    const loopName =
      (started?.loopId ? loopById.get(started.loopId)?.name : null) ??
      started?.title ??
      "运行中任务";
    runningGroups.push({
      id,
      loopName,
      startedAt: started?.createdAt ?? group[0]?.createdAt ?? null,
      events: group,
    });
  }
  runningGroups.sort((left, right) =>
    (right.startedAt ?? "").localeCompare(left.startedAt ?? ""),
  );

  return runningGroups[0] ?? null;
}

function RunningWorkflowPanel({ workflow }: { workflow: RunningWorkflow }) {
  const events = sortWorkshopEvents(workflow.events);
  return (
    <div className="mt-6 rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="animate-spin">
              <RemixIcon name="loader" size="size-4" />
            </span>
            正在运行
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {workflow.loopName}
            {workflow.startedAt ? ` · 开始 ${formatDateTime(workflow.startedAt)}` : ""}
          </p>
        </div>
        <Badge variant="secondary" className="bg-sky-500/10 text-sky-700">
          {events.length} 条过程
        </Badge>
      </div>

      {events.length ? (
        <div className="max-h-[68vh] overflow-y-auto px-4 py-4 sm:px-5">
          <div className="space-y-4">
            {events.map((event) => {
              const body = humanReadableWorkLogBody(event);
              const evidence = isEvidenceEvent(event)
                ? intentForEvidenceEvent(event)
                : null;
              return (
                <div
                  key={event.id}
                  className="grid grid-cols-[64px_minmax(0,1fr)] gap-3"
                >
                  <div className="pt-1 text-right text-xs text-muted-foreground">
                    {formatTime(event.createdAt)}
                  </div>
                  <div className="min-w-0 rounded-md border border-border bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {eventTypeLabel(event.type)}
                      </Badge>
                      <span className="text-sm font-medium text-foreground">
                        {eventDisplayTitle(event)}
                      </span>
                    </div>
                    {evidence ? (
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        {evidence.reason}
                      </p>
                    ) : null}
                    {body ? (
                      <div className="mt-3 text-sm leading-6 text-foreground">
                        <Markdown>{body}</Markdown>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-4 py-6 sm:px-5">
          <PanelState
            state="loading"
            title="正在等待第一条过程事件"
            description="智能体开始调用工具或写入观察后，会实时显示在这里。"
          />
        </div>
      )}
    </div>
  );
}

function readableEvidencePreview(value: string | null) {
  const text = value?.trim();
  if (!text) return null;
  if (
    text.length > 500 ||
    text.startsWith("{") ||
    text.startsWith("[") ||
    text.includes("<persisted-output>")
  ) {
    return "已完成取证，原始工具返回已保存在系统记录中。这里优先展示智能体为什么需要这一步和它使用了哪些证据。";
  }
  return text;
}

function AgentWorkRecordCard({ record }: { record: AgentWorkRecord }) {
  const reasoningSummaryPreview = readableEvidencePreview(
    record.reasoningSummary,
  );
  const timelineItems = workLogTimelineItems(record.rawEvents);

  return (
    <article className="scroll-mt-14 border border-[#E5E5E5] bg-white px-5 py-5 lg:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            {record.latestRecordedAt ? `最近记录 ${formatDateTime(record.latestRecordedAt)}` : "记录时间未知"}
          </div>
          <h3 className="mt-1 text-base font-semibold text-foreground">
            {record.conclusion ? "本次工作复盘" : "工作记录"}
          </h3>
        </div>
        <Badge variant="secondary" className="shrink-0">
          {record.ownerAttention ? "有异常记录" : "处理需求待核实"}
        </Badge>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)]">
        <section className="space-y-4">
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              本次目标
            </div>
            <p className="mt-1 text-sm leading-6 text-foreground">
              {record.goal}
            </p>
          </div>

          <div>
            <div className="text-xs font-medium text-muted-foreground">
              记录中的状态
            </div>
            <ul className="mt-2 space-y-1 text-sm leading-6 text-foreground">
              {record.currentState.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-xs font-medium text-muted-foreground">
              智能体思考
            </div>
            {record.thoughtSteps.length ? (
              <div className="mt-2 space-y-3">
                {record.thoughtSteps.map((step, index) => (
                  <div
                    key={step.id}
                    className="rounded-md border border-border bg-muted/20 p-3"
                  >
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0">
                        {index + 1}
                      </Badge>
                      <div className="min-w-0 space-y-1">
                        <div className="text-sm font-medium text-foreground">
                          {step.summary}
                        </div>
                        {step.description ? (
                          <p className="text-sm leading-6 text-muted-foreground">
                            {step.description}
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-1.5">
                          {step.stepType ? (
                            <Badge variant="secondary">{step.stepType}</Badge>
                          ) : null}
                          {step.sourceLabel ? (
                            <Badge variant="outline">{step.sourceLabel}</Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                这次运行还没有保存智能体自述的思考摘要；下面的验证过程来自系统根据证据事件整理。
              </p>
            )}
          </div>

          {record.steps.length ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                验证过程
              </div>
              <div className="mt-2 space-y-3">
                {record.steps.map((step, index) => {
                  const resultPreview = readableEvidencePreview(step.result);
                  return (
                    <div
                      key={step.id}
                      className="rounded-md border border-border bg-muted/20 p-3"
                    >
                      <div className="flex items-start gap-2">
                        <Badge variant="outline" className="mt-0.5 shrink-0">
                          {index + 1}
                        </Badge>
                        <div className="min-w-0 space-y-2">
                          <div className="text-sm font-medium text-foreground">
                            {step.title}
                          </div>
                          <p className="text-sm leading-6 text-muted-foreground">
                            {step.reason}
                          </p>
                          {resultPreview ? (
                            <p className="text-sm leading-6 text-foreground">
                              {resultPreview}
                            </p>
                          ) : null}
                          <div className="flex flex-wrap gap-1.5">
                            {step.dataSources.map((source) => (
                              <Badge key={source} variant="secondary">
                                {source}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {reasoningSummaryPreview ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                判断摘要
              </div>
              <div className="mt-1 text-sm leading-6 text-foreground">
                <Markdown>{reasoningSummaryPreview}</Markdown>
              </div>
            </div>
          ) : null}

          {record.conclusion ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                最终结论
              </div>
              <p className="mt-1 text-sm leading-6 text-foreground">
                {record.conclusion}
              </p>
            </div>
          ) : null}
        </section>

        <aside className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              已记录的执行动作
            </div>
            <ul className="mt-2 space-y-1 text-sm leading-6 text-foreground">
              {(record.actions.length ? record.actions : ["当前记录未提供执行动作的证据，不能据此认定没有发生动作。"]).map(
                (item) => (
                  <li key={item}>{item}</li>
                ),
              )}
            </ul>
          </div>

          <div>
            <div className="text-xs font-medium text-muted-foreground">
              未执行动作及原因
            </div>
            <p className="mt-2 text-sm leading-6 text-foreground">未汇总跳过动作及原因，请结合原始记录核实。</p>
          </div>

          <div>
            <div className="text-xs font-medium text-muted-foreground">
              需要主人处理
            </div>
            <p className="mt-2 text-sm leading-6 text-foreground">
              {record.ownerAttention ?? "当前记录不足以判断是否需要处理，请结合车间待处理状态核对。"}
            </p>
          </div>

          <div>
            <div className="text-xs font-medium text-muted-foreground">
              下一步关注
            </div>
            <ul className="mt-2 space-y-1 text-sm leading-6 text-foreground">
              {(record.nextFocus.length ? record.nextFocus : ["本轮记录未提供后续计划；实际调度请查看运行配置。"]).map(
                (item) => (
                  <li key={item}>{item}</li>
                ),
              )}
            </ul>
          </div>

          <details className="group rounded-md border border-border bg-background p-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              证据与原始系统记录
            </summary>
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {record.evidenceSources.map((source) => (
                  <Badge key={source} variant="outline">
                    {source}
                  </Badge>
                ))}
              </div>
              <div className="space-y-3">
                {timelineItems.map((event) => (
                  <div
                    key={event.id}
                    className={cn(
                      "rounded-md border bg-muted/20 p-3 text-xs leading-5",
                      event.status === "error"
                        ? "border-destructive/40 bg-destructive/5"
                        : "border-border",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-medium text-foreground">
                        Seq {event.seqLabel}: {event.title}
                      </div>
                      <Badge
                        variant={
                          event.status === "error"
                            ? "destructive"
                            : event.status === "completed"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {event.label}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </div>
                    {event.body ? (
                      <div className="mt-2 text-foreground">
                        <Markdown>{event.body}</Markdown>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </details>
        </aside>
      </div>
    </article>
  );
}

function WorkLogExpandedDialog({
  workshopId,
  events,
  open,
  onOpenChange,
  runId,
  onSelectRun,
}: {
  workshopId: string | null;
  events: WorkshopEvent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string | null;
  onSelectRun: (runId: string | null) => void;
}) {
  const history = useWorkshopRunHistory(workshopId, runId, open);
  const allEvents = useMemo(() => {
    const merged = new Map<string, WorkshopEvent>();
    const historyEvents = history.events;
    for (const event of [...historyEvents, ...events]) {
      if (event.workshopId !== workshopId) continue;
      if (runId && event.runId !== runId && event.loopRunId !== runId) continue;
      merged.set(event.id, event);
    }
    return workLogEvents(sortWorkshopEvents([...merged.values()]));
  }, [events, history.events, workshopId, runId]);
  const workRecords = useMemo(
    () => buildAgentWorkRecords(allEvents),
    [allEvents],
  );
  const newestEvent = allEvents.at(-1);



  return <RunHistoryView location={{workshopId,runId}} open={open} onOpenChange={onOpenChange}
    onSelectRun={onSelectRun} status={history} latestRecordedAt={newestEvent?formatDateTime(newestEvent.createdAt):null}
    items={workRecords.map(record=>({id:record.id,eventCount:record.rawEvents.length,
      recordedAt:record.latestRecordedAt?formatDateTime(record.latestRecordedAt):'记录时间未知',
      canLocate:record.rawEvents.some(event=>event.runId===record.id||event.loopRunId===record.id),
      content:<AgentWorkRecordCard record={record}/>}))}/>;
}

function executionTraceStepTitle(
  step: NonNullable<WorkshopLoopRun["executionTrace"]>["events"][number],
) {
  if (step.type === "agent_configured") return "运行时已配置";
  const toolName = stringValue(step.toolName);
  if (step.type === "tool_call") {
    if (step.title.startsWith("调用工具：")) return step.title;
    return `调用工具：${workDisplayLabel(toolName ?? step.title)}`;
  }
  if (step.type === "tool_result") {
    if (step.title.startsWith("工具完成：")) return step.title;
    return `工具完成：${workDisplayLabel(toolName ?? step.title)}`;
  }
  if (step.type === "tool_error") {
    if (step.title.startsWith("工具失败：")) return step.title;
    return `工具失败：${workDisplayLabel(toolName ?? step.title)}`;
  }
  return localizedEventTitle(step.title);
}

function executionTraceStepDetail(
  step: NonNullable<WorkshopLoopRun["executionTrace"]>["events"][number],
) {
  if (step.type === "agent_configured") {
    const metadata = objectValue(step.metadata);
    const runtime = objectValue(metadata.runtime);
    const selection = objectValue(metadata.runtimeSelection);
    const runtimeSnapshot = step.runtimeSnapshot;
    const engine =
      runtimeSnapshot?.engine ??
      stringValue(runtime.engine) ??
      stringValue(selection.engine);
    const adapter = runtimeSnapshot?.adapter ?? stringValue(runtime.adapter);
    const source = stringValue(selection.source);
    const piProtocol = stringValue(selection.piProtocol);
    const detailParts = [`运行时：${agentRuntimeLabel(engine)}`];
    if (adapter) detailParts.push(`适配器：${adapter}`);
    if (source) detailParts.push(`选择来源：${source}`);
    if (piProtocol) detailParts.push(`Pi 协议：${piProtocol}`);
    if (runtimeSnapshot?.model) detailParts.push(`模型：${runtimeSnapshot.model}`);
    if (runtimeSnapshot?.allowedToolCount != null) {
      detailParts.push(`工具：${runtimeSnapshot.allowedToolCount}`);
    }
    const piTools = objectValue(objectValue(runtimeSnapshot?.extra).piTools);
    const piToolCounts = [
      ["只读", stringListValue(piTools.readonly).length],
      ["提案", stringListValue(piTools.reviewableProposal).length],
      ["内部写", stringListValue(piTools.internalWrite).length],
    ].filter(([, count]) => Number(count) > 0);
    if (piToolCounts.length > 0) {
      detailParts.push(
        `Pi 工具：${piToolCounts
          .map(([label, count]) => `${label}${count}`)
          .join("、")}`,
      );
    }
    if (runtimeSnapshot?.runtimeHash) {
      detailParts.push(`快照：${shortHash(runtimeSnapshot.runtimeHash)}`);
    }
    if (runtimeSnapshot?.policyHash) {
      detailParts.push(`策略：${shortHash(runtimeSnapshot.policyHash)}`);
    }
    return detailParts.join("；");
  }
  return step.detail ? localizedEventBody(step.detail) : null;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      workshopApiErrorMessage(payload, `Request failed: ${response.status}`),
    );
  }
  return response.json() as Promise<T>;
}

function policyForMode(mode: WorkshopBoundaryMode) {
  return serializeWorkshopBoundaryPolicy({
    mode,
    externalMessages:
      mode === "observe" ? "blocked" : mode === "auto" ? "auto" : "draft",
    allowWechatPreview: mode !== "observe",
    requireSourcesForOutbox: true,
  });
}

function recipientText(policy: WorkshopBoundaryPolicy) {
  return policy.allowedRecipients.join("\n");
}

function numberFromPolicy(
  policy: Record<string, unknown>,
  key: string,
  fallback: number,
) {
  const value = policy[key];
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function heartbeatFormFromRow(
  heartbeat: WorkshopHeartbeat | null,
): HeartbeatPolicyForm {
  const policy = heartbeat?.heartbeatPolicy ?? {};
  return {
    enabled: heartbeat?.enabled ?? true,
    allowAgentSuggestedWakeup:
      typeof policy.allowAgentSuggestedWakeup === "boolean"
        ? policy.allowAgentSuggestedWakeup
        : true,
    minIntervalMinutes: numberFromPolicy(policy, "minIntervalMinutes", 15),
    defaultDelayMinutes: numberFromPolicy(policy, "defaultDelayMinutes", 60),
    maxIntervalMinutes: numberFromPolicy(policy, "maxIntervalMinutes", 1440),
    missedRunGraceMinutes: numberFromPolicy(
      policy,
      "missedRunGraceMinutes",
      10,
    ),
    leaseMinutes: numberFromPolicy(policy, "leaseMinutes", 30),
    maxConsecutiveFailures: numberFromPolicy(
      policy,
      "maxConsecutiveFailures",
      3,
    ),
  };
}

function pendingDashboardSummary(dashboard: WorkshopDashboard | null) {
  if (!dashboard) return "待处理状态读取中";
  const parts = [
    dashboard.counts.outboxDrafts === undefined ? "草稿数量待刷新" : `${dashboard.counts.outboxDrafts} 个草稿`,
    `${dashboard.counts.pendingApprovals} 个待审核`,
    `${dashboard.counts.outboxReady ?? 0} 个待发送`,
    `${dashboard.counts.outboxBlocked ?? 0} 个外发受阻`,
  ];
  if (dashboard.counts.pendingLoopProposals > 0) {
    parts.push(`待审核中 ${dashboard.counts.pendingLoopProposals} 个需激活`);
  }
  return parts.join(" · ");
}

function agentRuntimeLabel(engine: string | null | undefined) {
  if (engine === "pi") return "Pi";
  if (engine === "claude") return "Claude";
  return engine ?? "未知";
}

function dashboardRuntimeSummary(dashboard: WorkshopDashboard | null) {
  const runtime = dashboard?.contextCost?.latestRuntime;
  if (!runtime) return "运行时待记录";
  const parts = [`运行时 ${agentRuntimeLabel(runtime.engine)}`];
  if (runtime.adapter) parts.push(runtime.adapter);
  if (runtime.source) parts.push(`来源 ${runtime.source}`);
  if (runtime.piProtocol) parts.push(`协议 ${runtime.piProtocol}`);
  if (runtime.modelTier) parts.push(`档位 ${runtime.modelTier}`);
  if (runtime.allowedToolCount != null) parts.push(`工具 ${runtime.allowedToolCount}`);
  if (runtime.runtimeHash) parts.push(`快照 ${shortHash(runtime.runtimeHash)}`);
  if (runtime.policyHash) parts.push(`策略 ${shortHash(runtime.policyHash)}`);
  return parts.join(" · ");
}

function shortHash(value: string) {
  return value.slice(0, 8);
}

function fallbackDashboardLoop(loop: WorkshopLoop): WorkshopDashboardLoop {
  return {
    ...loop,
    dashboardStatus: loop.status,
    triggerConfig: {},
    currentPhase: null,
    nextAction: null,
    blockedReason: null,
    lastObservation: null,
    stateJson: {},
    nextScheduledRunAt: null,
    schedulerStatus: null,
    latestRun: null,
  };
}

function mergeWorkshopLiveRefreshPlans(
  current: WorkshopLiveRefreshPlan | null,
  next: WorkshopLiveRefreshPlan | null,
): WorkshopLiveRefreshPlan | null {
  if (!current) return next;
  if (!next) return current;
  return {
    detail: current.detail || next.detail,
    loopDetail: current.loopDetail || next.loopDetail,
    panels: Array.from(new Set([...current.panels, ...next.panels])),
  };
}

function ReviewLocationLink({workId,reviewId,onSelect}:{workId:string|null;reviewId:string;onSelect:(id:string)=>void}) {
  return <a className="mb-2 inline-block text-xs underline" href={`?workId=${encodeURIComponent(workId??'')}&tab=review&reviewId=${encodeURIComponent(reviewId)}`} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onSelect(reviewId);}}>定位此审核</a>;
}

export function WorkshopClient() {
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [presentationSnapshot, setPresentationSnapshot] = useState<{
    workshopId: string;
    presentation: WorkPresentationV1 | null;
  } | null>(null);
  const [presentationLoading, setPresentationLoading] = useState(false);
  const [presentationError, setPresentationError] = useState<string | null>(null);
  const [ownerOverview, setOwnerOverview] = useState<OwnerWorkOverviewResponse | null>(null);
  const [ownerOverviewError, setOwnerOverviewError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listReady,setListReady]=useState(false);
  const [preferredId,setPreferredId]=useState<string|null>(null);
  const {selectedId,setSelectedId,activeSideTab,setActiveSideTab,managementView,setManagementView,isDetailsPanelOpen,setIsDetailsPanelOpen,selectedRunId,setSelectedRunId,selectedReviewId,setSelectedReviewId}=useWorkshopLocation(workshops.map(item=>item.id),listReady,preferredId);
  const {loopIntent,setLoopIntent,acknowledgeDraft,draftWarning,draftsReady}=useWorkshopTextDrafts(selectedId);
  const [sidePanelDirection, setSidePanelDirection] =
    useState<SidePanelDirection>("next");
  const activeDetailSection = detailSectionForTab(activeSideTab);
  const [detailSnapshot, setDetail] = useState<WorkshopDetail | null>(null);
  const detail=detailSnapshot?.workshop.id===selectedId?detailSnapshot:null;
  const [toolMatrix, setToolMatrix] = useState<AgentToolMatrixResponse | null>(
    null,
  );
  const [toolMatrixLoading, setToolMatrixLoading] = useState(false);
  const [workModel, setWorkModel] = useState<WorkshopWorkModel | null>(null);
  const [workVersions, setWorkVersions] = useState<WorkshopWorkVersion[]>([]);
  const [memoryRecallQuality, setMemoryRecallQuality] =
    useState<MemoryRecallQualityReport | null>(null);
  const [loadedPanels, setLoadedPanels] = useState<LoadedWorkshopPanels>({
    dashboard: false,
    work: false,
    sources: false,
    memories: false,
    outbox: false,
  });
  const [panelLoading, setPanelLoading] = useState<
    Partial<Record<keyof LoadedWorkshopPanels, boolean>>
  >({});
  const [restoringWorkVersionId, setRestoringWorkVersionId] = useState<
    string | null
  >(null);
  const [interactionEvents, setInteractionEvents] = useState<
    InteractionEvent[]
  >([]);
  const [interactionWiki, setInteractionWiki] = useState<InteractionWiki>({
    notes: [],
    tasks: [],
    memories: [],
  });
  const [interactionsLoading, setInteractionsLoading] = useState(false);
  const [recordingWechatMessages, setRecordingWechatMessages] = useState(false);
  const [wikiActionId, setWikiActionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [runningLoopId, setRunningLoopId] = useState<string | null>(null);
  const [updatingLoopActivationId, setUpdatingLoopActivationId] = useState<
    string | null
  >(null);
  const [updatingLoopStatusId, setUpdatingLoopStatusId] = useState<
    string | null
  >(null);
  const [selectedLoopDetailId, setSelectedLoopDetailId] = useState<
    string | null
  >(null);
  const [loopDetail, setLoopDetail] = useState<WorkshopLoopDetail | null>(null);
  const [loadingLoopDetailId, setLoadingLoopDetailId] = useState<string | null>(
    null,
  );
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(
    null,
  );
  const [resumingApprovalId, setResumingApprovalId] = useState<string | null>(
    null,
  );
  const [outboxActionId, setOutboxActionId] = useState<string | null>(null);
  const [watchlistProposalActionId, setWatchlistProposalActionId] = useState<
    string | null
  >(null);
  const [agentChangeActionId, setAgentChangeActionId] = useState<string | null>(
    null,
  );
  const [reviewItemsSnapshot, setReviewItems] = useState<WorkshopReviewItem[] | null>(
    null,
  );
  const reviewLocation=useWorkshopReviewLocation<WorkshopReviewItem,WorkshopEvent>(selectedId,selectedReviewId,reviewItemsSnapshot);
  const reviewItems=useMemo(()=>{
    const target=reviewLocation.data?.item;
    const scoped=reviewItemsSnapshot?.filter(item=>item.workshopId===selectedId)??null;
    if(!target||target.workshopId!==selectedId)return scoped;
    const rest=(scoped??[]).filter(item=>item.id!==target.id);
    return target.status==='pending'?[target,...rest]:rest;
  },[reviewItemsSnapshot,reviewLocation.data,selectedId]);
  const reviewLocationRef=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    if(!selectedReviewId||activeSideTab!=='review')return;
    reviewLocationRef.current?.scrollIntoView({block:'start'});
  },[selectedReviewId,activeSideTab,reviewLocation.data,reviewLocation.error]);
  const [reviewItemsLoading, setReviewItemsLoading] = useState(false);
  const [reviewItemActionId, setReviewItemActionId] = useState<string | null>(
    null,
  );
  const [douyinDrafts, setDouyinDrafts] = useState<DouyinDraftSummary[]>([]);
  const [douyinDraftsLoading, setDouyinDraftsLoading] = useState(false);
  const [videoReviewActionId, setVideoReviewActionId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingWorkRequest | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const commandClientRef = useRef<ReturnType<typeof createWorkCommandClient> | null>(null);
  function getCommandClient() {
    return commandClientRef.current ??= createWorkCommandClient({storage:window.sessionStorage,fetch:window.fetch.bind(window),uuid:()=>crypto.randomUUID(),onPending:value=>{setPendingCommand(value);if(value)setCommandNotice(null);}});
  }
  function submitWorkAction<T>(url:string,init:RequestInit,expectedVersion?:number):Promise<T> {
    const workId=url.split('/')[3];
    const version=expectedVersion ?? (detail?.workshop.id===workId?detail.commandVersion:undefined);
    return getCommandClient().submit<T>({url,method:init.method as 'POST'|'PATCH'|'DELETE',body:JSON.parse(typeof init.body==='string'?init.body:'{}'),expectedVersion:version as number});
  }
  useEffect(()=>{try {void getCommandClient().pending().catch(error=>setError(error.message));}catch(error){setError(error instanceof Error?error.message:String(error));}},[]);
  async function recoverPendingCommand() {
    setBusy(true);setError(null);
    try {
      const pending=pendingCommand;
      const recovered=await getCommandClient().recover();
      setCommandNotice(recovered ? '上次提交已核对，未提交的新编辑保持不变。' : '当前身份没有待核对请求。');
      setManifestReview(null);
      let removedWorkId:string|null=null;
      if(recovered && pending){
        const pendingWorkId=pending.url.split('/')[3];
        if(pending.url.endsWith('/directives')&&typeof pending.body.content==='string')acknowledgeDraft(pendingWorkId,'directive',pending.body.content);
        if(pending.url.endsWith('/loops') && typeof pending.body.intent==='string')acknowledgeDraft(pendingWorkId,'loopIntent',pending.body.intent);
        if(pending.method==='DELETE' && /^\/api\/workshops\/[a-zA-Z0-9-]+$/.test(pending.url)){
          removedWorkId=pending.url.split('/')[3];
          setSelectedId(current=>current===removedWorkId?null:current);
          setDetail(current=>current?.workshop.id===removedWorkId?null:current);
        }
      }
      await refreshWorkshops(true);
      if(selectedId && selectedId!==removedWorkId)await Promise.all([refreshDetail(selectedId), refreshReviewItems(selectedId)]);
    }catch(error){setError(error instanceof Error?error.message:String(error));}
    finally {setBusy(false);}
  }
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [manifestBaseline, setManifestBaseline] = useState<{workshopId: string | null; commandVersion: number} | null>(null);
  const [newTemplateId, setNewTemplateId] = useState<string>(
    WORKSHOP_TEMPLATES[0].id,
  );
  const [newName, setNewName] = useState<string>(WORKSHOP_TEMPLATES[0].name);
  const [newMission, setNewMission] = useState<string>(
    WORKSHOP_TEMPLATES[0].mission,
  );
  const [manifestYaml, setManifestYaml] = useState(
    DEFAULT_WORKSHOP_MANIFEST_YAML,
  );
  const [manifestReview, setManifestReview] =
    useState<WorkshopManifestReview | null>(null);
  const [manifestReviewing, setManifestReviewing] = useState(false);
  const [isWorkLogExpanded, setIsWorkLogExpanded] = useState(false);
  const [workLogSnapshot, setWorkLogSnapshot] =
    useState<WorkLogSnapshot | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUri, setSourceUri] = useState("");
  const [sourceContent, setSourceContent] = useState("");
  const [creatingLoop, setCreatingLoop] = useState(false);
  const [outboxRecipients, setOutboxRecipients] = useState<
    Record<string, string>
  >({});
  const [boundaryForm, setBoundaryForm] =
    useState<WorkshopBoundaryPolicy | null>(null);
  const [heartbeatForm, setHeartbeatForm] =
    useState<HeartbeatPolicyForm | null>(null);
  const configurationDrafts = useRef(new Map<string,{boundary:VersionedDraft<WorkshopBoundaryPolicy>;heartbeat:VersionedDraft<HeartbeatPolicyForm>}>());
  const liveDetailRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const liveDetailRefreshPlanRef = useRef<WorkshopLiveRefreshPlan | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const selectedLoopDetailIdRef = useRef<string | null>(null);
  const {read:coalescedJsonFetch,states:readStates}=useWorkshopReads(jsonFetch);

  const selectedWorkshop = useMemo(
    () => detail?.workshop ?? workshops.find((item) => item.id === selectedId),
    [detail?.workshop, selectedId, workshops],
  );

  const handleSideTabChange = useCallback(
    (value: string) => {
      if (!SIDE_PANEL_TAB_VALUES.includes(value as SidePanelTab)) return;
      const nextTab = value as SidePanelTab;
      const currentIndex = SIDE_PANEL_TAB_VALUES.indexOf(activeSideTab);
      const nextIndex = SIDE_PANEL_TAB_VALUES.indexOf(nextTab);
      setSidePanelDirection(nextIndex >= currentIndex ? "next" : "previous");
      setActiveSideTab(nextTab);
    },
    [activeSideTab],
  );

  const sidePanelContentClass = useMemo(
    () =>
      cn(
        "m-0 data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-150 data-[state=active]:ease-out",
        "min-h-0 shrink-0 overflow-visible overscroll-contain",
        sidePanelDirection === "next"
          ? "data-[state=active]:slide-in-from-right-4"
          : "data-[state=active]:slide-in-from-left-4",
      ),
    [sidePanelDirection],
  );

  const sidePanelTriggerClass = "shrink-0 snap-start whitespace-nowrap";

  const updateBoundaryForm = useCallback(
    (patch: Partial<WorkshopBoundaryPolicy>) => {
      const draft=configurationDrafts.current.get(selectedIdRef.current ?? '');
      if(!draft)return;
      draft.boundary=editDraft(draft.boundary,serializeWorkshopBoundaryPolicy({...draft.boundary.value,...patch}));
      setBoundaryForm(draft.boundary.value);
    },
    [],
  );

  const updateHeartbeatForm = useCallback(
    (patch: Partial<HeartbeatPolicyForm>) => {
      const draft=configurationDrafts.current.get(selectedIdRef.current ?? '');
      if(!draft)return;
      draft.heartbeat=editDraft(draft.heartbeat,{...draft.heartbeat.value,...patch});
      setHeartbeatForm(draft.heartbeat.value);
    },
    [],
  );

  const refreshOwnerOverview = useCallback(async () => {
    try {
      const data = await coalescedJsonFetch<OwnerWorkOverviewResponse>('/api/page-state/workshop/owner');
      setOwnerOverview(data);
      setOwnerOverviewError(false);
    } catch {
      setOwnerOverviewError(true);
    }
  }, [coalescedJsonFetch]);

  const refreshWorkshops = useCallback(async (force = false) => {
    const [data] = await Promise.all([
      coalescedJsonFetch<WorkshopPageState>(`/api/page-state/workshop${force ? '?refresh=1' : ''}`),
      refreshOwnerOverview(),
    ]);
    const nextWorkshops = data.workshops.map((item) => item.workshop);
    setWorkshops(nextWorkshops);
    setPreferredId(data.selectedWorkshopId);
    setListReady(true);
  }, [coalescedJsonFetch, refreshOwnerOverview]);

  const markPanelLoaded = useCallback((panel: keyof LoadedWorkshopPanels) => {
    setLoadedPanels((current) => ({ ...current, [panel]: true }));
  }, []);

  const setPanelBusy = useCallback(
    (panel: keyof LoadedWorkshopPanels, value: boolean) => {
      setPanelLoading((current) => ({ ...current, [panel]: value }));
    },
    [],
  );

  const refreshDetail = useCallback(
    async (id: string, options?: { force?: boolean }) => {
      const suffix = options?.force === false ? "" : "?refresh=1";
      const data = await coalescedJsonFetch<
        WorkshopDetail & {
          interfaceVersion?: string;
          generatedAt?: string;
        }
      >(`/api/page-state/workshop/${id}/summary${suffix}`);
      if (selectedIdRef.current !== id) return;
      setDetail((current) => ({
        ...data,
        sources: current?.workshop.id === id ? current.sources : data.sources,
        memories:
          current?.workshop.id === id ? current.memories : data.memories,
        outbox: current?.workshop.id === id ? current.outbox : data.outbox,
        dashboard:
          mergeDashboardSummary(current?.workshop.id === id ? current.dashboard : null, data.dashboard),
        events: sortWorkshopEvents(data.events),
      }));
    },
    [coalescedJsonFetch],
  );

  const refreshDashboard = useCallback(
    async (id: string) => {
      setPanelBusy("dashboard", true);
      try {
        const dashboard = await coalescedJsonFetch<WorkshopDashboard>(
          `/api/workshops/${id}/dashboard?refresh=1`,
        );
        if (selectedIdRef.current !== id) return;
        setDetail((current) =>
          current?.workshop.id === id && !isOlderProjection(current.dashboard, dashboard) ? { ...current, dashboard } : current,
        );
        markPanelLoaded("dashboard");
      } finally {
        if (selectedIdRef.current === id) setPanelBusy("dashboard", false);
      }
    },
    [coalescedJsonFetch, markPanelLoaded, setPanelBusy],
  );

  const refreshWorkModel = useCallback(
    async (id: string) => {
      setPanelBusy("work", true);
      try {
        const work = await coalescedJsonFetch<WorkshopWorkResponse>(
          `/api/workshops/${id}/work`,
        );
        if (selectedIdRef.current !== id) return;
        setWorkModel(work.work);
        setWorkVersions(work.versions ?? []);
        markPanelLoaded("work");
      } finally {
        if (selectedIdRef.current === id) setPanelBusy("work", false);
      }
    },
    [coalescedJsonFetch, markPanelLoaded, setPanelBusy],
  );

  const refreshSources = useCallback(
    async (id: string) => {
      setPanelBusy("sources", true);
      try {
        const data = await coalescedJsonFetch<{ sources: WorkshopSource[] }>(
          `/api/workshops/${id}/sources`,
        );
        if (selectedIdRef.current !== id) return;
        setDetail((current) =>
          current?.workshop.id === id
            ? { ...current, sources: data.sources }
            : current,
        );
        markPanelLoaded("sources");
      } finally {
        if (selectedIdRef.current === id) setPanelBusy("sources", false);
      }
    },
    [coalescedJsonFetch, markPanelLoaded, setPanelBusy],
  );

  const refreshMemories = useCallback(
    async (id: string) => {
      setPanelBusy("memories", true);
      try {
        const [data, recallQuality] = await Promise.all([
          coalescedJsonFetch<{ memories: WorkshopMemory[] }>(
            `/api/workshops/${id}/memories`,
          ),
          coalescedJsonFetch<MemoryRecallQualityReport>(
            `/api/workshops/${id}/memory-recall-quality?days=7`,
          ).catch(() => undefined),
        ]);
        if (selectedIdRef.current !== id) return;
        setDetail((current) =>
          current?.workshop.id === id
            ? { ...current, memories: data.memories }
            : current,
        );
        if(recallQuality!==undefined)setMemoryRecallQuality(recallQuality);
        markPanelLoaded("memories");
      } finally {
        if (selectedIdRef.current === id) setPanelBusy("memories", false);
      }
    },
    [coalescedJsonFetch, markPanelLoaded, setPanelBusy],
  );

  const refreshOutbox = useCallback(
    async (id: string) => {
      setPanelBusy("outbox", true);
      try {
        const data = await coalescedJsonFetch<{ outbox: WorkshopOutbox[] }>(
          `/api/workshops/${id}/outbox`,
        );
        if (selectedIdRef.current !== id) return;
        setDetail((current) =>
          current?.workshop.id === id
            ? { ...current, outbox: data.outbox }
            : current,
        );
        markPanelLoaded("outbox");
      } finally {
        if (selectedIdRef.current === id) setPanelBusy("outbox", false);
      }
    },
    [coalescedJsonFetch, markPanelLoaded, setPanelBusy],
  );

  const refreshToolMatrix = useCallback(
    async (id: string) => {
      setToolMatrixLoading(true);
      try {
        const tools = await coalescedJsonFetch<AgentToolMatrixResponse>(
          `/api/workshops/${id}/tools`,
        );
        if (selectedIdRef.current !== id) return;
        setToolMatrix(tools);
      } finally {
        if (selectedIdRef.current === id) setToolMatrixLoading(false);
      }
    },
    [coalescedJsonFetch],
  );

  const refreshDouyinDrafts = useCallback(async () => {
    setDouyinDraftsLoading(true);
    try {
      const data = await coalescedJsonFetch<DouyinDraftListResponse>(
        "/api/douyin/drafts",
      );
      setDouyinDrafts(data.ok ? data.drafts : []);
    } finally {
      setDouyinDraftsLoading(false);
    }
  }, [coalescedJsonFetch]);

  const refreshReviewItems = useCallback(
    async (id: string) => {
      setReviewItemsLoading(true);
      try {
        const data = await coalescedJsonFetch<WorkshopReviewItemsResponse>(
          `/api/workshops/${id}/review-items`,
        );
        if (selectedIdRef.current !== id) return;
        setReviewItems(data.items);
      } finally {
        if (selectedIdRef.current === id) setReviewItemsLoading(false);
      }
    },
    [coalescedJsonFetch],
  );

  const refreshPanelByName = useCallback(
    (id: string, panel: WorkshopLiveRefreshPanel) => {
      switch (panel) {
        case "dashboard":
          return refreshDashboard(id);
        case "work":
          return refreshWorkModel(id);
        case "sources":
          return refreshSources(id);
        case "memories":
          return refreshMemories(id);
        case "outbox":
          return refreshOutbox(id);
        case "review":
          return refreshReviewItems(id);
      }
    },
    [
      refreshDashboard,
      refreshMemories,
      refreshOutbox,
      refreshReviewItems,
      refreshSources,
      refreshWorkModel,
    ],
  );

  const refreshLiveDetail = useCallback(
    async (id: string, plan?: WorkshopLiveRefreshPlan | null) => {
      const refreshes: Array<Promise<unknown>> = [];
      if (!plan || plan.detail) {
        refreshes.push(refreshDetail(id));
      }
      const panels = plan?.panels ?? [];
      for (const panel of panels) {
        if (panel === "review") {
          if (
            reviewItems !== null ||
            activeSideTab === "review" ||
            activeSideTab === "attention"
          ) {
            refreshes.push(refreshPanelByName(id, panel));
          }
          continue;
        }
        if (loadedPanels[panel]) {
          refreshes.push(refreshPanelByName(id, panel));
        }
      }
      if (refreshes.length === 0) return;
      await Promise.all(refreshes);
    },
    [
      loadedPanels.dashboard,
      loadedPanels.memories,
      loadedPanels.outbox,
      loadedPanels.sources,
      loadedPanels.work,
      activeSideTab,
      refreshDetail,
      refreshPanelByName,
      reviewItems,
    ],
  );

  const refreshInteractions = useCallback(async () => {
    setInteractionsLoading(true);
    try {
      const [data, wiki] = await Promise.all([
        coalescedJsonFetch<{ events: InteractionEvent[] }>(
          "/api/interactions/events?platform=wechat&limit=50",
        ),
        coalescedJsonFetch<InteractionWiki>("/api/interactions/wiki?limit=20"),
      ]);
      setInteractionEvents(data.events);
      setInteractionWiki(wiki);
    } finally {
      setInteractionsLoading(false);
    }
  }, [coalescedJsonFetch]);

  const loadLoopDetail = useCallback((workshopId: string, loopId: string) => {
    return coalescedJsonFetch<WorkshopLoopDetail>(
      `/api/workshops/${workshopId}/loops/${loopId}/detail`,
    );
  }, [coalescedJsonFetch]);

  const scheduleLiveDetailRefresh = useCallback(
    (
      workshopId: string,
      event?: WorkshopEvent,
      plan?: WorkshopLiveRefreshPlan,
    ) => {
      liveDetailRefreshPlanRef.current = mergeWorkshopLiveRefreshPlans(
        liveDetailRefreshPlanRef.current,
        plan ?? null,
      );
      if (liveDetailRefreshTimerRef.current) return;
      liveDetailRefreshTimerRef.current = setTimeout(() => {
        liveDetailRefreshTimerRef.current = null;
        const pendingPlan = liveDetailRefreshPlanRef.current;
        liveDetailRefreshPlanRef.current = null;
        refreshLiveDetail(workshopId, pendingPlan)
          .then(async () => {
            const loopId = selectedLoopDetailIdRef.current;
            if (!loopId || selectedIdRef.current !== workshopId) return;
            if (!pendingPlan?.loopDetail) return;
            if (event?.loopId && event.loopId !== loopId) return;
            const data = await loadLoopDetail(workshopId, loopId);
            if (
              selectedIdRef.current === workshopId &&
              selectedLoopDetailIdRef.current === loopId
            ) {
              setLoopDetail(data);
            }
          })
          .catch((err) => {
            if (selectedIdRef.current === workshopId) {
              setError(err instanceof Error ? err.message : String(err));
            }
          });
      }, 800);
    },
    [loadLoopDetail, refreshLiveDetail],
  );

  const refreshSelectedLoopDetail = useCallback(async () => {
    if (!selectedId || !selectedLoopDetailId) return;
    setLoopDetail(await loadLoopDetail(selectedId, selectedLoopDetailId));
  }, [loadLoopDetail, selectedId, selectedLoopDetailId]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setReviewItems(null);
  }, [selectedId]);

  useEffect(() => {
    selectedLoopDetailIdRef.current = selectedLoopDetailId;
  }, [selectedLoopDetailId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refreshWorkshops()
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshWorkshops]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshOwnerOverview();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refreshOwnerOverview]);

  useEffect(() => {
    if (liveDetailRefreshTimerRef.current) {
      clearTimeout(liveDetailRefreshTimerRef.current);
      liveDetailRefreshTimerRef.current = null;
    }
    if (!selectedId) {
      setDetail(null);
      setToolMatrix(null);
      setToolMatrixLoading(false);
      setWorkModel(null);
      setWorkVersions([]);
      setMemoryRecallQuality(null);
      setWorkLogSnapshot(null);
      setLoadedPanels({
        dashboard: false,
        work: false,
        sources: false,
        memories: false,
        outbox: false,
      });
      setPanelLoading({});
      setRestoringWorkVersionId(null);
      setInteractionEvents([]);
      setInteractionWiki({ notes: [], tasks: [], memories: [] });
      setInteractionsLoading(false);
      setLoopDetail(null);
      setLoadingLoopDetailId(null);
      setResolvingApprovalId(null);
      setResumingApprovalId(null);
      setOutboxActionId(null);
      setWatchlistProposalActionId(null);
      setDouyinDrafts([]);
      setDouyinDraftsLoading(false);
      setVideoReviewActionId(null);
      return;
    }
    setSelectedLoopDetailId(null);
    setToolMatrix(null);
    setToolMatrixLoading(false);
    setWorkModel(null);
    setWorkVersions([]);
    setMemoryRecallQuality(null);
    setWorkLogSnapshot(null);
    setLoadedPanels({
      dashboard: false,
      work: false,
      sources: false,
      memories: false,
      outbox: false,
    });
    setPanelLoading({});
    setRestoringWorkVersionId(null);
    setInteractionEvents([]);
    setInteractionWiki({ notes: [], tasks: [], memories: [] });
    setInteractionsLoading(false);
    setLoopDetail(null);
    setLoadingLoopDetailId(null);
    setResolvingApprovalId(null);
    setResumingApprovalId(null);
    setOutboxActionId(null);
    setWatchlistProposalActionId(null);
    setVideoReviewActionId(null);
    setDouyinDrafts([]);
    setDouyinDraftsLoading(false);
    refreshDetail(selectedId, { force: false }).catch((err) => {
      if(selectedIdRef.current===selectedId)setError(err instanceof Error ? err.message : String(err));
    });
  }, [refreshDetail, selectedId]);

  useEffect(() => {
    if (!selectedId) return;

    let cancelled = false;
    jsonFetch<{ events: WorkshopEvent[] }>(
      `/api/workshops/${selectedId}/events?limit=500`,
    )
      .then((data) => {
        if (cancelled || selectedIdRef.current !== selectedId) return;
        setWorkLogSnapshot({
          workshopId: selectedId,
          events: sortWorkshopEvents(
            data.events.filter((event) => event.workshopId === selectedId),
          ),
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || activeSideTab !== "loops" || loadedPanels.dashboard) {
      return;
    }
    refreshDashboard(selectedId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [activeSideTab, loadedPanels.dashboard, refreshDashboard, selectedId]);

  useEffect(() => {
    if (!selectedId || activeSideTab !== "loops" || managementView !== "model" || loadedPanels.work) return;
    refreshWorkModel(selectedId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [activeSideTab, loadedPanels.work, managementView, refreshWorkModel, selectedId]);

  useEffect(() => {
    if (!selectedId || activeSideTab !== "sources" || loadedPanels.sources) {
      return;
    }
    refreshSources(selectedId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [activeSideTab, loadedPanels.sources, refreshSources, selectedId]);

  useEffect(() => {
    if (!selectedId || activeSideTab !== "memory" || loadedPanels.memories) {
      return;
    }
    refreshMemories(selectedId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [activeSideTab, loadedPanels.memories, refreshMemories, selectedId]);

  useEffect(() => {
    if (!selectedId || (activeSideTab !== "outbox" && activeSideTab !== "attention") || loadedPanels.outbox) {
      return;
    }
    refreshOutbox(selectedId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [activeSideTab, loadedPanels.outbox, refreshOutbox, selectedId]);

  useEffect(() => {
    if (!selectedId || activeSideTab !== "loops" || managementView !== "tools" || toolMatrix) return;
    refreshToolMatrix(selectedId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [activeSideTab, managementView, refreshToolMatrix, selectedId, toolMatrix]);

  useEffect(() => {
    if (!selectedId || activeSideTab !== "sources") return;
    refreshInteractions().catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [activeSideTab, refreshInteractions, selectedId]);

  useEffect(() => {
    if (!selectedId || (activeSideTab !== "review" && activeSideTab !== "attention")) return;
    Promise.all([
      refreshReviewItems(selectedId),
      ...(activeSideTab === "review" ? [refreshDouyinDrafts()] : []),
    ]).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [activeSideTab, refreshDouyinDrafts, refreshReviewItems, selectedId]);

  useEffect(() => {
    if (!selectedId || selectedWorkshop?.modelConfig?.role !== "investment_publisher") return;
    refreshDouyinDrafts().catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [refreshDouyinDrafts, selectedId, selectedWorkshop?.modelConfig?.role]);

  useEffect(() => {
    if (!selectedId || !selectedLoopDetailId) {
      setLoopDetail(null);
      setLoadingLoopDetailId(null);
      return;
    }

    let cancelled = false;
    setLoopDetail(null);
    setLoadingLoopDetailId(selectedLoopDetailId);
    loadLoopDetail(selectedId, selectedLoopDetailId)
      .then((data) => {
        if (!cancelled) setLoopDetail(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingLoopDetailId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [loadLoopDetail, selectedId, selectedLoopDetailId]);

  useEffect(() => {
    if (!selectedId || !detail || detail.workshop.id !== selectedId) return;

    let lastSeq = detail.events.at(-1)?.seq ?? 0;

    const source = new EventSource(
      `/api/workshops/${selectedId}/events/stream?after=${lastSeq}`,
    );

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as WorkshopEvent;
      if (event.type === "error") {
        return;
      }
      lastSeq = Math.max(lastSeq, event.seq);
      let outboxPatchApplied = false;
      let memoryPatchApplied = false;
      let sourcePatchApplied = false;
      let loopDetailPatchApplied = false;
      setDetail((current) => {
        if (!current || current.workshop.id !== selectedId) return current;
        const outboxPatch = patchOutboxListFromEvent(current.outbox, event);
        const memoryPatch = patchMemoryListFromEvent(current.memories, event);
        const sourcePatch = patchSourceListFromEvent(current.sources, event);
        const dashboardPatch = patchWorkshopDashboardFromEvent(
          current.dashboard,
          event,
        );
        outboxPatchApplied = outboxPatch.applied;
        memoryPatchApplied = memoryPatch.applied;
        sourcePatchApplied = sourcePatch.applied;
        return {
          ...current,
          events: mergeWorkshopEvents(current.events, event),
          outbox: outboxPatch.outbox,
          memories: memoryPatch.memories,
          sources: sourcePatch.sources,
          dashboard: dashboardPatch.dashboard,
        };
      });
      setWorkLogSnapshot((current) =>
        current?.workshopId === selectedId
          ? {
              ...current,
              events: mergeWorkshopEvents(current.events, event),
            }
          : current,
      );
      setLoopDetail((current) => {
        const patch = patchLoopDetailFromEvent(current, event);
        loopDetailPatchApplied = patch.applied;
        return patch.detail;
      });
      const baseRefreshPlan = getWorkshopLiveRefreshPlan(event);
      const locallyPatchedPanels = new Set<WorkshopLiveRefreshPanel>();
      if (outboxPatchApplied) locallyPatchedPanels.add("outbox");
      if (memoryPatchApplied) locallyPatchedPanels.add("memories");
      if (sourcePatchApplied) locallyPatchedPanels.add("sources");
      const canUseLoopLocalPatch =
        event.type === "loop_run_started" || event.type === "loop_run_completed";
      // Local event patches do not replace authoritative aggregate counts.
      const refreshPlan = locallyPatchedPanels.size > 0 || (canUseLoopLocalPatch && loopDetailPatchApplied)
        ? {
            ...baseRefreshPlan,
            detail: baseRefreshPlan.detail,
            panels: baseRefreshPlan.panels.filter(
              (panel) => !locallyPatchedPanels.has(panel),
            ),
            loopDetail:
              canUseLoopLocalPatch && loopDetailPatchApplied
                ? false
                : baseRefreshPlan.loopDetail,
          }
        : baseRefreshPlan;
      if (
        refreshPlan.detail ||
        refreshPlan.panels.length > 0 ||
        refreshPlan.loopDetail
      ) {
        scheduleLiveDetailRefresh(selectedId, event, refreshPlan);
      }
      if (
        [
          "wechat_messages_recorded",
          "interaction_note_created",
          "interaction_task_detected",
          "interaction_memory_candidate",
          "interaction_processor_completed",
        ].includes(event.type) &&
        activeSideTab === "sources"
      ) {
        refreshInteractions().catch(() => {});
      }
      if (event.type === "publish_draft" && activeSideTab === "review") {
        refreshDouyinDrafts().catch(() => {});
      }
    };

    source.onerror = () => {
      // Let EventSource use its built-in reconnect. Duplicate history from a
      // reconnect is filtered by event id in the state updater.
    };

    return () => {
      source.close();
    };
  }, [
    detail?.workshop.id,
    activeSideTab,
    refreshDouyinDrafts,
    refreshInteractions,
    scheduleLiveDetailRefresh,
    selectedId,
  ]);

  useEffect(() => {
    return () => {
      if (liveDetailRefreshTimerRef.current) {
        clearTimeout(liveDetailRefreshTimerRef.current);
        liveDetailRefreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedWorkshop || selectedWorkshop.id!==selectedId || !Number.isSafeInteger(detail?.commandVersion)) {
      setBoundaryForm(null);
      setHeartbeatForm(null);
      return;
    }
    const previous=configurationDrafts.current.get(selectedWorkshop.id);
    const draft={boundary:refreshDraft(previous?.boundary,getWorkshopBoundaryPolicy(selectedWorkshop),detail!.commandVersion!),
      heartbeat:refreshDraft(previous?.heartbeat,heartbeatFormFromRow(detail?.heartbeat ?? null),detail!.commandVersion!)};
    configurationDrafts.current.set(selectedWorkshop.id,draft);
    setBoundaryForm(draft.boundary.value);
    setHeartbeatForm(draft.heartbeat.value);
  }, [
    selectedId,
    detail?.commandVersion,
    selectedWorkshop?.id,
    selectedWorkshop?.autonomyLevel,
    selectedWorkshop?.boundaryPolicy,
    detail?.heartbeat,
  ]);

  async function applyWorkshopYaml() {
    setBusy(true);
    setError(null);
    try {
      if (!manifestReview?.ok) {
        throw new Error("Manifest must pass review before applying.");
      }
      if (!manifestBaseline) throw new Error("请重新打开编辑器读取完整配置。");
      const data = await getCommandClient().submit<{
        workshop: Workshop;
        review: WorkshopManifestReview;
      }>({url:manifestBaseline.workshopId ? `/api/workshops/${manifestBaseline.workshopId}` : "/api/workshops",
        method: manifestBaseline.workshopId ? "PATCH" : "POST",
        body: {
          manifestYaml,
          apply: true,
        },
        expectedVersion: manifestBaseline.commandVersion,
      });
      await refreshWorkshops(true);
      setSelectedId(data.workshop.id);
      setIsCreateDialogOpen(false);
      setManifestReview(null);
      if (!manifestBaseline.workshopId) {
        setManifestYaml(DEFAULT_WORKSHOP_MANIFEST_YAML);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message === "version_conflict" ? "配置已被其他操作修改。当前草稿已保留，请复制需要的内容，重新打开编辑器核对最新配置。" : message);
    } finally {
      setBusy(false);
    }
  }

  async function reviewManifestYaml() {
    setManifestReviewing(true);
    setError(null);
    try {
      if (!manifestBaseline) throw new Error("请重新打开编辑器读取完整配置。");
      const data = await jsonFetch<{ review: WorkshopManifestReview }>(
        manifestBaseline.workshopId ? `/api/workshops/${manifestBaseline.workshopId}` : "/api/workshops",
        {
          method: manifestBaseline.workshopId ? "PATCH" : "POST",
          body: JSON.stringify({
            manifestYaml,
            dryRun: true,
          }),
        },
      );
      setManifestReview(data.review);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(String(err));
      }
      setManifestReview(null);
    } finally {
      setManifestReviewing(false);
    }
  }

  async function deleteWorkshop(workshopId: string) {
    const workshop = workshops.find((item) => item.id === workshopId);
    if (!workshop) return;
    let baseline:{workshop:Workshop;commandVersion:number};
    try {baseline=await jsonFetch(`/api/workshops/${workshopId}`);}
    catch(error){setError(error instanceof Error?error.message:String(error));return;}
    const confirmed = window.confirm(
      `删除车间「${baseline.workshop.name}」？这会同时删除它的工作记录、记忆、资料源、待发草稿和唤醒设置。`,
    );
    if (!confirmed) return;

    setDeletingId(workshopId);
    setError(null);
    try {
      await submitWorkAction<{ workshop: Workshop }>(`/api/workshops/${workshopId}`, {
        method: "DELETE",
      },baseline.commandVersion);
      const remaining = workshops.filter((item) => item.id !== workshopId);
      setWorkshops(remaining);
      setSelectedId((current) =>
        current === workshopId ? (remaining[0]?.id ?? null) : current,
      );
      setDetail((current) =>
        current?.workshop.id === workshopId ? null : current,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  async function startRun() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/runs`, {
        method: "POST",
        body: JSON.stringify({ triggerReason: { type: "manual" } }),
      });
      setCommandNotice('运行请求已排队，请在运行记录中核对状态。');
      await refreshDetail(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runWorkshopLoop(loopId: string) {
    if (!selectedId) return;
    setRunningLoopId(loopId);
    setError(null);
    try {
      await jsonFetch(`/api/workshops/${selectedId}/loops/${loopId}/execute`, {
        method: "POST",
        body: JSON.stringify({ mode: "native_agent" }),
      });
      setCommandNotice("Loop 运行已排队，请在运行记录中查看进度。");
      scheduleLiveDetailRefresh(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      window.setTimeout(() => {
        setRunningLoopId((current) => (current === loopId ? null : current));
      }, 1200);
    }
  }

  async function updateLoopActivation(
    loopId: string,
    action: "activate" | "reject",
  ) {
    if (!selectedId) return;
    setUpdatingLoopActivationId(loopId);
    setError(null);
    try {
      await submitWorkAction(
        `/api/workshops/${selectedId}/loops/${loopId}/activation`,
        {
          method: "POST",
          body: JSON.stringify({ action }),
        },
      );
      await Promise.all([
        refreshDetail(selectedId),
        refreshDashboard(selectedId),
        reviewItems !== null
          ? refreshReviewItems(selectedId)
          : Promise.resolve(),
      ]);
      if (selectedLoopDetailId === loopId) {
        setLoopDetail(await loadLoopDetail(selectedId, loopId));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setUpdatingLoopActivationId(null);
    }
  }

  async function updateLoopStatus(
    loop: WorkshopDashboardLoop,
    action: "pause" | "resume",
  ) {
    if (!selectedId) return;
    setUpdatingLoopStatusId(loop.id);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/loops/${loop.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          action,
          reason:
            action === "pause"
              ? "Owner paused loop from workshop UI"
              : "Owner resumed loop from workshop UI",
        }),
      });
      await Promise.all([
        refreshDetail(selectedId),
        refreshDashboard(selectedId),
      ]);
      if (selectedLoopDetailId === loop.id) {
        setLoopDetail(await loadLoopDetail(selectedId, loop.id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setUpdatingLoopStatusId(null);
    }
  }

  async function clearLoopBlocker(loop: WorkshopDashboardLoop) {
    if (!selectedId) return;
    setUpdatingLoopStatusId(loop.id);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/loops/${loop.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          action: "clear_blocker",
          reason:
            "Owner dismissed blocker without rerun; not current time window, not worth rerun cost, or intentionally deferred",
        }),
      });
      await Promise.all([
        refreshDetail(selectedId),
        refreshDashboard(selectedId),
      ]);
      if (selectedLoopDetailId === loop.id) {
        setLoopDetail(await loadLoopDetail(selectedId, loop.id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setUpdatingLoopStatusId(null);
    }
  }

  async function deleteWorkshopLoop(loop: WorkshopDashboardLoop) {
    if (!selectedId) return;
    const confirmed = window.confirm(
      `删除任务「${loop.name}」？这会从任务列表隐藏，但保留历史运行记录和审计事件。`,
    );
    if (!confirmed) return;

    setUpdatingLoopStatusId(loop.id);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/loops/${loop.id}`, {
        method: "DELETE",
        body: JSON.stringify({
          reason: "Owner archived loop from workshop UI",
        }),
      });
      await Promise.all([
        refreshDetail(selectedId),
        refreshDashboard(selectedId),
      ]);
      if (selectedLoopDetailId === loop.id) {
        setSelectedLoopDetailId(null);
        setLoopDetail(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setUpdatingLoopStatusId(null);
    }
  }

  async function resolveLoopApproval(
    approvalId: string,
    status: "approved" | "rejected",
  ) {
    if (!selectedId) return;
    setResolvingApprovalId(approvalId);
    setError(null);
    try {
      await jsonFetch(`/api/loops/approvals/${approvalId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await Promise.all([
        refreshDetail(selectedId),
        refreshDashboard(selectedId),
      ]);
      await refreshSelectedLoopDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshSelectedLoopDetail().catch(() => {});
    } finally {
      setResolvingApprovalId(null);
    }
  }

  async function resumeLoopApproval(approvalId: string) {
    if (!selectedId) return;
    setResumingApprovalId(approvalId);
    setError(null);
    try {
      await jsonFetch(`/api/loops/approvals/${approvalId}/resume`, {
        method: "POST",
        body: JSON.stringify({
          note: "Resumed from workshop loop detail",
        }),
      });
      await Promise.all([
        refreshDetail(selectedId),
        refreshDashboard(selectedId),
      ]);
      await refreshSelectedLoopDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshSelectedLoopDetail().catch(() => {});
    } finally {
      setResumingApprovalId(null);
    }
  }

  async function createWorkshopLoopFromIntent() {
    if (!selectedId || !loopIntent.trim()) return;
    const submittedIntent=loopIntent;
    setCreatingLoop(true);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/loops`, {
        method: "POST",
        body: JSON.stringify({
          type: "natural_language",
          intent: submittedIntent,
          create: true,
          externalWriteMode: "manual_approval",
        }),
      });
      acknowledgeDraft(selectedId,'loopIntent',submittedIntent);
      await Promise.all([
        refreshDetail(selectedId),
        refreshDashboard(selectedId),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setCreatingLoop(false);
    }
  }

  async function createDailyBriefLoop() {
    if (!selectedId) return;
    setCreatingLoop(true);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/loops`, {
        method: "POST",
        body: JSON.stringify({
          type: "template",
          templateId: "daily-brief",
          input: { timezone: "Asia/Shanghai" },
        }),
      });
      await Promise.all([
        refreshDetail(selectedId),
        refreshDashboard(selectedId),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setCreatingLoop(false);
    }
  }

  async function addSource() {
    if (!selectedId || !sourceName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await jsonFetch(`/api/workshops/${selectedId}/sources`, {
        method: "POST",
        body: JSON.stringify({
          type: /^(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)/i.test(sourceUri.trim()) ? "file" : sourceUri.trim() ? "url" : "manual",
          name: sourceName.trim(),
          uri: sourceUri.trim() || null,
          content: sourceContent || null,
        }),
      });
      setSourceName("");
      setSourceUri("");
      setSourceContent("");
      await Promise.all([
        refreshDetail(selectedId),
        refreshSources(selectedId),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function recordWechatMessages() {
    if (!selectedId) return;
    setRecordingWechatMessages(true);
    setError(null);
    try {
      await jsonFetch("/api/interactions/wechat/record-new", {
        method: "POST",
        body: JSON.stringify({
          workshopId: selectedId,
          limit: 50,
        }),
      });
      await Promise.all([refreshDetail(selectedId), refreshInteractions()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshInteractions().catch(() => {});
    } finally {
      setRecordingWechatMessages(false);
    }
  }

  async function updateInteractionWikiStatus(
    kind: "task" | "memory",
    id: string,
    status: string,
  ) {
    setWikiActionId(`${kind}:${id}:${status}`);
    setError(null);
    try {
      await jsonFetch("/api/interactions/wiki", {
        method: "PATCH",
        body: JSON.stringify({ kind, id, status }),
      });
      await refreshInteractions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWikiActionId(null);
    }
  }

  async function updateOutboxRecipient(
    outboxId: string,
    recipientName: string,
    refresh = true,
  ) {
    if (!selectedId) return;
    await jsonFetch(`/api/workshops/${selectedId}/outbox/${outboxId}`, {
      method: "PATCH",
      body: JSON.stringify({ recipientName }),
    });
    if (refresh) {
      await Promise.all([refreshDetail(selectedId), refreshOutbox(selectedId)]);
    }
  }

  async function dismissOutbox(outbox: WorkshopOutbox) {
    if(!selectedId||busy||!outbox.updatedAt)return;
    const workId=selectedId;setBusy(true);setOutboxActionId(`dismiss:${outbox.id}`);setError(null);
    try{
      await jsonFetch(`/api/workshops/${workId}/outbox/${outbox.id}/dismiss`,{method:'POST',body:JSON.stringify({expectedUpdatedAt:outbox.updatedAt})});
      await Promise.all([refreshDetail(workId,{force:true}),refreshOutbox(workId),refreshWorkshops(true),refreshReviewItems(workId)]);
    }catch(err){
      setError(`未能结束处理，请刷新后重试：${err instanceof Error?err.message:String(err)}`);
      await refreshOutbox(workId).catch(()=>{});
    }finally{setBusy(false);setOutboxActionId(null);}
  }

  async function previewOutbox(outbox: WorkshopOutbox) {
    if (!selectedId) return;
    setBusy(true);
    setOutboxActionId(`preview:${outbox.id}`);
    setError(null);
    try {
      const recipientName =
        outboxRecipients[outbox.id] ?? outbox.recipientName ?? "";
      if (recipientName.trim() !== (outbox.recipientName ?? "")) {
        await updateOutboxRecipient(outbox.id, recipientName, false);
      }
      await jsonFetch(
        `/api/workshops/${selectedId}/outbox/${outbox.id}/preview`,
        {
          method: "POST",
        },
      );
      await Promise.all([refreshDetail(selectedId), refreshOutbox(selectedId)]);
      await refreshSelectedLoopDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshDetail(selectedId),refreshOutbox(selectedId)]).catch(() => {});
      await refreshSelectedLoopDetail().catch(() => {});
    } finally {
      setBusy(false);
      setOutboxActionId(null);
    }
  }

  async function reconcileOutbox(outboxId:string){
    if(!selectedId)return;
    const workId=selectedId;
    setBusy(true);setOutboxActionId(`reconcile:${outboxId}`);setError(null);
    try{
      const result=await jsonFetch<{status:string}>(`/api/workshops/${workId}/outbox/${outboxId}/reconcile`,{method:'POST'});
      if(result.status==='unknown')setError('尚无法确认发送结果，请核对微信记录。查询不会再次发送。');
    }catch(err){setError(err instanceof Error?err.message:String(err));}
    finally{
      await Promise.all([refreshDetail(workId),refreshOutbox(workId),refreshReviewItems(workId),refreshSelectedLoopDetail()]).catch(()=>{});
      setBusy(false);setOutboxActionId(null);
    }
  }

  async function sendOutbox(outboxId: string) {
    if (!selectedId) return;
    const item=detail?.outbox.find(item=>item.id===outboxId);
    const preview=item?.boundaryResult?.wechatPreview as {contentHash?:string}|undefined;
    if(!preview?.contentHash){setError('请重新预览当前发信内容后再确认发送。');return;}
    setBusy(true);
    setOutboxActionId(`send:${outboxId}`);
    setError(null);
    try {
      await jsonFetch(`/api/workshops/${selectedId}/outbox/${outboxId}/send`, {
        method: "POST",
        body:JSON.stringify({expectedContentHash:preview.contentHash}),
      });
      await Promise.all([refreshDetail(selectedId), refreshOutbox(selectedId),refreshReviewItems(selectedId)]);
      await refreshSelectedLoopDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshDetail(selectedId),refreshOutbox(selectedId),refreshReviewItems(selectedId)]).catch(() => {});
      await refreshSelectedLoopDetail().catch(() => {});
    } finally {
      setBusy(false);
      setOutboxActionId(null);
    }
  }

  async function resolveWatchlistProposal(
    eventId: string,
    action: "apply" | "reject",
  ) {
    if (!selectedId) return;
    setWatchlistProposalActionId(`${action}:${eventId}`);
    setError(null);
    try {
      await jsonFetch(
        `/api/workshops/${selectedId}/watchlist-proposals/${eventId}`,
        {
          method: "POST",
          body: JSON.stringify({ action }),
        },
      );
      await Promise.all([refreshDetail(selectedId), refreshReviewItems(selectedId)]);
      await refreshSelectedLoopDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setWatchlistProposalActionId(null);
    }
  }

  async function resolveVideoReview(
    draftId: string,
    action: "approve" | "reject" | "regenerate",
  ) {
    if (!selectedId) return;
    setVideoReviewActionId(`${action}:${draftId}`);
    setError(null);
    try {
      await jsonFetch(`/api/workshops/${selectedId}/video-reviews/${draftId}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await Promise.all([
        refreshDetail(selectedId),
        refreshDouyinDrafts().catch(() => undefined),
      ]);
      await refreshSelectedLoopDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setVideoReviewActionId(null);
    }
  }

  async function resolveAgentChangeProposal(
    eventId: string,
    action: WorkshopAgentChangeAction,
  ) {
    if (!selectedId) return;
    setAgentChangeActionId(`${action}:${eventId}`);
    setError(null);
    try {
      await submitWorkAction(
        `/api/workshops/${selectedId}/agent-change-proposals/${eventId}`,
        {
          method: "POST",
          body: JSON.stringify({ action }),
        },
      );
      await Promise.all([refreshDetail(selectedId), refreshReviewItems(selectedId)]);
      await refreshSelectedLoopDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setAgentChangeActionId(null);
    }
  }

  async function dismissReviewItem(item: WorkshopReviewItem) {
    if (!selectedId) return;
    setReviewItemActionId(`dismiss:${item.id}`);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/review-items`, {
        method: "PATCH",
        body: JSON.stringify({
          itemId: item.id,
          status: "dismissed",
          reason:
            "Owner dismissed review item without rerun; not current time window, not worth rerun cost, or intentionally deferred.",
        }),
      });
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]).catch(() => {});
    } finally {
      setReviewItemActionId(null);
    }
  }

  async function dismissReviewItemGroup(item: WorkshopReviewItem) {
    if (!selectedId) return;
    setReviewItemActionId(`dismiss-group:${item.id}`);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/review-items`, {
        method: "PATCH",
        body: JSON.stringify({
          itemId: item.id,
          action: "dismiss_group",
          reason:
            "Owner dismissed the same service-error group without rerun; not current time window, not worth rerun cost, or intentionally deferred.",
        }),
      });
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]).catch(() => {});
    } finally {
      setReviewItemActionId(null);
    }
  }

  async function confirmMemoryRecallGovernanceAction(
    item: WorkshopReviewItem,
    governanceAction: string,
  ) {
    if (!selectedId) return;
    setReviewItemActionId(`governance:${item.id}:${governanceAction}`);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/review-items`, {
        method: "PATCH",
        body: JSON.stringify({
          itemId: item.id,
          action: "confirm_memory_recall_governance",
          governanceAction,
        }),
      });
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]).catch(() => {});
    } finally {
      setReviewItemActionId(null);
    }
  }

  async function confirmMemoryRecallGovernanceBatch(item: WorkshopReviewItem) {
    if (!selectedId) return;
    setReviewItemActionId(`governance-batch:${item.id}`);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/review-items`, {
        method: "PATCH",
        body: JSON.stringify({
          itemId: item.id,
          action: "confirm_memory_recall_governance_batch",
          limit: 5,
        }),
      });
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]).catch(() => {});
    } finally {
      setReviewItemActionId(null);
    }
  }

  async function resolveMemoryRecallGovernanceProposal(
    item: WorkshopReviewItem,
    resolution: "approved" | "rejected",
  ) {
    if (!selectedId) return;
    setReviewItemActionId(`governance-proposal:${resolution}:${item.id}`);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/review-items`, {
        method: "PATCH",
        body: JSON.stringify({
          itemId: item.id,
          action: "resolve_memory_recall_governance_proposal",
          resolution,
        }),
      });
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]).catch(() => {});
    } finally {
      setReviewItemActionId(null);
    }
  }

  async function resolveMemoryRecallChangePlan(
    item: WorkshopReviewItem,
    resolution: "approved" | "rejected",
  ) {
    if (!selectedId) return;
    setReviewItemActionId(`change-plan:${resolution}:${item.id}`);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/review-items`, {
        method: "PATCH",
        body: JSON.stringify({
          itemId: item.id,
          action: "resolve_memory_recall_change_plan",
          resolution,
        }),
      });
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]).catch(() => {});
    } finally {
      setReviewItemActionId(null);
    }
  }

  async function resolveInsightChangeProposal(
    item: WorkshopReviewItem,
    resolution: "approved" | "rejected",
  ) {
    if (!selectedId) return;
    setReviewItemActionId(`insight-proposal:${resolution}:${item.id}`);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/review-items`, {
        method: "PATCH",
        body: JSON.stringify({
          itemId: item.id,
          action: "resolve_insight_change_proposal",
          resolution,
        }),
      });
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]).catch(() => {});
    } finally {
      setReviewItemActionId(null);
    }
  }

  async function resolveLoopChangeProposal(item: WorkshopReviewItem, resolution: "approved" | "rejected") {
    if (!selectedId) return;
    setReviewItemActionId(`loop-proposal:${resolution}:${item.id}`);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/review-items`, {
        method: "PATCH",
        body: JSON.stringify({ itemId: item.id, action: "resolve_loop_change_proposal", resolution }),
      });
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId), refreshOwnerOverview()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([refreshReviewItems(selectedId), refreshDetail(selectedId)]).catch(() => {});
    } finally {
      setReviewItemActionId(null);
    }
  }

  async function restoreWorkVersion(version: WorkshopWorkVersion) {
    if (!selectedId) return;
    const ok = window.confirm(
      `恢复到 Work 版本 ${formatWorkVersion(
        version.version,
      )}？这会记录一条恢复事件，并生成新的当前版本。`,
    );
    if (!ok) return;

    setRestoringWorkVersionId(version.id);
    setError(null);
    try {
      await submitWorkAction(`/api/workshops/${selectedId}/work/versions`, {
        method: "POST",
        body: JSON.stringify({
          action: "restore",
          versionId: version.id,
          reason: "Owner restored Work version from Work panel",
        }),
      });
      await refreshDetail(selectedId);
      await refreshSelectedLoopDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshDetail(selectedId).catch(() => {});
    } finally {
      setRestoringWorkVersionId(null);
    }
  }

  async function saveOutboxRecipient(outbox: WorkshopOutbox) {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await updateOutboxRecipient(
        outbox.id,
        outboxRecipients[outbox.id] ?? outbox.recipientName ?? "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveBoundaryPolicy() {
    if (!selectedId || !boundaryForm) return;
    const draft=configurationDrafts.current.get(selectedId);
    if(!draft)return;
    const submitted=draft.boundary;
    const boundaryPolicy = serializeWorkshopBoundaryPolicy(submitted.value);
    setBusy(true);
    setError(null);
    try {
      await getCommandClient().submit<{ workshop: Workshop }>({url:`/api/workshops/${selectedId}`,
        method: "PATCH",
        expectedVersion:submitted.version,
        body: {
          autonomyLevel: boundaryPolicy.mode,
          boundaryPolicy,
        },
      });
      const current=configurationDrafts.current.get(selectedId);
      if(current)current.boundary=acceptDraft(current.boundary,submitted);
      await Promise.all([refreshWorkshops(true), refreshDetail(selectedId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveHeartbeatPolicy() {
    if (!selectedId || !heartbeatForm) return;
    const draft=configurationDrafts.current.get(selectedId);
    if(!draft)return;
    const submitted=draft.heartbeat;
    const savedHeartbeat=submitted.value;
    setBusy(true);
    setError(null);
    try {
      await getCommandClient().submit<{ workshop: Workshop; heartbeat: WorkshopHeartbeat }>(
        {url:`/api/workshops/${selectedId}`,
          method: "PATCH",
          expectedVersion:submitted.version,
          body: {
            heartbeat: {
              enabled: savedHeartbeat.enabled,
              mode: "suggested",
              heartbeatPolicy: {
                allowAgentSuggestedWakeup:
                  savedHeartbeat.allowAgentSuggestedWakeup,
                minIntervalMinutes: savedHeartbeat.minIntervalMinutes,
                defaultDelayMinutes: savedHeartbeat.defaultDelayMinutes,
                maxIntervalMinutes: savedHeartbeat.maxIntervalMinutes,
                missedRunGraceMinutes: savedHeartbeat.missedRunGraceMinutes,
                leaseMinutes: savedHeartbeat.leaseMinutes,
                maxConsecutiveFailures: savedHeartbeat.maxConsecutiveFailures,
              },
            },
          },
        },
      );
      const current=configurationDrafts.current.get(selectedId);
      if(current)current.heartbeat=acceptDraft(current.heartbeat,submitted);
      await refreshDetail(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openWorkshopYamlDialog() {
    const workshopId = selectedId;
    setBusy(true);
    setError(null);
    try {
      const exported = workshopId ? await jsonFetch<{workshopId: string; commandVersion: number; manifestYaml: string}>(`/api/workshops/${workshopId}/manifest`) : null;
      if (selectedIdRef.current !== workshopId) return;
      setManifestYaml(exported?.manifestYaml ?? DEFAULT_WORKSHOP_MANIFEST_YAML);
      setManifestBaseline({workshopId, commandVersion: exported?.commandVersion ?? 0});
      setManifestReview(null);
      setIsCreateDialogOpen(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {setBusy(false);}
  }

  const dashboard = detail?.dashboard ?? null;
  const loopItems = useMemo(
    () => {
      const items =
        dashboard?.loops ??
        (detail?.loops ?? []).map((loop) => fallbackDashboardLoop(loop));
      return items.filter((loop) => loop.status !== "archived");
    },
    [dashboard?.loops, detail?.loops],
  );
  const selectedLoopDetail = useMemo(
    () => loopItems.find((loop) => loop.id === selectedLoopDetailId) ?? null,
    [loopItems, selectedLoopDetailId],
  );
  const selectedLoopEvents = useMemo(() => {
    if (!selectedLoopDetail) return [];
    return [...(detail?.events ?? [])]
      .filter((event) => event.loopId === selectedLoopDetail.id)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
          b.seq - a.seq,
      );
  }, [detail?.events, selectedLoopDetail]);
  const selectedLoopApiDetail =
    loopDetail?.loop.id === selectedLoopDetailId ? loopDetail : null;
  const reviewEventsById = useMemo(
    () => {
      const result=new Map((detail?.events ?? []).map((event) => [event.id, event]));
      const source=reviewLocation.data?.sourceEvent;
      if(source&&source.workshopId===selectedId)result.set(source.id,source);
      return result;
    },
    [detail?.events,reviewLocation.data,selectedId],
  );
  const reviewItemsBySourceEventId = useMemo(
    () =>
      new Map(
        (reviewItems ?? [])
          .filter((item) => item.sourceEventId)
          .map((item) => [item.sourceEventId as string, item]),
      ),
    [reviewItems],
  );
  const reviewWatchlistProposals = useMemo(() => {
    if (reviewItems === null) {
      return pendingWatchlistProposalEvents(detail?.events ?? []);
    }
    return reviewItems
      .filter((item) => item.kind === "watchlist_proposal")
      .map((item) =>
        item.sourceEventId ? reviewEventsById.get(item.sourceEventId) : null,
      )
      .filter((event): event is WorkshopEvent => Boolean(event));
  }, [detail?.events, reviewEventsById, reviewItems]);
  const reviewAgentChangeProposals = useMemo(() => {
    if (reviewItems === null) {
      return pendingAgentChangeProposalEvents(detail?.events ?? []);
    }
    return reviewItems
      .filter((item) => item.kind === "agent_change_proposal")
      .map((item) =>
        item.sourceEventId ? reviewEventsById.get(item.sourceEventId) : null,
      )
      .filter((event): event is WorkshopEvent => Boolean(event));
  }, [detail?.events, reviewEventsById, reviewItems]);
  const genericReviewItems = useMemo(() => {
    if (reviewItems === null) return [];
    const proposalKinds = new Set([
      "watchlist_proposal",
      "agent_change_proposal",
    ]);
    return reviewItems.filter(
      (item) =>
        !item.sourceEventId ||
        !reviewEventsById.has(item.sourceEventId) ||
        !proposalKinds.has(item.kind),
    ).sort((a, b) => Number(decisionReviewKinds.has(b.kind)) - Number(decisionReviewKinds.has(a.kind)));
  }, [reviewEventsById, reviewItems]);
  const reviewVideoDrafts = useMemo(
    () => pendingVideoDrafts(douyinDrafts, detail?.events ?? [], selectedId),
    [detail?.events, douyinDrafts, selectedId],
  );
  const reviewItemCount =
    (reviewItems === null
      ? reviewWatchlistProposals.length + reviewAgentChangeProposals.length
      : reviewItems.length) + reviewVideoDrafts.length;
  const reviewDecisionCount = (reviewItems === null
    ? reviewWatchlistProposals.length + reviewAgentChangeProposals.length
    : reviewItems.filter((item) => decisionReviewKinds.has(item.kind)).length) + reviewVideoDrafts.length;
  const firstOtherReviewIndex = genericReviewItems.findIndex((item) =>
    !decisionReviewKinds.has(item.kind));
  const attentionItems = useMemo(() => {
    const structuredLoopBlockerIds = new Set(
      (reviewItems ?? [])
        .filter((item) => item.kind === "loop_blocker")
        .map((item) => stringValue(objectValue(item.metadata).loopId))
        .filter((loopId): loopId is string => Boolean(loopId)),
    );
    const loopItems = (dashboard?.blockedLoops ?? [])
      .filter(
        (loop) =>
          reviewItems === null || !structuredLoopBlockerIds.has(loop.id),
      )
      .map(buildLoopAttentionItem);
    const reviewAttentionItems = [
      ...reviewAgentChangeProposals.map((event) =>
        buildReviewAttentionItem(
          `agent-change:${event.id}`,
          event.title,
          "配置修改审核",
          event,
          true,
          undefined,
          reviewItemsBySourceEventId.get(event.id)?.id,
        ),
      ),
      ...reviewWatchlistProposals.map((event) =>
        buildReviewAttentionItem(
          `watchlist:${event.id}`,
          event.title,
          "自选股调整审核",
          event,
          true,
          undefined,
          reviewItemsBySourceEventId.get(event.id)?.id,
        ),
      ),
      ...reviewVideoDrafts.map((draft) =>
        buildReviewAttentionItem(
          `video:${draft.id}`,
          draft.title,
          "内容发布审核",
        ),
      ),
      ...genericReviewItems.map((item) =>
        buildReviewAttentionItem(
          `review-item:${item.id}`,
          item.title,
          reviewKindLabel(item.kind),
          item.sourceEventId
            ? reviewEventsById.get(item.sourceEventId)
            : undefined,
          decisionReviewKinds.has(item.kind),
          item.summary ?? undefined,
          item.id,
        ),
      ),
    ];
    const outboxItems = (detail?.outbox ?? [])
      .filter((item) => item.status === "blocked")
      .map(buildOutboxAttentionItem);
    return [
      ...reviewAttentionItems.filter((item) => item.category === "review"),
      ...loopItems,
      ...outboxItems,
      ...reviewAttentionItems.filter((item) => item.category === "review_observation"),
    ];
  }, [
    dashboard?.blockedLoops,
    detail?.outbox,
    genericReviewItems,
    reviewEventsById,
    reviewAgentChangeProposals,
    reviewItemsBySourceEventId,
    reviewItems,
    reviewVideoDrafts,
    reviewWatchlistProposals,
  ]);
  const attentionCounts = useMemo(() => {
    const counts: Partial<Record<AttentionCategory, number>> = {};
    for (const item of attentionItems) {
      counts[item.category] = (counts[item.category] ?? 0) + 1;
    }
    return counts;
  }, [attentionItems]);
  const visibleWorkLogEvents = useMemo(() => {
    const historyEvents =
      workLogSnapshot?.workshopId === selectedId ? workLogSnapshot.events : [];
    return workLogEvents(
      mergeWorkshopEventLists(detail?.events ?? [], historyEvents),
    );
  }, [detail?.events, selectedId, workLogSnapshot]);
  const presentationRefreshSeq = visibleWorkLogEvents.at(-1)?.seq ?? 0;
  const reviewRefreshKey = `${detail?.commandVersion ?? 0}:${Math.max(0, ...(detail?.events ?? []).map(event => event.seq))}`;
  useEffect(() => {
    if (!selectedId) {
      setPresentationSnapshot(null);
      setPresentationError(null);
      setPresentationLoading(false);
      return;
    }
    let cancelled = false;
    setPresentationLoading(true);
    setPresentationError(null);
    const timer = setTimeout(() => {
      jsonFetch<{
        presentation: WorkPresentationV1 | null;
      }>("/api/workshops/" + encodeURIComponent(selectedId) + "/presentation", {
        cache: "no-store",
      }).then((data) => {
        if (cancelled) return;
        setPresentationSnapshot({
          workshopId: selectedId,
          presentation: data.presentation,
        });
      }).catch((error) => {
        if (cancelled) return;
        setPresentationError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (!cancelled) setPresentationLoading(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedId, presentationRefreshSeq]);
  const selectedRunningWorkflow = latestRunningWorkflow(
    visibleWorkLogEvents,
    dashboard?.loops ?? [],
  );
  const selectedWorkRecords = useMemo(
    () => buildAgentWorkRecords(visibleWorkLogEvents),
    [visibleWorkLogEvents],
  );
  const selectedLatestWorkRecord = selectedWorkRecords[0] ?? null;
  const selectedPresentation = presentationSnapshot?.workshopId === selectedId
    ? presentationSnapshot.presentation
    : null;
  const selectedOwnerWork = ownerOverview?.works.find((item) => item.workId === selectedId) ?? null;
  const ownerAttention = selectedOwnerWork?.attention;
  const ownerDecisionCount = (ownerAttention
    ? ownerAttention.review + ownerAttention.loopApproval + ownerAttention.outboxApproval : 0) + reviewVideoDrafts.length;
  const ownerInvestigationCount = ownerAttention
    ? ownerAttention.reviewOther + ownerAttention.loopBlocker + ownerAttention.outboxBlocked + ownerAttention.outboxUnknown +
      ownerAttention.collaboration + ownerAttention.runNeedsReview : 0;
  const visibleDecisionCount = ownerAttention ? ownerDecisionCount : reviewDecisionCount;
  const visibleInvestigationCount = ownerAttention
    ? ownerInvestigationCount
    : attentionItems.filter((item) => item.category !== "review").length;

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-[#FAFAFA] text-[#0A0A0A]">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-3 border-b border-[#E5E5E5] pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-px w-6 shrink-0 bg-[#7C3AED]"
              aria-hidden="true"
            />
            <span className="shrink-0 text-xs font-medium text-[#7C3AED]">
              智能体车间
            </span>
            {dashboard ? (
              <Badge
                variant="secondary"
                className={dashboardStatusTone(dashboard.status)}
              >
                {dashboardStatusLabel(dashboard.status)}
              </Badge>
            ) : null}
          </div>
          {selectedId ? <Button
            variant="ghost"
            size="sm"
            onClick={openWorkshopYamlDialog}
            className="h-8 shrink-0 gap-1 px-2 text-xs"
          >
            <RemixIcon name="edit" size="size-3.5" />
            修改
          </Button> : null}
        </header>

        {!loading && !error && workshops.length === 0 ? (
          <div className="mx-auto flex min-h-[calc(100vh-170px)] w-full max-w-3xl flex-col justify-center gap-4">
            <EmptyState
              label="开始使用车间"
              title="创建第一个智能体车间"
              description="车间会持续执行你交付的任务，并保留运行记录、边界设置和待审核事项。先创建车间，再为它安排方向和任务。"
              icon="apps"
              action={<Button onClick={openWorkshopYamlDialog} className="gap-2"><RemixIcon name="add" size="size-4" />新建智能体车间</Button>}
              detail="创建时会先审核配置与工具权限；外部发送、交易和删除等动作仍受边界控制。"
              className="min-h-64 bg-white"
            />
            <RuntimeStatusPanel />
          </div>
        ) : <RuntimeStatusPanel />}
        {readStates.some(state=>state.error&&selectedId&&state.url.startsWith(`/api/workshops/${selectedId}/`))?<section aria-label="信息读取状态" role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>部分信息读取失败，当前展示不代表最新结果。</p>
          <ul className="mt-1 space-y-1">{readStates.filter(state=>state.error&&selectedId&&state.url.startsWith(`/api/workshops/${selectedId}/`)).map(state=>{
            const part=state.url.split('/')[4]?.split('?')[0]??'';
            const names:Record<string,string>={sources:'资料',memories:'记忆', 'memory-recall-quality':'记忆质量',work:'工作配置',dashboard:'运行概览',outbox:'发信',tools:'工具权限','review-items':'审核'};
            return <li key={state.url}>{names[part]??'车间信息'}：{state.status==='loading'||state.status==='refreshing'?'正在重试':'读取失败'}{state.lastSuccess!==null?`；最近成功读取于 ${formatDateTime(new Date(state.lastSuccess).toISOString())}`:'；尚未成功读取'}</li>;
          })}</ul>
        </section>:null}
        {draftWarning?<p role="alert" className="rounded border border-amber-300 p-3 text-sm text-amber-700">{draftWarning}</p>:null}

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {pendingCommand ? <div className="rounded-lg border p-3 text-sm">有一次提交尚未确认，原请求已保留。<Button disabled={busy} variant="outline" onClick={recoverPendingCommand}>核对上次提交</Button></div> : null}
        {commandNotice ? <div role="status" className="rounded-lg border p-3 text-sm">{commandNotice}</div> : null}
        {selectedId && (configurationDrafts.current.get(selectedId)?.boundary.dirty || configurationDrafts.current.get(selectedId)?.heartbeat.dirty) ? <Button variant="outline" disabled={busy} onClick={async()=>{
          configurationDrafts.current.delete(selectedId);setBoundaryForm(null);setHeartbeatForm(null);setCommandNotice(null);setError(null);
          try {await refreshDetail(selectedId);}catch(error){setError(error instanceof Error?error.message:String(error));}
        }}>放弃设置草稿并载入最新配置</Button> : null}

        <LoopTaskDetailDialog
          loop={selectedLoopDetail}
          detail={selectedLoopApiDetail}
          loading={
            Boolean(selectedLoopDetailId) &&
            loadingLoopDetailId === selectedLoopDetailId
          }
          events={selectedLoopEvents}
          open={Boolean(selectedLoopDetail)}
          onOpenChange={(open) => {
            if (!open) setSelectedLoopDetailId(null);
          }}
          onRun={runWorkshopLoop}
          onActivate={(loopId) => updateLoopActivation(loopId, "activate")}
          onReject={(loopId) => updateLoopActivation(loopId, "reject")}
          onPause={(loop) => updateLoopStatus(loop, "pause")}
          onResume={(loop) => updateLoopStatus(loop, "resume")}
          onDelete={deleteWorkshopLoop}
          onResolveApproval={resolveLoopApproval}
          onResumeApproval={resumeLoopApproval}
          onPreviewOutbox={previewOutbox}
          onSendOutbox={sendOutbox}
          onReconcileOutbox={reconcileOutbox}
          running={Boolean(
            selectedLoopDetail &&
              loopExecutionView({
                localPending: runningLoopId === selectedLoopDetail.id,
                latestRunStatus: selectedLoopDetail.latestRun?.status,
              }).busy,
          )}
          updatingActivation={Boolean(
            selectedLoopDetail &&
            updatingLoopActivationId === selectedLoopDetail.id,
          )}
          updatingStatus={Boolean(
            selectedLoopDetail &&
            updatingLoopStatusId === selectedLoopDetail.id,
          )}
          resolvingApprovalId={resolvingApprovalId}
          resumingApprovalId={resumingApprovalId}
          outboxActionId={outboxActionId}
        />

        <WorkLogExpandedDialog
          workshopId={selectedId}
          events={visibleWorkLogEvents}
          runId={selectedRunId}
          onSelectRun={runId=>{setIsWorkLogExpanded(true);setSelectedRunId(runId);}}
          open={isWorkLogExpanded || !!selectedRunId}
          onOpenChange={open=>{setIsWorkLogExpanded(open);if(!open)setSelectedRunId(null);}}
        />

        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>
                {manifestBaseline?.workshopId ? "修改智能体车间" : "新建智能体车间"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              {error ? <div role="alert" className="text-sm text-destructive">{error}</div> : null}
              {pendingCommand ? <Button disabled={busy} variant="outline" onClick={recoverPendingCommand}>核对上次提交</Button> : null}
              {commandNotice ? <div role="status" className="text-sm">{commandNotice}</div> : null}
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
                使用标准化 Workshop YAML
                创建车间。系统会先审核字段、工具权限、Skill、Loop
                和验证规则，审核通过后才能创建。
              </div>

                <div className="space-y-3">
                  <div className="space-y-2">
                    <label
                      htmlFor="workshop-manifest-yaml"
                      className="text-sm font-medium text-foreground"
                    >
                      Workshop YAML
                    </label>
                    <Textarea
                      id="workshop-manifest-yaml"
                      name="workshop-manifest-yaml"
                      value={manifestYaml}
                      onChange={(event) => {
                        setManifestYaml(event.target.value);
                        setManifestReview(null);
                      }}
                      className="min-h-72 resize-y font-mono text-xs"
                      placeholder={
                        "apiVersion: openzhiyu.ai/v1alpha1\nkind: Workshop\nmetadata:\n  name: watchlist-hunter\n  title: 自选股猎手\nspec: ..."
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={reviewManifestYaml}
                      disabled={manifestReviewing || !manifestYaml.trim()}
                      className="gap-2"
                    >
                      <RemixIcon name="shield-check" size="size-4" />
                      {manifestReviewing ? "审核中..." : "审核 YAML"}
                    </Button>
                    {manifestReview ? (
                      <Badge
                        variant={manifestReview.ok ? "default" : "destructive"}
                      >
                        {manifestReview.ok ? "审核通过" : "审核失败"}
                      </Badge>
                    ) : null}
                  </div>

                  {manifestReview ? (
                    <div
                      className={cn(
                        "space-y-3 rounded-lg border p-3 text-xs leading-5",
                        manifestReview.ok
                          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
                          : "border-destructive/30 bg-destructive/5 text-destructive",
                      )}
                    >
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        <div>
                          <div className="text-muted-foreground">Loop</div>
                          <div className="font-medium">
                            {manifestReview.summary.loops}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Source</div>
                          <div className="font-medium">
                            {manifestReview.summary.sources}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Tool</div>
                          <div className="font-medium">
                            {manifestReview.summary.requestedTools}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Skill</div>
                          <div className="font-medium">
                            {manifestReview.summary.requestedSkills}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Denied</div>
                          <div className="font-medium">
                            {manifestReview.summary.deniedTools}
                          </div>
                        </div>
                      </div>

                      {manifestReview.creationReport ? (
                        <div className="rounded-md border border-current/20 p-2">
                          <div className="font-medium">
                            {manifestReview.creationReport.title}
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                            {manifestReview.creationReport.body}
                          </p>
                        </div>
                      ) : null}

                      {manifestReview.issues.length > 0 ? (
                        <div className="space-y-1">
                          {manifestReview.issues.slice(0, 8).map((issue) => (
                            <div key={`${issue.path}-${issue.message}`}>
                              <span className="font-medium">
                                {issue.severity.toUpperCase()} {issue.path}
                              </span>
                              : {issue.message}
                            </div>
                          ))}
                          {manifestReview.issues.length > 8 ? (
                            <div>
                              +{manifestReview.issues.length - 8} more issue(s)
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>

              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-800">
                新车间默认只生成草稿。外部发送、交易、付款和删除等动作仍需经过边界检查。
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsCreateDialogOpen(false)}
                >
                  取消
                </Button>
                <Button
                  onClick={applyWorkshopYaml}
                  disabled={busy || !manifestReview?.ok}
                  className="gap-2"
                >
                  <RemixIcon name="checkbox_circle" size="size-4" />
                  应用 YAML
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {(loading || workshops.length > 0) ? <section className="border border-[#E5E5E5] bg-white px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <RemixIcon name="apps" size="size-4" />
              团队工作
              <span className="tabular-nums text-muted-foreground/80">
                {workshops.length}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openWorkshopYamlDialog}
              className="h-7 gap-1 px-2 text-xs"
            >
              <RemixIcon name={selectedId ? "edit" : "add"} size="size-3.5" />
              {selectedId ? "修改" : "新建"}
            </Button>
          </div>
          {loading ? (
            <PanelState
              state="loading"
              title="正在加载智能体"
              description="列表返回后会在这里局部更新。"
            />
          ) : workshops.length === 0 ? (
            <PanelState
              state="empty"
              title="还没有智能体"
              description="创建一个智能体后，它会作为长期工作的车间显示在这里。"
            />
          ) : (
            <OwnerTeamRoster works={workshops} overview={ownerOverview} selectedId={selectedId}
              onSelect={setSelectedId} error={ownerOverviewError}
              onRefresh={() => void refreshOwnerOverview()} />
          )}
        </section> : null}

        {(loading || workshops.length > 0) ? <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
            {selectedId&&!loading?<RunReviewPanel key={selectedId} workId={selectedId} revision={detail?.commandVersion} pending={!!pendingCommand} submit={request=>getCommandClient().submit(request)} onChanged={async()=>{await Promise.all([refreshWorkshops(true),refreshDetail(selectedId)]);}}/>:null}
            <section
              className={cn(
                "flex min-h-0 min-w-0 flex-col gap-4",
                isDetailsPanelOpen && "hidden",
              )}
            >
              <div data-workshop-overview-id={selectedId ?? undefined} className="border border-[#E5E5E5] bg-white p-4 sm:p-6">
                {loading ? (
                  <PanelState
                    state="loading"
                    title="正在加载智能体"
                    description="选中智能体后会显示当前工作和需要关注的事项。"
                  />
                ) : !selectedWorkshop ? (
                  <PanelState
                    state="empty"
                    title="还没有选中智能体"
                    description="先在上方选择一个智能体。"
                  />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-4">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">员工工作桌</p>
                        <h1 className="mt-1 text-xl font-semibold text-foreground">{selectedWorkshop.name}</h1>
                        <p className="mt-1 text-xs text-muted-foreground">{workshopDisplayDescription(selectedWorkshop)}</p>
                      </div>
                      {ownerOverview?.asOf && !ownerOverviewError ?
                        <span className="text-xs text-muted-foreground">核对时间 {formatDateTime(ownerOverview.asOf)}</span> : null}
                    </div>

                    <div className="mt-5">
                      <OwnerEmployeeStatus item={selectedOwnerWork} error={ownerOverviewError}
                        onRefresh={() => void refreshOwnerOverview()} />
                    </div>

                    {selectedOwnerWork?.execution.state === "running" && selectedRunningWorkflow ?
                      <div className="mt-5"><RunningWorkflowPanel workflow={selectedRunningWorkflow} /></div> : null}

                    <WorkPresentationArea
                      key={selectedId ?? "none"}
                      presentation={selectedPresentation}
                      loading={presentationLoading}
                      error={presentationError}
                      onOpenWorkLog={(runId) => {
                        setIsWorkLogExpanded(true);
                        setSelectedRunId(runId);
                      }}
                    />

                    <div className="mt-6 flex flex-wrap items-center gap-2">
                      <Button
                        onClick={() => setIsWorkLogExpanded(true)}
                        className="gap-2"
                      >
                        <RemixIcon name="file_text" size="size-4" />
                        查看工作记录
                      </Button>
                      {ownerDecisionCount > 0 ? (
                        <Button
                          variant="outline"
                          onClick={() => {
                            if (!ownerAttention?.review && !ownerAttention?.outboxApproval) setManagementView("tasks");
                            setActiveSideTab(ownerAttention?.review ? "review" : ownerAttention?.outboxApproval ? "outbox" : "loops");
                            setIsDetailsPanelOpen(true);
                          }}
                          className="gap-2"
                        >
                          <RemixIcon name="alarm_warning" size="size-4" />
                          查看需要我决定的事 {ownerDecisionCount}
                        </Button>
                      ) : null}
                      {ownerInvestigationCount > 0 ? <Button variant="outline" onClick={() => {
                        setActiveSideTab(ownerAttention?.outboxUnknown || ownerAttention?.outboxBlocked ? "outbox" :
                          ownerAttention?.reviewOther ? "review" : "attention");
                        setIsDetailsPanelOpen(true);
                      }}>查看待关注记录</Button> : null}
                      <Button
                        variant="outline"
                        onClick={startRun}
                        disabled={!selectedId || busy}
                        className="gap-2"
                      >
                        <RemixIcon name="play" size="size-4" />
                        运行一次
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setIsDetailsPanelOpen((current) => !current);
                        }}
                        className="gap-2"
                      >
                        <RemixIcon
                          name={
                            isDetailsPanelOpen ? "arrow_up_s" : "layout_grid"
                          }
                          size="size-4"
                        />
                        {isDetailsPanelOpen ? "收起详情" : "工作详情"}
                      </Button>
                    </div>
                  </>
                )}
              </div>

              {selectedWorkshop && !isDetailsPanelOpen ? (
                <ReviewDecisionDesk key={`decisions:${selectedWorkshop.id}`} workId={selectedWorkshop.id}
                  refreshKey={reviewRefreshKey}
                  onSelectReview={(id) => {
                    setSelectedReviewId(id);
                    setActiveSideTab("review");
                    setIsDetailsPanelOpen(true);
                  }} />
              ) : null}

              {selectedWorkshop ? (
                <WorkConversation key={selectedWorkshop.id} workId={selectedWorkshop.id}
                  workName={selectedWorkshop.name} workStatus={selectedWorkshop.status}
                  onOpenWorkLog={(runId) => {
                    setIsWorkLogExpanded(true);
                    setSelectedRunId(runId);
                  }} />
              ) : null}
            </section>

            {isDetailsPanelOpen ? (
              <section className="h-[calc(100vh-220px)] min-h-[620px] min-w-0 self-start overflow-hidden border border-[#E5E5E5] bg-white">
                <Tabs
                  value={activeSideTab}
                  onValueChange={handleSideTabChange}
                  className="flex h-full min-h-0 flex-col overflow-y-auto"
                >
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#E5E5E5] px-4 py-3">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">
                      工作详情
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      先看工作与待处理事项；需要追溯时再看协作、依据和管理设置。
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1 px-2 text-xs"
                    onClick={() => setIsDetailsPanelOpen(false)}
                  >
                    <RemixIcon name="close" size="size-3.5" />
                    关闭
                  </Button>
                </div>
                <nav aria-label="工作详情分类" className="flex shrink-0 flex-wrap gap-1 border-b border-[#E5E5E5] px-3 py-2">
                  {([
                    ["work", "工作记录", "run"],
                    ["attention", "待我处理", "attention"],
                    ["collaboration", "协作", "collaboration"],
                    ["knowledge", "知识与依据", "sources"],
                    ["management", "管理", "loops"],
                  ] as const).map(([section, label, tab]) => (
                    <Button
                      key={section}
                      type="button"
                      size="sm"
                      variant={activeDetailSection === section ? "secondary" : "ghost"}
                      aria-current={activeDetailSection === section ? "page" : undefined}
                      className="h-8 shrink-0 px-3 text-xs"
                      onClick={() => handleSideTabChange(tab)}
                    >
                      {label}
                      {section === "attention" && ownerDecisionCount > 0 ? ` ${ownerDecisionCount}` : ""}
                    </Button>
                  ))}
                </nav>
                {activeDetailSection === "attention" ? (
                  <div className="shrink-0 border-b border-[#E5E5E5] px-3 py-2">
                    <TabsList className="flex h-auto w-full justify-start gap-1 bg-transparent p-0">
                      <TabsTrigger className={sidePanelTriggerClass} value="attention">概览</TabsTrigger>
                      <TabsTrigger className={sidePanelTriggerClass} value="review">审核与评估{reviewDecisionCount > 0 ? ` ${reviewDecisionCount}` : ""}</TabsTrigger>
                      <TabsTrigger className={sidePanelTriggerClass} value="outbox">待发</TabsTrigger>
                    </TabsList>
                  </div>
                ) : activeDetailSection === "knowledge" ? (
                  <div className="shrink-0 border-b border-[#E5E5E5] px-3 py-2">
                    <TabsList className="flex h-auto w-full justify-start gap-1 bg-transparent p-0">
                      <TabsTrigger className={sidePanelTriggerClass} value="sources">资料</TabsTrigger>
                      <TabsTrigger className={sidePanelTriggerClass} value="memory">记忆</TabsTrigger>
                    </TabsList>
                  </div>
                ) : activeDetailSection === "management" ? (
                  <div className="shrink-0 border-b border-[#E5E5E5] px-3 py-2">
                    <TabsList className="flex h-auto w-full justify-start gap-1 bg-transparent p-0">
                      <TabsTrigger className={sidePanelTriggerClass} value="loops">运行配置</TabsTrigger>
                      <TabsTrigger className={sidePanelTriggerClass} value="evolution">演化建议</TabsTrigger>
                    </TabsList>
                  </div>
                ) : (
                  <div className="shrink-0 border-b border-[#E5E5E5] px-3 py-2">
                    <TabsList className="flex h-auto w-full justify-start bg-transparent p-0">
                      <TabsTrigger className={sidePanelTriggerClass} value={activeSideTab}>
                        {activeDetailSection === "work" ? "当前与最近一轮" : "协作记录"}
                      </TabsTrigger>
                    </TabsList>
                  </div>
                )}
                {activeSideTab === "loops" ? (
                  <div className="flex shrink-0 flex-wrap gap-1 border-b border-[#E5E5E5] px-3 py-2" role="group" aria-label="运行配置分类">
                    {([
                      ["tasks", "持续任务"],
                      ["model", "工作模型"],
                      ["tools", "工具权限"],
                      ["boundary", "边界与心跳"],
                    ] as const).map(([view, label]) => (
                      <Button key={view} type="button" size="sm" variant={managementView === view ? "outline" : "ghost"}
                        aria-pressed={managementView === view} className="h-7 px-2 text-xs" onClick={() => setManagementView(view)}>{label}</Button>
                    ))}
                  </div>
                ) : null}

                <TabsContent
                  value="run"
                  className={cn(sidePanelContentClass, "space-y-4 p-4")}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">当前进展与最近一轮记录</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => setIsWorkLogExpanded(true)}>
                      查看完整工作记录
                    </Button>
                  </div>
                  {activeSideTab === "run" ? (
                    selectedRunningWorkflow ? (
                      <RunningWorkflowPanel workflow={selectedRunningWorkflow} />
                    ) : selectedLatestWorkRecord ? (
                      <AgentWorkRecordCard record={selectedLatestWorkRecord} />
                    ) : (
                      <PanelState
                        state="empty"
                        title="还没有本次运行记录"
                        description="智能体开始运行后，这里会按目标、证据、判断和结论展示完整过程。"
                      />
                    )
                  ) : null}
                </TabsContent>

                <TabsContent
                  value="loops"
                  className={cn(sidePanelContentClass, "space-y-4 p-4")}
                >
                  {activeSideTab === "loops" && managementView === "tasks" ? (
                    <>
                      {panelLoading.dashboard && !loadedPanels.dashboard ? (
                        <PanelState
                          state="loading"
                          title="任务状态加载中"
                          description="任务创建区保持可用，Loop 状态返回后会在当前面板更新。"
                        />
                      ) : null}
                      <div className="space-y-2 rounded-lg border border-border p-3">
                        <Textarea
                          value={loopIntent}
                          aria-label="持续任务意图"
                          disabled={!draftsReady||!selectedId}
                          onChange={(event) =>
                            setLoopIntent(event.target.value)
                          }
                          className="min-h-20 resize-none"
                          placeholder="用一句话描述要持续做的任务"
                        />
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Button
                            onClick={createWorkshopLoopFromIntent}
                            disabled={
                              !selectedId || creatingLoop || !loopIntent.trim() || !Number.isSafeInteger(detail?.commandVersion)
                            }
                            className="flex-1 gap-2"
                          >
                            <RemixIcon name="sparkling" size="size-4" />
                            创建任务
                          </Button>
                          <Button
                            variant="outline"
                            onClick={createDailyBriefLoop}
                            disabled={!selectedId || creatingLoop}
                            className="flex-1 gap-2"
                          >
                            <RemixIcon name="calendar" size="size-4" />
                            每日唤醒{" "}
                          </Button>
                        </div>
                      </div>

                      {!panelLoading.dashboard && loopItems.length === 0 ? (
                        <PanelState
                          state="empty"
                          title="暂无任务"
                          description="创建一个持续任务后，车间会按触发条件运行、记录结果并等待必要审核。"
                        />
                      ) : (
                        loopItems.map((loop) => {
                          const isRunning = runningLoopId === loop.id;
                          const executionView = loopExecutionView({
                            localPending: isRunning,
                            latestRunStatus: loop.latestRun?.status,
                          });
                          const isPendingProposal = isPendingLoopProposal(loop);
                          const isUpdatingActivation =
                            updatingLoopActivationId === loop.id;
                          const isUpdatingStatus =
                            updatingLoopStatusId === loop.id;
                          return (
                            <div
                              key={loop.id}
                              className="rounded-md border border-border bg-background/60 p-3 transition-colors hover:bg-muted/20"
                            >
                              <div className="space-y-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="truncate text-sm font-medium text-foreground">
                                      {loop.name}
                                    </h4>
                                    <Badge variant="secondary">
                                      {isPendingProposal
                                        ? "待激活"
                                        : dashboardStatusLabel(
                                            loop.dashboardStatus,
                                          )}
                                    </Badge>
                                  </div>
                                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
                                    {loop.description ??
                                      loop.nextAction ??
                                      loop.goal}
                                  </p>
                                  <div className="mt-2 hidden flex-wrap gap-2 text-xs text-muted-foreground">
                                    <span>
                                      {loop.spaceSummary?.triggerLabel}
                                    </span>
                                    {loop.nextScheduledRunAt ? (
                                      <span>
                                        下次{" "}
                                        {formatDateTime(
                                          loop.nextScheduledRunAt,
                                        )}
                                      </span>
                                    ) : null}
                                  </div>
                                  {isPendingProposal ? (
                                    <LoopProposalDetails loop={loop} />
                                  ) : null}
                                </div>
                                {isPendingProposal ? (
                                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
                                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                      {loop.nextScheduledRunAt
                                        ? `下次 ${formatDateTime(loop.nextScheduledRunAt)}`
                                        : (loop.spaceSummary?.triggerLabel ??
                                          loop.status)}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        setSelectedLoopDetailId(loop.id)
                                      }
                                      className="gap-2"
                                    >
                                      <RemixIcon
                                        name="information"
                                        size="size-4"
                                      />
                                      详情
                                    </Button>
                                    <Button
                                      size="sm"
                                      onClick={() =>
                                        updateLoopActivation(
                                          loop.id,
                                          "activate",
                                        )
                                      }
                                      disabled={isUpdatingActivation}
                                      className="gap-2"
                                    >
                                      <RemixIcon
                                        name={
                                          isUpdatingActivation
                                            ? "loader"
                                            : "play"
                                        }
                                        size="size-4"
                                      />
                                      激活{" "}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        updateLoopActivation(loop.id, "reject")
                                      }
                                      disabled={isUpdatingActivation}
                                      className="gap-2"
                                    >
                                      <RemixIcon name="close" size="size-4" />
                                      拒绝
                                    </Button>
                                  </div>
                                ) : (
                                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
                                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                      {loop.nextScheduledRunAt
                                        ? `下次 ${formatDateTime(loop.nextScheduledRunAt)}`
                                        : (loop.spaceSummary?.triggerLabel ??
                                          loop.status)}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        setSelectedLoopDetailId(loop.id)
                                      }
                                      className="gap-2"
                                    >
                                      <RemixIcon
                                        name="information"
                                        size="size-4"
                                      />
                                      详情
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        loop.status === "paused"
                                          ? updateLoopStatus(loop, "resume")
                                          : updateLoopStatus(loop, "pause")
                                      }
                                      disabled={isUpdatingStatus}
                                      className="hidden gap-2"
                                    >
                                      <RemixIcon
                                        name={
                                          isUpdatingStatus
                                            ? "loader"
                                            : loop.status === "paused"
                                              ? "play"
                                              : "pause"
                                        }
                                        size="size-4"
                                      />
                                      {loop.status === "paused"
                                        ? "恢复"
                                        : "暂停"}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => deleteWorkshopLoop(loop)}
                                      disabled={isUpdatingStatus}
                                      className="hidden gap-2 text-destructive hover:text-destructive"
                                    >
                                      <RemixIcon
                                        name={
                                          isUpdatingStatus
                                            ? "loader"
                                            : "delete_bin"
                                        }
                                        size="size-4"
                                      />
                                      删除
                                    </Button>
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          disabled={isUpdatingStatus}
                                          className="h-8 w-8 p-0"
                                          aria-label="更多任务操作"
                                        >
                                          <RemixIcon
                                            name={
                                              isUpdatingStatus
                                                ? "loader"
                                                : "more_2"
                                            }
                                            size="size-4"
                                          />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent
                                        align="end"
                                        className="w-36"
                                      >
                                        <DropdownMenuItem
                                          onClick={() =>
                                            loop.status === "paused"
                                              ? updateLoopStatus(loop, "resume")
                                              : updateLoopStatus(loop, "pause")
                                          }
                                          disabled={isUpdatingStatus}
                                          className="gap-2"
                                        >
                                          <RemixIcon
                                            name={
                                              loop.status === "paused"
                                                ? "play"
                                                : "pause"
                                            }
                                            size="size-4"
                                          />
                                          {loop.status === "paused"
                                            ? "恢复"
                                            : "暂停"}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          onClick={() =>
                                            deleteWorkshopLoop(loop)
                                          }
                                          disabled={isUpdatingStatus}
                                          className="gap-2 text-destructive focus:text-destructive"
                                        >
                                          <RemixIcon
                                            name="delete_bin"
                                            size="size-4"
                                          />
                                          删除
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => runWorkshopLoop(loop.id)}
                                      disabled={
                                        !selectedId ||
                                        executionView.busy ||
                                        loop.status !== "active" ||
                                        isUpdatingStatus
                                      }
                                      className="gap-2"
                                    >
                                      <RemixIcon
                                        name={executionView.busy ? "loader" : "play"}
                                        size="size-4"
                                      />
                                      {executionView.actionLabel}
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </>
                  ) : null}
                  {activeSideTab === "loops" && managementView === "model" ? (
                    panelLoading.work && !workModel ? (
                      <PanelState
                        state="loading"
                        title="工作模型加载中"
                        description="正在读取车间的控制对象、边界、技能绑定和版本快照。"
                      />
                    ) : (
                      <WorkPanel
                        work={workModel}
                        events={detail?.events ?? []}
                        versions={workVersions}
                        restoringVersionId={restoringWorkVersionId}
                        onRestoreVersion={restoreWorkVersion}
                      />
                    )
                  ) : null}
                  {activeSideTab === "loops" && managementView === "tools" ? (
                    <>
                      {toolMatrixLoading ? (
                        <PanelState
                          state="loading"
                          title="工具矩阵加载中"
                          description="正在读取当前车间的工具权限、风险等级和确认入口。"
                        />
                      ) : !toolMatrix ? (
                        <PanelState
                          state="empty"
                          title="请选择一个车间"
                          description="选择车间后，可以查看该车间允许、需确认和禁止使用的工具。"
                        />
                      ) : (
                        <div className="space-y-4">
                          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                            <div className="rounded-md border border-border p-2">
                              <div className="text-muted-foreground">可用</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">
                                {toolMatrix.counts.allow}
                              </div>
                            </div>
                            <div className="rounded-md border border-border p-2">
                              <div className="text-muted-foreground">
                                霢确认
                              </div>
                              <div className="mt-1 text-lg font-semibold text-foreground">
                                {toolMatrix.counts.requireApproval}
                              </div>
                            </div>
                            <div className="rounded-md border border-border p-2">
                              <div className="text-muted-foreground">禁止</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">
                                {toolMatrix.counts.deny}
                              </div>
                            </div>
                            <div className="rounded-md border border-border p-2">
                              <div className="text-muted-foreground">未开</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">
                                {toolMatrix.counts.disabled +
                                  toolMatrix.counts.unknown}
                              </div>
                            </div>
                          </div>

                          <div className="space-y-2">
                            {toolMatrix.tools.map((tool) => (
                              <div
                                key={tool.id}
                                className="rounded-lg border border-border p-3 [contain-intrinsic-size:0_160px] [content-visibility:auto]"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <h4 className="truncate text-sm font-medium text-foreground">
                                        {tool.displayName}
                                      </h4>
                                      <Badge variant="secondary">
                                        {toolSourceLabel(tool.source)}
                                      </Badge>
                                      <Badge variant="outline">
                                        {toolRiskLabel(tool.risk)}
                                      </Badge>
                                    </div>
                                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                      {tool.description}
                                    </p>
                                  </div>
                                  <span
                                    className={cn(
                                      "shrink-0 rounded-md border px-2 py-1 text-xs",
                                      toolAvailabilityClass(tool.availability),
                                    )}
                                  >
                                    {toolAvailabilityLabel(tool.availability)}
                                  </span>
                                </div>

                                <div className="mt-3 flex flex-wrap gap-1.5">
                                  {tool.capabilities.map((capability) => (
                                    <span
                                      key={capability}
                                      className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                                    >
                                      {toolCapabilityLabel(capability)}
                                    </span>
                                  ))}
                                </div>

                                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                  {tool.decisionReason}
                                </p>

                                {tool.confirmation ? (
                                  <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                                    <div className="font-medium">
                                      确认入口：{tool.confirmation.label}
                                    </div>
                                    <div className="mt-1">
                                      {tool.confirmation.description}
                                    </div>
                                  </div>
                                ) : null}

                                {tool.effectivePolicy ? (
                                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                    策略{" "}
                                    {Object.entries(tool.effectivePolicy)
                                      .map(
                                        ([key, value]) =>
                                          `${key}=${String(value)}`,
                                      )
                                      .join(" / ")}
                                  </p>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : null}
                  {activeSideTab === "loops" && managementView === "boundary" ? (
                    <>
                      {!boundaryForm ? (
                        <PanelState
                          state="empty"
                          title="请选择一个车间"
                          description="选择车间后，可以查看和修改它的权限边界、外发策略和心跳唤醒。"
                        />
                      ) : (
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <label
                              htmlFor="workshop-boundary-mode"
                              className="text-xs font-medium text-muted-foreground"
                            >
                              工作模式
                            </label>
                            <Select
                              value={boundaryForm.mode}
                              onValueChange={(value) => {
                                const mode = value as WorkshopBoundaryMode;
                                const defaults = policyForMode(mode);
                                updateBoundaryForm({
                                  mode,
                                  externalMessages: defaults.externalMessages,
                                  allowWechatPreview:
                                    defaults.allowWechatPreview,
                                });
                              }}
                            >
                              <SelectTrigger id="workshop-boundary-mode">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="observe">
                                  只观察，不生成草稿
                                </SelectItem>
                                <SelectItem value="draft">
                                  只生成草稿
                                </SelectItem>
                                <SelectItem value="auto">
                                  白名单内自动执行
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-2">
                            <label
                              htmlFor="workshop-boundary-external-messages"
                              className="text-xs font-medium text-muted-foreground"
                            >
                              外部消息
                            </label>
                            <Select
                              value={boundaryForm.externalMessages}
                              onValueChange={(value) => {
                                const externalMessages =
                                  value as WorkshopExternalMessagePolicy;
                                updateBoundaryForm({
                                  externalMessages,
                                  allowWechatPreview:
                                    externalMessages !== "blocked",
                                });
                              }}
                            >
                              <SelectTrigger id="workshop-boundary-external-messages">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="blocked">
                                  禁止外部消息
                                </SelectItem>
                                <SelectItem value="draft">
                                  只生成待发草稿
                                </SelectItem>
                                <SelectItem value="auto">
                                  允许自动外发
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="grid gap-3 rounded-lg border border-border p-3">
                            <label
                              htmlFor="workshop-boundary-wechat-preview"
                              className="flex items-center justify-between gap-3 text-sm text-foreground"
                            >
                              <span>允许生成微信预览</span>
                              <Switch
                                id="workshop-boundary-wechat-preview"
                                checked={boundaryForm.allowWechatPreview}
                                onCheckedChange={(checked) =>
                                  updateBoundaryForm({
                                    allowWechatPreview: checked,
                                  })
                                }
                              />
                            </label>
                            <label
                              htmlFor="workshop-boundary-require-sources"
                              className="flex items-center justify-between gap-3 text-sm text-foreground"
                            >
                              <span>待发送草稿必须关联来</span>
                              <Switch
                                id="workshop-boundary-require-sources"
                                checked={boundaryForm.requireSourcesForOutbox}
                                onCheckedChange={(checked) =>
                                  updateBoundaryForm({
                                    requireSourcesForOutbox: checked,
                                  })
                                }
                              />
                            </label>
                          </div>

                          <div className="space-y-2">
                            <label
                              htmlFor="workshop-boundary-allowed-recipients"
                              className="text-xs font-medium text-muted-foreground"
                            >
                              微信收件人白名单
                            </label>
                            <Textarea
                              id="workshop-boundary-allowed-recipients"
                              value={recipientText(boundaryForm)}
                              onChange={(event) =>
                                updateBoundaryForm({
                                  allowedRecipients: parseRecipientList(
                                    event.target.value,
                                  ),
                                })
                              }
                              placeholder="每行一个，例如：文件传输助手"
                            />
                          </div>

                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <label
                              htmlFor="workshop-boundary-max-message-length"
                              className="space-y-2"
                            >
                              <span className="text-xs font-medium text-muted-foreground">
                                最大字数{" "}
                              </span>
                              <Input
                                id="workshop-boundary-max-message-length"
                                type="number"
                                min={1}
                                max={10000}
                                value={boundaryForm.maxMessageLength}
                                onChange={(event) =>
                                  updateBoundaryForm({
                                    maxMessageLength: Number(
                                      event.target.value,
                                    ),
                                  })
                                }
                              />
                            </label>
                            <label
                              htmlFor="workshop-boundary-min-confidence-draft"
                              className="space-y-2"
                            >
                              <span className="text-xs font-medium text-muted-foreground">
                                草稿阈值{" "}
                              </span>
                              <Input
                                id="workshop-boundary-min-confidence-draft"
                                type="number"
                                min={0}
                                max={100}
                                value={boundaryForm.minConfidenceToDraft}
                                onChange={(event) =>
                                  updateBoundaryForm({
                                    minConfidenceToDraft: Number(
                                      event.target.value,
                                    ),
                                  })
                                }
                              />
                            </label>
                            <label
                              htmlFor="workshop-boundary-min-confidence-send"
                              className="space-y-2"
                            >
                              <span className="text-xs font-medium text-muted-foreground">
                                发送阈值{" "}
                              </span>
                              <Input
                                id="workshop-boundary-min-confidence-send"
                                type="number"
                                min={0}
                                max={100}
                                value={boundaryForm.minConfidenceToSend}
                                onChange={(event) =>
                                  updateBoundaryForm({
                                    minConfidenceToSend: Number(
                                      event.target.value,
                                    ),
                                  })
                                }
                              />
                            </label>
                          </div>

                          <div className="space-y-2">
                            <label
                              htmlFor="workshop-boundary-custom-instructions"
                              className="text-xs font-medium text-muted-foreground"
                            >
                              自定义边界说明{" "}
                            </label>
                            <Textarea
                              id="workshop-boundary-custom-instructions"
                              value={boundaryForm.customInstructions}
                              onChange={(event) =>
                                updateBoundaryForm({
                                  customInstructions: event.target.value,
                                })
                              }
                              placeholder="例如：只在出现重大风险、财报异动或我点名的公司时提醒。"
                            />
                          </div>

                          {heartbeatForm ? (
                            <div className="space-y-3 rounded-lg border border-border p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <h3 className="text-sm font-medium text-foreground">
                                    心跳唤醒
                                  </h3>
                                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                    {detail?.heartbeat?.nextWakeupAt
                                      ? `下次唤醒：${new Date(
                                          detail.heartbeat.nextWakeupAt,
                                        ).toLocaleString("zh-CN")}`
                                      : "暂无已安排的下次唤醒"}
                                  </p>
                                </div>
                                <Badge variant="secondary">
                                  {detail?.heartbeat?.schedulerStatus ?? "idle"}
                                </Badge>
                              </div>

                              {detail?.heartbeat?.schedulerError ? (
                                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
                                  {detail.heartbeat.schedulerError}
                                </div>
                              ) : null}

                              <div className="grid gap-3">
                                <label
                                  htmlFor="workshop-heartbeat-enabled"
                                  className="flex items-center justify-between gap-3 text-sm text-foreground"
                                >
                                  <span>启用心跳</span>
                                  <Switch
                                    id="workshop-heartbeat-enabled"
                                    checked={heartbeatForm.enabled}
                                    onCheckedChange={(checked) =>
                                      updateHeartbeatForm({ enabled: checked })
                                    }
                                  />
                                </label>
                                <label
                                  htmlFor="workshop-heartbeat-agent-suggested"
                                  className="flex items-center justify-between gap-3 text-sm text-foreground"
                                >
                                  <span>接受智能体建议唤</span>
                                  <Switch
                                    id="workshop-heartbeat-agent-suggested"
                                    checked={
                                      heartbeatForm.allowAgentSuggestedWakeup
                                    }
                                    onCheckedChange={(checked) =>
                                      updateHeartbeatForm({
                                        allowAgentSuggestedWakeup: checked,
                                      })
                                    }
                                  />
                                </label>
                              </div>

                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <label
                                  htmlFor="workshop-heartbeat-min-interval"
                                  className="space-y-2"
                                >
                                  <span className="text-xs font-medium text-muted-foreground">
                                    最小间隔{" "}
                                  </span>
                                  <Input
                                    id="workshop-heartbeat-min-interval"
                                    type="number"
                                    min={1}
                                    value={heartbeatForm.minIntervalMinutes}
                                    onChange={(event) =>
                                      updateHeartbeatForm({
                                        minIntervalMinutes: Number(
                                          event.target.value,
                                        ),
                                      })
                                    }
                                  />
                                </label>
                                <label
                                  htmlFor="workshop-heartbeat-default-delay"
                                  className="space-y-2"
                                >
                                  <span className="text-xs font-medium text-muted-foreground">
                                    默认延迟
                                  </span>
                                  <Input
                                    id="workshop-heartbeat-default-delay"
                                    type="number"
                                    min={1}
                                    value={heartbeatForm.defaultDelayMinutes}
                                    onChange={(event) =>
                                      updateHeartbeatForm({
                                        defaultDelayMinutes: Number(
                                          event.target.value,
                                        ),
                                      })
                                    }
                                  />
                                </label>
                                <label
                                  htmlFor="workshop-heartbeat-max-interval"
                                  className="space-y-2"
                                >
                                  <span className="text-xs font-medium text-muted-foreground">
                                    最大间隔{" "}
                                  </span>
                                  <Input
                                    id="workshop-heartbeat-max-interval"
                                    type="number"
                                    min={1}
                                    value={heartbeatForm.maxIntervalMinutes}
                                    onChange={(event) =>
                                      updateHeartbeatForm({
                                        maxIntervalMinutes: Number(
                                          event.target.value,
                                        ),
                                      })
                                    }
                                  />
                                </label>
                              </div>

                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <label
                                  htmlFor="workshop-heartbeat-grace"
                                  className="space-y-2"
                                >
                                  <span className="text-xs font-medium text-muted-foreground">
                                    错过宽限
                                  </span>
                                  <Input
                                    id="workshop-heartbeat-grace"
                                    type="number"
                                    min={0}
                                    value={heartbeatForm.missedRunGraceMinutes}
                                    onChange={(event) =>
                                      updateHeartbeatForm({
                                        missedRunGraceMinutes: Number(
                                          event.target.value,
                                        ),
                                      })
                                    }
                                  />
                                </label>
                                <label
                                  htmlFor="workshop-heartbeat-lease"
                                  className="space-y-2"
                                >
                                  <span className="text-xs font-medium text-muted-foreground">
                                    租约分钟
                                  </span>
                                  <Input
                                    id="workshop-heartbeat-lease"
                                    type="number"
                                    min={1}
                                    value={heartbeatForm.leaseMinutes}
                                    onChange={(event) =>
                                      updateHeartbeatForm({
                                        leaseMinutes: Number(
                                          event.target.value,
                                        ),
                                      })
                                    }
                                  />
                                </label>
                                <label
                                  htmlFor="workshop-heartbeat-max-failures"
                                  className="space-y-2"
                                >
                                  <span className="text-xs font-medium text-muted-foreground">
                                    失败上限
                                  </span>
                                  <Input
                                    id="workshop-heartbeat-max-failures"
                                    type="number"
                                    min={1}
                                    value={heartbeatForm.maxConsecutiveFailures}
                                    onChange={(event) =>
                                      updateHeartbeatForm({
                                        maxConsecutiveFailures: Number(
                                          event.target.value,
                                        ),
                                      })
                                    }
                                  />
                                </label>
                              </div>

                              <Button
                                onClick={saveHeartbeatPolicy}
                                disabled={!selectedId || busy}
                                variant="outline"
                                className="w-full gap-2"
                              >
                                <RemixIcon name="pulse" size="size-4" />
                                保存心跳
                              </Button>
                            </div>
                          ) : null}

                          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
                            金融交易、下单和付款指令始终会被拦截；自动执行也只用于通过边界检查的白名单动作。
                          </div>
                          <Button
                            onClick={saveBoundaryPolicy}
                            disabled={!selectedId || busy}
                            className="w-full gap-2"
                          >
                            <RemixIcon name="save" size="size-4" />
                            保存边界
                          </Button>
                        </div>
                      )}
                    </>
                  ) : null}
                </TabsContent>

                <TabsContent
                  value="sources"
                  className={cn(sidePanelContentClass, "space-y-4 p-4")}
                >
                  {activeSideTab === "sources" ? (
                    <>
                      <Button variant="outline" disabled={!!panelLoading.sources} onClick={()=>{if(selectedId)void refreshSources(selectedId).catch((err)=>setError(String(err)));}}>刷新资料</Button>
                      <p className="text-xs leading-5 text-muted-foreground">这里保存智能体长期可用的背景资料、规则和网站。临时任务需要的文件路径，可以直接在当前智能体的对话中交代。</p>
                      <div className="space-y-2">
                        <Input
                          value={sourceName}
                          onChange={(event) =>
                            setSourceName(event.target.value)
                          }
                          placeholder="资料名称"
                        />
                        <Input
                          value={sourceUri}
                          onChange={(event) => setSourceUri(event.target.value)}
                          placeholder="网址或本地文件绝对路径，可选"
                        />
                        <Textarea
                          value={sourceContent}
                          onChange={(event) =>
                            setSourceContent(event.target.value)
                          }
                          className="min-h-24 resize-none"
                          placeholder="手动资料，可选"
                        />
                        <Button
                          onClick={addSource}
                          disabled={!selectedId || busy || !sourceName.trim()}
                          className="w-full gap-2"
                        >
                          <RemixIcon name="link" size="size-4" />
                          接入资料
                        </Button>
                      </div>
                      {panelLoading.sources && !loadedPanels.sources ? (
                        <PanelState
                          state="loading"
                          title="资料源加载中"
                          description="车间页面保持可用，资料列表返回后会在当前面板局部更新。"
                        />
                      ) : null}
                      {!panelLoading.sources &&
                      (detail?.sources ?? []).length === 0 ? (
                        <PanelState
                          state="empty"
                          title="暂无资料"
                          description="可以接入长期可用的说明、规则或网站；临时任务的文件路径请直接写在对话中。"
                        />
                      ) : null}
                      <div className="space-y-3">
                        {(detail?.sources ?? []).map((source) => (
                          <div
                            key={source.id}
                            className="rounded-lg border border-border p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {source.name}
                              </span>
                              <Badge variant="secondary">{source.type}</Badge>
                            </div>
                            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                              {source.uri ?? source.content ?? "无额外内"}
                            </p>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {activeSideTab === "sources" ? (
                    <>
                      <div className="flex items-center gap-2">
                        <Button
                          onClick={recordWechatMessages}
                          disabled={!selectedId || recordingWechatMessages}
                          className="flex-1 gap-2"
                        >
                          <RemixIcon name="inbox_unarchive" size="size-4" />
                          {recordingWechatMessages
                            ? "记录中..."
                            : "记录微信新消息"}
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() =>
                            refreshInteractions().catch((err) =>
                              setError(
                                err instanceof Error
                                  ? err.message
                                  : String(err),
                              ),
                            )
                          }
                          disabled={interactionsLoading}
                          aria-label="刷新交互"
                        >
                          <RemixIcon name="refresh" size="size-4" />
                        </Button>
                      </div>

                      {interactionsLoading && interactionEvents.length === 0 ? (
                        <PanelState
                          state="loading"
                          title="交互消息加载中"
                          description="当前车间保持可用，微信消息记录返回后会在这里局部更新。"
                        />
                      ) : interactionEvents.length === 0 ? (
                        <PanelState
                          state="empty"
                          title="暂无已记录的微信消息"
                          description="点击上方按钮后，新消息会沉淀为交互事件，并进入后续理解层。"
                        />
                      ) : (
                        <div className="space-y-2">
                          {interactionEvents.map((event) => (
                            <div
                              key={event.id}
                              className="rounded-lg border border-border p-3"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-foreground">
                                    {event.conversationName}
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground">
                                    {event.senderDisplayName ??
                                      event.senderName ??
                                      "未知发"}{" "}
                                    · {formatDateTime(event.messageTime)}
                                  </div>
                                </div>
                                <Badge variant="secondary">
                                  {event.processedStatus}
                                </Badge>
                              </div>
                              <p className="mt-2 line-clamp-3 text-sm leading-6 text-foreground">
                                {event.contentPreview}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="border-t border-border pt-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <h4 className="text-sm font-medium text-foreground">
                            交互沉淀
                          </h4>
                          <Badge variant="outline">
                            {interactionWiki.notes.length +
                              interactionWiki.tasks.length +
                              interactionWiki.memories.length}
                          </Badge>
                        </div>

                        {interactionWiki.notes.length === 0 &&
                        interactionWiki.tasks.length === 0 &&
                        interactionWiki.memories.length === 0 ? (
                          <PanelState
                            state="empty"
                            title="暂无交互沉淀"
                            description="智能体处理消息后，会把有价值的信息沉淀为摘要、待办或长期记忆候选。"
                          />
                        ) : (
                          <div className="space-y-3">
                            {interactionWiki.tasks.length > 0 ? (
                              <div className="space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                  待办候选{" "}
                                </div>
                                {interactionWiki.tasks
                                  .slice(0, 3)
                                  .map((task) => (
                                    <div
                                      key={task.id}
                                      className="min-w-0 rounded-lg border border-border p-3"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-sm font-medium text-foreground">
                                          {task.title}
                                        </span>
                                        <Badge variant="secondary">
                                          {interactionStatusLabel(task.status)}
                                        </Badge>
                                      </div>
                                      {task.description ? (
                                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                          {task.description}
                                        </p>
                                      ) : null}
                                      {canConfirmInteractionItem(
                                        task.status,
                                      ) ? (
                                        <div className="mt-3 flex gap-2">
                                          <Button
                                            variant="outline"
                                            className="h-7 gap-1 px-2 text-xs"
                                            disabled={
                                              wikiActionId ===
                                              `task:${task.id}:confirmed`
                                            }
                                            onClick={() =>
                                              updateInteractionWikiStatus(
                                                "task",
                                                task.id,
                                                "confirmed",
                                              )
                                            }
                                          >
                                            <RemixIcon
                                              name="checkbox_circle"
                                              size="size-3.5"
                                            />
                                            确认
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                                            disabled={
                                              wikiActionId ===
                                              `task:${task.id}:dismissed`
                                            }
                                            onClick={() =>
                                              updateInteractionWikiStatus(
                                                "task",
                                                task.id,
                                                "dismissed",
                                              )
                                            }
                                          >
                                            <RemixIcon
                                              name="close"
                                              size="size-3.5"
                                            />
                                            忽略
                                          </Button>
                                        </div>
                                      ) : null}
                                    </div>
                                  ))}
                              </div>
                            ) : null}

                            {interactionWiki.memories.length > 0 ? (
                              <div className="space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                  长期记忆候选{" "}
                                </div>
                                {interactionWiki.memories
                                  .slice(0, 3)
                                  .map((memory) => (
                                    <div
                                      key={memory.id}
                                      className="rounded-lg border border-border p-3"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-sm font-medium text-foreground">
                                          {memory.subject}
                                        </span>
                                        <Badge variant="secondary">
                                          {memory.memoryType}
                                        </Badge>
                                      </div>
                                      <div className="mt-2">
                                        <Badge variant="outline">
                                          {interactionStatusLabel(
                                            memory.status,
                                          )}
                                        </Badge>
                                      </div>
                                      <p className="mt-2 line-clamp-2 min-w-0 break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                                        {memory.content}
                                      </p>
                                      {canConfirmInteractionItem(
                                        memory.status,
                                      ) ? (
                                        <div className="mt-3 flex gap-2">
                                          <Button
                                            variant="outline"
                                            className="h-7 gap-1 px-2 text-xs"
                                            disabled={
                                              wikiActionId ===
                                              `memory:${memory.id}:confirmed`
                                            }
                                            onClick={() =>
                                              updateInteractionWikiStatus(
                                                "memory",
                                                memory.id,
                                                "confirmed",
                                              )
                                            }
                                          >
                                            <RemixIcon
                                              name="checkbox_circle"
                                              size="size-3.5"
                                            />
                                            确认
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                                            disabled={
                                              wikiActionId ===
                                              `memory:${memory.id}:dismissed`
                                            }
                                            onClick={() =>
                                              updateInteractionWikiStatus(
                                                "memory",
                                                memory.id,
                                                "dismissed",
                                              )
                                            }
                                          >
                                            <RemixIcon
                                              name="close"
                                              size="size-3.5"
                                            />
                                            忽略
                                          </Button>
                                        </div>
                                      ) : null}
                                    </div>
                                  ))}
                              </div>
                            ) : null}

                            {interactionWiki.notes.length > 0 ? (
                              <div className="space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                  理解摘要
                                </div>
                                {interactionWiki.notes
                                  .slice(0, 3)
                                  .map((note) => (
                                    <div
                                      key={note.id}
                                      className="rounded-lg border border-border p-3"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-sm font-medium text-foreground">
                                          {note.title}
                                        </span>
                                        <Badge variant="secondary">
                                          {note.noteType}
                                        </Badge>
                                      </div>
                                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                        {note.body}
                                      </p>
                                    </div>
                                  ))}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}
                </TabsContent>


                <TabsContent
                  value="memory"
                  className={cn(sidePanelContentClass, "space-y-3 p-4")}
                >
                  {activeSideTab === "memory" ? (
                    <>
                      <Button variant="outline" disabled={!!panelLoading.memories} onClick={()=>{if(selectedId)void refreshMemories(selectedId).catch((err)=>setError(String(err)));}}>刷新记忆</Button>
                      <MemoryRecallQualitySummary report={memoryRecallQuality} />
                      {panelLoading.memories && !loadedPanels.memories ? (
                        <PanelState
                          state="loading"
                          title="长期记忆加载中"
                          description="车间可继续查看其它面板，记忆列表返回后会局部更新。"
                        />
                      ) : (detail?.memories ?? []).length === 0 ? (
                        <PanelState
                          state="empty"
                          title="暂无长期记忆"
                          description="后续执行器会在每轮结束后提炼可复用事实，并写入统一记忆平台。"
                        />
                      ) : (
                        detail?.memories.map((memory) => (
                          <div
                            key={memory.id}
                            className="min-w-0 rounded-lg border border-border p-3"
                          >
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <Badge variant="secondary">{memory.kind}</Badge>
                              <span className="text-xs text-muted-foreground">
                                {memory.confidence}%
                              </span>
                            </div>
                            <p className="mt-2 min-w-0 whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                              {memory.content}
                            </p>
                            <MemoryCanonicalSummary memory={memory} />
                          </div>
                        ))
                      )}
                    </>
                  ) : null}
                </TabsContent>


                <TabsContent
                  value="outbox"
                  className={cn(sidePanelContentClass, "space-y-3 p-4")}
                >
                  {activeSideTab === "outbox" ? (
                    <>
                      {panelLoading.outbox && !loadedPanels.outbox ? (
                        <PanelState
                          state="loading"
                          title="待发草稿加载中"
                          description="车间其它区域保持可用，草稿返回后会在当前面板局部更新。"
                        />
                      ) : (detail?.outbox ?? []).length === 0 ? (
                        <PanelState
                          state="empty"
                          title="暂无待发送草稿"
                          description="智能体生成外部消息后，会先放到这里等待边界检查与人工确认。"
                        />
                      ) : (
                        detail?.outbox.map((item) => {
                          const boundary = item.boundaryResult?.boundary as
                            | {
                                status?: string;
                                violations?: string[];
                                warnings?: string[];
                              }
                            | undefined;
                          const preview = item.boundaryResult?.wechatPreview as
                            | { expiresAt?: string }
                            | undefined;
                          const recipientInputId = `outbox-recipient-${item.id}`;
                          const needsOwnerInput = isOwnerInputOutbox(item);
                          return (
                            <div
                              key={item.id}
                              data-outbox-id={item.id}
                              className={cn(
                                "rounded-lg border p-3",
                                needsOwnerInput
                                  ? "border-sky-500/30 bg-sky-500/5"
                                  : "border-border",
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <Badge>
                                  {needsOwnerInput ? "待补充信息" : outboxStatusLabel(item.status,item.boundaryResult)}
                                </Badge>
                                <span className="text-xs text-muted-foreground">
                                  {needsOwnerInput
                                    ? "车间提问"
                                    : `${item.riskLevel} / ${item.confidence}%`}
                                </span>
                              </div>
                              <p className="mt-2 text-sm leading-6 text-foreground">
                                {item.message}
                              </p>
                              <div
                                className={cn(
                                  "mt-3 flex flex-col gap-2 sm:flex-row sm:items-center",
                                  needsOwnerInput && "hidden",
                                )}
                              >
                                <div className="min-w-0 flex-1">
                                  <label
                                    htmlFor={recipientInputId}
                                    className="mb-1 block text-xs text-muted-foreground"
                                  >
                                    发送对象{" "}
                                  </label>
                                  <Input
                                    id={recipientInputId}
                                    value={
                                      outboxRecipients[item.id] ??
                                      item.recipientName ??
                                      ""
                                    }
                                    onChange={(event) =>
                                      setOutboxRecipients((current) => ({
                                        ...current,
                                        [item.id]: event.target.value,
                                      }))
                                    }
                                    placeholder="例如：文件传输助手"
                                    disabled={isOutboxLocked(item.status) || busy}
                                  />
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => saveOutboxRecipient(item)}
                                  disabled={isOutboxLocked(item.status) || busy}
                                  className="mt-5 shrink-0 gap-2 sm:mt-6"
                                >
                                  <RemixIcon name="save" size="size-4" />
                                  保存
                                </Button>
                              </div>
                              {needsOwnerInput ? (
                                <p className="mt-2 text-xs text-muted-foreground">
                                  请在方向输入框补充信息后重新发送，车间会继续规划。{" "}
                                </p>
                              ) : null}
                              <p className="mt-2 text-xs text-muted-foreground">
                                {needsOwnerInput ? "owner_input" : item.channel}
                              </p>
                              {boundary?.violations?.length ? (
                                <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
                                  {boundary.violations.join(" / ")}
                                </div>
                              ) : null}
                              {boundary?.warnings?.length ? (
                                <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                                  {boundary.warnings.join(" / ")}
                                </div>
                              ) : null}
                              {preview?.expiresAt ? (
                                <p className="mt-2 text-xs text-muted-foreground">
                                  预览有效期至{" "}
                                  {new Date(
                                    preview.expiresAt,
                                  ).toLocaleTimeString("zh-CN")}
                                </p>
                              ) : null}
                              <div
                                className={cn(
                                  "mt-3 flex flex-wrap gap-2",
                                  needsOwnerInput && "hidden",
                                )}
                              >
                                {canDismissOutbox(item.status)?(
                                  <Button size="sm" variant="outline" disabled={busy||!item.updatedAt} onClick={()=>dismissOutbox(item)} title="结束处理并保留消息及拦截记录，不会发送这条消息">
                                    {outboxActionId===`dismiss:${item.id}`?'处理中…':'不再发送'}
                                  </Button>
                                ):null}
                                {isOutboxUnsettled(item.status)?(
                                  <div className="w-full space-y-2 text-sm">
                                    <p>{outboxStatusLabel(item.status)}。当前内容已锁定，查询不会重复发送。</p>
                                    <Button size="sm" variant="outline" disabled={busy} onClick={()=>reconcileOutbox(item.id)}>查询发送结果</Button>
                                    {item.status==='unknown'&&selectedId?<OutboxResolutionPanel workId={selectedId} outboxId={item.id} onChanged={async(notice)=>{setError(notice??null);await Promise.all([refreshDetail(selectedId),refreshOutbox(selectedId),refreshReviewItems(selectedId),refreshSelectedLoopDetail()]);}}/>:null}
                                  </div>
                                ):null}
                                {canPreviewOutbox(item) ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => previewOutbox(item)}
                                    disabled={busy}
                                    className="gap-2"
                                  >
                                    <RemixIcon name="eye" size="size-4" />
                                    生成预览
                                  </Button>
                                ) : null}
                                {canSendOutbox(item) ? (
                                  <Button
                                    size="sm"
                                    onClick={() => sendOutbox(item.id)}
                                    disabled={busy}
                                    className="gap-2"
                                  >
                                    <RemixIcon
                                      name="send_plane"
                                      size="size-4"
                                    />
                                    确认发送{" "}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </>
                  ) : null}
                </TabsContent>


                <TabsContent
                  value="review"
                  className={cn(sidePanelContentClass, "space-y-3 p-4")}
                >
                  {activeSideTab === "review" ? (
                    <>
                      {selectedId && !selectedReviewId ? <ReviewDecisionDesk key={`review-decisions:${selectedId}`}
                        workId={selectedId} refreshKey={reviewRefreshKey}
                        onSelectReview={setSelectedReviewId} /> : null}
                      <div className="rounded-lg border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <h4 className="text-sm font-medium text-foreground">
                              {selectedReviewId ? "处理这件事" : "原始资料与处理入口"}
                            </h4>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {selectedReviewId ? "先核对这件事的原始依据，再选择处理方式。AI 建议供你参考，实际操作以按钮说明为准。" : "从上方选择你关心的事项。视频草稿等其他待办保留在下方对应入口。"}
                            </p>
                          </div>
                          <Badge variant="secondary">全部 {reviewItemCount}</Badge>
                        </div>
                        {!reviewItemsLoading && reviewItems !== null ? <p className="mt-2 text-xs text-muted-foreground">
                          需老板决策 {reviewDecisionCount} 项 · 其他待评估 {Math.max(0, reviewItemCount - reviewDecisionCount)} 项
                        </p> : null}
                      </div>

                      {selectedReviewId?<section ref={reviewLocationRef} aria-label="定位审核记录" className="scroll-mt-3 space-y-2 rounded border border-violet-300 p-3">
                        <div className="flex flex-wrap justify-between gap-2"><h4 className="font-medium">定位审核记录</h4><Button size="sm" variant="outline" onClick={()=>setSelectedReviewId(null)}>返回审核列表</Button></div>
                        {reviewLocation.loading?<p role="status">正在读取审核记录…</p>:reviewLocation.error?<p role="alert">{reviewLocation.error}</p>:reviewLocation.data?<>
                          <h5 className="font-medium">{buildReviewAssistantItem(reviewLocation.data.item).title}</h5>
                          <details className="text-sm"><summary className="cursor-pointer">查看原始标题与摘要</summary>
                            <p className="mt-2 break-words font-medium">{reviewLocation.data.item.title}</p>
                            <p className="mt-1 whitespace-pre-wrap break-words">{reviewLocation.data.item.summary}</p>
                          </details>
                          <p>审核状态：{{pending:'待处理',approved:'已批准',rejected:'已拒绝',dismissed:'已暂不处理',superseded:'已被替代'}[reviewLocation.data.item.status]}</p>
                          <p className="text-xs text-muted-foreground">更新于 {formatDateTime(reviewLocation.data.item.updatedAt)}</p>
                          <p className="text-xs text-muted-foreground">{reviewLocation.data.item.status==='pending'?'请在下方对应操作卡片核对后处理。':'此记录已处理，原处理入口不再开放。'}</p>
                        </>:null}
                        <Button size="sm" variant="outline" onClick={reviewLocation.refresh} disabled={reviewLocation.loading}>重新读取审核记录</Button>
                      </section>:null}

                      {douyinDraftsLoading && !selectedReviewId ? (
                        <PanelState
                          state="loading"
                          title="视频草稿审核加载中"
                          description="正在读取待审核的视频草稿，审核列表返回后会局部更新。"
                        />
                      ) : null}

                      {reviewItemsLoading ? (
                        <PanelState
                          state="loading"
                          title="待处理项加载中"
                          description="审核面板保持可用，结构化待处理项返回后会局部更新。"
                        />
                      ) : null}

                      {!reviewItemsLoading && reviewItemCount === 0 ? (
                        <PanelState
                          state="empty"
                          title="暂无待审核操作"
                          description="智能体提出需要人工确认的系统变更后，会出现在这里。"
                        />
                      ) : (
                        <details key={selectedReviewId ?? "all-review-details"} open={Boolean(selectedReviewId)} className="space-y-3">
                          <summary className="cursor-pointer text-sm font-medium">{selectedReviewId ? "这件事的依据与处理方式" : `展开全部原始待办（${reviewItemCount} 项）`}</summary>
                          {!selectedReviewId && reviewDecisionCount > 0 ? <h5 className="text-sm font-semibold">需老板决策</h5> : null}
                          {reviewAgentChangeProposals.filter(event => !selectedReviewId || reviewItemsBySourceEventId.get(event.id)?.id === selectedReviewId).map((event) => {
                            const item = reviewItemsBySourceEventId.get(event.id);
                            const dismissing =
                              item && reviewItemActionId === `dismiss:${item.id}`;
                            return (
                              <div key={event.id} className="space-y-2" data-review-item-id={item?.id}>
                                {item?<ReviewLocationLink workId={selectedId} reviewId={item.id} onSelect={setSelectedReviewId}/>:null}
                                {item ? <ReviewMatterSummary item={item} sourceEvent={event} /> : null}
                                <AgentChangeProposalCard
                                  event={event}
                                  actionId={agentChangeActionId}
                                  currentWorkVersion={
                                    workModel?.manifest.version ?? null
                                  }
                                  onResolve={resolveAgentChangeProposal}
                                  onRefresh={() => {
                                    if (selectedId) {
                                      refreshDetail(selectedId).catch((err) =>
                                        setError(
                                          err instanceof Error
                                            ? err.message
                                            : String(err),
                                        ),
                                      );
                                    }
                                  }}
                                />
                                {item ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="gap-2"
                                    disabled={Boolean(reviewItemActionId)}
                                    onClick={() => dismissReviewItem(item)}
                                  >
                                    <RemixIcon
                                      name={dismissing ? "loader" : "check"}
                                      size="size-4"
                                    />
                                    暂不处理
                                  </Button>
                                ) : null}
                              </div>
                            );
                          })}
                          {(selectedReviewId ? [] : reviewVideoDrafts).map((draft) => (
                            <VideoReviewCard
                              key={draft.id}
                              draft={draft}
                              actionId={videoReviewActionId}
                              onResolve={resolveVideoReview}
                            />
                          ))}
                          {genericReviewItems.filter(item => !selectedReviewId || item.id === selectedReviewId).map((item, index) => {
                            const dismissing =
                              reviewItemActionId === `dismiss:${item.id}`;
                            const groupDismissing =
                              reviewItemActionId === `dismiss-group:${item.id}`;
                            const canDismissGroup = item.kind === "service_error";
                            const isMemoryGovernanceProposal =
                              item.kind ===
                              "memory_recall_governance_proposal";
                            const isMemoryRecallChangePlan =
                              item.kind === "memory_recall_change_plan";
                            const isInsightChangeProposal =
                              item.kind === "insight_change_proposal";
                            const approvingGovernanceProposal =
                              reviewItemActionId ===
                              `governance-proposal:approved:${item.id}`;
                            const rejectingGovernanceProposal =
                              reviewItemActionId ===
                              `governance-proposal:rejected:${item.id}`;
                            const approvingChangePlan =
                              reviewItemActionId ===
                              `change-plan:approved:${item.id}`;
                            const rejectingChangePlan =
                              reviewItemActionId ===
                              `change-plan:rejected:${item.id}`;
                            const approvingInsightProposal =
                              reviewItemActionId ===
                              `insight-proposal:approved:${item.id}`;
                            const rejectingInsightProposal =
                              reviewItemActionId ===
                              `insight-proposal:rejected:${item.id}`;
                            return (<div key={item.id} className="space-y-3">
                              {!selectedReviewId && index === firstOtherReviewIndex ? <h5 className="pt-2 text-sm font-semibold">其他待评估记录</h5> : null}
                              <div
                                data-review-item-id={item.id}
                                className="rounded-lg border border-border bg-background p-3"
                              >
                                <ReviewLocationLink workId={selectedId} reviewId={item.id} onSelect={setSelectedReviewId}/>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge variant="secondary">
                                        {reviewKindLabel(item.kind)}
                                      </Badge>
                                      <h4 className="break-words text-sm font-medium text-foreground">
                                        {buildReviewAssistantItem(item, item.sourceEventId ? reviewEventsById.get(item.sourceEventId) : null).title}
                                      </h4>
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {formatDateTime(item.createdAt)}
                                    </p>
                                  </div>
                                </div>
                                <ReviewMatterSummary item={item} sourceEvent={item.sourceEventId ? reviewEventsById.get(item.sourceEventId) : null} />
                                {item.kind === "report_quality_config_proposal" ? <p className="mt-3 text-sm leading-6">
                                  这是一条改进以后工作汇报的建议，可以按兴趣查看。目前没有一键应用入口；关闭待办不会修改报告或任务设置。
                                </p> : null}
                                <details className="mt-3 text-xs leading-5 text-muted-foreground">
                                  <summary className="cursor-pointer">原始说明与证据</summary>
                                  <p className="mt-2 font-medium">{item.title}</p>
                                  <p className="mt-2 whitespace-pre-wrap break-words">{item.summary || "这条记录没有附带摘要。"}</p>
                                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3">{JSON.stringify(item.sourceEventId ? reviewEventsById.get(item.sourceEventId)?.metadata ?? item.metadata : item.metadata, null, 2)}</pre>
                                </details>
                                {item.kind === "loop_change_proposal" ? <div className="mt-3 space-y-2">
                                  <p className="text-xs leading-5">同意后会按原始提案修改这项持续任务；请先核对修改内容和运行安排。</p>
                                  <div className="flex flex-wrap gap-2">
                                    <Button size="sm" disabled={Boolean(reviewItemActionId)} onClick={() => resolveLoopChangeProposal(item, "approved")}>{reviewItemActionId === `loop-proposal:approved:${item.id}` ? "正在应用…" : "同意并修改任务"}</Button>
                                    <Button size="sm" variant="outline" disabled={Boolean(reviewItemActionId)} onClick={() => resolveLoopChangeProposal(item, "rejected")}>{reviewItemActionId === `loop-proposal:rejected:${item.id}` ? "正在拒绝…" : "拒绝这次修改"}</Button>
                                  </div>
                                </div> : null}
                                {isInsightChangeProposal ? (
                                  <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                                    确认后会按提案创建、修改或删除洞察，并记录审核审计；拒绝则只关闭提案，不改动洞察。
                                  </p>
                                ) : null}
                                <MemoryRecallQualityReviewDetails
                                  item={item}
                                  actionId={reviewItemActionId}
                                  onConfirmAction={
                                    confirmMemoryRecallGovernanceAction
                                  }
                                  onConfirmBatch={
                                    confirmMemoryRecallGovernanceBatch
                                  }
                                />
                                <MemoryRecallChangePlanReviewDetails
                                  item={item}
                                />
                                {isMemoryGovernanceProposal ? (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <Button
                                      size="sm"
                                      className="gap-2"
                                      disabled={Boolean(reviewItemActionId)}
                                      onClick={() =>
                                        resolveMemoryRecallGovernanceProposal(
                                          item,
                                          "approved",
                                        )
                                      }
                                    >
                                      <RemixIcon
                                        name={
                                          approvingGovernanceProposal
                                            ? "loader"
                                            : "check"
                                        }
                                        size="size-4"
                                      />
                                      同意开展检查
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="gap-2"
                                      disabled={Boolean(reviewItemActionId)}
                                      onClick={() =>
                                        resolveMemoryRecallGovernanceProposal(
                                          item,
                                          "rejected",
                                        )
                                      }
                                    >
                                      <RemixIcon
                                        name={
                                          rejectingGovernanceProposal
                                            ? "loader"
                                            : "x"
                                        }
                                        size="size-4"
                                      />
                                      拒绝这次检查
                                    </Button>
                                  </div>
                                ) : null}
                                {isMemoryRecallChangePlan ? (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <Button
                                      size="sm"
                                      className="gap-2"
                                      disabled={Boolean(reviewItemActionId)}
                                      onClick={() =>
                                        resolveMemoryRecallChangePlan(
                                          item,
                                          "approved",
                                        )
                                      }
                                    >
                                      <RemixIcon
                                        name={
                                          approvingChangePlan
                                            ? "loader"
                                            : "check"
                                        }
                                        size="size-4"
                                      />
                                      确认改进方案
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="gap-2"
                                      disabled={Boolean(reviewItemActionId)}
                                      onClick={() =>
                                        resolveMemoryRecallChangePlan(
                                          item,
                                          "rejected",
                                        )
                                      }
                                    >
                                      <RemixIcon
                                        name={
                                          rejectingChangePlan
                                            ? "loader"
                                            : "x"
                                        }
                                        size="size-4"
                                      />
                                      拒绝这个方案
                                    </Button>
                                  </div>
                                ) : null}
                                {isInsightChangeProposal ? (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <Button
                                      size="sm"
                                      className="gap-2"
                                      disabled={Boolean(reviewItemActionId)}
                                      onClick={() =>
                                        resolveInsightChangeProposal(
                                          item,
                                          "approved",
                                        )
                                      }
                                    >
                                      <RemixIcon
                                        name={
                                          approvingInsightProposal
                                            ? "loader"
                                            : "check"
                                        }
                                        size="size-4"
                                      />
                                      确认提案
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="gap-2"
                                      disabled={Boolean(reviewItemActionId)}
                                      onClick={() =>
                                        resolveInsightChangeProposal(
                                          item,
                                          "rejected",
                                        )
                                      }
                                    >
                                      <RemixIcon
                                        name={
                                          rejectingInsightProposal
                                            ? "loader"
                                            : "x"
                                        }
                                        size="size-4"
                                      />
                                      拒绝提案
                                    </Button>
                                  </div>
                                ) : null}
                                {canDismissGroup ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="mt-3 mr-2 gap-2"
                                    disabled={Boolean(reviewItemActionId)}
                                    onClick={() => dismissReviewItemGroup(item)}
                                  >
                                    <RemixIcon
                                      name={groupDismissing ? "loader" : "check"}
                                      size="size-4"
                                    />
                                    关闭同类
                                  </Button>
                                ) : null}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="mt-3 gap-2"
                                  disabled={Boolean(reviewItemActionId)}
                                  onClick={() => dismissReviewItem(item)}
                                >
                                  <RemixIcon
                                    name={dismissing ? "loader" : "check"}
                                    size="size-4"
                                  />
                                  关闭这条待办
                                </Button>
                              </div></div>
                            );
                          })}
                          {reviewWatchlistProposals.filter(event => !selectedReviewId || reviewItemsBySourceEventId.get(event.id)?.id === selectedReviewId).map((event) => {
                            const item = reviewItemsBySourceEventId.get(event.id);
                            const dismissing =
                              item && reviewItemActionId === `dismiss:${item.id}`;
                            return (
                            <div
                              key={event.id}
                              data-review-item-id={item?.id}
                              className="rounded-lg border border-border bg-background p-3"
                            >
                              {item?<ReviewLocationLink workId={selectedId} reviewId={item.id} onSelect={setSelectedReviewId}/>:null}
                              {item ? <ReviewMatterSummary item={item} sourceEvent={event} /> : null}
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant="secondary">
                                      自选股调整
                                    </Badge>
                                    <h4 className="truncate text-sm font-medium text-foreground">
                                      {event.title}
                                    </h4>
                                  </div>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {formatDateTime(event.createdAt)}
                                  </p>
                                </div>
                              </div>
                              <WatchlistProposalEventCard
                                event={event}
                                resolution={undefined}
                                actionId={watchlistProposalActionId}
                                onResolve={resolveWatchlistProposal}
                              />
                              {item ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="mt-3 gap-2"
                                  disabled={Boolean(reviewItemActionId)}
                                  onClick={() => dismissReviewItem(item)}
                                >
                                  <RemixIcon
                                    name={dismissing ? "loader" : "check"}
                                    size="size-4"
                                  />
                                  暂不处理
                                </Button>
                              ) : null}
                            </div>
                            );
                          })}
                        </details>
                      )}
                    </>
                  ) : null}
                </TabsContent>

                <TabsContent value="collaboration" className={cn(sidePanelContentClass, "p-4")}>
                  {activeSideTab === "collaboration" && selectedId ? <CollaborationPanel workId={selectedId} /> : null}
                </TabsContent>

                <TabsContent
                  value="evolution"
                  className={cn(sidePanelContentClass, "p-4")}
                >
                  {activeSideTab === "evolution" && selectedId ? (
                    <HarnessEvolutionPanel workshopId={selectedId} />
                  ) : null}
                </TabsContent>

                <TabsContent
                  value="attention"
                  className={cn(sidePanelContentClass, "space-y-4 p-4")}
                >
                  {activeSideTab === "attention" ? (
                    <>
                      <div className="rounded-lg border border-border bg-background p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-medium text-foreground">
                              待我处理
                            </h3>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              先区分需要你决定的动作和需要核查的记录；审核、待发分别保留独立操作。
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-1">
                            <Badge variant="secondary">需决策 {visibleDecisionCount}</Badge>
                            <Badge variant="outline">待核查 {visibleInvestigationCount}</Badge>
                          </div>
                        </div>
                        {attentionItems.length > 0 ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {Object.entries(attentionCounts).map(
                              ([category, count]) => {
                                const meta = attentionMeta(
                                  category as AttentionCategory,
                                );
                                return (
                                  <Badge
                                    key={category}
                                    variant="secondary"
                                    className={meta.tone}
                                  >
                                    {meta.label} {count}
                                  </Badge>
                                );
                              },
                            )}
                          </div>
                        ) : null}
                      </div>

                      {attentionItems.length === 0 && (reviewItemsLoading || panelLoading.outbox) ? (
                        <PanelState state="loading" title="待处理记录加载中" description="正在核对审核、阻塞和外发边界记录。" />
                      ) : attentionItems.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                          <RemixIcon
                            name="circle_check"
                            size="size-8"
                            className="mx-auto text-emerald-600 dark:text-emerald-300"
                          />
                          <p className="mt-3 text-sm font-medium text-foreground">
                            {visibleDecisionCount + visibleInvestigationCount === 0
                              ? "当前没有待处理事项"
                              : "请查看审核、待发或持续任务"}
                          </p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            这里汇总阻塞与待核查记录；审批提案和外发确认可在上方子页处理。
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {attentionItems.map((item) => {
                            const meta = attentionMeta(item.category);
                            const isPlatformBug =
                              isPlatformBugAttentionItem(item);
                            const isLoop = item.source === "loop";
                            const loop = isLoop ? item.loop : null;
                            const executionView = loop
                              ? loopExecutionView({
                                  localPending: runningLoopId === loop.id,
                                  latestRunStatus: loop.latestRun?.status,
                                })
                              : null;
                            const busyLoop =
                              loop &&
                              (executionView?.busy ||
                                updatingLoopStatusId === loop.id);
                            return (
                              <div
                                key={item.id}
                                className="rounded-lg border border-border bg-background p-4"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge
                                        variant="secondary"
                                        className={meta.tone}
                                      >
                                        <RemixIcon
                                          name={meta.icon}
                                          size="size-3.5"
                                        />
                                        {isPlatformBug ? "平台 bug" : meta.label}
                                      </Badge>
                                      <span className="text-xs text-muted-foreground">
                                        {item.scope}
                                      </span>
                                    </div>
                                    <h4 className="mt-2 break-words text-sm font-medium text-foreground">
                                      {item.title}
                                    </h4>
                                  </div>
                                  <Badge variant="secondary">
                                    {isPlatformBug
                                      ? "不可由用户处理"
                                      : item.category === "review_observation"
                                        ? "待核查"
                                        : item.severity === "blocking"
                                        ? "阻塞"
                                        : "待确认"}
                                  </Badge>
                                </div>

                                <div className="mt-3 grid gap-2 text-xs leading-5">
                                  <div>
                                    <span className="font-medium text-foreground">
                                      原因：
                                    </span>
                                    <span className="text-muted-foreground">
                                      {attentionUserMessage(item)}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="font-medium text-foreground">
                                      影响：
                                    </span>
                                    <span className="text-muted-foreground">
                                      {attentionImpact(item)}
                                    </span>
                                  </div>
                                  <div className="rounded-md bg-muted/60 p-2 text-muted-foreground [overflow-wrap:anywhere]">
                                    {item.technicalReason}
                                  </div>
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2">
                                  {loop ? (
                                    <>
                                      <Button
                                        size="sm"
                                        className="gap-2"
                                        onClick={() => runWorkshopLoop(loop.id)}
                                        disabled={Boolean(busyLoop)}
                                      >
                                        <RemixIcon
                                          name={
                                            executionView?.busy
                                              ? "loader"
                                              : "refresh"
                                          }
                                          size="size-4"
                                        />
                                        {isPlatformBug ? "重试验证" : "我已处理，重试"}
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="gap-2"
                                        onClick={() =>
                                          setSelectedLoopDetailId(loop.id)
                                        }
                                      >
                                        <RemixIcon
                                          name="file_text"
                                          size="size-4"
                                        />
                                        看详情
                                      </Button>
                                      {item.category === "permission" ? (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="gap-2"
                                            onClick={() =>
                                              setActiveSideTab("review")
                                            }
                                          >
                                            <RemixIcon
                                              name="clipboard_list"
                                              size="size-4"
                                            />
                                            去审核
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="gap-2"
                                            onClick={() => {
                                              setManagementView("boundary");
                                              setActiveSideTab("loops");
                                            }}
                                          >
                                            <RemixIcon
                                              name="shield"
                                              size="size-4"
                                            />
                                            调边界
                                          </Button>
                                        </>
                                      ) : null}
                                      {item.category === "billing" ||
                                      item.category === "credential" ||
                                      item.category === "provider" ? (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="gap-2"
                                          onClick={openWorkshopYamlDialog}
                                        >
                                          <RemixIcon
                                            name="settings"
                                            size="size-4"
                                          />
                                          改模型配置
                                        </Button>
                                      ) : null}
                                      {!isPlatformBug &&
                                      (item.category === "tool_missing" ||
                                        item.category === "schema_invalid" ||
                                        item.category === "missing_config") ? (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="gap-2"
                                            onClick={openWorkshopYamlDialog}
                                          >
                                            <RemixIcon
                                              name="edit"
                                              size="size-4"
                                            />
                                            改配置
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="gap-2"
                                            onClick={() => {
                                              setManagementView("tools");
                                              setActiveSideTab("loops");
                                            }}
                                          >
                                            <RemixIcon
                                              name="blocks"
                                              size="size-4"
                                            />
                                            看工具
                                          </Button>
                                        </>
                                      ) : null}
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="gap-2"
                                        onClick={() =>
                                          updateLoopStatus(loop, "pause")
                                        }
                                        disabled={Boolean(busyLoop)}
                                      >
                                        <RemixIcon
                                          name="pause"
                                          size="size-4"
                                        />
                                        暂停
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="gap-2"
                                        onClick={() => clearLoopBlocker(loop)}
                                        disabled={Boolean(busyLoop)}
                                      >
                                        <RemixIcon
                                          name="check"
                                          size="size-4"
                                        />
                                        暂不处理
                                      </Button>
                                    </>
                                  ) : item.source === "review" ? (
                                    <Button
                                      size="sm"
                                      className="gap-2"
                                      onClick={() => item.reviewId
                                        ? setSelectedReviewId(item.reviewId)
                                        : setActiveSideTab("review")}
                                    >
                                      <RemixIcon
                                        name="clipboard_list"
                                        size="size-4"
                                      />
                                      {item.category === "review_observation" ? "查看评估记录" : "去审核"}
                                    </Button>
                                  ) : (
                                    <>
                                      <Button
                                        size="sm"
                                        className="gap-2"
                                        onClick={() =>
                                          setActiveSideTab("outbox")
                                        }
                                      >
                                        <RemixIcon
                                          name="send_plane"
                                          size="size-4"
                                        />
                                        查看待发
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="gap-2"
                                        onClick={() => {
                                          setManagementView("boundary");
                                          setActiveSideTab("loops");
                                        }}
                                      >
                                        <RemixIcon
                                          name="shield"
                                          size="size-4"
                                        />
                                        调边界
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  ) : null}
                </TabsContent>

                </Tabs>
              </section>
            ) : null}
        </section> : null}
      </div>
    </main>
  );
}
