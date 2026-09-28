import type { AgentConfig, IAgent } from "@openzhiyu/ai/agent/types";
import {
  createLegacyAgentRuntime,
  createPiAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeEngine,
  type PiAgentRuntimeAdapterOptions,
} from "@openzhiyu/ai/agent/runtime";

import { createClaudeAgent } from "@/lib/ai/extensions";

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
  claudeConfig: AgentConfig;
  pi?: PiAgentRuntimeAdapterOptions;
  createClaudeAgentOverride?: (config: AgentConfig) => IAgent;
}

export function resolveAgentRuntimeEngine(
  engine?: string | null,
): AgentRuntimeEnginePreference {
  if (!engine || engine === "claude") return "claude";
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
  if (engine === "claude") {
    const agent = input.createClaudeAgentOverride
      ? input.createClaudeAgentOverride(input.claudeConfig)
      : createClaudeAgent(input.claudeConfig);
    return createLegacyAgentRuntime(agent, {
      engine: "claude",
      adapter: "claude-agent-sdk",
    });
  }

  if (!input.pi) {
    throw new AgentRuntimeUnavailableError(
      "pi_not_configured",
      "Pi agent runtime was requested, but no Pi model/runtime options were provided.",
    );
  }

  return createPiAgentRuntime(input.pi);
}
