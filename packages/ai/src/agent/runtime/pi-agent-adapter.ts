import { Agent } from "@earendil-works/pi-agent-core";
import { PiHarnessRuntimeAdapter } from "./pi-harness-adapter";
import type {
  AgentEvent as PiAgentEvent,
  AgentHarnessStreamOptions,
  AgentTool,
  StreamFn,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";

import type { AgentMessage, TaskPlan } from "../types";
import type {
  AgentRuntime,
  AgentRuntimeMetadata,
  AgentRuntimeRequest,
} from "./types";
import { createPiStreamDiagnostics, observePiStreamFn } from "./pi-stream-diagnostics";
import { preparePiConversationHistory } from "./pi-conversation-history";

export interface PiAgentRuntimeAdapterOptions {
  /** New runs use Harness; select agent explicitly for rollback. */
  adapter?: "harness" | "agent";
  model: Model<any>;
  streamFn: StreamFn;
  systemPrompt?: string;
  tools?: AgentTool<any>[];
  toolExecution?: ToolExecutionMode;
  streamOptions?: AgentHarnessStreamOptions;
  version?: string;
}

type PendingRun = {
  agent: Agent;
  abortController: AbortController;
};

function isTextContent(block: unknown): block is TextContent {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text"
  );
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .map((block) => (isTextContent(block) ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function stringifyToolResult(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return (result as { content: unknown[] }).content
      .map((block) => {
        if (isTextContent(block)) return block.text;
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

export function mapPiEvent(event: PiAgentEvent): AgentMessage[] {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      return [{ type: "text", content: update.delta, answerPhase: "draft" }];
    }
    if (update.type === "thinking_delta") {
      return [{ type: "reasoning", content: update.delta }];
    }
    if (update.type === "error") {
      return [
        {
          type: "error",
          message: update.error.errorMessage ?? "Pi agent stream error",
        },
      ];
    }
    return [];
  }

  if (event.type === "message_end") {
    const message = event.message;
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant"
    ) {
      const assistant = message as AssistantMessage;
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        return [{ type: "error", message: assistant.errorMessage ?? "Pi agent stream error" }];
      }
      const text = assistantText(assistant);
      if (text.length > 0) {
        return [
          {
            type: "result",
            content: text,
            cost: assistant.usage?.cost.total,
            answerPhase: assistant.stopReason === "stop"
              && !assistant.content.some((block) => block.type === "toolCall")
              ? "candidate_final" : "intermediate",
          },
        ];
      }
    }
    return [];
  }

  if (event.type === "tool_execution_start") {
    return [
      {
        type: "tool_use",
        id: event.toolCallId,
        name: event.toolName,
        input: event.args,
      },
    ];
  }

  if (event.type === "tool_execution_end") {
    const details = typeof event.result === "object" && event.result !== null
      ? (event.result as { details?: unknown }).details : undefined;
    const hostDetails = typeof details === "object" && details !== null
      && "result" in details && "trace" in details
      ? details as { result: unknown; trace: unknown } : undefined;
    return [
      {
        type: "tool_result",
        toolUseId: event.toolCallId,
        output: stringifyToolResult(event.result),
        isError: event.isError,
        ...(hostDetails ? { toolResultDetails: hostDetails } : {}),
      },
    ];
  }

  if (event.type === "agent_end") {
    return [{ type: "done" }];
  }

  return [];
}

async function* unsupportedOperation(
  operation: AgentRuntimeRequest["operation"],
): AsyncGenerator<AgentMessage> {
  yield {
    type: "error",
    message: `Pi runtime does not support ${operation} yet`,
  };
  yield { type: "done" };
}

export class PiAgentRuntimeAdapter implements AgentRuntime {
  readonly metadata: AgentRuntimeMetadata;
  private readonly pendingRuns = new Map<string, PendingRun>();
  private readonly plans = new Map<string, TaskPlan>();

  constructor(private readonly options: PiAgentRuntimeAdapterOptions) {
    this.metadata = {
      engine: "pi",
      adapter: "pi-agent-core",
      version: options.version ?? "0.85.1",
    };
  }

  async *run(request: AgentRuntimeRequest): AsyncGenerator<AgentMessage> {
    if (request.operation !== "run") {
      yield* unsupportedOperation(request.operation);
      return;
    }

    const abortController =
      request.options?.abortController ?? new AbortController();
    let history: ReturnType<typeof preparePiConversationHistory>;
    try {
      history = preparePiConversationHistory(request.options?.conversation, this.options.model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
      yield { type: "runtime_terminal", runtimeTerminal: {
        schemaVersion: "agent-runtime-terminal.v1", status: "failed",
        cleanupStatus: "completed", error: message,
      } };
      yield { type: "done" };
      return;
    }
    const diagnostics = createPiStreamDiagnostics(abortController.signal);
    const admittedStream: StreamFn = async (model, context, options) => {
      abortController.signal.throwIfAborted();
      try { await request.options?.onBeforeProviderRequest?.(); }
      catch (error) { abortController.abort(); throw error; }
      abortController.signal.throwIfAborted();
      return this.options.streamFn(model, context, options);
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: this.options.systemPrompt ?? "",
        model: this.options.model,
        tools: this.options.tools ?? [],
        thinkingLevel: "off",
        messages: history,
      },
      streamFn: observePiStreamFn(admittedStream, abortController.signal, diagnostics),
      sessionId: request.options?.sessionId,
      toolExecution: this.options.toolExecution ?? "sequential",
    });
    const sessionId = request.options?.sessionId;
    if (sessionId) {
      this.pendingRuns.set(sessionId, { agent, abortController });
    }

    const messages: AgentMessage[] = [];
    let wake: (() => void) | undefined;
    let finished = false;

    const notify = () => {
      wake?.();
      wake = undefined;
    };

    const unsubscribe = agent.subscribe((event) => {
      const mapped = mapPiEvent(event);
      const hasDiagnostics = (message: AgentMessage) => message.type === "error" || message.type === "result" || message.type === "done";
      const snapshot = mapped.some(hasDiagnostics) ? diagnostics.snapshot() : undefined;
      messages.push(...mapped.map(message => hasDiagnostics(message) && snapshot
        ? { ...message, providerStreamDiagnostics: snapshot } : message));
      notify();
    });

    const promptPromise = agent
      .prompt(request.prompt)
      .catch((error) => {
        messages.push({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          ...(diagnostics.snapshot() ? { providerStreamDiagnostics: diagnostics.snapshot() } : {}),
        });
      })
      .finally(() => {
        finished = true;
        unsubscribe();
        if (sessionId) {
          this.pendingRuns.delete(sessionId);
        }
        notify();
      });

    const abortListener = () => agent.abort();
    abortController.signal.addEventListener("abort", abortListener, {
      once: true,
    });

    try {
      while (!finished || messages.length > 0) {
        const next = messages.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      await promptPromise;
    } finally {
      abortController.signal.removeEventListener("abort", abortListener);
    }
  }

  async stop(sessionId: string): Promise<void> {
    const pending = this.pendingRuns.get(sessionId);
    pending?.abortController.abort();
    pending?.agent.abort();
  }

  getPlan(planId: string): TaskPlan | undefined {
    return this.plans.get(planId);
  }

  deletePlan(planId: string): void {
    this.plans.delete(planId);
  }
}

export function createPiAgentRuntime(
  options: PiAgentRuntimeAdapterOptions,
): AgentRuntime {
  const adapter = options.adapter ?? process.env.PI_RUNTIME_ADAPTER ?? "harness";
  if (adapter === "agent") return new PiAgentRuntimeAdapter(options);
  if (adapter === "harness") return new PiHarnessRuntimeAdapter(options);
  throw new Error(`Unknown PI_RUNTIME_ADAPTER: ${adapter}`);
}
