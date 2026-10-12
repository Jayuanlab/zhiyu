import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workshop } from "@/lib/db/schema";

const mocks = vi.hoisted(() => ({ read: vi.fn(), direct: vi.fn(), fetch: vi.fn(), load: vi.fn(), list: vi.fn(), figure: vi.fn(), append: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/ai/jina-page-reader", () => ({ readJinaDefuddlePage: mocks.read, readDirectDefuddlePage: mocks.direct, loadWebEvidence: mocks.load }));
vi.mock("@/lib/workshops/web-fetch", async original => ({
  ...await original<typeof import("@/lib/workshops/web-fetch")>(), fetchPublicWeb: mocks.fetch,
}));
vi.mock("@/lib/ai/web-figure-reader", async original => ({
  ...await original<typeof import("@/lib/ai/web-figure-reader")>(), readWebFigure: mocks.figure,
}));
vi.mock("@/lib/workshops/service", async original => ({
  ...await original<typeof import("@/lib/workshops/service")>(),
  appendWorkshopEvent: mocks.append, getWorkshop: mocks.get, listWorkshopEvents: mocks.list,
}));

import { createWorkshopToolDefinitions } from "@/lib/workshops/mcp-tools";
import { verifyWorkshopResearchEvidence } from "@/lib/workshops/research-evidence-verification";
import { finalizeWorkshopResearchDelivery } from "@/lib/workshops/research-report-delivery";
import { createHash } from "node:crypto";

const url = "https://arxiv.org/html/2501.12948";
const work: Workshop = { id: "work", userId: "owner", name: "Research", mission: "Read sources", status: "active",
  autonomyLevel: "draft", createdAt: new Date("2026-10-09T00:00:00Z"), updatedAt: new Date("2026-10-09T00:00:00Z"),
  modelConfig: { allowedTools: ["webReadPage"] }, boundaryPolicy: {} };
const content = "Methods. Experiment Table 1. Limitations. ".repeat(30);
const page = {
  url, finalUrl: url, finalUrlVerified: true, site: "arxiv.org", title: "DeepSeek-R1",
  method: "jina_defuddle", evidenceId: "saved-paper", cleaner: "defuddle",
  contentHash: "a".repeat(64), content, offset: 1200, totalChars: 1200 + content.length,
  truncated: false, nextOffset: null, qualityScore: 85, warnings: [], providerUsageTokens: 0,
};
function invoke() {
  const definition = createWorkshopToolDefinitions({ runtime: "pi", workshop: work, workshopId: work.id, runId: "run" })
    .find(tool => tool.name === "webReadPage");
  expect(definition).toBeDefined();
  return definition!.handler;
}
const args = { url, maxChars: 30_000, preferReader: true, evidenceId: page.evidenceId, offset: 1200 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(work);
  mocks.read.mockResolvedValue(page);
  mocks.append.mockImplementation(async event => ({ ...event, id: "host-event" }));
});

describe("actual Workshop webReadPage host receipts", () => {
  it("recovers a research Jina refusal with a saved direct body and transparent provenance", async () => {
    const body = "The directly fetched original study reports rule-based rewards and its actual experimental findings.";
    const direct = { ...page, provider: "direct_http", method: "direct_defuddle", cleaner: "defuddle-0.19.4/zhiyu-2",
      content: body, offset: 0, totalChars: body.length, warnings: ["direct_http_fallback_local_defuddle"] };
    mocks.read.mockRejectedValue(new Error("Jina Reader HTTP 403"));
    mocks.direct.mockResolvedValue(direct);
    const persisted: unknown[] = [];
    mocks.append.mockImplementation(async event => {
      const saved = { ...event, id: "direct-body-event" }; persisted.push(saved); return saved;
    });
    mocks.list.mockImplementation(async () => persisted);
    const modelConfig = { researchEvidenceContract: { version: "primary-reading/v1", reportDelivery: "grounded-report/v1",
      requiredPrimarySources: [{ id: "r1", label: "R1", urls: [url] }] } };
    const handler = createWorkshopToolDefinitions({ runtime: "pi", workshop: work, workshopId: "work", runId: "run",
      researchEvidenceContext: { modelConfig, taskText: "Read original research" } }).find(tool => tool.name === "webReadPage")!.handler;
    const result = await handler({ url, maxChars: 30000, preferReader: true }, {});
    expect(mocks.direct).toHaveBeenCalledWith(expect.objectContaining({ url, scope: "workshop:work", maxChars: 30000 }));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.append.mock.calls[0][0]).toMatchObject({ runId: "run", metadata: {
      provider: "direct_http", method: "direct_defuddle", cleaner: direct.cleaner, evidenceId: direct.evidenceId,
      contentHash: direct.contentHash, contentLength: body.length, totalChars: body.length, offset: 0, nextOffset: null,
      fallbackErrors: ["Jina Reader HTTP 403"], warnings: direct.warnings,
    } });
    expect(result.data).toMatchObject({ provider: "direct_http", sourceEventId: "direct-body-event",
      fallbackErrors: ["Jina Reader HTTP 403"], researchReadingProgress: { phase: "select_quotes", completeSourceCount: 1 } });
    mocks.read.mockRejectedValue(new Error("saved evidence unavailable"));
    mocks.direct.mockClear();
    await expect(handler({ url, evidenceId: direct.evidenceId, offset: 0 }, {})).rejects.toThrow("saved evidence unavailable");
    expect(mocks.direct).not.toHaveBeenCalled();
    const aborted = new AbortController();
    mocks.direct.mockImplementationOnce(async () => { aborted.abort(); return direct; });
    const previousEvents = persisted.length;
    await expect(handler({ url }, { signal: aborted.signal })).rejects.toThrow();
    expect(persisted.slice(previousEvents)).not.toEqual(expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ ok: true }) })]));
  });
  it("preserves ordinary text fallback without declaring it saved research evidence", async () => {
    mocks.read.mockRejectedValue(new Error("Jina Reader HTTP 403"));
    mocks.fetch.mockResolvedValue(new Response("A public plain text page with readable facts. ".repeat(40),
      { headers: { "content-type": "text/plain" } }));
    const result = await invoke()({ url, maxChars: 30000, preferReader: true }, {});
    expect(result.data).toMatchObject({ provider: "direct_http", method: "direct_fetch",
      fallbackErrors: ["Jina Reader HTTP 403"] });
    expect(result.data).not.toHaveProperty("evidenceId");
    expect(mocks.direct).not.toHaveBeenCalled();
  });
  it("persists the returned body window and gives the model its real source event ID", async () => {
    const result = await invoke()(args, {});
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ url, scope: "workshop:work",
      maxChars: 30_000, evidenceId: page.evidenceId, offset: 1200 }));
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({
      workshopId: "work", runId: "run", type: "source_checked",
      metadata: expect.objectContaining({ receiptAuthority: "runtime", toolName: "webReadPage", ok: true,
        url, finalUrl: url, finalUrlVerified: true, method: "jina_defuddle", evidenceId: page.evidenceId,
        contentHash: page.contentHash, offset: 1200, contentLength: content.length,
        totalChars: page.totalChars, nextOffset: null, qualityScore: 85 }),
    }));
    expect(result.data).toMatchObject({ sourceEventId: "host-event", content, contentHash: page.contentHash,
      evidenceId: page.evidenceId, offset: 1200, totalChars: page.totalChars, finalUrlVerified: true });
    const returnedText = result.content.find(block => block.type === "text");
    expect(returnedText?.type === "text" ? JSON.parse(returnedText.text).sourceEventId : undefined).toBe("host-event");
  });

  it("records host failure instead of a successful body when a saved read fails", async () => {
    const failure = new Error("saved evidence unavailable");
    mocks.read.mockRejectedValue(failure);
    await expect(invoke()(args, {})).rejects.toBe(failure);
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({ type: "source_checked",
      metadata: expect.objectContaining({ receiptAuthority: "runtime", toolName: "webReadPage", ok: false,
        status: "unavailable", coverage: "incomplete", url }),
    }));
    expect(mocks.append.mock.calls[0][0].metadata).not.toHaveProperty("contentLength");
  });

  it("keeps a figure receipt distinct and cannot use it to satisfy full body coverage", async () => {
    mocks.figure.mockResolvedValue({ metadata: { evidenceId: page.evidenceId, figureId: "figure-1",
      source: url, pageContentHash: page.contentHash, status: "rendered", interpretationStatus: "not_interpreted" } });
    const result = await invoke()({ ...args, figureId: "figure-1" }, {});
    expect(mocks.read).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ figureId: "figure-1", status: "rendered" });
    const figureEvent = mocks.append.mock.calls[0][0];
    expect(figureEvent.metadata).not.toHaveProperty("contentLength");
    const verification = verifyWorkshopResearchEvidence({ modelConfig: { researchEvidenceContract: {
      version: "primary-reading/v1", taskKeywords: ["deepseek"],
      requiredPrimarySources: [{ id: "r1", label: "DeepSeek-R1", urls: [url] }],
    } }, taskText: "Read DeepSeek", runId: "run", events: [{ ...figureEvent, id: "host-event" }], report: {
      researchEvidence: { works: [{ sourceId: "r1", evidenceEventIds: ["host-event"], method: "method",
        experiments: "experiment", limitations: "limit", locators: { method: "Section 2", experiments: "Table 1", limitations: "Section 4" },
        supportedClaims: [{ claim: "reported result", locator: "Table 1" }] }], gaps: [] },
    } });
    expect(verification.status).toBe("evidence_insufficient");
    expect(verification.coverage[0]).toMatchObject({ status: "incomplete", coveredChars: 0, eventIds: [] });
  });
  it("does not treat one paper's final cursor as task-wide reading completion", async () => {
    const otherUrl = "https://arxiv.org/html/2504.02495v1";
    const body = "A fully read original research passage about the study's reported method and experiments.";
    mocks.read.mockResolvedValue({ ...page, content: body, offset: 0, totalChars: body.length, nextOffset: null });
    const savedEvents: unknown[] = [];
    mocks.append.mockImplementation(async event => {
      const saved = { ...event, id: "host-event" }; savedEvents.push(saved); return saved;
    });
    mocks.list.mockImplementation(async () => savedEvents);
    const modelConfig = { researchEvidenceContract: { version: "primary-reading/v1", reportDelivery: "grounded-report/v1",
      requiredPrimarySources: [{ id: "r1", label: "R1", urls: [url] }, { id: "grm", label: "GRM", urls: [otherUrl] }] } };
    const handler = createWorkshopToolDefinitions({ runtime: "pi", workshop: work, workshopId: "work", runId: "run",
      researchEvidenceContext: { modelConfig, taskText: "Read research" } }).find(tool => tool.name === "webReadPage")!.handler;
    const result = await handler({ url, maxChars: 30_000 }, {});
    expect(result.data).toMatchObject({ nextOffset: null, researchReadingProgress: {
      phase: "read_sources", pendingReadRequests: [{ url: otherUrl, offset: 0, maxChars: 30000 }],
    } });
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledOnce();
    const parsed = JSON.parse((result.content.find(block => block.type === "text") as { text: string }).text);
    expect(parsed.researchReadingProgress.phase).toBe("read_sources");
    const stopped = new AbortController();
    mocks.list.mockImplementationOnce(async () => { stopped.abort(); return savedEvents; });
    await expect(handler({ url, maxChars: 30000 }, { signal: stopped.signal })).rejects.toThrow();
  });
  it("selects a real current-run quote through the same allowed read tool, with no fetch or fabricated body coverage", async () => {
    const exact = "The study uses rule-based rewards for the group policy optimization procedure, retaining the original evidence [^3].";
    const body = `## 2 Method\n\n${exact}`;
    const digest = createHash("sha256").update(body).digest("hex");
    mocks.load.mockResolvedValue({ snapshot: { evidenceId: page.evidenceId, contentHash: digest, url, content: body } });
    mocks.list.mockResolvedValue([{ id: "read-event", runId: "run", type: "source_checked", metadata: {
      receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true, url, finalUrl: url,
      evidenceId: page.evidenceId, contentHash: digest, qualityScore: 85, offset: 0, contentLength: body.length,
      totalChars: body.length, nextOffset: null } }]);
    const modelConfig = { researchEvidenceContract: { version: "primary-reading/v1", reportDelivery: "grounded-report/v1",
      requiredPrimarySources: [{ id: "r1", label: "R1", urls: [url] }] } };
    const handler = createWorkshopToolDefinitions({ runtime: "pi", workshop: work, workshopId: "work", runId: "run",
      researchEvidenceContext: { modelConfig, taskText: "Read research" } }).find(tool => tool.name === "webReadPage")!.handler;
    const selected = await handler({ url, evidenceId: page.evidenceId, quoteQueries: [{ text: "The study uses rule-based rewards" }] }, {});
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.figure).not.toHaveBeenCalled();
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({ type: "research_quote_selected", metadata:
      expect.objectContaining({ receiptAuthority: "runtime", workshopId: "work", queries: [{ text: "The study uses rule-based rewards" }],
        candidates: [expect.objectContaining({ quote: exact, sourceEventId: "read-event" })] }) }));
    expect(selected.data).toMatchObject({ selectionEventId: "host-event", candidates: [{ quote: exact,
      quoteRef: { selectionEventId: "host-event", index: 0 } }] });
    expect(mocks.append.mock.calls[0][0].metadata).not.toHaveProperty("contentLength");
    mocks.append.mockRejectedValueOnce(Error("receipt unavailable"));
    await expect(handler({ url, evidenceId: page.evidenceId, quoteQueries: [{ text: "The study uses rule-based rewards" }] }, {})).rejects.toThrow("receipt unavailable");
    const deniedWork = { ...work, modelConfig: { ...work.modelConfig as object, disallowedTools: ["webReadPage"] } };
    mocks.get.mockResolvedValueOnce(deniedWork);
    await expect(handler({ url, evidenceId: page.evidenceId, quoteQueries: [{ text: "The study uses rule-based rewards" }] }, {})).rejects.toThrow("Tool denied");
    mocks.get.mockResolvedValue(work);
    const stopped = new AbortController();
    mocks.load.mockImplementationOnce(async () => {
      stopped.abort();
      return { snapshot: { evidenceId: page.evidenceId, contentHash: digest, url, content: body } };
    });
    const receiptsBeforeAbort = mocks.append.mock.calls.length;
    await expect(handler({ url, evidenceId: page.evidenceId, quoteQueries: [{ text: "The study uses rule-based rewards" }] }, { signal: stopped.signal })).rejects.toThrow();
    expect(mocks.append).toHaveBeenCalledTimes(receiptsBeforeAbort);
  });
  it("binds alternative passages to real pool indexes and cannot approve invented query numbers", async () => {
    const method = "The training procedure uses group relative rewards without an additional critic model.";
    const experiment = "The evaluation increases benchmark accuracy to 64.2% under the reported sampling conditions.";
    const body = `## 2 Method\n\n${method}\n\n## 3 Results\n\n${experiment}`;
    const digest = createHash("sha256").update(body).digest("hex");
    const readEvent = { id: "read-event", runId: "run", type: "source_checked", metadata: {
      receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true, url,
      evidenceId: page.evidenceId, contentHash: digest, qualityScore: 85, offset: 0, contentLength: body.length,
      totalChars: body.length, nextOffset: null } };
    mocks.load.mockResolvedValue({ snapshot: { evidenceId: page.evidenceId, contentHash: digest, url, content: body } });
    mocks.list.mockResolvedValue([readEvent]);
    const modelConfig = { researchEvidenceContract: { version: "primary-reading/v1", reportDelivery: "grounded-report/v1",
      requiredPrimarySources: [{ id: "r1", label: "R1", urls: [url] }] } };
    const context = { modelConfig, taskText: "Read research" };
    const handler = createWorkshopToolDefinitions({ runtime: "pi", workshop: work, workshopId: "work", runId: "run",
      researchEvidenceContext: context }).find(tool => tool.name === "webReadPage")!.handler;
    const selected = await handler({ url, evidenceId: page.evidenceId, quoteQueries: [
      { text: "The training procedure uses group relative rewards" },
      { text: "The evaluation increases benchmark accuracy to 99.9%" },
    ] }, {});
    expect(selected.data).toMatchObject({ candidates: [{ quote: method, quoteRef: { selectionEventId: "host-event", index: 0 } }],
      alternativeCandidates: [{ quote: experiment, quoteRef: { selectionEventId: "host-event", index: 1 } }] });
    const receipt = mocks.append.mock.calls[0][0];
    expect(receipt.metadata.candidates.map((candidate: { quote: string }) => candidate.quote)).toEqual([method, experiment]);
    expect(receipt.metadata).not.toHaveProperty("alternativeCandidates");
    expect((selected.data as { gaps: unknown[] }).gaps).not.toEqual([]);
    expect(mocks.read).not.toHaveBeenCalled();
    const ref = { selectionEventId: "host-event", index: 1 };
    const structured = { researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "r1", supportedClaims: [
      { kind: "method", claim: "训练使用相对奖励。", quoteRef: { selectionEventId: "host-event", index: 0 } },
      { kind: "experiment", claim: "准确率为 99.9%。", quoteRef: ref },
      { kind: "limitation", claim: "结果受限于所报告的采样条件。", quoteRef: ref },
    ] }], gaps: [] } };
    const delivery = await finalizeWorkshopResearchDelivery({ ...context, workshopId: "work", runId: "run",
      events: [readEvent, { ...receipt, id: "host-event" }], result: { status: "success", output: JSON.stringify(structured),
        structured, toolCallCount: 1, durationMs: 1 } });
    expect(delivery.audit?.status).not.toBe("verified");
    expect(delivery.audit?.issues.join(" ")).toContain("99.9%");
    expect(structured.researchEvidence.works[0].supportedClaims[1].claim).toBe("准确率为 99.9%。");
  });
});
