import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readArtifact } from "@/lib/memory/artifacts/service";
type ArtifactRead = typeof readArtifact;
const fixture = vi.hoisted(() => ({ read: vi.fn<ArtifactRead>() }));
vi.mock("@/lib/memory/artifacts/service", () => ({ readArtifact: fixture.read, revalidateArtifactInTransaction: vi.fn() }));
import { getMemoryArtifactForUser } from "@/lib/ai/brain-read-tools";
import { createNativePiWebChatToolDefinitions } from "@/lib/ai/native-pi-web-chat-tools";

const owner = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const revision = `artifact:${id}:2:${"a".repeat(64)}`, content = new TextEncoder().encode("A\u{1f600}B");
function evidence(start: number, end: number): Awaited<ReturnType<ArtifactRead>> {
  return { status: "ok", bytes: content.slice(start, end), manifest: { id, name: "synthetic.txt", contentType: "text/plain", sizeBytes: content.byteLength,
    sha256: "b".repeat(64), state: "active", revision: 2, expiresAt: "2026-10-21T00:00:00Z", cleanupAttempts: 0,
    lastError: null, userFileId: null, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", provider: "private_local", url: `/api/files/${id}`, indexStatus: "not_requested" },
    ref: { record: { kind: "artifact", id }, revision }, receipt: { id: "33333333-3333-4333-8333-333333333333", purpose: "evidence",
      ref: { record: { kind: "artifact", id }, revision }, actualRange: { start, end, unit: "bytes" }, totalLength: content.byteLength,
      sha256: "b".repeat(64), createdAt: "2026-10-20T00:00:00Z" },
    meta: { traceId: owner, contractVersion: "memory-artifact.v1", implementationVersion: "memory-t5.v1", provider: "postgres", detail: "private_artifact_manifest", warnings: [] } };
}
beforeEach(() => { fixture.read.mockReset(); fixture.read.mockImplementation(async (_owner, value) => {
  const { range } = value as { range: { start: number; end: number } }; return evidence(range.start, Math.min(range.end, content.byteLength));
}); });
describe("managed artifact model text adapter", () => {
  it("uses receipt byte windows while stopping at complete UTF-8 characters without skipping a continuation", async () => {
    const first = await getMemoryArtifactForUser({ userId: owner, url: `/api/files/${id}`, maxBytes: 4 });
    expect(first.ok).toBe(true); expect(first.data).toMatchObject({ content: "A", actualRange: { start: 0, end: 1 }, nextOffset: 1,
      receipt: { purpose: "evidence", actualRange: { start: 0, end: 4 } }, completeness: "byte_window" });
    const second = await getMemoryArtifactForUser({ userId: owner, artifactId: id, revision, offset: 1, maxBytes: 4 });
    expect(second.data).toMatchObject({ content: "\u{1f600}", nextOffset: 5, actualRange: { start: 1, end: 5 } });
    const last = await getMemoryArtifactForUser({ userId: owner, artifactId: id, revision, offset: 5 });
    expect(last.data).toMatchObject({ content: "B", nextOffset: null });
    expect(String(first.data?.content) + String(second.data?.content) + String(last.data?.content)).toBe("A\u{1f600}B");
  });
  it("does not infer arbitrary URL authority or report failed/metadata reads as content success", async () => {
    for (const url of [`https://example.invalid/api/files/${id}`, `/api/files/${id}?owner=other`, "/private/file.txt"]) {
      const result = await getMemoryArtifactForUser({ userId: owner, url }); expect(result.ok).toBe(false); expect(result.data).toMatchObject({ statusCode: 400 });
    }
    expect(fixture.read).not.toHaveBeenCalled();
    fixture.read.mockRejectedValueOnce(Error("SELECT secret FROM private; postgres://password"));
    const failed = await getMemoryArtifactForUser({ userId: owner, artifactId: id });
    expect(failed.ok).toBe(false); expect(failed.data).toMatchObject({ code: "memory_read_unavailable", statusCode: 503 });
    expect(failed.text).not.toMatch(/SELECT|secret|postgres|password/);
  });
  it("the actual native readonly tool refuses Work even if model arguments claim owner scope", async () => {
    const tool = createNativePiWebChatToolDefinitions({ userId: owner, memoryWorkId: "actual-work" }).find(row => row.name === "getMemoryArtifact")!;
    await expect(tool.execute({ artifactId: id, userId: owner, memoryWorkId: undefined, workId: undefined } as never,
      { toolCallId: "synthetic-artifact" })).rejects.toMatchObject({ status: 403, code: "memory_owner_context_required" });
    expect(fixture.read).not.toHaveBeenCalled();
  });
});
