import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), lock: vi.fn(), replay: vi.fn(), persist: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: vi.fn() } }));
vi.mock("@/lib/memory/adapters/postgres/artifacts", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/memory/adapters/postgres/artifacts")>();
  return { ...original, withArtifactOwner: mocks.transaction, lockArtifact: mocks.lock, replayArtifactCommand: mocks.replay, persistArtifactCommand: mocks.persist };
});
import { reserveArtifactUploadIntent } from "@/lib/memory/artifacts/upload-intent";
const owner = "00000000-0000-4000-8000-000000000010", id = "00000000-0000-4000-8000-000000000001", store = {};
const input = { mode: "upload" as const, commandId: "stable-root-command", artifactId: id, saveRecord: false };
describe("durable multipart and resume command input", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.transaction.mockImplementation(async (_owner, _mode, callback) => callback(store));
    mocks.lock.mockResolvedValue({ id, revision: 0, state: "pending" }); mocks.replay.mockResolvedValue(null); mocks.persist.mockResolvedValue({ status: "recorded" });
  });
  it("records a pending intent under the owner lock before any object operation", async () => {
    await reserveArtifactUploadIntent(owner, input);
    expect(mocks.transaction).toHaveBeenCalledWith(owner, "update", expect.any(Function));
    expect(mocks.lock).toHaveBeenCalledWith(store, owner, id, "update");
    expect(mocks.persist).toHaveBeenCalledWith(store, expect.objectContaining({ action: "artifact.upload_intent", fromRevision: 0, row: expect.objectContaining({ state: "pending" }) }));
  });
  it("keeps one derived command identity while changed save intent or chat binding changes the request hash", async () => {
    await reserveArtifactUploadIntent(owner, input); const first = mocks.replay.mock.calls[0];
    await reserveArtifactUploadIntent(owner, { ...input, saveRecord: true }); const changed = mocks.replay.mock.calls[1];
    await reserveArtifactUploadIntent(owner, { ...input, chatId: owner, messageId: id }); const bound = mocks.replay.mock.calls[2];
    expect(changed[2]).toBe(first[2]); expect(bound[2]).toBe(first[2]); expect(changed[3]).not.toBe(first[3]); expect(bound[3]).not.toBe(first[3]);
  });
  it("binds a resume's original CAS version while preserving identity for a conflicting retry", async () => {
    await reserveArtifactUploadIntent(owner, { ...input, mode: "resume", expectedRevision: 0 }); const first = mocks.replay.mock.calls[0];
    await reserveArtifactUploadIntent(owner, { ...input, mode: "resume", expectedRevision: 1 }); const changed = mocks.replay.mock.calls[1];
    expect(changed[2]).toBe(first[2]); expect(changed[3]).not.toBe(first[3]);
  });
  it("returns a stored pending intent on replay and never persists another result", async () => {
    const replay = { status: "recorded", replayed: true }; mocks.replay.mockResolvedValue(replay);
    expect(await reserveArtifactUploadIntent(owner, input)).toBe(replay); expect(mocks.persist).not.toHaveBeenCalled(); expect(mocks.lock).not.toHaveBeenCalled();
  });
  it("does not swallow required intent receipt failure", async () => {
    mocks.persist.mockRejectedValue(new Error("synthetic-required-intent-receipt"));
    await expect(reserveArtifactUploadIntent(owner, input)).rejects.toThrow("synthetic-required-intent-receipt");
  });
});
