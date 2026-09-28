import { describe, it, expect } from "vitest";
import { prepareRecordEvidence } from "@/lib/brain/evidence-requirements";

const record = (fields: Record<string, unknown>) => [{ id: "db:snapshots:record", content: JSON.stringify({ capturedAt: "2026-09-22", fields }) }];
describe("record evidence requirements", () => {
  it("does not substitute capture time for creation time", () => {
    const result = prepareRecordEvidence("状态依据哪些记忆，何时生成？", record({ source_memory_ids: [] }));
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "created_at", state: "missing" }),
      expect.objectContaining({ field: "source_memory_ids", state: "empty" }),
    ]));
  });
  it("distinguishes explicit null from missing fields", () => {
    expect(prepareRecordEvidence("何时生成？", record({ created_at: null })).checks[0].state).toBe("null");
  });
  it("preserves short required fields when content exceeds the budget", () => {
    const result = prepareRecordEvidence("保存了什么状态，何时生成？", record({ content: "x".repeat(5000), created_at: "2026-09-01" }));
    const packed = JSON.parse(result.evidence[0].content);
    expect(packed.fields.created_at).toBe("2026-09-01");
    expect(packed.chunkedFields).toContain("content");
    const fragments = result.evidence.slice(1).map(item => JSON.parse(item.content).fragment).join("");
    expect(JSON.parse(fragments)).toBe("x".repeat(5000));
    expect(result.checks).toContainEqual({ evidenceId: "db:snapshots:record", field: "content", state: "present" });
  });
  it("does not require record fields from prose architecture memories", () => {
    expect(prepareRecordEvidence("何时生成？", [{ id: "memory", content: JSON.stringify({ content: "Design note" }) }]).checks).toEqual([]);
  });
  it("does not accept a different record as the requested record", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const result = prepareRecordEvidence(`${id} 何时生成？`, [{ id: `db:snapshots:${id}`, content: "{}" }, { id: "db:snapshots:other", content: '{"created_at":"today"}' }]);
    expect(result.checks).toEqual([{ evidenceId: `db:snapshots:${id}`, field: "created_at", state: "missing" }]);
  });
});
