import type {
  AgentMessage,
  AgentOptions,
  ExecuteOptions,
  PlanOptions,
  TaskPlan,
} from "../types";

export type AgentRuntimeEngine = "claude" | "pi";

export type AgentRuntimeOperation = "run" | "plan" | "execute";

export interface AgentRuntimeMetadata {
  engine: AgentRuntimeEngine;
  adapter: string;
  version: string;
}

export type AgentRuntimeRequest =
  | {
      operation: "run";
      prompt: string;
      options?: AgentOptions;
    }
  | {
      operation: "plan";
      prompt: string;
      options?: PlanOptions;
    }
  | {
      operation: "execute";
      options: ExecuteOptions;
    };

export interface AgentRuntime {
  readonly metadata: AgentRuntimeMetadata;

  run(request: AgentRuntimeRequest): AsyncGenerator<AgentMessage>;

  stop(sessionId: string): Promise<void>;

  getPlan(planId: string): TaskPlan | undefined;

  deletePlan(planId: string): void;
}
