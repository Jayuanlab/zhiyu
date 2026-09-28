import type { UserLlmProviderConfig } from "./user-llm-api-settings";

type PiConfig = Partial<UserLlmProviderConfig> & {
  protocol?: "anthropic-messages" | "openai-completions" | "openai-responses";
  providerId?: string;
};

/** Saved user providers take precedence, with protocol kept alongside credentials. */
export function resolveNativePiUserConfig(input: {
  env: PiConfig;
  request?: Partial<UserLlmProviderConfig>;
  openAI?: UserLlmProviderConfig;
  anthropic?: UserLlmProviderConfig;
}): PiConfig {
  if (input.openAI) return { ...input.openAI, protocol: "openai-completions" };
  if (input.anthropic) return { ...input.anthropic, protocol: "anthropic-messages" };
  return { ...input.env, ...input.request };
}
