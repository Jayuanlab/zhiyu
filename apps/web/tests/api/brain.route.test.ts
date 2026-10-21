import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authState = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
}));

const {
  createBrainMemoryCandidateMock,
  createBrainStateSnapshotMock,
  grantBrainAccessMock,
  listBrainCandidatesMock,
  listBrainMemoryMock,
  listBrainSnapshotsMock,
  reviewBrainMemoryMock,
  revokeBrainAccessMock,
  writeBrainMemoryMock,
} = vi.hoisted(() => ({
  createBrainMemoryCandidateMock: vi.fn(),
  createBrainStateSnapshotMock: vi.fn(),
  grantBrainAccessMock: vi.fn(),
  listBrainCandidatesMock: vi.fn(),
  listBrainMemoryMock: vi.fn(),
  listBrainSnapshotsMock: vi.fn(),
  reviewBrainMemoryMock: vi.fn(),
  revokeBrainAccessMock: vi.fn(),
  writeBrainMemoryMock: vi.fn(),
}));

vi.mock("@/app/(auth)/auth", () => ({
  auth: async () => (authState.user ? { user: authState.user } : null),
}));

vi.mock("@/lib/memory/continuity/state-snapshots", () => ({
  createBrainStateSnapshot: createBrainStateSnapshotMock,
  listBrainSnapshots: listBrainSnapshotsMock,
}));
vi.mock("@/lib/memory/governance/access-grants", () => ({
  createBrainAccessGrant: grantBrainAccessMock,
  deleteBrainAccessGrant: revokeBrainAccessMock,
}));
vi.mock("@/lib/memory/adapters/postgres/memory-records", () => ({ listBrainAccessGrantsForUser: vi.fn() }));
vi.mock("@/lib/memory/revision/writes", () => ({
  createMemoryCandidate: createBrainMemoryCandidateMock,
  reviewMemory: reviewBrainMemoryMock,
  writeMemory: writeBrainMemoryMock,
}));
vi.mock("@/lib/memory/retrieval/candidates", () => ({ listBrainMemoriesForUser: listBrainMemoryMock }));

function nextRequest(url: string) {
  return { nextUrl: new URL(url) } as any;
}

describe("Brain API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: "user-1" };
    createBrainMemoryCandidateMock.mockResolvedValue({ id: "candidate-1" });
    createBrainStateSnapshotMock.mockResolvedValue({ id: "snapshot-1" });
    grantBrainAccessMock.mockResolvedValue({ id: "grant-1" });
    listBrainCandidatesMock.mockResolvedValue([{ id: "candidate-1" }]);
    listBrainMemoryMock.mockResolvedValue([{ id: "memory-1" }]);
    listBrainSnapshotsMock.mockResolvedValue([{ id: "snapshot-1" }]);
    reviewBrainMemoryMock.mockResolvedValue({ id: "candidate-1", status: "verified" });
    revokeBrainAccessMock.mockResolvedValue({ deletedCount: 1 });
    writeBrainMemoryMock.mockResolvedValue({ id: "memory-1" });
  });

  it("lists and writes Brain memories for the authenticated user", async () => {
    const { GET, POST } = await import("@/app/api/brain/memories/route");
    const listResponse = await GET(
      nextRequest("http://localhost/api/brain/memories?statuses=active,verified"),
    );
    expect(await listResponse.json()).toEqual({ memories: [{ id: "memory-1" }] });
    expect(listBrainMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        statuses: ["active", "verified"],
      }),
    );

    const writeResponse = await POST(
      new Request("http://localhost/api/brain/memories", {
        method: "POST",
        body: JSON.stringify({
          subject: "Plan",
          content: "Follow the plan",
          evidenceRefs: ["event-1"],
        }),
      }) as any,
    );
    expect(await writeResponse.json()).toEqual({ memory: { id: "memory-1" } });
    expect(writeBrainMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requester: { type: "chat", userId: "user-1", id: "brain-api" },
        subject: "Plan",
        content: "Follow the plan",
        evidenceRefs: ["event-1"],
      }),
    );
  });

  it("creates and reviews Brain candidates", async () => {
    const candidatesRoute = await import("@/app/api/brain/candidates/route");
    const reviewRoute = await import(
      "@/app/api/brain/candidates/[id]/review/route"
    );

    await candidatesRoute.POST(
      new Request("http://localhost/api/brain/candidates", {
        method: "POST",
        body: JSON.stringify({
          subject: "Candidate",
          content: "Needs review",
        }),
      }) as any,
    );
    expect(createBrainMemoryCandidateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Candidate",
        content: "Needs review",
      }),
    );

    const response = await reviewRoute.POST(
      new Request("http://localhost/api/brain/candidates/candidate-1/review", {
        method: "POST",
        body: JSON.stringify({ decision: "confirmed", reason: "ok" }),
      }) as any,
      { params: Promise.resolve({ id: "candidate-1" }) },
    );
    expect(await response.json()).toEqual({
      memory: { id: "candidate-1", status: "verified" },
    });
    expect(reviewBrainMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "candidate-1",
        decision: "confirmed",
        reason: "ok",
      }),
    );
  });

  it("writes snapshots and manages grants", async () => {
    const snapshotsRoute = await import("@/app/api/brain/snapshots/route");
    const grantsRoute = await import("@/app/api/brain/grants/route");
    const grantRoute = await import("@/app/api/brain/grants/[id]/route");

    await snapshotsRoute.POST(
      new Request("http://localhost/api/brain/snapshots", {
        method: "POST",
        body: JSON.stringify({
          snapshotType: "work_state",
          content: { status: "ok" },
        }),
      }) as any,
    );
    expect(createBrainStateSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        snapshotType: "work_state",
        content: { status: "ok" },
      }),
    );

    await grantsRoute.POST(
      new Request("http://localhost/api/brain/grants", {
        method: "POST",
        body: JSON.stringify({
          subjectType: "work",
          subjectId: "work-1",
          scope: { type: "global" },
          permissions: ["reference"],
        }),
      }) as any,
    );
    expect(grantBrainAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        subjectType: "work",
        subjectId: "work-1",
        scope: { type: "global" },
      }),
    );

    const response = await grantRoute.DELETE(
      new Request("http://localhost/api/brain/grants/grant-1", {
        method: "DELETE",
      }) as any,
      { params: Promise.resolve({ id: "grant-1" }) },
    );
    expect(await response.json()).toEqual({ deletedCount: 1 });
    expect(revokeBrainAccessMock).toHaveBeenCalledWith({
      userId: "user-1",
      grantId: "grant-1",
    });
  });

  it("rejects unauthenticated requests", async () => {
    authState.user = null;
    const { GET } = await import("@/app/api/brain/memories/route");
    const response = await GET(nextRequest("http://localhost/api/brain/memories"));
    expect(response.status).toBe(401);
  });
});
