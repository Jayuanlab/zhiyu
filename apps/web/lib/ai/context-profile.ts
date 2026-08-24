import type { Loop, Workshop } from "@/lib/db/schema";

export type ContextProfile = "cheap" | "normal" | "full" | "audit";

export type ContextProfileBudget = {
  profile: ContextProfile;
  promptMaxChars: number;
  loopStateMaxChars: number;
  workshopContextMaxChars: number;
  sourceLimit: number;
  memoryRefLimit: number;
  directiveLimit: number;
  eventLimit: number;
  outboxLimit: number;
};

const CONTEXT_PROFILE_BUDGETS: Record<ContextProfile, ContextProfileBudget> = {
  cheap: {
    profile: "cheap",
    promptMaxChars: 14_000,
    loopStateMaxChars: 8_000,
    workshopContextMaxChars: 6_000,
    sourceLimit: 8,
    memoryRefLimit: 16,
    directiveLimit: 12,
    eventLimit: 12,
    outboxLimit: 5,
  },
  normal: {
    profile: "normal",
    promptMaxChars: 16_000,
    loopStateMaxChars: 14_000,
    workshopContextMaxChars: 10_000,
    sourceLimit: 10,
    memoryRefLimit: 18,
    directiveLimit: 12,
    eventLimit: 12,
    outboxLimit: 5,
  },
  full: {
    profile: "full",
    promptMaxChars: 40_000,
    loopStateMaxChars: 36_000,
    workshopContextMaxChars: 32_000,
    sourceLimit: 40,
    memoryRefLimit: 80,
    directiveLimit: 50,
    eventLimit: 50,
    outboxLimit: 20,
  },
  audit: {
    profile: "audit",
    promptMaxChars: 48_000,
    loopStateMaxChars: 40_000,
    workshopContextMaxChars: 36_000,
    sourceLimit: 50,
    memoryRefLimit: 100,
    directiveLimit: 60,
    eventLimit: 60,
    outboxLimit: 25,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeContextProfile(
  value: unknown,
): ContextProfile | null {
  return value === "cheap" ||
    value === "normal" ||
    value === "full" ||
    value === "audit"
    ? value
    : null;
}

function parsePositiveIntEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getContextProfileBudget(
  profile: ContextProfile,
): ContextProfileBudget {
  const budget = CONTEXT_PROFILE_BUDGETS[profile];
  return {
    ...budget,
    promptMaxChars: parsePositiveIntEnv(
      `CONTEXT_PROFILE_${profile.toUpperCase()}_PROMPT_MAX_CHARS`,
      budget.promptMaxChars,
    ),
    loopStateMaxChars: parsePositiveIntEnv(
      `CONTEXT_PROFILE_${profile.toUpperCase()}_LOOP_STATE_MAX_CHARS`,
      budget.loopStateMaxChars,
    ),
    workshopContextMaxChars: parsePositiveIntEnv(
      `CONTEXT_PROFILE_${profile.toUpperCase()}_WORKSHOP_CONTEXT_MAX_CHARS`,
      budget.workshopContextMaxChars,
    ),
  };
}

export function resolveWorkshopContextProfile(
  workshop: Pick<Workshop, "modelConfig">,
): ContextProfile {
  const config = isRecord(workshop.modelConfig) ? workshop.modelConfig : {};
  return (
    normalizeContextProfile(config.contextProfile) ??
    normalizeContextProfile(process.env.WORKSHOP_CONTEXT_PROFILE) ??
    "normal"
  );
}

export function resolveLoopContextProfile(
  loop: Pick<Loop, "contextConfig" | "triggerConfig">,
  workshop?: Pick<Workshop, "modelConfig"> | null,
): ContextProfile {
  const contextConfig = isRecord(loop.contextConfig) ? loop.contextConfig : {};
  const metadata = isRecord(contextConfig.metadata)
    ? contextConfig.metadata
    : {};
  const workshopConfig =
    workshop && isRecord(workshop.modelConfig) ? workshop.modelConfig : {};
  const triggerConfig = isRecord(loop.triggerConfig) ? loop.triggerConfig : {};
  const triggerType =
    typeof triggerConfig.type === "string" ? triggerConfig.type : "";

  return (
    normalizeContextProfile(contextConfig.contextProfile) ??
    normalizeContextProfile(metadata.contextProfile) ??
    normalizeContextProfile(workshopConfig.loopContextProfile) ??
    normalizeContextProfile(process.env.LOOP_CONTEXT_PROFILE) ??
    (triggerType === "cron" ||
    triggerType === "interval" ||
    triggerType === "scheduled_job"
      ? "cheap"
      : "normal")
  );
}
