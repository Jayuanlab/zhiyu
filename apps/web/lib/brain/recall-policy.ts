export type BrainRecallPlannerMode = "rules" | "llm";
export type PlatformRecallPrefetchMode = "rules" | "jev" | "off";
export type PlatformCapabilityRoutingMode = "rules" | "jev" | "off";
export type PlatformReasoningMode = "agent" | "optimized";

/** The agent baseline takes precedence over flags left by previous experiments. */
export function getPlatformReasoningMode(): PlatformReasoningMode {
  return process.env.PLATFORM_REASONING_MODE?.trim() === "optimized" ? "optimized" : "agent";
}

export function getBrainRecallPlannerMode(): BrainRecallPlannerMode {
  if (getPlatformReasoningMode() === "agent") return "llm";
  return process.env.BRAIN_RECALL_PLANNER?.trim() === "llm" ? "llm" : "rules";
}

export function getPlatformRecallPrefetchMode(): PlatformRecallPrefetchMode {
  if (getPlatformReasoningMode() === "agent") return "off";
  const mode = process.env.PLATFORM_RECALL_PREFETCH?.trim();
  return mode === "jev" || mode === "off" ? mode : "rules";
}

export function getPlatformCapabilityRoutingMode(): PlatformCapabilityRoutingMode {
  if (getPlatformReasoningMode() === "agent") return "off";
  const mode = process.env.PLATFORM_CAPABILITY_ROUTING?.trim();
  return mode === "jev" || mode === "off" ? mode : "rules";
}

export function getJevEvidenceCheckMode(): "off" | "shadow" | "active" {
  if (getPlatformReasoningMode() === "agent") return "off";
  const mode = process.env.BRAIN_JEV_MODE?.trim();
  return mode === "shadow" || mode === "active" ? mode : "off";
}

export function isJevTargetedRetryEnabled(): boolean {
  return getPlatformReasoningMode() === "optimized" && process.env.BRAIN_JEV_TARGETED_RETRY === "true";
}
