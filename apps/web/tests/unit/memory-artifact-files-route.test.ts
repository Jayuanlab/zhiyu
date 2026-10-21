import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), current: vi.fn(), read: vi.fn(), upload: vi.fn(), resume: vi.fn(), save: vi.fn(), cleanup: vi.fn(), usage: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/memory", () => ({ createOwnerMemoryClient: vi.fn() }));
vi.mock("@/lib/db/storageService", () => ({ getUserStorageUsage: mocks.usage }));
vi.mock("@/lib/memory/artifacts/service", () => ({ readArtifactCurrent: mocks.current, readArtifact: mocks.read, saveUploadedArtifact: mocks.upload,
  resumeUploadedArtifact: mocks.resume, saveArtifactRecord: mocks.save, cleanupArtifactReference: mocks.cleanup }));
import { GET, HEAD } from "@/app/api/files/[id]/route";
import { POST as upload } from "@/app/api/files/upload/route";
import { POST as download } from "@/app/api/files/download/route";
import { POST as save } from "@/app/api/files/save/route";
const id = "00000000-0000-4000-8000-000000000001", owner = "00000000-0000-4000-8000-000000000010";
const manifest = { id, state: "active", revision: 2, name: "\u8bb0\u5f55\r\n.txt", sizeBytes: 6, contentType: "text/html", provider: "private_local", url: `/api/files/${id}`, userFileId: null, updatedAt: "2026-10-20T00:00:00Z" };
const params = { params: Promise.resolve({ id }) };
function ownerRequest(url: string, init: RequestInit) {
  const headers = new Headers(init.headers); headers.set("host", new URL(url).host); headers.set("origin", new URL(url).origin);
  return new Request(url, { ...init, headers });
}
describe("real file route adapters use only owner artifact capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: owner, type: "regular" } }); mocks.usage.mockResolvedValue({ usedBytes: 6, quotaBytes: 204800 });
    mocks.current.mockResolvedValue({ status: "ok", record: manifest, ref: { revision: "fixed-manifest" }, receipt: { id: "metadata-only" } });
    mocks.read.mockImplementation(async (_owner, input) => { const range = input.range ?? { start: 0, end: 6 }; return { status: "ok", manifest,
      bytes: new TextEncoder().encode("\u4e2d\u6587").slice(range.start, range.end), ref: { revision: "fixed-manifest" },
      receipt: { id: "actual-byte-receipt", actualRange: { ...range, unit: "bytes" }, totalLength: 6 } }; });
    mocks.upload.mockResolvedValue({ manifest, ref: {}, receipt: {}, replayed: false }); mocks.resume.mockResolvedValue({ manifest, ref: {}, receipt: {}, replayed: false });
  });
  afterEach(() => vi.restoreAllMocks());
  it("uses an authenticated range reader with actual byte headers, private cache policy and attachment disposition", async () => {
    const response = await GET(new Request(`http://localhost/api/files/${id}`, { headers: { Range: "bytes=0-2" } }), params);
    expect(response.status).toBe(206); expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("\u4e2d");
    expect(response.headers.get("content-range")).toBe("bytes 0-2/6"); expect(response.headers.get("x-memory-read-receipt")).toBe("actual-byte-receipt");
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''%E8%AE%B0%E5%BD%95.txt");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(mocks.read).toHaveBeenCalledWith(owner, { artifactId: id, range: { start: 0, end: 3 } });
  });
  it("does not claim an object byte read for HEAD", async () => {
    expect((await HEAD(new Request(`http://localhost/api/files/${id}`, { method: "HEAD" }), params)).status).toBe(200); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not return prepared bytes when the final reader or its receipt fails", async () => {
    mocks.read.mockRejectedValue(new Error("SECRET object locator")); const response = await GET(new Request(`http://localhost/api/files/${id}`), params);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("SECRET");
  });
  it("does not return bytes for a foreign or missing owner manifest", async () => {
    mocks.current.mockResolvedValue({ status: "not_found" }); expect((await GET(new Request(`http://localhost/api/files/${id}`), params)).status).toBe(404); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([download, save])("never fetches a caller-supplied URL through a compatibility route", async route => {
    const response = await route(ownerRequest("http://localhost/api/files/download", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/private" }) }));
    expect([400, 410]).toContain(response.status); expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("keeps Chinese filenames and stable commands on a new multipart upload", async () => {
    const form = new FormData(); form.append("file", new File(["\u4e2d\u6587"], "\u8bb0\u5f55.txt", { type: "text/plain" })); form.append("commandId", "stable-upload"); form.append("createRecord", "false");
    const response = await upload(ownerRequest("http://localhost/api/files/upload", { method: "POST", body: form })); expect(response.status).toBe(200);
    expect(mocks.upload).toHaveBeenCalledWith(owner, expect.objectContaining({ commandId: "stable-upload", name: "\u8bb0\u5f55.txt", saveRecord: false }));
    expect(new TextDecoder().decode(mocks.upload.mock.calls[0][1].data)).toBe("\u4e2d\u6587");
  });
  it("resumes an explicit existing manifest without calling begin/new-upload", async () => {
    const form = new FormData(); form.append("file", new File(["\u4e2d\u6587"], "\u8bb0\u5f55.txt", { type: "text/plain" }));
    form.append("commandId", "stable-resume"); form.append("createRecord", "true"); form.append("artifactId", id); form.append("expectedRevision", "0");
    expect((await upload(ownerRequest("http://localhost/api/files/upload", { method: "POST", body: form }))).status).toBe(200);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.resume).toHaveBeenCalledWith(owner, expect.objectContaining({ artifactId: id, expectedRevision: 0, commandId: "stable-resume", saveRecord: true }));
  });
  it("rejects duplicate or conflicting multipart command identity before saving", async () => {
    const duplicate = new FormData(); duplicate.append("file", new File(["x"], "a.txt", { type: "text/plain" })); duplicate.append("commandId", "one"); duplicate.append("commandId", "two");
    expect((await upload(ownerRequest("http://localhost/api/files/upload", { method: "POST", body: duplicate }))).status).toBe(400);
    const conflicting = new FormData(); conflicting.append("file", new File(["x"], "a.txt", { type: "text/plain" })); conflicting.append("commandId", "one");
    expect((await upload(ownerRequest("http://localhost/api/files/upload", { method: "POST", body: conflicting, headers: { "idempotency-key": "two" } }))).status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("does not ignore an arbitrary URL or conflicting typed reference when another ID is valid", async () => {
    for (const body of [{ artifactId: id, url: "https://evil.invalid/file" }, { artifactId: id, fileId: owner }]) {
      const response = await download(new Request("http://localhost/api/files/download", { method: "POST", body: JSON.stringify(body) }));
      expect([400, 410]).toContain(response.status);
    }
    expect(mocks.current).not.toHaveBeenCalled();
  });
  it("returns a safe invalid request response for malformed JSON", async () => {
    const response = await download(new Request("http://localhost/api/files/download", { method: "POST", body: "{" }));
    expect(response.status).toBe(400); expect((await response.json()).code).toBe("invalid_memory_request");
  });
});
