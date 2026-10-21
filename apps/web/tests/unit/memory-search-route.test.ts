import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), search: vi.fn(), cache: vi.fn(), finalize: vi.fn(), client: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/ai/request-context", () => ({ extractCloudAuthToken: () => undefined }));
vi.mock("@/lib/memory", () => ({ createOwnerMemoryClient: mocks.client }));
vi.mock("@/lib/memory/search-cache", () => ({ cachedUnifiedMemorySearch: mocks.cache }));
vi.mock("@/lib/memory/retrieval/compatibility-discovery", () => ({ finalizeOwnerDiscovery: mocks.finalize }));
vi.mock("@/lib/memory/unified-search", () => ({ searchUnifiedMemory: mocks.search,
  normalizeUnifiedMemorySearchSources: (value: string[] | undefined) => value ?? ["memory"],
  clampUnifiedMemorySearchLimit: (value: number | undefined) => value ?? 10,
  clampUnifiedMemorySearchThreshold: (value: number | undefined) => value ?? 0.7 }));
import { POST } from "@/app/api/memory/search/route";

function request(body: unknown) { return new NextRequest("http://localhost/api/memory/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
const valid = { purpose: "discover", query: "Synthetic lookup", sources: ["memory"] };
describe("legacy memory search is explicit owner discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "synthetic-owner" } }); mocks.search.mockResolvedValue({ fresh: 1 });
    mocks.cache.mockImplementation(async (_input, load) => load()); mocks.finalize.mockImplementation(async (_owner, result) => ({ ...result, purpose: "discover", receipt: { id: "synthetic-receipt" } }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  it("classifies malformed JSON as caller input failure", async () => {
    const response = await POST(new NextRequest("http://localhost/api/memory/search", { method: "POST", body: "{" }));
    expect(response.status).toBe(400); expect(mocks.search).not.toHaveBeenCalled();
  });
  it("enforces the real transport budget on a chunked stream before parsing it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"query":"'));
      controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    const response = await POST(new NextRequest("http://localhost/api/memory/search", { method: "POST", body: stream }));
    expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ code: "memory_request_too_large" });
    expect(cancelled).toBe(true); expect(mocks.search).not.toHaveBeenCalled();
  });
  it("rejects malformed UTF-8 without entering a provider", async () => {
    const response = await POST(new NextRequest("http://localhost/api/memory/search", { method: "POST", body: new Uint8Array([0xff]) }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_memory_request" });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it.each([["recall purpose", { ...valid, purpose: "recall" }], ["query over 2000 characters", { ...valid, query: "q".repeat(2001) }], ["empty explicit sources", { ...valid, sources: [] }],
    ...["requester", "workId", "accessMode", "grant"].map(key => [key, { ...valid, [key]: "forged-authority" }])])("rejects %s", async (_label, body) => {
    expect((await POST(request(body))).status).toBe(400); expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.cache).not.toHaveBeenCalled();
  });
  it("always reads canonical discoveries afresh, even for the identical query", async () => {
    mocks.search.mockResolvedValueOnce({ fresh: 1 }).mockResolvedValueOnce({ fresh: 2 });
    expect(await (await POST(request(valid))).json()).toMatchObject({ fresh: 1, purpose: "discover" });
    expect(await (await POST(request(valid))).json()).toMatchObject({ fresh: 2, purpose: "discover" });
    expect(mocks.cache).not.toHaveBeenCalled(); expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.finalize).toHaveBeenNthCalledWith(1, "synthetic-owner", { fresh: 1 });
    expect(mocks.finalize).toHaveBeenNthCalledWith(2, "synthetic-owner", { fresh: 2 });
  });
  it("keeps auxiliary cache use separate and still finalizes owner discovery", async () => {
    const response = await POST(request({ ...valid, sources: ["graph"] })); expect(response.status).toBe(200);
    expect(mocks.cache).toHaveBeenCalledOnce(); expect(mocks.finalize).toHaveBeenCalledWith("synthetic-owner", { fresh: 1 });
  });
  it.each([403, 409, 503])("preserves safe typed status %i while withholding internal messages", async status => {
    mocks.finalize.mockRejectedValue(new MemoryModuleError("synthetic_memory_failure", status, "SECRET SQL BODY"));
    const response = await POST(request(valid)); expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Memory discovery is unavailable", code: "synthetic_memory_failure" });
  });
  it("reports an infrastructure or receipt failure as unavailable without returning the prepared body", async () => {
    mocks.finalize.mockRejectedValue(new Error("SECRET SQL BODY credential")); const response = await POST(request(valid));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Memory discovery is unavailable", code: "memory_discovery_unavailable" });
    expect(console.error).toHaveBeenCalledWith("[MemorySearch] Unified search failed", { code: "memory_discovery_unavailable" });
  });
  it.each([null, { user: {} }])("requires the actual session owner ID before any read (%j)", async session => {
    mocks.auth.mockResolvedValue(session); expect((await POST(request(valid))).status).toBe(401);
    expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.finalize).not.toHaveBeenCalled();
  });
});
