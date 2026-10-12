import { inspectWorkshopResearchSourceRecovery } from "./research-source-recovery";
import { resolveWorkshopResearchContract, verifyWorkshopResearchEvidence,
  type WorkshopResearchEvidenceEvent, type WorkshopResearchSourceCoverage } from "./research-evidence-verification";

export type WorkshopResearchReadingProgress = {
  version: "research-reading-progress/v1";
  phase: "read_sources" | "select_quotes" | "unavailable";
  requiredSourceCount: number;
  completeSourceCount: number;
  coverage: WorkshopResearchSourceCoverage[];
  pendingReadRequests: Array<{ url: string; offset: number; maxChars: number; evidenceId?: string }>;
  gaps: string[];
  warnings: string[];
  /** Source observation only; these phases never prohibit a reading report. */
  guidance: string;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A current-run reading state projection, not report verification or a grant.
 * One page's null cursor never declares the entire required corpus complete.
 * Facts and permitted recovery cursors come from the existing host verifier;
 * this helper does not read bodies, persist events, call tools or use a model. */
export function resolveWorkshopResearchReadingProgress(input: {
  modelConfig: unknown;
  taskText: string;
  runId: string;
  events: readonly WorkshopResearchEvidenceEvent[];
  eventsOverflow?: boolean;
}): WorkshopResearchReadingProgress | null {
  const resolution = resolveWorkshopResearchContract(input.modelConfig, input.taskText);
  if (!resolution.active) return null;
  const rawContract = record(record(input.modelConfig).researchEvidenceContract);
  if (resolution.contract?.reportDelivery !== "grounded-report/v1" && rawContract.reportDelivery !== "grounded-report/v1") return null;
  const unavailable = (gaps: string[]): WorkshopResearchReadingProgress => ({
    version: "research-reading-progress/v1", phase: "unavailable",
    requiredSourceCount: resolution.contract?.requiredPrimarySources.length ?? 0, completeSourceCount: 0,
    coverage: [], pendingReadRequests: [], gaps, warnings: [],
    guidance: "阅读覆盖目前无法确认。仍可提供阶段报告并如实说明资料范围，不能声称全文已读或已核验。",
  });
  if (resolution.issues.length || !resolution.contract) return unavailable([
    "本轮原文阅读合同无效，不能宣布读齐或推测读取游标。", ...resolution.issues,
  ]);
  if (typeof input.runId !== "string" || !input.runId.trim()) return unavailable(["缺少本轮编号，不能把其他运行的原文回执当作当前进度。"]);
  if (input.eventsOverflow || !Array.isArray(input.events) || input.events.length > 1000) {
    return unavailable(["本轮原文事件超出 1000 条核验上限或列表不可用；未将截断的事件列表当作完整正文。"]);
  }
  try {
    const verification = verifyWorkshopResearchEvidence({ ...input, report: undefined });
    const recovery = inspectWorkshopResearchSourceRecovery(input);
    const coverage = verification.coverage;
    const requiredSourceCount = resolution.contract.requiredPrimarySources.length;
    const completeSourceCount = coverage.filter(source => source.status === "complete").length;
    if (coverage.length !== requiredSourceCount || !coverage.length || recovery.incomplete !== (completeSourceCount < requiredSourceCount)) {
      return unavailable(["本轮原文覆盖与现有恢复游标不一致；保留未知状态，不能宣布读齐。"]);
    }
    // The generic verifier also checks a final report. No report exists at this
    // reading seam, so its report-schema gaps do not become missing-source facts.
    const gaps = coverage.filter(source => source.status !== "complete").map(source =>
      `必读来源 ${source.sourceId}（${source.label}）尚未读齐：本轮已连续返回 ${source.coveredChars}/${source.totalChars ?? "未知"} 字符。`);
    return {
      version: "research-reading-progress/v1",
      phase: recovery.incomplete ? "read_sources" : "select_quotes",
      requiredSourceCount, completeSourceCount, coverage,
      // Keep the exact admitted request shape. It remains subject to normal
      // tool grants, denial, lease, deadline and the original request budget.
      pendingReadRequests: recovery.requests,
      gaps, warnings: verification.warnings,
      guidance: "phase 仅描述原文覆盖，不是报告生成门禁。按研究问题决定是否继续补读；可用已有材料交付阶段性 Markdown 报告，明确未读范围。补读参数供继续阅读使用，不增加权限或预算。",
    };
  } catch {
    return unavailable(["本轮原文进度无法可靠核验；未执行补读、扩大权限或伪造完成状态。"]);
  }
}
