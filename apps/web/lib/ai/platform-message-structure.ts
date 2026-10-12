export type PlatformMessageRawRead = { source: string; id: string; offset: 0; expectedHash: string };

const maximumParts = 32;
const maximumPartTextCharacters = 2000;
const maximumPartsCharacters = 6000;
const knownTypes = new Set(["text", "reasoning", "tool-native", "tool-call", "tool-result", "tool_use", "tool_result", "image", "file"]);
const payloadKeys = ["text", "toolInput", "toolOutput", "input", "output", "data", "url", "image", "file"];

/** A bounded view of an owner-read message, never a replacement for its raw record. */
export function platformMessageStructure(source: string, fields: Record<string, unknown>, rawRead: PlatformMessageRawRead) {
  if (!["message", "messagev2", "chatmessages"].includes(source.replaceAll("_", "").toLowerCase())) return undefined;
  const original = fields.parts;
  const partsStatus = original === undefined ? "missing" : original === null ? "not_recorded"
    : !Array.isArray(original) ? "invalid" : original.length === 0 ? "empty_array" : "observed";
  const parts: Array<Record<string, unknown>> = [];
  let nextTextIndex = 0;
  if (Array.isArray(original)) {
    for (const [index, value] of original.slice(0, maximumParts).entries()) {
      let part: Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        part = { index, type: null, payloadStatus: "invalid_part" };
      } else {
        const type = typeof value.type === "string" && value.type.length <= 80 ? value.type : null;
        // index remains the original parts index. textIndex is the separate
        // ordered known-text coordinate used by exact interpretation anchors.
        part = { index, type, ...(type === "text" ? { textIndex: nextTextIndex++ } : {}) };
        if (type === "text") {
          const text = value.text;
          part.textStatus = text === undefined ? "missing" : text === null ? "not_recorded"
            : typeof text !== "string" ? "invalid" : "present_unread";
          if (typeof text === "string") {
            part.textCharacters = text.length;
            const shown = { ...part, textStatus: "shown", text };
            if (text.length <= maximumPartTextCharacters && JSON.stringify([...parts, shown]).length <= maximumPartsCharacters) part = shown;
          }
        } else {
          part.payloadStatus = "present_unread";
          part.payloadFields = payloadKeys.filter(key => Object.hasOwn(value, key));
          if (typeof value.toolName === "string" && value.toolName.length <= 120) part.toolName = value.toolName;
          if (typeof value.status === "string" && value.status.length <= 40) part.recordedToolStatus = value.status;
        }
      }
      if (JSON.stringify([...parts, part]).length > maximumPartsCharacters) break;
      parts.push(part);
    }
  }
  const partCount = Array.isArray(original) ? original.length : null;
  const hasMoreParts = partCount !== null && partCount > parts.length;
  const chatId = Object.hasOwn(fields, "chatId") ? fields.chatId : fields.chat_id;
  const validChatId = typeof chatId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(chatId);
  const knownTextPartsComplete = partCount !== null && !hasMoreParts && parts.every(part =>
    typeof part.type === "string" && knownTypes.has(part.type) && (part.type !== "text" || part.textStatus === "shown"));
  return {
    schemaVersion: "platform-message-structure.v1" as const,
    representation: "bounded_message_parts_projection" as const,
    ...(typeof fields.role === "string" && fields.role.length <= 80 ? { role: fields.role } : {}),
    ...(validChatId ? { chatId } : {}),
    chatIdStatus: chatId === undefined ? "missing" : chatId === null ? "not_recorded" : validChatId ? "shown" : "invalid",
    partsStatus, partCount, parts, hasMoreParts, omittedPartCount: partCount === null ? null : partCount - parts.length,
    knownTextPartsComplete, rawRecordComplete: false as const, rawRead,
    warning: "This projection shows part types and bounded whole text parts only. Reasoning, tool payloads and unknown parts remain unread here; recorded tool status is not a verified receipt. A message role does not establish a user's decision. Follow rawRead and its continuation for omitted content; this view never marks the raw record fully read. Read the related chat separately for its title.",
  };
}
