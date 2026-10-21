import { getUserLlmProviderConfig } from "../../lib/ai/user-llm-api-settings";
import { resolvePiAgentModelConfig } from "../../lib/ai/model-policy";
import type { PiModelRuntimeConfig, PiModelProtocol } from "../../../../packages/ai/src/agent/runtime";

/** Uses the same saved owner provider as Workshop; credentials never enter receipts. */
export async function loadJointMemoryProbeProvider(origin: string): Promise<PiModelRuntimeConfig & { configurationSource: string }> {
  const url = new URL(origin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("Use the local owner application for this probe.");
  const response = await fetch(new URL("/api/identity", url), { signal: AbortSignal.timeout(5000) });
  const identity = await response.json();
  if (!response.ok || identity.mode !== "local_owner" || typeof identity.actorId !== "string") throw Error("Local owner identity is unavailable.");
  const saved = await getUserLlmProviderConfig({ userId: identity.actorId, providerType: "openai_compatible" });
  const pick = (suffix: string) => ["LLM", "WORKSHOP_PLANNER_LLM", "INTERACTION_PROCESSOR_LLM", "OPENCODE"]
    .map(prefix => process.env[`${prefix}_${suffix}`]?.trim()).find(Boolean);
  const envConfig = { apiKey: pick("API_KEY"), baseUrl: pick("BASE_URL"), model: pick("MODEL") };
  if (!saved && (!envConfig.apiKey || !envConfig.baseUrl || !envConfig.model)) throw Error("Workshop provider configuration is incomplete; probe stopped without substituting another model.");
  const protocol = process.env.PI_AGENT_PROTOCOL;
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(protocol ?? "")) throw Error("An explicit PI_AGENT_PROTOCOL is required.");
  const config = resolvePiAgentModelConfig({ userConfig: saved, envConfig,
    runtimeProtocol: protocol as PiModelProtocol, fallbackModel: saved?.model ?? envConfig.model! });
  return { apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model,
    protocol: config.piProtocol, providerId: config.providerId, configurationSource: config.source };
}
