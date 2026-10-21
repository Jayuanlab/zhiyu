import { describe, it, expect } from "vitest";
import { resolveZhiyuMemoryPolicy } from "@/lib/memory-zhiyu/policy";
import {
  makeRecordLifecycle,
  memoryRecallOmitReason,
  storedRecordLifecycle,
} from "@/lib/memory/records/lifecycle";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
const record: BrainMemory = {
  id: "fixture",
  userId: "owner",
  ownerType: "work",
  ownerId: "work",
  scope: { type: "work", workId: "work" },
  memoryType: "insight",
  subject: "Report",
  content: "2026-10-21 盘前日报：现价 10.5；本轮运行完成。",
  status: "active",
  confidence: 80,
  evidenceRefs: [],
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
};
describe("Zhiyu installed project policy", () => {
  it("keeps 24h/7d and 30/90 while recording the installed pure strategy provenance", () => {
    const p = resolveZhiyuMemoryPolicy(record);
    expect(p.runWindowMs).toBe(86400_000);
    expect(p.reviewDefaultDays).toBe(30);
    expect(p.reviewMaxDays).toBe(90);
    expect(p.eligible).toBe(false);
    expect(p.trace).toMatchObject({
      id: "zhiyu.memory.records",
      version: "2.0.0",
    });
    expect(JSON.stringify(p.trace)).not.toContain(record.content);
    expect(
      resolveZhiyuMemoryPolicy({
        ...record,
        content: "A technical explanation",
        tags: [],
      }).runWindowMs,
    ).toBe(7 * 86400_000);
  });
  it("writes policy provenance only into a new lifecycle and rejects malformed stamps", () => {
    const lifecycle = makeRecordLifecycle(
      record,
      "run_record",
      "owner reason",
      new Date(),
      "command",
    );
    expect(lifecycle.policy?.id).toBe("zhiyu.memory.records");
    expect(lifecycle.usableUntil).toBe("2026-10-22T00:00:00.000Z");
    const classified = { ...record, metadata: { recordLifecycle: lifecycle } };
    expect(storedRecordLifecycle(classified)).not.toBeNull();
    expect(memoryRecallOmitReason(classified)).toBe("record_class:run_record");
    expect(
      memoryRecallOmitReason({
        ...classified,
        metadata: {
          recordLifecycle: { ...lifecycle, policy: { id: "forged" } },
        },
      }),
    ).toBe("record_lifecycle_invalid");
  });
});
