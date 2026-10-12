import { AppError, type ErrorCode } from "@openzhiyu/shared";
import type { ChatMessage } from "@openzhiyu/shared";
import type { Session } from "next-auth";
import { getAuthToken } from "@/lib/auth/token-manager";
import type { DBMessage } from "@/lib/db/schema";
import { getUserTimezoneHeaders } from "@/lib/timezone";

/**
 * Basic fetcher for API calls
 */
async function parseJsonBody(response: Response) {
  if (response.status === 204) return null;
  if (typeof response.text !== "function") {
    return response.json();
  }
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function appErrorFromPayload(payload: unknown, fallback: ErrorCode) {
  const error = payload as { code?: unknown; cause?: unknown } | null;
  return new AppError(
    typeof error?.code === "string" ? (error.code as ErrorCode) : fallback,
    typeof error?.cause === "string" ? error.cause : undefined,
  );
}

export const fetcher = async (url: string) => {
  const response = await fetch(url, {
    headers: getUserTimezoneHeaders(),
    credentials: "include",
  });

  const payload = await parseJsonBody(response);
  if (!response.ok) {
    throw appErrorFromPayload(payload, "bad_request:api");
  }

  return payload;
};

/**
 * Fetcher with cloud auth token - automatically adds Authorization header
 * Use this for API calls that require AI Provider authentication
 */
export const fetcherWithCloudAuth: typeof fetcher = async (url) => {
  const cloudAuthToken = typeof window !== "undefined" ? getAuthToken() : null;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...getUserTimezoneHeaders(),
  };

  if (cloudAuthToken) {
    headers.Authorization = `Bearer ${cloudAuthToken}`;
  }

  const response = await fetch(url, {
    headers,
    credentials: "same-origin",
  });

  const payload = await parseJsonBody(response);
  if (!response.ok) {
    throw appErrorFromPayload(payload, "bad_request:api");
  }

  return payload;
};

/**
 * Fetch with auth - automatically adds Authorization header for cloud auth
 * Supports all HTTP methods and custom options
 */
export async function fetchWithAuth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const cloudAuthToken = typeof window !== "undefined" ? getAuthToken() : null;

  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(getUserTimezoneHeaders())) {
    if (!headers.has(key)) headers.set(key, value);
  }

  if (
    init?.body &&
    !headers.has("Content-Type") &&
    typeof init.body === "string"
  ) {
    headers.set("Content-Type", "application/json");
  }

  if (cloudAuthToken) {
    headers.set("Authorization", `Bearer ${cloudAuthToken}`);
  }

  const response = await fetch(input, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  return response;
}

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  try {
    const response = await fetch(input, init);

    if (!response.ok) {
      const payload = await parseJsonBody(response);
      throw appErrorFromPayload(payload, "bad_request:api");
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      throw new AppError("offline:chat");
    }

    throw error;
  }
}

export function getLocalStorage(key: string) {
  if (typeof window !== "undefined") {
    return JSON.parse(localStorage.getItem(key) || "[]");
  }
  return [];
}

export function convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as "user" | "assistant" | "system",
    parts: message.parts as any,
    metadata: {
      ...(message.metadata || {}),
      // Persisted chronology owns ordering; browser clocks cannot override it.
      createdAt: new Date(message.createdAt).toISOString(),
    },
  }));
}

export function createPageUrl(pageName: string) {
  return `/${pageName.toLowerCase().replace(/ /g, "-")}`;
}

export function judgeGuest(session: Session) {
  return session?.user?.type === "guest";
}

/**
 * Get the home path based on character tab mode.
 * In character tab mode, returns "/character", otherwise returns "/".
 */
export function getHomePath(): string {
  return "/";
}
