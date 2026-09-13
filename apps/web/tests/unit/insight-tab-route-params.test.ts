import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/insight-queries", () => ({ updateInsightTab: mocks.update, deleteInsightTab: mocks.remove }));
import { PUT, DELETE } from "@/app/api/insight-tabs/[tabId]/route";

describe("insight tab dynamic route parameters", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({ user: { id: "owner" } });
    mocks.update.mockResolvedValue({ id: "target" });
    mocks.remove.mockResolvedValue(true);
  });
  it("passes the resolved tabId and authenticated owner to update", async () => {
    const request = new Request("http://localhost/api/insight-tabs/target", { method: "PUT", body: JSON.stringify({ title: "updated" }) });
    expect((await PUT(request as NextRequest, { params: Promise.resolve({ tabId: "target" }) })).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ userId: "owner", tabId: "target", payload: { title: "updated" } });
  });
  it("passes the resolved tabId to deletion", async () => {
    expect((await DELETE(new Request("http://localhost/api/insight-tabs/target") as NextRequest, { params: Promise.resolve({ tabId: "target" }) })).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({ userId: "owner", tabId: "target" });
  });
  it("rejects unauthenticated deletion before accessing storage", async () => {
    mocks.remove.mockClear();
    mocks.auth.mockResolvedValue(null);
    expect((await DELETE(new Request("http://localhost/api/insight-tabs/target") as NextRequest, { params: Promise.resolve({ tabId: "target" }) })).status).toBe(401);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
