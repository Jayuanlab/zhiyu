import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBrainRecallPlannerMode, getJevEvidenceCheckMode, getPlatformCapabilityRoutingMode, getPlatformReasoningMode, getPlatformRecallPrefetchMode, isJevTargetedRetryEnabled } from "@/lib/brain/recall-policy";

beforeEach(() => {
  for (const key of ["PLATFORM_REASONING_MODE", "BRAIN_RECALL_PLANNER", "PLATFORM_RECALL_PREFETCH", "PLATFORM_CAPABILITY_ROUTING", "BRAIN_JEV_ROUTING", "BRAIN_JEV_MODE", "BRAIN_JEV_TARGETED_RETRY"]) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("agent reasoning baseline", () => {
  it.each(["", "agent", "invalid", "OPTIMIZED", "false"])("keeps the agent baseline for mode %s despite all previous experiment flags", mode => {
    vi.stubEnv("PLATFORM_REASONING_MODE", mode);
    vi.stubEnv("BRAIN_RECALL_PLANNER", "rules");
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev");
    vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace");
    vi.stubEnv("BRAIN_JEV_MODE", "active");
    vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true");
    expect(getPlatformReasoningMode()).toBe("agent");
    expect(getBrainRecallPlannerMode()).toBe("llm");
    expect(getPlatformRecallPrefetchMode()).toBe("off");
    expect(getPlatformCapabilityRoutingMode()).toBe("off");
    expect(getJevEvidenceCheckMode()).toBe("off");
    expect(isJevTargetedRetryEnabled()).toBe(false);
  });
});

describe("explicit optimized recall policies", () => {
  beforeEach(() => vi.stubEnv("PLATFORM_REASONING_MODE", "optimized"));
  it("defaults each policy to rules, including with the legacy Jev flag enabled", () => {
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace");
    expect(getBrainRecallPlannerMode()).toBe("rules");
    expect(getPlatformRecallPrefetchMode()).toBe("rules");
    expect(getPlatformCapabilityRoutingMode()).toBe("rules");
  });

  it("reads each explicit opt-in without enabling another policy", () => {
    vi.stubEnv("BRAIN_RECALL_PLANNER", "llm");
    expect(getBrainRecallPlannerMode()).toBe("llm");
    expect(getPlatformRecallPrefetchMode()).toBe("rules");
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev");
    expect(getPlatformRecallPrefetchMode()).toBe("jev");
    expect(getPlatformCapabilityRoutingMode()).toBe("rules");
    vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "off");
    expect(getPlatformCapabilityRoutingMode()).toBe("off");
    expect(getBrainRecallPlannerMode()).toBe("llm");
  });

  it.each(["invalid", "replace", "LLM", "false"])("uses rules for invalid configuration %s", value => {
    vi.stubEnv("BRAIN_RECALL_PLANNER", value);
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", value);
    vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", value);
    expect(getBrainRecallPlannerMode()).toBe("rules");
    expect(getPlatformRecallPrefetchMode()).toBe("rules");
    expect(getPlatformCapabilityRoutingMode()).toBe("rules");
  });

  it("allows prefetch and capability routing to be disabled independently", () => {
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", " off ");
    vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", " jev ");
    expect(getPlatformRecallPrefetchMode()).toBe("off");
    expect(getPlatformCapabilityRoutingMode()).toBe("jev");
    expect(getBrainRecallPlannerMode()).toBe("rules");
  });

  it("enables evidence and targeted retry only in the explicit optimized mode", () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", " optimized ");
    vi.stubEnv("BRAIN_JEV_MODE", "active");
    vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true");
    expect(getPlatformReasoningMode()).toBe("optimized");
    expect(getJevEvidenceCheckMode()).toBe("active");
    expect(isJevTargetedRetryEnabled()).toBe(true);
    vi.stubEnv("BRAIN_JEV_MODE", "shadow");
    expect(getJevEvidenceCheckMode()).toBe("shadow");
    vi.stubEnv("BRAIN_JEV_MODE", "invalid");
    expect(getJevEvidenceCheckMode()).toBe("off");
  });
});
