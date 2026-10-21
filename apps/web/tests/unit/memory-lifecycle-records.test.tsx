// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryLifecycleRecords } from "@/components/memory-lifecycle-records";
vi.mock("@/components/memory-revision-dialog", () => ({ MemoryRevisionControl: () => createElement("button", null, "existing correction workflow") }));
const item = { id: "10000000-0000-4000-8000-000000000001", subject: "Operational sample", content: "Original evidence", status: "active", createdAt: "2026-10-02T00:00:00Z", revisionVersion: `bmrv1:${"a".repeat(64)}`, restoreReceiptId: null,
  lifecycle: { recordClass: "run_record", reason: "authored_operational_checkpoint", phase: "archived", usableUntil: "2026-10-09T00:00:00Z", recallEligible: false } };
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount(ownerId: string | null = "owner-fixture") { const cache = new Map(); await act(async () => root.render(createElement(SWRConfig, { value: { provider: () => cache, dedupingInterval: 0 } }, createElement(MemoryLifecycleRecords, { ownerId })))); }
it("shows archived operational evidence separately with a bounded source read", async () => {
  const fetcher = vi.fn(async () => Response.json({ records: [item], truncated: false })); vi.stubGlobal("fetch", fetcher); await mount();
  expect(fetcher.mock.calls[0]).toEqual(["/api/memory/lifecycle?recordClass=run_record", { cache: "no-store" }]);
  expect(container.textContent).toContain("使用窗口已结束"); expect(container.textContent).toContain("Original evidence"); expect(container.textContent).toContain("不会自动删除");
  expect(container.textContent).toContain("原记录明确标记为运行检查点"); expect(container.textContent).not.toContain("authored_operational_checkpoint"); expect(container.textContent).toContain("原状态：已保存");
});
it("shows the actually returned project policy without treating its version as truth verification",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>Response.json({records:[item],truncated:false,policy:{id:"zhiyu.memory.records",version:"2.0.0"}})));await mount();expect(container.textContent).toContain("zhiyu.memory.records · 2.0.0");expect(container.textContent).toContain("策略版本不替代原文核验和主人审核");});
it("rejects malformed policy metadata instead of rendering it as the active configuration",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>Response.json({records:[item],truncated:false,policy:{id:{forged:true},version:"2"}})));await mount();expect(container.querySelector('[role="alert"]')?.textContent).toContain("未将异常策略当作有效配置");expect(container.textContent).not.toContain("当前分类策略");});
it("distinguishes a superseded acceptance sample from its saved successor", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ records: [{ ...item, status: "superseded", lifecycle: { ...item.lifecycle, recordClass: "acceptance_record", phase: "audit_only" } }], truncated: false }))); await mount();
  expect(container.textContent).toContain("原状态：已被替代"); expect(container.textContent).toContain("仅保留验收证据");
});
it("does not read another owner's records while identity is unavailable", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await mount(null); expect(fetcher).not.toHaveBeenCalled();
});
it("loads the next bounded page without claiming a truncated sample is the entire history", async () => {
  const fetcher = vi.fn(async (url: string) => Response.json({ records: [url.includes("cursor=") ? {...item,id:"next-page",subject:"Earlier report"} : item], truncated: !url.includes("cursor="), nextCursor: url.includes("cursor=") ? null : "page-two" }));
  vi.stubGlobal("fetch", fetcher); await mount(); expect(container.textContent).toContain("还有更早记录未展示");
  const next = Array.from(container.querySelectorAll("button")).find(button=>button.textContent === "下一页")!;
  await act(async()=>next.click());expect(container.textContent).toContain("Earlier report");expect(container.textContent).not.toContain("Operational sample");expect(fetcher.mock.calls.at(-1)?.[0]).toContain("cursor=page-two");
});
it("distinguishes unavailable or malformed data from an empty result", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ records: [null], truncated: false }))); await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("未将异常当作空列表"); expect(container.textContent).not.toContain("本类暂无记录");
});
it("retries an uncertain mutation with the same command and version", async () => {
  const commands: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { commands.push(JSON.parse(String(init.body))); return Response.json({}, { status: 503 }); }
    return Response.json({ records: [item], truncated: false });
  })); await mount();
  const input = container.querySelector("input[maxlength=\"2000\"]")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Owner classification reason"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const form = input.closest("form")!;
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.textContent).toContain("重试同一操作");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]); expect(commands[0].expectedVersion).toBe(item.revisionVersion);
});
