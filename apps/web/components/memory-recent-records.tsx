"use client";

import useSWR from "swr";
import { MemoryRevisionControl } from "@/components/memory-revision-dialog";
import { MemoryUseDetails } from "@/components/memory-use-details";

type RecordItem = { id: string; subject: string; content: string; status: string; updatedAt: string; expiresAt?: string; metadata?: Record<string, unknown> };
export const RECENT_MEMORY_ENDPOINT = "/api/memory/memories?limit=8&statuses=active,verified,weakened";
const endpoint = RECENT_MEMORY_ENDPOINT;
const statuses: Record<string, string> = { active: "已保存", verified: "已审核", weakened: "已弱化" };
function due(item: RecordItem) { const deadline = item.expiresAt ?? (item.metadata?.recordLifecycle as { reviewBy?: string } | undefined)?.reviewBy; return Boolean(deadline && Date.parse(deadline) <= Date.now()); }
async function load() {
  const response = await fetch(endpoint, { cache: "no-store" });
  if (!response.ok) throw new Error("最近记忆读取失败，请重试；没有将读取失败当作空列表。");
  const body = await response.json();
  if (!Array.isArray(body.memories) || body.memories.length > 8 || body.memories.some((item: RecordItem) => !item || typeof item.id !== "string" || typeof item.subject !== "string" || typeof item.content !== "string" || !statuses[item.status] || !Number.isFinite(Date.parse(item.updatedAt)))) throw new Error("最近记忆信息不完整，请重新读取。");
  return body.memories as RecordItem[];
}

export function MemoryRecentRecords({ ownerId, onSaved }: { ownerId: string | null; onSaved?: () => void | Promise<void> }) {
  return ownerId ? <OwnerRecords key={ownerId} ownerId={ownerId} onSaved={onSaved} /> : null;
}
function OwnerRecords({ ownerId, onSaved }: { ownerId: string; onSaved?: () => void | Promise<void> }) {
  const { data, error, isLoading, mutate } = useSWR([endpoint, ownerId], load, { revalidateOnFocus: false, shouldRetryOnError: false });
  return <section aria-label="最近更新的记忆" className="min-w-0 rounded-lg border bg-card p-5">
    <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">最近更新的记忆</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">最多展示 8 条长期记忆。保存与审核不代表当前任务适用，使用前仍需核对。检查点和验收记录在“来源与使用记录”中查看。</p></div>
      <button type="button" disabled={isLoading} onClick={() => void mutate()} className="shrink-0 rounded border px-2.5 py-1.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">刷新记忆</button></div>
    {isLoading ? <p role="status" className="mt-4 text-sm text-muted-foreground">正在读取最近记忆…</p> : null}
    {error ? <p role="alert" className="mt-4 text-sm text-destructive">{error instanceof Error ? error.message : "最近记忆暂不可用，请重试。"}</p> : null}
    {!error && data?.length === 0 ? <p className="mt-4 text-sm leading-6 text-muted-foreground">这里还没有可展示的已保存记忆。可以先整理消息与知识，或切换来源查找历史资料。</p> : null}
    {!error ? data?.map(item => <details key={item.id} className="group min-w-0 border-t py-3 first-of-type:mt-4">
      <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="text-sm font-medium">{item.subject}</span><span className="ml-2 text-xs text-muted-foreground">{due(item) ? "已到期" : statuses[item.status]} · 更新于 {new Date(item.updatedAt).toLocaleDateString("zh-CN")}</span><span className="mt-1 block line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{item.content.slice(0, 160)}</span></summary>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{item.content}</p>
      <MemoryUseDetails applicability={item.metadata?.scenarioApplicability} useSemantics={item.metadata?.useSemantics} status={item.status} />
      <div className="mt-3"><MemoryRevisionControl memoryId={item.id} onSaved={async () => { await mutate(); await onSaved?.(); }} /></div>
    </details>) : null}
  </section>;
}
