import type { ContextProfile } from "@/lib/ai/context-profile";
import type { Loop, Workshop } from "@/lib/db/schema";
import type { UserLlmProviderConfig } from "./user-llm-api-settings";

export type ModelTier = "cheap" | "standard" | "review" | "audit" | "vision";

export type AgentModelConfig = {
  provider: "claude";
  tier: ModelTier;
  source: "tier_env" | "user" | "env" | "default";
  apiKey?: string;
  baseUrl?: string;
  model: string;
  inputPriceUsdPerMillionTokens: number | null;
  outputPriceUsdPerMillionTokens: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeModelTier(value: unknown): ModelTier | null {
  return value === "cheap" ||
    value === "standard" ||
    value === "review" ||
    value === "audit" ||
    value === "vision"
    ? value
    : null;
}

export function defaultModelTierForContextProfile(
  contextProfile: ContextProfile,
): ModelTier {
  if (contextProfile === "cheap") return "cheap";
  if (contextProfile === "full") return "review";
  if (contextProfile === "audit") return "audit";
  return "standard";
}

export function resolveWorkshopModelTier(input: {
  workshop: Pick<Workshop, "modelConfig">;
  contextProfile: ContextProfile;
}): ModelTier {
  const config = isRecord(input.workshop.modelConfig)
    ? input.workshop.modelConfig
    : {};
  return (
    normalizeModelTier(config.modelTier) ??
    normalizeModelTier(process.env.WORKSHOP_MODEL_TIER) ??
    defaultModelTierForContextProfile(input.contextProfile)
  );
}

export function resolveLoopModelTier(input: {
  loop: Pick<Loop, "contextConfig">;
  workshop?: Pick<Workshop, "modelConfig"> | null;
  contextProfile: ContextProfile;
}): ModelTier {
  const contextConfig = isRecord(input.loop.contextConfig)
    ? input.loop.contextConfig
    : {};
  const metadata = isRecord(contextConfig.metadata)
    ? contextConfig.metadata
    : {};
  const workshopConfig =
    input.workshop && isRecord(input.workshop.modelConfig)
      ? input.workshop.modelConfig
      : {};
  return (
    normalizeModelTier(contextConfig.modelTier) ??
    normalizeModelTier(metadata.modelTier) ??
    normalizeModelTier(workshopConfig.loopModelTier) ??
    normalizeModelTier(process.env.LOOP_MODEL_TIER) ??
    defaultModelTierForContextProfile(input.contextProfile)
  );
}

function normalizeOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function tierEnvValue(tier: ModelTier, key: "API_KEY" | "BASE_URL" | "MODEL") {
  const upper = tier.toUpperCase();
  return normalizeOptionalEnv(
    process.env[`LLM_${upper}_${key}`] ??
      process.env[`ANTHROPIC_${upper}_${key}`],
  );
}

function parseOptionalNumber(value: string | undefined): number | null {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function tierPriceEnvValue(
  tier: ModelTier,
  key: "INPUT_USD_PER_M" | "OUTPUT_USD_PER_M",
) {
  const upper = tier.toUpperCase();
  return parseOptionalNumber(
    process.env[`LLM_${upper}_${key}`] ??
      process.env[`MODEL_${upper}_${key}`],
  );
}

export function resolveAgentModelConfig(input: {
  tier: ModelTier;
  userConfig?: UserLlmProviderConfig | null;
  envConfig: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  fallbackBaseUrl?: string;
  fallbackModel: string;
}): AgentModelConfig {
  const tierApiKey = tierEnvValue(input.tier, "API_KEY");
  const tierBaseUrl = tierEnvValue(input.tier, "BASE_URL");
  const tierModel = tierEnvValue(input.tier, "MODEL");
  const source = tierModel
    ? "tier_env"
    : input.userConfig?.model
      ? "user"
      : input.envConfig.model
        ? "env"
        : "default";

  return {
    provider: "claude",
    tier: input.tier,
    source,
    apiKey:
      tierApiKey ?? input.userConfig?.apiKey ?? input.envConfig.apiKey,
    baseUrl:
      tierBaseUrl ??
      input.userConfig?.baseUrl ??
      input.envConfig.baseUrl ??
      input.fallbackBaseUrl,
    model:
      tierModel ??
      input.userConfig?.model ??
      input.envConfig.model ??
      input.fallbackModel,
    inputPriceUsdPerMillionTokens: tierPriceEnvValue(
      input.tier,
      "INPUT_USD_PER_M",
    ),
    outputPriceUsdPerMillionTokens: tierPriceEnvValue(
      input.tier,
      "OUTPUT_USD_PER_M",
    ),
  };
}
