import {
  classifyWorkshopRuntimeTool,
  summarizeWorkshopRuntimeToolClassifications,
  type WorkshopRuntimeToolClassification,
} from "./tool-classification";
import type { AgentRuntimeSelection } from "@/lib/ai/model-policy";

export type WorkshopPiRuntimeGreyReadinessStatus =
  | "not_requested"
  | "eligible"
  | "needs_tool_migration"
  | "blocked";

export interface WorkshopPiRuntimeGreyReadiness {
  schemaVersion: "workshop-pi-runtime-grey-readiness.v1";
  requested: boolean;
  eligible: boolean;
  status: WorkshopPiRuntimeGreyReadinessStatus;
  summary: ReturnType<typeof summarizeWorkshopRuntimeToolClassifications>;
  allowedTools: string[];
  migratedWriteTools: string[];
  policyScopedMigratedWriteTools: string[];
  needsMigrationTools: Array<{
    toolName: string;
    risk: WorkshopRuntimeToolClassification["risk"];
    reason: string;
  }>;
  blockedTools: Array<{
    toolName: string;
    risk: WorkshopRuntimeToolClassification["risk"];
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
}

export interface WorkshopPiRuntimeSelectionResult {
  runtimeSelection: AgentRuntimeSelection;
  piGreyReadiness: WorkshopPiRuntimeGreyReadiness;
  defaultPiSelected: boolean;
}

const PI_GREY_MIGRATED_WRITE_TOOLS = new Set([
  "workshopconvertdocument",
  "workshoplogevent",
  "workshoprecordmemoryrecallfeedback",
  "workshopreviewmemory",
  "workshopproposeagentchange",
  "workshopcreateharnessproposal",
  "workshopcreateharnessevaluationcampaign",
  "workshoprunharnessevaluation",
  "workshopcreatelooptask",
  "workshopwritememory",
  "workshopcreateoutboxdraft",
  "wechatrecordnewmessages",
  "wechatmarkmessagesprocessed",
  "wechatcreatereplydraft",
  "interactionprocessrecordedmessages",
  "interactioncreatewikinote",
  "interactioncreatetaskcandidate",
  "interactioncreatememorycandidate",
  "ownercontextprocessrecordedmessages",
  "ownercontextreviewcandidate",
  "watchlistfollowuptaskupsert",
  "quanttradeplanupsert",
  "quanttradeplanreview",
  "quantcandidatepoolmaintain",
  "quantpaperproposewatchlistchange",
  "quantpaperplaceorder",
  "quantpapercancelorder",
  "workshopsendoutboxwechat",
  "sendworkoutbox",
  "outboxsend",
  "wechatsendmessage",
  "sendwechatdesktopmessage",
  "videorenderinvestmentbrief",
  "videogenerateinvestmentbrief",
  "douyincreatepublishdraft",
  "douyinprepareupload",
  "douyinpublishapproveddraft",
]);

const PI_GREY_POLICY_SCOPED_MIGRATED_WRITE_TOOLS = new Set([
  "workshopcreateoutboxdraft",
  "wechatrecordnewmessages",
  "wechatmarkmessagesprocessed",
  "wechatcreatereplydraft",
  "interactionprocessrecordedmessages",
  "interactioncreatewikinote",
  "interactioncreatetaskcandidate",
  "interactioncreatememorycandidate",
  "ownercontextprocessrecordedmessages",
  "ownercontextreviewcandidate",
  "watchlistfollowuptaskupsert",
  "quanttradeplanupsert",
  "quanttradeplanreview",
  "quantcandidatepoolmaintain",
  "quantpaperproposewatchlistchange",
  "quantpaperplaceorder",
  "quantpapercancelorder",
  "workshopsendoutboxwechat",
  "sendworkoutbox",
  "outboxsend",
  "wechatsendmessage",
  "sendwechatdesktopmessage",
  "videorenderinvestmentbrief",
  "videogenerateinvestmentbrief",
  "douyincreatepublishdraft",
  "douyinprepareupload",
  "douyinpublishapproveddraft",
]);

function leafName(toolName: string) {
  return classifyWorkshopRuntimeTool(toolName).leafName;
}

const PI_RUNTIME_HOST_OR_SKILL_TOOLS = new Set([
  "bash",
  "powershell",
  "edit",
  "glob",
  "grep",
  "lsp",
  "read",
  "task",
  "todowrite",
  "webfetch",
  "write",
  "agent-browser",
  "docx",
  "frontend-design",
  "openzhiyu-api",
  "openzhiyu-feature-guide",
  "openzhiyu-memory",
  "pdf",
  "pptx",
  "ui-ux-pro-max",
  "weather",
  "xlsx",
]);

function isHostOrSkillTool(toolName: string) {
  return PI_RUNTIME_HOST_OR_SKILL_TOOLS.has(leafName(toolName));
}

export function isPiGreyMigratedWriteTool(toolName: string) {
  return PI_GREY_MIGRATED_WRITE_TOOLS.has(leafName(toolName));
}

export function evaluateWorkshopPiRuntimeGreyReadiness(input: {
  requested: boolean;
  tools: readonly string[];
}): WorkshopPiRuntimeGreyReadiness {
  const uniqueTools = Array.from(
    new Set(input.tools.map((tool) => tool.trim()).filter(Boolean)),
  );
  const allowedTools: string[] = [];
  const migratedWriteTools: string[] = [];
  const policyScopedMigratedWriteTools: string[] = [];
  const needsMigrationTools: WorkshopPiRuntimeGreyReadiness["needsMigrationTools"] =
    [];
  const blockedTools: WorkshopPiRuntimeGreyReadiness["blockedTools"] = [];

  for (const toolName of uniqueTools) {
    if (isHostOrSkillTool(toolName)) {
      continue;
    }
    const classification = classifyWorkshopRuntimeTool(toolName);
    if (classification.risk === "read") {
      allowedTools.push(toolName);
      continue;
    }
    if (isPiGreyMigratedWriteTool(toolName)) {
      migratedWriteTools.push(toolName);
      if (PI_GREY_POLICY_SCOPED_MIGRATED_WRITE_TOOLS.has(leafName(toolName))) {
        policyScopedMigratedWriteTools.push(toolName);
      }
      continue;
    }
    if (classification.defaultDecision === "deny") {
      blockedTools.push({
        toolName,
        risk: classification.risk,
        reason: classification.reason,
      });
      continue;
    }
    needsMigrationTools.push({
      toolName,
      risk: classification.risk,
      reason: classification.reason,
    });
  }

  const reasons: string[] = [];
  if (!input.requested) {
    reasons.push("Pi runtime is not explicitly requested.");
  }
  if (blockedTools.length > 0) {
    reasons.push(
      `Pi grey run is blocked by denied or high-risk tools: ${blockedTools
        .map((tool) => tool.toolName)
        .join(", ")}.`,
    );
  }
  if (needsMigrationTools.length > 0) {
    reasons.push(
      `Pi grey run needs more tool migration or approval wiring: ${needsMigrationTools
        .map((tool) => tool.toolName)
        .join(", ")}.`,
    );
  }
  if (input.requested && blockedTools.length === 0 && needsMigrationTools.length === 0) {
    reasons.push(
      "Pi grey run is limited to read-only tools and migrated reviewable write tools.",
    );
  }
  const nextSteps: WorkshopPiRuntimeGreyReadiness["nextSteps"] = [];
  if (!input.requested) {
    nextSteps.push({
      code: "request_pi_runtime",
      label: "显式选择 Pi 后再灰度",
      detail:
        "当前 Work 仍使用默认或 Claude 引擎；先通过配置变更把 agentRuntimeEngine 设为 pi，并说明下次运行生效。",
    });
  }
  if (blockedTools.length > 0) {
    nextSteps.push({
      code: "remove_or_split_blocked_tools",
      label: "拆分或移除阻断工具",
      detail:
        "这些工具当前是 deny/high-risk，不能进入低风险 Pi 灰度；请拆成只读/提案流程，或等 P4 领域台账和恢复链路完成后再接入。",
      toolNames: blockedTools.map((tool) => tool.toolName),
    });
  }
  if (needsMigrationTools.length > 0) {
    nextSteps.push({
      code: "migrate_tools",
      label: "先迁移需审批工具",
      detail:
        "这些工具需要接入 Pi handler、审批绑定、幂等命令或回执恢复后，才能作为灰度候选。",
      toolNames: needsMigrationTools.map((tool) => tool.toolName),
    });
  }
  if (input.requested && blockedTools.length === 0 && needsMigrationTools.length === 0) {
    nextSteps.push({
      code: "run_isolated_grey",
      label: "可安排隔离灰度",
      detail:
        "该 Work 的 Pi 工具范围已限制为只读和已迁移的安全写工具；下一步可用固定输入运行一次隔离灰度并核对运行快照、证据和产物。",
    });
  }

  const status: WorkshopPiRuntimeGreyReadinessStatus = !input.requested
    ? "not_requested"
    : blockedTools.length > 0
      ? "blocked"
      : needsMigrationTools.length > 0
        ? "needs_tool_migration"
        : "eligible";

  return {
    schemaVersion: "workshop-pi-runtime-grey-readiness.v1",
    requested: input.requested,
    eligible: status === "eligible",
    status,
    summary: summarizeWorkshopRuntimeToolClassifications(uniqueTools),
    allowedTools,
    migratedWriteTools,
    policyScopedMigratedWriteTools,
    needsMigrationTools,
    blockedTools,
    reasons,
    nextSteps,
  };
}

export function resolveWorkshopRuntimeWithPiGreyDefault(input: {
  runtimeSelection: AgentRuntimeSelection;
  tools: readonly string[];
  /** Exact registered domain bridge tools; their handlers own approval and fencing. */
  implementedTools?: readonly string[];
}): WorkshopPiRuntimeSelectionResult {
  if (input.implementedTools) {
    const registered = new Set(input.implementedTools);
    const missing = input.tools.filter(name => !registered.has(name));
    const readiness = evaluateWorkshopPiRuntimeGreyReadiness({requested: true, tools: []});
    readiness.allowedTools = [...input.tools];
    readiness.eligible = missing.length === 0;
    readiness.status = missing.length ? 'blocked' : 'eligible';
    readiness.reasons = missing.length ? [`Unregistered tools: ${missing.join(', ')}`] : ['Registered domain handlers preserve Work approval, ownership and execution fencing.'];
    readiness.summary = summarizeWorkshopRuntimeToolClassifications([...input.tools]);
    return {runtimeSelection: input.runtimeSelection, piGreyReadiness: readiness, defaultPiSelected: input.runtimeSelection.source === 'default'};
  }
  if (
    input.runtimeSelection.source === "default" &&
    input.runtimeSelection.engine === "claude"
  ) {
    const defaultPiReadiness = evaluateWorkshopPiRuntimeGreyReadiness({
      requested: true,
      tools: input.tools,
    });
    const autoPromotable = input.tools.every(
      (tool) => classifyWorkshopRuntimeTool(tool).risk !== "high_risk",
    );
    if (defaultPiReadiness.eligible && autoPromotable) {
      return {
        runtimeSelection: {
          ...input.runtimeSelection,
          engine: "pi",
        },
        piGreyReadiness: defaultPiReadiness,
        defaultPiSelected: true,
      };
    }
  }

  return {
    runtimeSelection: input.runtimeSelection,
    piGreyReadiness: evaluateWorkshopPiRuntimeGreyReadiness({
      requested: input.runtimeSelection.engine === "pi",
      tools: input.tools,
    }),
    defaultPiSelected: false,
  };
}
