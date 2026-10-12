import { createHash } from "node:crypto";
import type { WorkshopExecutionResult } from "./executor";
import { parseGroundedResearchFinalJson } from "./grounded-final-json";
import { knownWorkshopRuntimeFailureMessage } from "./runtime-failure";
import { finalizeWorkshopResearchDelivery, type ResearchDeliveryAudit } from "./research-report-delivery";
import { resolveWorkshopResearchContract, verifyWorkshopResearchEvidence,
  type WorkshopResearchEvidenceEvent, type WorkshopResearchEvidenceVerification } from "./research-evidence-verification";

/** Delivery of a reading artifact is independent of evidence approval. */
export type ReaderResearchDeliveryAudit = {
  version: "reader-report/v1";
  status: "delivered" | "rejected";
  verificationStatus: "verified" | "unverified";
  semanticStatus: "not_independently_verified";
  canonicalHash: string | null;
  issues: string[];
  groundedAudit?: ResearchDeliveryAudit;
};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const records = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const strings = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const escape = (value: string) => value.replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const UNVERIFIED = "报告已生成；来源覆盖与逐条引用尚未全部核验，请结合下方依据与限制阅读。";

function sourceLabel(sourceId: string, verification: WorkshopResearchEvidenceVerification) {
  return verification.coverage.find(source => source.sourceId === sourceId)?.label ?? `${sourceId || "未标注来源"}（来源未匹配）`;
}

/** Format author content without filling in facts, references or missing claims.
 * This tolerant path is for reading only; it never produces a verified receipt. */
export function extractWorkshopResearchReaderDraft(rawText: string, structured: unknown,
  verification: WorkshopResearchEvidenceVerification): { title: string; markdown: string; authored: RecordValue | null } | null {
  const raw = rawText.trim();
  if (knownWorkshopRuntimeFailureMessage(raw) || raw === "Final validation correction limit exhausted" || /^Workshop run completed$/i.test(raw)) return null;
  if (/^I (?:will|am going to) (?:start|begin) (?:reading|researching)(?: the (?:paper|sources))?(?: and report back)?[.!]?$/i.test(raw) ||
      /^(?:我(?:将|会|现在)?|正在|准备)(?:开始)?(?:阅读|搜索|研究|整理)(?:资料|论文|报告)?[。！.!]?$/u.test(raw)) return null;
  // Recognize serialization at the document boundary, never by scanning body
  // examples such as \\boxed{}, inline objects or a report's code blocks.
  // Preserve the existing introductory line + JSON-report form, while requiring
  // the entire remaining envelope to parse (no nested or trailing salvage).
  const preface = /^[^\r\n]+[:：][\t ]*\r?\n(?:[\t ]*\r?\n)*(?=```json\b)/i.exec(raw);
  const envelope = preface && !/^(?:#{1,6}\s|[>*+-]\s|\d+[.)]\s)/.test(preface[0])
    ? raw.slice(preface[0].length) : raw;
  const hasEnvelope = /^(?:\{|\[|```json\b)/i.test(envelope);
  const hasStructured = structured !== null && structured !== undefined;
  const authored = hasStructured ? record(structured) : hasEnvelope ? parseGroundedResearchFinalJson(envelope) : null;
  if (hasEnvelope && !hasStructured && !authored) return null;
  const value = record(authored);
  const presentation = record(value.presentation);
  const evidence = record(value.researchEvidence);
  const brief = record(evidence.brief);
  const explicit = text(value.reportMarkdown) || text(value.finalMarkdownReport) || text(presentation.reportMarkdown);
  let markdown = explicit;
  if (!markdown && Array.isArray(evidence.works)) {
    const sections: string[] = [];
    if (text(brief.title)) sections.push(`# ${text(brief.title)}`);
    if (text(brief.question)) sections.push(text(brief.question));
    const findings = records(brief.findings).map(finding => text(finding.text)).filter(Boolean);
    if (findings.length) sections.push("## 关键认识\n\n" + findings.map(finding => `- ${finding}`).join("\n"));
    const works = records(evidence.works).map(work => {
      const claims = records(work.supportedClaims).map(claim => text(claim.claim)).filter(Boolean);
      if (!claims.length) return "";
      return `### ${escape(sourceLabel(text(work.sourceId), verification))}\n\n${claims.map(claim => `- ${claim}`).join("\n")}`;
    }).filter(Boolean);
    if (works.length) sections.push("## 材料要点（未完成逐条引用核验）\n\n" + works.join("\n\n"));
    const reading = records(brief.readingPath).filter(step => text(step.focus)).map(step =>
      `- ${escape(sourceLabel(text(step.sourceId), verification))}：${text(step.focus)}`);
    if (reading.length) sections.push("## 阅读建议\n\n" + reading.join("\n"));
    const gaps = strings(evidence.gaps);
    if (gaps.length) sections.push("## 待核对\n\n" + gaps.map(gap => `- ${gap}`).join("\n"));
    markdown = sections.join("\n\n");
  }
  if (!markdown) {
    // Do not expose serialization fragments or a host checkpoint as prose.
    if (hasEnvelope || hasStructured) return null;
    markdown = raw;
  }
  if (!markdown || !markdown.replace(/^#{1,6}\s+.*$/gm, "").trim() || knownWorkshopRuntimeFailureMessage(markdown)) return null;
  const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1];
  return { title: (text(presentation.title) || text(brief.title) || heading || "研究报告").slice(0, 160), markdown, authored };
}

type Input = {
  workshopId: string; runId: string; modelConfig: unknown; taskText: string;
  events: readonly WorkshopResearchEvidenceEvent[]; result: WorkshopExecutionResult; eventsOverflow?: boolean;
};

/** The old grounded verifier remains an independent, unchanged evaluator.
 * Reader delivery may succeed with warnings; runtime failures cannot. */
export async function finalizeWorkshopResearchReaderDelivery(input: Input): Promise<{
  result: WorkshopExecutionResult; verification: WorkshopResearchEvidenceVerification;
  audit?: ReaderResearchDeliveryAudit | ResearchDeliveryAudit;
}> {
  const resolution = resolveWorkshopResearchContract(input.modelConfig, input.taskText);
  if (!resolution.active || resolution.contract?.reportDelivery !== "grounded-report/v1") {
    return finalizeWorkshopResearchDelivery(input);
  }
  const initial = verifyWorkshopResearchEvidence({ ...input, report: input.result.structured });
  const draft = input.result.status === "success"
    ? extractWorkshopResearchReaderDraft(input.result.output, input.result.structured, initial) : null;
  const structuredInput = input.result.structured ?? draft?.authored ?? null;
  // No network/model calls. Only an explicitly provided evidence object uses
  // the optional strict evaluation; free prose is not forced into its schema.
  let strict: Awaited<ReturnType<typeof finalizeWorkshopResearchDelivery>> | null = null;
  let strictUnavailable = false;
  if (record(structuredInput).researchEvidence && input.result.status === "success") {
    try { strict = await finalizeWorkshopResearchDelivery({ ...input, result: { ...input.result, structured: structuredInput } }); }
    catch { strictUnavailable = true; }
  }
  const verification = strict?.verification ?? initial;
  const approved = strict?.audit?.status === "verified";
  const issues = [...new Set([
    ...resolution.issues, ...(strict?.audit?.issues ?? verification.gaps),
    ...(input.eventsOverflow ? ["本轮来源记录超过核验范围；部分依据未检查。"] : []),
    ...(strictUnavailable ? ["逐条引用核验本次不可用；保留原始记录，未自动重取来源。"] : []),
  ])];
  if (!draft || resolution.issues.length || input.result.status !== "success") {
    const failures = [...resolution.issues, input.result.error || "本轮未形成可阅读的报告正文。"];
    return { result: input.result, verification, audit: { version: "reader-report/v1", status: "rejected",
      verificationStatus: "unverified", semanticStatus: "not_independently_verified", canonicalHash: null, issues: failures } };
  }
  const verifiedPresentation = approved ? record(strict?.result.structured?.presentation) : {};
  const markdown = approved ? text(verifiedPresentation.researchBriefMarkdown) || draft.markdown : draft.markdown;
  const observed = verification.coverage.map(source => `- ${escape(source.label)}：${source.status === "complete" ? "全文已返回" : "正文读取不完整"}（${source.coveredChars}/${source.totalChars ?? "未知"} 字符）；[来源](${source.urls[0]})。`).join("\n");
  const details = approved ? text(verifiedPresentation.evidenceMarkdown) : [
    "## 来源与阅读范围", observed || "本轮没有可核对的正文读取记录。",
    "## 引用核验说明", "正文是模型整理的研究内容，尚未完成逐条引用核验；交付不代表所有结论正确。",
    ...(issues.length ? [issues.map(issue => `- ${escape(issue)}`).join("\n")] : []),
  ].join("\n\n");
  const warnings = approved ? strings(verifiedPresentation.warnings) : [UNVERIFIED,
    ...(verification.coverage.some(source => source.status !== "complete") ? ["本轮部分来源尚未读完；报告按已读取材料提供阶段性认识。"] : []),
    ...(verification.warnings.some(warning => warning === "direct_source_defuddle_fallback") ? ["阅读服务降级为公开源站正文提取，来源提取质量仍需核对。"] : []),
    ...(input.eventsOverflow || strictUnavailable ? ["本轮部分依据未完成检查，详见来源与核验说明。"] : []),
  ];
  const summary = markdown.replace(/^#{1,6}\s+.*(?:\r?\n|$)/m, "").replace(/\s+/g, " ").trim().slice(0, 800) || draft.title;
  // Store content only. Relaxed parsing never turns memory, outbox or wakeup
  // fields into control actions.
  const structured = { summary,
    ...(approved ? { researchEvidence: strict?.result.structured?.researchEvidence } : {}),
    presentation: { schemaVersion: 1, source: "host_research_reader", title: draft.title, summary,
      reportMarkdown: `${markdown}\n\n${approved ? "" : `> ${UNVERIFIED}\n\n`}${details}`,
      researchBriefMarkdown: markdown, evidenceMarkdown: details,
      evidenceEventIds: verification.verifiedEventIds, warnings, nextSteps: [] },
  };
  return { result: { ...input.result, structured, output: summary }, verification,
    audit: { version: "reader-report/v1", status: "delivered", verificationStatus: approved ? "verified" : "unverified",
      semanticStatus: "not_independently_verified", canonicalHash: createHash("sha256").update(JSON.stringify(structured)).digest("hex"),
      issues, ...(strict?.audit ? { groundedAudit: strict.audit } : {}) } };
}
