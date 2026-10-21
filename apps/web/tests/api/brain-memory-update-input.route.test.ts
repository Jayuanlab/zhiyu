import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const f = vi.hoisted(() => ({ authenticated: true, storage: vi.fn(() => { throw new Error("Unexpected storage access"); }) }));
vi.mock("@/app/(auth)/auth", () => ({ auth: async () => f.authenticated ? { user: { id: "authenticated-owner" } } : null }));
vi.mock("@/lib/db/client", () => ({ db: { select: f.storage, transaction: f.storage } }));
import { POST as propose } from "@/app/api/brain/memory-updates/route";
import { POST as decide } from "@/app/api/brain/memory-updates/[id]/decision/route";
const memoryId = "00000000-0000-4000-a000-000000000001";
const version = `bmrv1:${"a".repeat(64)}`;
const request = (body: unknown) => new NextRequest("http://localhost/api/brain/memory-updates", { method: "POST", body: JSON.stringify(body) });
const context = { params: Promise.resolve({ id: memoryId }) };
beforeEach(() => { vi.clearAllMocks(); f.authenticated = true; });

describe("legacy memory update routes use Memory domain validation", () => {
  it("requires authentication before real proposal or decision validation", async () => {
    f.authenticated = false;
    expect((await propose(request({}))).status).toBe(401);
    expect((await decide(request({}), context)).status).toBe(401);
    expect(f.storage).not.toHaveBeenCalled();
  });

  it.each([{ userId: "forged-owner" }, { status: "active" }, { metadata: { authority: "owner" } }])("rejects proposal identity injection with unchanged JSON errors: %j", async patch => {
    const response = await propose(request({ targetMemoryId: memoryId, expectedVersion: version, commandId: "proposal-command",
      content: "New understanding", reason: "New source", evidenceRefs: [], ...patch }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_update", error: "Update cannot change identity, status or metadata" });
    expect(f.storage).not.toHaveBeenCalled();
  });

  it("retains decision evidence verification before any persisted mutation", async () => {
    const response = await decide(request({ commandId: "decision-command", action: "accept", expectedVersion: version,
      expectedBaseVersion: version, reason: "Unchecked source", evidenceConfirmed: false }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "evidence_verification_required" });
    expect(f.storage).not.toHaveBeenCalled();
  });
});
