import { describe, expect, it } from "vitest";
import { historicalStatisticsClarification as clarify } from "@/lib/ai/historical-statistics-clarification";
const prompt = "截至评测快照，Brain 记忆各状态有多少条？";
describe("unidentified historical aggregate", () => {
  it("asks for a source instead of reading an unbounded current memory list", () => {
    expect(clarify({ prompt })).toContain("尚未读取或统计");
  });
  it("preserves current counts and explicit dates or record references", () => {
    for (const question of ["当前记忆各状态有多少条？", "截至 2026-09-19 的历史快照有多少条？", "截至快照编号：snapshot-42 有多少条？", "记录 bc4f604b-7d71-4011-b35d-0eaf42b9f7de 的历史快照有多少条？"]) expect(clarify({ prompt: question })).toBeNull();
  });
  it("does not discard context or attachments that could identify the snapshot", () => {
    expect(clarify({ prompt, conversation: [{ role: "user", content: "请使用昨天发的快照" }] })).toBeNull();
    expect(clarify({ prompt, sessionId: "existing" })).toBeNull();
    expect(clarify({ prompt, ragDocuments: [{}] })).toBeNull();
    expect(clarify({ prompt, fileAttachments: [{}] })).toBeNull();
  });
});
