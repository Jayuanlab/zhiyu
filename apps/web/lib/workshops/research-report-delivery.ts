import { createHash } from "node:crypto";
import { loadWebEvidence } from "@/lib/ai/jina-page-reader";
import type { WorkshopExecutionResult } from "./executor";
import { verifyAndBuildGroundedResearchReport, type GroundedResearchSnapshot } from "./grounded-research-report";
import { resolveWorkshopResearchQuoteRefs } from "./research-quote-selection";
import { resolveWorkshopResearchContract, verifyWorkshopResearchEvidence,
  type WorkshopResearchEvidenceEvent, type WorkshopResearchEvidenceVerification } from "./research-evidence-verification";

export type ResearchDeliveryAudit = {
  version: "grounded-report/v1";
  status: "verified" | "rejected";
  semanticStatus: "not_independently_verified";
  canonicalHash: string | null;
  issues: string[];
};

/** Replays the pinned report against owned saved bodies; never invokes a model
 * or refetches a missing snapshot. Both fresh and captured runs use this seam. */
export async function finalizeWorkshopResearchDelivery(input: {
  workshopId: string;
  runId: string;
  modelConfig: unknown;
  taskText: string;
  events: readonly WorkshopResearchEvidenceEvent[];
  result: WorkshopExecutionResult;
  eventsOverflow?: boolean;
}): Promise<{ result: WorkshopExecutionResult; verification: WorkshopResearchEvidenceVerification; audit?: ResearchDeliveryAudit }> {
  const resolution = resolveWorkshopResearchContract(input.modelConfig, input.taskText);
  const initial = verifyWorkshopResearchEvidence({ ...input, report: input.result.structured });
  const grounded = resolution.active && resolution.contract?.reportDelivery === "grounded-report/v1";
  if (!grounded) {
    if (input.eventsOverflow) {
      initial.status = "evidence_insufficient";
      initial.gaps.push("本轮来源事件超过核验上限，请缩小研究批次后续办。");
    }
    return { result: input.result, verification: initial };
  }
  const issues: string[] = [];
  if (input.eventsOverflow) issues.push("本轮来源事件超过核验上限，请缩小研究批次后续办。");
  for (const source of initial.coverage) {
    if (source.status !== "complete") issues.push(`必读来源 ${source.sourceId} 正文覆盖不足：${source.coveredChars}/${source.totalChars ?? "未知"} 字符。`);
  }
  const snapshots: GroundedResearchSnapshot[] = [];
  if (!issues.length) {
    const loads = await Promise.allSettled(initial.coverage.map(async source => {
      if (!source.evidenceId || !source.contentHash) throw Error("missing_body_identity");
      const window = input.events.find(event => source.eventIds.includes(event.id));
      const metadata = window?.metadata && typeof window.metadata === "object" ? window.metadata as Record<string, unknown> : {};
      if (typeof metadata.url !== "string") throw Error("missing_body_url");
      const { snapshot } = await loadWebEvidence(`workshop:${input.workshopId}`, source.evidenceId, metadata.url);
      const canonical = (raw: string) => { const url = new URL(raw); url.hash = ""; return url.href; };
      if (snapshot.evidenceId !== source.evidenceId || snapshot.contentHash !== source.contentHash ||
          snapshot.content.length !== source.totalChars || !source.urls.some(url => canonical(url) === canonical(snapshot.url))) throw Error("body_identity_mismatch");
      return { sourceId: source.sourceId, evidenceId: snapshot.evidenceId, contentHash: snapshot.contentHash,
        url: snapshot.url, content: snapshot.content };
    }));
    for (const [index, load] of loads.entries()) {
      if (load.status === "fulfilled") snapshots.push(load.value);
      else issues.push(`来源 ${initial.coverage[index].sourceId} 的同版正文快照缺失或身份校验失败；保留失败，不自动重取或重跑。`);
    }
  }
  const resolved = !issues.length ? resolveWorkshopResearchQuoteRefs(input.result.structured, {
    workshopId: input.workshopId, runId: input.runId, coverage: initial.coverage, events: input.events, snapshots,
  }) : null;
  if (resolved && !resolved.ok) issues.push(...resolved.issues);
  const delivery = !issues.length && resolved?.ok ? verifyAndBuildGroundedResearchReport({
    report: resolved.report, runId: input.runId, coverage: initial.coverage, events: input.events, snapshots,
  }) : null;
  if (delivery && !delivery.ok) issues.push(...delivery.issues);
  if (delivery?.ok && !issues.length) {
    const verification = verifyWorkshopResearchEvidence({ ...input, report: delivery.structured });
    if (verification.status === "sufficient") {
      const structured = { ...delivery.structured, presentation: { ...delivery.structured.presentation,
        warnings: [...new Set([...delivery.structured.presentation.warnings, ...verification.warnings])] } };
      const audit: ResearchDeliveryAudit = { version: "grounded-report/v1", status: "verified",
        semanticStatus: "not_independently_verified", canonicalHash: createHash("sha256").update(JSON.stringify(structured)).digest("hex"), issues: [] };
      return { result: { ...input.result, structured, output: structured.summary }, verification, audit };
    }
    issues.push(...verification.gaps);
  }
  if (!issues.length) issues.push("最终报告未形成可核验的单一研究记录。");
  const uniqueIssues = [...new Set(issues)];
  const summary = `研究报告未通过交付核验：${uniqueIssues.slice(0, 2).join("；")}`;
  const coverage = initial.coverage.map(source => `- ${source.label}：${source.status === "complete" ? "全文已返回" : "正文未读齐"}，${source.coveredChars}/${source.totalChars ?? "未知"} 字符。`).join("\n");
  const presentation = { title: "研究报告未通过核验", summary,
    reportMarkdown: `# 研究报告未通过核验\n\n## 正文覆盖\n\n${coverage}\n\n## 未通过原因\n\n${uniqueIssues.map(issue => `- ${issue}`).join("\n")}\n\n原始回复与正文回执已保留。未修补数字、补造引文或自动重试。`,
    evidenceEventIds: initial.verifiedEventIds, warnings: [...new Set([...initial.warnings, ...uniqueIssues])],
    nextSteps: ["根据记录中的具体缺口纠正报告；无法核实的结论留空并明确说明。"] };
  return { result: { ...input.result, output: summary, structured: { presentation } },
    verification: { ...initial, status: "evidence_insufficient", gaps: uniqueIssues },
    audit: { version: "grounded-report/v1", status: "rejected", semanticStatus: "not_independently_verified", canonicalHash: null, issues: uniqueIssues } };
}
