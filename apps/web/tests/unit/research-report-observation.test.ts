import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WorkshopExecutionResult } from "@/lib/workshops/executor";

const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jina-page-reader", () => ({ loadWebEvidence: load }));
import { finalizeWorkshopResearchDelivery } from "@/lib/workshops/research-report-delivery";
import { finalizeWorkshopResearchReaderDelivery } from "@/lib/workshops/research-reader-delivery";
import { observeResearchReport } from "../../scripts/research-report-observation";

const directory = new URL("../../../../docs/verification/artifacts/deepseek-report-rerun-2026-10-09/", import.meta.url);
const readArtifact = (name: string) => JSON.parse(readFileSync(new URL(name, directory), "utf8"));
const running = readArtifact("run-e50e3ff1-b0a3-8b87-ab59-86af5c443850-2026-10-09T01-38-02-073Z.json");
const completed = readArtifact("run-e50e3ff1-b0a3-8b87-ab59-86af5c443850-terminal-2026-10-09T01-39-28-327Z.json");
const sourcesFrom = (artifact: typeof running) => {
  const validIds = new Set<string>(artifact.pages.flatMap((page: { validEventIds: string[] }) => page.validEventIds));
  return {
    modelConfig: completed.captured.pinnedResearchContext.modelConfig,
    taskText: completed.captured.pinnedResearchContext.taskText,
    runId: artifact.run.id,
    events: artifact.sourceCheckedReceipts.filter((event: { eventId: string }) => validIds.has(event.eventId))
      .map((event: { eventId: string; runId: string; type: string; metadata: unknown }) => ({
        id: event.eventId, runId: event.runId, type: event.type, metadata: event.metadata,
      })),
  };
};

describe("research observer checkpoint lifecycle", () => {
  it("matches reader delivery while keeping its evidence unverified", async () => {
    const sources = sourcesFrom(completed);
    const delivery = await finalizeWorkshopResearchReaderDelivery({ ...sources, workshopId: "work",
      result: { status: "success", output: "# 研究认识\n\n训练反馈与使用时选择解决不同问题；具体效果仍需核对实验条件。", structured: null, toolCallCount: 1, durationMs: 1 } });
    const observation = await observeResearchReport({ capturedOutputPresent: true, runStatus: "completed",
      sources, expectedCanonicalHash: delivery.audit?.canonicalHash, finalize: async () => delivery });
    expect(observation.deliveryVerification).toMatchObject({ version: "reader-report/v1", status: "delivered", verificationStatus: "unverified" });
    expect(observation.derivedGate).toBe("evidence_insufficient");
    expect(observation.deliveryHashMatches).toBe(true);
    expect(observation.canonicalPresentation?.source).toBe("host_research_reader");
  });
  it("keeps the actual running checkpoint absence pending without fabricating a report rejection", async () => {
    const finalize = vi.fn();
    const observation = await observeResearchReport({
      capturedOutputPresent: running.captured.present,
      runStatus: running.run.status,
      sources: sourcesFrom(running),
      expectedCanonicalHash: null,
      finalize,
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ derivedGate: "pending_report", derivedVerification: null,
      deliveryVerification: null, canonicalPresentation: null, deliveryHashMatches: null });
    expect(observation.sourceProgress).toMatchObject({ authority: "observer_derived", basis: "same_run_disk_validated_source_receipts" });
    expect(observation.sourceProgress.coverage.map(source => [source.sourceId, source.status, source.coveredChars]))
      .toEqual([["deepseek-math", "complete", 85645], ["deepseek-r1", "complete", 60740], ["deepseek-grm", "complete", 140201]]);
    expect(running.runtimeVerification).toEqual([]);
  });

  it("labels a terminal missing checkpoint explicitly and never executes report finalization", async () => {
    const finalize = vi.fn();
    const observation = await observeResearchReport({ capturedOutputPresent: false, runStatus: "failed",
      sources: sourcesFrom(running), expectedCanonicalHash: null, finalize });
    expect(finalize).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ derivedGate: "missing_output_checkpoint", derivedVerification: null,
      deliveryVerification: null, canonicalPresentation: null, deliveryHashMatches: null });
  });

  it("passes through the frozen completed receipt and canonical hash without rechecking historical gates", async () => {
    const finalize = vi.fn().mockResolvedValue({
      result: { status: "success", output: "frozen completed report", structured: { presentation: completed.canonicalPresentation }, toolCallCount: 17, durationMs: 1 },
      verification: completed.derivedVerification,
      audit: completed.deliveryVerification,
    });
    const observation = await observeResearchReport({ capturedOutputPresent: completed.captured.present,
      runStatus: completed.run.status, sources: sourcesFrom(completed),
      expectedCanonicalHash: completed.completionResearchDelivery.canonicalHash, finalize });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(observation.derivedGate).toBe("sufficient");
    expect(observation.derivedVerification).toBe(completed.derivedVerification);
    expect(observation.deliveryVerification).toBe(completed.deliveryVerification);
    expect(observation.canonicalPresentation).toBe(completed.canonicalPresentation);
    expect(observation.deliveryHashMatches).toBe(true);
    expect(observation.deliveryVerification?.canonicalHash).toBe("3dcaaf60cd01997ac9ea546313e80567682c5ffb497d6ed08a91d0654b250a03");
    expect(completed.runtimeVerification).toHaveLength(1);
    expect(completed.runtimeVerification[0].status).toBe("sufficient");
  });

  it.each([undefined, "not JSON", {}])("strictly rejects a present invalid checkpoint (%j)", async structured => {
    const content = "A saved source body with an independently identified complete window.";
    const url = "https://arxiv.org/html/2501.12948v1";
    const contentHash = createHash("sha256").update(content).digest("hex");
    load.mockResolvedValue({ snapshot: { evidenceId: "snapshot", contentHash, url, content } });
    const sources = { modelConfig: { researchEvidenceContract: {
      version: "primary-reading/v1", taskKeywords: ["deepseek"], reportDelivery: "grounded-report/v1",
      requiredPrimarySources: [{ id: "r1", label: "R1", urls: [url] }],
    } }, taskText: "Read DeepSeek", runId: "run", events: [{ id: "body", runId: "run", type: "source_checked", metadata: {
      receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true, url, finalUrl: url,
      evidenceId: "snapshot", contentHash, qualityScore: 80, offset: 0, contentLength: content.length,
      totalChars: content.length, nextOffset: null,
    } }] };
    const finalize = vi.fn(() => finalizeWorkshopResearchDelivery({ ...sources, workshopId: "work",
      result: { status: "success", output: "invalid checkpoint", structured, toolCallCount: 1, durationMs: 1 } as WorkshopExecutionResult }));
    const observation = await observeResearchReport({ capturedOutputPresent: true, runStatus: "running",
      sources, expectedCanonicalHash: null, finalize });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(observation.derivedGate).toBe("evidence_insufficient");
    expect(observation.deliveryVerification?.status).toBe("rejected");
    expect(observation.derivedVerification?.gaps.length).toBeGreaterThan(0);
    expect(observation.deliveryHashMatches).toBe(false);
  });
});
