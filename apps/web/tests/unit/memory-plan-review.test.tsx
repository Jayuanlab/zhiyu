// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ stream: vi.fn(), abort: vi.fn() }));
vi.mock("@/lib/ai/router/index", () => ({ streamNativeAgentResponse: mocks.stream }));
vi.mock("@/components/agent/model-selector", () => ({ useModelPreference: () => ["default", vi.fn()], getPiNativeModelConfig: () => undefined }));
import { MemoryPlanReview } from "@/components/memory-plan-review";
import type { streamNativeAgentResponse } from "@/lib/ai/router/index";
type Options = Parameters<typeof streamNativeAgentResponse>[1];
const owner = "00000000-0000-4000-8000-000000000001", taskId = "00000000-0000-4000-8000-000000000002", receiptId = "00000000-0000-4000-8000-000000000003";
const planId = "legacy-synthetic-plan", version = "mplan1:" + "b".repeat(64), legacyVersion = "legacyplan1:" + "a".repeat(64);
const proposal = { id: planId, goal: "Synthetic proposal", steps: [{ id: "1", description: "Check the synthetic source", status: "pending" }] };
const legacy = { kind: "legacy_unverified", plan: proposal, legacyVersion, historicalSources: "unknown", requiresOwnerRebase: true, taskId, workDir: "C:/synthetic-work" };
const current = { kind: "memory_plan", plan: proposal, version, revision: 1, state: "ready", available: true, sourceCount: 2,
  sourceReceiptIds: [receiptId], origin: "owner_rebased_legacy", historicalSources: "unknown_owner_rebased", taskId, workDir: "C:/synthetic-work", expiresAt: "2027-01-01T00:00:00.000Z", execution: null };
let root: Root, container: HTMLDivElement;
async function mount(ownerId = owner) { await act(async () => root.render(createElement(MemoryPlanReview, { ownerId, planId }))); }
function findButton(label: string) { const element = [...container.querySelectorAll("button")].find(item => item.textContent === label); expect(element).toBeDefined(); return element!; }
async function click(label: string) { await act(async () => findButton(label).click()); }
async function fill(label: string, value: string) {
  await act(async () => {
    const element = container.querySelector(`[aria-label="${label}"]`) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function confirm() { await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click()); }
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); mocks.stream.mockResolvedValue(mocks.abort); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe("owner plan review and guarded recovery", () => {
  it("requires fresh owner input and confirmation, retrying a failed rebase with the same immutable command", async () => {
    let rebased = false, failed = false;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/rebase")) { if (!failed) { failed = true; return Response.json({ code: "audit_unavailable" }, { status: 503 }); } rebased = true; return Response.json(current); }
      return Response.json(rebased ? current : legacy);
    }); vi.stubGlobal("fetch", fetcher); await mount();
    expect(container.textContent).toContain("历史来源未知，尚未补证"); expect(findButton("确认恢复为待批准计划").disabled).toBe(true); expect(mocks.stream).not.toHaveBeenCalled();
    await fill("当前输入", "Synthetic fresh instruction"); await fill("当前来源回执 ID", receiptId); await confirm(); await click("确认恢复为待批准计划");
    expect(container.textContent).not.toContain("Synthetic proposal"); expect(container.textContent).not.toContain("待主人批准");
    await click("重试原操作");
    const posts = fetcher.mock.calls.filter(([url]) => url.endsWith("/rebase"));
    const first = JSON.parse(String(posts[0][1]?.body)), second = JSON.parse(String(posts[1][1]?.body));
    expect(second).toEqual(first); expect(first).toMatchObject({ expectedLegacyVersion: legacyVersion, inputPrompt: "Synthetic fresh instruction", sourceReceiptIds: [receiptId], confirmed: true });
    expect(first.commandId).toMatch(/^[a-f0-9-]{36}$/i); expect(container.textContent).toContain("待主人批准"); expect(container.textContent).toContain(version);
    expect(container.textContent).toContain("历史来源未知，尚未补证"); expect(mocks.stream).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("a")].find(link => link.textContent === "查看原聊天与任务记录")?.getAttribute("href")).toBe(`/?page=chat&chatId=${taskId}`);
  });
  it("rejects invalid receipt IDs before any recovery request", async () => {
    const fetcher = vi.fn(async () => Response.json(legacy)); vi.stubGlobal("fetch", fetcher); await mount();
    await fill("当前输入", "Fresh input"); await fill("当前来源回执 ID", "not-a-receipt"); await confirm();
    expect(findButton("确认恢复为待批准计划").disabled).toBe(true); expect(container.textContent).toContain("来源回执须为 UUID"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reserves two proof slots by accepting at most 62 supplied source receipts", async () => {
    const fetcher = vi.fn(async () => Response.json(legacy)); vi.stubGlobal("fetch", fetcher); await mount();
    await fill("当前输入", "Fresh input"); await confirm();
    const ids = Array.from({ length: 63 }, (_, index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
    await fill("当前来源回执 ID", ids.join("\n")); expect(findButton("确认恢复为待批准计划").disabled).toBe(true); expect(container.textContent).toContain("最多 62 条");
    await fill("当前来源回执 ID", ids.slice(0, 62).join("\n")); expect(findButton("确认恢复为待批准计划").disabled).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("clears uncertain revocation state and only displays revoked after the real read succeeds", async () => {
    let count = 0, revoked = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/revoke")) { count++; if (count === 1) return Response.json({}, { status: 503 }); revoked = true; return Response.json({ ...current, state: "revoked" }); }
      return Response.json(revoked ? { ...current, state: "revoked", available: false } : current);
    }); vi.stubGlobal("fetch", fetcher); await mount(); await click("撤销当前版本");
    expect(container.textContent).not.toContain("已撤销"); expect(container.textContent).not.toContain("批准当前版本并执行"); await click("重试原操作");
    expect(container.textContent).toContain("已撤销"); expect(mocks.stream).not.toHaveBeenCalled();
    const posts = fetcher.mock.calls.filter(([url]) => url.endsWith("/revoke")); expect(posts.length).toBe(2);
  });
  it("cannot display success after a source admission error even when a stream subsequently says done", async () => {
    let options: Options | undefined;
    mocks.stream.mockImplementation(async (_prompt: string, received: Options) => { options = received; return mocks.abort; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(current))); await mount(); await click("批准当前版本并执行");
    expect(options).toMatchObject({ provider: "pi", phase: "execute", planId, planVersion: version, chatId: taskId, taskId, workDir: current.workDir });
    expect(options?.planCommandId).toMatch(/^[a-f0-9-]{36}$/i);
    await act(async () => { options?.onUpdate?.({ type: "error", message: "Source revoked" }); options?.onDone?.(); });
    expect(container.textContent).toContain("执行未完成，没有标记为成功"); expect(container.textContent).not.toContain("本次执行流已结束"); expect(container.textContent).not.toContain("批准当前版本并执行");
  });
  it("does not expose late data from a previous owner", async () => {
    let resolve: ((value: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetcher); await mount(); const old = resolve;
    await mount("00000000-0000-4000-8000-000000000099"); await act(async () => old?.(Response.json(legacy)));
    expect(container.textContent).not.toContain("Synthetic proposal"); expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("displays a saved execution failure and cannot restart an approved version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...current, state: "approved", execution: { state: "failed", startedAt: "2026-10-20T00:00:00Z", finishedAt: "2026-10-20T00:00:01Z" } }))); await mount();
    expect(container.textContent).toContain("执行失败"); expect(container.textContent).toContain("已批准的版本不能再次启动");
    expect([...container.querySelectorAll("button")].some(item => item.textContent === "批准当前版本并执行")).toBe(false); expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("keeps a plan without a task read-only for execution and copies the displayed version", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...current, taskId: null }))); await mount();
    expect(findButton("批准当前版本并执行").disabled).toBe(true); expect(container.textContent).toContain("没有可绑定的原任务");
    await click("复制当前版本"); expect(writeText).toHaveBeenCalledWith(version); expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("exposes an inspection failure without rendering an actionable old proposal", async () => {
    let count = 0; vi.stubGlobal("fetch", vi.fn(async () => ++count === 1 ? Response.json({}, { status: 503 }) : Response.json(current))); await mount();
    expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(container.textContent).not.toContain("Synthetic proposal"); await click("刷新计划状态"); expect(container.textContent).toContain("Synthetic proposal");
  });
});
