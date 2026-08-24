import { fetchQuantWatchlistConfig, updateQuantWatchlistConfig } from '@/lib/quant/client';
import type { WorkshopEvent } from '@/lib/db/schema';
import type {
  QuantWatchlistConfig,
  QuantWatchlistConfigItem,
} from '@/lib/quant/types';
import {
  appendWorkshopEvent,
  getWorkshopEvent,
  listWorkshopEvents,
} from './service';
import { resolveWorkshopReviewItemBySourceEvent } from './review-items';

export type WatchlistProposalAction = 'apply' | 'reject';

type WatchlistProposalResolutionStatus = 'applied' | 'rejected';

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    : [];
}

function findExistingResolution(
  events: WorkshopEvent[],
  proposal: { eventId: string; proposalId: string | null },
) {
  return events.find((event) => {
    if (
      event.type !== 'watchlist_proposal_applied' &&
      event.type !== 'watchlist_proposal_rejected'
    ) {
      return false;
    }
    const metadata = metadataObject(event.metadata);
    return (
      metadata.sourceProposalEventId === proposal.eventId ||
      (proposal.proposalId && metadata.proposalId === proposal.proposalId)
    );
  });
}

function readProposal(event: WorkshopEvent) {
  const metadata = metadataObject(event.metadata);
  const validation = metadataObject(metadata.validation);
  const proposalId =
    typeof metadata.proposalId === 'string' ? metadata.proposalId : null;
  const status = typeof metadata.status === 'string' ? metadata.status : null;
  const after = stringArray(metadata.after);

  if (event.type !== 'watchlist_proposal') {
    throw new Error('这不是自选股调整提案。');
  }
  if (metadata.kind !== 'watchlist_change_proposal') {
    throw new Error('提案类型不匹配，不能应用到自选股。');
  }

  return { metadata, validation, proposalId, status, after };
}

function assertApplicableProposal(event: WorkshopEvent) {
  const proposal = readProposal(event);
  const { validation, status, after } = proposal;

  if (status !== 'pending_approval') {
    throw new Error('只有待确认的自选股提案可以应用。');
  }
  if (validation.ok !== true) {
    const issues = stringArray(validation.issues);
    throw new Error(
      issues.length > 0
        ? `提案校验未通过：${issues.join('；')}`
        : '提案校验未通过，不能应用。',
    );
  }
  if (after.length === 0) {
    throw new Error('提案没有提供应用后的自选股列表。');
  }

  return proposal;
}

function buildAppliedWatchlistItems(input: {
  beforeConfig: QuantWatchlistConfig;
  metadata: Record<string, unknown>;
  after: string[];
}): QuantWatchlistConfigItem[] {
  const now = new Date().toISOString();
  const add = new Set(stringArray(input.metadata.add));
  const remove = new Set(stringArray(input.metadata.remove));
  const protectedRemove = new Set(stringArray(input.metadata.protectedRemove));
  const reason =
    typeof input.metadata.reason === 'string' ? input.metadata.reason : '';
  const existing = new Map(
    (input.beforeConfig.items ?? []).map((item) => [item.code, item]),
  );

  const afterSet = new Set(input.after);
  const activeItems = input.after.map((code) => {
    const previous = existing.get(code);
    const isProtected = protectedRemove.has(code);
    const isAdded = add.has(code);
    return {
      ...previous,
      code,
      pool: isProtected ? 'holding' : isAdded ? 'core' : previous?.pool ?? 'core',
      status: isProtected ? 'protected' : isAdded ? 'active' : previous?.status ?? 'active',
      source: isAdded ? 'watchlist_hunter' : previous?.source ?? 'watchlist',
      reason: isAdded || isProtected ? reason : previous?.reason ?? '',
      evidence: previous?.evidence ?? [],
      data_quality: previous?.data_quality ?? 'unknown',
      first_seen_at: previous?.first_seen_at ?? now,
      last_reviewed_at: now,
      updated_at: now,
    };
  });

  const preservedPassiveItems = (input.beforeConfig.items ?? []).filter((item) => {
    if (afterSet.has(item.code)) return false;
    if (remove.has(item.code)) return false;
    const pool = item.pool ?? 'core';
    return pool === 'candidate' || pool === 'archived';
  });

  return [...activeItems, ...preservedPassiveItems];
}

export async function resolveWatchlistProposal(input: {
  workshopId: string;
  eventId: string;
  action: WatchlistProposalAction;
  note?: string | null;
}) {
  const proposalEvent = await getWorkshopEvent(input.workshopId, input.eventId);
  if (!proposalEvent) {
    throw new Error('自选股提案不存在。');
  }

  const { metadata, proposalId, after } = readProposal(proposalEvent);
  const recentEvents = await listWorkshopEvents(input.workshopId, {
    limit: 300,
    order: 'latest',
  });
  const existing = findExistingResolution(recentEvents, {
    eventId: proposalEvent.id,
    proposalId,
  });
  if (existing) {
    const status = existing.type.endsWith('_applied') ? 'applied' : 'rejected';
    await resolveWorkshopReviewItemBySourceEvent({
      workshopId: input.workshopId,
      sourceEventId: proposalEvent.id,
      status: status === 'applied' ? 'approved' : 'rejected',
      metadata: {
        resolutionEventId: existing.id,
        proposalId,
        alreadyResolved: true,
      },
    });
    let config: QuantWatchlistConfig | null = null;
    let repaired = false;

    if (input.action === 'apply' && status === 'applied') {
      const beforeConfig = await fetchQuantWatchlistConfig();
      if (!activeCodesMatch(beforeConfig.codes, after)) {
        config = await updateQuantWatchlistConfig(
          after,
          buildAppliedWatchlistItems({ beforeConfig, metadata, after }),
        );
        repaired = true;
        await appendWatchlistRepairEvent({
          proposalEvent,
          proposalId,
          metadata,
          beforeConfig,
          afterConfig: config,
          note:
            input.note ??
            '提案此前已标记为已应用，但当前自选股配置未生效，已执行幂等补偿。',
        });
      } else {
        config = beforeConfig;
      }
    }

    return {
      status,
      proposal: proposalEvent,
      event: existing,
      config,
      alreadyResolved: true,
      repaired,
    };
  }

  if (input.action === 'reject') {
    const event = await appendResolutionEvent({
      proposalEvent,
      proposalId,
      resolutionStatus: 'rejected',
      note: input.note,
      metadata,
      config: null,
    });
    await resolveWorkshopReviewItemBySourceEvent({
      workshopId: input.workshopId,
      sourceEventId: proposalEvent.id,
      status: 'rejected',
      metadata: {
        resolutionEventId: event.id,
        proposalId,
        note: input.note ?? null,
      },
    });
    return {
      status: 'rejected' as const,
      proposal: proposalEvent,
      event,
      config: null,
      alreadyResolved: false,
    };
  }

  assertApplicableProposal(proposalEvent);
  const beforeConfig = await fetchQuantWatchlistConfig();
  const config = await updateQuantWatchlistConfig(
    after,
    buildAppliedWatchlistItems({ beforeConfig, metadata, after }),
  );
  const event = await appendResolutionEvent({
    proposalEvent,
    proposalId,
    resolutionStatus: 'applied',
    note: input.note,
    metadata,
    config: {
      beforeConfig,
      afterConfig: config,
    },
  });
  await resolveWorkshopReviewItemBySourceEvent({
    workshopId: input.workshopId,
    sourceEventId: proposalEvent.id,
    status: 'approved',
    metadata: {
      resolutionEventId: event.id,
      proposalId,
      note: input.note ?? null,
    },
  });

  return {
    status: 'applied' as const,
    proposal: proposalEvent,
    event,
    config,
    alreadyResolved: false,
  };
}

function activeCodesMatch(currentCodes: string[], expectedCodes: string[]) {
  const current = currentCodes
    .map((code) => code.trim())
    .filter(Boolean);
  return (
    current.length === expectedCodes.length &&
    current.every((code, index) => code === expectedCodes[index])
  );
}

async function appendWatchlistRepairEvent(input: {
  proposalEvent: WorkshopEvent;
  proposalId: string | null;
  metadata: Record<string, unknown>;
  beforeConfig: QuantWatchlistConfig;
  afterConfig: QuantWatchlistConfig;
  note: string;
}) {
  const after = stringArray(input.metadata.after);
  const add = stringArray(input.metadata.add);
  const remove = stringArray(input.metadata.remove);
  return appendWorkshopEvent({
    workshopId: input.proposalEvent.workshopId,
    runId: input.proposalEvent.runId,
    loopId: input.proposalEvent.loopId,
    loopRunId: input.proposalEvent.loopRunId,
    type: 'watchlist_proposal_repaired',
    title: '自选股调整已补偿应用',
    body: [
      '自选股提案此前已标记为已应用，但当前配置未反映提案结果。',
      `应用后列表：${after.join(', ') || '-'}`,
      add.length > 0 ? `加入：${add.join(', ')}` : '',
      remove.length > 0 ? `移除：${remove.join(', ')}` : '',
      `备注：${input.note}`,
    ]
      .filter(Boolean)
      .join('\n'),
    metadata: {
      provider: 'quant-paper',
      kind: 'watchlist_change_resolution_repair',
      proposalId: input.proposalId,
      sourceProposalEventId: input.proposalEvent.id,
      status: 'repaired',
      before: stringArray(input.metadata.before),
      after,
      add,
      remove,
      note: input.note,
      config: {
        beforeConfig: input.beforeConfig,
        afterConfig: input.afterConfig,
      },
    },
  });
}

async function appendResolutionEvent(input: {
  proposalEvent: WorkshopEvent;
  proposalId: string | null;
  resolutionStatus: WatchlistProposalResolutionStatus;
  note?: string | null;
  metadata: Record<string, unknown>;
  config: unknown;
}) {
  const isApplied = input.resolutionStatus === 'applied';
  const after = stringArray(input.metadata.after);
  const add = stringArray(input.metadata.add);
  const remove = stringArray(input.metadata.remove);
  const lines = [
    isApplied ? '自选股调整已应用。' : '自选股调整已拒绝。',
    `应用后列表：${after.join(', ') || '-'}`,
    add.length > 0 ? `加入：${add.join(', ')}` : '',
    remove.length > 0 ? `移除：${remove.join(', ')}` : '',
    input.note ? `备注：${input.note}` : '',
  ].filter(Boolean);

  return appendWorkshopEvent({
    workshopId: input.proposalEvent.workshopId,
    runId: input.proposalEvent.runId,
    loopId: input.proposalEvent.loopId,
    loopRunId: input.proposalEvent.loopRunId,
    type: isApplied
      ? 'watchlist_proposal_applied'
      : 'watchlist_proposal_rejected',
    title: isApplied ? '自选股调整已应用' : '自选股调整已拒绝',
    body: lines.join('\n'),
    metadata: {
      provider: 'quant-paper',
      kind: 'watchlist_change_resolution',
      proposalId: input.proposalId,
      sourceProposalEventId: input.proposalEvent.id,
      status: input.resolutionStatus,
      before: stringArray(input.metadata.before),
      after,
      add,
      remove,
      note: input.note ?? null,
      config: input.config,
    },
  });
}
