/**
 * Native Agent API Routes
 *
 * Provides API endpoints for native agent planning and execution.
 */

import type { NextRequest } from "next/server";
import { getAgentRegistry } from "@openzhiyu/ai/agent/registry";
import { claudePlugin, piPlugin } from "@/lib/ai/extensions";

// Set max duration for long-running agent tasks
// This prevents "TypeError: Load failed" when tool calls take a long time
// NOTE: Vercel has hard limits (Hobby: 10s, Pro: 800s)
export const maxDuration = 800;
import type {
  AgentConfig,
  AgentMessage,
  AgentOptions,
  FileAttachment,
  ImageAttachment,
} from "@openzhiyu/ai/agent/types";
import type { SandboxConfig } from "@openzhiyu/ai/agent/sandbox/types";
import { auth } from "@/app/(auth)/auth";
import { promises as fs } from "node:fs";
import { getMessagesByChatId } from "@/lib/db/chat-queries";
import { resolveNativeWorkshopManifestApplication, WorkshopManifestApplicationError } from "@/lib/ai/chat/native-workshop-manifest-application";
import { resolveNativeWorkshopRun, NativeWorkshopRunError } from "@/lib/ai/chat/native-workshop-run";
import { resolveNativeWorkshopControl } from "@/lib/ai/chat/native-workshop-control";
import { getUserInsightSettings } from "@/lib/db/insight-queries";
import path from "node:path";
import { existsSync } from "node:fs";
import { getDocument, getDocumentChunks } from "@/lib/ai/rag/langchain-service";
import { expandHomePath } from "@/lib/env/config/constants";
import { readFile } from "@/lib/storage";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import { permissionResponses } from "@/lib/ai/native-permission-state";
import { detectSudoPasswordPrompt, registerPasswordRequest } from "@/lib/ai/native-password-state";
import {
  resolveChatLoopGuardContext,
  type ChatLoopGuardContext,
  type NativeAgentPermissionRequestEvent,
  withNativeAgentLoopGuardMetadata,
} from "@/lib/loops";
import {
  previewWechatDesktopMessage,
  sendWechatDesktopMessage,
} from "@/lib/wechat-desktop/client";
import { createNativePiOpenAICompatibleMessageStream } from "@/lib/ai/native-pi-openai-fallback";
import {
  lookupStoredNativeAgentPlan,
  saveNativeAgentPlan,
} from "@/lib/ai/native-agent-plan-store";
import { getNativePiProviderCapabilityBlock } from "@/lib/ai/native-pi-provider-capabilities";
import { buildNativePiRagContext } from "@/lib/ai/native-pi-rag-context";
import { buildNativePiSkillsContext } from "@/lib/ai/native-pi-skills-context";
import { buildNativePiFileAttachmentsContext } from "@/lib/ai/native-pi-file-attachments-context";
import { buildNativePiWorkspaceFileRefsContext } from "@/lib/ai/native-pi-workspace-file-context";
import {
  normalizeNativeAgentProvider,
  resolveDefaultNativeAgentProvider,
} from "@/lib/ai/native-agent-default-provider";
import {
  createNativePiWebChatTools,
  getNativePiWebChatToolPolicy,
  resolveNativePiWebChatTurnId,
  type NativePiWebChatToolName,
} from "@/lib/ai/native-pi-web-chat-tools";
import { resolveNativePiUserConfig } from "@/lib/ai/native-pi-user-config";
import { buildPlatformRecallPromptInstruction } from "@/lib/ai/platform-recall";
import { prefetchPlatformWithJev, withPlatformEvidenceTimeBoundary } from "@/lib/ai/jev-platform-prefetch";
import { loadPlatformCapabilityContext } from "@/lib/ai/platform-capability-context";
import { buildPlatformCapabilityCatalog } from "@/lib/ai/platform-capabilities";
import { suggestPlatformCapabilities } from "@/lib/ai/platform-capability-routing";
import { getPlatformCapabilityRoutingMode, getPlatformRecallPrefetchMode } from "@/lib/brain/recall-policy";
import { guardDirectLoopRuntimeAnswer, directLoopRuntimeQuestionId } from "@/lib/ai/loop-runtime-answer-guard";
import { canCreateOwnerLoopPartialHost, closeOwnerLoopPartialSetup, createOwnerLoopPartialHost, type OwnerLoopPartialHost } from "@/lib/ai/loop-partial-host";
import { getLoop } from "@/lib/loops/service";
import {
  AgentAnswerAuditError, appendAgentAnswerAuditEvent, hashAgentAnswerPayload,
  reserveAgentAnswerTurn,
} from "@/lib/db/agent-answer-audits";
import { type AnswerEvidenceSession } from "@/lib/ai/runtime/answer-evidence-session";
import { guardExactLoopAnswer } from "@/lib/ai/runtime/answer-evidence-loop-gate";
import { createHostAnswerEvidenceSession, selectHostAnswerEvidenceContract, type HostAnswerEvidenceSelection, type HostAnswerEvidenceSession } from "@/lib/ai/runtime/answer-evidence-selection";
import { PlatformReadHandleRegistry, type PlatformReadIdentity } from "@/lib/ai/platform-read-handle-registry";
import { type PlatformAnswerSession } from "@/lib/ai/runtime/platform-answer-session";
import { guardPlatformAnswer } from "@/lib/ai/runtime/platform-answer-gate";
import { answerTextHash } from "@/lib/ai/runtime/answer-evidence-core";
import { buildMessageInterpretationInstruction, PLATFORM_MESSAGE_INTERPRETATION_SCHEMA_VERSION } from "@/lib/ai/runtime/platform-message-interpretation";
import { decideRuntimeTool, type RuntimeToolPolicy } from "@/lib/ai/runtime/tool-executor";
import { historicalStatisticsClarification } from "@/lib/ai/historical-statistics-clarification";
import { createMemoryReadBudget } from "@/lib/ai/memory-read-budget";
import { authorizePlatformPublishedRecordsForOwner, authorizePlatformFieldPageForOwner } from "@/lib/ai/platform-record-reader";
import { getSkillContent, loadSkills } from "@/lib/ai/skills/loader";

// Register native agent plugins
getAgentRegistry().register(claudePlugin);
getAgentRegistry().register(piPlugin);

interface AgentRequest {
  prompt: string;
  sessionId?: string;
  chatId?: string;
  clientRequestId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  phase?: "plan" | "execute";
  planId?: string;
  workDir?: string;
  taskId?: string;
  provider?: "claude" | "pi";
  modelConfig?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    thinkingLevel?: "disabled" | "low" | "adaptive";
  };
  sandboxConfig?: SandboxConfig;
  skillsConfig?: {
    enabled: boolean;
    userDirEnabled: boolean;
    appDirEnabled: boolean;
  };
  mcpConfig?: {
    enabled: boolean;
    userDirEnabled: boolean;
    appDirEnabled: boolean;
  };
  permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";
  images?: ImageAttachment[];
  // File attachments to be saved to workspace
  fileAttachments?: FileAttachment[];
  // RAG documents support (from web agent)
  ragDocuments?: Array<{
    id: string;
    name: string;
  }>;
  workspaceFileRefs?: Array<{
    taskId?: string;
    path: string;
    name?: string;
  }>;
  // Focused insights support (from web agent)
  focusedInsightIds?: string[];
  focusedInsights?: Array<{
    id: string;
    title: string;
    description?: string | null;
    details?: any[] | null;
    timeline?: Array<{ title?: string; description?: string }> | null;
    groups?: string[] | null;
    platform?: string | null;
  }>;
  // Cloud auth token for embeddings API (needed in Tauri mode)
  authToken?: string;
  // Optional loop policy context for advisory tool guard metadata
  loopIdForGuard?: string | null;
  // Explicit host tool allowlist. Pi validates this for capability reporting
  // before clearing SDK tools and using its migrated runtimeTools set.
  allowedTools?: string[];
}

// Helper to create SSE stream with heartbeat to keep connection alive
// SSE heartbeat sends a comment every 30 seconds to prevent idle timeouts
// from proxies, load balancers, and browsers
function createSSEStream(
  generator: AsyncGenerator<AgentMessage>,
  onClose?: () => void,
) {
  const encoder = new TextEncoder();
  const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds - safe margin for most idle timeouts

  return new ReadableStream({
    cancel() { onClose?.(); },
    async start(controller) {
      let heartbeatTimer: NodeJS.Timeout | undefined;

      // Clear heartbeat timer
      const clearHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      // Setup heartbeat to send SSE comments (ignored by clients, keeps connection alive)
      const setupHeartbeat = () => {
        heartbeatTimer = setInterval(() => {
          try {
            // SSE comment format - client ignores this but keeps connection active
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch (error) {
            // Controller already closed, stop heartbeat
            clearHeartbeat();
          }
        }, HEARTBEAT_INTERVAL_MS);
      };

      try {
        // Start heartbeat immediately
        setupHeartbeat();

        for await (const message of generator) {
          // Trusted details join receipts only on the server. They can contain
          // complete delegated records beyond the bounded model/UI excerpt.
          const publicMessage = { ...message };
          delete publicMessage.toolResultDetails;
          const data = `data: ${JSON.stringify(publicMessage)}\n\n`;
          try {
            controller.enqueue(encoder.encode(data));
          } catch (error) {
            // Abort before iterator return starts runtime cleanup.
            onClose?.();
            throw error;
          }
        }
      } catch (error) {
        console.error("[AgentAPI] Generator error:", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : String(error),
        });
        // Client may have disconnected — only send error if controller is still open
        const errorData = `data: ${JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        })}\n\n`;
        try {
          controller.enqueue(encoder.encode(errorData));
        } catch {}
      } finally {
        clearHeartbeat();
        try {
          controller.close();
        } catch {}
        // Call callback when connection closes
        onClose?.();
        // Log chat completion
        console.log("[AgentAPI] ===== CHAT COMPLETE =====");
      }
    },
  });
}

// SSE Response headers
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function normalizeOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "****") return undefined;
  return trimmed;
}

type WechatDesktopPreviewDraft = {
  recipientName: string;
  message: string;
  confirmToken?: string;
};

function isWechatDesktopSendConfirmationText(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  return /^(确认发送|确认|发送|可以发送|发吧|确认发出|确认要发送|send|confirm)$/i.test(
    normalized,
  );
}

function isWechatDesktopSendConfirmation(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  return /^(确认发送|确认|发送|可以发送|发吧|确认发出|确认要发送|send|confirm)$/i.test(
    normalized,
  );
}

function parseWechatDesktopPreviewDraftFromOutput(
  output: unknown,
): WechatDesktopPreviewDraft | null {
  if (
    (typeof output !== "string" || !output.trim()) &&
    (!output || typeof output !== "object")
  ) {
    return null;
  }

  try {
    const content = typeof output === "string" ? JSON.parse(output) : output;
    const textPayload =
      Array.isArray(content) &&
      content[0] &&
      typeof content[0] === "object" &&
      "text" in content[0] &&
      typeof content[0].text === "string"
        ? JSON.parse(content[0].text)
        : content;

    const previewResult = textPayload?.preview;
    const preview = previewResult?.preview;
    const recipientName = preview?.recipientName;
    const message = preview?.message;
    const confirmToken = previewResult?.confirmToken;

    if (
      typeof recipientName !== "string" ||
      typeof message !== "string" ||
      typeof confirmToken !== "string" ||
      !recipientName ||
      !message ||
      !confirmToken
    ) {
      return null;
    }

    return { recipientName, message, confirmToken };
  } catch {
    return null;
  }
}

function isWechatDesktopPreviewToolName(toolName: unknown) {
  if (typeof toolName !== "string") return false;
  return (
    toolName === "wechatDesktopPreviewMessage" ||
    toolName === "mcp__business-tools__wechatDesktopPreviewMessage" ||
    toolName.endsWith("__wechatDesktopPreviewMessage")
  );
}

async function findLatestWechatDesktopPreviewDraft(chatId?: string) {
  if (!chatId) return null;

  const messages = await getMessagesByChatId({ id: chatId, limit: 50 });
  const reversedMessages = [...messages].reverse();
  const latestConfirmationIndex = reversedMessages.findIndex(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.parts) &&
      message.parts.some(
        (part: { text?: unknown }) =>
          typeof (part as { text?: unknown }).text === "string" &&
          isWechatDesktopSendConfirmationText((part as { text: string }).text),
      ),
  );
  const messagesBeforeConfirmation =
    latestConfirmationIndex >= 0
      ? reversedMessages.slice(latestConfirmationIndex + 1)
      : reversedMessages;

  for (const message of messagesBeforeConfirmation) {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) {
      continue;
    }

    for (const part of [...message.parts].reverse()) {
      if (
        !part ||
        typeof part !== "object" ||
        (part as { type?: unknown }).type !== "tool-native" ||
        !isWechatDesktopPreviewToolName((part as { toolName?: unknown }).toolName)
      ) {
        continue;
      }

      const draft = parseWechatDesktopPreviewDraftFromOutput(
        (part as { toolOutput?: unknown }).toolOutput,
      );
      if (draft) return draft;
    }
  }

  for (const message of messagesBeforeConfirmation) {
    if (message.role !== "user" || !Array.isArray(message.parts)) {
      continue;
    }

    for (const part of message.parts) {
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      const parsed = parseWechatDesktopSendRequestText(text);
      if (parsed) return parsed;
    }
  }

  return null;
}

function parseWechatDesktopSendRequest(text: string): WechatDesktopPreviewDraft | null {
  const trimmed = text.trim();
  const patterns = [
    /给(?<recipient>.+?)发微信[：:]\s*(?<message>.+)$/s,
    /发微信给(?<recipient>.+?)[：:]\s*(?<message>.+)$/s,
    /微信发给(?<recipient>.+?)[：:]\s*(?<message>.+)$/s,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const recipientName = match?.groups?.recipient?.trim();
    const message = match?.groups?.message?.trim();
    if (recipientName && message) {
      return { recipientName, message };
    }
  }

  return null;
}

function parseWechatDesktopSendRequestText(
  text: string,
): WechatDesktopPreviewDraft | null {
  const trimmed = text.trim();
  const patterns = [
    /^.*?(?:帮我)?给(?<recipient>.+?)发(?:微信|消息)[：:，,]\s*(?<message>.+)$/s,
    /^.*?发(?:微信|消息)给(?<recipient>.+?)[：:，,]\s*(?<message>.+)$/s,
    /^.*?微信发给(?<recipient>.+?)[：:，,]\s*(?<message>.+)$/s,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const recipientName = match?.groups?.recipient?.trim();
    const message = match?.groups?.message?.trim();
    if (recipientName && message) {
      return { recipientName, message };
    }
  }

  return null;
}

function createWechatDesktopSendGenerator(input: {
  draft: WechatDesktopPreviewDraft;
}): AsyncGenerator<AgentMessage> {
  return (async function* () {
    const toolUseId = crypto.randomUUID();
    yield {
      type: "tool_use",
      id: toolUseId,
      name: "mcp__business-tools__wechatDesktopSendMessage",
      input: {
        recipientName: input.draft.recipientName,
        message: input.draft.message,
      },
      messageId: crypto.randomUUID(),
    };

    try {
      let result: Awaited<ReturnType<typeof sendWechatDesktopMessage>>;
      try {
        const confirmToken =
          input.draft.confirmToken ??
          (
            await previewWechatDesktopMessage({
              recipientName: input.draft.recipientName,
              message: input.draft.message,
            })
          ).confirmToken;

        result = await sendWechatDesktopMessage({
          ...input.draft,
          confirmToken,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (/does not match recipientName and message/i.test(errorMessage)) {
          throw new Error(
            [
              "桌面微信发送已中止：确认 token 与收件人或内容不匹配。",
              "这通常表示当前确认操作复用了另一条预览消息。",
              "请重新发起预览，并确认预览里的收件人和内容完全正确后再发送。",
            ].join("\n"),
          );
        }

        if (!/Invalid or expired confirmToken/i.test(errorMessage)) {
          throw error;
        }

        const refreshedPreview = await previewWechatDesktopMessage({
          recipientName: input.draft.recipientName,
          message: input.draft.message,
        });
        result = await sendWechatDesktopMessage({
          recipientName: input.draft.recipientName,
          message: input.draft.message,
          confirmToken: refreshedPreview.confirmToken,
        });
      }

      yield {
        type: "tool_result",
        toolUseId,
        output: JSON.stringify({ success: true, result }, null, 2),
        isError: false,
        messageId: crypto.randomUUID(),
      };
      yield {
        type: "text",
        content: `已调用桌面微信发送。\n\n收件人：${input.draft.recipientName}\n内容：${input.draft.message}`,
        messageId: crypto.randomUUID(),
      };
    } catch (error) {
      yield {
        type: "tool_result",
        toolUseId,
        output: JSON.stringify(
          {
            success: false,
            message: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
        isError: true,
        messageId: crypto.randomUUID(),
      };
      yield {
        type: "text",
        content: `桌面微信发送失败：${error instanceof Error ? error.message : String(error)}`,
        messageId: crypto.randomUUID(),
      };
    }

    yield { type: "done", messageId: crypto.randomUUID() };
  })();
}

function resolveEnvAnthropicCompatibleConfig() {
  const apiKey = normalizeOptionalEnv(
    process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  );
  const baseUrl = normalizeOptionalEnv(process.env.ANTHROPIC_BASE_URL);
  const model = normalizeOptionalEnv(
    process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL,
  );

  if (!apiKey && !baseUrl && !model) {
    return undefined;
  }

  return { apiKey, baseUrl, model };
}

function resolveEnvPiCompatibleConfig() {
  const apiKey = normalizeOptionalEnv(
    process.env.LLM_API_KEY ??
      process.env.OPENCODE_API_KEY,
  );
  const baseUrl = normalizeOptionalEnv(
    process.env.LLM_BASE_URL ??
      process.env.INTERACTION_PROCESSOR_LLM_BASE_URL ??
      process.env.WORKSHOP_PLANNER_LLM_BASE_URL ??
      process.env.OPENCODE_BASE_URL,
  );
  const isOpenCodeGo = baseUrl?.includes("opencode.ai/zen/go");
  const model = normalizeOptionalEnv(
    process.env.LLM_MODEL ??
      process.env.INTERACTION_PROCESSOR_LLM_MODEL ??
      process.env.WORKSHOP_PLANNER_LLM_MODEL ??
      process.env.OPENCODE_MODEL,
  ) ?? (isOpenCodeGo ? "minimax-m3" : undefined);
  const protocol: "anthropic-messages" | "openai-responses" | "openai-completions" =
    process.env.PI_AGENT_PROTOCOL === "anthropic-messages" ||
    process.env.PI_AGENT_PROTOCOL === "openai-responses" ||
    process.env.PI_AGENT_PROTOCOL === "openai-completions"
      ? process.env.PI_AGENT_PROTOCOL
      : isOpenCodeGo
        ? "openai-completions"
      : "openai-responses";
  const providerId = normalizeOptionalEnv(
    process.env.LLM_PROVIDER_ID ?? (isOpenCodeGo ? "opencode-go" : undefined),
  );

  return { apiKey, baseUrl, model, protocol, providerId };
}

const NATIVE_PI_READ_ONLY_TOOL_NAMES = new Set<NativePiWebChatToolName>([
  "askMemory",
  "listPlatformCapabilities",
  "webReadPage",
  "readPlatformSource",
  "time",
  "webSearch",
  "listWorkshopManifestCapabilities",
  "reviewWorkshopManifestYaml",
  "inspectWorkshopAgent",
  "discoverWorkshops",
  "describeWorkshop",
  "observeWorkshop",
  "listKnowledgeBaseDocuments",
  "getFullDocumentContent",
  "searchKnowledgeBase",
  "searchUnifiedMemory",
  "searchMemoryPath",
  "chatInsight",
  "queryContacts",
  "brainListMemories",
  "brainListCandidates",
  "brainListSnapshots",
  "brainListGrants",
  "platformRecall",
  "listLoopTasks",
  "wechatDesktopHealth",
]);

function isNativePiReadOnlyToolName(toolName: unknown) {
  return (
    typeof toolName === "string" &&
    NATIVE_PI_READ_ONLY_TOOL_NAMES.has(toolName as NativePiWebChatToolName)
  );
}

async function createPiOpenAICompatibleResponse(
  body: AgentRequest,
  configOverride?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  },
) {
  const envPiConfig = resolveEnvPiCompatibleConfig();
  const baseUrl = normalizeOptionalEnv(
    configOverride?.baseUrl ?? envPiConfig.baseUrl,
  );
  const apiKey = normalizeOptionalEnv(
    configOverride?.apiKey ?? envPiConfig.apiKey,
  );
  const model = normalizeOptionalEnv(
    configOverride?.model ?? envPiConfig.model,
  );

  if (!baseUrl || !apiKey || !model) {
    return null;
  }

  let generator: AsyncGenerator<AgentMessage>;
  try {
    generator = await createNativePiOpenAICompatibleMessageStream({
      prompt: body.prompt,
      conversation: body.conversation,
      config: {
        baseUrl,
        apiKey,
        model,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: `Pi AI OpenAI-compatible provider error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 500 },
    );
  }

  return new Response(createSSEStream(generator), { headers: SSE_HEADERS });
}

/**
 * Convert home directory tilde path to absolute path
 */
function resolveHomeDir(filePath: string): string {
  return expandHomePath(filePath);
}

/**
 * Save file attachments to the workspace directory
 * Returns array of saved file paths
 */
async function saveFileAttachmentsToWorkspace(
  fileAttachments: FileAttachment[],
  workDir: string,
): Promise<string[]> {
  const savedFilePaths: string[] = [];

  // Resolve the working directory path
  const resolvedWorkDir = resolveHomeDir(workDir);

  // Ensure workspace directory exists
  if (!existsSync(resolvedWorkDir)) {
    await fs.mkdir(resolvedWorkDir, { recursive: true });
    console.log("[AgentAPI] Created workspace directory:", resolvedWorkDir);
  }

  for (const attachment of fileAttachments) {
    try {
      // Decode base64 data
      const base64Data = attachment.data.includes(",")
        ? attachment.data.split(",")[1]
        : attachment.data;

      const buffer = Buffer.from(base64Data, "base64");
      const fileName = attachment.name;
      const filePath = path.join(resolvedWorkDir, fileName);

      // Write file to workspace
      await fs.writeFile(filePath, buffer);
      savedFilePaths.push(filePath);

      console.log(
        `[AgentAPI] Saved file attachment to workspace: ${fileName} -> ${filePath}`,
      );
    } catch (error) {
      console.error(
        `[AgentAPI] Failed to save file attachment: ${attachment.name}`,
        error,
      );
      // Continue with other files even if one fails
    }
  }

  return savedFilePaths;
}

/**
 * Save RAG documents to workspace by reconstructing from chunks
 *
 * NOTE: Since RAG only stores text content (not original binary files),
 * the reconstructed files are saved as .txt files with .pdf/.docx extensions preserved.
 * This preserves context about the original file type while indicating the actual content format.
 *
 * Returns array of saved file paths
 */
async function saveRAGDocumentsToWorkspace(
  ragDocuments: Array<{ id: string; name: string }>,
  workDir: string,
): Promise<string[]> {
  const savedFilePaths: string[] = [];

  // Resolve the working directory path
  const resolvedWorkDir = resolveHomeDir(workDir);

  // Ensure workspace directory exists
  if (!existsSync(resolvedWorkDir)) {
    await fs.mkdir(resolvedWorkDir, { recursive: true });
    console.log("[AgentAPI] Created workspace directory:", resolvedWorkDir);
  }

  for (const ragDoc of ragDocuments) {
    try {
      // Get document metadata from database
      const document = await getDocument(ragDoc.id);

      if (!document) {
        console.warn(`[AgentAPI] RAG document not found: ${ragDoc.id}`);
        continue;
      }

      const fileName = document.fileName;
      const filePath = path.join(resolvedWorkDir, fileName);

      // Check if we have an original binary file stored
      if (document.blobPath) {
        // Read original binary file from storage system and save it
        const fileBuffer = await readFile(document.blobPath);
        await fs.writeFile(filePath, fileBuffer);
        savedFilePaths.push(filePath);
        console.log(
          `[AgentAPI] Saved original RAG document to workspace: ${fileName} -> ${filePath} (${fileBuffer.length} bytes)`,
        );
      } else {
        // Fallback: reconstruct from chunks and save as .txt
        const chunks = await getDocumentChunks(ragDoc.id);

        if (!chunks || chunks.length === 0) {
          console.warn(`[AgentAPI] No chunks found for document: ${ragDoc.id}`);
          continue;
        }

        const sortedChunks = chunks.sort(
          (a: { chunkIndex: number }, b: { chunkIndex: number }) =>
            a.chunkIndex - b.chunkIndex,
        );

        const fullText = sortedChunks
          .map((chunk: { content: string }) => chunk.content)
          .join("\n\n");

        // Save as .txt file to indicate reconstructed content
        const txtFileName = `${fileName}.txt`;
        const txtFilePath = path.join(resolvedWorkDir, txtFileName);
        await fs.writeFile(txtFilePath, fullText, "utf-8");
        savedFilePaths.push(txtFilePath);

        console.log(
          `[AgentAPI] Saved RAG document (text reconstructed from chunks) to workspace: ${txtFileName} -> ${txtFilePath} (${chunks.length} chunks)`,
        );
      }
    } catch (error) {
      console.error(
        `[AgentAPI] Failed to save RAG document: ${ragDoc.name} (${ragDoc.id})`,
        error,
      );
      // Continue with other documents even if one fails
    }
  }

  return savedFilePaths;
}

// POST /api/native/agent - Run agent (direct execution mode)
export async function POST(req: NextRequest) {
  // Create AbortController for interrupting Agent
  const abortController = new AbortController();
  req.signal?.addEventListener("abort", () => abortController.abort(), { once: true });
  let answerSession: HostAnswerEvidenceSession | undefined;
  let selectedEvidence: HostAnswerEvidenceSelection | null = null;
  let partialHost: OwnerLoopPartialHost | undefined;
  let partialTurnId: string | undefined;
  let partialAuditSink: Parameters<typeof closeOwnerLoopPartialSetup>[0]["reservedAuditSink"];
  let partialSetupAuditState: Awaited<ReturnType<typeof closeOwnerLoopPartialSetup>> | undefined;
  let createLoadedPartialHost: ((runtimeHash: string, actualToolNames: readonly string[]) => OwnerLoopPartialHost | undefined) | undefined;
  let createLoadedAnswerSession: ((runtimeHash: string) => HostAnswerEvidenceSession) | undefined;
  let answerAuditOwnerId: string | undefined;
  let answerStreamStarted = false;
  let platformReadRegistered = false;
  const memoryReadBudget = createMemoryReadBudget();
  let platformReadRegistry: PlatformReadHandleRegistry | undefined;
  let platformReadIdentity: PlatformReadIdentity | undefined;
  const continuationRequested = process.env.PLATFORM_ANSWER_CONTINUATION === "bounded";

  try {
    // Try to read raw body text for debugging
    const rawBodyText = await req.text();
    // Parse JSON
    let body: AgentRequest;
    try {
      body = JSON.parse(rawBodyText) as AgentRequest;
    } catch (parseError) {
      console.error(
        "[AgentAPI] ERROR: Failed to parse request body:",
        parseError,
        rawBodyText,
      );
      return Response.json(
        { error: "Invalid JSON in request body" },
        { status: 400 },
      );
    }

    // Get user session for business tools
    const session = await auth();

    // Check authentication - unauthenticated users cannot run the agent
    if (!session?.user?.id) {
      console.error("[AgentAPI] ERROR: Unauthorized access attempt");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user insight settings (including aiSoulPrompt and language)
    const userSettings = await getUserInsightSettings(session.user.id);
    let chatLoopGuardContext: ChatLoopGuardContext | null = null;
    try {
      chatLoopGuardContext = await resolveChatLoopGuardContext({
        userId: session.user.id,
        loopId: body.loopIdForGuard,
      });
    } catch (error) {
      console.warn("[AgentAPI] Failed to resolve loop guard context", error);
    }

    function withLoopGuardMetadata(
      request: NativeAgentPermissionRequestEvent,
    ): NativeAgentPermissionRequestEvent {
      return withNativeAgentLoopGuardMetadata({
        context: chatLoopGuardContext,
        request,
      });
    }

    if (!body.prompt) {
      console.error("[AgentAPI] ERROR: prompt is missing or empty!");
      return Response.json({ error: "prompt is required" }, { status: 400 });
    }

    // Check again if prompt is empty string
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      console.error("[AgentAPI] ERROR: prompt is not a valid string:", {
        type: typeof body.prompt,
        value: body.prompt,
        trimmedLength: body.prompt?.trim()?.length || 0,
      });
      return Response.json(
        { error: "prompt must be a non-empty string" },
        { status: 400 },
      );
    }

    const explicitProvider =
      body.provider === undefined
        ? null
        : normalizeNativeAgentProvider(body.provider);
    if (body.provider !== undefined && !explicitProvider) {
      return Response.json(
        {
          error:
            "Unsupported native agent provider. Supported providers are claude and pi.",
          unsupportedCapabilities: [`provider:${String(body.provider)}`],
        },
        { status: 400 },
      );
    }
    const defaultProviderSelection = resolveDefaultNativeAgentProvider();
    let selectedProvider = explicitProvider ?? defaultProviderSelection.provider;
    const envAnthropicConfig = resolveEnvAnthropicCompatibleConfig();
    const userAnthropicConfig = await getUserLlmProviderConfig({
      userId: session.user.id,
      providerType: "anthropic_compatible",
    });
    const userOpenAiConfig = await getUserLlmProviderConfig({
      userId: session.user.id,
      providerType: "openai_compatible",
    });
    const hasClaudeNativeConfig = Boolean(
      normalizeOptionalEnv(envAnthropicConfig?.apiKey) ||
        (selectedProvider === "claude"
          ? normalizeOptionalEnv(body.modelConfig?.apiKey)
          : undefined) ||
        normalizeOptionalEnv(userAnthropicConfig?.apiKey),
    );

    const piCapabilityBlock = getNativePiProviderCapabilityBlock({
      ...body,
      provider: selectedProvider,
    });
    if (piCapabilityBlock) {
      if (
        !explicitProvider &&
        defaultProviderSelection.provider === "pi" &&
        hasClaudeNativeConfig
      ) {
        selectedProvider = "claude";
      } else {
      return Response.json(
        {
          error: piCapabilityBlock.error,
          unsupportedCapabilities:
            piCapabilityBlock.unsupportedCapabilities,
        },
        { status: piCapabilityBlock.status },
      );
      }
    }

    if (
      selectedProvider !== "pi" &&
      !hasClaudeNativeConfig
    ) {
      const openAICompatibleResponse = await createPiOpenAICompatibleResponse(
        body,
        userOpenAiConfig,
      );
      if (openAICompatibleResponse) {
        return openAICompatibleResponse;
      }
    }

    selectedEvidence = selectHostAnswerEvidenceContract(body.prompt, {
      loopMode: process.env.ANSWER_EVIDENCE_MODE, platformMode: process.env.PLATFORM_ANSWER_MODE,
    });
    // One host-selected read-only contract owns this turn's audit and final gate.
    if (selectedProvider === "pi" && !body.phase && selectedEvidence
      && body.chatId && body.clientRequestId && body.userMessageId && body.assistantMessageId) {
      const selection = selectedEvidence;
      const policySnapshot: RuntimeToolPolicy = { allowedTools: body.allowedTools ?? null, defaultDecision: Array.isArray(body.allowedTools) ? "deny" : "allow" };
      const runtimeSnapshot = {
        schemaVersion: "answer-request-config-intent.v1", provider: selectedProvider,
        requestedModel: body.modelConfig?.model ?? null,
        answerEvidenceMode: selection.mode, ruleVersion: selection.ruleVersion,
        auditSchemaVersion: "agent-answer-audits.v1", readerVersion: selection.readerVersion,
        scope: selection.scope, contractKind: selection.kind === "platform" ? selection.plan.kind : "exact_loop",
        platformContinuation: continuationRequested ? "bounded_requested" : "off",
        continuationAdmission: "original_output_budget_unavailable", policyHash: hashAgentAnswerPayload(policySnapshot),
      };
      const runtimeHash = hashAgentAnswerPayload(runtimeSnapshot);
      const reservation = await reserveAgentAnswerTurn({
        ownerId: session.user.id, chatId: body.chatId, clientRequestId: body.clientRequestId,
        userMessageId: body.userMessageId, assistantMessageId: body.assistantMessageId,
        requestPayloadHash: hashAgentAnswerPayload(body), schemaVersion: "agent-answer-audits.v1",
        ruleVersion: selection.ruleVersion, runtimeHash,
        payload: { answerEvidenceMode: selection.mode, runtimeSnapshot },
      });
      if (!reservation.created) return Response.json({ ...reservation, queryUrl: `/api/native/answer-audits/${reservation.turnId}` }, { status: reservation.status === "running" ? 202 : 200 });
      answerAuditOwnerId = session.user.id;
      createLoadedAnswerSession = loadedRuntimeHash => createHostAnswerEvidenceSession(selection, {
        turnId: reservation.turnId, ownerId: session.user.id,
        runtimeHash: loadedRuntimeHash, policyHash: runtimeSnapshot.policyHash, question: body.prompt,
        auditSink: event => appendAgentAnswerAuditEvent({ ownerId: session.user.id, turnId: reservation.turnId, ...event }),
        ...(selection.kind === "platform" && selection.mode === "enforce_supported" && continuationRequested ? { readonlyContinuation: {
          enabled: true as const,
          resolveReadHandle: handle => {
            if (!platformReadRegistry || !platformReadIdentity) throw Error("Platform read registry unavailable");
            return platformReadRegistry.resolve(handle, platformReadIdentity);
          }, readBudgetSnapshot: memoryReadBudget.snapshot,
        } } : {}),
        authorizeFieldPageFinal: async binding => {
          if (!platformReadRegistry || !platformReadIdentity) return false;
          try { platformReadRegistry.assertIdentity(platformReadIdentity); } catch { return false; }
          if (binding.ownerId !== session.user.id || binding.turnId !== reservation.turnId) return false;
          return await authorizePlatformFieldPageForOwner({ userId: session.user.id, binding }) === "allowed";
        },
        resolveFieldPageReadHandle: handle => {
          if (!platformReadRegistry || !platformReadIdentity) throw Error("Platform read registry unavailable");
          return platformReadRegistry.resolve(handle, platformReadIdentity);
        },
        authorizeFinal: async plan => platformReadRegistered
          && decideRuntimeTool({ toolName: "platformRecall", policy: policySnapshot, timestamp: new Date().toISOString() }).decision === "allow"
          && (selection.kind === "platform"
            ? !selection.plan.subject || (await authorizePlatformPublishedRecordsForOwner({ userId: session.user.id,
              subjects: plan?.finalAuthorizationSubjects ?? [selection.plan.subject] })).allowed
            : Boolean(await getLoop(session.user.id, selection.loopId))),
      });
      answerSession = createLoadedAnswerSession(runtimeHash);
    }

    // No selected contract/session is displaced. Missing audit identifiers leave only an uncommitted gap notice.
    const partialLoopId = directLoopRuntimeQuestionId(body.prompt);
    if (selectedProvider === "pi" && !body.phase && selectedEvidence === null && !answerSession
      && partialLoopId && canCreateOwnerLoopPartialHost({ ownerId: session.user.id, loopId: partialLoopId,
        adapter: "native_platform_recall", toolName: "platformRecall" }, body.prompt, selectedEvidence)
      && body.chatId && body.clientRequestId && body.userMessageId && body.assistantMessageId) {
      const policySnapshot: RuntimeToolPolicy = { allowedTools: body.allowedTools ?? null,
        defaultDecision: Array.isArray(body.allowedTools) ? "deny" : "allow" };
      const policyHash = hashAgentAnswerPayload(policySnapshot);
      const intent = { schemaVersion: "owner-loop-partial-host-intent.v2", ownerId: session.user.id,
        loopId: partialLoopId, originalQuestionHash: answerTextHash(JSON.stringify(body.prompt)), policyHash };
      const reservation = await reserveAgentAnswerTurn({ ownerId: session.user.id, chatId: body.chatId,
        clientRequestId: body.clientRequestId, userMessageId: body.userMessageId, assistantMessageId: body.assistantMessageId,
        requestPayloadHash: hashAgentAnswerPayload(body), schemaVersion: "agent-answer-audits.v1",
        ruleVersion: "owner-loop-partial-host.v2", runtimeHash: hashAgentAnswerPayload(intent), payload: intent });
      if (!reservation.created) return Response.json({ ...reservation, queryUrl: `/api/native/answer-audits/${reservation.turnId}` }, { status: reservation.status === "running" ? 202 : 200 });
      partialTurnId = reservation.turnId;
      partialAuditSink = event => appendAgentAnswerAuditEvent({ ownerId: session.user.id, turnId: reservation.turnId, ...event });
      createLoadedPartialHost = (runtimeHash, actualToolNames) => createOwnerLoopPartialHost({ selectedEvidence,
        context: { ownerId: session.user.id, loopId: partialLoopId, adapter: "native_platform_recall", toolName: "platformRecall" },
        originalQuestion: body.prompt, turnId: reservation.turnId, runtimeHash, policyHash, toolNames: actualToolNames,
        auditSink: event => appendAgentAnswerAuditEvent({ ownerId: session.user.id, turnId: reservation.turnId, ...event }),
        authorizeFinal: async () => platformReadRegistered
          && decideRuntimeTool({ toolName: "platformRecall", policy: policySnapshot, timestamp: new Date().toISOString() }).decision === "allow"
          && Boolean(await getLoop(session.user.id, partialLoopId)) });
    }

    // Build context with priority order: Images > RAG Documents > Focused Insights > User Question
    let finalPrompt = "";
    const contextParts: string[] = [];
    const piPlatformRecallAvailable =
      selectedProvider === "pi" &&
      (!Array.isArray(body.allowedTools) ||
        body.allowedTools.includes("platformRecall"));
    if (piPlatformRecallAvailable) {
      contextParts.push(buildPlatformRecallPromptInstruction());
    }

    if (selectedProvider === "pi" && body.skillsConfig?.enabled) {
      try {
        const skillContextItems = loadSkills().map((skill) => ({
          name: skill.name,
          description: skill.description,
          content: getSkillContent(skill.path) ?? "",
        }));
        const skillsContext = buildNativePiSkillsContext(skillContextItems);
        if (skillsContext) {
          console.log("[AgentAPI] Injecting Pi skills read-only context into prompt:", {
            skillCount: skillContextItems.length,
            contextLength: skillsContext.length,
          });
          contextParts.push(skillsContext);
        }
      } catch (error) {
        console.warn("[AgentAPI] Failed to load Pi skills context:", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (
      selectedProvider === "pi" &&
      body.fileAttachments &&
      body.fileAttachments.length > 0
    ) {
      const fileAttachmentsContext = await buildNativePiFileAttachmentsContext(
        body.fileAttachments,
      );
      if (fileAttachmentsContext) {
        console.log("[AgentAPI] Injecting Pi text file attachments into prompt:", {
          attachmentCount: body.fileAttachments.length,
          contextLength: fileAttachmentsContext.length,
        });
        contextParts.push(fileAttachmentsContext);
      }
    }

    if (
      selectedProvider === "pi" &&
      body.workspaceFileRefs &&
      body.workspaceFileRefs.length > 0 &&
      body.workDir
    ) {
      const workspaceFileContext = await buildNativePiWorkspaceFileRefsContext({
        workDir: resolveHomeDir(body.workDir),
        refs: body.workspaceFileRefs,
      });
      if (workspaceFileContext) {
        console.log("[AgentAPI] Injecting Pi workspace file refs into prompt:", {
          fileRefCount: body.workspaceFileRefs.length,
          contextLength: workspaceFileContext.length,
        });
        contextParts.push(workspaceFileContext);
      }
    }

    // 1. RAG Documents context (SECOND priority - after images which are handled by Claude agent)
    if (
      selectedProvider === "pi" &&
      body.ragDocuments &&
      body.ragDocuments.length > 0
    ) {
      const documents = await Promise.all(
        body.ragDocuments.map(async (ragDoc) => {
          try {
            const chunks = await getDocumentChunks(ragDoc.id);
            return {
              id: ragDoc.id,
              name: ragDoc.name,
              chunks: chunks.map((chunk: any) => ({
                chunkIndex: Number(chunk.chunkIndex ?? 0),
                content: String(chunk.content ?? ""),
              })),
            };
          } catch (error) {
            console.warn("[AgentAPI] Failed to load RAG document for Pi", {
              documentId: ragDoc.id,
              name: ragDoc.name,
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              id: ragDoc.id,
              name: ragDoc.name,
              chunks: [],
            };
          }
        }),
      );
      const documentContext = buildNativePiRagContext(documents);
      if (documentContext) {
        console.log("[AgentAPI] Injecting Pi RAG document content into prompt:", {
          documentCount: documents.length,
          withContentCount: documents.filter((document) => document.chunks.length > 0)
            .length,
          contextLength: documentContext.length,
        });
        contextParts.push(documentContext);
      }
    } else if (body.ragDocuments && body.ragDocuments.length > 0) {
      const ragDocumentNames = body.ragDocuments.map((doc) => doc.name);
      const ragDocumentIds = body.ragDocuments.map((doc) => doc.id);

      const documentContext = `[System Note: The user has uploaded the following documents to their strategy memory:
${ragDocumentNames.map((name, i) => `- ${name} (ID: ${ragDocumentIds[i]})`).join("\n")}

**CRITICAL INSTRUCTION**: When the user asks questions like "What's in THIS document?", "Summarize THIS file", or references "this document", they are referring to the document(s) listed above. You MUST use the searchKnowledgeBase tool with the documentIds parameter set to [${ragDocumentIds.join(", ")}] to search ONLY within these specific documents.

System Note: User has uploaded the following documents to strategy memory:
${ragDocumentNames.map((name, i) => `- ${name} (ID: ${ragDocumentIds[i]})`).join("\n")}

**IMPORTANT**: When the user asks questions like "What's in THIS document?", "Summarize THIS file", or uses expressions like "this document", they are referring to the document(s) listed above. You MUST use the searchKnowledgeBase tool and set the documentIds parameter to [${ragDocumentIds.join(", ")}] to search ONLY within these specific documents.

For general questions about the user's strategy memory or previous uploads, you can omit the documentIds parameter to search all documents.
For general questions about the user's entire strategy memory or previously uploaded documents, you can omit the documentIds parameter to search all documents.
]\n\n`;

      console.log("[AgentAPI] Injecting RAG documents context into prompt:", {
        documentCount: body.ragDocuments.length,
        documentIds: ragDocumentIds,
        contextLength: documentContext.length,
      });

      contextParts.push(documentContext);
    }

    // 2. Focused Insights context (THIRD priority - after documents)
    if (body.focusedInsights && body.focusedInsights.length > 0) {
      // Fetch notes and documents for focused insights
      let insightsNotesDocumentsMap = new Map();
      if (session?.user?.id) {
        try {
          const { getInsightsWithNotesAndDocuments } =
            await import("@/lib/db/queries");
          insightsNotesDocumentsMap = await getInsightsWithNotesAndDocuments({
            userId: session.user.id,
            insightIds: body.focusedInsights.map((i) => i.id),
          });
          console.log(
            "[AgentAPI] Fetched notes and documents for focused insights:",
            {
              insightCount: body.focusedInsights.length,
              insightsWithData: Array.from(insightsNotesDocumentsMap.keys())
                .length,
            },
          );
        } catch (error) {
          console.error(
            "[AgentAPI] Failed to fetch notes and documents for insights:",
            error,
          );
          // Continue without notes/documents
        }
      }

      const insightsContent = body.focusedInsights
        .map((insight, index) => {
          let content = `\n[${index + 1}] **${insight.title}**\n`;

          // Add description (if any)
          if (insight.description) {
            const descStr =
              typeof insight.description === "string"
                ? insight.description
                : JSON.stringify(insight.description);
            content += `   Description: ${descStr}\n`;
          }

          // More friendly display of details instead of raw JSON.stringify
          if (insight.details) {
            // Parse details if it's a string (SQLite mode stores as JSON string)
            const details =
              typeof insight.details === "string"
                ? JSON.parse(insight.details || "[]")
                : insight.details;

            if (details.length > 0) {
              content += "   Details:\n";
              details.forEach((detail: any, detailIndex: number) => {
                const detailStr =
                  typeof detail === "string" ? detail : JSON.stringify(detail);
                if (detailStr.length > 500) {
                  content += `     [${detailIndex + 1}] ${detailStr.substring(0, 500)}... (content too long, truncated)\n`;
                } else {
                  content += `     [${detailIndex + 1}] ${detailStr}\n`;
                }
              });
            }
          }

          // Add timeline events (new emails) - only title/description, deduplicated
          if (insight.timeline) {
            const timeline =
              typeof insight.timeline === "string"
                ? JSON.parse(insight.timeline || "[]")
                : insight.timeline;

            if (timeline.length > 0) {
              content += "   Recent Emails:\n";
              const seen = new Set<string>();
              timeline.forEach((event: any) => {
                const title = event?.title ?? "";
                const description = event?.description ?? "";
                const isDuplicate = title === description;
                const key = isDuplicate ? title : `${title}||${description}`;

                if (seen.has(key)) return;
                seen.add(key);

                if (isDuplicate) {
                  const truncated =
                    title.length > 200
                      ? `${title.substring(0, 200)}...`
                      : title;
                  content += `     - ${truncated}\n`;
                } else {
                  const t =
                    title.length > 200
                      ? `${title.substring(0, 200)}...`
                      : title;
                  const d =
                    description.length > 200
                      ? `${description.substring(0, 200)}...`
                      : description;
                  content += `     - ${t}: ${d}\n`;
                }
              });
            }
          }

          // Add platform info (if any)
          if (insight.platform) {
            content += `   Platform: ${insight.platform}\n`;
          }

          // Add notes
          const insightData = insightsNotesDocumentsMap.get(insight.id);
          if (insightData?.notes && insightData.notes.length > 0) {
            content += `   Notes (${insightData.notes.length}):\n`;
            insightData.notes.forEach((note: any, noteIndex: number) => {
              const noteContent =
                note.content.length > 200
                  ? `${note.content.substring(0, 200)}... (truncated)`
                  : note.content;
              content += `     [${noteIndex + 1}] ${noteContent}\n`;
            });
          }

          // Add files/documents
          if (insightData?.documents && insightData.documents.length > 0) {
            content += `   Files (${insightData.documents.length}):\n`;
            const documentIds: string[] = [];
            insightData.documents.forEach((doc: any, docIndex: number) => {
              content += `     [${docIndex + 1}] ${doc.fileName} (${(doc.sizeBytes / 1024).toFixed(2)} KB)\n`;
              documentIds.push(doc.id);
            });
            // Add note about retrieving full content from knowledge base.
            if (documentIds.length > 0) {
              if (selectedProvider === "pi") {
                content += `     Note: Pi can use read-only knowledge-base tools with documentIds [${documentIds.join(", ")}] to retrieve relevant chunks or full document text. Pi still has no file-system, MCP, or sandbox access in this run.\n`;
              } else {
                content += `     Note: You can use searchKnowledgeBase tool with documentIds parameter [${documentIds.join(", ")}] to retrieve full content from these files.\n`;
                content += `     Tip: You can use searchKnowledgeBase tool with documentIds parameter [${documentIds.join(", ")}] to retrieve full content from these files.\n`;
              }
            }
          }

          // Add ID reference
          content += `   ID: ${insight.id}\n`;

          return content;
        })
        .join("\n");

      const insightContext =
        selectedProvider === "pi"
          ? `[System Note: The user is focusing on ${body.focusedInsights.length} specific Insights. Below are the details of each focused insight, including associated notes and file metadata that are available as read-only context for Pi.

${insightsContent}

When the user refers to "this", "here", or the current focused material, first answer from the focused insights shown above. If a file is only listed by metadata and its full content is not included, use the read-only knowledge-base tools when the document IDs are available; otherwise say what context is missing. Do not claim to have file-system, MCP, sandbox, original binary/PDF file, or external action access. Uploaded PDFs and Word documents are available to Pi only when their text was extracted into the prompt context.
]\n\n`
          : `[System Note: The user is focusing on ${body.focusedInsights.length} specific Insights. Below are the details of each focused insight (including associated notes and files):

${insightsContent}

**CRITICAL INSTRUCTION**: When the user asks questions like "in this", "this", "here", or any reference that could point to these focused insights, you MUST:
1. FIRST check if their question refers to the focused insights listed above
2. Answer based on the insight details, notes, and files shown above
3. For files listed above, you can use searchKnowledgeBase tool with the documentIds parameter to retrieve their full content from the knowledge base
4. ONLY search all strategy memory if the question is clearly NOT about these insights

System Note: User is currently focusing on ${body.focusedInsights.length} specific Insights. Below are the details of each focused insight (including related notes and files):

${insightsContent}

**IMPORTANT**: When the user asks questions like "in this", "this", "here", etc., you MUST:
1. FIRST check if their question refers to the focused insights listed above
2. Answer based on the insight details, notes, and files shown above
3. For files listed above, you can use searchKnowledgeBase tool and set documentIds parameter to retrieve full content from the knowledge base
4. ONLY search all strategy memory when the question is clearly NOT about these insights

]\n\n`;

      console.log(
        "[AgentAPI] Injecting focused insights context into prompt:",
        {
          insightCount: body.focusedInsights.length,
          contextLength: insightContext.length,
        },
      );

      contextParts.push(insightContext);
    }

    // Combine all context parts with the user prompt
    finalPrompt = contextParts.join("") + body.prompt;

    // Save file attachments to workspace (if any)
    let savedFilesContext = "";
    if (
      body.fileAttachments &&
      body.fileAttachments.length > 0 &&
      body.workDir &&
      selectedProvider !== "pi"
    ) {
      try {
        const savedFilePaths = await saveFileAttachmentsToWorkspace(
          body.fileAttachments,
          body.workDir,
        );

        if (savedFilePaths.length > 0) {
          // Add context about saved files to the prompt
          savedFilesContext = `\n[System Note: The user has attached ${savedFilePaths.length} file(s) that have been saved to your workspace directory (${body.workDir}):\n${savedFilePaths.map((p, i) => `- ${path.basename(p)}`).join("\n")}\n\nYou can access these files using standard file operations like Read, Write, Edit, etc.\n\nSystem Note: User has attached ${savedFilePaths.length} file(s) that have been saved to the workspace directory (${body.workDir}):\n${savedFilePaths.map((p, i) => `- ${path.basename(p)}`).join("\n")}\n\nYou can access these files using Read, Write, Edit, and other tools.\n]\n\n`;

          console.log(
            `[AgentAPI] Saved ${savedFilePaths.length} file(s) to workspace:`,
            savedFilePaths,
          );
        }
      } catch (error) {
        console.error("[AgentAPI] Error saving file attachments:", error);
        // Continue even if file saving fails
      }
    }

    // Save RAG documents to workspace (if any)
    if (
      body.ragDocuments &&
      body.ragDocuments.length > 0 &&
      body.workDir &&
      selectedProvider !== "pi"
    ) {
      try {
        const savedRAGFilePaths = await saveRAGDocumentsToWorkspace(
          body.ragDocuments,
          body.workDir,
        );

        if (savedRAGFilePaths.length > 0) {
          // Add context about saved RAG documents to the prompt
          const ragContext = `\n[System Note: The user has uploaded ${savedRAGFilePaths.length} RAG document(s) from strategy memory that have been reconstructed and saved to your workspace directory (${body.workDir}):\n${savedRAGFilePaths.map((p, i) => `- ${path.basename(p)}`).join("\n")}\n\nNote: These are text-based reconstructions from the original documents. You can access these files using standard file operations like Read, Write, Edit, etc.\n\nSystem Note: User has extracted ${savedRAGFilePaths.length} RAG document(s) from strategy memory and reconstructed and saved them to the workspace directory (${body.workDir}):\n${savedRAGFilePaths.map((p, i) => `- ${path.basename(p)}`).join("\n")}\n\nNote: These are text-based reconstructions from original documents. You can access these files using Read, Write, Edit, and other tools.\n]\n\n`;

          savedFilesContext = ragContext + savedFilesContext;

          console.log(
            `[AgentAPI] Saved ${savedRAGFilePaths.length} RAG document(s) to workspace:`,
            savedRAGFilePaths,
          );
        }
      } catch (error) {
        console.error("[AgentAPI] Error saving RAG documents:", error);
        // Continue even if RAG document saving fails
      }
    }

    // Prepend saved files context to the prompt
    if (savedFilesContext) {
      finalPrompt = savedFilesContext + finalPrompt;
    }

    // This is part of the selected read-only answer contract, rather than a
    // new model call. The interpretation remains separate from verified facts.
    const messageInterpretationInstruction = selectedProvider === "pi" && selectedEvidence?.kind === "platform"
      ? buildMessageInterpretationInstruction(selectedEvidence.plan) : "";
    if (messageInterpretationInstruction) finalPrompt += `\n\n${messageInterpretationInstruction}`;

    const effectiveModelConfig = {
      ...envAnthropicConfig,
      ...body.modelConfig,
      ...userAnthropicConfig,
    };

    // User-saved Anthropic settings win over request defaults such as the
    // frontend's selectedModel fallback to claude-sonnet-4.6.
    const piModelConfig = resolveEnvPiCompatibleConfig();
    const effectivePiModelConfig = resolveNativePiUserConfig({ env: piModelConfig,
      request: body.modelConfig, openAI: userOpenAiConfig, anthropic: userAnthropicConfig });
    const config: AgentConfig =
      selectedProvider === "pi"
        ? {
            provider: "pi",
            apiKey: effectivePiModelConfig.apiKey,
            baseUrl: effectivePiModelConfig.baseUrl,
            model: effectivePiModelConfig.model,
            thinkingLevel: body.modelConfig?.thinkingLevel,
            workDir: body.workDir,
            providerConfig: {
              protocol: effectivePiModelConfig.protocol,
              providerId: effectivePiModelConfig.providerId,
              providerName: effectivePiModelConfig.providerId,
            },
          }
        : {
            provider: selectedProvider,
            apiKey: effectiveModelConfig.apiKey,
            baseUrl: effectiveModelConfig.baseUrl,
            model: effectiveModelConfig.model,
            thinkingLevel: body.modelConfig?.thinkingLevel,
            workDir: body.workDir,
          };

    const resolvedPlatformTurnId = resolveNativePiWebChatTurnId({ answerSessionTurnId: answerSession?.turnId, partialTurnId });
    const workshopManifestApply = selectedProvider === "pi" && !body.phase && !answerSession && !createLoadedPartialHost
      ? await resolveNativeWorkshopManifestApplication({ ownerId: session.user.id, chatId: body.chatId,
          sessionId: body.sessionId, turnId: resolvedPlatformTurnId, userMessageId: body.userMessageId, prompt: body.prompt })
      : undefined;
    if (workshopManifestApply) {
      finalPrompt += "\n\nThe server verified this owner's persisted confirmation for the exact previously reviewed Workshop YAML. "
        + "This instruction already authorizes this bound application; no separate UI confirmation is required. "
        + "Use the available zero-argument applyWorkshopManifestYaml tool to apply that bound draft. "
        + "Do not generate or substitute a new draft. Report creation only after a verified real Workshop receipt; include its Workshop link. "
        + "If application or readback fails, explain the tool's actual state and recovery step.";
    }
    const workshopRunOnce = selectedProvider === "pi" && !body.phase && !answerSession && !createLoadedPartialHost
      ? await resolveNativeWorkshopRun({ ownerId: session.user.id, chatId: body.chatId, sessionId: body.sessionId,
          turnId: resolvedPlatformTurnId, userMessageId: body.userMessageId, prompt: body.prompt }).catch(error => {
            if (error instanceof NativeWorkshopRunError && error.code === "workshop_run_target_missing") return undefined;
            throw error;
          })
      : undefined;
    if (workshopRunOnce) {
      finalPrompt += "\n\nThe server verified this owner's persisted command to run the exact active Workshop once. "
        + "This command already authorizes the bound manual run; no separate UI confirmation or Loop activation is required. "
        + "Use the available zero-argument runWorkshopOnce tool. Do not run this mission yourself in chat or change any schedule. "
        + "Report the tool's actual run ID and current state with its link. Queued or running is not completed; read the run status for results.";
    }
    const workshopControl = selectedProvider === "pi" && !body.phase && !answerSession && !createLoadedPartialHost && !workshopRunOnce && !workshopManifestApply
      ? await resolveNativeWorkshopControl({ ownerId: session.user.id, chatId: body.chatId, sessionId: body.sessionId,
          turnId: resolvedPlatformTurnId, userMessageId: body.userMessageId, prompt: body.prompt }) : undefined;
    if (workshopControl) {
      finalPrompt += "\n\nThe Control Host verified this current persisted owner instruction for one exact Workshop. "
        + JSON.stringify({ action: workshopControl.action, workshopId: workshopControl.workshopId, name: workshopControl.workshopName,
          workItemId: workshopControl.context?.workItemId, itemRevision: workshopControl.context?.itemRevision })
        + " Use the bound zero-argument named Workshop tool. The owner's command already authorizes this exact action; do not request an additional UI confirmation. "
        + "Do not substitute another target, expand permissions or execute the Workshop's domain mission in chat. "
        + "Admission is not completion; background terminal/clarification results will be added as ordinary text to this original chat. "
        + "Describe actual stored/adopted/run/acceptance state separately and give an ordinary Workshop link. Management details remain in the Workshop page.";
    }
    const capabilityContext = selectedProvider === "pi" && !body.phase && !answerSession && !createLoadedPartialHost
      && (getPlatformCapabilityRoutingMode() !== "off" || getPlatformRecallPrefetchMode() !== "off")
      ? await loadPlatformCapabilityContext({ ownerId: session.user.id, chatId: body.chatId,
          userMessageId: body.userMessageId, question: body.prompt,
          ...(workshopControl || workshopRunOnce ? { confirmedTarget: { kind: "workshop" as const,
            id: (workshopControl ?? workshopRunOnce)!.workshopId, name: (workshopControl ?? workshopRunOnce)!.workshopName } } : {}) })
      : undefined;
    platformReadIdentity = { ownerId: session.user.id, requester: { kind: "chat", id: body.chatId ?? body.sessionId ?? crypto.randomUUID() }, turnId: resolvedPlatformTurnId };
    platformReadRegistry = selectedProvider === "pi" ? new PlatformReadHandleRegistry(platformReadIdentity) : undefined;
    const nativeToolPolicy: RuntimeToolPolicy | undefined = Array.isArray(body.allowedTools)
      ? { allowedTools: body.allowedTools, defaultDecision: "deny" } : undefined;
    const nativeToolFilter = (tool: { name: string }) => (!Array.isArray(body.allowedTools) || body.allowedTools.includes(tool.name))
      && (!answerSession || selectedEvidence?.kind !== "platform" || isNativePiReadOnlyToolName(tool.name));
    const agentOptions: AgentOptions = {
      sessionId: body.sessionId,
      session: session || undefined, // Pass session for business tools
      authToken: body.authToken, // Cloud auth token for embeddings API (needed in Tauri mode)
      conversation: body.conversation,
      cwd: body.workDir,
      taskId: body.taskId,
      sandbox: selectedProvider === "pi" ? undefined : body.sandboxConfig,
      skillsConfig: body.skillsConfig,
      mcpConfig: selectedProvider === "pi" ? undefined : body.mcpConfig,
      permissionMode:
        selectedProvider === "pi" ? undefined : body.permissionMode,
      images: body.images,
      focusedInsightIds: body.focusedInsightIds,
      focusedInsights: body.focusedInsights,
      allowedTools:
        selectedProvider === "pi"
          ? []
          : [
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
            ],
      runtimeTools:
        selectedProvider === "pi"
          ? createNativePiWebChatTools({
              question: body.prompt,
              capabilityContext: capabilityContext?.context,
              turnId: resolvedPlatformTurnId,
              memoryReadBudget,
              platformReadIdentity, platformReadRegistry,
              runtimeIdentity: { model: config.model, provider: config.provider },
              userId: session.user.id,
              workshopManifestApply,
              workshopRunOnce,
              workshopControl,
              onResultConstructed: answerSession || createLoadedPartialHost
                ? receipt => answerSession ? answerSession.observeToolConstruction(receipt) : partialHost?.onResultConstructed(receipt) : undefined,
              embeddingsAuthToken: body.authToken,
              toolFilter: nativeToolFilter,
              policy: nativeToolPolicy,
            }).filter(nativeToolFilter)
          : undefined,
      aiSoulPrompt: userSettings?.aiSoulPrompt ?? null,
      language: userSettings?.language ?? null,
      abortController, // Pass AbortController for interruption
      stream: true,
      onToolContextCommitted: answerSession || createLoadedPartialHost
        ? async receipt => { if (answerSession) await answerSession.observeContextCommitted(receipt);
          else await partialHost?.onToolContextCommitted(receipt); } : undefined,
      onPromptContextCommitted: answerSession ? receipt => answerSession!.observePromptContextCommitted(receipt) : undefined,
    };

    platformReadRegistered = Boolean(agentOptions.runtimeTools?.some(tool => tool.name === "platformRecall"));
    if (createLoadedPartialHost) {
      const loaded = { schemaVersion: "owner-loop-partial-host-runtime.v2", provider: config.provider, model: config.model,
        originalQuestionHash: answerTextHash(JSON.stringify(body.prompt)), actualToolNames: agentOptions.runtimeTools?.map(tool => tool.name) ?? [],
        platformContinuation: "off", selectedEvidence: null };
      partialHost = createLoadedPartialHost(hashAgentAnswerPayload(loaded), loaded.actualToolNames);
      await partialHost?.core.append({ eventKey: "runtime_loaded", eventType: "runtime_loaded", payload: loaded });
    }
    if (createLoadedAnswerSession) {
      const loadedSnapshot = {
        schemaVersion: "answer-runtime-config.v1", provider: config.provider, model: config.model,
        answerEvidenceMode: answerSession!.mode, ruleVersion: selectedEvidence!.ruleVersion,
        auditSchemaVersion: "agent-answer-audits.v1", readerVersion: selectedEvidence!.readerVersion,
        scope: selectedEvidence!.scope, platformContinuation: "off",
        continuationRequested: continuationRequested ? "bounded" : "off", continuationAdmission: "original_output_budget_unavailable",
        actualToolNames: agentOptions.runtimeTools?.map(tool => tool.name) ?? [],
        messageInterpretationInstructionVersion: messageInterpretationInstruction ? PLATFORM_MESSAGE_INTERPRETATION_SCHEMA_VERSION : null,
        messageInterpretationInstructionHash: messageInterpretationInstruction ? answerTextHash(messageInterpretationInstruction) : null,
      };
      const actualRuntimeHash = hashAgentAnswerPayload(loadedSnapshot);
      answerSession = createLoadedAnswerSession(actualRuntimeHash);
      await appendAgentAnswerAuditEvent({ ownerId: answerAuditOwnerId!, turnId: answerSession.turnId,
        eventKey: "runtime_loaded", eventType: "runtime_loaded", payload: { ...loadedSnapshot, actualRuntimeHash } });
      if (selectedEvidence?.kind === "platform" && answerSession.mode === "enforce_supported" && continuationRequested) {
        agentOptions.hostReadonlyContinuation = {
          beforeClose: () => (answerSession as PlatformAnswerSession).beforeClose(),
          reserveOutputTokens: async () => {
            await appendAgentAnswerAuditEvent({ ownerId: answerAuditOwnerId!, turnId: answerSession!.turnId,
              eventKey: "readonly_continuation_unavailable", eventType: "readonly_continuation_unavailable",
              payload: { reason: "original_output_budget_unavailable", extraForwards: 0, extraReads: 0 } });
            return null;
          },
        };
      }
    }

    // Get agent instance
    const agent = getAgentRegistry().create(config);

    // Create permission request event queue
    const permissionRequestEventQueue: NativeAgentPermissionRequestEvent[] = [];

    // Track pending sudo commands for password input flow
    const pendingSudoCommands = new Map<
      string,
      { command: string; cwd?: string }
    >();

    let generator: AsyncGenerator<AgentMessage>;
    let generatorCompletedNormally = false;

    // Route based on phase
    if (body.phase === "plan") {
      // Planning phase only
      generator = (async function* () {
        const innerGenerator = agent.plan(finalPrompt, {
          ...agentOptions,
          onPermissionRequest: async (request) => {
            console.log("[AgentAPI] Permission request (plan mode):", request);
            // Auto-allow in plan mode since no actual execution
            return { behavior: "allow" };
          },
        });
        for await (const message of innerGenerator) {
          if (message.type === "plan" && message.plan) {
            await saveNativeAgentPlan({
              ownerId: session.user.id,
              plan: message.plan,
              originalPrompt: finalPrompt,
              workDir: body.workDir,
              taskId: body.taskId,
            });
          }
          yield message;
        }
      })();
    } else if (body.phase === "execute" && body.planId) {
      // Execute approved plan
      if (!body.planId) {
        return Response.json(
          { error: "planId is required for execute phase" },
          { status: 400 },
        );
      }
      const localPlan = agent.getPlan(body.planId);
      const storedPlan = localPlan
        ? null
        : await lookupStoredNativeAgentPlan({
            ownerId: session.user.id,
            planId: body.planId,
            workDir: body.workDir,
          });
      if (!localPlan && storedPlan?.state === "workdir_mismatch") {
        return Response.json(
          {
            error:
              "Plan workspace does not match this execute request. Please re-plan in the current workspace.",
          },
          { status: 409 },
        );
      }
      if (!localPlan && storedPlan?.state === "owner_mismatch") {
        return Response.json(
          { error: "Plan belongs to a different owner" },
          { status: 403 },
        );
      }
      if (!localPlan && storedPlan?.state === "expired") {
        return Response.json(
          { error: "Plan expired. Please re-plan before executing." },
          { status: 410 },
        );
      }
      const plan =
        localPlan ?? (storedPlan?.state === "found" ? storedPlan.record.plan : null);
      const planOriginalPrompt =
        storedPlan?.state === "found" ? storedPlan.record.originalPrompt : finalPrompt;
      if (!plan) {
        return Response.json(
          { error: "Plan not found or expired" },
          { status: 404 },
        );
      }

      // Assign planId to local const for type narrowing
      const planId = body.planId;

      // Create an event queue for insight changes
      const insightChangeEventQueue: Array<{
        action: "create" | "update" | "delete";
        insightId?: string;
        insight?: Record<string, unknown>;
      }> = [];

      // Wrap the generator to intercept messages and add insight change events
      generator = (async function* () {
        const innerGenerator = agent.execute({
          planId,
          plan,
          originalPrompt: planOriginalPrompt,
          ...agentOptions,
          onInsightChange: (data) => {
            // Add to event queue
            insightChangeEventQueue.push(data);
          },
          onPermissionRequest: async (request) => {
            console.log(
              "[AgentAPI] Permission request (execute mode):",
              request,
            );
            if (selectedProvider === "pi" && ["discoverWorkshops", "describeWorkshop", "observeWorkshop"].includes(request.toolName)
              && !agentOptions.runtimeTools?.some(tool => tool.name === request.toolName)) {
              return { behavior: "deny", message: "This Workshop read adapter is not mounted in the current runtime." };
            }
            if (
              selectedProvider === "pi" &&
              isNativePiReadOnlyToolName(request.toolName) &&
              agentOptions.runtimeTools?.some(tool => tool.name === request.toolName)
            ) {
              return { behavior: "allow" };
            }
            if (selectedProvider === "pi" && ["assignWorkshopTask", "askWorkshop", "setWorkshopAvailability", "cancelWorkshopRun"].includes(request.toolName)) {
              return { behavior: "deny", message: "Workshop controls require a current persisted owner command in ordinary chat." };
            }
            // Add to event queue and wait for user response
            permissionRequestEventQueue.push(withLoopGuardMetadata(request));

            // Create a promise that will be resolved when user responds.
            // A TTL timer prevents the Map entry from leaking if the user
            // never responds (e.g. tab closed, agent crashed).
            const PERMISSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
            return new Promise((resolve) => {
              const ttl = setTimeout(() => {
                if (permissionResponses.has(request.toolUseID)) {
                  permissionResponses.delete(request.toolUseID);
                  console.warn(
                    `[AgentAPI] Permission request timed out, auto-denying: ${request.toolUseID}`,
                  );
                  resolve({ behavior: "deny" });
                }
              }, PERMISSION_TTL_MS);
              permissionResponses.set(request.toolUseID, {
                ownerId: session.user.id,
                resolve: (result) => {
                  clearTimeout(ttl);
                  resolve(result);
                },
                reject: (error) => {
                  clearTimeout(ttl);
                  permissionResponses.delete(request.toolUseID);
                  console.error(
                    "[AgentAPI] Permission request rejected:",
                    error,
                  );
                  resolve({ behavior: "deny" });
                },
              });
            });
          },
        });

        for await (const message of innerGenerator) {
          // Yield the original message
          yield message;

          // After yielding, check if there are any insight change events to send
          while (insightChangeEventQueue.length > 0) {
            const event = insightChangeEventQueue.shift();
            if (event) {
              // Send insight change event as a special message type
              yield {
                type: "insightsRefresh" as const,
                ...event,
              };
            }
          }

          // Check if there are any permission request events to send
          while (permissionRequestEventQueue.length > 0) {
            const request = permissionRequestEventQueue.shift();
            if (request) {
              // Send permission request as a special message type
              yield {
                type: "permission_request" as const,
                permissionRequest: request,
              };
            }
          }
        }
      })();
    } else {
      // Direct execution (default)
      // Create an event queue for insight changes
      const insightChangeEventQueue: Array<{
        action: "create" | "update" | "delete";
        insightId?: string;
        insight?: Record<string, unknown>;
      }> = [];

      // Reuse the permission request event queue from outer scope
      generator = (async function* () {
        let streamDrained = false;
        try {
          const clarification = selectedProvider === "pi" ? historicalStatisticsClarification(body) : null;
          if (clarification) {
            yield { type: "text", content: clarification, messageId: crypto.randomUUID() };
            yield { type: "result", content: clarification, cost: 0 };
            yield { type: "done", messageId: crypto.randomUUID() };
            streamDrained = true;
            return;
          }
          let capabilityPrompt = finalPrompt;
          if (selectedProvider === "pi" && !answerSession && !createLoadedPartialHost
            && getPlatformCapabilityRoutingMode() !== "off") {
            if (capabilityContext?.status === "degraded") yield { type: "reasoning", content: JSON.stringify({
              stage: "platform_capability_context", status: capabilityContext.status, detail: capabilityContext.detail }) };
            const catalog = buildPlatformCapabilityCatalog({ tools: agentOptions.runtimeTools ?? [],
              policy: getNativePiWebChatToolPolicy(nativeToolPolicy), runtime: "chat" });
            const suggestion = await suggestPlatformCapabilities({ question: body.prompt, catalog,
              context: capabilityContext?.context, signal: abortController.signal });
            if (suggestion.status !== "disabled" && suggestion.detail !== "no_functional_request") {
              yield { type: "reasoning", content: JSON.stringify({ stage: "platform_capability_routing", ...suggestion }) };
            }
            if (suggestion.status === "ok" && suggestion.capabilityIds.length) capabilityPrompt +=
              "\n\n[Advisory platform capability matches: " + JSON.stringify(suggestion.capabilityIds)
              + ". Inspect their actual parameter schemas. Ignore a suggestion that does not fit the owner's request. "
              + "This does not execute any action, supply missing arguments, authorize writes or establish success. Existing guards and bound owner commands remain required.]";
          }
          const runPrompt = selectedProvider === "pi" && getPlatformRecallPrefetchMode() !== "off"
            ? yield* prefetchPlatformWithJev({ question: body.prompt, prompt: capabilityPrompt, tools: agentOptions.runtimeTools ?? [], signal: abortController.signal,
                context: capabilityContext?.context,
                onEvidenceEmbedded: answerSession ? binding => answerSession!.bindPromptEvidence(binding) : undefined })
            : selectedProvider === "pi" ? withPlatformEvidenceTimeBoundary(body.prompt, capabilityPrompt) : capabilityPrompt;
          const innerGenerator = agent.run(runPrompt, {
            ...agentOptions,
            onInsightChange: (data) => {
              // Add to event queue
              insightChangeEventQueue.push(data);
            },
            onPermissionRequest: async (request) => {
              console.log("[AgentAPI] Permission request (run mode):", request);
              if (selectedProvider === "pi" && ["discoverWorkshops", "describeWorkshop", "observeWorkshop"].includes(request.toolName)
                && !agentOptions.runtimeTools?.some(tool => tool.name === request.toolName)) {
                return { behavior: "deny", message: "This Workshop read adapter is not mounted in the current runtime." };
              }
              if (
                selectedProvider === "pi" &&
                isNativePiReadOnlyToolName(request.toolName) &&
                agentOptions.runtimeTools?.some(tool => tool.name === request.toolName)
              ) {
                return { behavior: "allow" };
              }

              if (selectedProvider === "pi" && ["assignWorkshopTask", "askWorkshop", "setWorkshopAvailability", "cancelWorkshopRun"].includes(request.toolName)) {
                const boundToolName = workshopControl?.action === "ask" ? "askWorkshop"
                  : workshopControl?.action === "pause" ? "setWorkshopAvailability"
                  : workshopControl && ["cancel", "stop"].includes(workshopControl.action) ? "cancelWorkshopRun"
                  : workshopControl && ["assign", "continue"].includes(workshopControl.action) ? "assignWorkshopTask" : null;
                if (!workshopControl || workshopControl.ownerId !== session.user.id || workshopControl.chatId !== body.chatId
                  || workshopControl.turnId !== resolvedPlatformTurnId || request.toolName !== boundToolName
                  || !agentOptions.runtimeTools?.some(tool => tool.name === request.toolName)) {
                  return { behavior: "deny", message: "This Workshop control tool requires the current server-bound owner command and its mounted adapter." };
                }
                if (!request.toolInput || typeof request.toolInput !== "object" || Array.isArray(request.toolInput)
                  || Object.keys(request.toolInput).length !== 0) {
                  return { behavior: "deny", message: "The server-bound Workshop control requires an empty object; do not supply replacement arguments." };
                }
                try {
                  await workshopControl.revalidate();
                } catch (error) {
                  return { behavior: "deny", message: "The persisted Workshop command is no longer valid: "
                    + (error instanceof Error ? error.message : "owner command, context or version changed") };
                }
                // This grants dispatch for this exact persisted owner command.
                // The mounted adapter's runtime guard still applies denied policy.
                return { behavior: "allow" };
              }

              if (
                selectedProvider === "pi" &&
                workshopRunOnce &&
                request.toolName === "runWorkshopOnce" &&
                agentOptions.runtimeTools?.some(tool => tool.name === request.toolName)
              ) {
                if (!request.toolInput || typeof request.toolInput !== "object" ||
                  Array.isArray(request.toolInput) || Object.keys(request.toolInput).length !== 0) {
                  return { behavior: "deny", message: "The server-bound Workshop run requires an empty object; do not supply replacement arguments." };
                }
                return { behavior: "allow" };
              }

              // The persisted owner command already authorizes this exact
              // server-bound draft. Keep its native policy and revalidation;
              // do not turn it into a read-only or generally approved tool.
              if (
                selectedProvider === "pi" &&
                workshopManifestApply &&
                request.toolName === "applyWorkshopManifestYaml" &&
                agentOptions.runtimeTools?.some(tool => tool.name === request.toolName)
              ) {
                if (!request.toolInput || typeof request.toolInput !== "object" ||
                  Array.isArray(request.toolInput) || Object.keys(request.toolInput).length !== 0) {
                  return { behavior: "deny", message: "The server-bound Workshop application requires an empty object; do not supply replacement arguments." };
                }
                return { behavior: "allow" };
              }

              // Check if this is a Bash command that needs sudo
              if (request.toolName === "Bash") {
                const command = request.toolInput?.command as string;
                if (command && /\bsudo\b/.test(command)) {
                  // Store the command for potential re-execution
                  pendingSudoCommands.set(request.toolUseID, {
                    command,
                    cwd: request.toolInput?.cwd as string | undefined,
                  });
                  console.log(
                    "[AgentAPI] Stored sudo command for toolUseID:",
                    request.toolUseID,
                  );
                }
              }

              // Add to event queue and wait for user response
              permissionRequestEventQueue.push(withLoopGuardMetadata(request));

              // Create a promise that will be resolved when user responds.
              // A TTL timer prevents the Map entry from leaking if the user
              // never responds (e.g. tab closed, agent crashed).
              const PERMISSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
              return new Promise((resolve) => {
                const ttl = setTimeout(() => {
                  if (permissionResponses.has(request.toolUseID)) {
                    permissionResponses.delete(request.toolUseID);
                    console.warn(
                      `[AgentAPI] Permission request timed out, auto-denying: ${request.toolUseID}`,
                    );
                    resolve({ behavior: "deny" });
                  }
                }, PERMISSION_TTL_MS);
                permissionResponses.set(request.toolUseID, {
                  ownerId: session.user.id,
                  resolve: (result) => {
                    clearTimeout(ttl);
                    resolve(result);
                  },
                  reject: (error) => {
                    clearTimeout(ttl);
                    permissionResponses.delete(request.toolUseID);
                    console.error(
                      "[AgentAPI] Permission request rejected:",
                      error,
                    );
                    resolve({ behavior: "deny" });
                  },
                });
              });
            },
          });

          for await (const message of innerGenerator) {
            if (message.type === "runtime_terminal" && answerSession && selectedEvidence?.kind === "platform") {
              await appendAgentAnswerAuditEvent({ ownerId: answerAuditOwnerId!, turnId: answerSession.turnId,
                eventKey: "retrieval_budget_closed", eventType: "retrieval_budget_closed", payload: {
                  budget: memoryReadBudget.snapshot(), providerStreamDiagnostics: message.providerStreamDiagnostics ?? null,
                } });
            }
            // Check for password prompt in tool results
            if (
              message.type === "tool_result" &&
              message.output &&
              message.toolUseId
            ) {
              if (detectSudoPasswordPrompt(message.output)) {
                const pendingCmd = pendingSudoCommands.get(message.toolUseId);
                if (pendingCmd) {
                  registerPasswordRequest(message.toolUseId, session.user.id, pendingCmd.command, pendingCmd.cwd);
                  console.log(
                    "[AgentAPI] Detected sudo password prompt for toolUseID:",
                    message.toolUseId,
                  );
                  // Emit password_input message to frontend
                  yield {
                    type: "password_input" as const,
                    toolUseId: message.toolUseId,
                    passwordInput: {
                      toolUseID: message.toolUseId,
                      originalCommand: pendingCmd.command,
                    },
                  };
                }
              }
            }

            // Yield the original message
            yield message;

            // After yielding, check if there are any insight change events to send
            while (insightChangeEventQueue.length > 0) {
              const event = insightChangeEventQueue.shift();
              if (event) {
                // Send insight change event as a special message type
                yield {
                  type: "insightsRefresh" as const,
                  ...event,
                };
              }
            }

            // Check if there are any permission request events to send
            while (permissionRequestEventQueue.length > 0) {
              const request = permissionRequestEventQueue.shift();
              if (request) {
                // Send permission request as a special message type
                yield {
                  type: "permission_request" as const,
                  permissionRequest: request,
                };
              }
            }
          }
          streamDrained = true;
        } finally {
          generatorCompletedNormally = streamDrained;
        }
      })();
    }

    const finalGenerator = answerSession
      ? (async function* () {
          let evidenceGateStarted = false;
          try {
            yield { type: "answer_evidence" as const, answerEvidence: { turnId: answerSession!.turnId } } as AgentMessage;
            evidenceGateStarted = true;
            if (selectedEvidence?.kind === "platform") yield* guardPlatformAnswer(generator, answerSession! as PlatformAnswerSession);
            else yield* guardExactLoopAnswer(generator, answerSession! as AnswerEvidenceSession);
          } finally {
            if (!evidenceGateStarted) {
              abortController.abort();
              await answerSession!.finalize({ terminal: {
                schemaVersion: "agent-runtime-terminal.v1", status: "aborted", cleanupStatus: "failed",
                completionScope: "answer_delivery",
                error: "Answer delivery stopped before the evidence guard entered; runtime cleanup completion was not observed.",
              }, rawDraft: "" });
            }
          }
        })()
      : selectedProvider === "pi" && !body.phase ? guardDirectLoopRuntimeAnswer(generator, body.prompt,
          { ownerId: session.user.id, partialDelivery: partialHost?.binding }) : generator;
    answerStreamStarted = true;
    // Create SSE stream
    const readable = createSSEStream(
      finalGenerator,
      () => {
        platformReadRegistry?.close();
        // Only abort if generator did not complete normally
        if (!generatorCompletedNormally) {
          abortController.abort();
        }
      },
    );

    return new Response(readable, { headers: { ...SSE_HEADERS, ...(answerSession || partialHost ? { "X-Answer-Evidence-Protocol": "v1" } : {}) } });
  } catch (error) {
    console.error("[AgentAPI] Error:", error);
    partialSetupAuditState = await closeOwnerLoopPartialSetup({ streamStarted: answerStreamStarted, host: partialHost,
      reservedTurnId: partialTurnId, reservedAuditSink: partialAuditSink });
    if (partialSetupAuditState === "setup_failed_audit_unconfirmed") console.error("[AgentAPI] Partial setup failed; its owned audit closure is unconfirmed", { turnId: partialTurnId });
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        ...(answerSession || partialTurnId ? { turnId: answerSession?.turnId ?? partialTurnId,
          queryUrl: `/api/native/answer-audits/${answerSession?.turnId ?? partialTurnId}` } : {}),
        ...(partialTurnId ? { partialSetupAuditState } : {}),
      },
      { status: error instanceof AgentAnswerAuditError || error instanceof WorkshopManifestApplicationError || error instanceof NativeWorkshopRunError ? error.status : 500 },
    );
  } finally {
    if (!answerStreamStarted) platformReadRegistry?.close();
    if (partialSetupAuditState === undefined) {
      partialSetupAuditState = await closeOwnerLoopPartialSetup({ streamStarted: answerStreamStarted, host: partialHost,
        reservedTurnId: partialTurnId, reservedAuditSink: partialAuditSink });
      if (partialSetupAuditState === "setup_failed_audit_unconfirmed") console.error("[AgentAPI] Partial setup failed; its owned audit closure is unconfirmed", { turnId: partialTurnId });
    }
    if (answerSession && !answerStreamStarted) {
      await answerSession.finalize({ terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "failed", cleanupStatus: "failed", error: "Request setup did not reach the runtime stream; cleanup completion was not observed." }, rawDraft: "" });
    }
  }
}
