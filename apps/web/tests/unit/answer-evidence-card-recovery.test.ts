// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerEvidenceCard } from "@/components/message/answer-evidence-card";

const turnId = "11111111-1111-4111-8111-111111111111";
const final = { turnId, chatId: "chat", assistantMessageId: "answer", status: "completed", finalText: "body",
  bodyMirror: { schemaVersion: "answer-body-mirror.v1", state: "not_confirmed", reason: "message_not_found", observedAt: "2026-10-04T00:00:00Z" } };
let root: Root, container: HTMLDivElement;
const fetchMock = vi.fn();
async function mount(id = turnId) {
  await act(async () => {
    root.render(createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0, isVisible: () => true, isOnline: () => true } },
      createElement(AnswerEvidenceCard, { turnId: id, chatId: "chat", assistantMessageId: "answer", displayedText: "body" })));
  });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
describe("actual SWR card recovery without model or save requests", () => {
  it("stops automatic retries after an unavailable GET and recovers through manual refresh", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("核验记录暂不可用");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...final, bodyMirror: { ...final.bodyMirror, state: "stored_matching", reason: "exact_body_and_turn_reference" } }) });
    await act(async () => { container.querySelector("button")!.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("聊天正文已保存，与本轮答文一致");
    expect(container.textContent).toContain("本轮回答尚未核验");
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe(`/api/native/answer-audits/${turnId}`); expect(options).toEqual({ cache: "no-store" });
    }
  });
  it("bounds terminal pending-mirror polling and keeps an absent save unconfirmed", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => final });
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(1); expect(calls).toBeLessThanOrEqual(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(container.textContent).toContain("聊天正文保存尚未确认");
    expect(container.textContent).not.toContain("保存失败");
  });
  it("does not issue a request for an invalid turn reference", async () => {
    await mount("invalid");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
