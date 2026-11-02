import type { AgentConfig } from "@openzhiyu/ai/agent/types";
import {
  createPiAgentRuntime,
  createPiRuntimeOptionsFromModelConfig,
  type AgentRuntime,
  type AgentRuntimeEngine,
  type PiAgentRuntimeAdapterOptions,
} from "@openzhiyu/ai/agent/runtime";

export type AgentRuntimeEnginePreference = AgentRuntimeEngine;

export class AgentRuntimeUnavailableError extends Error {
  readonly code: "pi_not_configured" | "unknown_engine";

  constructor(
    code: AgentRuntimeUnavailableError["code"],
    message: string,
  ) {
    super(message);
    this.name = "AgentRuntimeUnavailableError";
    this.code = code;
  }
}

export interface CreateAgentRuntimeInput {
  engine?: AgentRuntimeEnginePreference;
  modelConfig?: AgentConfig;
  pi?: PiAgentRuntimeAdapterOptions;
}

export function resolveAgentRuntimeEngine(
  engine?: string | null,
): AgentRuntimeEnginePreference {
  if (!engine) return "pi";
  if (engine === "pi") return "pi";
  throw new AgentRuntimeUnavailableError(
    "unknown_engine",
    `Unknown agent runtime engine: ${engine}`,
  );
}

export function createAgentRuntime(
  input: CreateAgentRuntimeInput,
): AgentRuntime {
  const engine = resolveAgentRuntimeEngine(input.engine);
  const config = input.modelConfig;
  const pi = input.pi ?? (config ? createPiRuntimeOptionsFromModelConfig({apiKey:config.apiKey,baseUrl:config.baseUrl,model:config.model ?? '',protocol:config.providerConfig?.protocol as any}) : undefined);
  if (!pi) {
    throw new AgentRuntimeUnavailableError(
      "pi_not_configured",
      "Pi agent runtime was requested, but no Pi model/runtime options were provided.",
    );
  }

  return createPiAgentRuntime(pi);
}
