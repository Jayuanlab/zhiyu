import type { ChatMessage } from "@openzhiyu/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/token-manager", () => ({ getAuthToken: () => null }));

const fetchMock = vi.fn<typeof fetch>();
let saveMessagesToDatabase: typeof import("@/lib/ai/chat/save-messages").saveMessagesToDatabase;

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function savedPayload(index = 0): {
  chatId: string;
  messages: ChatMessage[];
  skipSync: boolean;
} {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON save body");
  return JSON.parse(body);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ success: true }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ saveMessagesToDatabase } = await import("@/lib/ai/chat/save-messages"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("message save debounce", () => {
  it("merges different IDs and replaces only the latest version of a matching ID", async () => {
    const first = message("assistant-1", "assistant", "first");
    const second = message("assistant-2", "assistant", "second");
    const updated = message("assistant-1", "assistant", "updated");
    expect(await saveMessagesToDatabase([first], "chat-a")).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await saveMessagesToDatabase([second, updated], "chat-a", { skipSync: true });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedPayload()).toEqual({
      chatId: "chat-a", messages: [updated, second], skipSync: true, token: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes a pending assistant when a new user message is saved immediately", async () => {
    const assistant = message("assistant-1", "assistant", "reply");
    const user = message("user-2", "user", "next request");
    await saveMessagesToDatabase([assistant], "chat-a");
    expect(await saveMessagesToDatabase([user], "chat-a", { immediate: true })).toEqual({ success: true });
    expect(savedPayload().messages).toEqual([assistant, user]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets immediate updates replace pending versions and supports an empty flush", async () => {
    const first = message("assistant-1", "assistant", "partial");
    const final = message("assistant-1", "assistant", "final");
    await saveMessagesToDatabase([first], "chat-a");
    await saveMessagesToDatabase([final], "chat-a", { immediate: true });
    expect(savedPayload().messages).toEqual([final]);
    await saveMessagesToDatabase([first], "chat-b");
    await saveMessagesToDatabase([], "chat-b", { immediate: true });
    expect(savedPayload(1).messages).toEqual([first]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps pending messages and timers isolated across chats, even for the same message ID", async () => {
    const a = message("same-id", "assistant", "a reply");
    const b = message("same-id", "assistant", "b reply");
    const next = message("user-next", "user", "next");
    await saveMessagesToDatabase([a], "chat-a");
    await saveMessagesToDatabase([b], "chat-b");
    await saveMessagesToDatabase([next], "chat-a", { immediate: true });
    expect(savedPayload().messages).toEqual([a, next]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(savedPayload(1)).toMatchObject({ chatId: "chat-b", messages: [b] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["http", "network"] as const)("returns null after an immediate %s failure and clears its pending timer", async (failure) => {
    const assistant = message("assistant-1", "assistant", "pending");
    const user = message("user-2", "user", "next");
    await saveMessagesToDatabase([assistant], "chat-a");
    if (failure === "http") {
      fetchMock.mockResolvedValueOnce(new Response("simulated failure", { status: 503 }));
    } else {
      fetchMock.mockRejectedValueOnce(new Error("simulated network failure"));
    }
    expect(await saveMessagesToDatabase([user], "chat-a", { immediate: true })).toBeNull();
    expect(savedPayload().messages).toEqual([assistant, user]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const later = message("user-3", "user", "later");
    await saveMessagesToDatabase([later], "chat-a", { immediate: true });
    expect(savedPayload(1).messages).toEqual([later]);
  });

  it("cleans up after a failed debounced save without retaining stale messages", async () => {
    fetchMock.mockRejectedValueOnce(new Error("simulated failure"));
    await saveMessagesToDatabase([message("assistant-1", "assistant", "old")], "chat-a");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const later = message("assistant-2", "assistant", "new");
    await saveMessagesToDatabase([later], "chat-a");
    await vi.advanceTimersByTimeAsync(500);
    expect(savedPayload(1).messages).toEqual([later]);
  });

  it("retains a new pending batch while the previous debounced request is in flight", async () => {
    let resolveFirst: (response: Response) => void = () => { throw new Error("First request has not started"); };
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }));
    await saveMessagesToDatabase([message("assistant-1", "assistant", "first")], "chat-a");
    vi.advanceTimersByTime(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const second = message("assistant-2", "assistant", "second");
    await saveMessagesToDatabase([second], "chat-a");
    resolveFirst(Response.json({ success: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(savedPayload(1).messages).toEqual([second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
