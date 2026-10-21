import type { ImageAttachment } from "@openzhiyu/ai/agent/types";

export type AgentMode = "chat" | "native";

// ============ Import utility functions ============
// (Note: estimateTokens, INPUT_TOKENS_PER_CREDIT, OUTPUT_TOKENS_PER_CREDIT have been removed,
//  because billing logic is now handled by the backend API)

// ============ Error handling and retry logic ============

/**
 * Fetch with retry logic (for network errors and server errors)
 *
 * @param url - Request URL
 * @param options - Fetch options
 * @param maxRetries - Maximum retry count (default: 3 times)
 * @param retryDelay - First retry delay (default: 1000ms, exponential backoff)
 * @returns Promise<Response>
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  retryDelay = 1000,
): Promise<Response> {
  let lastError: Error | null = null;

  // Create new options object to avoid modifying original object during retries
  // If body is string, create new request for each retry
  // Because in some cases (like HTTP/2), body may be marked as already consumed
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Create new options object for each request
      // If body exists, ensure it is a string (strings are immutable)
      const requestOptions: RequestInit = {
        ...options,
        body: options.body as string, // Keep original body
      };

      const response = await fetch(url, requestOptions);

      // Check HTTP status code, retry needed: 5xx server error or 429 rate limit
      if (!response.ok && (response.status >= 500 || response.status === 429)) {
        const delay = retryDelay * 2 ** attempt;
        console.warn(
          `[AgentRouter] Server error ${response.status}, retrying (${attempt + 1}/${maxRetries}) in ${delay}ms...`,
        );

        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue; // retry
        }

        // Retry count used up, return final response (let caller handle error)
        return response;
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      const errorMessage = lastError?.message || "";

      // If user actively cancels, don't retry
      if (lastError?.name === "AbortError") {
        throw lastError;
      }

      // Only retry on network errors
      const isNetworkError =
        errorMessage === "Load failed" ||
        errorMessage === "Failed to fetch" ||
        errorMessage.includes("NetworkError") ||
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("fetch");

      if (!isNetworkError) {
        throw lastError;
      }

      // Wait and retry (exponential backoff)
      if (attempt < maxRetries - 1) {
        const delay = retryDelay * 2 ** attempt;
        console.log(
          `[AgentRouter] Network error, retrying (${attempt + 1}/${maxRetries}), retry after ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Fetch failed after retries");
}

/**
 * Error classification for better retry strategy
 */
interface ErrorClassification {
  type: "retry" | "fatal" | "user_error";
  category: string;
  i18nKey: string; // i18n key for frontend localization
}

export interface NativeAgentErrorResponseDetail {
  message: string;
  unsupportedCapabilities?: string[];
}

export function parseNativeAgentErrorResponse(
  responseBody: string,
): NativeAgentErrorResponseDetail {
  if (!responseBody.trim()) {
    return { message: "Cloud service unavailable" };
  }

  try {
    const parsed = JSON.parse(responseBody);
    const rawError = parsed?.error;
    const message =
      typeof rawError === "string"
        ? rawError
        : typeof rawError?.message === "string"
          ? rawError.message
          : typeof parsed?.message === "string"
            ? parsed.message
            : responseBody;
    const unsupportedCapabilities = Array.isArray(
      parsed?.unsupportedCapabilities,
    )
      ? parsed.unsupportedCapabilities.filter(
          (value: unknown): value is string => typeof value === "string",
        )
      : undefined;

    return {
      message: unsupportedCapabilities?.length
        ? `${message} Unsupported capabilities: ${unsupportedCapabilities.join(", ")}.`
        : message,
      unsupportedCapabilities,
    };
  } catch {
    return { message: responseBody };
  }
}

/**
 * Classify error to determine retry strategy
 */
function classifyError(error: Error): ErrorClassification {
  const message = error.message.toLowerCase();
  const name = error.name?.toLowerCase() || "";
  const status = (error as any)?.status;

  if (
    status === 400 ||
    status === 404 ||
    status === 409 ||
    status === 410 ||
    status === 422 ||
    Array.isArray((error as any)?.unsupportedCapabilities)
  ) {
    return {
      type: "user_error",
      category: "request",
      i18nKey: "agent.errors.requestError",
    };
  }

  // TypeError - fatal (code bug, should not retry)
  if (name === "typeerror") {
    return {
      type: "fatal",
      category: "type_error",
      i18nKey: "agent.errors.typeError",
    };
  }

  // API key errors - fatal (user must fix)
  if (
    message.includes("invalid api key") ||
    message.includes("invalid_api_key") ||
    message.includes("unauthorized") ||
    message.includes("401") ||
    message.includes("403") ||
    message.includes("authentication failed") ||
    message.includes("invalid key")
  ) {
    return {
      type: "fatal",
      category: "auth",
      i18nKey: "agent.errors.apiKeyError",
    };
  }

  // Cloud / upstream API errors (502, 503, etc.) — retryable
  if (
    error.name === "CloudError" ||
    message.includes("cloud") ||
    message.includes("upstream") ||
    /\b(502|503|504)\b/.test(message) ||
    message.includes("bad gateway") ||
    message.includes("service unavailable")
  ) {
    return {
      type: "retry",
      category: "cloud",
      i18nKey: "agent.errors.cloudRetry",
    };
  }

  // Connection refused - fatal (service not running)
  if (
    message.includes("econnrefused") ||
    message.includes("service not running")
  ) {
    return {
      type: "fatal",
      category: "service_unavailable",
      i18nKey: "agent.errors.serviceUnavailable",
    };
  }

  // Network errors - retryable
  if (
    message.includes("timeout") ||
    message.includes("timedout") ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("networkerror") ||
    message.includes("econnreset")
  ) {
    return {
      type: "retry",
      category: "network",
      i18nKey: "agent.errors.networkRetry",
    };
  }

  // Process crash - retryable
  if (
    message.includes("process") ||
    message.includes("exited with code") ||
    message.includes("killed") ||
    message.includes("oom") ||
    message.includes("sigkill")
  ) {
    return {
      type: "retry",
      category: "process_crash",
      i18nKey: "agent.errors.processCrashRetry",
    };
  }

  // Stream errors - retryable
  if (
    message.includes("stream") ||
    message.includes("connection") ||
    message.includes("disconnect")
  ) {
    return {
      type: "retry",
      category: "stream",
      i18nKey: "agent.errors.streamConnectionRetry",
    };
  }

  // CORS errors - fatal (configuration issue)
  if (message.includes("cors") || message.includes("cross-origin")) {
    return {
      type: "fatal",
      category: "cors",
      i18nKey: "agent.errors.corsError",
    };
  }

  // Default: retry unknown errors
  return {
    type: "retry",
    category: "unknown",
    i18nKey: "agent.errors.unknownRetry",
  };
}

/**
 * Create SSE message stream for Native Agent
 *
 * IMPROVED: Added timeout protection and better error handling
 * FIXED: Returns abort function immediately after creating AbortController
 *
 * @returns Returns an abort function, used to interrupt stream
 */
export async function streamNativeAgentResponse(
  prompt: string,
  options: {
    chatId?: string;
    clientRequestId?: string;
    userMessageId?: string;
    assistantMessageId?: string;
    provider?: "claude" | "pi";
    phase?: "plan" | "execute";
    planId?: string;
    planVersion?: string;
    planCommandId?: string;
    conversation?: Array<{ role: "user" | "assistant"; content: string }>;
    workDir?: string;
    taskId?: string;
    modelConfig?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      thinkingLevel?: "disabled" | "low" | "adaptive";
    };
    sandboxConfig?: {
      enabled: boolean;
      provider?: string;
    };
    permissionMode?:
      | "default"
      | "acceptEdits"
      | "bypassPermissions"
      | "plan"
      | "dontAsk";
    images?: ImageAttachment[];
    fileAttachments?: Array<{
      name: string;
      data: string;
      mimeType: string;
    }>;
    ragDocuments?: Array<{
      id: string;
      name: string;
    }>;
    workspaceFileRefs?: Array<{
      taskId: string;
      path: string;
      name: string;
    }>;
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
    authToken?: string;
    loopIdForGuard?: string | null;
    onUpdate?: (message: any) => void;
    onDone?: () => void;
    onError?: (error: Error) => void;
    /** Call immediately when abort function is ready, used to immediately save abortFn to state */
    onAbortFnReady?: (abortFn: () => void) => void;
  },
): Promise<() => void> {
  const {
    chatId,
    clientRequestId,
    userMessageId,
    assistantMessageId,
    provider,
    phase,
    planId,
    planVersion,
    planCommandId,
    conversation,
    workDir,
    taskId,
    modelConfig,
    sandboxConfig,
    permissionMode,
    images,
    fileAttachments,
    ragDocuments,
    workspaceFileRefs,
    focusedInsightIds,
    focusedInsights,
    authToken,
    loopIdForGuard,
    onUpdate,
    onDone,
    onError,
    onAbortFnReady,
  } = options;

  // Create AbortController to interrupt stream
  const abortController = new AbortController();

  // Track timer to ensure cleanup
  let timeoutCheckInterval: NodeJS.Timeout | null = null;

  // Immediately return abort function, so caller can cancel at any time
  // Stream processing runs asynchronously in background
  const abortFn = () => {
    abortController.abort();
    // Cleanup timeout check timer
    if (timeoutCheckInterval) {
      clearInterval(timeoutCheckInterval);
      timeoutCheckInterval = null;
    }
  };

  // Immediately notify caller that abortFn is ready, so caller can save abortFn to state before request starts
  // Reduce race condition: when user clicks stop, abortFn is already available
  if (onAbortFnReady) {
    onAbortFnReady(abortFn);
  }

  // Start stream processing in background
  (async () => {
    const STREAM_TIMEOUT_REASON = "stream_timeout";
    try {
      // ========== Billing: Check and pre-deduct input tokens ==========
      // Note: Billing is now handled in backend API, here only responsible for sending requests
      // /api/native/agent will handle billing logic

      // Build request body
      const requestBody = JSON.stringify({
        prompt,
        provider,
        sessionId: chatId,
        chatId,
        clientRequestId,
        userMessageId,
        assistantMessageId,
        conversation,
        workDir,
        taskId,
        modelConfig,
        sandboxConfig,
        permissionMode,
        images,
        fileAttachments,
        ragDocuments,
        workspaceFileRefs,
        focusedInsightIds,
        focusedInsights,
        authToken,
        loopIdForGuard,
        skillsConfig: {
          enabled: true,
          userDirEnabled: true,
          appDirEnabled: false,
        },
        mcpConfig: {
          enabled: false,
          userDirEnabled: false,
          appDirEnabled: false,
        },
        phase,
        planId,
        planVersion,
        planCommandId,
      });

      // Use fetchWithRetry to automatically retry on network errors and server errors, pass signal to support abort
      const response = await fetchWithRetry("/api/native/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: abortController.signal,
        body: requestBody,
      });

      // Detect non-OK responses (e.g. 502 from cloud) BEFORE attempting to read the stream.
      // A 502 body is NOT a valid SSE stream — without this check, the reader would hang
      // waiting for data that will never come, causing a silent timeout.
      if (!response.ok) {
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {}
        const detail = parseNativeAgentErrorResponse(errorBody);
        const status = response.status;
        const cloudError = new Error(
          `[${status}] ${detail.message || "Cloud service unavailable"}`,
        );
        cloudError.name =
          status >= 500 || status === 429
            ? "CloudError"
            : "NativeAgentRequestError";
        (cloudError as any).status = status;
        (cloudError as any).unsupportedCapabilities =
          detail.unsupportedCapabilities;
        (cloudError as any).isRetryable =
          status >= 500 || status === 429 || status === 502 || status === 503;
        throw cloudError;
      }

      // A replay response is a JSON snapshot, never a new model stream.
      if (response.headers.get("content-type")?.includes("application/json")) {
        let snapshot = await response.json();
        const assertSnapshotBinding = (value: any) => {
          if (typeof value?.turnId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.turnId)
            || (chatId && value.chatId !== chatId)
            || (assistantMessageId && value.assistantMessageId !== assistantMessageId)) {
            throw Object.assign(new Error("Saved turn belongs to a different request."), { isRetryable: false });
          }
        };
        assertSnapshotBinding(snapshot);
        const deadline = Date.now() + 600_000;
        while (snapshot.status === "running") {
          onUpdate?.({ type: "answer_evidence", answerEvidence: { turnId: snapshot.turnId } });
          if (Date.now() >= deadline) {
            throw Object.assign(new Error("The saved turn is still running; check its audit before retrying."), { isRetryable: false });
          }
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
            const timer = setTimeout(() => { abortController.signal.removeEventListener("abort", onAbort); resolve(); }, 1000);
            if (abortController.signal.aborted) onAbort();
            else abortController.signal.addEventListener("abort", onAbort, { once: true });
          });
          if (typeof snapshot.turnId !== "string" || !/^[0-9a-f-]{36}$/i.test(snapshot.turnId)) throw new Error("Invalid turn snapshot");
          const poll = await fetch(`/api/native/answer-audits/${snapshot.turnId}`, { signal: abortController.signal });
          if (!poll.ok) throw Object.assign(new Error("Could not recover the saved turn audit."), { isRetryable: false });
          snapshot = await poll.json();
          assertSnapshotBinding(snapshot);
        }
        if (!["completed", "failed", "aborted"].includes(snapshot.status)
          || snapshot.runtimeTerminal?.schemaVersion !== "agent-runtime-terminal.v1"
          || !["completed", "failed", "aborted"].includes(snapshot.runtimeTerminal.status)
          || !["completed", "failed"].includes(snapshot.runtimeTerminal.cleanupStatus)) {
          throw Object.assign(new Error("The saved turn has no confirmed terminal; completion is unknown."), { isRetryable: false });
        }
        onUpdate?.({ type: "answer_evidence", answerEvidence: { turnId: snapshot.turnId } });
        const finalText = snapshot.finalText ?? snapshot.evidence?.displayText;
        if (typeof finalText === "string" && finalText) onUpdate?.({ type: "text", content: finalText, answerPhase: "candidate_final" });
        onUpdate?.({ type: "runtime_terminal", runtimeTerminal: snapshot.runtimeTerminal });
        onDone?.();
        return;
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        throw Object.assign(new Error("Unsupported native agent response format"), { isRetryable: false });
      }

      // Handle SSE stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let messageCount = 0;
      const auditedProtocol = response.headers.get("x-answer-evidence-protocol") === "v1";
      let receivedTerminal = false;
      let receivedStreamEnd = false;

      // IMPROVED: Add read timeout protection
      // If no data received for 300 seconds (5 minutes), cancel the stream
      const READ_TIMEOUT_MS = 600000; // 10 minutes
      let lastDataTime = Date.now();

      // Set up timeout check interval
      timeoutCheckInterval = setInterval(() => {
        const timeSinceLastData = Date.now() - lastDataTime;
        if (timeSinceLastData > READ_TIMEOUT_MS) {
          console.error(
            `[AgentRouter] Stream read timeout - no data for ${timeSinceLastData}ms`,
          );
          reader.cancel(STREAM_TIMEOUT_REASON).catch((err) => {
            console.error("[AgentRouter] Failed to cancel reader:", err);
          });
        }
      }, 10000); // Check every 10 seconds

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            if (auditedProtocol && !receivedTerminal) {
              throw Object.assign(new Error("Connection ended without a confirmed runtime terminal. Check the saved audit; completion is unknown."), { isRetryable: false });
            }
            if (auditedProtocol && !receivedStreamEnd) {
              throw Object.assign(new Error("Connection ended before the final answer stream was committed. Check the saved audit."), { isRetryable: false });
            }
            // Use .then().catch() to handle async onDone callback and catch any rejection
            // This prevents unhandledRejection when onDone is async and throws
            Promise.resolve()
              .then(() => onDone?.())
              .catch((e) =>
                console.error("[AgentRouter] onDone callback error:", e),
              );
            break;
          }

          // Update last data time when we receive data
          if (value && value.length > 0) {
            lastDataTime = Date.now();
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(5));
                messageCount++;
                if (data.type === "runtime_terminal"
                  && data.runtimeTerminal?.schemaVersion === "agent-runtime-terminal.v1"
                  && ["completed", "failed", "aborted"].includes(data.runtimeTerminal.status)
                  && ["completed", "failed"].includes(data.runtimeTerminal.cleanupStatus)) receivedTerminal = true;
                if (data.type === "done") receivedStreamEnd = true;
                onUpdate?.(data);
              } catch (e) {
                console.error(
                  "[AgentRouter] Failed to parse SSE data:",
                  line,
                  e,
                );
              }
            }
          }
        }
      } finally {
        // Clear timeout check interval
        if (timeoutCheckInterval) {
          clearInterval(timeoutCheckInterval);
          timeoutCheckInterval = null;
        }
      }
    } catch (error) {
      const err = error as Error;

      // If user-initiated cancellation, call onDone to reset state, then handle silently
      if (err?.name === "AbortError") {
        if (err.message === STREAM_TIMEOUT_REASON) {
          // Timeout - show error to user
          const timeoutError = new Error("[stream] agent.errors.timeout");
          timeoutError.name = "TimeoutError";
          (timeoutError as any).errorClassification = {
            type: "fatal",
            category: "stream",
            i18nKey: "agent.errors.timeout",
            retryable: false,
          };
          // Use .then().catch() to handle async onError callback and catch any rejection
          Promise.resolve()
            .then(() => onError?.(timeoutError))
            .catch((e) =>
              console.error("[AgentRouter] onError callback error:", e),
            );
        } else {
          // User-initiated cancellation - silent
          console.log("[AgentRouter] Request was aborted by user");
          // Use .then().catch() to handle async onDone callback and catch any rejection
          Promise.resolve()
            .then(() => onDone?.())
            .catch((e) =>
              console.error("[AgentRouter] onDone callback error:", e),
            );
        }
        return;
      }

      console.error("[AgentRouter] Request failed:", {
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
      });

      // IMPROVED: Use error classification for better error handling
      const errorClassification = classifyError(err);
      console.log("[AgentRouter] Error classified:", errorClassification);

      // Format error message based on classification
      // Use i18n key for frontend localization, fallback to English
      let errorMessage: string;
      if (
        errorClassification.type === "fatal" ||
        errorClassification.type === "user_error"
      ) {
        // Fatal errors - use i18n key and include original error message for debugging
        errorMessage = `[${errorClassification.category}] ${errorClassification.i18nKey}: ${err.message}`;
      } else {
        // Retryable errors - use i18n key for frontend to localize
        // The frontend will use the i18nKey from errorClassification to localize
        errorMessage = `[${errorClassification.category}] ${errorClassification.i18nKey}`;
        if (
          errorClassification.category === "network" ||
          errorClassification.category === "stream" ||
          errorClassification.category === "cloud"
        ) {
          // Add retry marker for network/stream/cloud errors
          errorMessage += ". agent.errors.retrying";
        }
      }

      const enhancedError = new Error(errorMessage);
      enhancedError.name = err?.name ?? "Error";
      enhancedError.stack = err?.stack;

      // Propagate isRetryable flag from CloudError if present
      const isRetryable =
        clientRequestId ? false : (err as any).isRetryable ?? errorClassification.type === "retry";
      (enhancedError as any).isRetryable = isRetryable;
      (enhancedError as any).unsupportedCapabilities = (err as any)
        ?.unsupportedCapabilities;

      // Add error classification to error object for frontend to use
      (enhancedError as any).errorClassification = errorClassification;

      // Use .then().catch() to handle async onError callback and catch any rejection
      Promise.resolve()
        .then(() => onError?.(enhancedError))
        .catch((e) =>
          console.error("[AgentRouter] onError callback error:", e),
        );
    }
  })();

  return abortFn;
}
