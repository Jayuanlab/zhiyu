import { beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jina-page-reader", () => ({ loadWebEvidence: load }));

import { validateWorkshopResearchFinal } from "@/lib/workshops/research-final-validation";
import { verifyWorkshopResearchEvidence, type WorkshopResearchEvidenceEvent } from "@/lib/workshops/research-evidence-verification";

const url = "https://example.test/queue-study";
const contract = {
  version: "primary-reading/v1", reportDelivery: "grounded-report/v1", taskKeywords: ["queue"],
  requiredPrimarySources: [{ id: "queue-study", label: "Queue study", urls: [url] }],
};
const markdown = "# Queue scheduling\n\nThe opening section describes grouping related requests before scheduling. My interpretation is that this may reduce repeated work, while its effect on waiting time still needs evaluation.\n\nSource: https://example.test/queue-study#method. Only the opening section was read.";
function input(rawText = markdown) {
  return { workshopId: "work", runId: "run", modelConfig: { researchEvidenceContract: structuredClone(contract) },
    taskText: "Explain queue scheduling", events: [] as WorkshopResearchEvidenceEvent[], rawText };
}
function partialRead(): WorkshopResearchEvidenceEvent {
  return { id: "read-opening", runId: "run", type: "source_checked", metadata: {
    receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true,
    url, finalUrl: url, evidenceId: "queue-body", contentHash: "a".repeat(64), qualityScore: 90,
    offset: 0, contentLength: 100, totalChars: 2000, nextOffset: 100,
  } };
}

describe("reader report completion independent of evidence approval", () => {
  beforeEach(() => { load.mockReset().mockRejectedValue(Error("No fixture source loading is expected")); });

  it("accepts useful short Markdown without fixed sections, counts or a JSON attachment", async () => {
    const args = input("Grouping related requests may reduce repeated scheduling work; the effect on latency is still a hypothesis. See https://example.test/queue-study#method.");
    expect(await validateWorkshopResearchFinal(args)).toEqual({ ok: true });
    expect(verifyWorkshopResearchEvidence({ ...args, report: null }).status).toBe("evidence_insufficient");
    expect(load).not.toHaveBeenCalled();
  });

  it("allows partial reading and an oversized observation set without asking for a report rewrite", async () => {
    const args = { ...input(), events: [partialRead()], eventsOverflow: true };
    expect(await validateWorkshopResearchFinal(args)).toEqual({ ok: true });
    const observed = verifyWorkshopResearchEvidence({ ...args, report: null });
    expect(observed.status).toBe("evidence_insufficient");
    expect(observed.coverage[0]).toMatchObject({ status: "incomplete", coveredChars: 100, totalChars: 2000 });
    expect(observed.verifiedEventIds).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps a structured partial report readable without filling in claim kinds or deleting its gaps", async () => {
    const report = { researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "queue-study",
      supportedClaims: [{ kind: "method", claim: "Related requests share scheduling work." }],
    }], gaps: ["The latency experiment has not been reviewed."],
      brief: { title: "Queue scheduling", findings: [{ text: "Shared scheduling is a plausible efficiency mechanism, not yet a measured latency result." }] },
    } };
    const rawText = `A preliminary reading:\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
    const args = { ...input(rawText), events: [partialRead()] };
    expect(await validateWorkshopResearchFinal(args)).toEqual({ ok: true });
    const independent = verifyWorkshopResearchEvidence({ ...args, report });
    expect(independent.status).toBe("evidence_insufficient");
    expect(independent.gaps.some(gap => gap.includes(report.researchEvidence.gaps[0]))).toBe(true);
    expect(args.rawText).toBe(rawText);
    expect(report.researchEvidence.works[0].supportedClaims).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    "", "   ", "# Report", "{}", '{"summary":"Work will start shortly."}',
    '{"reportMarkdown":"unfinished', '```json\n{"reportMarkdown":"unfinished',
    "Final validation correction limit exhausted", "Final validation context compaction result is invalid",
    "Research tool budget exhausted: 31/30", "Workshop run completed",
  ])("rejects an absent report or runtime checkpoint: %j", async rawText => {
    const result = await validateWorkshopResearchFinal(input(rawText));
    expect(result.ok).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("does not treat a plain promise to begin work as a report", async () => {
    expect((await validateWorkshopResearchFinal(input("I will start reading the paper and report back."))).ok).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("does not turn an invalid explicit configuration into report approval", async () => {
    const args = input();
    args.modelConfig.researchEvidenceContract.requiredPrimarySources = [];
    const result = await validateWorkshopResearchFinal(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain("requiredPrimarySources");
    expect(load).not.toHaveBeenCalled();
  });

  it("leaves an unrelated admitted task and the prior contract outside this completion check", async () => {
    expect(await validateWorkshopResearchFinal({ ...input("{}"), taskText: "Check worker status" })).toEqual({ ok: true });
    const args = input("{}");
    delete (args.modelConfig.researchEvidenceContract as Partial<typeof contract>).reportDelivery;
    expect(await validateWorkshopResearchFinal(args)).toEqual({ ok: true });
    expect(load).not.toHaveBeenCalled();
  });
});
