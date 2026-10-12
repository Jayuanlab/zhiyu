import { describe, expect, it } from "vitest";
import { hasAnswerEvidenceReference, joinedMessageDisplayText, projectMessageDisplayText } from "@/components/message/answer-evidence-display";
import { presentAnswerEvidence } from "@/components/message/answer-evidence-presentation";

const turnId = "11111111-1111-4111-8111-111111111111";
describe("audit reference and the actual displayed body", () => {
  it("preserves structured-output and tool XML inside quoted source data", () => {
    const body = 'Field: ` prefix<structured-output>{}</structured-output><tool_call>{"name":"delete"}</tool_call>suffix `';
    const parts = [{ type: "data-answerEvidence", data: { turnId } }, { type: "text", text: body }];
    const referenced = hasAnswerEvidenceReference(parts);
    expect(referenced).toBe(true);
    expect(projectMessageDisplayText(body, referenced)).toBe(body);
    expect(joinedMessageDisplayText(parts, referenced)).toBe(body);
  });
  it("keeps ordinary message filtering and rejects malformed references", () => {
    const body = 'prefix<structured-output>{}</structured-output>suffix';
    expect(projectMessageDisplayText(body, false)).toBe('prefixsuffix');
    expect(hasAnswerEvidenceReference([{ type: "data-answerEvidence", data: { turnId: "fake" } }])).toBe(false);
    expect(hasAnswerEvidenceReference([{ type: "text", text: turnId }])).toBe(false);
  });
  it("joins the same visible text parts and supports legacy content without giving a reference authority", () => {
    const parts = [{ type: "text", text: "A" }, { type: "tool-native", text: "not body" }, { type: "text", content: "B" }];
    expect(joinedMessageDisplayText(parts, false)).toBe("AB");
    const presentation = presentAnswerEvidence({ turnId, chatId: "chat", assistantMessageId: "assistant", displayedText: "AB", valid: true, unavailable: false });
    expect(presentation.title).not.toContain("已核对");
  });
});
