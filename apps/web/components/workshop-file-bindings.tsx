'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
type Binding = { id: string; sourceId: string; revision: number; state: 'active' | 'revoked'; permissions: string[]; expiresAt: string };
type Source = { id: string; name: string; type: string; enabled?: boolean };
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init), body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '文件授权操作失败'); return body;
}
type Upload = { file: File; commandId: string; expiresAt: string };
export function WorkshopFileBindings({ workshopId, canUpload, sources, onSaved }: { workshopId: string; canUpload: boolean; sources: Source[]; onSaved: () => Promise<unknown> }) {
  const url = `/api/memory/files/bindings?workshopId=${encodeURIComponent(workshopId)}`;
  const { data, error, isLoading, mutate } = useSWR<{ bindings: Binding[]; hasMore: boolean }>(url, json, { revalidateOnFocus: false });
  const [file, setFile] = useState<File | null>(null), [days, setDays] = useState(7), [pending, setPending] = useState<Upload | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [taskId, setTaskId] = useState(''), [path, setPath] = useState(''), [sourceId, setSourceId] = useState('');
  const [imported, setImported] = useState<{ artifactId: string; artifactRevision: string } | null>(null);
  const [retryJson, setRetryJson] = useState<{ url: string; body: Record<string, unknown> } | null>(null);
  async function refresh() { await Promise.all([mutate(), onSaved()]); }
  async function upload(original?: Upload) {
    if (!file && !original) return;
    const command = original ?? { file: file!, commandId: crypto.randomUUID(), expiresAt: new Date(Date.now() + days * 86400000).toISOString() };
    setPending(command); setBusy(true); setFailure(null); setNotice(null);
    try {
      const form = new FormData(); form.set('file', command.file); form.set('commandId', command.commandId); form.set('expiresAt', command.expiresAt);
      await json(`/api/workshops/${workshopId}/sources/upload`, { method: 'POST', body: form });
      setPending(null); setFile(null); setNotice('文件快照已保存并限期授权；正文尚未由模型读取。'); await refresh();
    } catch (error) { setFailure(error instanceof Error ? error.message : '文件上传失败'); }
    finally { setBusy(false); }
  }
  async function submit(url: string, body: Record<string, unknown>) {
    setBusy(true); setFailure(null); setNotice(null); setRetryJson({ url, body });
    try {
      const result = await json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setRetryJson(null); if (result.artifactId && result.artifactRevision) setImported(result);
      setNotice(result.artifactId ? '已导入当时的文件快照；原工作空间文件以后变化不会自动更新快照。请选定资料源后授权。' : '文件授权状态已保存。'); await refresh();
    } catch (error) { setFailure(error instanceof Error ? error.message : '文件授权失败'); }
    finally { setBusy(false); }
  }
  const existing = data?.bindings.find(binding => binding.sourceId === sourceId);
  return <section aria-label="Work 文件授权" className="space-y-3 rounded-lg border border-border p-3 text-xs">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">文件快照与授权</h3><Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>刷新文件授权</Button></div>
    <p className="leading-5 text-muted-foreground">仅授权当前 Work 读取与转换所选不可变快照；不授权磁盘目录。工具禁用优先，停用资料、撤销、到期或文件校验失败后，下一次模型请求会被阻断。转换结果另存，原件不可编辑。</p>
    <label className="block space-y-1">授权天数<Input aria-label="文件授权天数" type="number" min={1} max={365} value={days} disabled={busy || !!pending || !!retryJson} onChange={event => setDays(Math.min(365, Math.max(1, Number(event.target.value) || 1)))} /></label>
    {canUpload ? <div className="space-y-2"><input aria-label="上传给当前 Work 的文件" type="file" disabled={busy || !!pending || !!retryJson} onChange={event => setFile(event.target.files?.[0] ?? null)} />
      <Button size="sm" disabled={busy || !file || !!pending || !!retryJson} onClick={() => void upload()}>上传并授权读取与转换</Button></div> : <p>此角色不接受直接文档上传；可导入本人任务文件快照，再为已有文件资料源明确绑定。</p>}
    {pending ? <div className="space-y-1"><p>原操作期限：{new Date(pending.expiresAt).toLocaleString()}。重试保持原文件、命令与期限。</p><Button size="sm" disabled={busy} onClick={() => void upload(pending)}>重试原文件上传</Button></div> : null}
    <details><summary className="cursor-pointer">导入本人任务文件并绑定已有资料源</summary><div className="mt-2 space-y-2">
      <Input aria-label="文件所属任务 ID" placeholder="本人任务 Chat ID" value={taskId} disabled={busy || !!retryJson} onChange={event => setTaskId(event.target.value)} />
      <Input aria-label="任务内相对文件路径" placeholder="outputs/report.md（相对路径）" value={path} disabled={busy || !!retryJson} onChange={event => setPath(event.target.value)} />
      <Button size="sm" disabled={busy || !!retryJson || !taskId || !path} onClick={() => void submit('/api/memory/files/import', { commandId: crypto.randomUUID(), taskId, path })}>确认导入当前文件快照</Button>
      {imported ? <><p className="break-all">已导入文件：{imported.artifactId}</p><select aria-label="绑定的文件资料源" className="w-full rounded border bg-background p-2" value={sourceId} disabled={busy || !!retryJson} onChange={event => setSourceId(event.target.value)}><option value="">选择已启用的文件资料源</option>{sources.filter(source => source.type === 'file' && source.enabled !== false).map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select>
        <Button size="sm" disabled={busy || !!retryJson || !sourceId || !data} onClick={() => void submit('/api/memory/files/bindings', { commandId: crypto.randomUUID(), workshopId, sourceId,
          artifactId: imported.artifactId, expectedArtifactRevision: imported.artifactRevision, expectedBindingRevision: existing?.revision ?? 0,
          permissions: ['read', 'convert'], expiresAt: new Date(Date.now() + days * 86400000).toISOString() })}>确认绑定此快照并授权</Button></> : null}
    </div></details>
    {retryJson ? <Button size="sm" disabled={busy} onClick={() => void submit(retryJson.url, retryJson.body)}>重试原授权操作</Button> : null}
    {failure || error ? <p role="alert" className="break-words text-destructive">{failure ?? error.message}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {isLoading ? <p role="status">正在读取文件授权…</p> : null}
    {data?.bindings.map(binding => <div key={binding.id} className="space-y-1 border-t pt-2"><p className="break-all">{sources.find(source => source.id === binding.sourceId)?.name ?? binding.sourceId} · v{binding.revision} · {binding.state === 'revoked' ? '已撤销' : Date.parse(binding.expiresAt) <= Date.now() ? '已到期' : '授权已保存'}</p><p>到期：{new Date(binding.expiresAt).toLocaleString()} · {binding.permissions.join(' / ')}</p>
      {binding.state === 'active' ? <Button size="sm" variant="outline" disabled={busy || !!retryJson} onClick={() => void submit(`/api/memory/files/bindings/${binding.id}/revoke`, { commandId: crypto.randomUUID(), expectedBindingRevision: binding.revision })}>撤销文件授权</Button> : null}</div>)}
    {data?.hasMore ? <p>仅显示前 100 条授权，范围有界。</p> : null}
  </section>;
}
