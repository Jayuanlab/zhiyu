import { describe, expect, it } from "vitest";
import { resolveWorkshopResearchReadingProgress } from "@/lib/workshops/research-reading-progress";
import { inspectWorkshopResearchSourceRecovery } from "@/lib/workshops/research-source-recovery";
import type { WorkshopResearchEvidenceEvent } from "@/lib/workshops/research-evidence-verification";

const url = "https://arxiv.org/html/2501.12948v1";
const config = { researchEvidenceContract: { version: "primary-reading/v1", reportDelivery: "grounded-report/v1",
  requiredPrimarySources: [{ id: "r1", label: "R1", urls: [url] }] } };
const receipt = (offset = 0, length = 30000, metadata: Record<string, unknown> = {}): WorkshopResearchEvidenceEvent => ({
  id: `read-${offset}`, runId: "run", type: "source_checked", metadata: { receiptAuthority: "runtime", toolName: "webReadPage", ok: true,
    url, evidenceId: "body", contentHash: "a".repeat(64), offset, contentLength: length, totalChars: 60000,
    nextOffset: offset + length === 60000 ? null : offset + length, qualityScore: 90, method: "jina_defuddle", ...metadata },
});
const input = (events: WorkshopResearchEvidenceEvent[] = []) => ({ modelConfig: config, taskText: "research", runId: "run", events });

describe("host-derived research reading phases", () => {
  it("does not affect ordinary tools, unrelated keyword tasks or non-grounded delivery", () => {
    expect(resolveWorkshopResearchReadingProgress({ ...input(), modelConfig: {} })).toBeNull();
    expect(resolveWorkshopResearchReadingProgress({ ...input(), modelConfig: { researchEvidenceContract: { ...config.researchEvidenceContract, reportDelivery: undefined } } })).toBeNull();
    expect(resolveWorkshopResearchReadingProgress({ ...input(), modelConfig: { researchEvidenceContract: { ...config.researchEvidenceContract, taskKeywords: ["deepseek"] } } })).toBeNull();
  });

  it("starts with exact initial permitted reads without inventing a saved body identity", () => {
    const progress = resolveWorkshopResearchReadingProgress(input());
    expect(progress).toMatchObject({ version: "research-reading-progress/v1", phase: "read_sources", requiredSourceCount: 1, completeSourceCount: 0 });
    expect(progress?.pendingReadRequests).toEqual([{ url, offset: 0, maxChars: 30000 }]);
    expect(progress?.coverage[0]).toMatchObject({ status: "incomplete", coveredChars: 0 });
    expect(progress?.gaps.length).toBeGreaterThan(0);
    expect(progress?.gaps.join(" ")).not.toContain("报告缺少");
    expect(progress?.guidance).toContain("不是报告生成门禁");
    expect(progress?.guidance).toContain("可用已有材料交付阶段性 Markdown 报告");
  });

  it("exposes the actual next cursor and transitions only once the entire source is contiguous", () => {
    const partial = resolveWorkshopResearchReadingProgress(input([receipt()]));
    expect(partial?.pendingReadRequests).toEqual([{ url, evidenceId: "body", offset: 30000, maxChars: 30000 }]);
    expect(partial?.coverage[0]).toMatchObject({ status: "incomplete", coveredChars: 30000, totalChars: 60000 });
    const complete = resolveWorkshopResearchReadingProgress(input([receipt(), receipt(30000)]));
    expect(complete).toMatchObject({ phase: "select_quotes", completeSourceCount: 1, requiredSourceCount: 1, pendingReadRequests: [], gaps: [] });
    expect(complete?.warnings).toContain("extraction_not_independently_verified");
    expect(complete).not.toHaveProperty("reportVerified");
  });

  it("reuses the exact recovery requests and their existing allow/deny boundary", () => {
    const args = input([receipt()]); const recovery = inspectWorkshopResearchSourceRecovery(args);
    const progress = resolveWorkshopResearchReadingProgress(args);
    expect(progress?.pendingReadRequests).toEqual(recovery.requests);
    for (const request of progress?.pendingReadRequests ?? []) {
      expect(recovery.isToolAllowed("webReadPage", request)).toBe(true);
      expect(recovery.isToolAllowed("workshopRemember", request)).toBe(false);
      expect(recovery.isToolAllowed("webReadPage", { ...request, offset: 0 })).toBe(false);
    }
    expect(JSON.stringify(progress)).not.toContain("allowedTools");
  });

  it.each([
    { receiptAuthority: "agent" }, { ok: false }, { qualityScore: 54 }, { method: "direct_fetch" },
    { finalUrl: "https://example.com/redirected" }, { contentHash: "bad" }, { nextOffset: null },
  ])("does not turn untrusted, failed, low-quality or malformed receipts into coverage: %j", patch => {
    const progress = resolveWorkshopResearchReadingProgress(input([receipt(0, 30000, patch), receipt(30000)]));
    expect(progress?.phase).toBe("read_sources"); expect(progress?.coverage[0].coveredChars).toBe(0);
    expect(progress?.completeSourceCount).toBe(0);
  });

  it("ignores old runs, gaps and mismatched version identities rather than combining their tails", () => {
    for (const events of [
      [{ ...receipt(), runId: "old" }, receipt(30000)],
      [receipt(30000)],
      [receipt(), receipt(30000, 30000, { evidenceId: "another-body" })],
      [receipt(), receipt(30000, 30000, { contentHash: "b".repeat(64) })],
    ]) {
      const progress = resolveWorkshopResearchReadingProgress(input(events));
      expect(progress?.phase).toBe("read_sources"); expect(progress?.completeSourceCount).toBe(0);
      expect(progress?.coverage[0].coveredChars).toBeLessThan(60000);
    }
  });

  it("denies conflicting event identity while preserving exact duplicate observations", () => {
    const conflict = resolveWorkshopResearchReadingProgress(input([receipt(), receipt(0, 30000, { ok: false }), receipt(30000)]));
    expect(conflict?.phase).toBe("read_sources"); expect(conflict?.coverage[0].coveredChars).toBe(0);
    const duplicate = resolveWorkshopResearchReadingProgress(input([receipt(), receipt(), receipt(30000)]));
    expect(duplicate?.phase).toBe("select_quotes");
  });

  it("fails closed on overflow, invalid grounded contracts and missing run identity without issuing speculative reads", () => {
    for (const args of [
      { ...input([receipt(), receipt(30000)]), eventsOverflow: true },
      input(Array.from({ length: 1001 }, () => receipt())),
      { ...input([receipt(), receipt(30000)]), runId: "" },
      { ...input(), modelConfig: { researchEvidenceContract: { ...config.researchEvidenceContract, requiredPrimarySources: [] } } },
    ]) {
      const progress = resolveWorkshopResearchReadingProgress(args);
      expect(progress?.phase).toBe("unavailable");
      expect(progress?.pendingReadRequests).toEqual([]);
      expect(progress?.completeSourceCount).toBe(0);
      expect(progress?.gaps.length).toBeGreaterThan(0);
    }
    const exactlyBounded = resolveWorkshopResearchReadingProgress(input([...Array.from({ length: 999 }, () => receipt()), receipt(30000)]));
    expect(exactlyBounded?.phase).toBe("select_quotes");
  });

  it("preserves its inputs and exposes no model call, network operation or completion status", () => {
    const args = input([receipt()]); const before = JSON.stringify(args);
    const progress = resolveWorkshopResearchReadingProgress(args);
    expect(JSON.stringify(args)).toBe(before);
    for (const key of ["report", "success", "completed", "passed", "modelCalls", "externalActions"]) expect(progress).not.toHaveProperty(key);
  });
});

// Whitelisted immutable source facts copied from real review53 run
// e0e8c7e2-3e51-8af0-a238-bab3b4d7cccd's sourceCheckedReceipts, in event time order.
// No owner ID, execution credential, provider call or database access is needed.
const realRunId = "e0e8c7e2-3e51-8af0-a238-bab3b4d7cccd";
const realSources = [
  { id: "deepseek-math", label: "DeepSeekMath", url: "https://arxiv.org/html/2402.03300v3", evidenceId: "f8b418aa-2dac-4276-a493-4b619b140b19", contentHash: "669a2695b649d39f8019f681d86630d3a80213aa84344376a33f02c6ed13fe5a", totalChars: 85645 },
  { id: "deepseek-r1", label: "DeepSeek-R1", url: "https://arxiv.org/html/2501.12948v1", evidenceId: "7050ac84-aa4e-497f-b701-c2dad0afd242", contentHash: "3807feb1320a6abd14d1672a2edfb3bd70f05f3b389fc48b4c723d9941daa80a", totalChars: 60740 },
  { id: "deepseek-grm", label: "DeepSeek-GRM", url: "https://arxiv.org/html/2504.02495v1", evidenceId: "af36a972-2277-4f71-986c-4123840ac9bc", contentHash: "8b803991f47504a12ed2cb910968bcd524ced24dcd712b1c1f13f28737de4d54", totalChars: 135404 },
];
const realRows: Array<[string, number, number, number]> = [
  ["2557f506-d171-49af-8ec0-2c9c0652354a", 0, 0, 30000], ["41cc4c6a-ef3e-4c72-a900-cf695c05905c", 1, 0, 30000],
  ["99db1ef2-a213-4315-b2ca-4259d88e7206", 2, 0, 30000], ["222577e5-1898-4285-800e-97943896fed8", 0, 30000, 30000],
  ["4de32091-24d7-4429-b8a3-080125bb79b9", 1, 30000, 30000], ["efe96d85-68bc-4c80-a158-99a6f86b147e", 2, 30000, 30000],
  ["eca784e0-6701-4fdb-a8ea-9e3e4a469dcd", 0, 60000, 25645], ["cd17b19d-12c7-440e-8e06-3c164b6cd432", 1, 60000, 740],
  ["d83f6902-5ac1-43ba-ac85-5008a4549abe", 2, 60000, 30000], ["199cfe4c-50a1-4846-a615-319691cbfd89", 2, 90000, 30000],
  ["7a1377d9-bb9c-43b7-b408-53463964ca7d", 2, 120000, 15404],
];
const realEvents: WorkshopResearchEvidenceEvent[] = realRows.map(([id, sourceIndex, offset, contentLength]) => {
  const source = realSources[sourceIndex];
  return { id, runId: realRunId, type: "source_checked", metadata: { receiptAuthority: "runtime", toolName: "webReadPage", ok: true,
    url: source.url, finalUrl: source.url, evidenceId: source.evidenceId, contentHash: source.contentHash,
    offset, contentLength, totalChars: source.totalChars, nextOffset: offset + contentLength === source.totalChars ? null : offset + contentLength,
    qualityScore: 80, method: "jina_defuddle", finalUrlVerified: false } };
});
const realConfig = { researchEvidenceContract: { version: "primary-reading/v1", reportDelivery: "grounded-report/v1",
  requiredPrimarySources: realSources.map(source => ({ id: source.id, label: source.label, urls: [source.url] })) } };
const realProgress = (count: number) => resolveWorkshopResearchReadingProgress({ modelConfig: realConfig, taskText: "DeepSeek research", runId: realRunId, events: realEvents.slice(0, count) });

describe("matched real review53 reading prefix replay", () => {
  it("keeps read_sources after the first null cursor and names the two exact remaining saved-body reads", () => {
    const progress = realProgress(7);
    expect(progress).toMatchObject({ phase: "read_sources", requiredSourceCount: 3, completeSourceCount: 1 });
    expect(progress?.coverage.map(source => [source.sourceId, source.coveredChars, source.totalChars, source.status])).toEqual([
      ["deepseek-math", 85645, 85645, "complete"], ["deepseek-r1", 60000, 60740, "incomplete"], ["deepseek-grm", 60000, 135404, "incomplete"],
    ]);
    expect(progress?.pendingReadRequests).toEqual([
      { url: realSources[1].url, evidenceId: realSources[1].evidenceId, offset: 60000, maxChars: 30000 },
      { url: realSources[2].url, evidenceId: realSources[2].evidenceId, offset: 60000, maxChars: 30000 },
    ]);
  });

  it("only transitions after all 11 real windows and preserves the last missing GRM tail until then", () => {
    for (let count = 0; count < 11; count++) expect(realProgress(count)?.phase).toBe("read_sources");
    expect(realProgress(10)?.pendingReadRequests).toEqual([{ url: realSources[2].url, evidenceId: realSources[2].evidenceId, offset: 120000, maxChars: 30000 }]);
    const complete = realProgress(11);
    expect(complete).toMatchObject({ phase: "select_quotes", requiredSourceCount: 3, completeSourceCount: 3, pendingReadRequests: [], gaps: [] });
    expect(complete?.coverage.reduce((sum, source) => sum + source.coveredChars, 0)).toBe(281789);
  });
});
