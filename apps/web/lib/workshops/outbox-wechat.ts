import {
  previewWechatDesktopMessage,
} from '@/lib/wechat-desktop/client';
import type { Workshop, WorkshopOutboxItem } from '@/lib/db/schema';
import {
  evaluateWorkshopOutboxBoundary,
  parseAllowedRecipientsFromEnv,
} from './outbox-boundary';
import { getWorkshopBoundaryPolicy } from './boundary-policy';
import {
  resolveWorkshopPermissionBoundaryReviewItem,
  upsertWorkshopPermissionBoundaryReviewItem,
} from './review-items';
import { appendWorkshopEvent, updateWorkshopOutboxItem } from './service';
import type {AppendWorkshopEventInput} from './types';
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {withWorkshopControlWrite} from '@/lib/work-runtime/workshop-write';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {outboxContentHash} from '@/lib/work-runtime/outbox-attempt';
import {dispatchOutboxAttempt,type OutboxSendAdapter} from '@/lib/work-runtime/outbox-dispatch';
import {workCommandChildId} from '@/lib/work-runtime/child-id';
import {getWorkshopOutboxItem} from './service';

type OutboxActionInput={workshop:Workshop;outbox:WorkshopOutboxItem;auditActorId?:string;provider?:OutboxSendAdapter};
async function assertOutboxAction(input:OutboxActionInput){
  if(input.outbox.workshopId!==input.workshop.id)throw new ExecutionLeaseError('invalid_lease');
  if(input.auditActorId){
    if(resolveExecutionLease() || input.auditActorId!==input.workshop.userId)throw new ExecutionLeaseError('invalid_lease');
    return;
  }
  await withWorkshopControlWrite({workshopId:input.workshop.id,runId:input.outbox.runId},async()=>undefined);
}
function appendOutboxActionEvent(input:OutboxActionInput,event:AppendWorkshopEventInput){
  // Owner review is a new action on an outbox item, not a late producer write
  // from the old run. This capability is supplied only after requireWork.
  return appendWorkshopEvent(input.auditActorId?{...event,runId:null,metadata:{...event.metadata,actorId:input.auditActorId,sourceRunId:input.outbox.runId,source:'owner_outbox_action'}}:event);
}

type PreviewState = {
  confirmToken?: string;
  expiresAt?: string;
  preview?: unknown;
};

function getPreviewState(
  boundaryResult: Record<string, unknown>,
): PreviewState {
  const preview = boundaryResult.wechatPreview;
  return preview && typeof preview === 'object'
    ? (preview as PreviewState)
    : {};
}

function firstAllowedWechatRecipient(workshop: Workshop) {
  const policy = getWorkshopBoundaryPolicy(workshop);
  return policy.allowedRecipients[0] ?? parseAllowedRecipientsFromEnv()[0];
}

function allowedWechatRecipients(workshop: Workshop) {
  const policy = getWorkshopBoundaryPolicy(workshop);
  return Array.from(
    new Set([...policy.allowedRecipients, ...parseAllowedRecipientsFromEnv()]),
  ).filter((recipient) => recipient.trim().length > 0);
}

function resolveRecipientName(workshop: Workshop, outbox: WorkshopOutboxItem) {
  return (
    outbox.recipientName?.trim() ||
    process.env.WORKSHOP_DEFAULT_WECHAT_RECIPIENT?.trim() ||
    process.env.WECHAT_DESKTOP_DEFAULT_RECIPIENT?.trim() ||
    firstAllowedWechatRecipient(workshop) ||
    '文件传输助手'
  );
}

function withRecipient(
  outbox: WorkshopOutboxItem,
  recipientName: string,
): WorkshopOutboxItem {
  return {
    ...outbox,
    recipientName,
  };
}

function outboxLoopScope(outbox: WorkshopOutboxItem) {
  const boundaryResult =
    outbox.boundaryResult && typeof outbox.boundaryResult === 'object'
      ? (outbox.boundaryResult as Record<string, unknown>)
      : {};
  return {
    loopId:
      typeof boundaryResult.loopId === 'string' ? boundaryResult.loopId : null,
    loopRunId:
      typeof boundaryResult.loopRunId === 'string'
        ? boundaryResult.loopRunId
        : null,
  };
}

export function isWorkshopOutboxRecipientWhitelisted(input: {
  workshop: Workshop;
  outbox: WorkshopOutboxItem;
}) {
  const recipientName = resolveRecipientName(input.workshop, input.outbox);
  const allowedRecipients = allowedWechatRecipients(input.workshop);

  return {
    allowed: allowedRecipients.includes(recipientName),
    recipientName,
    allowedRecipients,
  };
}

export async function previewWorkshopOutboxWechat(input: OutboxActionInput) {
  if(['sending','unknown','sent','failed','rejected'].includes(input.outbox.status))throw new Error('Terminal or unsettled outbox cannot be previewed again.');
  await assertOutboxAction(input);
  const recipientName = resolveRecipientName(input.workshop, input.outbox);
  const effectiveOutbox = withRecipient(input.outbox, recipientName);
  const boundary = evaluateWorkshopOutboxBoundary({
    workshop: input.workshop,
    outbox: effectiveOutbox,
    action: 'preview',
  });
  const baseBoundaryResult = {
    ...(input.outbox.boundaryResult ?? {}),
    boundary,
  };

  if (!boundary.allowed) {
    const updated = await updateWorkshopOutboxItem(
      input.workshop.id,
      input.outbox.id,
      {
        status: 'blocked',
        recipientName,
        boundaryResult: baseBoundaryResult,
      },
    );
    const event = await appendOutboxActionEvent(input, {
      workshopId: input.workshop.id,
      runId: input.outbox.runId,
      ...outboxLoopScope(input.outbox),
      type: 'outbox_blocked',
      title: 'Outbox draft blocked by boundary',
      body: boundary.violations.join('\n'),
      metadata: {
        outboxId: input.outbox.id,
        boundary,
        ...outboxLoopScope(input.outbox),
      },
    });
    if (updated) {
      await upsertWorkshopPermissionBoundaryReviewItem({
        workshopId: input.workshop.id,
        outbox: updated,
        sourceEventId: event.id,
      });
    }
    return { ok: false, outbox: updated, boundary };
  }

  const preview = await previewWechatDesktopMessage({
    recipientName,
    message: input.outbox.message,
  });
  const expiresAt = new Date(
    Date.now() + preview.expiresInSeconds * 1000,
  ).toISOString();
  const boundaryResult = {
    ...baseBoundaryResult,
    wechatPreview: {
      contentHash: outboxContentHash(effectiveOutbox),
      confirmToken: preview.confirmToken,
      expiresAt,
      preview: preview.preview,
    },
  };

  const updated = await updateWorkshopOutboxItem(
    input.workshop.id,
    input.outbox.id,
    {
      status: 'pending_approval',
      recipientName,
      boundaryResult,
    },
  );
  await appendOutboxActionEvent(input, {
    workshopId: input.workshop.id,
    runId: input.outbox.runId,
    ...outboxLoopScope(input.outbox),
    type: 'outbox_preview_ready',
    title: 'WeChat preview ready',
    body: `Waiting for confirmation to send to: ${recipientName}`,
    metadata: {
      outboxId: input.outbox.id,
      preview: preview.preview,
      warnings: boundary.warnings,
      ...outboxLoopScope(input.outbox),
    },
  });
  await resolveWorkshopPermissionBoundaryReviewItem({
    workshopId: input.workshop.id,
    outboxId: input.outbox.id,
    status: "superseded",
    metadata: {
      reason: "Outbox boundary passed during preview.",
      boundary,
      recipientName,
    },
  });

  return { ok: true, outbox: updated, boundary, preview };
}

export async function sendWorkshopOutboxWechat(input: OutboxActionInput) {
  await assertOutboxAction(input);
  const recipientName = resolveRecipientName(input.workshop, input.outbox);
  const effectiveOutbox = withRecipient(input.outbox, recipientName);
  const boundary = evaluateWorkshopOutboxBoundary({
    workshop: input.workshop,
    outbox: effectiveOutbox,
    action: 'send',
  });
  if (!boundary.allowed) {
    const updated = await updateWorkshopOutboxItem(
      input.workshop.id,
      input.outbox.id,
      {
        status: 'blocked',
        recipientName,
        boundaryResult: {
          ...(input.outbox.boundaryResult ?? {}),
          boundary,
        },
      },
    );
    const event = await appendOutboxActionEvent(input, {
      workshopId: input.workshop.id,
      runId: input.outbox.runId,
      ...outboxLoopScope(input.outbox),
      type: 'outbox_blocked',
      title: 'Outbox draft blocked by boundary',
      body: boundary.violations.join('\n'),
      metadata: {
        outboxId: input.outbox.id,
        boundary,
        ...outboxLoopScope(input.outbox),
      },
    });
    if (updated) {
      await upsertWorkshopPermissionBoundaryReviewItem({
        workshopId: input.workshop.id,
        outbox: updated,
        sourceEventId: event.id,
      });
    }
    return { ok: false, outbox: updated, boundary };
  }

  // Resolve the recipient before taking the immutable content snapshot.
  if(input.outbox.recipientName!==recipientName)await updateWorkshopOutboxItem(input.workshop.id,input.outbox.id,{recipientName});
  const contentHash=outboxContentHash(effectiveOutbox);
  const attempt=await dispatchOutboxAttempt({userId:input.workshop.userId,workId:input.workshop.id,outboxId:input.outbox.id,commandId:workCommandChildId(input.workshop.userId,input.workshop.id,input.outbox.id,`send:${contentHash}`),expectedContentHash:contentHash},input.provider);
  const updated=await getWorkshopOutboxItem(input.workshop.id,input.outbox.id);
  const sent=attempt.provider_receipt;
  if(attempt.status!=='sent')return {ok:false,outbox:updated,boundary,sent,attemptStatus:attempt.status,error:'Send result is unknown; review required'};
  await resolveWorkshopPermissionBoundaryReviewItem({
    workshopId: input.workshop.id,
    outboxId: input.outbox.id,
    status: "approved",
    metadata: {
      reason: "Outbox message was sent after boundary validation.",
      boundary,
      recipientName,
    },
  });

  return { ok: true, outbox: updated, boundary, sent };
}

export async function autoSendWorkshopOutboxIfWhitelisted(input: {
  workshop: Workshop;
  outbox: WorkshopOutboxItem;
}) {
  await assertOutboxAction(input);
  const whitelist = isWorkshopOutboxRecipientWhitelisted(input);

  if (!whitelist.allowed) {
    return {
      attempted: false as const,
      reason: 'recipient_not_whitelisted',
      ...whitelist,
    };
  }

  const outbox = withRecipient(input.outbox, whitelist.recipientName);
  const boundary = evaluateWorkshopOutboxBoundary({
    workshop: input.workshop,
    outbox,
    action: 'send',
  });

  if (boundary.requiresApproval) {
    return {
      attempted: false as const,
      reason: 'approval_required',
      recipientName: whitelist.recipientName,
      boundary,
    };
  }

  try {
    const result = await sendWorkshopOutboxWechat({
      workshop: input.workshop,
      outbox,
    });

    const unresolved=!result.ok&&'attemptStatus' in result;
    if (!result.ok&&!unresolved) {
      await appendWorkshopEvent({
        workshopId: input.workshop.id,
        runId: input.outbox.runId,
        ...outboxLoopScope(input.outbox),
        type: 'outbox_auto_send_blocked',
        title: 'Whitelist auto-send blocked by boundary',
        body: result.boundary.violations.join('\n'),
        metadata: {
          outboxId: input.outbox.id,
          recipientName: whitelist.recipientName,
          boundary: result.boundary,
          ...outboxLoopScope(input.outbox),
        },
      });
    }

    return {
      attempted: true as const,
      reason: result.ok ? 'sent' : unresolved?'send_unknown':'boundary_blocked',
      recipientName: whitelist.recipientName,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if(error instanceof ExecutionLeaseError)throw error;
    const updated = await getWorkshopOutboxItem(input.workshop.id,input.outbox.id);
    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.outbox.runId,
      ...outboxLoopScope(input.outbox),
      type: 'outbox_auto_send_failed',
      title: 'Whitelist auto-send failed',
      body: message,
      metadata: {
        outboxId: input.outbox.id,
        recipientName: whitelist.recipientName,
        ...outboxLoopScope(input.outbox),
      },
    });

    return {
      attempted: true as const,
      reason: 'send_failed',
      recipientName: whitelist.recipientName,
      outbox: updated,
      error: message,
    };
  }
}
