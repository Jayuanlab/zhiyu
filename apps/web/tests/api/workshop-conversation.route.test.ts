import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(auth)/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/work-runtime/conversation", () => ({ listWorkConversation: vi.fn(), submitWorkConversation: vi.fn(),
  WorkConversationValidationError: class extends Error {} }));
vi.mock("@/lib/work-runtime/command-ledger", () => ({ WorkCommandConflict: class extends Error {
  constructor(public code: string) { super(code); }
  get status() { return this.code === "not_found" ? 404 : 409; }
} }));

import { auth } from "@/app/(auth)/auth";
import { GET, POST } from "@/app/api/workshops/[id]/conversation/route";
import { listWorkConversation, submitWorkConversation, WorkConversationValidationError } from "@/lib/work-runtime/conversation";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";

const workId = "b0252cc6-8e80-45fa-b125-ead5618bc4ad";
const context = { params: Promise.resolve({ id: workId }) };
function request(body: string, actor = "owner") {
  return new Request(`http://localhost/api/workshops/${workId}/conversation`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Work-Actor": actor }, body });
}

describe("Work conversation HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { id: "owner" } } as never);
    vi.mocked(listWorkConversation).mockResolvedValue({ version: 1, workId, turns: [], hasMore: false });
    vi.mocked(submitWorkConversation).mockResolvedValue({ turn: { id: "run-1" } } as never);
  });

  it("requires a session and returns private uncached conversation reads", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    expect((await GET(new Request("http://localhost"), context)).status).toBe(401);
    expect(listWorkConversation).not.toHaveBeenCalled();
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(listWorkConversation).toHaveBeenCalledWith({ userId: "owner", workId });
  });

  it("rejects actor changes, malformed JSON and arrays before accepting work", async () => {
    expect((await POST(request("{}", "different-owner"), context)).status).toBe(409);
    expect((await POST(request("["), context)).status).toBe(400);
    expect((await POST(request("[]"), context)).status).toBe(400);
    expect(submitWorkConversation).not.toHaveBeenCalled();
  });

  it("only trusts the authenticated owner and reports validation/ledger failures", async () => {
    const body = JSON.stringify({ commandId: "cmd-1", content: "处理文档", userId: "attacker", parentRunId: null });
    const response = await POST(request(body), context);
    expect(response.status).toBe(201);
    expect(submitWorkConversation).toHaveBeenCalledWith({ userId: "owner", workId, commandId: "cmd-1",
      content: "处理文档", parentRunId: null });
    vi.mocked(submitWorkConversation).mockRejectedValueOnce(new WorkConversationValidationError("任务内容过长"));
    expect((await POST(request(body), context)).status).toBe(400);
    vi.mocked(submitWorkConversation).mockRejectedValueOnce(new WorkCommandConflict("payload_conflict"));
    expect((await POST(request(body), context)).status).toBe(409);
    vi.mocked(listWorkConversation).mockRejectedValueOnce(new WorkCommandConflict("not_found"));
    expect((await GET(new Request("http://localhost"), context)).status).toBe(404);
  });
});
