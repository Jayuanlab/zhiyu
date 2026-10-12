export type WorkshopRuntimeFailureEvent = {
  id: string;
  runId?: string | null;
  type: string;
  seq?: number;
  createdAt?: Date | string;
  metadata?: unknown;
};

export type WorkshopRuntimeFailure = {
  version: "workshop-runtime-failure/v1";
  receiptAuthority: "runtime";
  runId: string;
  code: "research_final_validation_rejected" | "agent_runtime_failed";
  runtimeError: string;
  message: string;
  issues: string[];
  /** Same-run host terminal witness for a narrow, known process failure. */
  runtimeEventId?: string;
  validationEventId?: string;
  attempt?: number;
  omittedIssueCount?: number;
};

const CORRECTION_LIMIT = "Final validation correction limit exhausted";
const KNOWN_RUNTIME_FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  "Final validation correction forward limit exhausted": "本轮补读与报告处理的模型往返次数已达到运行上限，尚未形成通过核验的报告。",
  "Final validation correction has no forward budget after this tool": "本轮读取或纠正操作后，剩余模型往返次数不足以继续完成报告，尚未形成通过核验的报告。",
  "Final validation correction output budget is unknown or exhausted": "报告纠正所需的输出预算无法确认或已用尽，系统已停止，尚未形成通过核验的报告。",
  "Final validation correction output budget exhausted": "报告纠正阶段的输出预算已用尽，尚未形成通过核验的报告。",
  "Final validation correction deadline is unknown": "本轮报告纠正缺少可验证的截止时间，系统已停止，尚未形成通过核验的报告。",
  "Final validation whole-runtime deadline exhausted": "本轮研究任务已达到运行时间上限，尚未形成通过核验的报告。",
  "Final validation context compaction forward limit exhausted": "上下文压缩阶段的模型往返次数已达到上限，尚未形成通过核验的报告。",
  "Final validation context compaction output budget exhausted": "上下文压缩阶段的输出预算已用尽，尚未形成通过核验的报告。",
  "Final validation context compaction result is invalid": "上下文压缩未返回有效结果，系统已停止，尚未形成通过核验的报告。",
  "Final validation context compaction is not allowed": "本轮上下文压缩不符合宿主允许的运行边界，系统已停止，尚未形成通过核验的报告。",
  "Final validation source recovery configuration is invalid": "原文恢复读取的运行配置不满足宿主边界，系统已停止，尚未形成通过核验的报告。",
  "Final validation source recovery coverage callback failed": "原文恢复读取时，宿主未能完成正文覆盖检查，尚未形成通过核验的报告。",
  "Final validation source recovery callback returned an invalid result": "原文恢复读取时，正文覆盖检查未返回有效结果，尚未形成通过核验的报告。",
  "Final validation source recovery forward limit exhausted": "原文恢复读取阶段的模型往返次数已达到上限，尚未形成通过核验的报告。",
  "Final validation source recovery output budget exhausted": "原文恢复读取阶段的模型输出预算已用尽，尚未形成通过核验的报告。",
  "Final validation source recovery tool is not allowed": "原文恢复读取请求超出本轮允许的读取工具范围，系统已停止，尚未形成通过核验的报告。",
  "Final validation source recovery tool policy failed": "原文恢复读取的工具请求未通过宿主策略核验，系统已停止，尚未形成通过核验的报告。",
  "Final validation forward budget receipt failed": "本轮模型往返预算回执未能保存，系统已停止，尚未形成通过核验的报告。",
});

/** Fixed host messages only. Never pass through arbitrary errors or prompts. */
export function knownWorkshopRuntimeFailureMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (Object.hasOwn(KNOWN_RUNTIME_FAILURE_MESSAGES, value)) return KNOWN_RUNTIME_FAILURE_MESSAGES[value];
  const budget = /^Research tool budget exhausted: ([1-9]\d{0,4})\/([1-9]\d{0,4})$/.exec(value);
  if (budget && Number(budget[1]) === Number(budget[2]) + 1) {
    return `本轮读取与报告处理已达到 ${Number(budget[2])} 次工具调用上限，尚未形成通过核验的报告。`;
  }
  return null;
}
const MAX_ISSUES = 20;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const timestamp = (value: unknown) => value instanceof Date || typeof value === "string" ? new Date(value).getTime() : NaN;

function order(left: WorkshopRuntimeFailureEvent, right: WorkshopRuntimeFailureEvent) {
  if (Number.isSafeInteger(left.seq) && Number.isSafeInteger(right.seq)) return left.seq! - right.seq!;
  const time = timestamp(left.createdAt) - timestamp(right.createdAt);
  return Number.isFinite(time) ? time : 0;
}

/** Compatibility reads only the fixed host feedback section, never the model
 * body, quotation JSON, recovery hints, or a model-authored issue list. */
function rejectionIssues(metadata: Record<string, unknown>): string[] {
  if (Array.isArray(metadata.issues)) return [...new Set(metadata.issues.filter((value): value is string =>
    typeof value === "string" && Boolean(value.trim())).map(value => value.trim()))];
  const feedback = text(metadata.feedback);
  if (!feedback.startsWith("宿主结束前研究交付校验未通过。")) return [];
  const section = feedback.match(/本次真实未通过原因（最多 20 条）：\r?\n([\s\S]*?)\r?\n引用窗口定位提示：/u)?.[1];
  if (!section) return [];
  return [...new Set(section.split(/\r?\n/u).flatMap(line => {
    const match = line.match(/^\d{1,2}\. (.+)$/u);
    return match ? [match[1].trim()] : [];
  }))];
}

function sameExecution(rejection: WorkshopRuntimeFailureEvent, terminal: WorkshopRuntimeFailureEvent, runId: string) {
  const left = record(record(rejection.metadata).execution);
  const right = record(record(terminal.metadata).execution);
  if (!Object.keys(left).length && !Object.keys(right).length) return true;
  return left.runId === runId && right.runId === runId &&
    Number.isSafeInteger(left.token) && left.token === right.token &&
    typeof left.workerId === "string" && Boolean(left.workerId) && left.workerId === right.workerId;
}

/** Pure interpretation of a failed runtime. It cannot admit a final report or
 * modify terminal state. Exact same-run host receipts outrank downstream null
 * schema errors. Missing/ambiguous receipts retain the original runtime error. */
export function resolveWorkshopRuntimeFailure(input: {
  runId: string;
  error?: string | null;
  runtimeFailure?: unknown;
  startedAt?: Date | string | null;
  events: readonly WorkshopRuntimeFailureEvent[];
}): WorkshopRuntimeFailure {
  const events = input.events.filter(event => event.runId === input.runId).slice().sort(order);
  const host = (event: WorkshopRuntimeFailureEvent) => record(event.metadata).receiptAuthority === "runtime";
  const terminal = [...events].reverse().find(event => event.type === "agent_final_output_rejected" && host(event) &&
    record(event.metadata).terminalStatus === "failed");
  const terminalError = text(record(terminal?.metadata).error);
  const saved = record(input.runtimeFailure);
  const runtimeError = (terminalError || text(input.error) || "智能体运行未形成可交付结果。").slice(0, 4000);
  const configured = [...events].reverse().find(event => event.type === "agent_configured" || event.type === "run_started");
  const start = timestamp(input.startedAt);
  const cutoff = Math.max(Number.isFinite(start) ? start : -Infinity,
    Number.isFinite(timestamp(configured?.createdAt)) ? timestamp(configured?.createdAt) : -Infinity);
  const terminalTime = timestamp(terminal?.createdAt);
  const knownMessage = knownWorkshopRuntimeFailureMessage(terminalError);
  const savedGenericMatches = !Object.keys(saved).length || (saved.version === "workshop-runtime-failure/v1" &&
    saved.receiptAuthority === "runtime" && saved.runId === input.runId && saved.code === "agent_runtime_failed" &&
    saved.runtimeError === terminalError && (saved.runtimeEventId == null || saved.runtimeEventId === terminal?.id));
  const knownTerminal = Boolean(terminal && knownMessage && Number.isFinite(terminalTime) && terminalTime >= cutoff && savedGenericMatches);
  const generic: WorkshopRuntimeFailure = { version: "workshop-runtime-failure/v1", receiptAuthority: "runtime",
    runId: input.runId, code: "agent_runtime_failed", runtimeError,
    message: knownTerminal ? knownMessage! : runtimeError.slice(0, 2000), issues: [],
    ...(knownTerminal ? { runtimeEventId: terminal!.id } : {}) };
  // A callback rejection alone does not prove the runtime exhausted corrections.
  if (runtimeError !== CORRECTION_LIMIT || !terminal) return generic;
  const lastValidation = [...events].reverse().find(event => host(event) &&
    ["research_final_validation_rejected", "research_final_validation_passed"].includes(event.type));
  if (!lastValidation || lastValidation.type !== "research_final_validation_rejected" || order(lastValidation, terminal) > 0 ||
    !sameExecution(lastValidation, terminal, input.runId)) return generic;
  const metadata = record(lastValidation.metadata);
  if (!Number.isSafeInteger(metadata.attempt) || metadata.attempt !== metadata.maxCorrections ||
    (metadata.attempt as number) < 0 || (metadata.attempt as number) > 2 || metadata.status !== "correction_required") return generic;
  const validationTime = timestamp(lastValidation.createdAt);
  if (Number.isFinite(cutoff) && (!Number.isFinite(validationTime) || validationTime < cutoff) ||
    Number.isFinite(validationTime) && Number.isFinite(terminalTime) && validationTime > terminalTime) return generic;
  // A saved interpretation must reference the observed host event, rather than
  // introduce an alternate issue list or a previous run's rejection.
  if (Object.keys(saved).length && (saved.version !== "workshop-runtime-failure/v1" || saved.receiptAuthority !== "runtime" ||
    saved.runId !== input.runId || saved.validationEventId !== lastValidation.id)) return generic;
  const allIssues = rejectionIssues(metadata);
  if (!allIssues.length) return generic;
  const issues = allIssues.slice(0, MAX_ISSUES).map(issue => issue.length > 1000
    ? `${issue.slice(0, 1000)}（原因过长，已截断；详见原始校验记录）` : issue);
  const omittedIssueCount = Math.max(0, allIssues.length - issues.length);
  const detail = issues.slice(0, 2).join("；");
  return { ...generic, code: "research_final_validation_rejected", validationEventId: lastValidation.id,
    attempt: metadata.attempt as number, issues, ...(omittedIssueCount ? { omittedIssueCount } : {}),
    message: `研究报告校验未通过，纠正次数已用尽：${detail}${issues.length > 2 ? `；另有 ${issues.length - 2} 项，见完整失败记录` : ""}` };
}

const markdownText = (value: string) => value.replace(/[\\`*_{}\[\]()#+.!|<>]/gu, character => `\\${character}`);

export function buildWorkshopRuntimeFailurePresentation(failure: WorkshopRuntimeFailure) {
  const title = failure.code === "research_final_validation_rejected" ? "研究报告未通过核验" : "智能体运行未完成";
  const knownMessage = failure.runtimeEventId ? knownWorkshopRuntimeFailureMessage(failure.runtimeError) : null;
  const summary = knownMessage ?? failure.message;
  const issues = failure.issues.length ? failure.issues : [knownMessage ?? failure.runtimeError];
  const detail = failure.code === "research_final_validation_rejected"
    ? "原始候选与来源回执已保存；未把未通过的候选当作最终报告，也未自动另开任务。"
    : "已发生的读取与模型过程请核对本轮工作记录；尚未形成通过核验的报告，也未自动另开任务。";
  return { source: "host_runtime_failure", schemaVersion: 1, title, summary,
    reportMarkdown: `# ${title}\n\n${markdownText(summary)}\n\n## 未通过原因\n\n${issues.map(issue => `- ${markdownText(issue)}`).join("\n")}${failure.omittedIssueCount ? `\n- 另有 ${failure.omittedIssueCount} 项未在此处展开，请查看本轮宿主校验记录。` : ""}\n\n本轮保留失败状态。${detail}`,
    evidenceEventIds: failure.validationEventId ? [failure.validationEventId] : failure.runtimeEventId ? [failure.runtimeEventId] : [],
    warnings: issues,
    nextSteps: ["依据本轮具体校验原因纠正报告，再明确发起重试。"],
  };
}
