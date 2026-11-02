export type NativeAgentProvider = "pi";

export type NativeAgentProviderSource = "env" | "default";

export interface NativeAgentDefaultProviderSelection {
  provider: NativeAgentProvider;
  source: NativeAgentProviderSource;
  migratedFrom?: 'claude';
}

export function normalizeNativeAgentProvider(
  value: unknown,
): NativeAgentProvider | null {
  return value === "pi" ? value : null;
}

export function resolveDefaultNativeAgentProvider(): NativeAgentDefaultProviderSelection {
  const env = normalizeNativeAgentProvider(
    process.env.NATIVE_AGENT_DEFAULT_PROVIDER,
  );
  return {
    provider: env ?? "pi",
    source: env || process.env.NATIVE_AGENT_DEFAULT_PROVIDER === 'claude' ? "env" : "default",
    ...(process.env.NATIVE_AGENT_DEFAULT_PROVIDER === 'claude' ? {migratedFrom:'claude' as const} : {}),
  };
}
