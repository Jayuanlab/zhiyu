/** Presentation only: never modifies the persisted routing event or its decision. */
export function describeRecallReasoning(text: string, language: string): string | null {
  if (!text.trimStart().startsWith("{")) return null;
  let event: any;
  try { event = JSON.parse(text); } catch { return null; }
  if (event?.stage !== "jev_replaces_initial_recall_decision") return null;
  const zh = language.startsWith("zh");
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
