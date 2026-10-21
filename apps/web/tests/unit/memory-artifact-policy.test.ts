import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ db: { transaction: vi.fn() } }));
import { artifactDigest, verifyArtifactMedia } from "@/lib/memory/artifacts/policy";
import { artifactHttpRange, artifactIdFromReference, requireArtifactSameOrigin } from "@/lib/memory/artifacts/http";
import { artifactPublicManifest, artifactRef, requireArtifactOwner, type ArtifactRow } from "@/lib/memory/adapters/postgres/artifacts";
import { privateArtifactStore } from "@/lib/memory/artifacts/object-store";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
const owner = "00000000-0000-4000-8000-000000000010", id = "00000000-0000-4000-8000-000000000001";
function row(): ArtifactRow { return { id, userId: owner, commandId: "test", requestHash: "a".repeat(64), revision: 2, state: "active", provider: "private_local",
  objectKey: "PRIVATE_LOCATOR_MUST_NOT_ESCAPE", name: "\u8bb0\u5f55.txt", contentType: "text/plain", sizeBytes: 6, sha256: "b".repeat(64), expiresAt: new Date("2026-10-20T01:00:00Z"),
  quotaCharged: true, cleanupAttempts: 0, lastError: null, userFileId: null, metadata: { privateInternal: true }, createdAt: new Date("2026-10-20T00:00:00Z"), updatedAt: new Date("2026-10-20T00:01:00Z") }; }
const invalidAuthorityHeaders: Array<Record<string, string>> = [
  { Host: "127.0.0.1:3610", Origin: "http://127.0.0.1:3610", "sec-fetch-site": "cross-site" },
  { Host: "127.0.0.1:3610", Origin: "http://localhost:3610" },
  { Host: "127.0.0.1:3611", Origin: "http://127.0.0.1:3611" },
  { Host: "evil.invalid:3610", Origin: "http://evil.invalid:3610" },
  { Host: "127.0.0.1:3610" },
  { Origin: "http://localhost:3610" },
];
describe("private artifact boundaries", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("hashes the actual UTF-8 bytes and verifies text without corrupting Unicode", () => {
    const bytes = new TextEncoder().encode("\u4e2d\u6587\u{1f600}"); expect(bytes.byteLength).toBe(10);
    expect(() => verifyArtifactMedia(bytes, "text/plain")).not.toThrow(); expect(artifactDigest(bytes)).toMatch(/^[a-f0-9]{64}$/);
    expect(artifactDigest(bytes)).not.toBe(artifactDigest(bytes.subarray(0, 9)));
  });
  it.each(["image/png", "application/pdf", "application/zip"])("rejects a false %s MIME declaration", type => {
    expect(() => verifyArtifactMedia(new TextEncoder().encode("plain text"), type)).toThrow(expect.objectContaining({ code: "artifact_media_mismatch" }));
  });
  it("rejects invalid UTF-8 and executable unsupported media", () => {
    expect(() => verifyArtifactMedia(new Uint8Array([0xff]), "text/plain")).toThrow();
    expect(() => verifyArtifactMedia(new TextEncoder().encode("<svg/>"), "image/svg+xml")).toThrow(expect.objectContaining({ status: 415 }));
  });
  it("parses a single byte window including suffix and end clamping", () => {
    expect(artifactHttpRange("bytes=1-3", 6)).toEqual({ start: 1, end: 4 });
    expect(artifactHttpRange("bytes=-2", 6)).toEqual({ start: 4, end: 6 });
    expect(artifactHttpRange("bytes=2-100", 6)).toEqual({ start: 2, end: 6 });
    for (const range of ["bytes=6-", "bytes=-0", "bytes=3-1", "bytes=0-1,3-4", "bytes=9007199254740992-"]) expect(() => artifactHttpRange(range, 6)).toThrow();
  });
  it("accepts managed IDs and relative app URLs while rejecting arbitrary URLs and raw paths", () => {
    expect(artifactIdFromReference(`artifact:${id}`)).toBe(id); expect(artifactIdFromReference(`/api/files/${id}`)).toBe(id);
    for (const ref of [`https://evil.invalid/api/files/${id}`, "http://127.0.0.1/secret", "../private", "owner/object.bin"]) expect(artifactIdFromReference(ref)).toBeNull();
  });
  it("uses the real browser Host origin when Next normalizes a loopback URL hostname", () => {
    const request = new Request("http://localhost:3610/api/files/upload", { method: "POST", headers: { Host: "127.0.0.1:3610", Origin: "http://127.0.0.1:3610" } });
    expect(() => requireArtifactSameOrigin(request)).not.toThrow();
  });
  it.each(invalidAuthorityHeaders)("retains the shared browser rejection policy for missing or conflicting authority headers: %j", headers => {
    expect(() => requireArtifactSameOrigin(new Request("http://localhost:3610/api/files/upload", { method: "POST", headers }))).toThrow(expect.objectContaining({ status: 403 }));
  });
  it("does not leak a provider locator or internal metadata in public manifest DTOs", () => {
    const saved = row(), safe = artifactPublicManifest(saved); expect(safe.name).toBe("\u8bb0\u5f55.txt");
    expect(JSON.stringify(safe)).not.toContain(saved.objectKey); expect(JSON.stringify(safe)).not.toContain("privateInternal");
    expect(safe.url).toBe(`/api/files/${id}`); expect(safe.indexStatus).toBe("not_requested");
    saved.state = "deleting"; saved.metadata.cleanupIntent = { commandId: "original-cleanup", fromRevision: 2, requestHash: "PRIVATE_INTERNAL_HASH" };
    expect(artifactPublicManifest(saved).cleanupRecovery).toEqual({ commandId: "original-cleanup", expectedRevision: 2 });
    expect(JSON.stringify(artifactPublicManifest(saved))).not.toContain("PRIVATE_INTERNAL_HASH");
  });
  it("changes opaque versions when manifest MIME or business binding changes without relying on numeric revision alone", () => {
    const saved = row(), original = artifactRef(saved).revision;
    expect(artifactRef({ ...saved, contentType: "text/markdown" }).revision).not.toBe(original);
    expect(artifactRef({ ...saved, userFileId: owner }).revision).not.toBe(original);
  });
  it("rejects actual Work capabilities instead of treating their userId as owner file authority", () => {
    expect(() => withExecutionContext({ userId: owner, workshopId: id, runId: owner, workerId: "test", token: 1 }, () => requireArtifactOwner(owner)))
      .toThrow(expect.objectContaining({ status: 403, code: "memory_owner_context_required" }));
  });
  it("does not silently fall back to public storage or an unimplemented native provider", () => {
    vi.stubEnv("MEMORY_ARTIFACT_STORAGE_ROOT", ""); expect(() => privateArtifactStore()).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => privateArtifactStore("private_blob")).toThrow(expect.objectContaining({ status: 503 }));
    vi.stubEnv("IS_TAURI", "true"); expect(() => requireArtifactOwner(owner)).toThrow(expect.objectContaining({ code: "artifact_native_provider_unavailable" }));
  });
});
