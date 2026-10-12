"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@openzhiyu/ui";
import type { WorkspaceLayout } from "@/lib/workshops/workspace";

type Space = WorkspaceLayout & { status: "ready" | "not_created" | "unavailable"; warning: string | null };
type Response = { workspace: Space; loops: Array<Space & { name: string }>; loopsTruncated: boolean };

async function fetchSpace(url: string, method = "GET"): Promise<Response> {
  const response = await fetch(url, { method });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "工作空间加载失败");
  return value;
}

const statusLabel = { ready: "已创建", not_created: "运行时自动创建", unavailable: "空间不可用" };

export function WorkshopWorkspacePanel({ workshopId }: { workshopId: string }) {
  const url = `/api/workshops/${workshopId}/workspace`;
  const { data, error, isLoading, mutate } = useSWR<Response>(url, fetchSpace, { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  async function refresh() {
    setActionError(null);
    try { await mutate(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  }
  async function prepare() {
    setBusy(true);
    setActionError(null);
    try { await mutate(await fetchSpace(url, "POST"), false); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return (
    <section aria-label="车间工作空间" className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">工作空间</h3>
        <Button size="sm" variant="outline" disabled={busy || isLoading} onClick={() => void refresh()}>刷新空间</Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">车间共享长期资料与已审核记忆；每个 Loop 保留自己的任务状态；每次运行独立保存输入、输出和执行证据。</p>
      {isLoading ? <p role="status" className="text-xs">正在检查空间状态…</p> : null}
      {error || actionError ? <p role="alert" className="break-words text-xs text-destructive">{actionError ?? error.message}</p> : null}
      {data ? <>
        <p className="text-xs">车间长期空间：{statusLabel[data.workspace.status]}</p>
        {data.workspace.warning ? <p role="alert" className="break-words text-xs text-destructive">{data.workspace.warning}</p> : null}
        <details className="text-xs">
          <summary className="cursor-pointer">查看空间归属与路径（{data.loops.length} 个 Loop）</summary>
          <p className="mt-2 break-all">车间：{data.workspace.workshopDir}</p>
          {data.loops.map(loop => <div key={loop.loopId} className="mt-2 space-y-1">
            <p>{loop.name} · {statusLabel[loop.status]}</p>
            <p className="break-all text-muted-foreground">{loop.loopDir}</p>
            {loop.warning ? <p role="alert" className="break-words text-destructive">{loop.warning}</p> : null}
          </div>)}
          {data.loopsTruncated ? <p role="status">仅显示前 200 个 Loop，其他 Loop 在运行时创建空间。</p> : null}
          <p className="mt-2 leading-5 text-muted-foreground">任务进度与检查点以数据库为准。运行文件保留原路径，新运行通过索引关联到长期空间。资料和成果通过现有资料／审核流程共享，不会自动转成长期记忆。</p>
          <p className="mt-2 leading-5 text-muted-foreground">目录划分不等于系统沙箱；命令工具的权限仍由车间边界控制。</p>
        </details>
        {data.workspace.status !== "ready" || data.loops.some(loop => loop.status !== "ready") ?
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void prepare()}>{busy ? "正在准备…" : "准备长期空间"}</Button> : null}
      </> : null}
    </section>
  );
}
