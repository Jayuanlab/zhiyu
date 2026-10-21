import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), select: vi.fn(), where: vi.fn(), from: vi.fn(), limit: vi.fn(), read: vi.fn(), binary: vi.fn(), remove: vi.fn(), boundary: vi.fn(), directory: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/files/workspace/sessions", () => ({ readSessionFile: mocks.read, readSessionFileBinary: mocks.binary, deleteSessionFile: mocks.remove, getTaskSessionDir: mocks.directory }));
vi.mock("@/lib/files/workspace/listing-boundary", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/files/workspace/listing-boundary")>(), resolveSessionListingPath: mocks.boundary }));
import { GET, DELETE } from "@/app/api/workspace/file/[...path]/route";
import { WorkspaceListingBoundaryError } from "@/lib/files/workspace/listing-boundary";
const owner = "00000000-0000-4000-8000-000000000010", task = "00000000-0000-4000-8000-000000000001";
const params = (name = "notes.txt") => ({ params: Promise.resolve({ path: [task, name] }) });
const request = (method = "GET", headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3000/api/workspace/file/${task}/notes.txt`, { method,
  headers: { Host: "localhost:3000", Origin: "http://localhost:3000", ...headers } });
describe("legacy workspace file API requires its actual chat owner", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: owner } });
    const query = { from: mocks.from, where: mocks.where, limit: mocks.limit }; mocks.select.mockReturnValue(query); mocks.from.mockReturnValue(query); mocks.where.mockReturnValue(query); mocks.limit.mockResolvedValue([{ id: task }]);
    mocks.directory.mockReturnValue("synthetic-owner-root"); mocks.boundary.mockReturnValue("synthetic-owner-root/notes.txt");
    mocks.read.mockReturnValue("OWNER_ONLY_BODY"); mocks.binary.mockReturnValue(Buffer.from("OWNER_ONLY_BYTES")); mocks.remove.mockReturnValue(true);
  });
  it("does not probe or read a foreign/missing task's filesystem", async () => {
    mocks.limit.mockResolvedValue([]); const response = await GET(request(), params());
    expect(response.status).toBe(404); expect(await response.text()).not.toContain("OWNER_ONLY"); expect(mocks.boundary).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
    expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]).params).toEqual([task, owner]);
  });
  it("labels an owner UI read as legacy/unregistered and prevents shared caching", async () => {
    const response = await GET(request(), params()); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "OWNER_ONLY_BODY", sourceControl: "legacy_workspace_owner_view_only", modelUse: "unsupported_without_registered_source" });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("serves an owner binary only as a private attachment with a Unicode-safe filename", async () => {
    const response = await GET(request("GET", { Accept: "application/pdf" }), params("\u4e2d\u6587.pdf"));
    expect(response.status).toBe(200); expect(response.headers.get("content-disposition")).toContain("attachment;"); expect(response.headers.get("content-disposition")).toContain("%E4%B8%AD%E6%96%87.pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("content-security-policy")).toBe("sandbox");
  });
  it("does not read a path whose canonical boundary is rejected", async () => {
    mocks.boundary.mockImplementationOnce(() => { throw new WorkspaceListingBoundaryError(); });
    expect((await GET(request(), params("../secret"))).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.binary).not.toHaveBeenCalled();
  });
  it("does not delete on cross-site or foreign-owner requests", async () => {
    expect((await DELETE(request("DELETE", { "sec-fetch-site": "cross-site" }), params())).status).toBe(403);
    mocks.limit.mockResolvedValue([]); expect((await DELETE(request("DELETE"), params())).status).toBe(404); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("only dispatches an explicit same-origin owner deletion to the synthetic adapter", async () => {
    const response = await DELETE(request("DELETE"), params()); expect(response.status).toBe(200); expect(mocks.remove).toHaveBeenCalledWith(task, "notes.txt");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
