import { describe, expect, it } from "vitest";
import {
  brainMemoryCorrectionRecordId, correctionTextHash, getBrainMemoryCorrectionDraftVersion,
  parseBrainMemoryCorrectionDraftRequest, parseBrainMemoryCorrectionIntent,
  type BrainMemoryCorrectionDraft,
} from "@/lib/brain/memory-correction-draft-common";

const expectedVersion = `bmrv1:${"a".repeat(64)}`;
const original = "原有的完整记忆内容";

describe("bounded owner correction draft rules", () => {
  it("normalizes only command identity and preserves the raw owner statement", () => {
    const intent = " \r\n完整改为：新的完整正文\r\n ";
    expect(parseBrainMemoryCorrectionDraftRequest({ commandId: " command ", expectedVersion, intent }))
      .toEqual({ commandId: "command", expectedVersion, intent });
    expect(correctionTextHash(intent)).not.toBe(correctionTextHash(intent.trim()));
  });

  it("rejects hidden authority, status, targets and source references", () => {
    for (const extra of [{ authority: "owner_statement" }, { status: "verified" }, { evidenceRefs: ["forged"] }, { memoryId: "forged" }, { metadata: { trusted: true } }]) {
      expect(() => parseBrainMemoryCorrectionDraftRequest({ commandId: "command", expectedVersion, intent: "完整改为：新正文", ...extra })).toThrow();
    }
  });

  it("requires bounded nonempty text, exact memory tokens and a command identifier", () => {
    for (const patch of [{ intent: " " }, { intent: "x".repeat(4001) }, { intent: "x\0y" }, { expectedVersion: "id-only" }, { commandId: "" }, { commandId: "x".repeat(201) }]) {
      expect(() => parseBrainMemoryCorrectionDraftRequest({ commandId: "command", expectedVersion, intent: "完整改为：新正文", ...patch })).toThrow();
    }
  });

  it("prepares only explicit complete replacement commands", () => {
    for (const intent of ["完整改为：新的完整正文", "请完整改为: 新的完整正文", "把这条记忆完整改为：新的完整正文"]) {
      const draft = parseBrainMemoryCorrectionIntent(original, intent);
      expect(draft).toMatchObject({ outcome: "ready", operation: "correct", content: "新的完整正文", authority: null, sourceObservedAt: null, questions: [] });
      expect(draft.provider).toBe("deterministic_rules");
      expect(draft.reason).toEqual(expect.any(String));
      expect(draft.quote?.text).toBe(draft.content);
      expect(intent.slice(draft.quote!.start, draft.quote!.end)).toBe(draft.content);
    }
  });

  it("uses the full supplied supplement without inferring or concatenating old content", () => {
    const intent = "完整补充为：保留原意并补充后的完整新正文";
    const draft = parseBrainMemoryCorrectionIntent(original, intent);
    expect(draft).toMatchObject({ outcome: "ready", operation: "supplement", content: "保留原意并补充后的完整新正文" });
    expect(draft.content).not.toContain(original);
  });

  it("does not invent authority or an observation time for a state change", () => {
    const draft = parseBrainMemoryCorrectionIntent(original, "状态变化后的完整内容：当前计划已调整为先整理材料");
    expect(draft).toMatchObject({ outcome: "ready", operation: "state_change", content: "当前计划已调整为先整理材料", authority: null, sourceObservedAt: null });
    expect(draft.reason).toContain("人工确认");
  });

  it("quotes an exact deactivation instruction without modifying a memory", () => {
    for (const intent of ["停用这条记忆", "请停用这条记忆。", " \r\n停用这条记忆！ "]) {
      const draft = parseBrainMemoryCorrectionIntent(original, intent);
      expect(draft).toMatchObject({ outcome: "ready", operation: "deactivate", content: null, authority: null, sourceObservedAt: null });
      expect(intent.slice(draft.quote!.start, draft.quote!.end)).toBe(draft.quote!.text);
      expect(draft.quote?.text).toContain("停用这条记忆");
    }
  });

  it("keeps Chinese multiline CRLF and UTF16 quote positions exact", () => {
    const intent = " \r\n完整改为：\r\n  新正文😀第一行\r\n第二行保留事实来源  \r\n ";
    const draft = parseBrainMemoryCorrectionIntent(original, intent);
    expect(draft.outcome).toBe("ready");
    expect(draft.content).toBe("新正文😀第一行\r\n第二行保留事实来源");
    expect(draft.quote).toEqual({ start: intent.indexOf("新正文"), end: intent.indexOf("新正文") + draft.content!.length, text: draft.content });
    expect(intent.slice(draft.quote!.start, draft.quote!.end)).toBe(draft.content);
  });

  it("requires clarification for quotation, hypotheticals, questions and weak claims", () => {
    for (const intent of ["以前不是这样，你理解错了", "完整改为：如果以后改变再考虑", "完整改为：可能没有签约", "完整改为：已经签约？", "他说完整改为：已经签约", "“完整改为：已经签约”", "完整改为：据说已经签约", "停用这条记忆吗？"]) {
      const draft = parseBrainMemoryCorrectionIntent(original, intent);
      expect(draft).toMatchObject({ outcome: "needs_clarification", operation: null, content: null, reason: null, authority: null, sourceObservedAt: null });
      expect(draft.questions.length).toBeGreaterThan(0);
      expect(intent.slice(draft.quote!.start, draft.quote!.end)).toBe(draft.quote!.text);
    }
  });

  it("does not guess partial corrections or restore retired versions", () => {
    for (const intent of ["完整改为：", "补充一句来源还未核实", "把签约改成讨论", "恢复这条记忆", "不要停用这条记忆"]) {
      expect(parseBrainMemoryCorrectionIntent(original, intent).outcome).toBe("needs_clarification");
    }
  });

  it("does not prepare an unchanged body as a new correction", () => {
    expect(parseBrainMemoryCorrectionIntent(original, `完整改为：${original}`))
      .toMatchObject({ outcome: "needs_clarification", detail: "unchanged_content", operation: null, content: null });
  });

  it("keeps immutable draft versions stable after JSON key reordering", () => {
    const draft: BrainMemoryCorrectionDraft = { ...parseBrainMemoryCorrectionIntent(original, "完整改为：新正文"),
      id: "00000000-0000-4000-8000-000000000001", commandId: "command", memoryId: "00000000-0000-4000-8000-000000000002",
      expectedVersion, intent: "完整改为：新正文", evidenceRefs: ["brain-observation:fixture"], createdAt: "2026-10-02T12:00:00.000Z" };
    const version = getBrainMemoryCorrectionDraftVersion(draft);
    expect(version).toMatch(/^bmcd1:[a-f0-9]{64}$/);
    const reordered = Object.fromEntries(Object.entries(draft).reverse()) as BrainMemoryCorrectionDraft;
    expect(getBrainMemoryCorrectionDraftVersion(reordered)).toBe(version);
    expect(getBrainMemoryCorrectionDraftVersion({ ...draft, intent: "完整改为：另一个正文" })).not.toBe(version);
  });

  it("separates user, command and immutable observation/receipt identities", () => {
    const id = brainMemoryCorrectionRecordId("owner", "command", "draft");
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(brainMemoryCorrectionRecordId("owner", "command", "draft")).toBe(id);
    expect(brainMemoryCorrectionRecordId("other", "command", "draft")).not.toBe(id);
    expect(brainMemoryCorrectionRecordId("owner", "other-command", "draft")).not.toBe(id);
    expect(brainMemoryCorrectionRecordId("owner", "command", "observation")).not.toBe(id);
    expect(brainMemoryCorrectionRecordId("owner", "command", "receipt")).not.toBe(id);
  });
});
