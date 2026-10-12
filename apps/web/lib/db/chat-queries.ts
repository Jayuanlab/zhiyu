import { and, asc, count, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { AppError } from "@openzhiyu/shared/errors";
import { isTauriMode } from "@/lib/env/constants";
import { DB_INSERT_CHUNK_SIZE } from "./batch";
import { db } from "./client";
import { deserializeJson, serializeJson } from "./serialization";
import { chat, message, stream, vote, type Chat, type DBMessage } from "./schema";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string) {
  return UUID_REGEX.test(value);
}

export async function saveChat({
  id,
  userId,
  title,
}: {
  id: string;
  userId: string;
  title: string;
}) {
  try {
    return await db
      .insert(chat)
      .values({
        id,
        createdAt: new Date(),
        userId,
        title,
        visibility: "public",
      })
      .onConflictDoUpdate({
        target: chat.id,
        set: {
          title,
          visibility: "public",
        },
      });
  } catch (error) {
    console.error(error);
    throw new AppError("bad_request:database", `Failed to save chat. ${error}`);
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}): Promise<{
  chats: Array<
    Chat & {
      latestMessageTime: Date | null;
      latestMessageContent: string | null;
      messageCount: number;
    }
  >;
  hasMore: boolean;
}> {
  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<unknown>) =>
      db
        .select()
        .from(chat)
        .where(
          whereCondition
            ? and(whereCondition, eq(chat.userId, id))
            : eq(chat.userId, id),
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: Array<Chat> = [];

    if (startingAfter && !isValidUuid(startingAfter)) {
      return { chats: [], hasMore: false };
    }

    if (endingBefore && !isValidUuid(endingBefore)) {
      return { chats: [], hasMore: false };
    }

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        return { chats: [], hasMore: false };
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        return { chats: [], hasMore: false };
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;
    const chatsToReturn = hasMore
      ? filteredChats.slice(0, limit)
      : filteredChats;

    const chatsWithExtendedInfo = await Promise.all(
      chatsToReturn.map(async (chat) => {
        const [latestMessages, [{ count: messageCount }]] = await Promise.all([
          db
            .select()
            .from(message)
            .where(eq(message.chatId, chat.id))
            .orderBy(desc(message.createdAt))
            .limit(1),
          db
            .select({ count: count(message.id) })
            .from(message)
            .where(eq(message.chatId, chat.id))
            .execute(),
        ]);

        let latestMessageContent = null;
        if (latestMessages.length > 0) {
          const latestMessage = latestMessages[0];
          type MessagePart = {
            type?: string;
            text?: string;
          };
          const parts = Array.isArray(latestMessage.parts)
            ? (latestMessage.parts as MessagePart[])
            : [];
          if (parts.length > 0) {
            const textParts = parts
              .filter(
                (
                  part,
                ): part is Required<Pick<MessagePart, "text">> & MessagePart =>
                  part?.type === "text" && typeof part.text === "string",
              )
              .map((part) => part.text);
            latestMessageContent = textParts.join("");
          }
        }

        return {
          ...chat,
          latestMessageTime:
            latestMessages.length > 0 ? latestMessages[0].createdAt : null,
          latestMessageContent,
          messageCount: messageCount?.count ?? 0,
        };
      }),
    );

    return {
      chats: chatsWithExtendedInfo,
      hasMore,
    };
  } catch (error) {
    console.error(error);
    throw new AppError(
      "bad_request:database",
      `Failed to get chats by user id. ${error}`,
    );
  }
}

export async function getChatById({ id }: { id: string }) {
  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, id));
    return selectedChat;
  } catch (error) {
    console.error(error);
    throw new AppError(
      "bad_request:database",
      `Failed to get chat by id. ${error}`,
    );
  }
}

export async function deleteChatById({ id }: { id: string }) {
  try {
    await db.delete(vote).where(eq(vote.chatId, id));
    await db.delete(message).where(eq(message.chatId, id));
    await db.delete(stream).where(eq(stream.chatId, id));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, id))
      .returning();
    return chatsDeleted;
  } catch (error) {
    console.error(error);
    throw new AppError(
      "bad_request:database",
      `Failed to delete chat by id. ${error}`,
    );
  }
}

export async function saveMessages({
  messages,
}: {
  messages: Array<DBMessage>;
}) {
  try {
    const serializedMessages = messages.map((msg) => {
      const messageData: any = {
        id: msg.id,
        chatId: msg.chatId,
        role: msg.role,
        parts: serializeJson(msg.parts as any),
        attachments: serializeJson(msg.attachments as any),
        createdAt: msg.createdAt,
      };

      if (msg.metadata !== undefined && msg.metadata !== null) {
        messageData.metadata = serializeJson(msg.metadata as any);
      }

      return messageData;
    });

    for (let i = 0; i < serializedMessages.length; i += DB_INSERT_CHUNK_SIZE) {
      const chunk = serializedMessages.slice(i, i + DB_INSERT_CHUNK_SIZE);
      await db
        .insert(message)
        .values(chunk)
        .onConflictDoUpdate({
          target: message.id,
          set: {
            parts: sql`excluded.parts`,
            attachments: sql`excluded.attachments`,
            metadata: sql`excluded.metadata`,
          },
        });
    }
  } catch (error) {
    console.error("[saveMessages] Error:", error);
    throw new AppError(
      "bad_request:database",
      `Failed to save messages. ${error}`,
    );
  }
}

export async function getMessagesByChatId({
  id,
  limit = 1000,
  offset = 0,
  order = "oldest",
}: {
  id: string;
  limit?: number;
  offset?: number;
  order?: "oldest" | "latest";
}) {
  try {
    const messages = await db
      .select()
      .from(message)
      .where(eq(message.chatId, id))
      .orderBy(...(order === "latest" ? [desc(message.createdAt), desc(message.id)] : [asc(message.createdAt), asc(message.id)]))
      .limit(limit)
      .offset(offset);

    const chronological = order === "latest" ? messages.reverse() : messages;
    if (isTauriMode()) {
      return chronological.map((msg: any) => ({
        ...msg,
        parts: deserializeJson(msg.parts),
        attachments: deserializeJson(msg.attachments),
        metadata: msg.metadata ? deserializeJson(msg.metadata) : msg.metadata,
      }));
    }

    return chronological;
  } catch (error) {
    console.error(error);
    throw new AppError(
      "bad_request:database",
      `Failed to get messages by chat id. ${error}`,
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  try {
    const messages = await db.select().from(message).where(eq(message.id, id));

    if (isTauriMode() && messages.length > 0) {
      return messages.map((msg: any) => ({
        ...msg,
        parts: deserializeJson(msg.parts),
        attachments: deserializeJson(msg.attachments),
        metadata: msg.metadata ? deserializeJson(msg.metadata) : msg.metadata,
      }));
    }

    return messages;
  } catch (error) {
    console.error(error);
    throw new AppError(
      "bad_request:database",
      `Failed to get message by id. ${error}`,
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp)),
      );

    const messageIds = messagesToDelete.map((message: any) => message.id);

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds)),
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds)),
        );
    }
  } catch (error) {
    console.error(error);
    throw new AppError(
      "bad_request:database",
      `Failed to delete messages by chat id after timestamp. ${error}`,
    );
  }
}
