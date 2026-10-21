/**
 * Agent SDK Abstraction Layer - Type Definitions
 *
 * This module defines the common interfaces for different agent implementations.
 * Supports: Claude Agent SDK, DeepAgents.js, and custom implementations.
 */

// ============================================================================
// Re-export from sandbox package
// ============================================================================

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SandboxConfig, SandboxProviderType } from "./sandbox/types";
import type { AgentRuntimeMetadata } from "./runtime/types";

// Re-export as types (for external consumers)
export type { SandboxConfig, SandboxProviderType };

// ============================================================================
// Minimal inlined types (from provider-core)
// ============================================================================

export interface ProviderCapabilities {
  [key: string]: boolean | string | string[] | undefined;
}

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Model configuration for custom API endpoints
 */
export interface ModelConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  thinkingLevel?: "disabled" | "low" | "adaptive";
}

// ============================================================================
// Message Types
// ============================================================================

export type AgentMessageType =
  | "session"
  | "text"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error"
  | "done"
  | "runtime_terminal"
  | "answer_evidence"
  | "plan"
  | "direct_answer"
  | "question"
  | "insightsRefresh"
  | "permission_request"
  | "password_input"
  | "reasoning"
  | "preferenceUpdate"
  | "memoryUpdate";

/** Host runtime completion, emitted after cleanup; done remains an EOF marker. */
export interface AgentRuntimeTerminal {
  schemaVersion: "agent-runtime-terminal.v1";
  status: "completed" | "failed" | "aborted";
  cleanupStatus: "completed" | "failed";
  /** A host answer-delivery gate may fail after the runtime itself completed. */
  completionScope?: "runtime" | "answer_delivery";
  runtimeStatus?: "completed" | "failed" | "aborted";
  operationId?: string;
  error?: string;
}

export type AgentProviderErrorName = "Error" | "TypeError" | "RangeError" | "AbortError" | "TimeoutError"
  | "APIError" | "APIConnectionError" | "APIConnectionTimeoutError"
  | "AuthenticationError" | "PermissionDeniedError" | "BadRequestError"
  | "NotFoundError" | "ConflictError" | "UnprocessableEntityError"
  | "RateLimitError" | "InternalServerError" | "UnknownError";
export type AgentProviderErrorCode = "ETIMEDOUT" | "ECONNRESET" | "ECONNREFUSED" | "ENOTFOUND"
  | "EAI_AGAIN" | "EPIPE" | "ABORT_ERR" | "ERR_CANCELED"
  | "UND_ERR_CONNECT_TIMEOUT" | "UND_ERR_HEADERS_TIMEOUT"
  | "UND_ERR_BODY_TIMEOUT" | "UND_ERR_SOCKET" | "ERR_NETWORK";

/** Generated SDK parameters after the caller's payload hook, not HTTP attempts,
 * provider enforcement, measured usage, billing or a verified context window. */
export interface AgentSdkRequestParameters {
  schemaVersion: "pi-sdk-request-parameters.v1";
  source: "sdk_request_parameters";
  state: "unknown" | "observed" | "partial";
  totalCallbacks: number;
  omittedCallbacks: number;
  maximumRetainedCallbacks: 4;
  observerFailures: number;
  callbacks: Array<{
    callback: number;
    outcome: "pending" | "observed" | "unknown" | "ambiguous" | "hook_rejected" | "observer_error" | "after_terminal";
    tokenParameters: Array<{ field: "max_tokens" | "max_completion_tokens" | "max_output_tokens"; value: number }>;
  }>;
}

/** Host observation of a streamFn invocation, not a count of SDK HTTP requests. */
export interface AgentProviderStreamDiagnostics {
  schemaVersion: "agent-provider-stream-diagnostics.v1";
  scope: "provider_stream_invocation";
  totalInvocations: number;
  omittedInvocations: number;
  invocations: Array<{
    invocation: number;
    firstEventReceived: boolean;
    /** Invocation-local, bounded observation. Missing/unreached hooks remain unknown. */
    sdkRequestParameters?: AgentSdkRequestParameters;
    /** SDK observations only. Local configuration is not the provider's verified limit. */
    contextReceipt?: {
      schemaVersion: "pi-context-receipt.v1";
      configuredContextWindow: { value: number | null; source: "local_model_config" | "unknown" };
      configuredMaxOutputTokens: { value: number | null; source: "stream_options" | "unknown" };
      sdkInput: { serializedCharacters: number | null; characterUnit: "utf16"; messages: number | null; tools: number | null };
      usage: {
        status: "reported" | "partial" | "unknown";
        source: "sdk_result" | "unknown";
        inputTokens: number | null; outputTokens: number | null;
        cacheReadTokens: number | null; cacheWriteTokens: number | null;
        totalTokens: number | null; reasoningTokens: number | null;
      };
      stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "unknown";
      providerContextLimit: null;
      tokenizer: "unknown";
      tokenEstimate: null;
      truncation: "unknown";
      compaction: "unknown";
      evidenceIds: "unknown";
    };
    stages: Array<{
      stage: "request_start" | "first_event" | "error" | "terminal";
      elapsedMs: number;
      signalAborted: boolean;
      controllerAborted: boolean;
      firstEventKind?: "start" | "text" | "thinking" | "tool_call" | "done" | "error" | "other";
      phase?: "stream_open" | "stream_iteration" | "stream_event" | "stream_result";
      outcome?: "completed" | "failed" | "aborted";
      /** Compares terminal reasons; the final content always comes from result(). */
      terminalConsistency?: "consistent" | "event_result_mismatch" | "receipt_only";
      errorMetadataStatus?: "safe_projection" | "not_exposed";
      error?: {
        name?: AgentProviderErrorName;
        code?: AgentProviderErrorCode;
        status?: number;
        causeName?: AgentProviderErrorName;
        causeCode?: AgentProviderErrorCode;
      };
    }>;
  }>;
}

export interface AgentMessage {
  type: AgentMessageType;
  /** Unique identifier for deduplication */
  messageId?: string;
  sessionId?: string;
  content?: string;
  name?: string;
  id?: string;
  input?: unknown;
  cost?: number;
  duration?: number;
  /** A candidate is not committed until the host receives runtime_terminal. */
  answerPhase?: "draft" | "intermediate" | "candidate_final" | "committed";
  runtimeTerminal?: AgentRuntimeTerminal;
  /** Produced by the host gate, never accepted from model text. */
  answerEvidence?: Record<string, unknown>;
  /** Tool result fields */
  toolUseId?: string;
  output?: string;
  isError?: boolean;
  /** SDK tool_end's host-produced details. Requires a host construction receipt. */
  toolResultDetails?: { result: unknown; trace: unknown };
  /** Plan fields */
  plan?: TaskPlan;
  /** Host-persisted control proposal lineage. Generated text cannot issue this. */
  sourceLineage?: { version: string; revision: number; state: string; origin: string; receiptId: string; sourceCount: number;
    expiresAt: string; historicalSources: 'unknown_owner_rebased' | 'captured_at_generation' };
  /** Error fields */
  message?: string;
  /** Safe host diagnostics only; never contains provider messages or payloads. */
  providerStreamDiagnostics?: AgentProviderStreamDiagnostics;
  /** Question fields (for interactive skills) */
  question?: AgentQuestion;
  /** Insight change fields (for optimistic updates) */
  action?: "create" | "update" | "delete";
  insightId?: string;
  insight?: Record<string, unknown>;
  /** Preference update fields (for explicit user preference changes) */
  preferenceUpdate?: {
    preferenceType: string;
    value: string;
    displayLabel: string;
  };
  /**
   * Memory update fields — fired when the agent writes a user-fact markdown
   * file under the memory directory (people / projects / notes / strategy).
   * The UI surfaces this as a notification card so the user can see which
   * pieces of their information the agent just updated.
   */
  memoryUpdate?: {
    category: string;
    fileName: string;
    displayLabel: string;
    action: "create" | "update";
    description?: string;
    filePath?: string;
  };
  /** Permission request fields */
  permissionRequest?: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseID: string;
    decisionReason?: string;
    blockedPath?: string;
  };
  /** Password input fields (for sudo commands) */
  passwordInput?: {
    toolUseID: string;
    originalCommand: string;
  };
}

/**
 * Agent question for interactive skills (AskUserQuestion)
 */
export interface AgentQuestion {
  id: string;
  questions: Question[];
  status?: "pending" | "answered" | "cancelled";
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Image file paths attached to this message (saved to workspace) */
  imagePaths?: string[];
}

/**
 * Image attachment for vision capabilities
 * Either data (base64) or url (cloud-accessible) must be provided.
 */
export interface ImageAttachment {
  /** Base64 encoded image data */
  data?: string;
  /** Cloud-accessible URL (e.g. TUS blobUrl) */
  url?: string;
  mimeType: string; // e.g. 'image/png', 'image/jpeg'
}

/**
 * PDF attachment for native PDF API support
 * Used with Anthropic Claude and Google Gemini models that support PDF document blocks
 * Either data (base64) or url (cloud-accessible) must be provided.
 */
export interface PDFAttachment {
  /** Base64 encoded PDF data */
  data?: string;
  /** Cloud-accessible URL (e.g. TUS blobUrl) */
  url?: string;
  mimeType: string; // 'application/pdf'
  pageCount?: number; // Number of pages in the PDF
}

/**
 * File attachment for workspace operations
 * Used to save files to the agent's working directory
 */
export interface FileAttachment {
  name: string; // Original filename
  data: string; // Base64 encoded file data
  mimeType: string; // e.g. 'image/png', 'application/pdf', 'text/plain'
}

// ============================================================================
// Plan Types
// ============================================================================

export interface TaskPlan {
  id: string;
  goal: string;
  steps: PlanStep[];
  notes?: string;
  createdAt: Date;
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

// ============================================================================
// Agent Configuration
// ============================================================================

export type AgentProvider = "claude" | "pi" | "codex" | "deepagents" | "custom";

export interface AgentConfig {
  /** Agent provider to use */
  provider: AgentProvider;
  /** API key for the provider */
  apiKey?: string;
  /** Custom API base URL (for third-party API endpoints) */
  baseUrl?: string;
  /** Model to use (provider-specific) */
  model?: string;
  /** Thinking level for extended thinking (Claude 4.6+) */
  thinkingLevel?: "disabled" | "low" | "adaptive";
  /** Working directory for file operations */
  workDir?: string;
  /** Custom configuration for the provider */
  providerConfig?: Record<string, unknown>;
}

/**
 * Skills configuration for loading skills from different directories
 */
export interface SkillsConfig {
  /** Whether skills are globally enabled */
  enabled: boolean;
  /** Whether to load skills from user directory (~/.openzhiyu/skills) */
  userDirEnabled: boolean;
  /** Whether to load skills from app directory (workspace/skills) */
  appDirEnabled: boolean;
  /** Custom skills directory path (legacy support) */
  skillsPath?: string;
}

/**
 * MCP configuration for loading MCP servers from different config files
 */
export interface McpConfig {
  /** Whether MCP is globally enabled */
  enabled: boolean;
  /** Whether to load MCP servers from user directory (claude config) */
  userDirEnabled: boolean;
  /** Whether to load MCP servers from app directory (Zhiyu config) */
  appDirEnabled: boolean;
  /** Custom MCP config file path (legacy support) */
  mcpConfigPath?: string;
}

export interface AgentOptions {
  /** Session ID for continuing conversations */
  sessionId?: string;
  /** User session for authentication and context (used for business tools) */
  session?: any; // Session from next-auth
  /** Cloud auth token for embeddings API (needed in native mode) */
  authToken?: string;
  /** Conversation history */
  conversation?: ConversationMessage[];
  /** Working directory */
  cwd?: string;
  /** Allowed tools */
  allowedTools?: string[];
  /**
   * Provider-neutral runtime tool objects supplied by the host after policy
   * checks. Pi consumes these directly; Claude continues to use allowedTools
   * and MCP/tool configuration until its adapter is retired.
   */
  runtimeTools?: AgentTool<any>[];
  /** Tools to exclude from the allowed list */
  excludeTools?: string[];
  /** Task ID for tracking */
  taskId?: string;
  /** Abort controller for cancellation */
  abortController?: AbortController;
  /** Permission mode */
  permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";
  /** Sandbox configuration for isolated execution */
  sandbox?: SandboxConfig;
  /** Image attachments for vision capabilities */
  images?: ImageAttachment[];
  /** PDF attachments for native PDF API support */
  pdfs?: PDFAttachment[];
  /** File attachments to be saved to workspace */
  fileAttachments?: FileAttachment[];
  /** Skills configuration */
  skillsConfig?: SkillsConfig;
  /** MCP configuration */
  mcpConfig?: McpConfig;
  /** Runtime-scoped MCP servers injected by the host for one agent run. */
  customMcpServers?: Record<string, unknown>;
  /** Active character (mate) ID for character-scoped chat */
  characterId?: string;
  /** Focused insight IDs (from web agent) */
  focusedInsightIds?: string[];
  /** Focused insights data (from web agent) */
  focusedInsights?: Array<{
    id: string;
    title: string;
    description?: string | null;
    details?: unknown[] | null;
    timeline?: Array<{ title?: string; description?: string }> | null;
    groups?: string[] | null;
    platform?: string | null;
  }>;
  /** Callback for insight changes (used for optimistic updates in native agent mode) */
  onInsightChange?: (data: {
    action: "create" | "update" | "delete";
    insightId?: string;
    insight?: Record<string, unknown>;
  }) => void;
  /**
   * Callback invoked when the MCP-backed `AskUserQuestion` tool needs to ask
   * the user. Presence of this callback gates registration of the
   * `ask-user-question` MCP server — non-interactive contexts (cron,
   * subagent, execute) should not pass it.
   */
  onAskUserQuestion?: (question: AgentQuestion) => void;
  /** Callback invoked when the MCP Bash tool detects a sudo password prompt. */
  onPasswordRequired?: (request: { id: string; command: string }) => void;
  /** Callback for user preference updates from saveUserPreference tool */
  onPreferenceUpdate?: (data: {
    preferenceType: string;
    value: string;
    displayLabel: string;
  }) => void;
  /**
   * Called when the agent SDK has fully resolved a tool call's input — i.e.
   * after streaming `input_json_delta` finishes and the assistant message
   * is materialized. Hosts use this to inspect tool inputs that aren't
   * available at the initial `tool_use` emission (which fires at
   * `content_block_start` with empty/partial input under Anthropic's
   * streaming protocol). Fires at most once per `toolUseId`.
   */
  onToolUseSeen?: (data: {
    toolUseId: string;
    toolName: string;
    input: unknown;
  }) => void;
  /** Host execution fence, invoked before dispatch even in bypassPermissions.
   * Rejection stops this execution; it must never grant tool permissions. */
  onBeforeToolUse?: (data: {
    toolUseId: string;
    toolName: string;
    input: unknown;
  }) => Promise<void>;
  /** Host admission immediately before each logical provider request. Rejection
   * stops the run before sending its transcript. Physical transport retries are
   * part of the already admitted request; this grants no tool permissions. */
  onBeforeProviderRequest?: () => Promise<void>;
  /** Host observes the actual selected adapter before starting it. Only runtime
   * identity is exposed here, never credentials or provider connection config. */
  onRuntimeSelected?: (metadata: AgentRuntimeMetadata) => void;
  /** Host receipt after the SDK committed a tool result to its transcript.
   * Construction, tool_end and stream delivery are separate stages. */
  onToolContextCommitted?: (data: {
    toolCallId: string;
    entryId: string;
    modelText: string;
  }) => Promise<void>;
  /** Host receipt after the SDK committed the actual user prompt to its transcript.
   * This observes SDK context commitment, not model understanding. */
  onPromptContextCommitted?: (data: { entryId: string; modelText: string }) => Promise<void>;
  /** Host-owned run-local context edits. Absent means off. This option grants
   * no business tools and never promotes model notes to durable facts. */
  hostWorkingMemory?: import('./runtime/host-working-memory').HostWorkingMemoryOptions;
  /** Trusted host-only transport policy. It grants no tools or domain retries.
   * Absent means unchanged provider behavior; the exact provider gate is local. */
  hostProviderRecovery?: import('./runtime/provider-stream-recovery').HostProviderRecoveryOptions;
  /** Optional, host-owned one-episode readonly continuation. Absent means off.
   * Output grants must be atomically reserved from the original run budget;
   * an absent/unknown grant never starts a continuation. */
  hostReadonlyContinuation?: {
    beforeClose: () => Promise<{ followUp: string; readHandles: string[] } | null>;
    reserveOutputTokens?: () => number | null | Promise<number | null>;
    onEpisodeStarted?: (data: {
      readHandles: string[];
      maxForwards: 2;
      maxReads: 2;
      reservedOutputTokens: number;
    }) => void | Promise<void>;
  };
  /** Optional Pi Harness gate before the same run closes. It grants no tools.
   * Rejected final messages may be corrected at most twice, within the explicit
   * whole-runtime deadline and a conservatively pre-reserved output budget.
   * Mutually exclusive with hostReadonlyContinuation. Absent means off. */
  hostReportReserve?: {
    /** At most one existing site-filtered, single-result search in the two
     * closing forwards. No new tool permission is granted. */
    allowClosingSearch?: boolean;
    outputTokens:number;
    observationHeadroomTokens:number;
    onReserve?:(data:{forward:number;inputTokens:number;outputTokens:number;remainingTools:string[]})=>void|Promise<void>;
  };
  hostFinalValidation?: {
    /** Optional host commit of bounded, model-authored progress after business
     * approval. Never a synthetic model tool call or a verified fact. */
    progressFromValidatedReport?: (text: string) => { openQuestions: string[]; checkpointHash: string } | null;
    validate: (candidate: { text: string; attempt: number; signal: AbortSignal;
      /** Host-owned committed snapshot, never extracted from the model report. */
      workingMemory?: import('./runtime/host-working-memory').WorkingMemorySnapshot }) =>
      Promise<{ ok: true } | { ok: false; feedback: string }>;
    maxCorrections?: 0 | 1 | 2;
    /** Maximum report-correction forwards after the first rejected candidate;
     * at most 4. Opt-in source recovery has a separate bounded forward count. */
    maxExtraForwards?: number;
    /** Optional larger single report bound within the same finite grant. */
    perForwardOutputTokens?: number;
    /** Whole-runtime deadline, including initial execution; never renewed. */
    timeoutMs?: number;
    /** Called once when corrections or an authorized SDK summary first need
     * output. Both consume the same grant. Unknown grants fail. */
    reserveOutputTokens?: () => number | null | Promise<number | null>;
    /** Optional, host-observed recovery of already authorized missing source
     * windows. These forwards have their own small cap and still pre-deduct
     * from the same correction output grant. Once coverage is complete, the
     * recovery phase cannot reopen. No tools are granted by this option. */
    sourceRecovery?: {
      maxForwards: number;
      perForwardOutputTokens: number;
      beforeForward: () => boolean | Promise<boolean>;
      isToolAllowed: (name: string, input: unknown) => boolean;
      /** Host-owned denial receipt and optional bounded correction details.
       * Denial does not dispatch the tool. Callback failure terminates the run. */
      onToolDenied?: (data: { name: string; input: unknown }) => string | void | Promise<string | void>;
    };
    /** Opt-in SDK overflow summaries, including initial execution. Each typed
     * compaction request consumes this sublimit AND the original output grant;
     * summaries never count as final candidates or grant tools. */
    boundedCompaction?: {
      maxForwards: number;
      totalOutputTokens: number;
      perForwardOutputTokens: number;
    };
    /** Records a reserved forward before dispatch. Receipt failure terminates
     * the runtime; no provider-usage refund or extra output grant is allowed. */
    onForward?: (data: {
      phase: "source_recovery" | "report_correction" | "context_compaction";
      forward: number;
      maxForwards: number;
      maxTokens: number;
      remainingOutputTokens: number;
      /** Same SDK context estimate/clamp as streamSimple, not provider limits. */
      requestedMaxTokens: number;
      localContextWindow: number | null;
      sdkEstimatedInputTokens: number;
      capSource: "sdk_context_estimate";
    }) => void | Promise<void>;
  };
  /**
   * Called after a first-party memory tool successfully persists a durable
   * user fact. The host surfaces this as a chat notification card.
   */
  onMemoryUpdate?: (data: {
    category: string;
    fileName: string;
    displayLabel: string;
    action: "create" | "update";
    description?: string;
    filePath?: string;
  }) => void;
  /** Callback for handling permission requests from SDK */
  onPermissionRequest?: (request: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseID: string;
    decisionReason?: string;
    blockedPath?: string;
  }) => Promise<{
    behavior: "allow" | "deny";
    updatedInput?: Record<string, unknown>;
    message?: string;
  }>;
  /** Enable streaming output (default: true) */
  stream?: boolean;
  /** User-defined AI Soul prompt (custom instructions) */
  aiSoulPrompt?: string | null;
  /** User language preference for agent responses */
  language?: string | null;
  /** User timezone for date/time operations */
  timezone?: string | null;
}

export interface PlanOptions extends AgentOptions {
  /** Planning-specific options */
}

export interface ExecuteOptions extends AgentOptions {
  /** Plan ID to execute */
  planId: string;
  /** Original prompt that created the plan */
  originalPrompt: string;
  /** Sandbox configuration */
  sandbox?: SandboxConfig;
  /** Plan object (optional - if not provided, will look up by planId) */
  plan?: TaskPlan;
}

// ============================================================================
// Agent Interface
// ============================================================================

/**
 * Base interface for all agent implementations.
 * Each provider (Claude, DeepAgents, etc.) must implement this interface.
 */
export interface IAgent {
  /** Provider name */
  readonly provider: AgentProvider;

  /**
   * Run the agent with a prompt (direct execution mode)
   */
  run(prompt: string, options?: AgentOptions): AsyncGenerator<AgentMessage>;

  /**
   * Run planning phase only (returns a plan for approval)
   */
  plan(prompt: string, options?: PlanOptions): AsyncGenerator<AgentMessage>;

  /**
   * Execute an approved plan
   */
  execute(options: ExecuteOptions): AsyncGenerator<AgentMessage>;

  /**
   * Stop the current execution
   */
  stop(sessionId: string): Promise<void>;

  /**
   * Get a stored plan by ID
   */
  getPlan(planId: string): TaskPlan | undefined;

  /**
   * Delete a stored plan
   */
  deletePlan(planId: string): void;
}

// ============================================================================
// Session Management
// ============================================================================

export interface AgentSession {
  id: string;
  createdAt: Date;
  phase: "planning" | "executing" | "idle";
  isAborted: boolean;
  abortController: AbortController;
  config?: AgentConfig;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "Skill",
  "Task",
  "LSP",
  "TodoWrite",
];

// ============================================================================
// Factory Types
// ============================================================================

export type AgentFactory = (config: AgentConfig) => IAgent;

export type AgentRegistryInterface = {
  register(provider: AgentProvider, factory: AgentFactory): void;
  get(provider: AgentProvider): AgentFactory | undefined;
  create(config: AgentConfig): IAgent;
};

/**
 * API Request type for agent endpoints
 */
export interface AgentRequest {
  prompt: string;
  sessionId?: string;
  conversation?: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  /** Two-phase execution control */
  phase?: "plan" | "execute";
  planId?: string; // Reference to approved plan
  /** Workspace settings */
  workDir?: string; // Working directory for session outputs
  taskId?: string; // Task ID for session folder
  /** Provider selection (optional, defaults to env config) */
  provider?: "claude" | "pi" | "deepagents";
  /** Custom model configuration */
  modelConfig?: ModelConfig;
  /** Sandbox configuration for isolated execution */
  sandboxConfig?: SandboxConfig;
  /** Cloud auth token for embeddings API (needed in native mode) */
  authToken?: string;
}
