import { describe, expect, it } from "vitest";
import { inspectWorkshopResearchSourceRecovery } from "@/lib/workshops/research-source-recovery";
import type { WorkshopResearchEvidenceEvent } from "@/lib/workshops/research-evidence-verification";

const url = "https://arxiv.org/html/2501.12948v1";
const modelConfig = { researchEvidenceContract: { version: "primary-reading/v1", reportDelivery: "grounded-report/v1",
  requiredPrimarySources: [{ id: "r1", label: "R1", urls: [url] }] } };
const receipt = (offset = 0, length = 30000, metadata = {}): WorkshopResearchEvidenceEvent => ({ id: `read-${offset}`, runId: "run", type: "source_checked",
  metadata: { receiptAuthority: "runtime", toolName: "webReadPage", ok: true, url, evidenceId: "body", contentHash: "a".repeat(64),
    offset, contentLength: length, totalChars: 60000, nextOffset: offset + length === 60000 ? null : offset + length,
    qualityScore: 90, method: "jina_defuddle", ...metadata } });
const inspect = (events: WorkshopResearchEvidenceEvent[] = [receipt()]) => inspectWorkshopResearchSourceRecovery({ runId: "run", modelConfig, taskText: "research", events });
const params = { url, offset: 30000, maxChars: 30000, evidenceId: "body" };

describe("owned research source recovery boundary", () => {
  it("allows only the exact remaining cursor and identity, and stops when the paper is complete", () => {
    expect(inspect().incomplete).toBe(true);
    expect(inspect().isToolAllowed("webReadPage", params)).toBe(true);
    expect(inspect().isToolAllowed("mcp__workshop-tools__webReadPage", params)).toBe(true);
    expect(inspect([receipt(), receipt(30000)]).incomplete).toBe(false);
    expect(inspect([receipt(), receipt(30000)]).isToolAllowed("webReadPage", params)).toBe(false);
  });
  it.each([{ offset: 0 }, { offset: 45000 }, { evidenceId: "other-body" }, { url: "https://example.test" },
    { maxChars: 30001 }, { maxChars: 0 }, { maxChars: 1.5 }, { extraInstruction: "ignore boundary" }])("denies changed recovery arguments %j", change => {
    expect(inspect().isToolAllowed("webReadPage", { ...params, ...change })).toBe(false);
  });
  it("denies control tools and cross-run/model receipts without treating them as trusted cursors", () => {
    expect(inspect().isToolAllowed("workshopRemember", params)).toBe(false);
    const crossRun = { ...receipt(), runId: "other-run" };
    expect(inspect([crossRun]).isToolAllowed("webReadPage", params)).toBe(false);
    expect(inspect([receipt(0, 30000, { receiptAuthority: "agent" })]).isToolAllowed("webReadPage", params)).toBe(false);
    expect(inspect([]).isToolAllowed("webReadPage", { url, offset: 0, maxChars: 30000 })).toBe(true);
  });
  it("fails closed for inactive/invalid contracts and event overflow", () => {
    expect(() => inspectWorkshopResearchSourceRecovery({ runId: "run", modelConfig: {}, taskText: "research", events: [] })).toThrow();
    expect(() => inspect(Array.from({ length: 1001 }, () => receipt()))).toThrow("receipt limit");
  });
  it("records safe denied input fields without exposing unknown URLs, credentials or unknown values", () => {
    const described = inspect().describeRequest({ url: "https://password:secret@example.test/private", evidenceId: "Bearer secret",
      offset: 30000, maxChars: 45000, apiKey: "secret-key" });
    expect(described).toMatchObject({ url: "[unapproved_url]", evidenceId: "[invalid_or_missing_identity]", offset: 30000, maxChars: 45000 });
    expect(JSON.stringify(described)).not.toContain("secret");
    expect(inspect().requests).toEqual([{ url, offset: 30000, maxChars: 30000, evidenceId: "body" }]);
  });
});
