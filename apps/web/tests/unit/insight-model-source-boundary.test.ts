import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: { user: { id: "synthetic-owner" } } as { user: { id?: string } } | null,
  lookup: vi.fn(), update: vi.fn(), select: vi.fn(), compaction: vi.fn(), generate: vi.fn(), aiContext: vi.fn(),
}));
vi.mock("@/app/(auth)/auth", () => ({ auth: async () => mocks.session }));
vi.mock("@/lib/db/queries", () => ({ getInsightByIdForUser: mocks.lookup, updateInsightById: mocks.update, db: { select: mocks.select } }));
vi.mock("@/lib/insights/compaction", () => ({ runInsightCompaction: mocks.compaction }));
vi.mock("@/lib/ai/subagents/insights", () => ({ generateProjectInsights: mocks.generate }));
vi.mock("@/lib/ai/request-context", () => ({ setAIUserContextFromRequest: mocks.aiContext }));
vi.mock("@/lib/auth/remote-auth-utils", () => ({ verifyCronAuth: (request: Request, secret: string) => request.headers.get("authorization") === `Bearer ${secret}` }));
import { POST as understand } from "@/app/(chat)/api/insights/[id]/understand/route";
import { GET as weeklyGet, POST as weeklyPost } from "@/app/api/insights/maintenance/weekly/route";
import { LEGACY_INSIGHT_SOURCE_WARNING } from "@/lib/insights/source-protection";

const input = () => new Request("http://localhost/api/insights/synthetic-insight/understand", { method: "POST", body: JSON.stringify({ cloudAuthToken: "synthetic-never-used" }) });
const params = { params: Promise.resolve({ id: "synthetic-insight" }) };
describe("legacy insight Web model-source boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "synthetic-cron-only");
    mocks.session = { user: { id: "synthetic-owner" } };
    mocks.lookup.mockResolvedValue({ insight: { id: "synthetic-insight", description: "PRIVATE_STORED_BODY", details: [{ content: "PRIVATE_STORED_ATTACHMENT", attachments: [{ downloadUrl: "https://invalid.example/private" }] }] }, bot: { id: "synthetic-bot" } });
  });
  afterEach(() => {
    for (const operation of [mocks.update, mocks.select, mocks.compaction, mocks.generate, mocks.aiContext]) expect(operation).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it("keeps owner lookup first but never builds a prompt, invokes a model or updates insight state", async () => {
    const response = await understand(input(), params), body = await response.json();
    expect(mocks.lookup).toHaveBeenCalledWith({ userId: "synthetic-owner", insightId: "synthetic-insight" });
    expect(response.status).toBe(422);
    expect(body).toMatchObject({ code: "memory_source_required", detail: "legacy_insight_source_unregistered", error: LEGACY_INSIGHT_SOURCE_WARNING,
      sourceProtection: { status: "withheld", modelInvoked: false, domainStateUpdated: false } });
    expect(JSON.stringify(body)).not.toContain("PRIVATE_STORED");
  });
  it.each([null, { user: {} }])("rejects an unauthenticated owner before lookup: %j", async session => {
    mocks.session = session;
    expect((await understand(input(), params)).status).toBe(401);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("keeps foreign or missing insight 404 without source/body disclosure", async () => {
    mocks.lookup.mockResolvedValue(null);
    expect((await understand(input(), params)).status).toBe(404);
  });
  it("does not expose SQL/provider error text on ownership lookup failure", async () => {
    mocks.lookup.mockRejectedValue(new Error("PRIVATE_SQL_BODY"));
    const response = await understand(input(), params);
    expect(await response.text()).not.toContain("PRIVATE_SQL_BODY");
    expect(response.ok).toBe(false);
  });
  it.each([weeklyGet, weeklyPost])("keeps cron authentication ahead of the source gate", async handler => {
    const response = await handler(new Request("http://localhost/api/insights/maintenance/weekly"));
    expect(response.status).toBe(401);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it.each([weeklyGet, weeklyPost])("returns explicit 422 instead of success for authorized weekly maintenance", async handler => {
    const response = await handler(new Request("http://localhost/api/insights/maintenance/weekly", { headers: { authorization: "Bearer synthetic-cron-only" } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "memory_source_required", detail: "legacy_insight_source_unregistered", provider: "none" });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});
