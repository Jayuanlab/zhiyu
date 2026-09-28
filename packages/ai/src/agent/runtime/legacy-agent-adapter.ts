import type { AgentMessage, IAgent, TaskPlan } from "../types";
import type {
  AgentRuntime,
  AgentRuntimeEngine,
  AgentRuntimeMetadata,
  AgentRuntimeRequest,
} from "./types";

export interface LegacyAgentRuntimeAdapterOptions {
  engine?: AgentRuntimeEngine;
  adapter?: string;
  version?: string;
}

export class LegacyAgentRuntimeAdapter implements AgentRuntime {
  readonly metadata: AgentRuntimeMetadata;

  constructor(
    private readonly agent: IAgent,
    options: LegacyAgentRuntimeAdapterOptions = {},
  ) {
    this.metadata = {
      engine: options.engine ?? "claude",
      adapter: options.adapter ?? "legacy-agent",
      version: options.version ?? "1.0.0",
    };
  }

  run(request: AgentRuntimeRequest): AsyncGenerator<AgentMessage> {
    if (request.operation === "run") {
      return this.agent.run(request.prompt, request.options);
    }
    if (request.operation === "plan") {
      return this.agent.plan(request.prompt, request.options);
    }
    return this.agent.execute(request.options);
  }

  stop(sessionId: string): Promise<void> {
    return this.agent.stop(sessionId);
  }

  getPlan(planId: string): TaskPlan | undefined {
    return this.agent.getPlan(planId);
  }

  deletePlan(planId: string): void {
    this.agent.deletePlan(planId);
  }
}

export function createLegacyAgentRuntime(
  agent: IAgent,
  options?: LegacyAgentRuntimeAdapterOptions,
): AgentRuntime {
  return new LegacyAgentRuntimeAdapter(agent, options);
}
