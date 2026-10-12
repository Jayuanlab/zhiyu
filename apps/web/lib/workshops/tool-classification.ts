import type { RuntimeToolDecision, RuntimeToolPolicy } from "@/lib/ai/runtime/tool-executor";

export type WorkshopRuntimeToolRisk =
  | "read"
  | "internal_write"
  | "proposal"
  | "external_effect"
  | "high_risk";

export interface WorkshopRuntimeToolClassification {
  toolName: string;
  leafName: string;
  risk: WorkshopRuntimeToolRisk;
  defaultDecision: RuntimeToolDecision;
  reason: string;
}

const READ_PREFIXES = [
  "workshoplist",
  "workshopget",
  "workshopread",
  "workshopsearch",
  "workshopinspect",
  "wechatlocal",
  "wechatlist",
  "astock",
  "quantpaperget",
  "quantmarketdiscover",
  "quanttradeplanlist",
  "quantruleevaluate",
  "watchlistchangehistory",
  "watchlistperformancereview",
  "watchlistcandidateagereview",
  "watchlistfollowuptasklist",
  "ownercontextget",
  "ownercontextlist",
  "webreadpage",
  "douyincheck",
  "time",
];

const READ_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "getfulldocumentcontent",
  "listknowledgebasedocuments",
  "searchknowledgebase",
  "searchmemorypath",
  "searchunifiedmemory",
  "skill",
  "websearch",
  "chatinsight",
  "querycontacts",
  "brainlistmemories",
  "brainlistcandidates",
  "brainlistsnapshots",
  "brainlistgrants",
  "listlooptasks",
  "wechatdesktophealth",
  "wechatdesktoppreviewmessage",
  "interactionlistwiki",
  "wechattododigest",
  "wechatscenariocontext",
  "wechatmemoryevidence",
  "ownercontextlistcandidates",
  "ownercontextgetevidence",
  "listworkshopmanifestcapabilities",
  "reviewworkshopmanifestyaml",
  "inspectworkshopagent",
]);

const INTERNAL_WRITE_TOOLS = new Set([
  "workingmemory",
  "workshopconvertdocument",
  "write",
  "edit",
  "workshoplogevent",
  "workshopwritememory",
  "workshopreviewmemory",
  "workshoprecordmemoryrecallfeedback",
  "wechatrecordnewmessages",
  "wechatmarkmessagesprocessed",
  "interactionprocessrecordedmessages",
  "interactioncreatewikinote",
  "interactioncreatetaskcandidate",
  "interactioncreatememorycandidate",
  "watchlistfollowuptaskupsert",
  "quanttradeplanupsert",
  "quantcandidatepoolmaintain",
  "douyincreatepublishdraft",
  "ownercontextprocessrecordedmessages",
  "ownercontextreviewcandidate",
]);

const PROPOSAL_TOOLS = new Set([
  "workshopproposeagentchange",
  "workshopcreateharnessproposal",
  "workshopcreateharnessevaluationcampaign",
  "workshoprunharnessevaluation",
  "workshopcreatelooptask",
  "quantpaperproposewatchlistchange",
  "quanttradeplanreview",
]);

const EXTERNAL_EFFECT_TOOLS = new Set([
  "workshopcreateoutboxdraft",
  "wechatcreatereplydraft",
  "workshopsendoutboxwechat",
  "sendworkoutbox",
  "outboxsend",
  "wechatsendmessage",
  "sendwechatdesktopmessage",
  "videorenderinvestmentbrief",
  "videogenerateinvestmentbrief",
  "douyinprepareupload",
  "douyinpublishapproveddraft",
]);

const HIGH_RISK_TOOLS = new Set([
  "bash",
  "powershell",
  "workshopruncomputeruse",
  "quantpaperplaceorder",
  "quantpapercancelorder",
]);

function leafToolName(toolName: string) {
  const trimmed = toolName.trim();
  const mcpMatch = trimmed.match(/^mcp__[^_]+__(.+)$/);
  return (mcpMatch?.[1] ?? trimmed).toLowerCase();
}

function readByPrefix(leafName: string) {
  return READ_PREFIXES.some((prefix) => leafName.startsWith(prefix));
}

export function classifyWorkshopRuntimeTool(
  toolName: string,
): WorkshopRuntimeToolClassification {
  const leafName = leafToolName(toolName);
  if (HIGH_RISK_TOOLS.has(leafName)) {
    return {
      toolName,
      leafName,
      risk: "high_risk",
      defaultDecision: "deny",
      reason: "High-risk control action must stay outside autonomous Pi runtime until the domain ledger and approval recovery are wired.",
    };
  }
  if (EXTERNAL_EFFECT_TOOLS.has(leafName)) {
    return {
      toolName,
      leafName,
      risk: "external_effect",
      defaultDecision: "require_approval",
      reason: "External effect requires owner approval and a durable recovery path.",
    };
  }
  if (PROPOSAL_TOOLS.has(leafName)) {
    return {
      toolName,
      leafName,
      risk: "proposal",
      defaultDecision: "require_approval",
      reason: "Proposal-producing tools must surface reviewable artifacts before action.",
    };
  }
  if (INTERNAL_WRITE_TOOLS.has(leafName)) {
    return {
      toolName,
      leafName,
      risk: "internal_write",
      defaultDecision: "require_approval",
      reason: "Internal durable writes are staged behind review until Pi write handlers share the domain command ledger.",
    };
  }
  if (READ_TOOLS.has(leafName) || readByPrefix(leafName)) {
    return {
      toolName,
      leafName,
      risk: "read",
      defaultDecision: "allow",
      reason: "Read-only observation tool.",
    };
  }
  return {
    toolName,
    leafName,
    risk: "high_risk",
    defaultDecision: "deny",
    reason: "Unclassified Workshop tool is denied by default.",
  };
}

export function buildWorkshopRuntimeToolPolicy(
  tools: readonly string[],
): RuntimeToolPolicy {
  const allowedTools: string[] = [];
  const requiresApprovalTools: string[] = [];
  const deniedTools: string[] = [];
  for (const tool of tools) {
    const classification = classifyWorkshopRuntimeTool(tool);
    if (classification.defaultDecision === "allow") {
      allowedTools.push(tool);
    } else if (classification.defaultDecision === "require_approval") {
      requiresApprovalTools.push(tool);
    } else {
      deniedTools.push(tool);
    }
  }
  return {
    allowedTools,
    requiresApprovalTools,
    deniedTools,
    defaultDecision: "deny",
  };
}

export function summarizeWorkshopRuntimeToolClassifications(
  tools: readonly string[],
) {
  const counts: Record<WorkshopRuntimeToolRisk, number> = {
    read: 0,
    internal_write: 0,
    proposal: 0,
    external_effect: 0,
    high_risk: 0,
  };
  const decisions: Record<RuntimeToolDecision, number> = {
    allow: 0,
    require_approval: 0,
    deny: 0,
  };
  for (const tool of tools) {
    const classification = classifyWorkshopRuntimeTool(tool);
    counts[classification.risk] += 1;
    decisions[classification.defaultDecision] += 1;
  }
  return {
    schemaVersion: "workshop-runtime-tool-classification.v1",
    total: tools.length,
    counts,
    decisions,
  };
}
