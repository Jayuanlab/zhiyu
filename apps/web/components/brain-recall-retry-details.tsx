import React from "react";

const CATEGORY_LABELS: Record<string, string> = { platform: '平台操作', tools: '工具回执', user: '用户与关系', task: '任务状态', knowledge: '知识与规则', experience: '经验反馈' };
const INFORMATION_LABELS: Record<string, string> = { present: '已找到可读证据', unverified: '来源待核验', stale: '需要刷新', conflict: '存在冲突', missing: '未召回', denied: '无权读取', unavailable: '数据源不可用' };

function InformationNeedsDetails({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null;
  const readiness = value as Record<string, unknown>;
  if (readiness.version !== 'information-readiness.v1' || !Array.isArray(readiness.needs)) return null;
  return <div className="mt-2 space-y-1">
    <p>所需信息清单（证据可用不代表答案已经充分，也不代表动作获批）</p>
    <ul className="list-disc pl-4">{readiness.needs.slice(0, 24).map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const need = raw as Record<string, unknown>;
      if (typeof need.category !== 'string' || typeof need.status !== 'string') return null;
      return <li key={index}>
        {CATEGORY_LABELS[need.category] ?? '其他信息'}：{INFORMATION_LABELS[need.status] ?? '状态未知'}
        {need.required === true ? '（本任务相关）' : '（按需）'}
        {typeof need.question === 'string' ? <span className="block">{need.question}</span> : null}
      </li>;
    })}</ul>
  </div>;
}

const STOP_LABELS: Record<string, string> = {
  results_available: "已有检索结果，停止补查",
  source_unavailable: "数据源异常，停止补查",
  access_denied: "存在权限拒绝，停止补查",
  candidates_filtered: "候选被规则过滤，停止补查",
  context_warning: "上下文存在警告，停止补查",
  no_alternative: "没有可用的替代表达",
  unchanged_terms: "关键词未变化，不重复检索",
  disabled: "本次未启用内部补查",
  empty_after_retry: "补查后仍无匹配，需要进一步澄清",
  retry_failed: "补查失败，保留首次结果",
  coverage_retry_complete: "证据覆盖不足，已补查并合并结果",
  coverage_retry_degraded: "补查数据源不完整，已保留可用证据",
};

export function BrainRecallRetryDetails({ trace }: { trace: unknown }) {
  if (!trace || typeof trace !== "object") return null;
  const value = trace as Record<string, unknown>;
  const check = value.evidenceCheck && typeof value.evidenceCheck === "object"
    ? value.evidenceCheck as Record<string, unknown> : undefined;
  if (typeof value.originalQuery !== "string" || typeof value.stopReason !== "string") return null;
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">检索补查：{STOP_LABELS[value.stopReason] ?? "未知状态"}（{value.attempts === 2 ? 2 : 1} 轮）</summary>
      <div className="mt-2 space-y-1 whitespace-pre-wrap break-words">
        <p>原问题：{value.originalQuery}</p>
        {typeof value.rewrittenQuery === "string" ? <p>补查表达：{value.rewrittenQuery}</p> : null}
        {typeof value.reason === "string" ? <p>改写原因：{value.reason}</p> : null}
        <InformationNeedsDetails value={value.informationReadiness} />
        {check && check.status !== "disabled" ? <p>
          证据检查：{check.mode === "shadow" ? "旁路观察，不影响回答" : "辅助判断"}
          {check.status === "degraded" ? "；检查不可用，保留原检索流程" : "；检查完成"}
          {typeof check.detail === "string" ? `（${check.detail}）` : ""}
          {check.truncated === true ? "；仅检查部分证据" : ""}
        </p> : null}
      </div>
    </details>
  );
}
