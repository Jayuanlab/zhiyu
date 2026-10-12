const DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_ATTEMPTS = 3;

export type WechatDesktopHealth = {
  ok: boolean;
  service: string;
  uptimeSeconds?: number;
  wxautoAvailable?: boolean;
  wxautoError?: string | null;
  pid?: number;
  backend?: string;
  sendEnabled?: boolean;
  wechatWindowFound?: boolean;
  wechatVersion?: string | null;
  versionFamily?: "4.x" | "unsupported" | "unknown";
  loginStatus?: "unverified" | "window_not_available";
  compatibility?: "unverified";
  desktopStatus?: "available" | "locked_or_unavailable" | "unavailable";
  capabilities?: {readMessages: false; preview: boolean; send: boolean; deliveryReceipt: false};
};

export type WechatDesktopPreview = {
  ok: boolean;
  requiresConfirmation: boolean;
  confirmToken: string;
  expiresInSeconds: number;
  preview: {
    recipientName: string;
    message: string;
    messageHash: string;
  };
};

export type WechatDesktopSendResult = {
  ok: boolean;
  recipientName: string;
  messageHash: string;
  sentAt: number;
};

type RequestOptions = {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
};

export class WechatDesktopServiceError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "WechatDesktopServiceError";
    this.status = status;
  }
}

function getServiceUrl() {
  const value = (
    process.env.WECHAT_DESKTOP_SERVICE_URL?.replace(/\/+$/, "") ||
    DEFAULT_SERVICE_URL
  );
  if (process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED !== undefined) {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new WechatDesktopServiceError("wechat_sender_loopback_required");
    }
  }
  return value;
}

function buildHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const token = process.env.WECHAT_DESKTOP_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function requestJson<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
    try {
      return await requestJsonOnce<T>(path, options);
    } catch (error) {
      lastError = error;
      if (
        error instanceof WechatDesktopServiceError &&
        error.status !== undefined
      ) {
        throw error;
      }
      if (attempt < REQUEST_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new WechatDesktopServiceError(String(lastError));
}

async function requestJsonOnce<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  if (process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED !== undefined && process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED !== "true") {
    throw new WechatDesktopServiceError("wechat_component_disabled");
  }
  if (path === "/send" && process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED !== undefined && process.env.WECHAT_DESKTOP_SEND_ENABLED !== "true") {
    throw new WechatDesktopServiceError("wechat_reviewed_sending_disabled");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${getServiceUrl()}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...buildHeaders(),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : `WeChat desktop service returned HTTP ${response.status}`;
      throw new WechatDesktopServiceError(message, response.status);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof WechatDesktopServiceError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new WechatDesktopServiceError(
        `WeChat desktop service timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    const cause = (error as { cause?: unknown })?.cause;
    const causeMessage =
      cause && typeof cause === "object" && "message" in cause
        ? String((cause as { message?: unknown }).message)
        : cause
          ? String(cause)
          : "";
    throw new WechatDesktopServiceError(
      `Failed to call WeChat desktop service: ${error instanceof Error ? error.message : String(error)}${causeMessage ? ` (${causeMessage})` : ""}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function getWechatDesktopServiceConfig() {
  return {
    url: getServiceUrl(),
    hasToken: Boolean(process.env.WECHAT_DESKTOP_TOKEN),
  };
}

export async function getWechatDesktopHealth() {
  return requestJson<WechatDesktopHealth>("/health");
}

export async function previewWechatDesktopMessage(input: {
  recipientName: string;
  message: string;
}) {
  return requestJson<WechatDesktopPreview>("/preview", {
    method: "POST",
    body: input,
  });
}

export async function sendWechatDesktopMessage(input: {
  commandId?: string;
  recipientName: string;
  message: string;
  confirmToken: string;
}) {
  return requestJsonOnce<WechatDesktopSendResult>("/send", {
    method: "POST",
    body: input,
  });
}

export type WechatDesktopSendStatus =
  | {ok:true;status:'not_found'}
  | {ok:true;status:'unknown';result:null}
  | {ok:true;status:'not_sent';result:Record<string,unknown>}
  | {ok:true;status:'sent';result:Record<string,unknown>};

export async function getWechatDesktopSendStatus(commandId:string){
  if(!commandId.trim()||commandId.length>256)throw new WechatDesktopServiceError('Invalid commandId');
  return requestJson<WechatDesktopSendStatus>('/send-status',{method:'POST',body:{commandId}});
}

export async function resolveWechatDesktopSend(input:{commandId:string;recipientName:string;message:string;resolutionId:string;decision:'sent'|'not_sent';actorId:string;evidence:string}){
  return requestJsonOnce<{ok:true;status:'sent'|'not_sent';result:Record<string,unknown>}>('/resolve-send',{method:'POST',body:input});
}
