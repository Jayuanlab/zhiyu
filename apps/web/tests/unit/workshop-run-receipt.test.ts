// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkshopRunReceipt, findLatestChatWorkshopRunSource } from "@/components/message/workshop-run-receipt";
import type { NativeConversationSourceMessage } from "@/lib/ai/chat/native-conversation";

const chatId = "11111111-1111-4111-8111-111111111111", workshopId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333", requestId = "44444444-4444-4444-8444-444444444444";
const nextRunId = "55555555-5555-4555-8555-555555555555", nextRequestId = "66666666-6666-4666-8666-666666666666";
const workshop = { id: workshopId, name: "强化学习前沿学习者", status: "active" };
const key = `zhiyu.chat-workshop-run.v1.${chatId}.${workshopId}`;
const fetchMock = vi.fn(), uuid = vi.fn();
let root: Root, container: HTMLDivElement;
function receipt(status = "queued", id = runId, observedAt = "2026-10-05T12:00:00.000Z") {
  return { ok: true, status: "run_observed", workshopId, workshop,
    run: { id, workshopId, status, error: status === "failed" ? "模型暂不可用" : null, outputSummary: status === "completed" ? "本轮学习汇报：已完成前沿论文归纳。" : null },
    observedAt, workshopUrl: "https://untrusted.example/", presentation: null, warnings: [] };
}
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
async function mount(patch: Partial<Parameters<typeof WorkshopRunReceipt>[0]> = {}) {
  await act(async () => root.render(createElement(WorkshopRunReceipt, { chatId, workshop, ...patch })));
}
async function click(label: string) {
  await act(async () => { const button = [...container.querySelectorAll("button")].find(item => item.textContent === label); expect(button).toBeDefined(); button!.click(); });
}
function native(toolName: string, toolOutput: unknown, patch: Record<string, unknown> = {}): NativeConversationSourceMessage {
  return { id: "source-assistant", chatId, role: "assistant", parts: [{ type: "tool-native", toolName, toolUseId: "source-call", status: "completed", toolOutput, ...patch }] };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fetchMock.mockReset(); uuid.mockReset().mockReturnValue(requestId); vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("crypto", { randomUUID: uuid });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("chat Workshop run once receipt", () => {
  it("selects only the latest actual target in the current assistant chat", () => {
    const created = native("applyWorkshopManifestYaml", { ok: true, status: "created_verified", workshop });
    const inspected = { ...native("inspectWorkshopAgent", JSON.stringify({ ok: true, target: { ...workshop, name: "已核对智能体" } })), id: "inspected" };
    expect(findLatestChatWorkshopRunSource([created, inspected], chatId)).toMatchObject({ assistantMessageId: "inspected", workshop: { id: workshopId, name: "已核对智能体" } });
    expect(findLatestChatWorkshopRunSource([{ ...created, chatId: "other" }, { ...created, role: "user" }], chatId)).toBeNull();
    expect(findLatestChatWorkshopRunSource([created, native("inspectWorkshopAgent", { ok: true, target: null })], chatId)).toBeNull();
    expect(findLatestChatWorkshopRunSource([native("applyWorkshopManifestYaml", { ok: true, review: { ok: true } })], chatId)).toBeNull();
    expect(findLatestChatWorkshopRunSource([native("runWorkshopOnce", { status: "success", result: receipt("running") })], chatId)?.receipt?.run.id).toBe(runId);
    expect(findLatestChatWorkshopRunSource([native("runWorkshopOnce", receipt(), { isError: true })], chatId)).toBeNull();
    expect(findLatestChatWorkshopRunSource([native("inspectWorkshopAgent", { ok: true, target: { id: "../../unsafe" } })], chatId)).toBeNull();
  });

  it("submits once without confirmation, persists IDs only, and follows its exact actual run", async () => {
    const confirm = vi.spyOn(window, "confirm"); let finish!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockImplementation((url: string) => url === "/api/workshops/run-from-chat"
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response(receipt("completed"))));
    await mount();
    await act(async () => { container.querySelector("button")!.click(); container.querySelector("button")!.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(container.querySelector("button")!.disabled).toBe(true); expect(confirm).not.toHaveBeenCalled();
    const options = fetchMock.mock.calls[0][1]; expect(JSON.parse(options.body)).toEqual({ chatId, workshopId, requestId });
    expect(options.body).not.toContain("status"); expect(options.body).not.toContain("schedule");
    await act(async () => finish(response({ ...receipt(), status: "run_accepted" }, 202)));
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/workshops/${workshopId}/runs/${runId}`);
    expect(container.textContent).toContain("已完成"); expect(container.textContent).toContain("已完成前沿论文归纳");
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ requestId, runId });
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`/workshop?workId=${workshopId}&tab=run&runId=${runId}`);
    expect(container.innerHTML).not.toContain("untrusted.example");
  });

  it("retries an uncertain submission with the same UUID, including after remount", async () => {
    fetchMock.mockRejectedValueOnce(Error("connection dropped")); await mount(); await click("运行一次");
    expect(container.textContent).toContain("结果暂未确认"); const first = fetchMock.mock.calls[0][1].body;
    await act(async () => root.unmount()); root = createRoot(container);
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.endsWith("run-from-chat") ? { ...receipt(), status: "run_accepted" } : receipt("completed"))));
    await mount(); expect(fetchMock).toHaveBeenCalledTimes(1); await click("核对本次提交");
    expect(fetchMock.mock.calls[1][1].body).toBe(first); expect(uuid).toHaveBeenCalledTimes(1);
  });

  it("restores only an ID pointer and verifies state rather than trusting browser status or prose", async () => {
    window.localStorage.setItem(key, JSON.stringify({ requestId, runId, status: "completed", report: "虚假的成功" }));
    fetchMock.mockResolvedValue(response(receipt("running"))); await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    expect(container.textContent).toContain("正在处理"); expect(container.textContent).not.toContain("虚假的成功"); expect(uuid).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "completed", "failed", "cancelled", "needs_review", "interrupted"])("displays durable %s state and only offers another action for safe terminal states", async status => {
    fetchMock.mockResolvedValue(response(receipt(status))); await mount({ initialReceipt: receipt(status) });
    const labels: Record<string, string> = { queued: "等待执行", running: "正在处理", completed: "已完成", failed: "处理失败", cancelled: "已停止", needs_review: "待核对", interrupted: "已中断" };
    expect(container.textContent).toContain(labels[status]); expect(container.textContent.includes("再运行一次")).toBe(["completed", "failed", "cancelled", "interrupted"].includes(status));
    if (status === "failed") expect(container.textContent).toContain("模型暂不可用");
    if (status === "needs_review") expect(container.textContent).toContain("不会自动重跑");
  });

  it("creates a new UUID only on explicit rerun, ignores an older Native seed, and preserves that request across retries", async () => {
    uuid.mockReturnValueOnce(requestId).mockReturnValueOnce(nextRequestId);
    let posts = 0;
    const thirdRunId = "77777777-7777-4777-8777-777777777777";
    fetchMock.mockImplementation((url: string, options: { body?: string }) => {
      if (!url.endsWith("run-from-chat")) return Promise.resolve(response(receipt("completed", url.includes(thirdRunId) ? thirdRunId : url.includes(nextRunId) ? nextRunId : runId)));
      posts++; return posts === 1 ? Promise.reject(Error("uncertain")) : Promise.resolve(response({ ...receipt("queued", JSON.parse(options.body!).requestId === nextRequestId ? thirdRunId : nextRunId), status: "run_accepted" }));
    });
    await mount({ initialReceipt: receipt("completed") });
    await act(async () => { const button = [...container.querySelectorAll("button")].find(item => item.textContent === "再运行一次")!; button.click(); button.click(); });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).requestId).toBe(requestId);
    await click("核对本次提交");
    const sent = fetchMock.mock.calls.filter(([url]) => url.endsWith("run-from-chat")); expect(sent[0][1].body).toBe(sent[1][1].body);
    expect(container.querySelector("a")?.getAttribute("href")).toContain(nextRunId); expect(uuid).toHaveBeenCalledTimes(1);
    await click("再运行一次");
    const newest = fetchMock.mock.calls.filter(([url]) => url.endsWith("run-from-chat")).at(-1)!;
    expect(JSON.parse(newest[1].body).requestId).toBe(nextRequestId); expect(uuid).toHaveBeenCalledTimes(2);
    expect(container.querySelector("a")?.getAttribute("href")).toContain(thirdRunId);
  });

  it("recovers a rerun across reload only for the same Native source, while newer Native runs win over old storage", async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.endsWith("run-from-chat")
      ? { ...receipt("running", nextRunId), status: "run_accepted" } : receipt(url.includes(nextRunId) ? "running" : "completed", url.includes(nextRunId) ? nextRunId : runId))));
    await mount({ initialReceipt: receipt("completed") }); await click("再运行一次");
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ requestId, runId: nextRunId, sourceRunId: runId });
    await act(async () => root.unmount()); root = createRoot(container); fetchMock.mockClear();
    await mount({ initialReceipt: receipt("completed") });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`/api/workshops/${workshopId}/runs/${nextRunId}`);
    expect(container.querySelector("a")?.getAttribute("href")).toContain(nextRunId); expect(container.textContent).toContain("正在处理");
    const newerRunId = "88888888-8888-4888-8888-888888888888";
    await act(async () => root.unmount()); root = createRoot(container); fetchMock.mockClear().mockResolvedValue(response(receipt("running", newerRunId)));
    await mount({ initialReceipt: receipt("running", newerRunId) });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`/api/workshops/${workshopId}/runs/${newerRunId}`);
    expect(container.querySelector("a")?.getAttribute("href")).toContain(newerRunId); expect(uuid).toHaveBeenCalledTimes(1);
  });

  it("keeps the pure chat renderer independent of the legacy run card and its polling", () => {
    const source = readFileSync(resolve("components/message/index.tsx"), "utf8");
    expect(source).not.toContain("WorkshopRunReceipt");
    expect(source).not.toContain("workshopRunSource");
    expect(source).toContain("workshopToolText(toolPart.toolName, toolPart.status, toolPart.toolOutput)");
  });

  it("retains the last observed status and time when a read fails, and never auto-starts on 404", async () => {
    fetchMock.mockResolvedValue(response({ error: "not_found" }, 404)); await mount({ initialReceipt: receipt("running") });
    expect(container.textContent).toContain("正在处理"); expect(container.textContent).toContain("最近核对"); expect(container.textContent).toContain("不会自动创建另一轮");
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).not.toContain("run-from-chat");
  });

  it("rejects a mismatched run observation without replacing the current run state", async () => {
    fetchMock.mockResolvedValue(response(receipt("completed", nextRunId))); await mount({ initialReceipt: receipt("queued") });
    expect(container.textContent).toContain("等待执行"); expect(container.textContent).not.toContain("已完成前沿论文归纳"); expect(container.textContent).toContain("响应不完整");
  });

  it("shows pending admission as unverified until exact readback, then polls every 3 seconds only while visible", async () => {
    vi.useFakeTimers(); let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    let reads = 0;
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.endsWith("run-from-chat")
      ? { ok: false, status: "run_readback_pending", workshopId, runId, retrySafe: true }
      : receipt(++reads < 3 ? "running" : "completed"))));
    await mount(); await click("运行一次"); expect(container.textContent).toContain("正在处理");
    await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(reads).toBe(2);
    visibility = "hidden"; await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(reads).toBe(2);
    visibility = "visible"; await act(async () => document.dispatchEvent(new Event("visibilitychange"))); expect(reads).toBe(3);
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(reads).toBe(3); expect(container.textContent).toContain("已完成");
  });

  it("does not queue a paused Workshop or expose a run action while the chat is busy", async () => {
    await mount({ workshop: { ...workshop, status: "paused" } }); expect(container.querySelector("button")).toBeNull(); expect(container.textContent).toContain("没有排队");
    await mount({ disabled: true }); expect(container.querySelector("button")?.disabled).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks action if a saved request pointer is corrupt rather than discarding recovery evidence", async () => {
    window.localStorage.setItem(key, "bad-json"); await mount(); expect(container.textContent).toContain("保留浏览器数据"); expect(container.querySelector("button")?.disabled).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
  });
});
