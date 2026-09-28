import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { paperRecordKeys, readPaperRecordsForOwner } from "@/lib/ai/platform-paper-records";
import { readPlatformRecordsForOwner } from "@/lib/ai/platform-record-reader";
import { buildPlatformAnswerCoverage } from "@/lib/ai/platform-answer-coverage";

const account = "11111111-1111-4111-8111-111111111111";
const key = `${account}/fill-close-20260908-515980.SH`;
describe("owner-scoped composite ledger evidence", () => {
  it("preserves the full key and does not treat its account UUID as the requested record", async () => {
    const query = vi.fn(async () => []);
    const paper = vi.fn(async () => [{ source: "paper_fills", id: key, fields: { quantity: 20, order_quantity: 50 } }]);
    const result = await readPlatformRecordsForOwner({ userId: "owner", question: key }, query, paper);
    expect(result.requestedIds).toEqual([key]); expect(result.missingIds).toEqual([]);
    expect(paper).toHaveBeenCalledWith("owner", [key]); expect(query).not.toHaveBeenCalled();
  });
  it("binds owner/account/id and joins provenance on BOTH account and order", async () => {
    const statements: any[] = [];
    const execute = vi.fn(async q => { statements.push(new PgDialect().sqlToQuery(q)); return []; });
    await readPaperRecordsForOwner("owner", [key], execute);
    expect(statements).toHaveLength(2);
    for (const s of statements) {
      expect(s.params).toEqual(["owner", account, "fill-close-20260908-515980.SH"]);
      expect(s.sql).toContain("a.owner_id=");
    }
    expect(statements[0].sql).toContain("o.account_id=f.account_id AND o.id=f.order_id");
    expect(paperRecordKeys(`${key} ${key}`)).toEqual([key]);
  });
  it("exposes unavailable ledger reads, not a successful empty table", async () => {
    const result = await readPlatformRecordsForOwner({ userId: "owner", question: key }, vi.fn(), async () => { throw Error("offline"); });
    expect(result.failedSources).toEqual(["paper_ledger"]); expect(result.missingIds).toEqual([key]);
  });
  it("keeps the substantive outcome and null error as separate answer facets", () => {
    const result = buildPlatformAnswerCoverage("运行结果是什么，是否记录了失败原因？", [{ source: "workshopRuns", id: "r", fields: { status: "completed", outputSummary: "Produced two drafts", error: null } }]);
    expect(result.facts.map(f => f.field)).toEqual(["status", "outputSummary", "error"]);
    expect(result.facts[2].state).toBe("not_recorded");
    expect(buildPlatformAnswerCoverage("引擎和模型", [{ source: "runtime", id: "r", fields: { modelTier: "cheap" } }]).facts).toEqual([]);
  });
});
