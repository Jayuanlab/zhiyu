import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const authState = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
}));

const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const addWorkDirectiveMock = vi.hoisted(() => vi.fn());
const getWorkshopMock = vi.hoisted(() => vi.fn());
const getDouyinPublishDraftMock = vi.hoisted(() => vi.fn());
const prepareDouyinUploadMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/(auth)/auth", () => ({
  auth: async () => (authState.user ? { user: authState.user } : null),
}));

vi.mock("@/lib/douyin/client", () => ({
  getDouyinPublishDraft: getDouyinPublishDraftMock,
  prepareDouyinUpload: prepareDouyinUploadMock,
}));

vi.mock("@/lib/work-runtime", () => ({
  addWorkDirective: addWorkDirectiveMock,
  assertWorkAccess: getWorkshopMock,
}));

vi.mock("@/lib/workshops/service", () => ({
  appendWorkshopEvent: appendWorkshopEventMock,
  getWorkshop: getWorkshopMock,
}));

import { POST } from "@/app/api/workshops/[id]/video-reviews/[draftId]/route";

describe("workshop video review API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: "user-1" };
    getWorkshopMock.mockResolvedValue({
      id: "workshop-1",
      userId: "user-1",
      name: "投研视频发布官",
    });
    getDouyinPublishDraftMock.mockResolvedValue({
      draft: {
        id: "draft-1",
        title: "7月30日复盘",
        status: "draft",
        video_path: "C:/videos/old.mp4",
        topics: ["模拟盘"],
        account_label: "default",
      },
    });
    appendWorkshopEventMock.mockResolvedValue({
      id: "event-1",
      type: "video_review_regenerate_requested",
    });
    addWorkDirectiveMock.mockResolvedValue({
      directive: {id: "directive-1", content: "主人要求重生成投研视频"},
      run: {id: "run-1", workshopId: "workshop-1", status: "queued", startedAt: null},
      runError: null,
    });
  });

  it("queues a directive and run when a video is requested for regeneration", async () => {
    const request = new Request(
      "http://localhost/api/workshops/workshop-1/video-reviews/draft-1",
      {
        method: "POST",
        body: JSON.stringify({
          action: "regenerate",
          note: "字幕太短，内容需要更完整",
        }),
      },
    );

    const response = await POST(request as never, {
      params: Promise.resolve({ id: "workshop-1", draftId: "draft-1" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(addWorkDirectiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workId: "workshop-1",
        priority: 100,
        scope: "current_run",
        content: expect.stringContaining("videoRenderInvestmentBrief"),
      }),
    );
    expect(addWorkDirectiveMock.mock.calls[0][0].content).toContain(
      "字幕太短，内容需要更完整",
    );
    expect(addWorkDirectiveMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      workId: "workshop-1",
      triggerRun: true,
      content: expect.stringContaining("不要复用被要求重生成的旧视频文件"),
      triggerReason: expect.objectContaining({
        origin: "video_review_regenerate",
        reviewEventId: "event-1",
        draftId: "draft-1",
      }),
    }));
    expect(payload.run.id).toBe("run-1");
    expect(payload.directive.id).toBe("directive-1");
    expect(payload.run.status).toBe("queued");
    expect(payload.run.startedAt).toBeNull();
  });
});
