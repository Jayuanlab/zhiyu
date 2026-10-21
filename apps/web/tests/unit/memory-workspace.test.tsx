// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "@/components/memory-workspace";

let root: Root, container: HTMLDivElement;
const mounted = vi.fn(), unmounted = vi.fn();
function Panel({ name }: { name: string }) {
  const [draft, setDraft] = useState("");
  useEffect(() => { mounted(name); return () => { unmounted(name); }; }, [name]);
  return createElement("input", { "aria-label": name, value: draft, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value) });
}
async function mount() {
  await act(async () => root.render(createElement(MemoryWorkspace, {
    search: createElement(Panel, { name: "search" }), review: createElement(Panel, { name: "review" }),
    files: createElement(Panel, { name: "files" }), activity: createElement(Panel, { name: "activity" }),
  })));
}
async function click(hash: string) { await act(async () => (container.querySelector(`a[href="#${hash}"]`) as HTMLAnchorElement).click()); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mounted.mockClear(); unmounted.mockClear();
  window.history.replaceState(null, "", "/memory");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("Memory center navigation", () => {
  it("loads only search initially and visits audit/file panels only on request", async () => {
    await mount(); expect(mounted.mock.calls.map(([name]) => name)).toEqual(["search"]);
    expect(container.querySelector('[aria-current="location"]')?.textContent).toContain("查找记忆");
    await click("memory-review"); expect(mounted.mock.calls.map(([name]) => name)).toEqual(["search", "review"]);
    expect(window.location.hash).toBe("#memory-review");
    expect((container.querySelector("#memory-search") as HTMLElement).hidden).toBe(true);
    expect(container.querySelector('[aria-label="files"]')).toBeNull();
  });
  it("retains an edited form and mounted controls when switching sections", async () => {
    await mount(); await click("memory-review");
    const input = container.querySelector('[aria-label="review"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "unconfirmed draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("memory-private-files"); await click("memory-review");
    expect((container.querySelector('[aria-label="review"]') as HTMLInputElement).value).toBe("unconfirmed draft");
    expect(mounted.mock.calls.filter(([name]) => name === "review")).toHaveLength(1); expect(unmounted).not.toHaveBeenCalled();
  });
  it("opens the existing file deep link and responds to external hash links", async () => {
    window.history.replaceState(null, "", "/memory#memory-private-files"); await mount();
    expect((container.querySelector("#memory-private-files") as HTMLElement).hidden).toBe(false);
    await act(async () => { window.history.replaceState(null, "", "/memory#memory-activity"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect((container.querySelector("#memory-activity") as HTMLElement).hidden).toBe(false);
    expect(container.querySelector('[aria-current="location"]')?.textContent).toContain("来源与使用记录");
  });
  it("falls back to search for an unknown hash without loading other controls", async () => {
    window.history.replaceState(null, "", "/memory#unknown"); await mount();
    expect(mounted.mock.calls.map(([name]) => name)).toEqual(["search"]);
    expect((container.querySelector("#memory-search") as HTMLElement).hidden).toBe(false);
  });
});
