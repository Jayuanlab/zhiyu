import { z } from "zod";
import { locateResearchQuoteContext, researchQuoteLocatorIssue } from "./research-quote-context";
import { isSavedResearchPageMethod } from "./research-page-method";
import { researchClaimConditionIssues } from "./research-claim-conditions";
import type {
  WorkshopResearchEvidenceEvent,
  WorkshopResearchSourceCoverage,
} from "./research-evidence-verification";

export const GROUNDED_RESEARCH_REPORT_VERSION = "grounded-report/v1" as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const claimSchema = z.object({
  kind: z.enum(["method", "experiment", "limitation"]),
  claim: boundedText(500),
  locator: boundedText(200),
  quote: z.string().trim().min(40).max(1600),
  evidenceEventId: boundedText(200),
}).strict();
const claimRefSchema = z.object({
  sourceId: boundedText(2048),
  kind: z.enum(["method", "experiment", "limitation"]),
}).strict();
const briefSchema = z.object({
  title: boundedText(100),
  question: boundedText(280),
  findings: z.array(z.object({
    text: boundedText(280),
    claimRefs: z.array(claimRefSchema).min(1).max(6),
  }).strict()).min(2).max(4),
  readingPath: z.array(z.object({ sourceId: boundedText(2048), focus: boundedText(160) }).strict()).min(1).max(6),
}).strict().superRefine((brief, context) => {
  const chars = brief.title.length + brief.question.length + brief.findings.reduce((sum, finding) => sum + finding.text.length, 0)
    + brief.readingPath.reduce((sum, step) => sum + step.focus.length, 0);
  if (chars > 1600) context.addIssue({ code: z.ZodIssueCode.custom, message: "读者解读正文超过 1600 字符；保留关键认识与阅读顺序，不增加原预算" });
});
const reportSchema = z.object({
  researchEvidence: z.object({
    reportVersion: z.literal(GROUNDED_RESEARCH_REPORT_VERSION),
    works: z.array(z.object({
      sourceId: boundedText(2048),
      supportedClaims: z.array(claimSchema).min(3).max(9),
    }).strict()).min(1).max(20),
    gaps: z.array(boundedText(1000)).max(20),
    brief: briefSchema.optional(),
  }).strict(),
}).strict();

export type GroundedResearchClaim = z.infer<typeof claimSchema>;
export type GroundedResearchBrief = z.infer<typeof briefSchema>;
export type GroundedResearchSnapshot = {
  sourceId: string;
  evidenceId: string;
  contentHash: string;
  url: string;
  content: string;
};
export type GroundedResearchStructuredReport = {
  summary: string;
  researchEvidence: {
    reportVersion: typeof GROUNDED_RESEARCH_REPORT_VERSION;
    works: Array<{
      sourceId: string;
      evidenceEventIds: string[];
      method: string;
      experiments: string;
      limitations: string;
      locators: { method: string; experiments: string; limitations: string };
      supportedClaims: GroundedResearchClaim[];
    }>;
    gaps: string[];
    brief?: GroundedResearchBrief;
  };
  presentation: {
    schemaVersion: 1;
    source: "host_grounded_report";
    title: string;
    summary: string;
    reportMarkdown: string;
    researchBriefMarkdown: string;
    evidenceMarkdown: string;
    evidenceEventIds: string[];
    warnings: string[];
    nextSteps: string[];
  };
};
export type GroundedResearchReportVerification =
  | { ok: false; issues: string[] }
  | { ok: true; issues: []; structured: GroundedResearchStructuredReport };
export type GroundedResearchReportInput = {
  report: unknown;
  runId: string;
  coverage: readonly WorkshopResearchSourceCoverage[];
  events: readonly WorkshopResearchEvidenceEvent[];
  /** The loader must validate each persisted snapshot's hash before this call. */
  snapshots: readonly GroundedResearchSnapshot[];
};

const KINDS = ["method", "experiment", "limitation"] as const;
const KIND_LABEL: Record<GroundedResearchClaim["kind"], string> = {
  method: "方法", experiment: "实验", limitation: "局限",
};
type Value = Record<string, unknown>;

function record(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
function normalizeWhitespace(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
function canonicalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}
function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function escapeMarkdown(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
}

/** Keep signs, decimals, exponent, percent and plus suffix; never repair values. */
function numericTokens(value: string): string[] {
  return unique([...value.matchAll(/[+\-−]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][+\-]?\d+)?(?:\s*[%‰]|\+)?/g)]
    .map(match => {
      const token = match[0].replace(/\s+/g, "");
      // A hyphen after an identifier (GRM-27B, o1-1217) is a name separator.
      // Standalone signed quantities retain the sign; their values are never repaired.
      return /^[-+]/.test(token) && /[A-Za-z0-9_]/.test(value[(match.index ?? 0) - 1] ?? "")
        ? token.slice(1) : token;
    }));
}

/** Bind digits inside model/benchmark names, not merely an unrelated chapter. */
function numberedIdentifiers(value: string): string[] {
  return unique((value.match(/[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*/g) ?? [])
    .filter(token => /[A-Za-z]/.test(token) && /\d/.test(token)));
}
function includesIdentifier(quote: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`).test(quote);
}

/** A metric's name and rank are one identity; unrelated digits cannot stand in. */
function rankedMetricIdentifiers(value: string): string[] {
  return unique([...value.matchAll(/(?<![A-Za-z0-9_-])[A-Za-z][A-Za-z0-9_-]*[\t ]*@[\t ]*(?:\d+|[A-Za-z])(?=$|[^A-Za-z0-9_])/g)]
    .map(match => match[0].replace(/[\t ]/g, "")));
}

function claimTokenIssues(claim: GroundedResearchClaim): string[] {
  const quoteNumbers = new Set(numericTokens(claim.quote));
  const quoteMetrics = new Set(rankedMetricIdentifiers(claim.quote).map(metric => metric.toLowerCase()));
  return [
    ...numericTokens(claim.claim).filter(token => !quoteNumbers.has(token)).map(token => `数字 ${token} 未在短摘中出现`),
    ...numberedIdentifiers(claim.claim).filter(token => !includesIdentifier(claim.quote, token))
      .map(token => `带数字的名称 ${token} 未在短摘中对应出现`),
    ...rankedMetricIdentifiers(claim.claim).filter(metric => !quoteMetrics.has(metric.toLowerCase()))
      .map(metric => `指标 ${metric} 的完整名称及参数未在同条选中短摘中出现；查询、邻句和上下文不能代替该短摘`),
  ];
}

// Deliberately closed lexical bridges, never a paper/model/source-specific judge.
// A bridge only identifies a shared local proposition; it does not prove it true.
const EPISTEMIC_TERM_BRIDGES = [
  { source: /\bannotations?\b/i, claim: /\bannotations?\b|标注/iu },
  { source: /\bfundamental\s+capabilit(?:y|ies)\b/i, claim: /\bfundamental\s+capabilit(?:y|ies)\b|基础能力/iu },
] as const;
const ANNOTATION_QUALIFIERS = [
  { source: /\b(?:automated|automatic)\b/i, claim: /\b(?:automated|automatic)\b|自动/iu },
  { source: /\b(?:manual|human)\b/i, claim: /\b(?:manual|human)\b|人工|手工/iu },
] as const;

function sharesEpistemicProposition(sourceClause: string, claimClause: string): boolean {
  for (const bridge of EPISTEMIC_TERM_BRIDGES) {
    if (!bridge.source.test(sourceClause) || !bridge.claim.test(claimClause)) continue;
    if (bridge === EPISTEMIC_TERM_BRIDGES[0] && ANNOTATION_QUALIFIERS.some(qualifier =>
      qualifier.source.test(sourceClause) && !qualifier.claim.test(claimClause))) continue;
    return true;
  }
  // Exact acronyms, mixed-case technical symbols and numbered names are observable
  // anchors. Ordinary shared prose ("the", "result", "method") is not alignment.
  const anchors = unique((sourceClause.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []).filter(token =>
    /\d/.test(token) || (token.match(/[A-Z]/g)?.length ?? 0) >= 2));
  return anchors.some(anchor => {
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "i").test(claimClause);
  });
}

function preservesUncertainty(clause: string): boolean {
  return /(?<!不)可能|似乎|或许|也许|未必|不一定|推测|假设|尚不确定|\b(?:may|might)\b|\b(?:it\s+seems|seems\s+that|appears\s+that)\b/iu.test(clause);
}

/** Bounded lexical guard, not translation, entailment or independent science review. */
function claimEpistemicIssues(claim: GroundedResearchClaim): string[] {
  const claimClauses = claim.claim.split(/[，,、；;。!?！？：:\r\n]+/u).map(clause => clause.trim()).filter(Boolean);
  const issues: string[] = [];
  // Decimal points remain intact. Semicolons and sentence endings bound the
  // selected quote's local statement; unrelated later sentences never align it.
  for (const sentence of claim.quote.split(/[!?;\r\n]+|\.(?=\s+[A-Z]|\s*$)/u)) {
    for (const match of sentence.matchAll(/\b(?:it\s+seems(?:\s+that)?|seems\s+that|appears\s+that|may\s+not|might\s+not)\b/gi)) {
      const index = match.index ?? 0;
      const isHypothesis = /seems|appears/i.test(match[0]);
      const start = isHypothesis ? index : sentence.slice(0, index).lastIndexOf(",") + 1;
      const sourceClause = sentence.slice(start).split(/,\s*(?:while|whereas|but|and)\b/i)[0];
      for (const clause of claimClauses) {
        if (sharesEpistemicProposition(sourceClause, clause) && !preservesUncertainty(clause)) {
          issues.push(`选中短摘局部命题含 ${match[0]}，对应结论分句未保留不确定性；请保留作者限定及本实验语境，或另选更窄的真实连续原句，不能用另一分句的“可能”抵账`);
        }
      }
    }
  }
  return unique(issues);
}

function claimTerminologyIssues(claim: GroundedResearchClaim): string[] {
  // A narrow observed definition error, not a general semantic judge.
  if (/supervised[\s-]+fine[\s-]*tuning/i.test(claim.quote) &&
      /(?:\bSFT\s*(?:预训练|pre[\s-]*training)|预训练\s*[（(]?\s*SFT\b)/i.test(claim.claim)) {
    return ["短摘明确说 supervised fine-tuning（监督微调），不能将 SFT 称为预训练；保留已预训练基座与后训练阶段的区别"];
  }
  return [];
}

function receiptWindow(event: WorkshopResearchEvidenceEvent, runId: string,
  source: WorkshopResearchSourceCoverage, snapshot: GroundedResearchSnapshot): string | null {
  const metadata = record(event.metadata);
  const url = canonicalUrl(metadata.url);
  const sourceUrls = source.urls.map(canonicalUrl).filter((value): value is string => value !== null);
  const finalUrl = metadata.finalUrl == null ? null : canonicalUrl(metadata.finalUrl);
  if (event.runId !== runId || event.type !== "source_checked" || metadata.receiptAuthority !== "runtime" ||
    metadata.toolName !== "webReadPage" || metadata.ok !== true || !isSavedResearchPageMethod(metadata) ||
    metadata.evidenceId !== snapshot.evidenceId || metadata.contentHash !== snapshot.contentHash ||
    !url || url !== canonicalUrl(snapshot.url) || !sourceUrls.includes(url) ||
    (metadata.finalUrl != null && (!finalUrl || !sourceUrls.includes(finalUrl))) ||
    !safeInteger(metadata.offset, 0) || !safeInteger(metadata.contentLength, 1) ||
    metadata.totalChars !== snapshot.content.length || metadata.totalChars !== source.totalChars ||
    typeof metadata.qualityScore !== "number" || !Number.isFinite(metadata.qualityScore) ||
    metadata.qualityScore < 0 || metadata.qualityScore > 100) return null;
  const end = metadata.offset + metadata.contentLength;
  if (!Number.isSafeInteger(end) || end > snapshot.content.length ||
    (metadata.nextOffset === null ? end !== snapshot.content.length : metadata.nextOffset !== end || end >= snapshot.content.length)) return null;
  return snapshot.content.slice(metadata.offset, end);
}

function observedEvents(events: readonly WorkshopResearchEvidenceEvent[]): Map<string, WorkshopResearchEvidenceEvent> {
  const byId = new Map<string, WorkshopResearchEvidenceEvent>();
  const conflicts = new Set<string>();
  for (const event of events) {
    if (!event.id) continue;
    const previous = byId.get(event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) conflicts.add(event.id);
    byId.set(event.id, event);
  }
  for (const id of conflicts) byId.delete(id);
  return byId;
}

function completeSnapshot(source: WorkshopResearchSourceCoverage,
  snapshots: readonly GroundedResearchSnapshot[]): GroundedResearchSnapshot | null {
  if (source.status !== "complete" || !source.evidenceId || !source.contentHash ||
    !/^[a-f0-9]{64}$/i.test(source.contentHash) || !safeInteger(source.totalChars, 1) ||
    source.coveredChars !== source.totalChars || !source.eventIds.length) return null;
  const allowedUrls = source.urls.map(canonicalUrl);
  const matches = snapshots.filter(snapshot => snapshot.sourceId === source.sourceId &&
    snapshot.evidenceId === source.evidenceId && snapshot.contentHash === source.contentHash &&
    allowedUrls.includes(canonicalUrl(snapshot.url)) && canonicalUrl(snapshot.url) !== null &&
    snapshot.content.length === source.totalChars);
  if (!matches.length || matches.some(snapshot => snapshot.content !== matches[0].content ||
    canonicalUrl(snapshot.url) !== canonicalUrl(matches[0].url))) return null;
  return matches[0];
}

/** References bind an interpretation to existing facts, never certify entailment. */
function briefIssues(report: z.infer<typeof reportSchema>): string[] {
  const brief = report.researchEvidence.brief;
  if (!brief) return [];
  const issues: string[] = [];
  const works = report.researchEvidence.works;
  const allClaims = works.flatMap(work => work.supportedClaims);
  const checkTokens = (text: string, claims: GroundedResearchClaim[], label: string) => {
    const basis = claims.map(claim => claim.claim).join("\n");
    const probe: GroundedResearchClaim = { kind: "method", claim: text, quote: basis, locator: "解读所引结论", evidenceEventId: "" };
    issues.push(...claimTokenIssues(probe).map(issue => `${label}：${issue}；解读不能加入所引事实没有报告的新数字或型号。`));
  };
  checkTokens(brief.title, allClaims, "研究标题");
  checkTokens(brief.question, allClaims, "研究问题");
  for (const [index, finding] of brief.findings.entries()) {
    const cited: GroundedResearchClaim[] = [];
    for (const ref of finding.claimRefs) {
      const source = works.find(work => work.sourceId === ref.sourceId);
      const matches = source?.supportedClaims.filter(claim => claim.kind === ref.kind) ?? [];
      if (!matches.length) issues.push(`关键认识 ${index + 1} 的依据 ${ref.sourceId}/${ref.kind} 未对应本报告结论；不接受其他论文、历史运行或伪造种类。`);
      cited.push(...matches);
    }
    if (cited.length) checkTokens(finding.text, cited, `关键认识 ${index + 1}`);
  }
  for (const [index, step] of brief.readingPath.entries()) {
    const source = works.find(work => work.sourceId === step.sourceId);
    if (!source) issues.push(`阅读顺序 ${index + 1} 引用了本轮报告以外的来源 ${step.sourceId}；不能虚构已阅读材料。`);
    else checkTokens(step.focus, source.supportedClaims, `阅读顺序 ${index + 1}`);
  }
  return unique(issues);
}

function buildReaderMarkdown(brief: GroundedResearchBrief | undefined,
  works: GroundedResearchStructuredReport["researchEvidence"]["works"], coverage: readonly WorkshopResearchSourceCoverage[],
  snapshots: Map<string, GroundedResearchSnapshot>, title: string): string {
  const labels = new Map(coverage.map(source => [source.sourceId, source.label]));
  const lines = [`# ${escapeMarkdown(title)}`];
  if (brief) {
    lines.push(`本轮问题：${escapeMarkdown(brief.question)}`, "## 关键认识");
    for (const finding of brief.findings) {
      const refs = unique(finding.claimRefs.map(ref => `${labels.get(ref.sourceId)}·${KIND_LABEL[ref.kind]}`));
      lines.push(`- ${escapeMarkdown(finding.text)}\n\n  依据：${refs.map(escapeMarkdown).join("；")}`);
    }
    lines.push("以上为基于所列结论的综合解读；引文对应检查不代替独立内容审查。");
  } else {
    lines.push("本轮按来源整理方法、实验结果和适用边界。尚未提交跨来源解读。", "## 研究要点");
  }
  const table = ["| 来源 | 方法 | 实验结果与条件 | 局限 |", "| --- | --- | --- | --- |"];
  for (const work of works) {
    table.push(`| ${escapeMarkdown(labels.get(work.sourceId)!)} | ${escapeMarkdown(work.method).replace(/\n/g, "<br />")} | ${escapeMarkdown(work.experiments).replace(/\n/g, "<br />")} | ${escapeMarkdown(work.limitations).replace(/\n/g, "<br />")} |`);
  }
  lines.push("## 论文对照", table.join("\n"));
  if (brief) {
    lines.push("## 阅读顺序");
    brief.readingPath.forEach((step, index) => lines.push(`${index + 1}. **${escapeMarkdown(labels.get(step.sourceId)!)}**：${escapeMarkdown(step.focus)}`));
  }
  lines.push("## 原文与范围");
  for (const source of coverage) lines.push(`- [${escapeMarkdown(source.label)}](<${canonicalUrl(snapshots.get(source.sourceId)!.url)!}>)：本轮配置的原文版本。`);
  lines.push("本轮覆盖所列原文版本，未进行全领域或最新论文的完整扫描。作者结果、综合解读与实际复现实验应分别看待；正文已读取不代表图示、公式和科学语义已经独立核准。");
  return lines.join("\n\n");
}

function buildStructuredReport(report: z.infer<typeof reportSchema>, coverage: readonly WorkshopResearchSourceCoverage[],
  snapshots: Map<string, GroundedResearchSnapshot>, events: Map<string, WorkshopResearchEvidenceEvent>): GroundedResearchStructuredReport {
  const allEventIds: string[] = [];
  const sections: string[] = [];
  const works = coverage.map(source => {
    const work = report.researchEvidence.works.find(value => value.sourceId === source.sourceId)!;
    const supportedClaims = KINDS.flatMap(kind => work.supportedClaims.filter(claim => claim.kind === kind));
    const evidenceEventIds = unique([...source.eventIds, ...supportedClaims.map(claim => claim.evidenceEventId)]);
    allEventIds.push(...evidenceEventIds);
    const snapshot = snapshots.get(source.sourceId)!;
    const sourceParts = [`## ${escapeMarkdown(source.label)}`, `来源：[同版原文](<${canonicalUrl(snapshot.url)!}>)`];
    for (const kind of KINDS) {
      sourceParts.push(`### ${KIND_LABEL[kind]}`);
      for (const claim of supportedClaims.filter(value => value.kind === kind)) {
        sourceParts.push(`- ${escapeMarkdown(claim.claim)}`,
          `  位置：${escapeMarkdown(claim.locator)}；正文回执：${escapeMarkdown(claim.evidenceEventId)}`,
          `> ${escapeMarkdown(normalizeWhitespace(claim.quote))}`);
        const metadata = record(events.get(claim.evidenceEventId)?.metadata);
        const context = locateResearchQuoteContext(snapshot.content, claim.quote,
          { offset: metadata.offset as number, endOffset: (metadata.offset as number) + (metadata.contentLength as number) });
        if (context?.heading) {
          sourceParts.push(`  证据语境（宿主从同版正文定位）：${escapeMarkdown(context.headingPath.join(" / "))}`,
            `> ${escapeMarkdown(normalizeWhitespace(context.paragraph))}${context.paragraphTruncated ? "（上下文已按长度或阅读窗口截取，不能视为完整实验条件。）" : ""}`);
        }
      }
    }
    sections.push(sourceParts.join("\n\n"));
    const contentFor = (kind: GroundedResearchClaim["kind"]) => supportedClaims.filter(claim => claim.kind === kind)
      .map(claim => claim.claim).join("\n");
    const locatorsFor = (kind: GroundedResearchClaim["kind"]) => unique(supportedClaims.filter(claim => claim.kind === kind)
      .map(claim => claim.locator)).join("；");
    return { sourceId: source.sourceId, evidenceEventIds, method: contentFor("method"),
      experiments: contentFor("experiment"), limitations: contentFor("limitation"),
      locators: { method: locatorsFor("method"), experiments: locatorsFor("experiment"), limitations: locatorsFor("limitation") },
      supportedClaims };
  });
  const warnings = [
    "宿主已核对短摘来自本轮同版正文及所引用窗口，数字与短摘对应；真实引文不等于中文结论已被逻辑支持，机制、比较条件和因果关系仍需独立抽查。",
    "正文提取、公式和图片未在本验收中进行独立复核。论文时效性以列出的原文版本为准。",
    "不确定性只对明确模态与可词法对应的局部命题作有限检查；无法对齐的分句和其他语义仍需独立抽查，门禁通过不等于科学审批。",
  ];
  if (unique(allEventIds).some(id => record(events.get(id)?.metadata).finalUrlVerified !== true)) {
    warnings.push("正文读取器未独立验证重定向最终地址。已保留真实读取记录，此限制不能作为已核验结论。");
  }
  const brief = report.researchEvidence.brief;
  const title = brief?.title ?? `${coverage.map(source => source.label).join("、")}：研究摘要`;
  const summary = brief ? brief.findings.map(finding => finding.text).slice(0, 2).join("\n")
    : works.slice(0, 2).map(work => `${coverage.find(source => source.sourceId === work.sourceId)!.label}：${work.method}`).join("\n");
  const researchBriefMarkdown = buildReaderMarkdown(brief, works, coverage, snapshots, title);
  const evidenceMarkdown = sections.join("\n\n");
  return { summary, researchEvidence: { reportVersion: GROUNDED_RESEARCH_REPORT_VERSION, works, gaps: [], ...(brief ? { brief } : {}) },
    presentation: { schemaVersion: 1, source: "host_grounded_report", title, summary,
      researchBriefMarkdown, evidenceMarkdown,
      reportMarkdown: [researchBriefMarkdown, "## 原文依据", evidenceMarkdown, "## 核验范围", ...warnings.map(warning => `- ${escapeMarkdown(warning)}`)].join("\n\n"),
      evidenceEventIds: unique(allEventIds), warnings,
      nextSteps: brief?.readingPath.map(step => `${coverage.find(source => source.sourceId === step.sourceId)!.label}：${step.focus}`)
        ?? ["对关键机制、指标定义与实验比较条件进行独立语义抽查。"] } };
}

/**
 * One canonical report, derived entirely from verified claims and host receipts.
 * This checks observable quotation provenance and bounded lexical bindings, not
 * scientific semantic truth. It grants no permissions and performs no actions.
 */
export function verifyAndBuildGroundedResearchReport(input: GroundedResearchReportInput): GroundedResearchReportVerification {
  const parsed = reportSchema.safeParse(input.report);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(issue =>
    `报告格式 ${issue.path.join(".") || "顶层"}：${issue.message}；只接受单一 researchEvidence，不接受自由 presentation/summary/reportMarkdown。`) };
  const report = parsed.data;
  const issues: string[] = [...report.researchEvidence.gaps.map(gap => `报告声明尚缺证据：${gap}`), ...briefIssues(report)];
  if (!input.runId || !input.coverage.length || input.coverage.length > 20) {
    issues.push("缺少本轮编号或有效的必读来源覆盖记录。");
  }
  const required = new Set(input.coverage.map(source => source.sourceId));
  if (required.size !== input.coverage.length) issues.push("必读来源覆盖记录存在重复编号。");
  for (const work of report.researchEvidence.works) {
    if (!required.has(work.sourceId)) issues.push(`报告来源编号未绑定必读原文：${work.sourceId}`);
  }
  const events = observedEvents(input.events);
  const snapshots = new Map<string, GroundedResearchSnapshot>();
  for (const source of input.coverage) {
    const matches = report.researchEvidence.works.filter(work => work.sourceId === source.sourceId);
    if (matches.length !== 1) {
      issues.push(`必读来源 ${source.sourceId} 需要且只能有一条规范报告记录。`);
      continue;
    }
    const snapshot = completeSnapshot(source, input.snapshots);
    if (!snapshot) {
      issues.push(`必读来源 ${source.sourceId} 缺少本轮完整覆盖所绑定的同版正文 snapshot。`);
      continue;
    }
    snapshots.set(source.sourceId, snapshot);
    const normalizedContent = normalizeWhitespace(snapshot.content);
    for (const id of source.eventIds) {
      const event = events.get(id);
      if (!event || receiptWindow(event, input.runId, source, snapshot) === null) {
        issues.push(`必读来源 ${source.sourceId} 的完整覆盖回执 ${id} 未绑定本轮真实同版正文。`);
      }
    }
    const claims = matches[0].supportedClaims;
    for (const kind of KINDS) {
      if (!claims.some(claim => claim.kind === kind)) issues.push(`必读来源 ${source.sourceId} 缺少${KIND_LABEL[kind]}结论及原文短摘。`);
    }
    for (const [index, claim] of claims.entries()) {
      const prefix = `必读来源 ${source.sourceId} 第 ${index + 1} 条结论`;
      const event = events.get(claim.evidenceEventId);
      const window = event ? receiptWindow(event, input.runId, source, snapshot) : null;
      if (window === null) {
        issues.push(`${prefix} 的 evidenceEventId 不对应本轮该来源的真实正文窗口。`);
        continue;
      }
      const quote = normalizeWhitespace(claim.quote);
      if (!normalizedContent.includes(quote) || !normalizeWhitespace(window).includes(quote)) {
        issues.push(`${prefix} 的短摘未完整出现在所引用的同版正文窗口中。`);
      }
      issues.push(...claimTokenIssues(claim).map(issue => `${prefix}：${issue}。`));
      issues.push(...claimEpistemicIssues(claim).map(issue => `${prefix}：${issue}。`));
      issues.push(...claimTerminologyIssues(claim).map(issue => `${prefix}：${issue}。`));
      const metadata = record(event?.metadata);
      const context = locateResearchQuoteContext(snapshot.content, claim.quote,
        { offset: metadata.offset as number, endOffset: (metadata.offset as number) + (metadata.contentLength as number) });
      issues.push(...researchClaimConditionIssues({ ...claim, context: context?.paragraph ?? "" })
        .map(issue => `${prefix}：${issue}。`));
      if (!context && normalizeWhitespace(window).includes(quote)) {
        issues.push(`${prefix}：短摘在同一阅读窗口出现多次，无法唯一定位；请选择包含上下文的唯一连续原句，不能挑选有利的章节标注。`);
      }
      const locatorIssue = context ? researchQuoteLocatorIssue(claim.locator, context) : null;
      if (locatorIssue) issues.push(`${prefix}：${locatorIssue}`);
    }
  }
  for (const [index, finding] of (report.researchEvidence.brief?.findings ?? []).entries()) {
    for (const ref of finding.claimRefs) {
      const snapshot = snapshots.get(ref.sourceId);
      if (!snapshot) continue;
      const claims = report.researchEvidence.works.find(work => work.sourceId === ref.sourceId)?.supportedClaims
        .filter(claim => claim.kind === ref.kind) ?? [];
      for (const claim of claims) {
        const metadata = record(events.get(claim.evidenceEventId)?.metadata);
        const context = locateResearchQuoteContext(snapshot.content, claim.quote,
          { offset: metadata.offset as number, endOffset: (metadata.offset as number) + (metadata.contentLength as number) });
        const interpreted = { ...claim, claim: finding.text };
        issues.push(...claimEpistemicIssues(interpreted).map(issue => `关键认识 ${index + 1}：${issue}。`));
        issues.push(...claimTerminologyIssues(interpreted).map(issue => `关键认识 ${index + 1}：${issue}。`));
        issues.push(...researchClaimConditionIssues({ ...interpreted, context: context?.paragraph ?? "" })
          .map(issue => `关键认识 ${index + 1}：${issue}。`));
      }
    }
  }
  if (issues.length) return { ok: false, issues: unique(issues) };
  const structured = buildStructuredReport(report, input.coverage, snapshots, events);
  if (structured.presentation.reportMarkdown.length > 64_000) {
    return { ok: false, issues: ["规范报告超过 64000 字符展示上限；请减少重复短摘后重新提交，不截断或替换结论。"] };
  }
  return { ok: true, issues: [], structured };
}
