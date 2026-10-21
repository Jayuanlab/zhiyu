import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/remix-icon", () => ({ RemixIcon: () => null }));
vi.mock("@/components/markdown-with-citations", () => ({ MarkdownWithCitations: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
import { AgentPlanMessage } from "@/components/agent-plan-message";
describe("plan approval displayed state", () => {
  it("keeps an unapproved proposal pending and routes old plans to source review", () => {
    const html = renderToStaticMarkup(<AgentPlanMessage thought="Review current sources" plan={[{ step: 1, action: "Read" }]}
      currentStep={0} approvalStatus="pending_approval" requiresApproval planId="old-plan" />);
    expect(html).toContain("0 / 1");
    expect(html).toContain('href="/memory/plans/old-plan"');
    expect(html).toContain("核验来源后执行");
    expect(html).not.toContain("common.agentStatus.approveExecution");
  });
});
