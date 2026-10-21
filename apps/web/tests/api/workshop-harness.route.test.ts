import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authState = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
}));
const getWorkshopMock = vi.hoisted(() => vi.fn());
const getWorkshopBaselineMock = vi.hoisted(() => vi.fn());
const resolveCurrentWorkHarnessMock = vi.hoisted(() => vi.fn());
const listLegacyHarnessProposalProjectionsMock = vi.hoisted(() => vi.fn());
const repository = vi.hoisted(() => ({
  getSummary: vi.fn(),
  getLatestSnapshot: vi.fn(),
  listEvidence: vi.fn(),
  listProposals: vi.fn(),
  listEvaluationCampaigns: vi.fn(),
}));

vi.mock("@/app/(auth)/auth", () => ({
  auth: async () => (authState.user ? { user: authState.user } : null),
}));

vi.mock("@/lib/workshops/service", () => ({
  getWorkshop: getWorkshopMock,
  getWorkshopConfigurationBaseline: getWorkshopBaselineMock,
}));

vi.mock("@/lib/harness-evolution", () => ({
  harnessEvolutionRepository: repository,
  isWorkHarnessEvolutionEnabled: () => true,
  resolveCurrentWorkHarness: resolveCurrentWorkHarnessMock,
  listLegacyHarnessProposalProjections:
    listLegacyHarnessProposalProjectionsMock,
}));

function request(url: string) {
  return { nextUrl: new URL(url) } as any;
}

const routeContext = {
  params: Promise.resolve({ id: "work-1" }),
};

describe("Work Harness API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: "user-1" };
    getWorkshopMock.mockResolvedValue({ id: "work-1", userId: "user-1" });
    getWorkshopBaselineMock.mockResolvedValue({ workshop: { id: "work-1", userId: "user-1", modelConfig: {} }, commandVersion: 7 });
    repository.getSummary.mockResolvedValue({
      activeSnapshot: {
        id: "snapshot-1",
        componentSetHash: "hash-1",
      },
      evidenceCount: 3,
      openProposalCount: 1,
      activeCampaignCount: 0,
    });
    repository.listEvidence.mockResolvedValue([]);
    repository.listProposals.mockResolvedValue([]);
    repository.listEvaluationCampaigns.mockResolvedValue([]);
    listLegacyHarnessProposalProjectionsMock.mockResolvedValue([]);
  });

  it("returns a lightweight summary without resolving or loading detail tabs", async () => {
    const { GET } = await import("@/app/api/workshops/[id]/harness/route");
    const response = await GET(
      request("http://localhost/api/workshops/work-1/harness?view=summary"),
      routeContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.interfaceVersion).toBe("work-harness-summary.v1");
    expect(payload.summary.evidenceCount).toBe(3);
    expect(resolveCurrentWorkHarnessMock).not.toHaveBeenCalled();
    expect(repository.getLatestSnapshot).not.toHaveBeenCalled();
    expect(repository.listEvidence).not.toHaveBeenCalled();
    expect(repository.listProposals).not.toHaveBeenCalled();
    expect(repository.listEvaluationCampaigns).not.toHaveBeenCalled();
  });

  it("checks Work ownership before loading evidence", async () => {
    getWorkshopMock.mockResolvedValue(null);
    const { GET } =
      await import("@/app/api/workshops/[id]/harness/evidence/route");
    const response = await GET(
      request("http://localhost/api/workshops/work-1/harness/evidence"),
      routeContext,
    );

    expect(response.status).toBe(404);
    expect(repository.listEvidence).not.toHaveBeenCalled();
  });

  it("returns the owned command version and validated memory binding for review", async () => {
    const { GET } = await import("@/app/api/workshops/[id]/harness/route");
    const response = await GET(request("http://localhost/api/workshops/work-1/harness?refresh=false"), routeContext);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(getWorkshopBaselineMock).toHaveBeenCalledWith("user-1", "work-1");
    expect(payload.commandVersion).toBe(7);
    expect(payload.memoryPolicy).toMatchObject({ bindingStatus: "unbound", issues: [], identity: { version: "memact-automem.v1" } });
    expect(resolveCurrentWorkHarnessMock).not.toHaveBeenCalled();
  });

  it("uses bounded list limits for lazy-loaded tabs", async () => {
    const evidenceRoute =
      await import("@/app/api/workshops/[id]/harness/evidence/route");
    const proposalRoute =
      await import("@/app/api/workshops/[id]/harness/proposals/route");
    const campaignRoute =
      await import("@/app/api/workshops/[id]/harness/evaluation-campaigns/route");

    await evidenceRoute.GET(
      request("http://localhost/api/workshops/work-1/harness/evidence"),
      routeContext,
    );
    await proposalRoute.GET(
      request(
        "http://localhost/api/workshops/work-1/harness/proposals?limit=999",
      ),
      routeContext,
    );
    await campaignRoute.GET(
      request(
        "http://localhost/api/workshops/work-1/harness/evaluation-campaigns?limit=invalid",
      ),
      routeContext,
    );

    expect(repository.listEvidence).toHaveBeenCalledWith("work-1", 20);
    expect(repository.listProposals).toHaveBeenCalledWith("work-1", 100);
    expect(listLegacyHarnessProposalProjectionsMock).toHaveBeenCalledWith(
      "work-1",
      100,
    );
    expect(repository.listEvaluationCampaigns).toHaveBeenCalledWith(
      "work-1",
      20,
    );
  });
});
