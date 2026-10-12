import { parseStructuredOutput } from "@/lib/types/execution-result";
import { stripMalformedToolCalls } from "@/lib/utils/tool-names";

type Part = { type: string; text?: unknown; content?: unknown; data?: unknown };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** A reference selects literal data presentation; only the server audit grants verification. */
export function hasAnswerEvidenceReference(parts: readonly Part[]) {
  return parts.some(part => part.type === "data-answerEvidence" && part.data && typeof part.data === "object"
    && "turnId" in part.data && typeof part.data.turnId === "string" && uuid.test(part.data.turnId));
}

export function projectMessageDisplayText(rawText: string, evidenceReferenced: boolean) {
  // Verified source fields may themselves contain XML/structured-output examples.
  // Their server renderer quotes them as data; deleting bytes breaks the receipt.
  return evidenceReferenced ? rawText : stripMalformedToolCalls(parseStructuredOutput(rawText).cleanText);
}

export function joinedMessageDisplayText(parts: readonly Part[], evidenceReferenced: boolean) {
  return parts.filter(part => part.type === "text").map(part => {
    const text = part.text ?? part.content;
    return projectMessageDisplayText(typeof text === "string" ? text : "", evidenceReferenced);
  }).join("");
}
