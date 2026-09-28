export type AgentRuntimeErrorKind =
  | "provider_connection_closed"
  | "provider_timeout"
  | "provider_auth"
  | "provider_compatibility"
  | "process_crash"
  | "unknown";

export type NormalizedAgentRuntimeError = {
  kind: AgentRuntimeErrorKind;
  message: string;
  retryable: boolean;
  rawMessage: string;
};

function rawErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeAgentRuntimeError(
  error: unknown,
): NormalizedAgentRuntimeError {
  const rawMessage = rawErrorMessage(error);
  const lower = rawMessage.toLowerCase();

  if (
    lower.includes("socket connection was closed") ||
    lower.includes("connection was closed unexpectedly") ||
    lower.includes("und_err_socket") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("terminated")
  ) {
    return {
      kind: "provider_connection_closed",
      message:
        "模型供应商连接中途断开，本次智能体执行没有拿到完整结果。通常是上游 API、网络或长连接超时导致，可以稍后重试；如果频繁出现，需要切换模型供应商或降低单次任务上下文/执行时长。",
      retryable: true,
      rawMessage,
    };
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timedout") ||
    lower.includes("etimedout")
  ) {
    return {
      kind: "provider_timeout",
      message:
        "模型供应商请求超时，本次智能体执行未完成。可以重试，或降低单次任务的上下文长度和工具调用数量。",
      retryable: true,
      rawMessage,
    };
  }

  if (
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("authentication failed") ||
    lower.includes("failed to authenticate") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return {
      kind: "provider_auth",
      message:
        "模型 API 鉴权失败，请检查当前模型供应商的 API Key、Base URL 和模型配置。",
      retryable: false,
      rawMessage,
    };
  }

  if (lower.includes("exited with code")) {
    return {
      kind: "provider_compatibility",
      message:
        "模型兼容层执行失败，可能是当前模型供应商接口、协议或运行时适配器不兼容。请检查当前运行使用的 provider、Base URL、协议和模型配置。",
      retryable: true,
      rawMessage,
    };
  }

  if (
    lower.includes("sigkill") ||
    lower.includes("oom") ||
    lower.includes("killed") ||
    lower.includes("137")
  ) {
    return {
      kind: "process_crash",
      message:
        "智能体执行进程被系统中断，可能是内存不足或进程被杀掉。可以重试，或减少本次任务上下文。",
      retryable: true,
      rawMessage,
    };
  }

  return {
    kind: "unknown",
    message: rawMessage || "智能体执行失败。",
    retryable: false,
    rawMessage,
  };
}
