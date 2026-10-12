import { describe, expect, it } from "vitest";
import {
  canEndMemoryReviewRecovery, clearPendingMemoryReview, clearPendingMemoryRevision, memoryReviewRecoveryKey,
  memoryRevisionRecoveryKey, persistPendingMemoryReview, persistPendingMemoryRevision,
  readPendingMemoryReview, readPendingMemoryRevision,
  type PendingMemoryReview, type PendingMemoryRevision,
} from "@/components/memory-revision-recovery";

const memoryId = "00000000-0000-4000-8000-000000000001";
const nextId = "00000000-0000-4000-8000-000000000002";
const version = `bmrv1:${"a".repeat(64)}`;
const nextVersion = `bmrv1:${"b".repeat(64)}`;
const review: PendingMemoryReview = {
  kind: "memory_revision_review_pending.v1", ownerId: "owner", memoryId: nextId, expectedVersion: nextVersion,
};
const revision: PendingMemoryRevision = {
  kind: "memory_revision_pending.v1", ownerId: "owner", memoryId,
  request: { commandId: "original-command", expectedVersion: version, operation: "correct",
    authority: "external_fact", reason: "Source correction", content: "Corrected fact", evidenceRefs: ["source:1"] },
};

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("memory revision review recovery", () => {
  it("allows ending only a read-confirmed obsolete target, never an unchanged candidate or another memory", () => {
    expect(canEndMemoryReviewRecovery(review, { memoryId: nextId, expectedVersion: nextVersion, status: "candidate" })).toBe(false);
    expect(canEndMemoryReviewRecovery(review, { memoryId: nextId, expectedVersion: version, status: "candidate" })).toBe(true);
    expect(canEndMemoryReviewRecovery(review, { memoryId: nextId, expectedVersion: nextVersion, status: "deleted" })).toBe(true);
    expect(canEndMemoryReviewRecovery(review, { memoryId: nextId, expectedVersion: nextVersion, status: "superseded" })).toBe(true);
    expect(canEndMemoryReviewRecovery(review, { memoryId, expectedVersion: version, status: "deleted" })).toBe(false);
    expect(canEndMemoryReviewRecovery(review, { memoryId: nextId, expectedVersion: "malformed", status: "deleted" })).toBe(false);
  });

  it("retains an existing-version review after the original revision receipt is dismissed", () => {
    const store = storage();
    persistPendingMemoryRevision(store, revision);
    persistPendingMemoryReview(store, review);
    clearPendingMemoryRevision(store, "owner", revision.request.commandId);
    expect(readPendingMemoryRevision(store, "owner")).toBeNull();
    expect(readPendingMemoryReview(store, "owner")).toEqual(review);
    expect(JSON.parse(store.getItem(memoryReviewRecoveryKey("owner"))!)).not.toHaveProperty("request");
    expect(readPendingMemoryReview(store, "other-owner")).toBeNull();
  });

  it.each([
    { ...review, ownerId: "other-owner" },
    { ...review, memoryId: "invalid" },
    { ...review, expectedVersion: "invalid" },
    { ...review, commandId: "fabricated-command" },
    { ...review, request: revision.request },
  ])("refuses malformed or cross-owner review markers", value => {
    const store = storage();
    store.setItem(memoryReviewRecoveryKey("owner"), JSON.stringify(value));
    expect(() => readPendingMemoryReview(store, "owner")).toThrow();
  });

  it("does not replace an unresolved review of another target or version", () => {
    const store = storage();
    persistPendingMemoryReview(store, review);
    expect(() => persistPendingMemoryReview(store, { ...review, memoryId })).toThrow();
    expect(() => persistPendingMemoryReview(store, { ...review, expectedVersion: version })).toThrow();
    expect(readPendingMemoryReview(store, "owner")).toEqual(review);
  });

  it("requires durable readback before a review can be sent", () => {
    const store = storage();
    expect(() => persistPendingMemoryReview({ ...store, setItem: () => {} }, review)).toThrow();
    expect(() => persistPendingMemoryReview({ ...store, setItem: () => { throw new Error("Storage denied"); } }, review)).toThrow();
    expect(readPendingMemoryReview(store, "owner")).toBeNull();
  });

  it("clears only the exact owner, memory and version under review", () => {
    const store = storage();
    persistPendingMemoryReview(store, review);
    clearPendingMemoryReview(store, { ...review, memoryId });
    clearPendingMemoryReview(store, { ...review, expectedVersion: version });
    clearPendingMemoryReview(store, { ...review, ownerId: "other-owner" });
    expect(readPendingMemoryReview(store, "owner")).toEqual(review);
    clearPendingMemoryReview(store, review);
    expect(readPendingMemoryReview(store, "owner")).toBeNull();
  });

  it("preserves legacy nested review recovery without constructing a new revision request", () => {
    const store = storage();
    const legacy = { ...revision, reviewPending: { memoryId: nextId, expectedVersion: nextVersion } };
    persistPendingMemoryRevision(store, legacy);
    persistPendingMemoryReview(store, review);
    clearPendingMemoryReview(store, review);
    expect(readPendingMemoryRevision(store, "owner")).toEqual(legacy);
    expect(JSON.parse(store.getItem(memoryRevisionRecoveryKey("owner"))!).request.commandId).toBe("original-command");
  });
});
