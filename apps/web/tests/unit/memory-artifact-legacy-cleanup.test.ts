import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cleanup: vi.fn(), messages: vi.fn(), update: vi.fn(), saved: vi.fn() }));
vi.mock("@/lib/files/monitoring", () => ({ cleanupBlob: mocks.cleanup }));
vi.mock("@/lib/db/queries", () => ({ getMessagesWithAttachmentsBefore: mocks.messages, updateMessageFileMetadata: mocks.update }));
vi.mock("@/lib/db/storageService", () => ({ getSavedBlobPathSet: mocks.saved }));
import { cleanupStaleAttachments } from "@/lib/files/cleanup";
describe("legacy attachment retention reports actual object cleanup failures", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.saved.mockResolvedValue(new Set()); mocks.update.mockResolvedValue(undefined);
    mocks.messages.mockResolvedValue([{ id: "synthetic-message", attachments: [{ blobPath: "legacy/object.txt", url: "https://example.invalid/old" }], parts: [] }]);
  });
  it("does not count a false adapter result as a successful deletion", async () => {
    mocks.cleanup.mockResolvedValue(false);
    const result = await cleanupStaleAttachments({ now: new Date("2026-10-20T00:00:00Z") });
    expect(result.deletedBlobPaths).toEqual([]); expect(result.errors).toEqual([{ target: "legacy/object.txt", error: expect.stringContaining("not confirmed") }]);
  });
  it("only counts an explicitly confirmed cleanup result", async () => {
    mocks.cleanup.mockResolvedValue(true);
    const result = await cleanupStaleAttachments({ now: new Date("2026-10-20T00:00:00Z") });
    expect(result.deletedBlobPaths).toEqual(["legacy/object.txt"]); expect(result.errors).toEqual([]);
  });
});
