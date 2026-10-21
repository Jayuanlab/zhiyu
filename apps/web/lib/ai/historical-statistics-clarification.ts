import { inferEvidenceTimePolicy } from "../memory/retrieval/evidence-time";

/** A first-turn aggregate request cannot identify a snapshot by saying "the snapshot". */
export function historicalStatisticsClarification(input: {
  prompt: string;
  sessionId?: string;
  conversation?: Array<{ role: string; content: string }>;
  images?: unknown[]; fileAttachments?: unknown[]; ragDocuments?: unknown[];
  workspaceFileRefs?: unknown[]; focusedInsightIds?: unknown[]; focusedInsights?: unknown[];
}): string | null {
  if (input.sessionId || input.conversation?.some(turn => turn.role !== "user" || turn.content.trim() !== input.prompt.trim())) return null;
  if ([input.images, input.fileAttachments, input.ragDocuments, input.workspaceFileRefs, input.focusedInsightIds, input.focusedInsights].some(items => items?.length)) return null;
  if (inferEvidenceTimePolicy(input.prompt).mode !== "unresolved") return null;
  if (!/截至.*快照|历史快照/u.test(input.prompt) || !/多少|数量|分布|统计|有记录|有多少/u.test(input.prompt)) return null;
  // A supplied date, version identifier or explicit record may be resolved by a reader.
  if (/\d{4}-\d{2}-\d{2}|[a-f0-9]{8}-[a-f0-9-]{27,}|快照(?:编号|版本|ID|id)\s*[:：]/u.test(input.prompt)) return null;
  return "需要先明确您指的是哪一份历史快照。请提供快照时间（含时区）、编号或快照文件，再核对对应统计。当前问题没有可定位的快照信息；我尚未读取或统计记录，也不能用当前列表代替历史数据。如果您要查询当前统计，请明确说明。";
}
