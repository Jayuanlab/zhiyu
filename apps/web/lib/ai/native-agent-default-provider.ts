export type NativeAgentProvider = "claude" | "pi";

export type NativeAgentProviderSource = "env" | "default";

export interface NativeAgentDefaultProviderSelection {
  provider: NativeAgentProvider;
  source: NativeAgentProviderSource;
}

export function normalizeNativeAgentProvider(
  value: unknown,
): NativeAgentProvider | null {
  return value === "claude" || value === "pi" ? value : null;
}

export function resolveDefaultNativeAgentProvider(): NativeAgentDefaultProviderSelection {
  const env = normalizeNativeAgentProvider(
    process.env.NATIVE_AGENT_DEFAULT_PROVIDER,
  );
  return {
    provider: env ?? "pi",
    source: env ? "env" : "default",
  };
}
