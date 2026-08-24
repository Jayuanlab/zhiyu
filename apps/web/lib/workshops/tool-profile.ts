import type { ContextProfile } from "@/lib/ai/context-profile";
import type { Workshop } from "@/lib/db/schema";

export type WorkshopToolProfileName =
  | "cheap_observe"
  | "normal"
  | "full"
  | "audit";

export type WorkshopToolProfileResult = {
  name: WorkshopToolProfileName;
  tools: string[];
  selectedLeafTools: string[];
  removedToolCount: number;
};

const CHEAP_CORE_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "skill",
  "lsp",
  "todowrite",
  "time",
  "webreadpage",
  "workshoplogevent",
  "workshoplistsources",
  "workshopgetdirectives",
  "workshopreadlinkedworkshopevents",
  "workshopinspectwork",
]);

const CHEAP_MEMORY_TOOLS = new Set([
  "workshopreadmemory",
  "workshopsearchmemory",
  "workshoprecordmemoryrecallfeedback",
  "workshopinspectmemoryrecallquality",
  "workshopgetmemoryevidence",
  "workshoplistmemorycandidates",
  "workshopreviewmemory",
  "workshopwritememory",
]);

const CHEAP_MARKET_OBSERVATION_TOOLS = new Set([
  "astockquote",
  "astockresearch",
  "astocksignals",
  "astocktrend",
  "astocktrendsystem",
  "astocktrendstatehistory",
  "astocktrendstrategystats",
  "astockfundamentals",
  "astocknewsandfilings",
  "astockmarketmood",
  "quantpapergetaccount",
  "quantruleevaluate",
  "quantpapergetwatchlist",
  "quanttradeplanlist",
  "watchlistfollowuptasklist",
  "watchlistcandidateagereview",
  "watchlistchangehistory",
  "watchlistperformancereview",
]);

const TOOL_FAMILY_PREFIXES = [
  "astock",
  "quant",
  "watchlist",
  "wechat",
  "interaction",
  "douyin",
  "video",
  "workshop",
];

const WORKSHOP_MCP_ALIAS_PREFIXES = [
  "workshop",
  "wechat",
  "interaction",
  "webreadpage",
  "astock",
  "quant",
  "watchlist",
  "video",
  "douyin",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function leafToolName(toolName: string) {
  return (toolName.split("__").pop() ?? toolName).toLowerCase();
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function shouldAddWorkshopMcpAlias(toolName: string) {
  const leaf = leafToolName(toolName);
  if (toolName.startsWith("mcp__")) return false;
  return WORKSHOP_MCP_ALIAS_PREFIXES.some((prefix) => leaf.startsWith(prefix));
}

function expandWorkshopMcpToolAliases(tools: readonly string[]) {
  const expanded: string[] = [];
  for (const tool of tools) {
    expanded.push(tool);
    if (shouldAddWorkshopMcpAlias(tool)) {
      expanded.push(`mcp__workshop-tools__${tool}`);
    }
  }
  return unique(expanded);
}

function relatedLeafTools(toolName: string, baseLeafTools: Set<string>) {
  const leaf = leafToolName(toolName);
  const related = new Set<string>([leaf]);
  for (const prefix of TOOL_FAMILY_PREFIXES) {
    if (!leaf.startsWith(prefix)) continue;
    for (const candidate of baseLeafTools) {
      if (candidate.startsWith(prefix)) {
        related.add(candidate);
      }
    }
  }
  return related;
}

function configuredToolHints(workshop: Pick<Workshop, "modelConfig">) {
  const config = asRecord(workshop.modelConfig);
  return unique([
    ...stringArray(config.allowedTools),
    ...stringArray(config.primaryTools),
    ...stringArray(config.observationTools),
    ...stringArray(config.requiresApprovalTools),
    ...stringArray(config.requiresApproval),
  ]);
}

export function buildWorkshopToolProfile(input: {
  workshop: Pick<Workshop, "modelConfig">;
  contextProfile: ContextProfile;
  baseTools: readonly string[];
  requestedTools?: readonly string[];
}): WorkshopToolProfileResult {
  const baseTools = expandWorkshopMcpToolAliases(input.baseTools);
  if (input.contextProfile !== "cheap") {
    return {
      name: input.contextProfile === "normal" ? "normal" : input.contextProfile,
      tools: baseTools,
      selectedLeafTools: unique(baseTools.map(leafToolName)),
      removedToolCount: 0,
    };
  }

  const baseLeafTools = new Set(baseTools.map(leafToolName));
  const selectedLeaves = new Set<string>([
    ...CHEAP_CORE_TOOLS,
    ...CHEAP_MEMORY_TOOLS,
    ...CHEAP_MARKET_OBSERVATION_TOOLS,
  ]);

  for (const hint of [
    ...configuredToolHints(input.workshop),
    ...(input.requestedTools ?? []),
  ]) {
    for (const leaf of relatedLeafTools(hint, baseLeafTools)) {
      selectedLeaves.add(leaf);
    }
  }

  const tools = baseTools.filter((tool) => selectedLeaves.has(leafToolName(tool)));
  return {
    name: "cheap_observe",
    tools,
    selectedLeafTools: unique(tools.map(leafToolName)),
    removedToolCount: Math.max(0, baseTools.length - tools.length),
  };
}
