// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig, type SWRConfiguration } from "swr";
import { MemorySourceGovernance } from "@/components/memory-source-governance";
const owner = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000002";
const coverage = { sources: [{ kind: "message", semantics: "stored_observation", owner: "exact_owner_row", work: "unavailable" }],
  gaps: [], status: "unobserved", receipts: [], sample: { returnedCount: 0, hasMore: false }, warning: "Not execution proof" };
const evidence = { status: "read", source: "message", id, revision: "msrc1:" + "b".repeat(64), receiptId: id, content: "SYNTHETIC_OLD_SOURCE",
  contentHash: "a".repeat(64), semantics: "stored_observation", actualRange: { start: 0, end: 20, unit: "utf16" }, totalCharacters: 40, nextOffset: 20 };
let root: Root, container: HTMLDivElement, config: SWRConfiguration;
async function mount(ownerId = owner) {
  await act(async () => root.render(createElement(SWRConfig, { value: config }, createElement(MemorySourceGovernance, { ownerId }))));
}
async function change(label: string, value: string) {
  await act(async () => {
    const element = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => {
    const button = [...container.querySelectorAll("button")].find(element => element.textContent === label);
    expect(button).toBeDefined(); button!.click();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cache = new Map(); config = { provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe("desktop Memory source governance", () => {
  it("uses fixed content and row revision for the next window, clearing stale evidence on conflict", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/memory/sources") return Response.json(coverage);
      if (url === "/api/memory/sources/read") return JSON.parse(String(init?.body)).offset
        ? Response.json({ code: "memory_source_version_changed" }, { status: 409 }) : Response.json(evidence);
      throw new Error("Unexpected route " + url);
    }); vi.stubGlobal("fetch", fetcher); await mount();
    await change("精确来源类型", "message"); await change("来源记录 ID", id); await click("读取登记来源");
    expect(container.textContent).toContain("SYNTHETIC_OLD_SOURCE"); await click("读取下一来源窗口");
    expect(container.textContent).toContain("旧窗口已清除"); expect(container.textContent).not.toContain("SYNTHETIC_OLD_SOURCE");
    const calls = fetcher.mock.calls.filter(([url]) => url === "/api/memory/sources/read");
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ source: "message", id, offset: 20, expectedHash: evidence.contentHash, expectedRevision: evidence.revision });
    expect([...container.querySelectorAll("button")].some(element => element.textContent === "重试来源窗口")).toBe(false);
  });
  it("does not render a previous owner's late source body", async () => {
    let resolve: ((value: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/memory/sources" ? Promise.resolve(Response.json(coverage)) : new Promise<Response>(done => { resolve = done; })));
    await mount(); await change("精确来源类型", "message"); await change("来源记录 ID", id); await click("读取登记来源");
    expect(resolve).toBeDefined(); await mount("00000000-0000-4000-8000-000000000003");
    await act(async () => resolve?.(Response.json(evidence))); expect(container.textContent).not.toContain("SYNTHETIC_OLD_SOURCE");
    expect((container.querySelector('[aria-label="来源记录 ID"]') as HTMLInputElement).value).toBe("");
  });
  it("clears revoked or unavailable source windows and restarts a recovery read from the beginning", async () => {
    let failContinuation = true;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => url === "/api/memory/sources" ? Response.json(coverage)
      : JSON.parse(String(init?.body)).offset && failContinuation
        ? Response.json({ code: "memory_source_origin_unavailable" }, { status: 503 }) : Response.json(evidence));
    vi.stubGlobal("fetch", fetcher); await mount(); await change("精确来源类型", "message"); await change("来源记录 ID", id);
    await click("读取登记来源"); expect(container.textContent).toContain("SYNTHETIC_OLD_SOURCE");
    await click("读取下一来源窗口"); expect(container.textContent).not.toContain("SYNTHETIC_OLD_SOURCE");
    expect(container.querySelector('[aria-label="登记来源原文"]')).toBeNull();
    failContinuation = false; await click("重试来源窗口");
    const calls = fetcher.mock.calls.filter(([url]) => url === "/api/memory/sources/read");
    expect(JSON.parse(String(calls[2][1]?.body))).toEqual({ source: "message", id });
    expect(container.textContent).toContain("SYNTHETIC_OLD_SOURCE");
  });
  it("exposes a failed coverage read without claiming a healthy sample", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "unavailable" }, { status: 503 }))); await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("没有视为健康");
    expect([...container.querySelectorAll("button")].some(element => element.textContent === "读取登记来源")).toBe(false);
  });
});
