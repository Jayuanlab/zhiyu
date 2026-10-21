export type AgentRuntimeErrorKind =
  | "provider_connection_closed"
  | "provider_timeout"
  | "provider_auth"
  | "provider_content_rejected"
  | "provider_output_truncated"
  | "provider_incomplete_output"
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

  // Explicit provider/host causes take precedence over incidental transport words.
  if (lower.includes("api_key_expired")) {
    return {
      kind: "provider_auth",
      message: "模型 API Key 已过期，本次智能体执行未完成。请在当前模型配置中更新有效 Key 后重新运行。",
      retryable: false,
      rawMessage,
    };
  }

  if (
    lower.includes("[provider_content_rejected]") ||
    lower.includes("data_inspection_failed") ||
    lower.includes("datainspectionfailed")
  ) {
    return {
      kind: "provider_content_rejected",
      message: "模型供应商的内容检查中断了输出，本次智能体执行未完成。已保留失败原因，请检查任务与提供方返回的错误后再决定如何处理。",
      retryable: false,
      rawMessage,
    };
  }

  if (lower.includes("[provider_output_truncated]")) {
    return {
      kind: "provider_output_truncated",
      message: "模型输出达到提供方的输出长度上限，本次任务未完成。已生成的内容仅为草稿，请调整单轮任务范围或模型输出限制后重新运行。",
      retryable: false,
      rawMessage,
    };
  }

  if (lower.includes("[provider_stream_interrupted]")) {
    return {
      kind: "provider_incomplete_output",
      message: "模型输出中途返回了未说明原因的错误，本次任务未完成。已保留草稿和运行记录；当前不能确定是提供方还是连接链路导致，请先核对记录。",
      retryable: false,
      rawMessage,
    };
  }

  const invalidRuntimeReceipt = lower.includes("[provider_incomplete_output]");
  if (invalidRuntimeReceipt || lower.includes("stream ended without finish_reason")) {
    return {
      kind: "provider_incomplete_output",
      message: invalidRuntimeReceipt
        ? "智能体运行的结束回执缺失或不一致，本次任务未完成。请检查运行时日志与模型连接后再处理。"
        : "模型流未返回完整结束标记，本次智能体执行未完成。请检查提供方连接后重新运行。",
      retryable: !invalidRuntimeReceipt,
      rawMessage,
    };
  }

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
