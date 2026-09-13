/** A submitted command is an execution request, never evidence of a result. */
type ConclusionEvent = {
  type: string;
  title: string;
  createdAt: Date | string;
  metadata?: Record<string, unknown> | null;
};

export function latestWorkshopConclusion<T extends ConclusionEvent>(
  events: readonly (T | null | undefined)[],
): T | null {
  let latest: T | null = null;
  for (const event of events) {
    if (!event || !Number.isFinite(new Date(event.createdAt).getTime())) continue;
    if (event.type !== "loop_run_completed" && event.type !== "decision" &&
      !(event.type === "agent_text" && event.metadata?.final === true)) continue;
    if (event.title.toLowerCase().includes("partial") ||
      event.title.includes("报告质量") || event.title.includes("配置改进提案")) continue;
    if (!latest || new Date(event.createdAt).getTime() > new Date(latest.createdAt).getTime()) latest = event;
  }
  return latest;
}
