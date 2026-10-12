import { describe, expect, it } from "vitest";
import { buildAgentToolMatrix } from "@/lib/agent-tools/matrix";

function findTool(
  matrix: ReturnType<typeof buildAgentToolMatrix>,
  name: string,
) {
  const tool = matrix.tools.find((item) => item.name === name);
  expect(tool, `expected tool ${name} to exist`).toBeTruthy();
  if (!tool) throw new Error(`expected tool ${name} to exist`);
  return tool;
}

describe("agent tool matrix", () => {
  it("supports public search in a workshop and keeps deny precedence", () => {
    const workshop = {autonomyLevel: "auto", modelConfig: {allowedTools: ["webSearch"]}, boundaryPolicy: {mode: "draft"}} as any;
    expect(findTool(buildAgentToolMatrix({runtime: "workshop", workshop}), "webSearch").availability).toBe("allow");
    workshop.modelConfig.disallowedTools = ["webSearch"];
    expect(findTool(buildAgentToolMatrix({runtime: "workshop", workshop}), "webSearch").availability).toBe("deny");
  });
  it("shows ordinary chat can create loop tasks but must approve external send", () => {
    const matrix = buildAgentToolMatrix({ runtime: "chat" });

    expect(findTool(matrix, "createLoopTask").availability).toBe("allow");
    const sendReply = findTool(matrix, "sendReply");
    expect(sendReply.availability).toBe("require_approval");
    expect(sendReply.confirmation?.surface).toBe("chat_confirm");
    expect(findTool(matrix, "Bash").availability).toBe("allow");
    expect(findTool(matrix, "frontend-design").availability).toBe("allow");
  });

  it("keeps workshop task creation as an owner-activated proposal", () => {
    const matrix = buildAgentToolMatrix({
      runtime: "workshop",
      workshopId: "workshop-1",
      workshop: {
        autonomyLevel: "draft",
        boundaryPolicy: {
          mode: "draft",
          externalMessages: "draft",
        },
      } as any,
    });

    expect(findTool(matrix, "createLoopTask").availability).toBe("disabled");
    const createTask = findTool(matrix, "workshopCreateLoopTask");
    expect(createTask.availability).toBe("require_approval");
    expect(createTask.confirmation?.surface).toBe("workshop_task_tab");
    const createDraft = findTool(matrix, "workshopCreateOutboxDraft");
    expect(createDraft.availability).toBe("require_approval");
    expect(createDraft.confirmation?.surface).toBe("workshop_outbox_tab");
    const recallFeedback = findTool(
      matrix,
      "workshopRecordMemoryRecallFeedback",
    );
    expect(recallFeedback.availability).toBe("allow");
    expect(recallFeedback.risk).toBe("low");
    const recallQuality = findTool(
      matrix,
      "workshopInspectMemoryRecallQuality",
    );
    expect(recallQuality.availability).toBe("allow");
    expect(recallQuality.risk).toBe("low");
    expect(findTool(matrix, "quantMarketDiscoverCandidates").availability).toBe(
      "allow",
    );
    const watchlistChange = findTool(matrix, "quantPaperProposeWatchlistChange");
    expect(watchlistChange.availability).toBe("allow");
    expect(watchlistChange.confirmation).toBeUndefined();
    expect(findTool(matrix, "douyinCheckAccount").availability).toBe("allow");
    expect(findTool(matrix, "douyinCreatePublishDraft").availability).toBe(
      "allow",
    );
    expect(findTool(matrix, "videoRenderInvestmentBrief").availability).toBe(
      "allow",
    );
    const douyinPublish = findTool(matrix, "douyinPublishApprovedDraft");
    expect(douyinPublish.availability).toBe("require_approval");
    expect(douyinPublish.confirmation?.surface).toBe("workshop_review_tab");
  });

  it("blocks workshop external drafts when the boundary blocks messages", () => {
    const matrix = buildAgentToolMatrix({
      runtime: "workshop",
      workshop: {
        autonomyLevel: "observe",
        boundaryPolicy: {
          mode: "observe",
          externalMessages: "blocked",
        },
      } as any,
    });

    expect(findTool(matrix, "workshopCreateOutboxDraft").availability).toBe(
      "deny",
    );
    expect(findTool(matrix, "wechatCreateReplyDraft").availability).toBe(
      "deny",
    );
  });

  it("shows PowerShell only when the Work explicitly grants it", () => {
    const base = { autonomyLevel: "draft", boundaryPolicy: { mode: "draft", externalMessages: "draft" } };
    const denied = buildAgentToolMatrix({ runtime: "workshop", workshop: { ...base, modelConfig: {} } as any });
    expect(findTool(denied, "PowerShell").availability).toBe("deny");
    const allowed = buildAgentToolMatrix({ runtime: "workshop", workshop: { ...base, modelConfig: { allowedTools: ["PowerShell"] } } as any });
    expect(findTool(allowed, "PowerShell").availability).toBe("allow");
  });

  it("denies loop self-replication and gates direct external sends", () => {
    const matrix = buildAgentToolMatrix({ runtime: "loop" });

    expect(findTool(matrix, "createLoopTask").availability).toBe("deny");
    const sendMessage = findTool(matrix, "wechatDesktopSendMessage");
    expect(sendMessage.availability).toBe("require_approval");
    expect(sendMessage.confirmation?.surface).toBe("loop_approval");
  });
});
