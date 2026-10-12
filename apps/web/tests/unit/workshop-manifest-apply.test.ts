// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { TextEncoder } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkshopManifestApply, findWorkshopManifestApplyReceipt } from "@/components/message/workshop-manifest-apply";
import { type NativeConversationSourceMessage, type WorkshopManifestHistoryReview } from "@/lib/ai/chat/native-conversation";

const chatId = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const yaml = "apiVersion: openzhiyu.ai/v1alpha1\r\nkind: Workshop\r\nmetadata:\r\n  name: frontier-learner\r\n  title: 强化学习前沿学习者  \r\n";
const hash = createHash("sha256").update(yaml, "utf8").digest("hex");
const review: WorkshopManifestHistoryReview = { state: "valid", assistantMessageId: "review-assistant", toolUseId: "review-call", manifestYaml: yaml, manifestName: "frontier-learner", title: "强化学习前沿学习者", reason: "latest_review_passed_only_not_created" };
const verified = { ok: true, status: "created_verified", workshop: { id, name: review.title }, manifestSha256: hash,
  reviewAssistantMessageId: review.assistantMessageId, reviewToolCallId: review.toolUseId, workshopUrl: "https://untrusted.example/" };
const fetchMock = vi.fn();
let root: Root, container: HTMLDivElement;

function reviewMessage(messageId: string, toolUseId: string, ok = true): NativeConversationSourceMessage {
  return { id: messageId, chatId, role: "assistant", parts: [{ type: "tool-native", toolName: "reviewWorkshopManifestYaml", toolUseId,
    status: "completed", toolInput: { manifestYaml: yaml }, toolOutput: { review: { ok, title: review.title } } }] };
}
function receiptMessage(value: unknown = verified, override: Record<string, unknown> = {}): NativeConversationSourceMessage {
  return { id: "apply-assistant", role: "assistant", chatId, parts: [{ type: "tool-native", toolName: "applyWorkshopManifestYaml", status: "completed", toolOutput: value, ...override }] };
}
async function mount(patch: Partial<Parameters<typeof WorkshopManifestApply>[0]> = {}) {
  await act(async () => { root.render(createElement(WorkshopManifestApply, { chatId, review, messages: [], ...patch })); });
}
async function click() { await act(async () => { container.querySelector("button")!.click(); }); }
function response(body: unknown, ok = true) { return { ok, status: ok ? 200 : 409, json: async () => body }; }

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("TextEncoder", TextEncoder);
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async (algorithm: string, bytes: Uint8Array) => {
    expect(algorithm).toBe("SHA-256"); const result = createHash("sha256").update(bytes).digest();
    return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  }) } });
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("direct reviewed Workshop application desktop UI", () => {
  it("posts only immutable review references and the exact UTF-8 hash, without a confirmation dialog", async () => {
    const confirm = vi.spyOn(window, "confirm"); fetchMock.mockResolvedValue(response(verified));
    await mount(); expect(container.textContent).toContain("应用到车间"); expect(container.textContent).not.toContain("尚未创建");
    await click();
    expect(confirm).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workshops/apply-reviewed-chat-manifest"); expect(options.method).toBe("POST"); expect(options.credentials).toBe("same-origin");
    expect(JSON.parse(options.body)).toEqual({ chatId, reviewAssistantMessageId: review.assistantMessageId, reviewToolCallId: review.toolUseId, manifestSha256: hash });
    expect(options.body).not.toContain("manifestYaml"); expect(options.body).not.toContain("userConfirmation");
    expect(container.textContent).toContain("智能体已创建并核对"); expect(container.textContent).not.toContain("应用到车间");
    expect(container.textContent).toContain("运行一次");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`/workshop?workId=${id}`); expect(container.innerHTML).not.toContain("untrusted.example");
    confirm.mockRestore();
  });

  it("submits once even for two rapid clicks and disables the action while awaiting its result", async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockReturnValue(new Promise(resolve => { finish = resolve; })); await mount();
    await act(async () => { const button = container.querySelector("button")!; button.click(); button.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(container.querySelector("button")?.disabled).toBe(true); expect(container.textContent).toContain("正在应用");
    await act(async () => { finish(response(verified)); });
    expect(container.textContent).not.toContain("应用到车间"); expect(container.textContent).toContain("运行一次");
  });

  it("makes an uncertain network result retryable with exactly the same request", async () => {
    fetchMock.mockRejectedValueOnce(Error("connection interrupted")).mockResolvedValueOnce(response(verified)); await mount(); await click();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("结果暂未确认"); expect(container.querySelector("button")?.disabled).toBe(false);
    await click(); expect(fetchMock).toHaveBeenCalledTimes(2); expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(container.textContent).toContain("智能体已创建并核对");
  });

  it("keeps committed-but-unread creation pending and offers safe receipt revalidation", async () => {
    fetchMock.mockResolvedValueOnce(response({ ...verified, ok: false, status: "created_readback_pending", workshopId: id, workshop: undefined, retrySafe: true }))
      .mockResolvedValueOnce(response(verified)); await mount(); await click();
    expect(container.textContent).toContain("创建结果待核对"); expect(container.textContent).not.toContain("已创建并核对");
    expect(container.querySelector("button")?.textContent).toBe("重试核对结果");
    await click(); expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(container.textContent).toContain("智能体已创建并核对");
  });

  it("displays an existing matching Native receipt instead of implying the draft has not been created", async () => {
    await mount({ messages: [receiptMessage(JSON.stringify(verified))] });
    expect(container.textContent).toContain("智能体已创建并核对"); expect(container.querySelector("button")).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("尚未创建");
  });

  it.each([
    { ...verified, manifestSha256: "0".repeat(64) }, { ...verified, reviewToolCallId: "other-review" },
    { ...verified, reviewAssistantMessageId: "other-assistant" }, { ...verified, workshop: { id: "../../unsafe" } },
  ])("does not promote a mismatched or invalid application response: %j", async body => {
    fetchMock.mockResolvedValue(response(body)); await mount(); await click();
    expect(container.textContent).not.toContain("已创建并核对"); expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(container.querySelector("button")?.disabled).toBe(false);
  });

  it("shows server rejection without silently succeeding and lets the owner retry", async () => {
    fetchMock.mockResolvedValue(response({ ok: false, error: "latest_review_changed", message: "配置已更新，请刷新对话后重新审核。" }, false));
    await mount(); await click(); expect(container.textContent).toContain("配置已更新"); expect(container.querySelector("button")?.textContent).toBe("重试应用");
    expect(container.textContent).not.toContain("已创建并核对");
  });

  it.each([{ state: "invalid" as const }, { state: "pending" as const }, { toolUseId: null }, { manifestYaml: null }])("does not create an entry for an unpassed or incomplete review: %j", async patch => {
    await mount({ review: { ...review, ...patch } }); expect(container.textContent).toBe(""); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables application while the current chat is running", async () => {
    await mount({ disabled: true }); expect(container.querySelector("button")?.disabled).toBe(true); await click(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores receipts from another chat, errored success, other YAML, and generic draft ok=true", () => {
    const messages = [
      { ...receiptMessage(), chatId: "another-chat" }, receiptMessage(verified, { status: "error" }),
      receiptMessage({ ...verified, manifestSha256: "other-yaml" }), receiptMessage({ ok: true, review: { ok: true } }),
    ];
    expect(findWorkshopManifestApplyReceipt(messages, chatId, review, hash)).toBeNull();
    expect(findWorkshopManifestApplyReceipt([receiptMessage({ status: "success", result: verified })], chatId, review, hash)).toEqual(verified);
  });

  it("keeps creation approval controls off the pure chat renderer", () => {
    const source = readFileSync(resolve("components/message/index.tsx"), "utf8");
    expect(source).not.toContain("WorkshopManifestApply");
    expect(source).not.toContain("latestWorkshopReview");
    expect(source).toContain("isWorkshopChatTool(part.toolName)");
  });
});
