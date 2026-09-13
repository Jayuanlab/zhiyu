import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workshop, WorkshopOutboxItem } from '@/lib/db/schema';

const previewWechatDesktopMessageMock = vi.hoisted(() => vi.fn());
const sendWechatDesktopMessageMock = vi.hoisted(() => vi.fn());
const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const updateWorkshopOutboxItemMock = vi.hoisted(() => vi.fn());
const resolvePermissionBoundaryReviewItemMock = vi.hoisted(() => vi.fn());
const upsertPermissionBoundaryReviewItemMock = vi.hoisted(() => vi.fn());
const executionWriteGuardMock = vi.hoisted(() => vi.fn());
const dispatchMock=vi.hoisted(()=>vi.fn());
const getOutboxMock=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/work-runtime/outbox-dispatch',()=>({dispatchOutboxAttempt:dispatchMock}));
vi.mock('@/lib/work-runtime/workshop-write',()=>({withWorkshopControlWrite:executionWriteGuardMock}));

vi.mock('@/lib/wechat-desktop/client', () => ({
  previewWechatDesktopMessage: previewWechatDesktopMessageMock,
  sendWechatDesktopMessage: sendWechatDesktopMessageMock,
}));

vi.mock('@/lib/workshops/service', () => ({
  appendWorkshopEvent: appendWorkshopEventMock,
  updateWorkshopOutboxItem: updateWorkshopOutboxItemMock,
  getWorkshopOutboxItem:getOutboxMock,
}));

vi.mock('@/lib/workshops/review-items', () => ({
  resolveWorkshopPermissionBoundaryReviewItem:
    resolvePermissionBoundaryReviewItemMock,
  upsertWorkshopPermissionBoundaryReviewItem:
    upsertPermissionBoundaryReviewItemMock,
}));

import { autoSendWorkshopOutboxIfWhitelisted } from '@/lib/workshops/outbox-wechat';

const now = new Date('2026-07-04T00:00:00.000Z');

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: 'workshop-1',
    userId: 'user-1',
    name: 'Research workshop',
    mission: 'Send research briefs',
    status: 'active',
    autonomyLevel: 'draft',
    boundaryPolicy: {
      externalMessages: 'draft',
      allowedRecipients: ['File Transfer'],
      allowWechatPreview: true,
      requireSourcesForOutbox: false,
      minConfidenceToDraft: 60,
      minConfidenceToSend: 75,
      maxMessageLength: 2000,
    },
    modelConfig: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

function outbox(
  overrides: Partial<WorkshopOutboxItem> = {},
): WorkshopOutboxItem {
  return {
    id: 'outbox-1',
    workshopId: 'workshop-1',
    runId: 'run-1',
    channel: 'wechat_desktop',
    recipientName: 'File Transfer',
    message: 'Research brief with source context and risks.',
    status: 'draft',
    confidence: 80,
    riskLevel: 'low',
    sourceEventIds: [],
    boundaryResult: {},
    sentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkshopOutboxItem;
}

describe('workshop outbox whitelist auto-send', () => {
  it('rejects a lost execution before preview, send, or failure-state writes',async()=>{
    executionWriteGuardMock.mockRejectedValueOnce(Error('lease_lost'));
    await expect(autoSendWorkshopOutboxIfWhitelisted({workshop:workshop(),outbox:outbox()})).rejects.toThrow('lease_lost');
    expect(previewWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(sendWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(updateWorkshopOutboxItemMock).not.toHaveBeenCalled();
    expect(appendWorkshopEventMock).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({status:'sent',provider_receipt:{ok:true}});
    getOutboxMock.mockReset();
    getOutboxMock.mockResolvedValue(outbox({status:'sent'}));
    executionWriteGuardMock.mockReset();
    executionWriteGuardMock.mockResolvedValue(undefined);
    previewWechatDesktopMessageMock.mockReset();
    sendWechatDesktopMessageMock.mockReset();
    appendWorkshopEventMock.mockReset();
    updateWorkshopOutboxItemMock.mockReset();
    resolvePermissionBoundaryReviewItemMock.mockReset();
    upsertPermissionBoundaryReviewItemMock.mockReset();

    previewWechatDesktopMessageMock.mockResolvedValue({
      confirmToken: 'confirm-token',
      expiresInSeconds: 300,
      preview: {
        recipientName: 'File Transfer',
        messageHash: 'hash-1',
      },
    });
    sendWechatDesktopMessageMock.mockResolvedValue({
      ok: true,
      sent: true,
      recipientName: 'File Transfer',
    });
    updateWorkshopOutboxItemMock.mockImplementation(
      async (_workshopId, _outboxId, input) => ({
        ...outbox(),
        ...input,
      }),
    );
    appendWorkshopEventMock.mockResolvedValue({});
    resolvePermissionBoundaryReviewItemMock.mockResolvedValue(null);
    upsertPermissionBoundaryReviewItemMock.mockResolvedValue(null);
  });

  it('sends immediately when auto mode, whitelist, and boundary all pass', async () => {
    const result = await autoSendWorkshopOutboxIfWhitelisted({
      workshop: workshop({
        autonomyLevel: 'auto',
        boundaryPolicy: {
          externalMessages: 'auto',
          allowedRecipients: ['File Transfer'],
          allowWechatPreview: true,
          requireSourcesForOutbox: false,
          minConfidenceToDraft: 60,
          minConfidenceToSend: 75,
          maxMessageLength: 2000,
        },
      }),
      outbox: outbox(),
    });

    expect(result.attempted).toBe(true);
    expect(result.reason).toBe('sent');
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({userId:'user-1',workId:'workshop-1',outboxId:'outbox-1',expectedContentHash:expect.stringMatching(/^[a-f0-9]{64}$/)}),undefined);
    expect(sendWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(updateWorkshopOutboxItemMock).not.toHaveBeenCalled();
  });

  it('keeps a whitelisted draft when the workshop requires approval', async () => {
    const result = await autoSendWorkshopOutboxIfWhitelisted({
      workshop: workshop(),
      outbox: outbox(),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('approval_required');
    expect(result).toMatchObject({
      boundary: { requiresApproval: true },
    });
    expect(previewWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(sendWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(updateWorkshopOutboxItemMock).not.toHaveBeenCalled();
  });

  it('keeps high-risk messages for approval even in auto mode', async () => {
    const result = await autoSendWorkshopOutboxIfWhitelisted({
      workshop: workshop({
        autonomyLevel: 'auto',
        boundaryPolicy: {
          externalMessages: 'auto',
          allowedRecipients: ['File Transfer'],
          allowWechatPreview: true,
          requireSourcesForOutbox: false,
          minConfidenceToDraft: 60,
          minConfidenceToSend: 75,
          maxMessageLength: 2000,
        },
      }),
      outbox: outbox({ riskLevel: 'high' }),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('approval_required');
    expect(result).toMatchObject({
      boundary: { requiresApproval: true },
    });
    expect(previewWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(sendWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(updateWorkshopOutboxItemMock).not.toHaveBeenCalled();
  });

  it('keeps the draft when the recipient is not whitelisted', async () => {
    const result = await autoSendWorkshopOutboxIfWhitelisted({
      workshop: workshop(),
      outbox: outbox({ recipientName: 'Someone Else' }),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('recipient_not_whitelisted');
    expect(previewWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(sendWechatDesktopMessageMock).not.toHaveBeenCalled();
    expect(updateWorkshopOutboxItemMock).not.toHaveBeenCalled();
  });

  it('records loop scope when auto-send fails after creating a draft', async () => {
    dispatchMock.mockRejectedValueOnce(
      new Error('WeChat desktop window was not found.'),
    );

    const result = await autoSendWorkshopOutboxIfWhitelisted({
      workshop: workshop({
        autonomyLevel: 'auto',
        boundaryPolicy: {
          externalMessages: 'auto',
          allowedRecipients: ['File Transfer'],
          allowWechatPreview: true,
          requireSourcesForOutbox: false,
          minConfidenceToDraft: 60,
          minConfidenceToSend: 75,
          maxMessageLength: 2000,
        },
      }),
      outbox: outbox({
        boundaryResult: {
          loopId: 'loop-1',
          loopRunId: 'loop-run-1',
        },
      }),
    });

    expect(result.attempted).toBe(true);
    expect(result.reason).toBe('send_failed');
    expect(updateWorkshopOutboxItemMock).not.toHaveBeenCalled();
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'outbox_auto_send_failed',
        loopId: 'loop-1',
        loopRunId: 'loop-run-1',
        metadata: expect.objectContaining({
          loopId: 'loop-1',
          loopRunId: 'loop-run-1',
        }),
      }),
    );
  });
});
