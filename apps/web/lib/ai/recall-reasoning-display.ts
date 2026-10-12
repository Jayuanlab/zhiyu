/** Presentation only: never modifies the persisted routing event or its decision. */
export function describeRecallReasoning(text: string, language: string): string | null {
  if (!text.trimStart().startsWith("{")) return null;
  let event: any;
  try { event = JSON.parse(text); } catch { return null; }
  const zh = language.startsWith("zh");
  if (event?.stage === "platform_capability_context") return event.status === "degraded"
    ? zh ? "本轮上下文读取不完整，继续通过常规工具确认对象。" : "Context is incomplete. Continuing with normal tools to identify the target." : null;
  if (event?.stage === "platform_capability_routing") {
    if (event.status === "disabled") return zh ? "能力匹配已关闭，继续使用常规工具。" : "Capability matching is disabled. Normal tools remain available.";
    if (event.status === "degraded") return zh ? "能力匹配暂不可用，继续使用常规工具。" : "Capability matching is unavailable. Continuing with normal tools.";
    if (event.status === "unresolved") return zh ? "尚未确定合适的接口，继续根据对话选择工具。" : "No definite interface match. Continuing with the conversation and normal tools.";
    if (event.status === "ok" && Array.isArray(event.capabilityIds) && event.capabilityIds.length) return zh
      ? "已匹配当前可用的接口；实际操作与结果以工具执行回执为准。" : "Matched currently available interfaces. Actions and results require actual tool receipts.";
    return null;
  }
  if (!["jev_replaces_initial_recall_decision", "platform_recall_prefetch"].includes(event?.stage)) return null;
  if (event.applicationRoute?.source === "records" && event.applicationRoute?.reason === "change_history_requires_event_read")
    return zh ? "Jev 的来源判断未选中平台记录；应用规则补充读取车间变更事件。具体事实以工具结果为准。"
      : "Jev did not select platform records; an application rule reads workshop change events. Facts require tool evidence.";
  if (event.status === "degraded") {
    if (event.detail === "uncertain_route") return zh
      ? "资料来源判断不确定，继续通过常规工具检索。"
      : "Source selection is uncertain. Continuing with normal retrieval tools.";
    if (event.detail === "aborted") return zh ? "资料来源判断已取消。" : "Source selection was cancelled.";
    return zh ? "资料来源判断暂不可用，继续通过常规工具检索。"
      : "Source selection is unavailable. Continuing with normal retrieval tools.";
  }
  if (event.status !== "ok" || !Array.isArray(event.sources)) return null;
  const labels: Record<string, string> = zh
    ? { architecture: "项目架构", records: "平台运行记录", knowledge: "知识库文档", brain: "个人记忆" }
    : { architecture: "project architecture", records: "platform records", knowledge: "knowledge documents", brain: "personal memories" };
  if (event.sources.some((source: unknown) => typeof source !== "string" || !Object.hasOwn(labels, source))) return null;
  if (!event.sources.length) return zh ? "未识别出需要预先检索的资料来源。" : "No source requiring initial retrieval was identified.";
  const sources = event.sources.map((source: string) => labels[source]).join(zh ? "、" : ", ");
  return zh ? `判断需要查阅：${sources}。具体事实以工具读取结果为准。`
    : `Sources to consult: ${sources}. Facts still require tool evidence.`;
}
