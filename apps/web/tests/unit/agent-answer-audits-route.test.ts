import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), summary: vi.fn(), mirror: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/agent-answer-audits", async (original) => ({ ...await original<typeof import("@/lib/db/agent-answer-audits")>(), getAgentAnswerAuditSummary: mocks.summary, getAgentAnswerBodyMirror: mocks.mirror }));
vi.mock("@/lib/db/client", () => ({ db: {}, withDatabaseTransaction: vi.fn() }));
import { GET } from "@/app/api/native/answer-audits/[turnId]/route";
import { AgentAnswerAuditError } from "@/lib/db/agent-answer-audits";
const context = { params: Promise.resolve({ turnId: "turn" }) };
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "owner" } }); });
describe("owner answer audit GET", () => {
  it("requires authentication and does not reveal a different owner's turn", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost"), context)).status).toBe(401);
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue({ user: { id: "owner" } }); mocks.summary.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost"), context)).status).toBe(404);
    expect(mocks.summary).toHaveBeenCalledWith({ ownerId: "owner", turnId: "turn" });
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
  it("passes the authenticated owner and returns storage state separately from audit completion", async () => {
    const summary = { turnId: "turn", chatId: "chat", assistantMessageId: "message", status: "completed", finalText: "answer" };
    mocks.summary.mockResolvedValue(summary);
    const bodyMirror = { schemaVersion: "answer-body-mirror.v1", state: "not_confirmed", reason: "message_not_found", observedAt: "2026-10-04T00:00:00Z" };
    mocks.mirror.mockResolvedValue(bodyMirror);
    const response = await GET(new Request("http://localhost"), context);
    expect(await response.json()).toMatchObject({ status: "completed", bodyMirror });
    expect(mocks.mirror).toHaveBeenCalledWith({ ownerId: "owner", summary });
  });
  it("returns running state without marking it completed and disables caching", async () => {
    mocks.summary.mockResolvedValue({ turnId: "turn", chatId: "chat", assistantMessageId: "message", status: "running" });
    const response = await GET(new Request("http://localhost"), context);
    expect(await response.json()).toMatchObject({ status: "running", queryUrl: "/api/native/answer-audits/turn" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("surfaces validation and storage failure with no raw error data", async () => {
    mocks.summary.mockRejectedValue(new AgentAnswerAuditError("invalid_audit_request", 400, "Invalid turnId"));
    expect((await GET(new Request("http://localhost"), context)).status).toBe(400);
    mocks.summary.mockRejectedValue(new Error("postgres://secret"));
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
