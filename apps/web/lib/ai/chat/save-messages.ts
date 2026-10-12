import type { ChatMessage } from "@openzhiyu/shared";
import { getAuthToken } from "@/lib/auth/token-manager";

export interface SaveMessagesResponse {
  success: boolean;
  chat?: {
    id: string;
    title: string;
    createdAt: Date | string;
  } | null;
}

export interface SaveOptions {
  immediate?: boolean;
  skipSync?: boolean;
}

const pendingSaves = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout> | null;
    messages: ChatMessage[];
    options: SaveOptions;
  }
>();

function mergeMessages(
  pending: ChatMessage[],
  current: ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...pending, ...current]) {
    byId.set(message.id, message);
  }
  return [...byId.values()];
}

async function doSave(
  messages: ChatMessage[],
  chatId: string,
  options: SaveOptions,
): Promise<SaveMessagesResponse | null> {
  try {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    let cloudAuthToken: string | null = null;
    try {
      cloudAuthToken = getAuthToken();
      if (cloudAuthToken) {
        headers.Authorization = `Bearer ${cloudAuthToken}`;
      }
    } catch (error) {
      console.error(
        "[saveMessagesToDatabase] Failed to read cloud_auth_token:",
        error,
      );
    }

    const response = await fetch("/api/chat/save-messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        chatId,
        messages,
        skipSync: options.skipSync ?? false,
        token: cloudAuthToken,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[saveMessagesToDatabase] Failed to save messages:",
        response.status,
        response.statusText,
        errorText,
      );
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error("[saveMessagesToDatabase] Error saving messages:", error);
    return null;
  }
}

// Helper function to save messages to database
export async function saveMessagesToDatabase(
  messages: ChatMessage[],
  chatId: string,
  options?: SaveOptions,
): Promise<SaveMessagesResponse | null> {
  const opts = options ?? {};
  const existing = pendingSaves.get(chatId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  const latestMessages = mergeMessages(existing?.messages ?? [], messages);

  if (opts.immediate) {
    pendingSaves.delete(chatId);
    return doSave(latestMessages, chatId, opts);
  }

  // Keep each pending message, replacing only newer versions of the same ID.
  const latestOptions = opts;

  pendingSaves.set(chatId, {
    timer: setTimeout(async () => {
      pendingSaves.delete(chatId);
      await doSave(latestMessages, chatId, latestOptions);
    }, 500),
    messages: latestMessages,
    options: latestOptions,
  });

  return null;
}
