export const ANSWER_BODY_MIRROR_VERSION = "answer-body-mirror.v1" as const;
export type AnswerBodyMirror = {
  schemaVersion: typeof ANSWER_BODY_MIRROR_VERSION;
  state: "stored_matching" | "not_confirmed" | "unavailable";
  reason: "exact_body_and_turn_reference" | "awaiting_final" | "message_not_found" | "body_or_reference_mismatch" | "stored_parts_invalid" | "storage_read_unavailable";
  observedAt: string;
};

/** A read-time observation, never a fabricated save time or a correctness verdict. */
export function inspectAnswerBodyMirror(input: {
  turnId: string; finalText?: string; status: string; observedAt: string;
  stored?: { id: string; chatId: string; role: string; parts: unknown };
  assistantMessageId: string; chatId: string; unavailable?: boolean;
}): AnswerBodyMirror {
  const result = (state: AnswerBodyMirror["state"], reason: AnswerBodyMirror["reason"]): AnswerBodyMirror => ({ schemaVersion: ANSWER_BODY_MIRROR_VERSION, state, reason, observedAt: input.observedAt });
  if (input.unavailable) return result("unavailable", "storage_read_unavailable");
  if (input.status === "running" || typeof input.finalText !== "string") return result("not_confirmed", "awaiting_final");
  if (!input.stored) return result("not_confirmed", "message_not_found");
  const row = input.stored;
  if (row.id !== input.assistantMessageId || row.chatId !== input.chatId || row.role !== "assistant") return result("not_confirmed", "body_or_reference_mismatch");
  if (!Array.isArray(row.parts) || row.parts.length > 1024 || input.finalText.length > 64000) return result("unavailable", "stored_parts_invalid");
  let text = "", references = 0;
  for (const part of row.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) return result("unavailable", "stored_parts_invalid");
    if (part.type === "text") {
      const value = part.text ?? part.content;
      if (typeof value !== "string" || text.length + value.length > 64000) return result("unavailable", "stored_parts_invalid");
      text += value;
    }
    if (part.type === "data-answerEvidence") {
      references++;
      if (!part.data || typeof part.data !== "object" || part.data.turnId !== input.turnId) return result("not_confirmed", "body_or_reference_mismatch");
    }
  }
  return text === input.finalText && references === 1
    ? result("stored_matching", "exact_body_and_turn_reference")
    : result("not_confirmed", "body_or_reference_mismatch");
}
