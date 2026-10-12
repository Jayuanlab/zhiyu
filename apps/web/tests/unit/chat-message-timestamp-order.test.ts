import { describe, expect, it } from "vitest";
import type { DBMessage } from "@/lib/db/schema";
import { convertToUIMessages } from "@/lib/utils/fetcher";
import { mergeBackgroundChatMessages } from "@/components/chat/background-messages";
import { buildNativeConversation } from "@/lib/ai/chat/native-conversation";

const chatId = "chat-timestamp-order";

function persistedMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: string,
  metadata?: Record<string, unknown>,
): DBMessage {
  return {
    id, chatId, role,
    parts: [{ type: "text", text }],
    attachments: [],
    createdAt: new Date(createdAt),
    metadata,
  };
}

describe("persisted chat chronology", () => {
  it.each([
    ["same-second client timestamp", "2026-10-09T20:54:35.266Z"],
    ["client clock ahead of the server", "2026-10-10T04:54:35.266Z"],
  ])("keeps paired turns after reload with %s", (_scenario, clientTimestamp) => {
    const source = [
      persistedMessage("u1", "user", "List knowledge interfaces.", "2026-10-09T20:53:55.393Z"),
      persistedMessage("a1", "assistant", "Knowledge interface list.", "2026-10-09T20:53:56.064Z"),
      persistedMessage("u2", "user", "Read memory counts.", "2026-10-09T20:54:35.272Z", {
        createdAt: clientTimestamp, referencedTaskIds: ["retained-task"],
      }),
      persistedMessage("a2", "assistant", "Memory counts.", "2026-10-09T20:54:35.859Z"),
    ];

    const ui = convertToUIMessages(source);
    const reloaded = mergeBackgroundChatMessages(
      { chatId, baseline: [], messages: ui }, [], new Set(),
    );

    expect(reloaded.map(message => message.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(buildNativeConversation(reloaded, chatId)).toEqual([
      { role: "user", content: "List knowledge interfaces." },
      { role: "assistant", content: "Knowledge interface list." },
      { role: "user", content: "Read memory counts." },
      { role: "assistant", content: "Memory counts." },
    ]);
    expect(ui[2].metadata).toEqual({
      createdAt: "2026-10-09T20:54:35.272Z", referencedTaskIds: ["retained-task"],
    });
    expect(source[2].metadata).toEqual({
      createdAt: clientTimestamp, referencedTaskIds: ["retained-task"],
    });
  });

  it.each([
    { label: "database Date", createdAt: new Date("2026-10-09T20:54:35.859Z") },
    { label: "serialized ISO date", createdAt: "2026-10-10T04:54:35.859+08:00" },
  ])("retains milliseconds from a $label", ({ createdAt }) => {
    const source = persistedMessage("a2", "assistant", "Memory counts.", "2026-10-09T20:54:35.859Z");
    // Database schemas return Date; serialized replay callers may supply ISO text.
    source.createdAt = createdAt as DBMessage["createdAt"];

    expect(convertToUIMessages([source])[0].metadata?.createdAt).toBe("2026-10-09T20:54:35.859Z");
  });
});
