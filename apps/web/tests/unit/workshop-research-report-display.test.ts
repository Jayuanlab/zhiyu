import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkPresentationArea } from "@/app/(chat)/workshop/work-presentation-area";
import { Markdown } from "@/components/markdown";
import { buildWorkPresentation, type WorkPresentationEvent, type WorkPresentationV1 } from "@/lib/workshops/work-presentation";

vi.mock("@/lib/tauri", () => ({ openUrl: vi.fn() }));
vi.mock("@openzhiyu/ui", () => {
  const container = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  const dialogContent = ({ children }: { children?: ReactNode }) => createElement("div", { "data-testid": "presentation-dialog" }, children);
  return { Badge: container, Button: container, Dialog: container, DialogContent: dialogContent,
    DialogDescription: container, DialogHeader: container, DialogTitle: container };
});

const report: WorkPresentationV1 = {
  version: 1, runId: "48da4ddf-96cc-8a33-a332-77060e594771", status: "failed",
  title: "研究报告未通过核验", summary: "本轮已读齐 85645/85645 字符，研究报告仍未通过核验。",
  presentedAt: "2026-10-08T21:24:42.707Z",
  reportMarkdown: "# 研究报告未通过核验\n\n连续覆盖 85645/85645 字符。字段 presentation/summary 不代表引文证据。\n\n[论文原文](https://arxiv.org/html/2402.03300v3)\n\n[真实报告附件](/api/workshops/work/artifacts/event/report.md)",
  evidence: [], artifacts: [], warnings: [], nextSteps: [],
};

const readerMarkdown = "## 研究解读\n\n方法：从 group scores 估计 baseline。\n\n实验：Model-Qwen-32B 在 AIME 2024 得分 72.6%。\n\n局限：该研究未测量 training latency。";
const evidenceMarkdown = "## 原文依据\n\n位置：Table 1；正文回执：8379608f-bdc1-4dc7-adfc-905c52592778\n\n> Model-Qwen-32B scores 72.6% on AIME 2024.\n\n证据语境：Section 3 / Evaluation\n\n> This evaluation uses the tested task settings.\n\n[同版原文](https://papers.example.com/html/paper-v1)";
const readerWarnings = ["中文结论仍需独立语义抽查。", "公式和图片未独立复核。", "最终地址尚未独立核验。"];
const readableReport: WorkPresentationV1 = {
  ...report, status: "completed" as const, reportKind: "grounded_research" as const,
  title: "论文研究报告", summary: "3 条结论绑定原文短摘，结论语义仍需独立抽查。",
  reportMarkdown: "# 完整报告\n\n" + readerMarkdown + "\n\n" + evidenceMarkdown,
  researchBriefMarkdown: readerMarkdown, evidenceMarkdown, warnings: readerWarnings,
};

function taskReply(markup: string) {
  const start = markup.indexOf('<section aria-label="任务回复"');
  const end = markup.indexOf("</section>", start);
  if (start < 0 || end < 0) throw Error("Missing task reply section");
  return markup.slice(start, end);
}

function hostReportEvent(metadata: Record<string, unknown> = {}): WorkPresentationEvent {
  return {
    id: "host-report-event", runId: report.runId, seq: 1, type: "run_completed", title: "完成",
    createdAt: report.presentedAt!, metadata: {
      receiptAuthority: "runtime",
      researchDelivery: { version: "grounded-report/v1", status: "verified", canonicalHash: "a".repeat(64) },
      presentation: { source: "host_grounded_report", title: readableReport.title,
        summary: readableReport.summary, reportMarkdown: readableReport.reportMarkdown,
        researchBriefMarkdown: readerMarkdown, evidenceMarkdown },
      ...metadata,
    },
  };
}

describe("desktop research report display", () => {
  it("shows the reading brief first, keeps provenance folded, and leaves every warning visible in conversation", () => {
    const markup = renderToStaticMarkup(createElement(WorkPresentationArea, {
      presentation: readableReport, loading: false, error: null, mode: "conversation", onOpenWorkLog: vi.fn(),
    }));
    const reply = taskReply(markup);
    expect(reply).toContain("研究解读");
    const details = reply.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(details).toBeDefined();
    expect(details).not.toMatch(/<details\b[^>]*\bopen(?:=|\s|>)/);
    expect(details).toContain("原文引文、语境与核验记录");
    expect(details).toContain("8379608f-bdc1-4dc7-adfc-905c52592778");
    expect(details).toContain("Model-Qwen-32B scores 72.6% on AIME 2024.");
    expect(details).toContain("This evaluation uses the tested task settings.");
    expect(details).toContain("同版原文");
    const visible = reply.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
    expect(visible).toContain("从 group scores 估计 baseline");
    expect(visible).toContain("未测量 training latency");
    expect(visible).not.toContain("8379608f-bdc1-4dc7-adfc-905c52592778");
    for (const warning of readerWarnings) expect(visible).toContain(warning);
    expect(reply.indexOf("研究解读")).toBeLessThan(reply.indexOf("<details"));
    expect(reply).not.toContain("max-h-[480px]");
    expect(reply).not.toContain("rounded-md");
    expect(reply).not.toContain('data-badge-kind="skill"');
  });

  it("also starts the full report dialog with reading prose and a closed evidence disclosure", () => {
    const markup = renderToStaticMarkup(createElement(WorkPresentationArea, {
      presentation: readableReport, loading: false, error: null, onOpenWorkLog: vi.fn(),
    }));
    const dialog = markup.slice(markup.indexOf('data-testid="presentation-dialog"'));
    expect(dialog).toContain("研究解读");
    expect(dialog.indexOf("研究解读")).toBeLessThan(dialog.indexOf("<details"));
    expect(dialog).toMatch(/<details\b[^>]*><summary\b/);
    expect(dialog).not.toMatch(/<details\b[^>]*\bopen(?:=|\s|>)/);
    expect(dialog).toContain("8379608f-bdc1-4dc7-adfc-905c52592778");
    for (const warning of readerWarnings) expect(dialog).toContain(warning);
  });

  it("projects reader fields only from a completed verified host research receipt", () => {
    const projected = buildWorkPresentation({ run: { id: report.runId, status: "completed" }, events: [hostReportEvent()] });
    expect(projected).toMatchObject({ status: "completed", reportKind: "grounded_research",
      researchBriefMarkdown: readerMarkdown, evidenceMarkdown, reportMarkdown: readableReport.reportMarkdown });
  });

  it.each(["verified", "unverified"])("projects a delivered %s reader report without claiming evidence passed", (verificationStatus) => {
    const event = hostReportEvent({ researchDelivery: { version: "reader-report/v1", status: "delivered",
      verificationStatus, semanticStatus: "not_independently_verified", canonicalHash: "a".repeat(64) } });
    delete event.metadata!.receiptAuthority;
    (event.metadata!.presentation as Record<string, unknown>).source = "host_research_reader";
    event.seq = 2;
    const receipt: WorkPresentationEvent = { id: "reader-delivered-event", runId: report.runId, seq: 1,
      type: "research_report_delivered", title: "报告已生成", createdAt: report.presentedAt!,
      metadata: { receiptAuthority: "runtime", version: "reader-report/v1", status: "delivered", verificationStatus,
        canonicalHash: "a".repeat(64) } };
    const projected = buildWorkPresentation({ run: { id: report.runId, status: "completed" }, events: [receipt, event] });
    expect(projected).toMatchObject({ status: "completed", reportKind: "grounded_research",
      researchBriefMarkdown: readerMarkdown, evidenceMarkdown, reportMarkdown: readableReport.reportMarkdown });
  });

  it.each(["other-hash", "other-run", "agent", "missing-authority", "rejected", "wrong-version", "missing-receipt-hash",
    "missing-delivery-hash", "invalid-hash", "after-terminal", "failed", "model-source", "terminal-self-claim"])(
    "does not trust a %s reader delivery", (scenario) => {
      const event = hostReportEvent({ researchDelivery: { version: "reader-report/v1", status: "delivered",
        verificationStatus: "unverified", canonicalHash: "a".repeat(64) } });
      delete event.metadata!.receiptAuthority;
      (event.metadata!.presentation as Record<string, unknown>).source = "host_research_reader";
      event.seq = 2;
      const receipt: WorkPresentationEvent = { id: "reader-delivered-event", runId: report.runId, seq: 1,
        type: "research_report_delivered", title: "报告已生成", createdAt: report.presentedAt!,
        metadata: { receiptAuthority: "runtime", version: "reader-report/v1", status: "delivered", canonicalHash: "a".repeat(64) } };
      if (scenario === "other-hash") receipt.metadata!.canonicalHash = "b".repeat(64);
      if (scenario === "other-run") receipt.runId = "foreign-run";
      if (scenario === "agent") receipt.metadata!.receiptAuthority = "agent";
      if (scenario === "missing-authority") delete receipt.metadata!.receiptAuthority;
      if (scenario === "rejected") receipt.metadata!.status = "rejected";
      if (scenario === "wrong-version") receipt.metadata!.version = "grounded-report/v1";
      if (scenario === "missing-receipt-hash") delete receipt.metadata!.canonicalHash;
      if (scenario === "missing-delivery-hash") delete (event.metadata!.researchDelivery as Record<string, unknown>).canonicalHash;
      if (scenario === "invalid-hash") (event.metadata!.researchDelivery as Record<string, unknown>).canonicalHash = "invalid";
      if (scenario === "after-terminal") receipt.seq = 3;
      if (scenario === "model-source") (event.metadata!.presentation as Record<string, unknown>).source = "agent_report";
      if (scenario === "terminal-self-claim") { event.metadata!.receiptAuthority = "runtime"; receipt.type = "observation"; }
      const projected = buildWorkPresentation({ run: { id: report.runId, status: scenario === "failed" ? "failed" : "completed" },
        events: [receipt, event] });
      expect(projected?.researchBriefMarkdown).toBeUndefined();
      expect(projected?.evidenceMarkdown).toBeUndefined();
    });

  it.each(["same-report", "other-hash", "other-run", "missing-run", "agent", "missing-authority", "rejected", "wrong-version",
    "missing-receipt-hash", "missing-delivery-hash", "invalid-hash", "after-terminal"])(
    "uses the real runtime completion and %s preceding research receipt without inventing terminal authority", (scenario) => {
      const event = hostReportEvent();
      delete event.metadata!.receiptAuthority;
      event.metadata!.researchDelivery = { version: "grounded-report/v1", status: "verified", canonicalHash: "a".repeat(64) };
      event.seq = 2;
      const receipt: WorkPresentationEvent = { id: "research-verified-event", runId: report.runId, seq: 1,
        type: "research_report_verified", title: "宿主核验", createdAt: report.presentedAt!,
        metadata: { receiptAuthority: "runtime", version: "grounded-report/v1", status: "verified", canonicalHash: "a".repeat(64) } };
      if (scenario === "other-hash") receipt.metadata!.canonicalHash = "b".repeat(64);
      if (scenario === "other-run") receipt.runId = "foreign-run";
      if (scenario === "missing-run") { delete receipt.runId; receipt.loopRunId = report.runId; }
      if (scenario === "agent") receipt.metadata!.receiptAuthority = "agent";
      if (scenario === "missing-authority") delete receipt.metadata!.receiptAuthority;
      if (scenario === "rejected") receipt.metadata!.status = "rejected";
      if (scenario === "wrong-version") receipt.metadata!.version = "other/v1";
      if (scenario === "missing-receipt-hash") delete receipt.metadata!.canonicalHash;
      if (scenario === "missing-delivery-hash") delete (event.metadata!.researchDelivery as Record<string, unknown>).canonicalHash;
      if (scenario === "invalid-hash") {
        receipt.metadata!.canonicalHash = "invalid";
        (event.metadata!.researchDelivery as Record<string, unknown>).canonicalHash = "invalid";
      }
      if (scenario === "after-terminal") receipt.seq = 3;
      const projected = buildWorkPresentation({ run: { id: report.runId, status: "completed" }, events: [receipt, event] });
      if (scenario === "same-report") {
        expect(projected).toMatchObject({ researchBriefMarkdown: readerMarkdown, evidenceMarkdown,
          reportMarkdown: readableReport.reportMarkdown, status: "completed" });
      } else {
        expect(projected?.researchBriefMarkdown).toBeUndefined();
        expect(projected?.evidenceMarkdown).toBeUndefined();
      }
    });

  it.each(["unverified", "wrong-version", "missing-authority", "missing-hash", "invalid-hash", "agent", "nonresearch", "recovered", "failed"])(
    "does not promote %s reader fields into the trusted reading view", (scenario) => {
      const event = hostReportEvent();
      const metadata = event.metadata!;
      if (scenario === "unverified") metadata.researchDelivery = { version: "grounded-report/v1", status: "rejected" };
      if (scenario === "wrong-version") metadata.researchDelivery = { version: "other/v1", status: "verified" };
      if (scenario === "missing-authority") delete metadata.receiptAuthority;
      if (scenario === "missing-hash") delete (metadata.researchDelivery as Record<string, unknown>).canonicalHash;
      if (scenario === "invalid-hash") (metadata.researchDelivery as Record<string, unknown>).canonicalHash = "invalid";
      if (scenario === "agent") metadata.receiptAuthority = "agent";
      if (scenario === "nonresearch") (metadata.presentation as Record<string, unknown>).source = "model";
      const recovered = scenario === "recovered" ? JSON.stringify({ presentation: metadata.presentation }) : null;
      if (scenario === "recovered") metadata.presentation = {};
      const projected = buildWorkPresentation({ run: { id: report.runId,
        status: scenario === "failed" ? "failed" : "completed", outputSummary: recovered }, events: [event] });
      expect(projected?.researchBriefMarkdown).toBeUndefined();
      expect(projected?.evidenceMarkdown).toBeUndefined();
      expect(projected?.status).toBe(scenario === "failed" ? "failed" : "completed");
    });

  it.each(["nonresearch", "failed", "missing-evidence", "missing-brief"])(
    "keeps the existing complete report path for %s presentations", (scenario) => {
      const presentation = { ...readableReport };
      if (scenario === "nonresearch") delete presentation.reportKind;
      if (scenario === "failed") presentation.status = "failed";
      if (scenario === "missing-evidence") presentation.evidenceMarkdown = "";
      if (scenario === "missing-brief") presentation.researchBriefMarkdown = "";
      const markup = renderToStaticMarkup(createElement(WorkPresentationArea, {
        presentation, loading: false, error: null, mode: "conversation", onOpenWorkLog: vi.fn(),
      }));
      expect(taskReply(markup)).not.toContain("<details");
      expect(taskReply(markup)).toContain("完整报告");
    });

  it("shows a validation-specific failure and leaves report fractions/schema fields as text at the real Work presentation seam", () => {
    const presentation = { ...report, reportKind: "grounded_research" as const,
      failureKind: "research_report_validation" as const };
    const markup = renderToStaticMarkup(createElement(WorkPresentationArea, {
      presentation, loading: false, error: null, onOpenWorkLog: vi.fn(),
    }));
    expect(markup).toContain("研究报告未通过核验");
    expect(markup).not.toContain("运行失败");
    expect(markup).toContain("85645/85645");
    expect(markup).toContain("presentation/summary");
    expect(markup).not.toContain('data-badge-kind="skill"');
    // Markdown's existing links use openUrl-backed buttons; disabling badges
    // must retain those link controls and their labels.
    expect(markup).toContain('border-none p-0 text-left">论文原文</button>');
    expect(markup).toContain('border-none p-0 text-left">真实报告附件</button>');
  });

  it("also preserves literal slashes in a verified grounded report", () => {
    const markup = renderToStaticMarkup(createElement(WorkPresentationArea, {
      presentation: { ...report, status: "completed", reportKind: "grounded_research" as const },
      loading: false, error: null, mode: "conversation", onOpenWorkLog: vi.fn(),
    }));
    expect(markup).toContain("85645/85645");
    expect(markup).not.toContain('data-badge-kind="skill"');
  });

  it("keeps existing instruction previews and ordinary runtime failure labels", () => {
    const instruction = renderToStaticMarkup(createElement(Markdown, { children: "运行 /existing-skill" }));
    expect(instruction).toContain('data-badge-kind="skill"');
    const markup = renderToStaticMarkup(createElement(WorkPresentationArea, {
      presentation: { ...report, title: "本轮运行失败", reportMarkdown: null },
      loading: false, error: null, onOpenWorkLog: vi.fn(),
    }));
    expect(markup).toContain("运行失败");
  });
});
