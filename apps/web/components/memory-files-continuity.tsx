"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { ArtifactManifest, ArtifactRef } from "@/lib/memory/artifacts/contracts";

type ManagedManifest = ArtifactManifest & { cleanupRecovery?: { commandId: string; expectedRevision: number } };
type Item = { manifest: ManagedManifest; ref: ArtifactRef; receipt: { id: string } };
type Files = { items: Item[]; nextCursor: string | null; coverage: { complete: false } };
type ContinuityReceipt = { id: string; type: string; createdAt: string; stage: "saved" | "prepared-for-request" | "usage-observed";
  status: string; reason: string | null; runId: string | null; sourceRunId: string | null; loopId: string | null; runtimeBinding: unknown };
type Continuity = { status: "select_work" | "observed" | "unobserved"; works?: Array<{ id: string; name: string }>;
  receipts?: ContinuityReceipt[]; warnings?: string[] };
const states: Record<string, string> = { pending: "等待上传或核验", sealed: "已封存，待激活", active: "可读取", deleting: "清理未完成", deleted: "已清理" };
const stages = { saved: "状态已保存", "prepared-for-request": "已准备模型请求", "usage-observed": "已观察到模型用量" };
const button = "rounded-md border px-3 py-1.5 text-sm disabled:opacity-50";
async function loadJson(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("读取暂不可用，请刷新后重试。");
  return response.json();
}

export function MemoryFilesContinuity({ ownerId }: { ownerId: string | null }) {
  return <OwnerMemoryFilesContinuity key={ownerId ?? "signed-out"} ownerId={ownerId} />;
}

function OwnerMemoryFilesContinuity({ ownerId }: { ownerId: string | null }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1];
  const fileUrl = "/api/memory/artifacts?limit=20" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const { data, error, isLoading, mutate } = useSWR<Files>(ownerId ? [fileUrl, ownerId] : null,
    ([url]: [string, string]) => loadJson(url), { revalidateOnFocus: false });
  const { data: works, error: worksError, isLoading: worksLoading, mutate: refreshWorks } = useSWR<Continuity>(ownerId ? ["/api/memory/continuity", ownerId] : null,
    ([url]: [string, string]) => loadJson(url), { revalidateOnFocus: false });
  const [workId, setWorkId] = useState("");
  const { data: continuity, error: continuityError, isLoading: continuityLoading, mutate: refreshContinuity } = useSWR<Continuity>(ownerId && workId ? ["/api/memory/continuity?workshopId=" + encodeURIComponent(workId), ownerId] : null,
    ([url]: [string, string]) => loadJson(url), { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [failure, setFailure] = useState("");
  const [pending, setPending] = useState<{ file: File; commandId: string; target?: ManagedManifest } | null>(null);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const picker = useRef<HTMLInputElement>(null), resume = useRef<ManagedManifest | undefined>(undefined);
  const generation = useRef(0), requests = useRef(new Set<AbortController>()), commands = useRef(new Map<string, string>());
  useEffect(() => {
    generation.current++; for (const controller of requests.current) controller.abort(); requests.current.clear(); commands.current.clear(); resume.current = undefined;
    setWorkId(""); setPending(null); setEvidence({}); setNotice(""); setFailure(""); setBusy(false);
    return () => { generation.current++; for (const controller of requests.current) controller.abort(); requests.current.clear(); };
  }, [ownerId]);

  async function upload(request: { file: File; commandId: string; target?: ManagedManifest }) {
    const attempt = generation.current, controller = new AbortController(); requests.current.add(controller);
    setPending(request); setBusy(true); setFailure(""); setNotice("正在保存私有文件并核对清单…");
    try {
      const body = new FormData(); body.append("file", request.file); body.append("commandId", request.commandId); body.append("createRecord", "true");
      if (request.target) { body.append("artifactId", request.target.id); body.append("expectedRevision", String(request.target.revision)); }
      const response = await fetch("/api/files/upload", { method: "POST", body, signal: controller.signal });
      const result = await response.json();
      if (generation.current !== attempt) return;
      if (!response.ok) throw new Error(`文件尚未保存完成（${result.code ?? "artifact_upload_unavailable"}），可重试原上传或处理下方清单。`);
      setPending(null); setNotice("私有文件已激活，可按固定版本读取；资料索引尚未请求。"); await mutate();
    } catch (error) {
      if (!controller.signal.aborted && generation.current === attempt) { setNotice(""); setFailure(error instanceof Error ? error.message : "上传尚未完成，请重试原上传。"); await mutate(); }
    } finally { requests.current.delete(controller); if (generation.current === attempt) setBusy(false); }
  }
  async function command(item: Item, kind: "artifact.activate" | "artifact.cleanup") {
    if (kind === "artifact.cleanup" && !window.confirm(`确认清理“${item.manifest.name}”？已保存文件也会移除；历史操作回执保留。`)) return;
    const attempt = generation.current, controller = new AbortController(), key = `${kind}:${item.manifest.id}:${item.manifest.revision}`;
    requests.current.add(controller);
    const recovery = kind === "artifact.cleanup" ? item.manifest.cleanupRecovery : undefined;
    const commandId = recovery?.commandId ?? commands.current.get(key) ?? crypto.randomUUID(); commands.current.set(key, commandId);
    setBusy(true); setFailure("");
    try {
      const response = await fetch("/api/memory/commands", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ kind, commandId, artifactId: item.manifest.id, expectedRevision: recovery?.expectedRevision ?? item.manifest.revision,
          ...(kind === "artifact.activate" ? { saveRecord: true } : {}) }) });
      const result = await response.json(); if (generation.current !== attempt) return;
      if (!response.ok) throw new Error(`文件操作未完成（${result.code ?? "artifact_command_unavailable"}），清单保留可恢复状态。`);
      setNotice(kind === "artifact.cleanup" ? "文件已清理，空间已释放。" : "文件已激活并保存。");
    } catch (error) { if (!controller.signal.aborted && generation.current === attempt) setFailure(error instanceof Error ? error.message : "文件操作未完成。"); }
    finally { requests.current.delete(controller); if (generation.current === attempt) { await mutate(); if (generation.current === attempt) setBusy(false); } }
  }
  async function read(item: Item) {
    const attempt = generation.current, controller = new AbortController(); requests.current.add(controller);
    setEvidence(previous => ({ ...previous, [item.manifest.id]: "正在核对固定版本与原文摘要…" }));
    try {
      const response = await fetch("/api/memory/read", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ purpose: "evidence", ref: item.ref, range: { start: 0, end: Math.min(item.manifest.sizeBytes, 4096) } }) });
      const result = await response.json(); if (generation.current !== attempt) return;
      if (!response.ok || result.status !== "ok" || result.encoding !== "base64") throw new Error("固定版本暂不可读，未把文件标记为已核验。");
      const bytes = Uint8Array.from(atob(result.content), character => character.charCodeAt(0));
      let preview = "此文件按二进制窗口读取，不转换为事实结论。";
      if (item.manifest.contentType.startsWith("text/") || item.manifest.contentType === "application/json") {
        try { preview = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { preview = "已读窗口跨越文本编码边界，请下载完整文件查看。"; }
      }
      setEvidence(previous => ({ ...previous, [item.manifest.id]: `${preview}\n\n实际已读：${result.receipt.actualRange.start}–${result.receipt.actualRange.end} / ${result.receipt.totalLength} 字节\n读取回执：${result.receipt.id}` }));
    } catch (error) { if (!controller.signal.aborted && generation.current === attempt) setEvidence(previous => ({ ...previous,
      [item.manifest.id]: error instanceof Error ? error.message : "原文暂不可读。" })); }
    finally { requests.current.delete(controller); }
  }

  return <section aria-label="文件与连续性" className="grid min-w-0 gap-4 rounded-lg border bg-card p-4">
    <div><h2 className="font-semibold">文件与连续性</h2><p className="text-sm text-muted-foreground">查看私有文件的真实状态和运行接续回执。保存、准备模型输入与观察到模型用量分别记录。</p></div>
    <section aria-label="已登记文件" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!ownerId || busy} onClick={() => { resume.current = undefined; picker.current?.click(); }}>上传私有文件</button>
        <button type="button" className={button} disabled={!ownerId || busy} onClick={() => void mutate()}>刷新文件清单</button></div>
      <input ref={picker} aria-label="选择私有文件" type="file" className="hidden" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (file) void upload({ file, commandId: crypto.randomUUID(), target: resume.current }); resume.current = undefined;
      }} />
      {notice ? <p role="status" aria-label="私有文件操作状态" className="text-sm text-muted-foreground">{notice}</p> : null}
      {failure || error ? <p role="alert" className="text-sm text-destructive">{failure || "文件清单暂不可用，可刷新后重试。"}</p> : null}
      {pending ? <button type="button" disabled={busy} className={button + " w-fit"} onClick={() => void upload(pending)}>重试原上传</button> : null}
      {isLoading ? <p className="text-sm text-muted-foreground">正在读取文件清单…</p> : null}
      {data?.items.map(item => <article aria-label={item.manifest.name} key={item.manifest.id} className="grid min-w-0 gap-2 rounded border p-3 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="break-all font-medium">{item.manifest.name}</h3><span>{states[item.manifest.state]}</span></div>
        <p className="text-xs text-muted-foreground">{item.manifest.sizeBytes} 字节 · {item.manifest.userFileId ? "已保存文件" : "附件或未完成上传"} · {item.manifest.cleanupAttempts ? `已尝试清理 ${item.manifest.cleanupAttempts} 次` : "尚未清理"}</p>
        <div className="flex flex-wrap gap-2">
          {item.manifest.state === "active" ? <><button type="button" className={button} onClick={() => void read(item)}>读取固定窗口</button><a className={button} href={item.manifest.url}>下载文件</a></> : null}
          {item.manifest.state === "pending" ? <button type="button" className={button} disabled={busy} onClick={() => { resume.current = item.manifest; picker.current?.click(); }}>继续上传同一文件</button> : null}
          {item.manifest.state === "sealed" ? <button type="button" className={button} disabled={busy} onClick={() => void command(item, "artifact.activate")}>继续激活</button> : null}
          {item.manifest.state !== "deleted" ? <button type="button" className={button} disabled={busy} onClick={() => void command(item, "artifact.cleanup")}>{item.manifest.state === "deleting" ? "重试原清理" : "清理文件"}</button> : null}
        </div>
        {evidence[item.manifest.id] ? <pre aria-label="文件固定窗口" className="whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{evidence[item.manifest.id]}</pre> : null}
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">文件版本与清单回执</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify({ ref: item.ref, sha256: item.manifest.sha256, receipt: item.receipt }, null, 2)}</pre></details>
      </article>)}
      {data && !data.items.length ? <p className="text-sm text-muted-foreground">当前没有可见的已登记私有文件，不代表历史公开文件已迁移。</p> : null}
      <nav aria-label="文件清单分页" className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={busy || isLoading || cursors.length === 1} onClick={() => { setEvidence({}); setCursors(previous => previous.slice(0, -1)); }}>上一页文件</button>
        <span className="text-xs text-muted-foreground" aria-live="polite">第 {cursors.length} 页</span>
        <button type="button" className={button} disabled={busy || isLoading || !data?.nextCursor} onClick={() => { if (data?.nextCursor) { setEvidence({}); setCursors(previous => previous.at(-1) === data.nextCursor ? previous : [...previous, data.nextCursor]); } }}>下一页文件</button>
      </nav>
      <p className="text-xs text-muted-foreground">清单包含未完成上传及未保存附件。旧公开地址未自动迁移，也不承诺即时撤回；文件激活不等于资料已完成索引。</p>
    </section>
    <section aria-label="连续性回执" className="grid min-w-0 gap-3 border-t pt-4">
      <h3 className="text-sm font-medium">连续性回执</h3>
      <label className="grid gap-1 text-sm">选择连续任务<select aria-label="选择连续任务" className="min-w-0 rounded border bg-background p-2" value={workId} disabled={!ownerId || worksLoading} onChange={event => setWorkId(event.target.value)}>
        <option value="">选择工作以查看最近回执</option>{works?.works?.map(work => <option key={work.id} value={work.id}>{work.name}</option>)}
      </select></label>
      <button type="button" className={button + " w-fit"} disabled={!ownerId || worksLoading || continuityLoading} onClick={() => { void refreshWorks(); if (workId) void refreshContinuity(); }}>刷新连续性回执</button>
      {worksError ? <p role="alert" className="text-sm text-destructive">连续任务列表暂不可用，可点击刷新重试。</p> : null}
      {worksLoading || continuityLoading ? <p role="status" className="text-sm text-muted-foreground">正在读取连续性回执…</p> : null}
      {works?.status === "select_work" && !works.works?.length ? <p className="text-sm text-muted-foreground">当前没有可查看的连续任务。</p> : null}
      {continuityError ? <p role="alert" className="text-sm text-destructive">连续性回执暂不可用。</p> : null}
      {continuity?.status === "unobserved" ? <p className="text-sm text-muted-foreground">尚未观察到该工作的可信运行回执；不能据此判断恢复已成功。</p> : null}
      {continuity?.receipts?.map(receipt => <article key={receipt.id} className="min-w-0 rounded border p-3 text-sm">
        <p>{stages[receipt.stage]} · {receipt.status}</p>{receipt.reason ? <p className="break-all text-xs text-muted-foreground">{receipt.reason}</p> : null}
        <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">运行来源与绑定</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(receipt, null, 2)}</pre></details>
      </article>)}
      <p className="text-xs text-muted-foreground">回执是有界样本。接续会重新检查角色、工具、场景、来源版本和权限；无法核验的旧断言不会作为当前结论装载。</p>
    </section>
  </section>;
}
