import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), loadChat: vi.fn(), loadMessages: vi.fn(), apply: vi.fn(), read: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/chat-queries", () => ({ getChatById: mocks.loadChat, getMessagesByChatId: mocks.loadMessages }));
vi.mock("@/lib/workshops/manifest", () => ({ applyWorkshopManifest: mocks.apply }));
vi.mock("@/lib/workshops/service", () => ({ getWorkshop: mocks.read }));
vi.mock("@/lib/work-runtime/command-ledger", () => ({ WorkCommandConflict: class extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); }
} }));
import { POST } from "@/app/api/workshops/apply-reviewed-chat-manifest/route";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";

const ownerId = "owner-a";
const chatId = "chat-a";
const yaml = "kind: Workshop\nmetadata:\n  title: 强化学习前沿学习者\nspec:\n  loops:\n    - status: paused\n";
const manifestSha256 = createHash("sha256").update(yaml, "utf8").digest("hex");
const binding = { chatId, reviewAssistantMessageId: "assistant-a", reviewToolCallId: "review-a", manifestSha256 };
const messages = [{ id: binding.reviewAssistantMessageId, chatId, role: "assistant", parts: [{ type: "tool-native",
  toolName: "reviewWorkshopManifestYaml", toolUseId: binding.reviewToolCallId, status: "completed",
  toolInput: { manifestYaml: yaml }, toolOutput: { review: { ok: true } } }] }];
const workshop = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", userId: ownerId, name: "强化学习前沿学习者", mission: "Study research", status: "paused", autonomyLevel: "draft" };

function request(body: unknown = binding, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/workshops/apply-reviewed-chat-manifest", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: ownerId } });
  mocks.loadChat.mockResolvedValue({ userId: ownerId });
  mocks.loadMessages.mockResolvedValue(messages);
  mocks.apply.mockResolvedValue({ workshop, review: { ok: true }, created: { loops: 1, sources: 0 } });
  mocks.read.mockResolvedValue(workshop);
});

describe("direct reviewed chat manifest owner endpoint", () => {
  it("creates from server-persisted YAML with one button request and no confirmation message", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, status: "created_verified", workshop: { id: workshop.id }, manifestSha256, reviewAssistantMessageId: binding.reviewAssistantMessageId, reviewToolCallId: binding.reviewToolCallId });
    expect(mocks.loadChat).toHaveBeenCalledWith({ id: chatId });
    expect(mocks.loadMessages).toHaveBeenCalledTimes(2);
    expect(mocks.loadMessages).toHaveBeenCalledWith({ id: chatId, limit: 1001 });
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, manifestYaml: yaml, source: "chat_agent", commandId: expect.stringMatching(/^web-chat-manifest:[a-f0-9]{64}$/) }));
  });

  it("refuses unauthenticated requests and an actor change before accessing chat state", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: { id: ownerId } });
    const changed = await POST(request(binding, { "X-Work-Actor": "another-owner" }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "actor_changed" });
    expect(mocks.loadChat).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rejects another owner's conversation before reading the YAML", async () => {
    mocks.loadChat.mockResolvedValue({ userId: "other-owner" });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workshop_apply_chat_not_owned" });
    expect(mocks.loadMessages).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it.each([
    { ...binding, manifestYaml: "client replacement" }, { ...binding, confirmation: "approved" },
    { ...binding, commandId: "client-command" }, { ...binding, ownerId }, { chatId }, null, [binding],
  ])("does not accept extra action parameters or missing binding fields %j", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.loadChat).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("refuses cross-origin form requests before accessing state", async () => {
    expect((await POST(request(binding, { Origin: "http://another-site" }))).status).toBe(403);
    expect((await POST(request(binding, { "Content-Type": "text/plain" }))).status).toBe(400);
    expect(mocks.loadChat).not.toHaveBeenCalled();
  });

  it("uses the public Host when Next normalizes the request URL to an internal localhost address", async () => {
    const response = await POST(request(binding, { Host: "127.0.0.1:3515", Origin: "http://127.0.0.1:3515" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, status: "created_verified" });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("accepts the real loopback request even though NextURL rewrites its hostname", async () => {
    const loopback = new NextRequest("http://127.0.0.1:3515/api/workshops/apply-reviewed-chat-manifest", {
      method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:3515", Origin: "http://127.0.0.1:3515" },
      body: JSON.stringify(binding),
    });
    expect(loopback.nextUrl.origin).toBe("http://localhost:3515");
    const response = await POST(loopback);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, status: "created_verified" });
  });

  it("does not trust a forwarded host to permit a foreign Origin", async () => {
    const response = await POST(request(binding, {
      Host: "127.0.0.1:3515", Origin: "http://another-site", "X-Forwarded-Host": "another-site",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "cross_origin_request" });
    expect(mocks.loadChat).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rejects a stale hash and fresh draft changes before any application", async () => {
    const stale = await POST(request({ ...binding, manifestSha256: "0".repeat(64) }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "workshop_apply_draft_changed" });
    mocks.loadMessages.mockResolvedValueOnce(messages).mockResolvedValueOnce([{ ...messages[0], id: "changed-review" }]);
    const changed = await POST(request());
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "workshop_apply_draft_changed" });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("returns committed-but-unread state and retries the identical command payload", async () => {
    mocks.read.mockRejectedValueOnce(Error("read unavailable"));
    const pendingResponse = await POST(request());
    const pending = await pendingResponse.json();
    expect(pendingResponse.status).toBe(200);
    expect(pending).toMatchObject({ ok: false, status: "created_readback_pending", workshopId: workshop.id, retrySafe: true, manifestSha256 });
    expect(pending).not.toHaveProperty("workshop");
    const response = await POST(request(binding, { "X-Work-Actor": ownerId, Origin: "http://localhost" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, commandId: pending.commandId });
    expect(mocks.apply.mock.calls[0]).toEqual(mocks.apply.mock.calls[1]);
  });

  it("preserves command conflicts without inventing a Workshop receipt", async () => {
    mocks.apply.mockRejectedValue(new WorkCommandConflict("manifest_conflict"));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: "manifest_conflict" });
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
