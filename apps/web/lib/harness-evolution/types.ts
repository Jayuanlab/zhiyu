export const HARNESS_COMPONENT_TYPES = [
  "prompt",
  "skill",
  "tool_contract",
  "tool_implementation",
  "middleware_policy",
  "loop_spec",
  "memory_profile",
  "verifier",
  "context_policy",
  "artifact_policy",
] as const;

export type HarnessComponentType = (typeof HARNESS_COMPONENT_TYPES)[number];

export type HarnessComponentScope = {
  type: "platform" | "user" | "work";
  id: string | null;
};

export type HarnessComponentOwner = "platform" | "owner" | "work";

export type HarnessComponentMutability =
  | "observe_only"
  | "proposal_only"
  | "owner_editable"
  | "system_protected";

export type HarnessRiskLevel = "low" | "medium" | "high" | "protected";

export type HarnessComponentSourceKind =
  | "database"
  | "file"
  | "code_registry"
  | "derived";

export interface HarnessComponentDefinition {
  key: string;
  type: HarnessComponentType;
  scope: HarnessComponentScope;
  owner: HarnessComponentOwner;
  mutability: HarnessComponentMutability;
  riskLevel: HarnessRiskLevel;
  sourceKind: HarnessComponentSourceKind;
  sourceRef: string;
  sourceVersion: string;
  content: Record<string, unknown>;
}

export interface HarnessComponentSnapshot extends HarnessComponentDefinition {
  id: string;
  revisionId: string;
  revision: number;
  checksum: string;
}

export interface WorkHarnessSnapshot {
  interfaceVersion: "work-harness.v1";
  snapshotId: string;
  workId: string;
  workVersionId: string;
  workVersion: string;
  platformVersion: string;
  componentSetHash: string;
  modelRuntime: {
    provider: string | null;
    model: string | null;
    reasoningLevel: string | null;
  };
  components: HarnessComponentSnapshot[];
  policySummary: {
    allowedActions: string[];
    approvalRequiredActions: string[];
    deniedActions: string[];
    protectedComponentIds: string[];
  };
  resolvedAt: string;
}

export interface AssembleWorkHarnessSnapshotInput {
  workId: string;
  workVersionId: string;
  workVersion: string;
  platformVersion: string;
  modelRuntime: WorkHarnessSnapshot["modelRuntime"];
  components: readonly HarnessComponentDefinition[];
  policy: {
    allowedActions: readonly string[];
    approvalRequiredActions: readonly string[];
    deniedActions: readonly string[];
  };
  resolvedAt?: string;
}

export type EvidenceRefKind =
  | "workshop_event"
  | "workshop_run"
  | "loop_run"
  | "brain_context_log"
  | "memory"
  | "tool_result"
  | "owner_feedback"
  | "artifact";

export interface EvidenceRef {
  kind: EvidenceRefKind;
  id: string;
  claim: string;
  observedAt: string | null;
  freshness: "fresh" | "stale" | "unknown";
  integrity: "verified" | "unverified" | "missing";
}

export interface RunEvidenceBundle {
  interfaceVersion: "run-evidence.v1";
  id: string;
  userId: string;
  workId: string;
  workRunId: string | null;
  loopId: string | null;
  loopRunId: string | null;
  workVersionId: string;
  harnessSnapshotId: string;
  componentSetHash: string;
  runtime: {
    model: string | null;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    tokenUsage: Record<string, number>;
    tokenUsageStatus?: "reported" | "unknown";
    attemptCount: number;
  };
  observations: {
    sourceEventIds: string[];
    freshness: "fresh" | "stale" | "unknown";
    providerWarnings: string[];
  };
  actions: {
    toolCallCount: number;
    toolNames: string[];
    deniedCount: number;
    approvalCount: number;
    externalActionCount: number;
  };
  outcome: {
    status: string;
    verifierPassed: boolean | null;
    requiredFieldsMissing: string[];
    artifacts: Array<{ type: string; id: string }>;
    errorClass: string | null;
  };
  evidenceRefs: EvidenceRef[];
  captureStatus: "capturing" | "finalized" | "partial";
  completeness: "complete" | "partial" | "insufficient";
  warnings: string[];
  createdAt: string;
}

export type BuildRunEvidenceBundleInput = Omit<
  RunEvidenceBundle,
  "interfaceVersion" | "completeness" | "warnings"
>;

export interface RunHarnessCaptureContext {
  interfaceVersion: "run-harness-context.v1";
  workId: string;
  workVersionId: string;
  harnessSnapshotId: string;
  componentSetHash: string;
  model: string | null;
  capturedAt: string;
}

export interface CapturedRunEventFact {
  id: string;
  type: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CapturedContextLogFact {
  id: string;
  selectedMemoryIds: string[];
  deniedCount: number;
  createdAt: string;
}

export interface BuildCapturedRunEvidenceInput {
  id?: string;
  userId: string;
  workId: string;
  workRunId: string | null;
  loopId: string | null;
  loopRunId: string | null;
  context: RunHarnessCaptureContext;
  status: string;
  startedAt: string;
  completedAt: string | null;
  outputSummary: string | null;
  error: string | null;
  verificationResult?: Record<string, unknown> | null;
  events: CapturedRunEventFact[];
  /** False when bounded event capture omitted part of the run. */
  eventsComplete?: boolean;
  contextLogs: CapturedContextLogFact[];
  captureWarnings?: string[];
  /** Actual provider/SDK receipt only; never estimated from text length. */
  tokenUsage?: Record<string, number> | null;
  createdAt?: string;
}

export type RunFailureClass =
  | "data_missing"
  | "data_stale"
  | "access_denied_expected"
  | "access_grant_gap_confirmed"
  | "tool_contract_mismatch"
  | "tool_runtime_failure"
  | "tool_retry_loop"
  | "context_overflow"
  | "memory_missing"
  | "memory_irrelevant"
  | "memory_stale"
  | "planning_failure"
  | "boundary_blocked_expected"
  | "boundary_policy_defect"
  | "verification_failure"
  | "artifact_missing"
  | "external_dependency_failure"
  | "user_goal_ambiguous"
  | "insufficient_evidence";

export interface RunEvidenceDiagnosis {
  interfaceVersion: "run-diagnosis.v1";
  evidenceBundleId: string;
  status: "completed" | "inconclusive";
  failureClasses: RunFailureClass[];
  symptoms: string[];
  rootCauseCandidates: string[];
  targetComponentTypes: HarnessComponentType[];
  confidence: number;
  evidenceRefs: EvidenceRef[];
}

export interface HarnessEvaluationRunResult {
  scenarioId: string;
  cohort: "baseline" | "candidate";
  repetition: number;
  status: "success" | "failed" | "blocked" | "timeout";
  metrics: Record<string, number>;
  hardInvariantFailures: string[];
}

export interface HarnessEvaluationResult {
  interfaceVersion: "harness-evaluation.v1";
  status: "passed" | "rejected" | "inconclusive";
  recommendedAction: "keep" | "rollback" | "collect_more_data";
  fixedScenarios: string[];
  regressedScenarios: string[];
  hardInvariantFailures: Array<{
    scenarioId: string;
    failures: string[];
  }>;
  comparisons: Array<{
    scenarioId: string;
    baseline: Record<string, number>;
    candidate: Record<string, number>;
    delta: Record<string, number>;
    sampleSize: { baseline: number; candidate: number };
  }>;
  warnings: string[];
}

export type HarnessEvaluationMode =
  | "deterministic_replay"
  | "dry_run"
  | "simulation"
  | "shadow"
  | "manual";

export interface HarnessEvaluationScenarioDefinition {
  scenarioKey: string;
  name: string;
  mode: HarnessEvaluationMode;
  tags: string[];
  riskTier: "normal" | "boundary" | "holdout";
  fixtureRef: string;
  preconditions: Record<string, unknown>;
  taskIntent: string;
  expectedArtifacts: string[];
  hardInvariants: string[];
  forbiddenActions: string[];
  metrics: string[];
  repetitions: number;
  timeoutMs: number;
  status: "active" | "paused";
}

export interface HarnessEvaluationSuiteDefinition {
  ownerType: "system" | "user";
  workRole: string;
  name: string;
  version: number;
  status: "draft" | "active" | "archived";
  metricPolicy: Record<string, unknown>;
  holdoutPolicy: Record<string, unknown>;
  scenarios: HarnessEvaluationScenarioDefinition[];
}

export interface HarnessEvaluationExecutionResult {
  status: HarnessEvaluationRunResult["status"];
  metrics: Record<string, number>;
  actions: string[];
  hardInvariantFailures?: string[];
  evidenceBundleId?: string | null;
  usageStatus?: "reported" | "unknown";
  warnings?: string[];
}

export interface HarnessEvaluationExecutionRequest {
  scenario: HarnessEvaluationScenarioDefinition;
  cohort: "baseline" | "candidate";
  repetition: number;
  runtimeContract: Record<string, unknown>;
  allowExternalActions: false;
  allowRealFunds: false;
  allowDestructiveActions: false;
  signal?: AbortSignal;
}

export interface PersistedHarnessEvaluationScenario extends HarnessEvaluationScenarioDefinition {
  id: string;
  suiteId: string;
}

export interface PersistedHarnessEvaluationSuite extends Omit<
  HarnessEvaluationSuiteDefinition,
  "scenarios"
> {
  id: string;
  userId: string | null;
  scenarios: PersistedHarnessEvaluationScenario[];
  createdAt: string;
  updatedAt: string;
}

export interface HarnessEvaluationCampaign {
  id: string;
  workshopId: string;
  suiteId: string;
  baselineWorkVersionId: string;
  candidateWorkVersionId: string | null;
  baselineHarnessSnapshotId: string;
  candidateHarnessSnapshotId: string;
  changeProposalId: string | null;
  status: string;
  runtimeContract: Record<string, unknown>;
  budget: Record<string, unknown>;
  summary: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateHarnessEvaluationCampaignInput extends Omit<
  HarnessEvaluationCampaign,
  "id" | "status" | "summary" | "startedAt" | "completedAt" | "createdAt"
> {
  id?: string;
}

export interface PersistHarnessEvaluationRunInput {
  id?: string;
  campaignId: string;
  scenarioId: string;
  cohort: "baseline" | "candidate";
  repetition: number;
  status: HarnessEvaluationRunResult["status"] | "pending" | "running";
  score: number | null;
  metrics: Record<string, number>;
  evidenceBundleId: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type HarnessProposalStatus =
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

export interface HarnessChangePrediction {
  scenarioId: string;
  expectedDirection: "improve" | "unchanged" | "regress";
  metric: string;
  threshold: number | string;
  rationale: string;
}

export interface HarnessMetricExpectation {
  scenarioId: string;
  metric: string;
  operator: ">" | ">=" | "=" | "<=" | "<" | "no_regression";
  target: number | string;
  severity: "objective" | "guardrail" | "cost";
}

export interface HarnessRollbackPlan {
  strategy: "restore_component_revision" | "restore_work_version";
  targetRevisionIds: string[];
  triggerConditions: string[];
  verificationScenarioIds: string[];
  ownerApprovalRequired: boolean;
}

export interface HarnessChangeItemInput {
  componentId: string;
  componentType: HarnessComponentType;
  beforeRevisionId: string;
  afterRevisionId?: string | null;
  componentMutability: HarnessComponentMutability;
  componentRiskLevel: HarnessRiskLevel;
  patch: Record<string, unknown>;
  rationale: string;
  groupKey?: string | null;
}

export interface CreateHarnessChangeProposalInput {
  id?: string;
  workId: string;
  scope: "work" | "platform";
  affectedWorkIds: string[];
  baseWorkVersionId: string;
  baseHarnessSnapshotId: string;
  baseComponentSetHash: string;
  proposedBy: "owner" | "chat_agent" | "workshop_agent" | "quality_work";
  riskLevel: HarnessRiskLevel;
  failurePattern: string;
  evidenceRefs: EvidenceRef[];
  rootCauseHypothesis: string;
  changes: HarnessChangeItemInput[];
  predictedFixes: HarnessChangePrediction[];
  predictedRegressions: HarnessChangePrediction[];
  successMetrics: HarnessMetricExpectation[];
  evaluationSuiteId: string;
  evaluationScenarioIds: string[];
  evaluationWindow: Record<string, unknown>;
  rollbackPlan: HarnessRollbackPlan;
  attributionLimited: boolean;
  expiresAt?: string | null;
  createdAt?: string;
}

export interface HarnessChangeProposalV2 extends Omit<
  CreateHarnessChangeProposalInput,
  "id" | "createdAt"
> {
  interfaceVersion: "harness-change-proposal.v2";
  id: string;
  status: HarnessProposalStatus;
  createdAt: string;
  updatedAt: string;
}

export type HarnessPredictionOutcomeStatus =
  | "confirmed"
  | "refuted"
  | "unresolved";

export interface HarnessPredictionOutcome {
  predictionType: "fix" | "regression_guard";
  prediction: HarnessChangePrediction;
  status: HarnessPredictionOutcomeStatus;
  actualDelta: number | null;
  reason: string;
}

export interface HarnessEvolutionVerdict {
  interfaceVersion: "harness-evolution-verdict.v1";
  id: string;
  proposalId: string;
  evaluationCampaignId: string;
  status: "confirmed" | "partial" | "rejected" | "inconclusive";
  recommendedAction: "keep" | "revise" | "rollback" | "collect_more_data";
  predictionAccuracy: number | null;
  confirmedPredictions: HarnessPredictionOutcome[];
  refutedPredictions: HarnessPredictionOutcome[];
  unresolvedPredictions: HarnessPredictionOutcome[];
  fixedScenarios: string[];
  regressedScenarios: string[];
  hardInvariantFailures: HarnessEvaluationResult["hardInvariantFailures"];
  attributionLimited: boolean;
  summary: string;
  createdAt: string;
}
