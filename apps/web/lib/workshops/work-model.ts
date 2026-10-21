import type { Loop, Workshop, WorkshopHeartbeat } from "@/lib/db/schema";
import type { AgentToolMatrix } from "@/lib/agent-tools/types";
import { resolveWorkshopAgentRuntime } from "@/lib/ai/model-policy";
import type { BrainRecallProfile } from "@/lib/memory/context/pack";
import { parseBrainRecallProfilesFromModelConfig } from "@/lib/memory/retrieval/recall-profiles";
import {
  resolveWorkshopRuntimeWithPiGreyDefault,
  type WorkshopPiRuntimeGreyReadiness,
} from "./pi-runtime-readiness";

export type WorkRiskLevel = "low" | "medium" | "high";

export type WorkSkillBindingStatus = "bound" | "missing" | "unmapped";

export interface WorkshopWorkManifest {
  id: string;
  name: string;
  role: string;
  mission: string;
  status: string;
  autonomyLevel: string;
  version: string;
  updatedAt: string;
}

export interface WorkshopWorkControlContract {
  controlledObjects: string[];
  observations: string[];
  allowedActions: string[];
  approvalRequiredActions: string[];
  deniedActions: string[];
  boundaryMode: string;
  externalMessagePolicy: string;
  feedbackSignals: string[];
  conflicts: Array<{
    kind: "allowed_and_denied";
    tool: string;
  }>;
}

export interface WorkshopWorkSkillBindings {
  primarySkills: string[];
  loopSkillMap: Record<string, string>;
  availableSkills: string[];
  missingSkills: string[];
}

export interface WorkshopWorkLoopBinding {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  nextScheduledRunAt: string | null;
  requiredFields: string[];
  skillName: string | null;
  skillStatus: WorkSkillBindingStatus;
  hasActionPolicy: boolean;
  hasVerification: boolean;
}

export interface WorkshopWorkMemoryPolicy {
  defaultReadableKinds: string[];
  evidenceRequiredForHighImpact: boolean;
  writeReusableFindingsToMemory: boolean;
  recallProfiles: BrainRecallProfile[];
}

export interface WorkshopWorkArtifactPolicy {
  eventTypes: string[];
  proposalTypes: string[];
  outboxEnabled: boolean;
}

/** Shared owner-facing report contract; the Work may refine content, not status authority. */
export interface WorkshopWorkPresentationContract {
  audience: "owner";
  reportFormat: "markdown";
  purpose: string;
  requiredSections: string[];
  expectedArtifacts: string[];
  evidenceSource: "run_events";
  artifactSource: "run_receipts";
  statusSource: "run_lifecycle";
  source: "manifest" | "default";
}

export interface WorkshopWorkFeedback {
  nextWakeupAt: string | null;
  heartbeatStatus: string | null;
  pendingReviewSurfaces: string[];
  feedbackSignals: string[];
}

export interface WorkshopWorkObservability {
  missing: string[];
  warnings: string[];
}

export interface WorkshopWorkRuntime {
  engine: "claude" | "pi";
  source: "config" | "env" | "default";
  piGreyReadiness: WorkshopPiRuntimeGreyReadiness;
}

export interface WorkshopWorkChangeControl {
  proposalSurface: "workshop_review_tab";
  highRiskChanges: string[];
  mediumRiskChanges: string[];
  lowRiskChanges: string[];
}

export interface WorkshopWorkModel {
  manifest: WorkshopWorkManifest;
  controlContract: WorkshopWorkControlContract;
  skillBindings: WorkshopWorkSkillBindings;
  loopBindings: WorkshopWorkLoopBinding[];
  memoryPolicy: WorkshopWorkMemoryPolicy;
  artifactPolicy: WorkshopWorkArtifactPolicy;
  presentationContract: WorkshopWorkPresentationContract;
  feedback: WorkshopWorkFeedback;
  observability: WorkshopWorkObservability;
  runtime: WorkshopWorkRuntime;
  changeControl: WorkshopWorkChangeControl;
}

export interface BuildWorkshopWorkModelInput {
  workshop: Workshop;
  loops: Loop[];
  toolMatrix: AgentToolMatrix;
  availableSkillNames: string[];
  heartbeat?: WorkshopHeartbeat | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function isoTime(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function roleControlledObjects(role: string) {
  if (role === "paper_trader") {
    return ["paper_account", "paper_positions", "current_watchlist"];
  }
  if (role === "watchlist_selector") {
    return [
      "market_candidate_pool",
      "core_watchlist_pool",
      "trading_watchlist_pool",
      "holding_watchlist_pool",
      "watchlist_change_events",
    ];
  }
  if (role === "owner_context_steward") {
    return ["owner_context_candidates", "owner_memory", "owner_wiki"];
  }
  if (role === "investment_publisher") {
    return ["investment_video_drafts", "douyin_publish_drafts"];
  }
  return ["workshop_runtime_state"];
}

function roleFeedbackSignals(role: string) {
  if (role === "paper_trader") {
    return [
      "paper_order_result",
      "paper_fill_result",
      "realized_pnl",
      "unrealized_pnl",
      "post_market_review",
      "strategy_memory",
    ];
  }
  if (role === "watchlist_selector") {
    return [
      "candidate_pool_growth",
      "active_watchlist_change_result",
      "candidate_followup_performance",
      "data_source_quality",
      "paper_trader_usage",
    ];
  }
  return [
    "loop_verification_result",
    "owner_review_result",
    "memory_update",
    "tool_failure",
  ];
}

function toolNamesByAvailability(
  matrix: AgentToolMatrix,
  availability: "allow" | "require_approval" | "deny",
) {
  return matrix.tools
    .filter((tool) => tool.availability === availability)
    .map((tool) => tool.name);
}

function observationTools(matrix: AgentToolMatrix) {
  const observationCapabilities = new Set([
    "file_read",
    "web_read",
    "memory_read",
    "knowledge_read",
    "message_read",
    "market_data",
    "time",
  ]);
  return matrix.tools
    .filter(
      (tool) =>
        tool.availability !== "deny" &&
        tool.capabilities.some((capability) =>
          observationCapabilities.has(capability),
        ),
    )
    .map((tool) => tool.name);
}

function requiredFields(loop: Loop) {
  return stringArray(asRecord(loop.verificationConfig).requiredFields);
}

function hasMeaningfulPolicy(value: unknown) {
  return Object.keys(asRecord(value)).length > 0;
}

function loopTemplateId(loop: Loop) {
  return stringValue(asRecord(asRecord(loop.triggerConfig).metadata).templateId);
}

function isSystemGovernanceLoop(loop: Loop) {
  return (
    loopTemplateId(loop) === "work-self-audit" ||
    loop.name === "Work 自检升级" ||
    /work\s+self-audit/i.test(loop.goal)
  );
}

export function buildWorkshopWorkModel(
  input: BuildWorkshopWorkModelInput,
): WorkshopWorkModel {
  const modelConfig = asRecord(input.workshop.modelConfig);
  const boundaryPolicy = asRecord(input.workshop.boundaryPolicy);
  const role = stringValue(
    modelConfig.role,
    stringValue(modelConfig.persona, "general_workshop"),
  );
  const recallProfileResult = parseBrainRecallProfilesFromModelConfig(
    modelConfig,
  );
  const primarySkills = unique(stringArray(modelConfig.primarySkills));
  const loopSkillMap = stringRecord(modelConfig.loopSkillMap);
  const explicitAllowed = unique([
    ...stringArray(modelConfig.allowedTools),
    ...stringArray(modelConfig.primaryTools),
  ]);
  const explicitDenied = unique([
    ...stringArray(modelConfig.deniedTools),
    ...stringArray(modelConfig.disallowedTools),
  ]);
  const explicitApproval = unique([
    ...stringArray(modelConfig.requiresApprovalTools),
    ...stringArray(modelConfig.requiresApproval),
  ]);
  const configuredRuntimeSelection = resolveWorkshopAgentRuntime({
    workshop: input.workshop,
  });
  const policyAllowed = toolNamesByAvailability(input.toolMatrix, "allow");
  const policyApproval = toolNamesByAvailability(
    input.toolMatrix,
    "require_approval",
  );
  const policyDenied = toolNamesByAvailability(input.toolMatrix, "deny");
  const denied = unique([...explicitDenied, ...policyDenied]);
  const allowed = unique([...explicitAllowed, ...policyAllowed]).filter(
    (tool) => !denied.includes(tool),
  );
  const approvalRequired = unique([
    ...explicitApproval,
    ...policyApproval,
  ]).filter((tool) => !denied.includes(tool));
  const runtimeResolution = resolveWorkshopRuntimeWithPiGreyDefault({
    runtimeSelection: configuredRuntimeSelection,
    tools: unique([...allowed, ...approvalRequired]),
  });
  const runtimeSelection = runtimeResolution.runtimeSelection;
  const piGreyReadiness = runtimeResolution.piGreyReadiness;
  const conflicts = explicitAllowed
    .filter((tool) => denied.includes(tool))
    .map((tool) => ({
      kind: "allowed_and_denied" as const,
      tool,
    }));
  const mappedSkills = Object.values(loopSkillMap);
  const configuredSkills = unique([...primarySkills, ...mappedSkills]);
  const availableSkillSet = new Set(input.availableSkillNames);
  const missingSkills = configuredSkills.filter(
    (skill) => !availableSkillSet.has(skill),
  );
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!role) missing.push("manifest.role");
  if (primarySkills.length === 0) warnings.push("No primary Skill is bound.");
  if (conflicts.length > 0) warnings.push("Some tools are both allowed and denied.");
  if (missingSkills.length > 0) warnings.push("Some configured Skills are missing.");
  if (
    piGreyReadiness.requested &&
    piGreyReadiness.status === "blocked"
  ) {
    warnings.push("Pi grey run is blocked by high-risk or denied tools.");
  } else if (
    piGreyReadiness.requested &&
    piGreyReadiness.status === "needs_tool_migration"
  ) {
    warnings.push("Pi grey run needs more tool migration or approval wiring.");
  }
  for (const issue of recallProfileResult.issues) {
    warnings.push(`Invalid memory recall profile at ${issue.path}: ${issue.message}`);
  }

  const loopBindings = input.loops.map((loop): WorkshopWorkLoopBinding => {
    const skillName = loopSkillMap[loop.name] ?? null;
    const systemGovernanceLoop = isSystemGovernanceLoop(loop);
    const skillStatus: WorkSkillBindingStatus = skillName
      ? availableSkillSet.has(skillName)
        ? "bound"
        : "missing"
      : "unmapped";
    const fields = requiredFields(loop);
    if (!skillName && !systemGovernanceLoop) {
      warnings.push(`Loop "${loop.name}" has no Skill mapping.`);
    }
    if (fields.length === 0) {
      warnings.push(`Loop "${loop.name}" has no required verifier fields.`);
    }
    return {
      id: loop.id,
      name: loop.name,
      status: loop.status,
      triggerType: stringValue(asRecord(loop.triggerConfig).type, "unknown"),
      nextScheduledRunAt: null,
      requiredFields: fields,
      skillName,
      skillStatus,
      hasActionPolicy: hasMeaningfulPolicy(loop.actionPolicy),
      hasVerification: hasMeaningfulPolicy(loop.verificationConfig),
    };
  });

  const feedbackSignals = unique([
    ...roleFeedbackSignals(role),
    ...stringArray(modelConfig.feedbackSignals),
  ]);
  const configuredPresentation = asRecord(asRecord(modelConfig.manifestSpec).presentation);
  const presentationConfigured = Object.keys(configuredPresentation).length > 0;

  return {
    manifest: {
      id: input.workshop.id,
      name: input.workshop.name,
      role,
      mission: input.workshop.mission,
      status: input.workshop.status,
      autonomyLevel: input.workshop.autonomyLevel,
      version: stringValue(
        modelConfig.workVersion,
        isoTime(input.workshop.updatedAt) ?? "unversioned",
      ),
      updatedAt: isoTime(input.workshop.updatedAt) ?? "",
    },
    controlContract: {
      controlledObjects: unique([
        ...roleControlledObjects(role),
        ...stringArray(modelConfig.controlledObjects),
      ]),
      observations: unique([
        ...stringArray(modelConfig.observationTools),
        ...observationTools(input.toolMatrix),
      ]),
      allowedActions: allowed,
      approvalRequiredActions: approvalRequired,
      deniedActions: denied,
      boundaryMode: stringValue(boundaryPolicy.mode, input.workshop.autonomyLevel),
      externalMessagePolicy: stringValue(
        boundaryPolicy.externalMessages,
        "blocked",
      ),
      feedbackSignals,
      conflicts,
    },
    skillBindings: {
      primarySkills,
      loopSkillMap,
      availableSkills: input.availableSkillNames,
      missingSkills,
    },
    loopBindings,
    memoryPolicy: {
      defaultReadableKinds: [
        "finding",
        "watchlist",
        "boundary",
        "source_note",
        "mistake",
      ],
      evidenceRequiredForHighImpact: true,
      writeReusableFindingsToMemory: true,
      recallProfiles: recallProfileResult.profiles,
    },
    artifactPolicy: {
      eventTypes: [
        "source_checked",
        "decision",
        "memory_written",
        "watchlist_proposal",
        "workshop_agent_change_proposed",
        "workshop_insight_change_proposed",
        "workshop_loop_change_proposed",
      ],
      proposalTypes: [
        "watchlist_change_proposal",
        "workshop_agent_change_proposal",
        "insight_change_proposal",
        "loop_change_proposal",
        "video_review",
      ],
      outboxEnabled:
        stringValue(boundaryPolicy.externalMessages, "blocked") !== "blocked",
    },
    presentationContract: {
      audience: "owner",
      reportFormat: "markdown",
      purpose: stringValue(configuredPresentation.purpose, input.workshop.mission),
      requiredSections: stringArray(configuredPresentation.requiredSections).length > 0
        ? unique(stringArray(configuredPresentation.requiredSections))
        : ["conclusion", "evidence", "actions", "limitations", "next_steps"],
      expectedArtifacts: unique(stringArray(configuredPresentation.expectedArtifacts)),
      evidenceSource: "run_events",
      artifactSource: "run_receipts",
      statusSource: "run_lifecycle",
      source: presentationConfigured ? "manifest" : "default",
    },
    feedback: {
      nextWakeupAt: isoTime(input.heartbeat?.nextWakeupAt),
      heartbeatStatus: input.heartbeat?.schedulerStatus ?? null,
      pendingReviewSurfaces: unique([
        ...input.toolMatrix.tools
          .filter((tool) => tool.availability === "require_approval")
          .map((tool) => tool.confirmation?.surface ?? "")
          .filter(Boolean),
      ]),
      feedbackSignals,
    },
    observability: {
      missing,
      warnings: unique(warnings),
    },
    runtime: {
      engine: runtimeSelection.engine,
      source: runtimeSelection.source,
      piGreyReadiness,
    },
    changeControl: {
      proposalSurface: "workshop_review_tab",
      highRiskChanges: [
        "enable external send",
        "enable real trading",
        "remove denied action",
        "change autonomy to auto",
        "delete or archive work",
      ],
      mediumRiskChanges: [
        "add tool",
        "change Skill binding",
        "change Loop schedule",
        "change verifier",
        "change boundary policy",
      ],
      lowRiskChanges: [
        "rename Work",
        "clarify mission text",
        "add display-only source",
        "add non-actionable memory guidance",
      ],
    },
  };
}
