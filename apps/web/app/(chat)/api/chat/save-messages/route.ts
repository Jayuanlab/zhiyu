import { auth } from "@/app/(auth)/auth";
import { saveOwnedChatMessages, updateOwnedChatTitle } from "@/lib/db/owned-chat-messages";
import { AgentAnswerAuditError } from "@/lib/db/agent-answer-audits";
import { NextResponse } from "next/server";
import { generateTitleFromUserMessage } from "@/app/(chat)/actions";
import { syncChatToFilesystem } from "@/lib/ai/memory/chat-sync";
import { isTauriMode } from "@/lib/env";
import { setAIUserContextFromRequest } from "@/lib/ai/request-context";
import { clearAIUserContext } from "@/lib/ai";
import type { ChatMessage } from "@openzhiyu/shared";
import type { Attachment } from "@openzhiyu/shared";

/**
 * Save Native Agent messages to database
 */
export async function POST(request: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check content length before parsing
    const contentLength = request.headers.get("content-length");
    const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB limit

    if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      console.error("[SaveMessages] Request body too large:", contentLength);
      return NextResponse.json(
        { error: "Request body too large" },
        { status: 413 },
      );
    }

    let body: {
      chatId: string | null;
      messages: unknown;
      skipSync?: boolean;
      token?: string;
    } | null = null;
    try {
      body = await request.json();
    } catch (jsonError) {
      return NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 },
      );
    }

    // Set AI user context for proper billing in proxy mode
    await setAIUserContextFromRequest({
      userId: session.user.id,
      email: session.user.email || "",
      name: session.user.name || null,
      userType: session.user.type,
      request,
      body,
    });

    const { chatId, messages, skipSync, token } = body ?? {
      chatId: null,
      messages: null,
      token: undefined,
    };

    if (!chatId) {
      return NextResponse.json(
        { error: "chatId is required" },
        { status: 400 },
      );
    }

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: "messages is required" },
        { status: 400 },
      );
    }

    if (messages.some((msg) => !msg || typeof msg !== "object" || typeof msg.id !== "string" || !["user", "assistant", "system", "tool"].includes(msg.role) || (msg.parts !== undefined && !Array.isArray(msg.parts)) || (msg.attachments !== undefined && (!Array.isArray(msg.attachments) || msg.attachments.some((att: unknown) => !att || typeof att !== "object"))))) {
      return NextResponse.json({ error: "Invalid message identity or role", code: "invalid_message_request" }, { status: 400 });
    }
    // A temporary title never requires a model call before ownership is checked.
    const firstUserMessage = messages.find((msg) => msg.role === "user");
    let tempTitle = "New Chat";
    if (firstUserMessage) {
      const content = firstUserMessage.content ?? firstUserMessage.parts;
      if (typeof content === "string") tempTitle = content.slice(0, 20).trim();
      else if (Array.isArray(content)) {
        const textPart = content.find((part) => part?.type === "text" && typeof part.text === "string");
        if (textPart) tempTitle = textPart.text.slice(0, 20).trim();
      }
      if (!tempTitle) tempTitle = "New Chat";
    }

    // Save messages to database
    // Filter out large attachment data to avoid JSON parsing failures
    // Images already uploaded via /api/files/upload, only save metadata here
    const MAX_ATTACHMENT_SIZE = 10 * 1024; // 10KB threshold for inline data

    const saved = await saveOwnedChatMessages({
      ownerId: session.user.id,
      chatId,
      title: tempTitle,
      messages: messages.map(
        (
          msg: ChatMessage & {
            attachments?: Attachment[];
            createdAt?: string | Date;
          },
        ) => ({
          chatId,
          id: msg.id,
          role: msg.role,
          parts: msg.parts || [],
          attachments: (msg.attachments || []).map((att: Attachment) => {
            // If url is base64 and too large, clear it (keep other metadata)
            if (
              att.url &&
              att.url.length > MAX_ATTACHMENT_SIZE &&
              att.url.startsWith("data:")
            ) {
              return {
                ...att,
                url: "", // Clear large base64 data
              };
            }
            return att;
          }),
          createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
          metadata: msg.metadata,
        }),
      ),
    });
    const chat = saved.chat;
    if (saved.created && firstUserMessage && token) {
      generateTitleFromUserMessage({ token, message: firstUserMessage })
        .then((title) => updateOwnedChatTitle({ ownerId: session.user.id, chatId, title }))
        .catch(() => console.error("[SaveMessages] Failed to generate title"));
    }

    // Sync chat history to filesystem (skip during streaming to avoid per-chunk I/O)
    if (!skipSync) {
      const tauriMode = isTauriMode();

      try {
        if (chat && messages) {
          const chatHistory = {
            id: chat.id,
            title: chat.title,
            createdAt: chat.createdAt,
            messages: (
              messages as (ChatMessage & {
                attachments?: Attachment[];
                createdAt?: string | Date;
              })[]
            ).map((msg) => ({
              id: msg.id,
              chatId,
              role: msg.role as "user" | "assistant" | "system",
              parts: msg.parts || [],
              attachments: (msg.attachments || []).map((att: Attachment) => {
                // If url is base64 and too large, clear it (keep other metadata)
                if (
                  att.url &&
                  att.url.length > MAX_ATTACHMENT_SIZE &&
                  att.url.startsWith("data:")
                ) {
                  return {
                    ...att,
                    url: "",
                  };
                }
                return att;
              }),
              createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
              metadata: msg.metadata ?? null,
            })),
          };

          if (tauriMode) {
            await syncChatToFilesystem(chatHistory);
          }
        }
      } catch (syncError) {
        // Sync failure does not affect message saving
        console.error("[SaveMessages] Sync error (non-fatal):", syncError);
      }
    }

    clearAIUserContext();
    return Response.json({
      success: true,
      chat: chat
        ? {
            id: chat.id,
            title: chat.title,
            createdAt: chat.createdAt,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof AgentAnswerAuditError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    console.error("[SaveMessages] Error:", error);
    clearAIUserContext();
    return NextResponse.json(
      { error: "Failed to save messages" },
      { status: 500 },
    );
  } finally {
    clearAIUserContext();
  }
}
