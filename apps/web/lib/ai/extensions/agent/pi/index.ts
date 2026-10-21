import {
  BaseAgent,
  createPiAgentRuntime,
  createPiRuntimeOptionsFromModelConfig,
  type PiModelProtocol,
} from "@openzhiyu/ai/agent";
import { defineAgentPlugin } from "@openzhiyu/ai/agent/plugin";
import type { AgentPlugin } from "@openzhiyu/ai/agent/plugin";
import type {
  AgentConfig,
  AgentMessage,
  AgentOptions,
  ExecuteOptions,
  PlanOptions,
  TaskPlan,
} from "@openzhiyu/ai/agent/types";
import type { AgentRuntime } from "@openzhiyu/ai/agent/runtime";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const WEB_CHAT_PI_PROVIDER_TIMEOUT_MS = 120_000;

function resolvePiProtocol(config: AgentConfig): PiModelProtocol {
  const configured = config.providerConfig?.protocol;
  if (
    configured === "anthropic-messages" ||
    configured === "openai-responses" ||
    configured === "openai-completions"
  ) {
    return configured;
  }
  return "openai-responses";
}

function createTextPlan(prompt: string): TaskPlan {
  const trimmed = prompt.trim();
  const goal =
    trimmed.length > 120 ? `${trimmed.slice(0, 117).trimEnd()}...` : trimmed;
  return {
    id: crypto.randomUUID(),
    goal: goal || "Respond to the user's request",
    steps: [
      {
        id: "understand",
        description: "Clarify the requested answer",
        status: "pending",
      },
      {
        id: "respond",
        description: "Generate the final response",
        status: "pending",
      },
    ],
    notes:
      "Pi Web Chat migration currently supports text plan/execute, read-only platformRecall/time/webSearch/workshop manifest capability/review/agent inspection/knowledge document list/full document read/search/unified memory/memory path/chat insight/contact query/Brain read and grant list/Loop list/WeChat health tools, owner-scoped Loop status controls, owner-reviewable WeChat message previews, workshop change proposals, Insight change proposals, and paused Loop task and Loop change proposals, plus read-only text attachments, PDF/Word text extraction, workspace text files, RAG, and skills context. MCP, sandbox, original binary file access, direct WeChat sending, and external actions remain disabled by API boundary.",
    createdAt: new Date(),
  };
}

function createExecutionPrompt(options: ExecuteOptions, plan: TaskPlan) {
  const steps = plan.steps
    .map((step, index) => `${index + 1}. ${step.description}`)
    .join("\n");
  return `Execute the approved Pi Web Chat plan below.\n\nGoal:\n${plan.goal}\n\nApproved steps:\n${steps}\n\nNotes:\n${plan.notes ?? "None"}\n\nOriginal user request:\n${options.originalPrompt}\n\nRespond to the user directly. You may use read-only context already included in the prompt, the read-only platformRecall/time/webSearch/workshop manifest capability/review/agent inspection/knowledge document list/full document read/search/unified memory/memory path/chat insight/contact query/Brain read and grant list/Loop list/WeChat health tools, the owner-scoped Loop status control tool, and owner-reviewable WeChat message preview, workshop change, Insight change, and Loop task and Loop change proposal tools when needed. For questions about Zhiyu architecture, Work, Loop, Brain memory, grants, tools, provider capability, or platform information coverage, use platformRecall first when it is available. Do not claim to have used MCP, sandbox, original binary file access, direct WeChat sending, or external actions. Uploaded PDFs and Word documents are available only as extracted text when that context was included in the prompt.`;
}

export class PiAgent extends BaseAgent {
  readonly provider = "pi" as const;
  private readonly activeRuntimes = new Map<string, AgentRuntime>();

  constructor(config: AgentConfig) {
    super(config);
  }

  private createRuntime(tools?: AgentTool<any>[]) {
    return createPiAgentRuntime({
      ...createPiRuntimeOptionsFromModelConfig({
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
        model: this.config.model ?? "",
        protocol: resolvePiProtocol(this.config),
        providerId:
          typeof this.config.providerConfig?.providerId === "string"
            ? this.config.providerConfig.providerId
            : undefined,
        providerName:
          typeof this.config.providerConfig?.providerName === "string"
            ? this.config.providerConfig.providerName
            : undefined,
      }),
      streamOptions: {
        timeoutMs: WEB_CHAT_PI_PROVIDER_TIMEOUT_MS,
      },
      tools,
    });
  }

  private async *runWithRuntime(
    request: Parameters<AgentRuntime["run"]>[0],
  ): AsyncGenerator<AgentMessage> {
    const sessionId =
      request.operation === "execute"
        ? request.options.sessionId
        : request.options?.sessionId;
    const tools =
      request.operation === "execute"
        ? request.options.runtimeTools
        : request.options?.runtimeTools;
    const runtime = this.createRuntime(tools);
    request.options?.onRuntimeSelected?.(runtime.metadata);
    if (sessionId) {
      this.activeRuntimes.set(sessionId, runtime);
    }
    try {
      yield* runtime.run(request);
    } finally {
      if (sessionId && this.activeRuntimes.get(sessionId) === runtime) {
        this.activeRuntimes.delete(sessionId);
      }
    }
  }

  override getCapabilities() {
    return {
      features: ["run", "plan", "execute", "stop"],
      supportsPlan: true,
      supportsStreaming: true,
      supportsSandbox: false,
    };
  }

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentMessage> {
    yield* this.runWithRuntime({
      operation: "run",
      prompt,
      options,
    });
  }

  async *plan(
    prompt: string,
    _options?: PlanOptions,
  ): AsyncGenerator<AgentMessage> {
    const plan = createTextPlan(prompt);
    this.storePlan(plan);
    yield {
      type: "plan",
      plan,
    };
    yield { type: "done" };
  }

  async *execute(options: ExecuteOptions): AsyncGenerator<AgentMessage> {
    const plan = options.plan ?? this.getPlan(options.planId);
    if (!plan) {
      yield {
        type: "error",
        message: "Plan not found or expired. Please re-plan before executing.",
      };
      yield { type: "done" };
      return;
    }
    yield* this.runWithRuntime({
      operation: "run",
      prompt: createExecutionPrompt(options, plan),
      options,
    });
  }

  override async stop(sessionId: string): Promise<void> {
    await this.activeRuntimes.get(sessionId)?.stop(sessionId);
    await super.stop(sessionId);
  }
}

export const piPlugin: AgentPlugin = defineAgentPlugin({
  metadata: {
    type: "pi",
    name: "Pi Agent",
    version: "0.85.1",
    description:
      "Pi agent-core runtime for streamed Web Chat run and plan/execute with read-only platformRecall/time/webSearch/workshop manifest capability/review/agent inspection/knowledge document list/full document read/search/unified memory/memory path/chat insight/contact query/Brain read and grant list/Loop list/WeChat health tools plus owner-scoped Loop status controls, owner-reviewable WeChat message previews, workshop change proposals, Insight change proposals, paused Loop task and Loop change proposals, read-only text attachments, PDF/Word text extraction, workspace text files, RAG, and skills context. Direct WeChat sending, sandbox, MCP, and original binary file access remain gated until parity migration is complete.",
    capabilities: {
      run: true,
      plan: true,
      execute: true,
      streaming: true,
      readOnlyContext: {
        textAttachments: true,
        workspaceTextFiles: true,
        ragDocuments: true,
        skills: true,
      },
      readOnlyTools: {
        platformRecall: true,
        time: true,
        webSearch: true,
        listWorkshopManifestCapabilities: true,
        reviewWorkshopManifestYaml: true,
        inspectWorkshopAgent: true,
        listKnowledgeBaseDocuments: true,
        getFullDocumentContent: true,
        searchKnowledgeBase: true,
        searchUnifiedMemory: true,
        searchMemoryPath: true,
        chatInsight: true,
        queryContacts: true,
        brainListMemories: true,
        brainListCandidates: true,
        brainListSnapshots: true,
        brainListGrants: true,
        listLoopTasks: true,
        wechatDesktopHealth: true,
      },
      controlledWriteTools: {
        setLoopTaskStatus: true,
      },
      reviewableWriteTools: {
        wechatDesktopPreviewMessage: true,
        proposeWorkshopAgentChange: true,
        proposeInsightChange: true,
        proposeWorkshopLoopTask: true,
        proposeWorkshopLoopChange: true,
      },
      claudeOnlyTools: {
        applyInsightChange: true,
        updateLoopTask: true,
        deleteLoopTask: true,
      },
      disabled: {
        mcp: true,
        sandbox: true,
        binaryFiles: true,
        images: true,
        externalActions: true,
      },
    },
    builtin: true,
    supportsPlan: true,
    supportsStreaming: true,
    supportsSandbox: false,
    supportedModels: ["qwen-plus", "qwen-max", "gpt-4.1", "gpt-5.4"],
    defaultModel: "qwen-plus",
    tags: ["pi", "agent-core", "openai-compatible", "streaming"],
  },
  factory: (config) => new PiAgent(config),
});
