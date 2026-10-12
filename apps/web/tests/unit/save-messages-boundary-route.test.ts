import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), save: vi.fn(), update: vi.fn(), title: vi.fn(), context: vi.fn(), clear: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/owned-chat-messages", () => ({ saveOwnedChatMessages: mocks.save, updateOwnedChatTitle: mocks.update }));
vi.mock("@/app/(chat)/actions", () => ({ generateTitleFromUserMessage: mocks.title }));
vi.mock("@/lib/ai/memory/chat-sync", () => ({ syncChatToFilesystem: vi.fn() }));
vi.mock("@/lib/ai/request-context", () => ({ setAIUserContextFromRequest: mocks.context }));
vi.mock("@/lib/ai", () => ({ clearAIUserContext: mocks.clear }));
vi.mock("@/lib/env", () => ({ isTauriMode: () => false }));
vi.mock("@/lib/db/client", () => ({ db: {}, withDatabaseTransaction: vi.fn() }));
import { POST } from "@/app/(chat)/api/chat/save-messages/route";
import { AgentAnswerAuditError } from "@/lib/db/agent-answer-audits";
const chatId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const body = { chatId, messages: [{ id, role: "user", parts: [{ type: "text", text: "内容" }] }], token: "not-used" };
function request(data: unknown = body) { return new Request("http://localhost/api/chat/save-messages", { method: "POST", body: JSON.stringify(data) }); }
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: chatId, email: "synthetic@example.invalid" } }); mocks.save.mockResolvedValue({ chat: { id: chatId, title: "内容", createdAt: new Date() }, created: false }); });
describe("save messages boundary", () => {
  it("delegates owner binding and never generates a title after an ownership or message conflict", async () => {
    for (const error of [new AgentAnswerAuditError("chat_not_owned", 403, "Chat not owned"), new AgentAnswerAuditError("message_identity_conflict", 409, "Message conflict")]) {
      mocks.save.mockRejectedValueOnce(error);
      const response = await POST(request()); expect(response.status).toBe(error.status);
      expect(await response.json()).toMatchObject({ code: error.code });
    }
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ ownerId: chatId, chatId }));
    expect(mocks.title).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed roles, arrays and JSON while clearing request context", async () => {
    expect((await POST(request({ ...body, messages: [{ id, role: "forged" }] }))).status).toBe(400);
    expect((await POST(request({ ...body, messages: [{ id, role: "user", attachments: "invalid" }] }))).status).toBe(400);
    const invalid = new Request("http://localhost", { method: "POST", body: "{" });
    expect((await POST(invalid)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.title).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledTimes(3);
  });
  it("accepts a valid saved user message without making a title model call", async () => {
    const response = await POST(request()); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, chat: { id: chatId } });
    expect(mocks.title).not.toHaveBeenCalled();
  });
});
