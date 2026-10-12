import { AsyncLocalStorage } from "node:async_hooks";
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
      /** Host outer serializer only. Never a model argument or source action. */
      fitsModelText?: (text: string, result?: unknown) => boolean;
    },
  ) => Promise<TResult> | TResult;
  formatResult?: (result: TResult) => string;
  formatContent?: (result: TResult) => AgentToolResult<unknown>["content"];
  onTrace?: (trace: RuntimeToolTraceEvent) => void | Promise<void>;
  /** Host-only receipt: called only after guarded execution and formatting succeed. */
  onResultConstructed?: (receipt: GuardedPiToolReceipt) => void | Promise<void>;
}

export interface GuardedPiToolReceipt {
  toolCallId: string;
  toolName: string;
  params: unknown;
  result: unknown;
  trace: RuntimeToolTraceEvent;
  observedAt: string;
  modelText: string;
}

export type EnvelopeGuardedPiTool<TParameters extends TSchema = TSchema> = AgentTool<TParameters> & {
  /** Same guard and handler as execute; only the trusted composing host calls this. */
  executeForEnvelope: (toolCallId: string, params: Static<TParameters>, fitsModelText: (text: string, result?: unknown) => boolean,
    signal?: AbortSignal) => ReturnType<AgentTool<TParameters>["execute"]>;
};

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
): AgentTool<TParameters, { result: TResult; trace: RuntimeToolTraceEvent }> & EnvelopeGuardedPiTool<TParameters> {
  // A per-tool asynchronous host scope preserves ordinary execute wrappers and
  // concurrent call isolation. It stores only this call's pure serializer fit.
  const envelopeFit = new AsyncLocalStorage<(text: string, result?: unknown) => boolean>();
  const execute = async (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal) => {
      const fitsModelText = envelopeFit.getStore();
      const outcome = await executeGuardedRuntimeTool({
        toolName: definition.name,
        toolUseId: toolCallId,
        input: params,
        policy: definition.policy,
        handler: (input) => definition.execute(input, { toolCallId, signal, ...(fitsModelText ? { fitsModelText } : {}) }),
      });
      await definition.onTrace?.(outcome.trace);
      if (!outcome.ok) throw new GuardedPiToolExecutionError(outcome.error, outcome);
      const result = piToolResult(outcome.result, outcome.trace, definition.formatResult, definition.formatContent);
      const modelText = result.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n");
      if (fitsModelText && fitsModelText(modelText, outcome.result) !== true) throw Error("guarded_result_exceeds_host_envelope");
      await definition.onResultConstructed?.({
        toolCallId, toolName: definition.name, params, result: outcome.result, trace: outcome.trace,
        observedAt: new Date().toISOString(),
        modelText,
      });
      return result;
  };
  const tool: AgentTool<TParameters, { result: TResult; trace: RuntimeToolTraceEvent }> & EnvelopeGuardedPiTool<TParameters> = {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.parameters,
    replay: definition.replay ?? "never",
    executionMode: definition.executionMode ?? "sequential",
    prepareArguments: definition.prepareArguments,
    execute: (toolCallId, params, signal) => execute(toolCallId, params, signal),
    executeForEnvelope: (toolCallId, params, fitsModelText, signal) => envelopeFit.run(fitsModelText, () => tool.execute(toolCallId, params, signal)),
  };
  return tool;
}

export function createGuardedPiTools(
  definitions: GuardedPiToolDefinition[],
): AgentTool<any>[] {
  return definitions.map((definition) => createGuardedPiTool(definition));
}
