import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/app/(auth)/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/workshops/review-assistant-service", () => ({ getReviewAssistant: vi.fn(), generateReviewAssistant: vi.fn(), getSavedReviewAssistantResult: vi.fn(),
  ReviewAssistantError: class extends Error { constructor(public code: string, public status: number) { super(code); } } }));
vi.mock("@/lib/workshops/review-assistant-decisions", () => ({ getReviewAssistantDecisions: vi.fn(), applyReviewAssistantDecisions: vi.fn(), restoreReviewAssistantDecision: vi.fn() }));
import { auth } from "@/app/(auth)/auth";
import { getReviewAssistant, generateReviewAssistant, getSavedReviewAssistantResult, ReviewAssistantError } from "@/lib/workshops/review-assistant-service";
import { getReviewAssistantDecisions, applyReviewAssistantDecisions, restoreReviewAssistantDecision } from "@/lib/workshops/review-assistant-decisions";
import { GET, POST, PATCH } from "@/app/api/workshops/[id]/review-assistant/route";
const workId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id: workId }) };
function request(body: unknown = { fingerprint: "a".repeat(64) }, actor = "owner") {
  return new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json", "X-Work-Actor": actor }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
describe("review assistant API ownership", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(auth).mockResolvedValue({ user: { id: "owner" } } as never);
    vi.mocked(getReviewAssistant).mockResolvedValue({ mode: "rules" } as never);
    vi.mocked(generateReviewAssistant).mockResolvedValue({ mode: "ai" } as never);
    vi.mocked(getReviewAssistantDecisions).mockResolvedValue([]);
    vi.mocked(getSavedReviewAssistantResult).mockResolvedValue(null); });
  it("requires authentication for reads and generation", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await GET(new Request("http://localhost"), context)).status).toBe(401);
    expect((await POST(request(), context)).status).toBe(401);
    expect(getReviewAssistant).not.toHaveBeenCalled(); expect(generateReviewAssistant).not.toHaveBeenCalled();
  });
  it("returns uncached private responses and binds owner only from session", async () => {
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(getReviewAssistant).toHaveBeenCalledWith({ userId: "owner", workId });
    expect((await POST(request(), context)).status).toBe(200);
    expect(generateReviewAssistant).toHaveBeenCalledWith({ userId: "owner", workId, fingerprint: "a".repeat(64) });
  });
  it("rejects actor changes, malformed inputs, client evidence and excessive bodies", async () => {
    expect((await POST(request({}, "someone-else"), context)).status).toBe(409);
    for (const body of ["[", [], { fingerprint: "a".repeat(64), userId: "other", items: [] }, "x".repeat(1025)]) {
      expect((await POST(request(body), context)).status).toBe(400);
    }
    expect(generateReviewAssistant).not.toHaveBeenCalled();
  });
  it("returns cross-work not-found and stale source conflicts without leaking details", async () => {
    vi.mocked(getReviewAssistant).mockRejectedValueOnce(new ReviewAssistantError("not_found", 404));
    expect((await GET(new Request("http://localhost"), context)).status).toBe(404);
    vi.mocked(generateReviewAssistant).mockRejectedValueOnce(new ReviewAssistantError("source_changed", 409));
    const response = await POST(request(), context);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "source_changed" });
  });
  it("records AI decisions after a current main-model result and returns the current review state", async () => {
    const result = { status: "ok" } as never;
    vi.mocked(getSavedReviewAssistantResult).mockResolvedValue(result);
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(applyReviewAssistantDecisions).toHaveBeenCalledWith({ userId: "owner", workId,
      fingerprint: "a".repeat(64), response: { mode: "ai" }, result });
    expect(getReviewAssistant).toHaveBeenCalledWith({ userId: "owner", workId });
  });
  it("restores only through the authenticated decision route", async () => {
    const body = { itemId: "33333333-3333-4333-8333-333333333333", decisionEventId: "44444444-4444-4444-8444-444444444444" };
    const restoreRequest = (value: unknown, actor = "owner") => new Request("http://localhost", { method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Work-Actor": actor }, body: JSON.stringify(value) });
    expect((await PATCH(restoreRequest(body, "other"), context)).status).toBe(409);
    expect((await PATCH(restoreRequest({ ...body, status: "approved" }), context)).status).toBe(400);
    expect(restoreReviewAssistantDecision).not.toHaveBeenCalled();
    expect((await PATCH(restoreRequest(body), context)).status).toBe(200);
    expect(restoreReviewAssistantDecision).toHaveBeenCalledWith({ userId: "owner", workId, ...body });
  });
});
