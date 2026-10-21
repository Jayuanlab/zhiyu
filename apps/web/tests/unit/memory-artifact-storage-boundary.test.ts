import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), auth: vi.fn(), document: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: vi.fn() } }));
vi.mock("@/lib/memory/artifacts/service", () => ({ saveUploadedArtifact: mocks.save }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/ai/rag/langchain-service", () => ({ getDocument: mocks.document }));
vi.mock("@/app/api/files/_handlers", () => ({ get: mocks.get }));
import { uploadFile } from "@/lib/storage";
import { GET } from "@/app/api/rag/documents/[documentId]/binary/route";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
const owner = "00000000-0000-4000-8000-000000000010", foreign = "00000000-0000-4000-8000-000000000020", id = "00000000-0000-4000-8000-000000000001";
describe("legacy storage and RAG originals enter the explicit owner artifact boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.save.mockResolvedValue({ manifest: { id, url: `/api/files/${id}` } });
    mocks.auth.mockResolvedValue({ user: { id: owner } }); mocks.get.mockResolvedValue(new Response("controlled-original"));
  });
  it("uses the trusted owner argument even when a logical pathname starts with another user", async () => {
    const result = await uploadFile({ userId: owner, pathname: `${foreign}/untrusted-path.txt`, data: Buffer.from("body"), contentType: "text/plain" });
    expect(mocks.save).toHaveBeenCalledWith(owner, expect.objectContaining({ name: "untrusted-path.txt", saveRecord: false }));
    expect(result.pathname).toBe(`artifact:${id}`); expect(result.url).toBe(`/api/files/${id}`);
  });
  it("rejects Work execution context before the upload service can write", async () => {
    await expect(withExecutionContext({ userId: owner, workshopId: id, runId: foreign, workerId: "test", token: 1 }, () => uploadFile({ userId: owner, pathname: "a.txt", data: Buffer.from("body"), contentType: "text/plain" })))
      .rejects.toMatchObject({ status: 403, code: "memory_owner_context_required" });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("checks document ownership before delegating a controlled original to its actual reader", async () => {
    mocks.document.mockResolvedValue({ userId: foreign, blobPath: `artifact:${id}` });
    const request = new Request(`http://localhost/api/rag/documents/${id}/binary`), params = { params: Promise.resolve({ documentId: id }) };
    expect((await GET(request, params)).status).toBe(404); expect(mocks.get).not.toHaveBeenCalled();
    mocks.document.mockResolvedValue({ userId: owner, blobPath: `artifact:${id}` });
    expect(await (await GET(request, params)).text()).toBe("controlled-original");
    expect((await mocks.get.mock.calls[0][1].params).id).toBe(id);
  });
  it("does not fetch arbitrary historical URLs or revive raw local paths", async () => {
    for (const path of ["https://example.invalid/public.bin", "owner/raw.bin", "../secret"]) {
      mocks.document.mockResolvedValue({ userId: owner, blobPath: path });
      expect((await GET(new Request(`http://localhost/api/rag/documents/${id}/binary`), { params: Promise.resolve({ documentId: id }) })).status).toBe(410);
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
