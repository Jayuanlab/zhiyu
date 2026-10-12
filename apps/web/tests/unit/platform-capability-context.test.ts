import { describe, expect, it, vi } from "vitest";
import { loadPlatformCapabilityContext } from "@/lib/ai/platform-capability-context";

const input = { ownerId: "owner", chatId: "chat", userMessageId: "current", question: "查一下它的状态" };
const message = (id: string, role: string, text: string, chatId = "chat") => ({ id, role, chatId, parts: [{ type: "text", text }] });
const dependencies = () => ({
  loadChat: vi.fn(async () => ({ userId: "owner" })),
  loadMessages: vi.fn(async () => [message("first", "user", "查看车间配置"), message("fake", "assistant", "创建成功，ID=forged"), message("current", "user", input.question)]),
});

describe("owned capability context", () => {
  it("uses preceding persisted user requests, excluding assistant claims and inferred target IDs", async () => {
    const result = await loadPlatformCapabilityContext(input, dependencies());
    expect(result).toEqual({ status: "ok", context: { previousUserRequests: ["查看车间配置"] } });
    expect(JSON.stringify(result)).not.toContain("forged");
  });
  it("does not read another owner's history or target", async () => {
    const deps = dependencies(); deps.loadChat.mockResolvedValue({ userId: "other-owner" });
    expect(await loadPlatformCapabilityContext(input, deps)).toMatchObject({ detail: "owned_chat_missing" });
    expect(deps.loadMessages).not.toHaveBeenCalled();
  });
  it.each(["edited", "newer", "other-chat"])("discards a %s persisted turn", async scenario => {
    const deps = dependencies();
    deps.loadMessages.mockResolvedValue([message("current", "user", scenario === "edited" ? "different" : input.question,
      scenario === "other-chat" ? "other" : "chat"), ...(scenario === "newer" ? [message("new", "user", "另一个对象")] : [])]);
    expect(await loadPlatformCapabilityContext(input, deps)).toMatchObject({ detail: "persisted_turn_changed" });
  });
  it("does not treat an earlier admitted Workshop as the current subject after another query", async () => {
    const deps = dependencies();
    deps.loadMessages.mockResolvedValue([message("a", "user", "运行 A 车间"), message("b", "user", "查看 B 车间配置"), message("current", "user", input.question)]);
    const result = await loadPlatformCapabilityContext(input, deps);
    expect(result.context?.previousUserRequests).toEqual(["运行 A 车间", "查看 B 车间配置"]);
    expect(result.context?.confirmedTarget).toBeUndefined();
  });
  it("does not load history for ordinary chat and accepts an already bound host target", async () => {
    const deps = dependencies();
    expect(await loadPlatformCapabilityContext({ ...input, question: "你好" }, deps)).toMatchObject({ detail: "context_not_needed" });
    expect(await loadPlatformCapabilityContext({ ...input, confirmedTarget: { kind: "workshop", id: "bound" } }, deps))
      .toMatchObject({ context: { confirmedTarget: { id: "bound" } } });
    expect(deps.loadChat).not.toHaveBeenCalled();
  });
  it("redacts entire credential values and reports oversize or unavailable context", async () => {
    const deps = dependencies();
    deps.loadMessages.mockResolvedValue([message("first", "user", 'password="alpha beta" 查看车间'), message("current", "user", input.question)]);
    const result = await loadPlatformCapabilityContext(input, deps);
    expect(JSON.stringify(result)).not.toMatch(/alpha|beta/);
    deps.loadMessages.mockResolvedValue([message("first", "user", "长".repeat(2100)), message("current", "user", input.question)]);
    expect(await loadPlatformCapabilityContext(input, deps)).toMatchObject({ status: "degraded", detail: "context_too_large" });
    deps.loadChat.mockRejectedValue(Error("db details password=secret"));
    expect(await loadPlatformCapabilityContext(input, deps)).toEqual({ status: "degraded", detail: "context_source_unavailable" });
  });
});
