import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workshop, WorkshopOutboxItem } from "@/lib/db/schema";

const now = new Date("2026-08-03T00:00:00.000Z");
const workshop = vi.hoisted(
  () => {
    const date = new Date("2026-08-03T00:00:00.000Z");
    return (
    ({
      id: "work-1",
      userId: "user-1",
      name: "投研发布官",
      mission: "发布投研内容。",
      status: "active",
      autonomyLevel: "draft",
      boundaryPolicy: {},
      modelConfig: {},
      createdAt: date,
      updatedAt: date,
    }) as Workshop
    );
  },
);
const outbox = vi.hoisted(
  () => {
    const date = new Date("2026-08-03T00:00:00.000Z");
    return (
    ({
      id: "outbox-1",
      workshopId: "work-1",
      runId: null,
      channel: "wechat_desktop",
      recipientName: "主人",
      message: "请确认发布。",
      status: "approved",
      confidence: 80,
      riskLevel: "medium",
      sourceEventIds: [],
      boundaryResult: {},
      sentAt: null,
      createdAt: date,
      updatedAt: date,
    }) as WorkshopOutboxItem
    );
  },
);

const getWorkshopMock = vi.hoisted(() => vi.fn());
const addWorkshopSourceMock = vi.hoisted(() => vi.fn());
const getWorkshopOutboxItemMock = vi.hoisted(() => vi.fn());
const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const sendWorkshopOutboxWechatMock = vi.hoisted(() => vi.fn());
const approveOutboxSendMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/work-runtime/outbox-attempt", () => ({approveOutboxSend:approveOutboxSendMock}));

vi.mock("@/lib/workshops/service", () => ({
  getWorkshop: getWorkshopMock,
  addWorkshopSource: addWorkshopSourceMock,
  appendWorkshopEvent: appendWorkshopEventMock,
  getWorkshopOutboxItem: getWorkshopOutboxItemMock,
  addWorkshopMemory: vi.fn(),
  createOutboxDraft: vi.fn(),
  listWorkshopEvents: vi.fn(),
  listWorkshopMemories: vi.fn(),
  listWorkshopOutbox: vi.fn(),
  listWorkshopSources: vi.fn(),
  updateWorkshopOutboxItem: vi.fn(),
}));

vi.mock("@/lib/workshops/outbox-wechat", () => ({
  autoSendWorkshopOutboxIfWhitelisted: vi.fn(),
  previewWorkshopOutboxWechat: vi.fn(),
  sendWorkshopOutboxWechat: sendWorkshopOutboxWechatMock,
}));

import { addWorkSource, sendWorkOutbox } from "@/lib/work-runtime/resources";

describe("work runtime resources", () => {
  beforeEach(() => {
    approveOutboxSendMock.mockReset();
    approveOutboxSendMock.mockResolvedValue({});
    getWorkshopMock.mockReset();
    getWorkshopMock.mockResolvedValue(workshop);
    addWorkshopSourceMock.mockReset();
    addWorkshopSourceMock.mockResolvedValue({
      id: "source-1",
      workshopId: "work-1",
      type: "manual",
      name: "交易复盘资料",
      uri: null,
      content: "复盘内容",
      config: {},
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    getWorkshopOutboxItemMock.mockReset();
    getWorkshopOutboxItemMock.mockResolvedValue(outbox);
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock.mockResolvedValue({ id: "event-1" });
    sendWorkshopOutboxWechatMock.mockReset();
    sendWorkshopOutboxWechatMock.mockResolvedValue({
      ok: true,
      sent: true,
      outbox,
    });
  });

  it("adds a source through Work ownership and command metadata", async () => {
    const result = await addWorkSource({
      userId: "user-1",
      workId: "work-1",
      type: "manual",
      name: "交易复盘资料",
      content: "复盘内容",
      commandId: "cmd-source",
      source: "chat_agent",
      reason: "补充复盘资料。",
    });

    expect(result.source.id).toBe("source-1");
    expect(getWorkshopMock).toHaveBeenCalledWith("user-1", "work-1");
    expect(addWorkshopSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "work-1",
        name: "交易复盘资料",
        config: expect.objectContaining({
          commandMeta: expect.objectContaining({
            commandId: "cmd-source",
            source: "chat_agent",
          }),
        }),
      }),
    );
  });

  it("sends approved outbox through Work Runtime and records feedback", async () => {
    const result = await sendWorkOutbox({
      userId: "user-1",
      workId: "work-1",
      outboxId: "outbox-1",
      commandId: "cmd-send",
      expectedContentHash: "a".repeat(64),
      source: "owner",
      reason: "主人确认发送。",
    });

    expect(result.ok).toBe(true);
    expect(approveOutboxSendMock).toHaveBeenCalledWith({userId:"user-1",workId:"work-1",outboxId:"outbox-1",expectedContentHash:"a".repeat(64)});
    expect(sendWorkshopOutboxWechatMock).toHaveBeenCalledWith({
      workshop,
      outbox,
      auditActorId: "user-1",
    });
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "work-1",
        type: "work_outbox_send_requested",
        metadata: expect.objectContaining({
          outboxId: "outbox-1",
          commandMeta: expect.objectContaining({
            commandId: "cmd-send",
          }),
        }),
      }),
    );
  });
  it("rejects confirmation without the preview content hash before approval or send",async()=>{
    await expect(sendWorkOutbox({userId:"user-1",workId:"work-1",outboxId:"outbox-1"})).rejects.toThrow("Preview the current content");
    expect(approveOutboxSendMock).not.toHaveBeenCalled();
    expect(sendWorkshopOutboxWechatMock).not.toHaveBeenCalled();
  });
});
