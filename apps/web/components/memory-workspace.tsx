"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

const sections = [
  { id: "search", hash: "memory-search", label: "查找记忆", description: "找回内容，核对是否适用" },
  { id: "review", hash: "memory-review", label: "审核与纠错", description: "确认变更，修正已有理解" },
  { id: "files", hash: "memory-private-files", label: "文件与接续", description: "管理文件，查看任务接续" },
  { id: "activity", hash: "memory-activity", label: "来源与使用记录", description: "追溯依据，核对读取范围" },
] as const;
type Section = (typeof sections)[number]["id"];

/** Visit sections on demand, then retain their forms and pending commands. */
export function MemoryWorkspace({ search, review, files, activity }: Record<Section, ReactNode>) {
  const [active, setActive] = useState<Section>("search");
  const [visited, setVisited] = useState<Set<Section>>(() => new Set(["search"]));
  function select(section: Section) {
    setActive(section);
    setVisited(previous => previous.has(section) ? previous : new Set([...previous, section]));
  }
  useEffect(() => {
    const restore = () => select(sections.find(section => `#${section.hash}` === window.location.hash)?.id ?? "search");
    restore();
    window.addEventListener("hashchange", restore);
    return () => window.removeEventListener("hashchange", restore);
  }, []);
  const panels = { search, review, files, activity };
  return <>
    <header className="grid gap-4 border-b border-border pb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-xs font-medium tracking-wide text-[var(--product-jade)]">你的记忆，由你核对</p>
          <h1 className="mt-1 text-[28px] font-semibold tracking-tight">记忆中心</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">查找已经记住的内容，审核新的理解，追溯对话与工作使用的依据。</p>
        </div>
        <Link href="/knowledge-pipeline" className="mt-1 rounded-md border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">整理消息与知识 <span aria-hidden="true">↗</span></Link>
      </div>
      <div aria-label="记忆如何进入任务" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground">
        <span>消息与文件 <span className="ml-1 text-foreground">保留来源</span></span><span aria-hidden="true">→</span>
        <span>理解与经验 <span className="ml-1 text-foreground">审核变更</span></span><span aria-hidden="true">→</span>
        <span>当前任务 <span className="ml-1 text-foreground">核对后使用</span></span>
      </div>
    </header>
    <nav aria-label="记忆中心分区" className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/30 p-1 lg:grid-cols-4">
      {sections.map(section => <a key={section.id} href={`#${section.hash}`} aria-current={active === section.id ? "location" : undefined}
        onClick={event => { event.preventDefault(); window.history.replaceState(null, "", `#${section.hash}`); select(section.id); }}
        className={cn("min-w-0 rounded-md px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active === section.id ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-card/60 hover:text-foreground")}>
        <span className="block text-sm font-medium">{section.label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{section.description}</span>
      </a>)}
    </nav>
    {sections.map(section => visited.has(section.id) ? <section key={section.id} id={section.hash} aria-label={section.label} hidden={active !== section.id}>
      <div className="grid min-w-0 gap-5">{panels[section.id]}</div>
    </section> : null)}
  </>;
}
