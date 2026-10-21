// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type SWRConfiguration } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFilesContinuity } from "@/components/memory-files-continuity";
const fetchMock = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>();
let root: Root, container: HTMLDivElement;
let config: SWRConfiguration;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function item(name: string) {
  return { manifest: { id: name, name, state: "active", contentType: "text/plain", sizeBytes: 5,
    sha256: "a".repeat(64), revision: 1, userFileId: null, cleanupAttempts: 0, url: "/api/files/" + name },
    ref: { record: { kind: "artifact", id: name }, revision: "artifact:" + name }, receipt: { id: "receipt-" + name } };
}
async function render(ownerId = "owner-a") {
  await act(async () => { root.render(createElement(SWRConfig, { value: config }, createElement(MemoryFilesContinuity, { ownerId }))); });
}
async function click(label: string) {
  await act(async () => {
    const button = [...container.querySelectorAll("button")].find(value => value.textContent === label);
    expect(button).toBeDefined(); button!.click();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
  const cache = new Map(); config = { provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe("Owner file and continuity panel", () => {
  it("navigates the real cursor in both directions without deleting files to reach older pages", async () => {
    fetchMock.mockImplementation(async url => response(url.startsWith("/api/memory/artifacts")
      ? { items: [item(url.includes("cursor=") ? "older-file" : "newer-file")], nextCursor: url.includes("cursor=") ? null : "next:opaque", coverage: { complete: false } }
      : { status: "select_work", works: [] }));
    await render(); expect(container.textContent).toContain("newer-file");
    await click("下一页文件"); expect(container.textContent).toContain("older-file"); expect(container.textContent).not.toContain("newer-file");
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/artifacts?limit=20&cursor=next%3Aopaque", { cache: "no-store" });
    await click("上一页文件"); expect(container.textContent).toContain("newer-file");
    expect(fetchMock.mock.calls.every(([url]) => !url.includes("/commands"))).toBe(true);
  });
  it("resets pagination and discards an old owner's pending evidence on owner change", async () => {
    let owner = "a", resolveRead!: (value: Response) => void;
    fetchMock.mockImplementation(async url => {
      if (url === "/api/memory/read") return new Promise(resolve => { resolveRead = resolve; });
      if (url.startsWith("/api/memory/artifacts")) return response({ items: [item(owner + "-file")], nextCursor: "older", coverage: { complete: false } });
      return response({ status: "select_work", works: [{ id: owner + "-work", name: owner + "-work" }] });
    });
    await render(); await click("下一页文件"); await click("读取固定窗口");
    const read = fetchMock.mock.calls.find(([url]) => url === "/api/memory/read"); expect(read).toBeDefined();
    owner = "b"; await render("owner-b");
    expect(container.textContent).toContain("b-file"); expect(container.textContent).not.toContain("a-file");
    expect(container.textContent).toContain("第 1 页"); expect((container.querySelector("select") as HTMLSelectElement).value).toBe("");
    expect(read![1]?.signal?.aborted).toBe(true);
    await act(async () => { resolveRead(response({ status: "ok", encoding: "base64", content: btoa("OLD_OWNER_BODY"),
      receipt: { id: "old", actualRange: { start: 0, end: 14 }, totalLength: 14 } })); });
    expect(container.textContent).not.toContain("OLD_OWNER_BODY");
  });
  it("shows a failed Work directory and allows an explicit refresh", async () => {
    let recovered = false;
    fetchMock.mockImplementation(async url => url.startsWith("/api/memory/artifacts")
      ? response({ items: [], nextCursor: null, coverage: { complete: false } })
      : recovered ? response({ status: "select_work", works: [{ id: "work", name: "Recovered Work" }] }) : response({}, 503));
    await render(); expect(container.textContent).toContain("连续任务列表暂不可用");
    recovered = true; await click("刷新连续性回执"); expect(container.textContent).toContain("Recovered Work");
    expect(container.textContent).not.toContain("连续任务列表暂不可用");
  });
});
