// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRecentRecords } from "@/components/memory-recent-records";
vi.mock("@/components/memory-revision-dialog", () => ({ MemoryRevisionControl: () => createElement("button", null, "review existing record") }));
const item = { id: "10000000-0000-4000-8000-000000000001", subject: "Saved understanding", content: "Bounded sample", status: "active", updatedAt: "2026-10-21T00:00:00Z" };
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount() { const cache = new Map(); await act(async () => root.render(createElement(SWRConfig, { value: { provider: () => cache, dedupingInterval: 0 } }, createElement(MemoryRecentRecords, { ownerId: "owner-canary" })))); }
it("reads a bounded list, preserves status semantics and exposes existing review controls", async () => {
  const fetcher = vi.fn(async () => Response.json({ memories: [item] })); vi.stubGlobal("fetch", fetcher); await mount();
  expect(fetcher.mock.calls[0]).toEqual(["/api/memory/memories?limit=8&statuses=active,verified,weakened", { cache: "no-store" }]);
  expect(container.textContent).toContain("Saved understanding"); expect(container.textContent).toContain("已保存"); expect(container.textContent).toContain("适用范围待核对"); expect(container.textContent).toContain("review existing record");
});
it("shows request failure without claiming there are no saved memories", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 503 }))); await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("没有将读取失败当作空列表"); expect(container.textContent).not.toContain("这里还没有可展示");
});
it("rejects an oversized or malformed response instead of displaying its body", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ memories: Array(9).fill(item) }))); await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("信息不完整"); expect(container.textContent).not.toContain("Bounded sample");
});
