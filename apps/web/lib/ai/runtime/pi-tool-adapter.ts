import type {
  AgentTool,
  AgentToolResult,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";

import {
  executeGuardedRuntimeTool,
  type GuardedRuntimeToolOutcome,
  type RuntimeToolPolicy,
  type RuntimeToolTraceEvent,
} from "./tool-executor";

export class GuardedPiToolExecutionError extends Error {
  readonly trace: RuntimeToolTraceEvent;
  readonly outcome: GuardedRuntimeToolOutcome<unknown>;

  constructor(message: string, outcome: GuardedRuntimeToolOutcome<unknown>) {
    super(message);
    this.name = "GuardedPiToolExecutionError";
    this.trace = outcome.trace;
    this.outcome = outcome;
  }
}

export interface GuardedPiToolDefinition<
  TParameters extends TSchema = TSchema,
  TResult = unknown,
> {
  name: string;
  label?: string;
  description: string;
  parameters: TParameters;
  policy?: RuntimeToolPolicy;
  replay?: AgentTool<TParameters>["replay"];
  executionMode?: ToolExecutionMode;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    params: Static<TParameters>,
    context: {
      toolCallId: string;
      signal?: AbortSignal;
    },
  ) => Promise<TResult> | TResult;
  formatResult?: (result: TResult) => string;
  formatContent?: (result: TResult) => AgentToolResult<unknown>["content"];
  onTrace?: (trace: RuntimeToolTraceEvent) => void | Promise<void>;
}

function resultText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function piToolResult<TResult>(
  result: TResult,
  trace: RuntimeToolTraceEvent,
  formatResult?: (result: TResult) => string,
  formatContent?: (result: TResult) => AgentToolResult<unknown>["content"],
): AgentToolResult<{
  result: TResult;
  trace: RuntimeToolTraceEvent;
}> {
  const text = formatResult ? formatResult(result) : resultText(result);
  return {
    content: formatContent ? formatContent(result) : [{ type: "text", text }],
    details: {
      result,
      trace,
    },
  };
}

export function createGuardedPiTool<
  TParameters extends TSchema,
  TResult = unknown,
>(
  definition: GuardedPiToolDefinition<TParameters, TResult>,
): AgentTool<TParameters, { result: TResult; trace: RuntimeToolTraceEvent }> {
  return {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.parameters,
    replay: definition.replay ?? "never",
    executionMode: definition.executionMode ?? "sequential",
    prepareArguments: definition.prepareArguments,
    execute: async (toolCallId, params, signal) => {
      const outcome = await executeGuardedRuntimeTool({
        toolName: definition.name,
        toolUseId: toolCallId,
        input: params,
        policy: definition.policy,
        handler: (input) =>
          definition.execute(input, {
            toolCallId,
            signal,
          }),
      });
      await definition.onTrace?.(outcome.trace);

      if (!outcome.ok) {
        throw new GuardedPiToolExecutionError(outcome.error, outcome);
      }

      return piToolResult(
        outcome.result,
        outcome.trace,
        definition.formatResult,
        definition.formatContent,
      );
    },
  };
}

export function createGuardedPiTools(
  definitions: GuardedPiToolDefinition[],
): AgentTool<any>[] {
  return definitions.map((definition) => createGuardedPiTool(definition));
}
