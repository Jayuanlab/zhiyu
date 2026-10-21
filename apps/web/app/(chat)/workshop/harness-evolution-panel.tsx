"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FlaskConical,
  GitBranch,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type HarnessComponent = {
  key: string;
  componentId?: string;
  id?: string;
  revisionId: string;
  revision: number;
  checksum: string;
  type?: string;
  mutability?: string;
  riskLevel?: string;
  sourceRef?: string;
};

type HarnessSnapshot = {
  snapshotId?: string;
  id?: string;
  workVersionId: string;
  platformVersion: string;
  componentSetHash: string;
  status?: string;
  resolvedAt: string;
  components: HarnessComponent[];
  policySummary?: {
    allowedActions?: string[];
    approvalRequiredActions?: string[];
    deniedActions?: string[];
  };
};

type HarnessResponse = {
  enabled: boolean;
  snapshot: HarnessSnapshot | null;
  candidateSnapshot: HarnessSnapshot | null;
  commandVersion: number;
  memoryPolicy?: {
    identity: { version: string; hash: string };
    bindingStatus: string;
    issues: string[];
    binding: { proposalId?: string } | null;
  };
  summary: {
    evidenceCount: number;
    openProposalCount: number;
    activeCampaignCount: number;
  };
};

type EvidenceItem = {
  bundle: {
    id: string;
    workRunId: string | null;
    loopRunId: string | null;
    completeness: string;
    captureStatus: string;
    createdAt: string;
    runtime: { durationMs: number | null; attemptCount: number };
    actions: { toolCallCount: number; deniedCount: number };
    outcome: { status: string; verifierPassed: boolean | null };
    warnings: string[];
  };
  diagnosis: {
    status: string;
    failureClasses: string[];
    confidence: number;
  } | null;
};

type EvaluationSuite = {
  id: string;
  name: string;
  workRole: string;
  version: number;
  scenarios: Array<{ id: string; name: string; riskTier: string }>;
};

type EvaluationCampaign = {
  id: string;
  suiteId: string;
  status: string;
  changeProposalId: string | null;
  createdAt: string;
  completedAt: string | null;
  summary: Record<string, unknown>;
};

type ProposalStatus =
  | "draft"
  | "proposed"
  | "approved"
  | "canary"
  | "evaluating"
  | "confirmed"
  | "partial"
  | "rejected"
  | "reverted"
  | "superseded";

type HarnessProposal = {
  id: string;
  status: ProposalStatus;
  riskLevel: string;
  failurePattern: string;
  rootCauseHypothesis: string;
  evaluationSuiteId: string;
  changes: Array<{
    componentType: string;
    rationale: string;
    patch?: Record<string, unknown>;
  }>;
  predictedFixes: Array<{ scenarioId: string; metric: string }>;
  predictedRegressions: Array<{ scenarioId: string; metric: string }>;
  createdAt: string;
};

type LegacyHarnessProposal = {
  id: string;
  status: "pending" | "applied" | "rejected" | "superseded";
  reason: string;
  riskLevel: string;
  changedFields: string[];
  proposedBy: string;
  createdAt: string;
  legacyEvidence: true;
};

type EvolutionTab = "harness" | "evidence" | "evaluation" | "proposals";

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "请求失败");
  }
  return data as T;
}

function timeLabel(value: string | null) {
  if (!value) return "未完成";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function statusTone(status: string) {
  if (["confirmed", "passed", "complete", "completed"].includes(status)) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (["rejected", "reverted", "failed"].includes(status)) {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (["partial", "inconclusive", "canary", "evaluating"].includes(status)) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function LoadingRow() {
  return (
    <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      加载中
    </div>
  );
}

export function HarnessEvolutionPanel({ workshopId }: { workshopId: string }) {
  const [activeTab, setActiveTab] = useState<EvolutionTab>("harness");
  const [harness, setHarness] = useState<HarnessResponse | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[] | null>(null);
  const [suites, setSuites] = useState<EvaluationSuite[] | null>(null);
  const [campaigns, setCampaigns] = useState<EvaluationCampaign[] | null>(null);
  const [proposals, setProposals] = useState<HarnessProposal[] | null>(null);
  const [legacyProposals, setLegacyProposals] = useState<
    LegacyHarnessProposal[] | null
  >(null);
  const [loading, setLoading] = useState<EvolutionTab | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memorySuiteId, setMemorySuiteId] = useState("");
  const [memoryCandidateResult, setMemoryCandidateResult] = useState<string | null>(null);
  const memoryCommands = useRef(new Map<string, Record<string, unknown>>());

  useEffect(() => {
    setActiveTab("harness");
    setHarness(null);
    setEvidence(null);
    setSuites(null);
    setCampaigns(null);
    setProposals(null);
    setLegacyProposals(null);
    setLoading(null);
    setActionId(null);
    setError(null);
    memoryCommands.current.clear();
    setMemorySuiteId("");
    setMemoryCandidateResult(null);
  }, [workshopId]);

  const loadHarness = useCallback(
    async (refresh = false) => {
      setLoading("harness");
      try {
        setHarness(
          await readJson<HarnessResponse>(
            `/api/workshops/${workshopId}/harness?refresh=${refresh ? "true" : "false"}`,
          ),
        );
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(null);
      }
    },
    [workshopId],
  );

  const loadEvidence = useCallback(async () => {
    setLoading("evidence");
    try {
      const data = await readJson<{ evidence: EvidenceItem[] }>(
        `/api/workshops/${workshopId}/harness/evidence?limit=50`,
      );
      setEvidence(data.evidence);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [workshopId]);

  const loadEvaluation = useCallback(async () => {
    setLoading("evaluation");
    try {
      const [suiteData, campaignData] = await Promise.all([
        readJson<{ suites: EvaluationSuite[] }>(
          `/api/workshops/${workshopId}/harness/evaluation-suites`,
        ),
        readJson<{ campaigns: EvaluationCampaign[] }>(
          `/api/workshops/${workshopId}/harness/evaluation-campaigns?limit=30`,
        ),
      ]);
      setSuites(suiteData.suites);
      setCampaigns(campaignData.campaigns);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [workshopId]);

  const loadProposals = useCallback(async () => {
    setLoading("proposals");
    try {
      const data = await readJson<{
        proposals: HarnessProposal[];
        legacyProposals: LegacyHarnessProposal[];
      }>(`/api/workshops/${workshopId}/harness/proposals?limit=30`);
      setProposals(data.proposals);
      setLegacyProposals(data.legacyProposals);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [workshopId]);

  useEffect(() => {
    if (activeTab === "harness" && !harness) void loadHarness(false);
    if (activeTab === "evidence") {
      if (!evidence) void loadEvidence();
      if (!suites) void loadEvaluation();
    }
    if (activeTab === "evaluation" && (!suites || !campaigns)) {
      void loadEvaluation();
    }
    if (activeTab === "proposals") {
      if (!proposals) void loadProposals();
      if (!campaigns) void loadEvaluation();
      if (!harness) void loadHarness(false);
    }
  }, [
    activeTab,
    campaigns,
    evidence,
    harness,
    loadEvaluation,
    loadEvidence,
    loadHarness,
    loadProposals,
    proposals,
    suites,
  ]);

  const proposalAction = useCallback(
    async (proposal: HarnessProposal, action: string) => {
      setActionId(proposal.id);
      try {
        const isMemoryCommand = action === "activate_memory_policy" || action === "rollback_memory_policy";
        let body: Record<string, unknown> = { action };
        const commandKey = `${proposal.id}:${action}`;
        if (isMemoryCommand) {
          const previous = memoryCommands.current.get(commandKey);
          if (previous) body = previous;
          else {
            const current = await readJson<HarnessResponse>(`/api/workshops/${workshopId}/harness?refresh=false`);
            const campaign = campaigns?.find(item => item.changeProposalId === proposal.id
              && item.status === "passed" && item.summary.evaluatorKind === "isolated-memory-model/v1");
            if (action === "activate_memory_policy" && !campaign) throw new Error("需要先通过真实模型留出评测，才能应用记忆策略。");
            body = { action, expectedVersion: current.commandVersion, commandId: crypto.randomUUID(),
              ...(campaign ? { campaignId: campaign.id } : {}) };
            memoryCommands.current.set(commandKey, body);
          }
        }
        await readJson(
          `/api/workshops/${workshopId}/harness/proposals/${proposal.id}`,
          { method: "POST", body: JSON.stringify(body) },
        );
        memoryCommands.current.delete(commandKey);
        await Promise.all([
          loadProposals(),
          loadHarness(false),
          action === "begin_evaluation" ? loadEvaluation() : Promise.resolve(),
        ]);
        setError(null);
      } catch (cause) {
        // These preflight failures precede updateWork. Unknown network results retain their command for replay.
        const message = cause instanceof Error ? cause.message : String(cause);
        if (["The loaded memory policy or command version changed concurrently.", "Memory rollback owner or version differs.", "version_conflict"].includes(message)) {
          memoryCommands.current.delete(`${proposal.id}:${action}`);
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setActionId(null);
      }
    },
    [campaigns, loadEvaluation, loadHarness, loadProposals, workshopId],
  );

  const snapshot = harness?.snapshot ?? null;
  const proposeMemoryCandidate = async (evidenceBundleId: string) => {
    const suite = suites?.find(item => item.id === memorySuiteId);
    if (!suite) return;
    const developmentScenarioIds = suite.scenarios.filter(item => item.riskTier !== "holdout").map(item => item.id).slice(0, 20);
    setActionId(evidenceBundleId);
    try {
      const result = await readJson<{ proposals: HarnessProposal[]; diagnosis: { causes?: unknown[] } }>(
        `/api/workshops/${workshopId}/harness/memory-candidates`,
        { method: "POST", body: JSON.stringify({ evidenceBundleId, evaluationSuiteId: suite.id, developmentScenarioIds }) },
      );
      setMemoryCandidateResult(result.proposals.length ? `已生成 ${result.proposals.length} 个待审记忆策略候选。请到变更页审核。` : "这份运行证据未支持需要修改的记忆策略，未生成候选。");
      await Promise.all([loadProposals(), loadHarness(false)]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setActionId(null); }
  };
  const compactHash = snapshot?.componentSetHash.slice(0, 10) ?? "-";
  const deniedCount = snapshot?.policySummary?.deniedActions?.length ?? 0;
  const summaryItems = useMemo(
    () => [
      ["组件", snapshot?.components.length ?? 0],
      ["证据", harness?.summary.evidenceCount ?? 0],
      ["待审变更", harness?.summary.openProposalCount ?? 0],
      ["评测中", harness?.summary.activeCampaignCount ?? 0],
    ],
    [harness, snapshot],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b px-1 pb-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="min-w-28">
            <p className="text-xs text-muted-foreground">当前版本</p>
            <p className="mt-0.5 font-mono text-sm">{compactHash}</p>
          </div>
          {summaryItems.map(([label, value]) => (
            <div key={String(label)} className="min-w-16">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-0.5 text-sm font-medium tabular-nums">{value}</p>
            </div>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <Badge
              variant="outline"
              className={statusTone(harness?.enabled ? "confirmed" : "paused")}
            >
              {harness?.enabled ? "采集中" : "未启用"}
            </Badge>
            <Button
              aria-label="刷新演化状态"
              disabled={loading !== null}
              onClick={() => {
                if (activeTab === "harness") void loadHarness(true);
                if (activeTab === "evidence") void loadEvidence();
                if (activeTab === "evaluation") void loadEvaluation();
                if (activeTab === "proposals") void loadProposals();
              }}
              size="icon"
              title="刷新"
              variant="ghost"
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </div>
      {harness?.memoryPolicy ? <div className="border-b py-3 text-xs leading-6 text-muted-foreground">
        <p>记忆策略：{harness.memoryPolicy.identity.version} · {harness.memoryPolicy.identity.hash.slice(0, 12)}</p>
        <p>{harness.memoryPolicy.issues.length ? `策略未装载：${harness.memoryPolicy.issues.join("、")}`
          : harness.memoryPolicy.bindingStatus === "active" ? "已应用到车间配置；后续新运行会记录实际装载版本。" : "使用内置策略。候选须通过真实模型留出评测后由主人应用。"}</p>
      </div> : null}

      {error ? (
        <div className="mt-3 flex items-start gap-2 border-l-2 border-destructive px-3 py-2 text-sm text-destructive">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}

      <Tabs
        className="mt-3 flex min-h-0 flex-1 flex-col"
        onValueChange={(value) => setActiveTab(value as EvolutionTab)}
        value={activeTab}
      >
        <TabsList className="h-9 w-full justify-start overflow-x-auto">
          <TabsTrigger value="harness">支架</TabsTrigger>
          <TabsTrigger value="evidence">证据</TabsTrigger>
          <TabsTrigger value="evaluation">评测</TabsTrigger>
          <TabsTrigger value="proposals">变更</TabsTrigger>
        </TabsList>

        <TabsContent
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          value="harness"
        >
          {loading === "harness" && !harness ? <LoadingRow /> : null}
          {!loading && !snapshot ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              暂无 Harness 快照
            </p>
          ) : null}
          {snapshot ? (
            <div className="divide-y">
              <div className="grid grid-cols-2 gap-3 py-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Work Version</p>
                  <p className="mt-1 break-all font-mono text-xs">
                    {snapshot.workVersionId}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Platform</p>
                  <p className="mt-1 break-all font-mono text-xs">
                    {snapshot.platformVersion}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">拒绝动作</p>
                  <p className="mt-1 text-sm tabular-nums">{deniedCount}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">解析时间</p>
                  <p className="mt-1 text-sm">
                    {timeLabel(snapshot.resolvedAt)}
                  </p>
                </div>
              </div>
              {harness?.candidateSnapshot ? (
                <div className="flex items-center gap-2 py-3 text-sm">
                  <GitBranch className="size-4 text-amber-600" />
                  <span>隔离候选</span>
                  <code className="text-xs text-muted-foreground">
                    {harness.candidateSnapshot.componentSetHash.slice(0, 10)}
                  </code>
                </div>
              ) : null}
              <div className="divide-y">
                {snapshot.components.map((component) => (
                  <div
                    className="py-3"
                    key={`${component.key}:${component.revisionId}`}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-all text-sm font-medium">
                          {component.key}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          r{component.revision} ·{" "}
                          {component.checksum.slice(0, 10)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        {component.type ? (
                          <Badge variant="outline">{component.type}</Badge>
                        ) : null}
                        {component.riskLevel ? (
                          <Badge
                            className={statusTone(component.riskLevel)}
                            variant="outline"
                          >
                            {component.riskLevel}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </TabsContent>

        <TabsContent
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          value="evidence"
        >
          {suites?.length ? <div className="border-b py-3 text-xs leading-6">
            <label htmlFor={`memory-suite-${workshopId}`}>记忆策略候选的评测集</label>
            <select id={`memory-suite-${workshopId}`} className="ml-3 max-w-72 rounded border bg-background px-2 py-1"
              value={memorySuiteId} onChange={event => setMemorySuiteId(event.target.value)}>
              <option value="">请选择评测集</option>
              {suites.filter(suite => suite.scenarios.some(item => item.riskTier !== "holdout")).map(suite =>
                <option key={suite.id} value={suite.id}>{suite.name}</option>)}
            </select>
            <p className="text-muted-foreground">只用开发场景提出候选；留出场景不参与改写。候选不会触发模型评测或自动上线。</p>
            {memoryCandidateResult ? <p role="status">{memoryCandidateResult}</p> : null}
          </div> : null}
          {loading === "evidence" && !evidence ? <LoadingRow /> : null}
          {evidence?.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              暂无运行证据
            </p>
          ) : null}
          <div className="divide-y">
            {evidence?.map((item) => (
              <div className="py-3" key={item.bundle.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        className={statusTone(item.bundle.completeness)}
                        variant="outline"
                      >
                        {item.bundle.completeness}
                      </Badge>
                      <span className="text-sm font-medium">
                        {item.bundle.outcome.status}
                      </span>
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {item.bundle.loopRunId ??
                        item.bundle.workRunId ??
                        item.bundle.id}
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {timeLabel(item.bundle.createdAt)}
                  </time>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{item.bundle.runtime.durationMs ?? 0} ms</span>
                  <span>{item.bundle.actions.toolCallCount} 次工具调用</span>
                  <span>{item.bundle.actions.deniedCount} 次边界拒绝</span>
                  {item.bundle.captureStatus === "finalized" ? <Button size="sm" variant="outline"
                    disabled={!memorySuiteId || actionId !== null} onClick={() => void proposeMemoryCandidate(item.bundle.id)}>
                    {actionId === item.bundle.id ? "诊断中" : "提出记忆策略候选"}
                  </Button> : null}
                </div>
                {item.diagnosis?.failureClasses.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {item.diagnosis.failureClasses.map((failure) => (
                      <Badge key={failure} variant="secondary">
                        {failure}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          value="evaluation"
        >
          {loading === "evaluation" && (!suites || !campaigns) ? (
            <LoadingRow />
          ) : null}
          <div className="divide-y">
            {suites?.map((suite) => (
              <div className="py-3" key={suite.id}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">
                      {suite.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {suite.workRole} · v{suite.version}
                    </p>
                  </div>
                  <Badge variant="outline">{suite.scenarios.length} 场景</Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {suite.scenarios.map((scenario) => (
                    <Badge key={scenario.id} variant="secondary">
                      {scenario.name}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t pt-3">
            <h4 className="text-sm font-medium">评测批次</h4>
            {campaigns?.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                暂无评测批次
              </p>
            ) : null}
            <div className="divide-y">
              {campaigns?.map((campaign) => (
                <div className="flex items-center gap-3 py-3" key={campaign.id}>
                  <FlaskConical className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-mono text-xs">{campaign.id}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {timeLabel(campaign.createdAt)}
                    </p>
                  </div>
                  <Badge
                    className={statusTone(campaign.status)}
                    variant="outline"
                  >
                    {campaign.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          value="proposals"
        >
          {loading === "proposals" && !proposals ? <LoadingRow /> : null}
          {proposals?.length === 0 && legacyProposals?.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              暂无 Harness 变更
            </p>
          ) : null}
          {legacyProposals && legacyProposals.length > 0 ? (
            <div className="border-b pb-3">
              <div className="flex items-center justify-between py-2">
                <p className="text-sm font-medium">历史 v1 提案</p>
                <Badge variant="outline">legacyEvidence</Badge>
              </div>
              <div className="divide-y">
                {legacyProposals.map((proposal) => (
                  <div className="py-3" key={proposal.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm">{proposal.reason}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {proposal.changedFields.join(" · ") || "Work 配置"}
                          {" · "}
                          {timeLabel(proposal.createdAt)}
                        </p>
                      </div>
                      <Badge
                        className={statusTone(proposal.status)}
                        variant="outline"
                      >
                        {proposal.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
              <p className="py-2 text-xs text-muted-foreground">
                历史提案仍按原有审核流程处理，不会转为新候选版本。
              </p>
            </div>
          ) : null}
          <div className="divide-y">
            {proposals?.map((proposal) => {
              const busy = actionId === proposal.id;
              const memoryChange = proposal.changes.some(change => change.patch?.memoryUsageContract !== undefined);
              const passedMemoryCampaign = campaigns?.some(campaign => campaign.changeProposalId === proposal.id
                && campaign.status === "passed" && campaign.summary.evaluatorKind === "isolated-memory-model/v1");
              const activeMemoryProposal = harness?.memoryPolicy?.bindingStatus === "active"
                && harness.memoryPolicy.binding?.proposalId === proposal.id;
              return (
                <div className="py-4" key={proposal.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">
                        {proposal.failurePattern}
                      </p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        {proposal.rootCauseHypothesis}
                      </p>
                    </div>
                    <Badge
                      className={statusTone(proposal.status)}
                      variant="outline"
                    >
                      {proposal.status}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {proposal.changes.map((change, index) => (
                      <Badge
                        key={`${change.componentType}:${index}`}
                        variant="secondary"
                      >
                        {change.componentType}
                      </Badge>
                    ))}
                    <Badge variant="outline">{proposal.riskLevel}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {memoryChange && proposal.status === "confirmed" && !activeMemoryProposal ? <Button
                      disabled={busy || !passedMemoryCampaign}
                      onClick={() => void proposalAction(proposal, "activate_memory_policy")}
                      size="sm" title={passedMemoryCampaign ? "应用通过留出评测的策略" : "等待真实模型留出评测"}>
                      应用记忆策略
                    </Button> : null}
                    {activeMemoryProposal ? <Button disabled={busy}
                      onClick={() => void proposalAction(proposal, "rollback_memory_policy")} size="sm" variant="outline">
                      回滚记忆策略
                    </Button> : null}
                    {proposal.status === "proposed" ? (
                      <>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void proposalAction(proposal, "reject")
                          }
                          size="sm"
                          variant="ghost"
                        >
                          <XCircle className="mr-1.5 size-4" />
                          驳回
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void proposalAction(proposal, "approve")
                          }
                          size="sm"
                        >
                          <CheckCircle2 className="mr-1.5 size-4" />
                          批准
                        </Button>
                      </>
                    ) : null}
                    {proposal.status === "approved" ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void proposalAction(proposal, "materialize_candidate")
                        }
                        size="sm"
                      >
                        <GitBranch className="mr-1.5 size-4" />
                        生成候选
                      </Button>
                    ) : null}
                    {proposal.status === "canary" && !memoryChange ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void proposalAction(proposal, "begin_evaluation")
                        }
                        size="sm"
                      >
                        <FlaskConical className="mr-1.5 size-4" />
                        进入评测
                      </Button>
                    ) : null}
                    {proposal.status === "canary" && memoryChange ? <p className="text-xs text-muted-foreground">
                      记忆候选需先冻结来源并接入真实模型评测执行器；普通回放不能确认它的效果。
                    </p> : null}
                    {["canary", "evaluating", "confirmed", "partial"].includes(
                      proposal.status,
                    ) ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void proposalAction(proposal, "discard_candidate")
                        }
                        size="sm"
                        variant="outline"
                      >
                        <RotateCcw className="mr-1.5 size-4" />
                        废弃候选
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
