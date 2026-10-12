import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/work-runtime", () => ({
  listWorks: vi.fn(async () => ({ works: [] })),
  getWorkModelSnapshot: vi.fn(async () => ({ work: {
    manifest: { id: "work", name: "Research", role: "researcher" },
    controlContract: { deniedActions: ["sendMessage"] },
    skillBindings: { primarySkills: ["research"] },
    loopBindings: [],
    changeControl: { proposalSurface: "workshop_review_tab" },
    modelConfig: { apiKey: "synthetic-work-key" },
    runtime: { engine: "pi", credentials: { token: "synthetic-runtime-token" } },
  } })),
}));
vi.mock("@/lib/workshops/service", () => ({
  getWorkshop: vi.fn(),
  listWorkshops: vi.fn(async () => []),
}));

import { inspectWorkshopAgentForUser } from "@/lib/ai/workshop-agent-inspector";
import { getWorkModelSnapshot, listWorks } from "@/lib/work-runtime";
import { getWorkshop, listWorkshops } from "@/lib/workshops/service";

const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
function target(overrides: Record<string, unknown> = {}) {
  return { id, userId: owner, name: "Research", mission: "Research sources", status: "active",
    autonomyLevel: "draft", updatedAt: new Date("2026-10-09T00:00:00Z"),
    modelConfig: { role: "researcher", model: "example-model", allowedTools: ["webSearch"],
      apiKey: "synthetic-api-key", anthropicApiKey: "synthetic-anthropic-key", openaiApiKey: "synthetic-openai-key",
      manifestSpec: { modelConfig: { token: "synthetic-nested-token" } },
      primarySkills: [{ apiKey: "synthetic-array-key" }, "research"],
      arbitraryProvider: { credentials: "synthetic-provider-key" } },
    boundaryPolicy: { mode: "draft", externalMessages: "blocked", providerCredentials: { secret: "synthetic-boundary-key" } },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWorkshop).mockResolvedValue(null);
  vi.mocked(listWorkshops).mockResolvedValue([]);
  vi.mocked(listWorks).mockResolvedValue({ works: [] } as any);
});

describe("model-visible Workshop inspection boundaries", () => {
  it("uses an owner-scoped exact ID beyond the bounded discovery list and never returns secret configuration", async () => {
    vi.mocked(getWorkshop).mockResolvedValue(target());
    const result = await inspectWorkshopAgentForUser({ userId: owner, workshopId: id });
    expect(getWorkshop).toHaveBeenCalledWith(owner, id);
    expect(result.target?.id).toBe(id);
    expect(result.targetResolution).toBe("unique");
    expect(result.target?.modelConfig).toEqual(expect.objectContaining({ role: "researcher", model: "example-model", allowedTools: ["webSearch"] }));
    expect(result.work?.controlContract.deniedActions).toEqual(["sendMessage"]);
    const encoded = JSON.stringify(result);
    for (const secret of ["synthetic-api-key", "synthetic-anthropic-key", "synthetic-openai-key", "synthetic-nested-token",
      "synthetic-array-key", "synthetic-provider-key", "synthetic-boundary-key", "synthetic-work-key", "synthetic-runtime-token"]) {
      expect(encoded).not.toContain(secret);
    }
    expect(encoded).not.toContain("manifestSpec");
  });

  it("checks exact-name uniqueness independently of the first discovery page", async () => {
    vi.mocked(listWorks).mockResolvedValue({ works: [{ workshop: target() }] } as any);
    vi.mocked(listWorkshops).mockResolvedValue([target(), target({ id: "33333333-3333-4333-8333-333333333333" })]);
    const result = await inspectWorkshopAgentForUser({ userId: owner, workshopName: "Research" });
    expect(listWorkshops).toHaveBeenCalledWith(owner, 2, { exactName: "Research" });
    expect(result.targetResolution).toBe("ambiguous");
    expect(result.target).toBeNull();
    expect(getWorkModelSnapshot).not.toHaveBeenCalled();
  });

  it("does not select a partial name or fall back from an unknown ID to a name", async () => {
    vi.mocked(listWorks).mockResolvedValue({ works: [{ workshop: target({ name: "Research team" }) }] } as any);
    const partial = await inspectWorkshopAgentForUser({ userId: owner, workshopName: "Research" });
    expect(partial.targetResolution).toBe("not_found");
    vi.mocked(listWorkshops).mockClear();
    const missing = await inspectWorkshopAgentForUser({ userId: owner, workshopId: id, workshopName: "Research team" });
    expect(missing.targetResolution).toBe("not_found");
    expect(listWorkshops).not.toHaveBeenCalled();
    expect(getWorkModelSnapshot).not.toHaveBeenCalled();
  });

  it("rejects conflicting ID/name and foreign-owner targets before reading the Work model", async () => {
    vi.mocked(getWorkshop).mockResolvedValue(target());
    expect((await inspectWorkshopAgentForUser({ userId: owner, workshopId: id, workshopName: "Other" })).targetResolution)
      .toBe("conflicting_reference");
    vi.mocked(getWorkshop).mockResolvedValue(target({ userId: "another-owner" }));
    expect((await inspectWorkshopAgentForUser({ userId: owner, workshopId: id })).target).toBeNull();
    expect(getWorkModelSnapshot).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs without a database target query and exposes bounded-list coverage", async () => {
    vi.mocked(listWorks).mockResolvedValue({ works: Array.from({ length: 100 }, (_, index) => ({ workshop: target({ name: `Work ${index}` }) })) } as any);
    const result = await inspectWorkshopAgentForUser({ userId: owner, workshopId: "not-an-id" });
    expect(result.targetResolution).toBe("invalid_reference");
    expect(result.listingCoverage.completeness).toBe("partial_or_unknown");
    expect(getWorkshop).not.toHaveBeenCalled();
  });

  it("does not relay credentials from configuration/query exceptions to the model", async () => {
    vi.mocked(getWorkshop).mockRejectedValueOnce(new Error("provider apiKey=synthetic-error-key"));
    const error = await inspectWorkshopAgentForUser({ userId: owner, workshopId: id }).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("synthetic-error-key");
    expect(error.message).toContain("未完成目标与配置核验");
  });
});
