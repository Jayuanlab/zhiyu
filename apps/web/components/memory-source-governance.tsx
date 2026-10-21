"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import useSWR from "swr";

type Source = { kind: string; semantics: string; owner: string; work: string; version: string; receipt: string; dispatch: string };
type Receipt = { id: string; createdAt: string; stage: "source_read" | "dispatch_admitted"; requesterType: string;
  sequence: number | null; refs: Array<{ kind: string; id: string; source: string | null; revision: string }> };
type Coverage = { schemaVersion: string; complete: false; sources: Source[]; gaps: Array<{ kind: string; code: string; recovery: string }>;
  status: "observed" | "unobserved"; receipts: Receipt[]; sample: { returnedCount: number; hasMore: boolean }; warning: string };
type ReadBody = { source: string; id: string; offset?: number; expectedHash?: string; expectedRevision?: string };
type Evidence = { source: string; id: string; revision: string; receiptId: string; content: string; contentHash: string;
  semantics: string; actualRange: { unit: string; start: number; end: number }; totalCharacters: number; nextOffset: number | null };
const names: Record<string, string> = {
  workshops: "工作配置", loops: "连续任务配置", loopStates: "连续任务状态", loopRuns: "连续任务运行", loopApprovalRequests: "任务审批",
  workshopRuns: "工作运行", workshopEvents: "工作原始事件", workshopSources: "工作资料配置", workshopDirectives: "工作指令", workshopReviewItems: "工作审核项",
  workshopOutbox: "待发消息", workshopWorkVersions: "工作配置版本", workshopRuntimeSnapshots: "运行快照", workshopHeartbeats: "运行心跳",
  brainMemories: "正式记忆与候选", brainContextLogs: "上下文回执", brainStateSnapshots: "保存的状态快照", brainObservations: "原始观测", brainAccessGrants: "记忆授权",
  interactionEvents: "原始交互事件", interactionThreads: "交互会话", interactionTasks: "交互任务", interactionNotes: "交互理解", interactionMemories: "交互记忆",
  memoryGraphRelations: "关系理解", memoryGraphEntities: "关系实体", memoryGraphEvidence: "关系证据", workRunEvidenceBundles: "运行证据包", workRunDiagnostics: "运行诊断",
  chat: "历史对话", message: "历史消息", quantTradePlans: "模拟交易计划", workshopMemories: "工作内记忆", "rag-document": "知识库文档", "rag-document-metadata": "知识库目录",
};
const semantics: Record<string, string> = { stored_observation: "已存观测", read_time_observation: "读取时状态", stored_control: "已存控制配置", derived_content: "派生理解" };
const gaps: Record<string, string> = { local_workspace: "未登记本地路径", legacy_cloud_file: "旧公开文件地址", paper_ledger_remote: "远端模拟账本", external_tool: "外部工具观测",
  local_shell: "未隔离本地命令", unconfined_shell: "未隔离本地命令", unisolated_shell: "未隔离本地命令", focused_insight: "未绑定的缓存资料", cached_insight_or_rendered_work_history: "未绑定的缓存资料" };
const style = "rounded border px-3 py-1.5 text-sm disabled:opacity-50";
async function load(url: string) { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error("来源覆盖暂不可用，请重试。"); return response.json(); }
export function MemorySourceGovernance({ ownerId }: { ownerId: string | null }) {
  return <OwnerSourceGovernance key={ownerId ?? "signed-out"} ownerId={ownerId} />;
}
function OwnerSourceGovernance({ ownerId }: { ownerId: string | null }) {
  const { data, error, mutate } = useSWR<Coverage>(ownerId ? ["/api/memory/sources", ownerId] : null, ([url]: [string, string]) => load(url), { revalidateOnFocus: false });
  const [source, setSource] = useState("workshopEvents"), [id, setId] = useState(""), [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
  const [evidence, setEvidence] = useState<Evidence | null>(null), [content, setContent] = useState(""), [explanation, setExplanation] = useState<unknown>(null);
  const [retry, setRetry] = useState<ReadBody | null>(null), active = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => () => { generation.current++; active.current?.abort(); }, []);
  function reset() { active.current?.abort(); generation.current++; setEvidence(null); setContent(""); setExplanation(null); setFailure(""); setRetry(null); setBusy(false); }
  async function read(body: ReadBody) {
    active.current?.abort(); const controller = new AbortController(), attempt = ++generation.current; active.current = controller;
    setBusy(true); setFailure(""); setRetry(body); setExplanation(null);
    let canRetry = true;
    try {
      const response = await fetch("/api/memory/sources/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const result = await response.json(); if (generation.current !== attempt) return;
      if (!response.ok) {
        if (response.status === 409) { canRetry = false; throw new Error("来源版本或权限依据已变化，旧窗口已清除；请重新读取。"); }
        throw new Error(`来源尚未读取（${result.code ?? "memory_source_unavailable"}），没有把它标记为可用。`);
      }
      if (result.status !== "read" || typeof result.content !== "string" || !result.receiptId || typeof result.revision !== "string") throw new Error("未取得可信读取回执。");
      setEvidence(result); setContent(previous => body.offset ? previous + result.content : result.content); setRetry(null); await mutate();
    } catch (error) {
      if (!controller.signal.aborted && generation.current === attempt) {
        setEvidence(null); setContent(""); setExplanation(null);
        setRetry(canRetry ? { source: body.source, id: body.id } : null);
        setFailure(error instanceof Error ? error.message : "来源读取未完成。");
      }
    } finally { if (generation.current === attempt) setBusy(false); }
  }
  async function explain() {
    if (!evidence) return; const attempt = generation.current, controller = new AbortController(); active.current?.abort(); active.current = controller; setBusy(true);
    try {
      const response = await fetch(`/api/memory/receipts/${evidence.receiptId}`, { cache: "no-store", signal: controller.signal }), result = await response.json();
      if (generation.current !== attempt) return;
      if (!response.ok || result.status !== "ok") throw new Error("历史读取回执暂不可用。"); setExplanation(result);
    } catch (error) { if (!controller.signal.aborted && generation.current === attempt) setFailure(error instanceof Error ? error.message : "读取回执暂不可用。"); }
    finally { if (generation.current === attempt) setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setContent(""); setEvidence(null); void read({ source, id: id.trim() }); }
  return <section aria-label="来源覆盖与精确读取" className="grid min-w-0 gap-4 rounded-lg border bg-card p-4">
    <div><h2 className="font-semibold">来源覆盖与精确读取</h2><p className="text-sm text-muted-foreground">先核对真实记录，再登记本次读取；模型每次出站前重新检查版本与权限。</p></div>
    <div className="flex flex-wrap gap-2"><button type="button" className={style} disabled={!ownerId || busy} onClick={() => void mutate()}>刷新来源覆盖</button><a className={style} href="/memory/backfill">治理历史记忆</a></div>
    {error ? <p role="alert" className="text-sm text-destructive">来源覆盖暂不可用，请刷新重试；没有视为健康。</p> : null}
    {data ? <>
      <p className="text-sm text-muted-foreground">已列 {data.sources.length} 类登记入口；目录是有界能力范围，不是私有数据的全量盘点。</p>
      <details className="min-w-0"><summary className="cursor-pointer text-sm">查看登记入口与工作权限</summary><div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
        {data.sources.map(item => <article key={item.kind} className="min-w-0 rounded border p-2 text-xs"><p className="font-medium">{names[item.kind] ?? item.kind}</p>
          <p>{semantics[item.semantics] ?? item.semantics} · 主人精确读取</p><p>{item.work === "unavailable" ? "Work 无对应授权时不可读取" : "Work 须匹配当前配置、范围与来源授权"}</p></article>)}
      </div></details>
      <div className="grid min-w-0 gap-2" aria-label="来源缺口与恢复"><h3 className="text-sm font-medium">来源缺口与恢复</h3>{data.gaps.map(item => <p key={item.kind} className="break-words text-xs text-muted-foreground">
        {gaps[item.kind] ?? item.kind}：{item.code === "external_observation_at_t0" ? "只表达当时观测，当前状态须由原领域控制器读取。" : "没有可核验绑定，不向模型提供正文；主人可导入受管私有文件，Work 仍需单独的正式来源授权。"}
      </p>)}<a className="w-fit text-sm underline" href="#memory-private-files">前往私有文件导入</a></div>
      <form onSubmit={submit} className="grid min-w-0 gap-2">
        <label className="grid gap-1 text-sm">来源类型<select aria-label="精确来源类型" className="min-w-0 rounded border bg-background p-2" value={source} disabled={busy} onChange={event => { reset(); setSource(event.target.value); }}>
          {data.sources.map(item => <option key={item.kind} value={item.kind}>{names[item.kind] ?? item.kind}</option>)}
        </select></label>
        <label className="grid gap-1 text-sm">记录 ID<input aria-label="来源记录 ID" className="min-w-0 rounded border bg-background p-2" value={id} disabled={busy} onChange={event => { reset(); setId(event.target.value); }} placeholder="输入该领域记录的 UUID" required /></label>
        <button type="submit" className={style + " w-fit"} disabled={busy || !ownerId || !id.trim()}>读取登记来源</button>
      </form>
      {busy ? <p role="status" className="text-sm text-muted-foreground">正在核对来源和必要回执…</p> : null}
      {failure ? <p role="alert" className="text-sm text-destructive">{failure}</p> : null}
      {retry ? <button type="button" className={style + " w-fit"} disabled={busy} onClick={() => void read(retry)}>重试来源窗口</button> : null}
      {evidence ? <article aria-label="登记来源原文" className="grid min-w-0 gap-2 rounded border p-3 text-sm">
        <p>{semantics[evidence.semantics] ?? evidence.semantics} · 实际已读至 {evidence.actualRange.end} / {evidence.totalCharacters}（UTF-16 位置）</p>
        <pre aria-label="来源原文窗口" className="min-w-0 whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{content}</pre>
        <div className="flex flex-wrap gap-2">{evidence.nextOffset !== null && content.length < 32000 ? <button type="button" className={style} disabled={busy} onClick={() => void read({ source: evidence.source, id: evidence.id, offset: evidence.nextOffset!, expectedHash: evidence.contentHash, expectedRevision: evidence.revision })}>读取下一来源窗口</button> : null}
          <button type="button" className={style} disabled={busy} onClick={() => void explain()}>解释来源读取回执</button></div>
        {content.length >= 32000 ? <p className="text-xs text-muted-foreground">本页展示达到上限；完整原文请使用所属领域页面。</p> : null}
        <details><summary className="cursor-pointer text-xs">来源版本与读取回执</summary><pre className="min-w-0 whitespace-pre-wrap break-all text-xs">{JSON.stringify({ source: evidence.source, id: evidence.id, revision: evidence.revision, contentHash: evidence.contentHash, receiptId: evidence.receiptId, actualRange: evidence.actualRange }, null, 2)}</pre></details>
        {explanation ? <pre aria-label="来源回执说明" className="min-w-0 whitespace-pre-wrap break-all text-xs">{JSON.stringify(explanation, null, 2)}</pre> : null}
      </article> : null}
      <section aria-label="最近来源回执" className="grid min-w-0 gap-2 border-t pt-3"><h3 className="text-sm font-medium">最近来源回执</h3>
        {data.status === "unobserved" ? <p className="text-xs text-muted-foreground">尚未观察到来源读取或出站准入回执，不能判断已覆盖或执行成功。</p> : null}
        {data.receipts.map(receipt => <details key={receipt.id} className="min-w-0 text-xs"><summary className="cursor-pointer">{receipt.stage === "source_read" ? "来源已读取" : "模型出站已准入"} · {new Date(receipt.createdAt).toLocaleString()}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(receipt, null, 2)}</pre></details>)}
        <p className="text-xs text-muted-foreground">{data.warning}{data.sample.hasMore ? " 当前仅显示最近样本。" : ""}历史回执不代表当前仍有权限。</p>
      </section>
    </> : ownerId && !error ? <p className="text-sm text-muted-foreground">正在读取来源能力与回执样本…</p> : null}
  </section>;
}
