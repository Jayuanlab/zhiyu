import {
  appendWorkshopEvent,
  completeWorkshopRun,
  consumeWorkshopDirectives,
  createOutboxDraft,
  createWorkshopRun,
  getWorkshop,
  listActiveDirectives,
  listRecentSourceEventIds,
  listWorkshopEvents,
  listWorkshopMemories,
  listWorkshopOutbox,
  listWorkshopSources,
} from './service';
import type { Loop } from '@/lib/db/schema';
import {
  createBrainMemoryCandidate,
  createBrainStateSnapshot,
  writeBrainMemory,
} from '@/lib/brain/service';
import type { BrainMemoryType } from '@/lib/brain/types';
import { listLoopsForWorkshop } from '@/lib/loops/service';
import { planWorkshopDirective } from './directive-planner';
import { executeWorkshopAgent } from './executor';
import { scheduleWorkshopWakeupFromSuggestion } from './heartbeat';
import { proposeWorkshopLoopFromNaturalLanguage } from './loop-service';
import { autoSendWorkshopOutboxIfWhitelisted } from './outbox-wechat';
import {
  captureCompletedWorkshopRunEvidence,
  prepareRunHarnessCaptureContext,
} from '@/lib/harness-evolution/capture-service';
import type { RunHarnessCaptureContext } from '@/lib/harness-evolution/types';

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 50) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function brainMemoryTypeFromWorkshopKind(kind: string): BrainMemoryType {
  switch (kind) {
    case 'boundary':
      return 'boundary';
    case 'preference':
      return 'preference';
    case 'watchlist':
      return 'plan';
    default:
      return 'insight';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function directiveTriggerReason(value: unknown) {
  const record = asRecord(value);
  if (record.type !== 'directive') return null;
  const directiveId = stringValue(record.directiveId).trim();
  const content = stringValue(record.content).trim();
  if (!directiveId && !content) return null;
  return { directiveId, content };
}

type DirectiveTrigger = ReturnType<typeof directiveTriggerReason>;

function directiveMatchesTrigger(
  directive: { id: string; content: string },
  trigger: DirectiveTrigger,
) {
  if (!trigger) return false;
  if (trigger.directiveId && directive.id === trigger.directiveId) return true;
  return Boolean(trigger.content && directive.content === trigger.content);
}

export function selectDirectivesForWorkshopRun<
  T extends {
    id: string;
    runId: string | null;
    content: string;
    scope: string;
  },
>(input: {
  directives: T[];
  runId: string;
  trigger: DirectiveTrigger;
}): T[] {
  return input.directives.filter((directive) => {
    if (directive.scope === 'persistent') return true;
    if (directive.runId === input.runId) return true;
    return (
      directive.scope === 'current_run' &&
      directiveMatchesTrigger(directive, input.trigger)
    );
  });
}

function normalizeComparableText(value: unknown) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/\s+/g, '').trim()
    : '';
}

function findSimilarWorkshopLoop(loops: Loop[], intent: string) {
  const normalizedIntent = normalizeComparableText(intent);
  if (!normalizedIntent) return null;

  for (const loop of loops) {
    if (loop.status === 'archived') continue;
    const context = asRecord(loop.contextConfig);
    const candidates = [
      loop.name,
      loop.description,
      loop.goal,
      context.instructions,
      context.prompt,
    ]
      .map(normalizeComparableText)
      .filter(Boolean);

    if (
      candidates.some(
        (candidate) =>
          candidate === normalizedIntent ||
          candidate.includes(normalizedIntent) ||
          normalizedIntent.includes(candidate),
      )
    ) {
      return loop;
    }
  }

  return null;
}

async function sourceEventIdsOrRecent(input: {
  workshopId: string;
  runId: string;
  explicit: string[];
}) {
  if (input.explicit.length > 0) return input.explicit;
  return listRecentSourceEventIds(input.workshopId, {
    runId: input.runId,
    limit: 3,
  });
}

const OUTBOX_NOTIFY_REASONS = new Set([
  'needs_owner_decision',
  'urgent_risk',
  'reply_required',
  'approval_required',
  'owner_requested',
]);

function evaluateOutboxDraftNeed(draft: Record<string, unknown>) {
  const notifyReason = stringValue(draft.notifyReason).trim();
  const whyNow = stringValue(draft.whyNow).trim();

  if (!notifyReason) {
    return {
      ok: false,
      notifyReason,
      whyNow,
      reason:
        'Missing notifyReason. Routine summaries should stay in events or memory.',
    };
  }

  if (!OUTBOX_NOTIFY_REASONS.has(notifyReason)) {
    return {
      ok: false,
      notifyReason,
      whyNow,
      reason: `Unsupported notifyReason: ${notifyReason}.`,
    };
  }

  if (whyNow.length < 8) {
    return {
      ok: false,
      notifyReason,
      whyNow,
      reason: 'Missing whyNow. Outbox drafts must explain why the owner needs it now.',
    };
  }

  return { ok: true, notifyReason, whyNow, reason: null };
}

export async function executeWorkshopRunLifecycle(input: {
  userId: string;
  workshop: NonNullable<Awaited<ReturnType<typeof getWorkshop>>>;
  run: Awaited<ReturnType<typeof createWorkshopRun>>;
  triggerReason?: Record<string, unknown>;
}) {
  let currentRunDirectiveIds: string[] = [];
  try {
    const [sources, memories, activeDirectives, events, outbox, loops] = await Promise.all([
      listWorkshopSources(input.workshop.id, 20),
      listWorkshopMemories(input.workshop.id, 30),
      listActiveDirectives(input.workshop.id),
      listWorkshopEvents(input.workshop.id, { limit: 50, order: 'latest' }),
      listWorkshopOutbox(input.workshop.id, 10),
      listLoopsForWorkshop({
        userId: input.userId,
        workshopId: input.workshop.id,
        limit: 100,
      }),
    ]);

    let eventsForAgent = events;
    const directiveTrigger = directiveTriggerReason(input.triggerReason);
    const directives = selectDirectivesForWorkshopRun({
      directives: activeDirectives,
      runId: input.run.id,
      trigger: directiveTrigger,
    });
    currentRunDirectiveIds = activeDirectives
      .filter((directive) => directive.scope === 'current_run')
      .map((directive) => directive.id);

    if (directiveTrigger) {
      const directive =
        directives.find((item) => item.id === directiveTrigger.directiveId) ??
        directives.find((item) => item.content === directiveTrigger.content);

      if (directive) {
        try {
          const plan = await planWorkshopDirective({
            userId: input.userId,
            workshop: input.workshop,
            directive,
            activeDirectives: directives,
            loops,
            sources,
            memories,
            events,
          });

          const plannedEvent = await appendWorkshopEvent({
            workshopId: input.workshop.id,
            runId: input.run.id,
            type: 'directive_planned',
            title: `Directive planned: ${plan.action}`,
            body: plan.reason,
            metadata: {
              directiveId: directive.id,
              action: plan.action,
              confidence: plan.confidence,
              model: plan.model,
              taskIntent: plan.taskIntent ?? null,
              clarificationQuestion: plan.clarificationQuestion ?? null,
              subtasks: plan.subtasks ?? [],
              duplicateOf: plan.duplicateOf ?? null,
            },
          });
          eventsForAgent = [...eventsForAgent, plannedEvent];

          if (plan.action === 'create_loop_task') {
            try {
              const intent = plan.taskIntent?.trim() || directive.content;
              const duplicate = findSimilarWorkshopLoop(loops, intent);
              if (duplicate) {
                const summary = `Skipped duplicate task proposal: ${duplicate.name}`;
                await appendWorkshopEvent({
                  workshopId: input.workshop.id,
                  runId: input.run.id,
                  loopId: duplicate.id,
                  type: 'directive_duplicate_ignored',
                  title: 'Similar task already exists',
                  body: summary,
                  metadata: {
                    directiveId: directive.id,
                    loopId: duplicate.id,
                    plannerAction: plan.action,
                    duplicateOf: duplicate.id,
                  },
                });
                await completeWorkshopRun({
                  runId: input.run.id,
                  status: 'completed',
                  outputSummary: summary,
                  error: null,
                });
                return;
              }

              const proposal = await proposeWorkshopLoopFromNaturalLanguage({
                userId: input.userId,
                workshopId: input.workshop.id,
                runId: input.run.id,
                intent,
                timezone: 'Asia/Shanghai',
                proposedBy: 'workshop_agent',
                proposalReason: plan.reason,
              });
              const summary = `Created paused task proposal: ${proposal.loop.name}`;
              await appendWorkshopEvent({
                workshopId: input.workshop.id,
                runId: input.run.id,
                loopId: proposal.loop.id,
                type: 'run_completed',
                title: 'Directive converted to task proposal',
                body: summary,
                metadata: {
                  directiveId: directive.id,
                  loopId: proposal.loop.id,
                  plannerAction: plan.action,
                },
              });
              await completeWorkshopRun({
                runId: input.run.id,
                status: 'completed',
                outputSummary: summary,
                error: null,
              });
              return;
            } catch (error) {
              await appendWorkshopEvent({
                workshopId: input.workshop.id,
                runId: input.run.id,
                type: 'loop_proposal_failed',
                title: 'Task proposal creation failed',
                body:
                  error instanceof Error
                    ? error.message
                    : 'Failed to create task proposal',
                metadata: {
                  directiveId: directive.id,
                  plannerAction: plan.action,
                },
              });
            }
          }

          if (
            plan.action === 'ask_clarification' ||
            plan.action === 'ignore_duplicate'
          ) {
            const summary =
              plan.action === 'ask_clarification'
                ? plan.clarificationQuestion || plan.reason
                : plan.reason;
            if (plan.action === 'ask_clarification') {
              await createOutboxDraft({
                workshopId: input.workshop.id,
                runId: input.run.id,
                channel: 'wechat_desktop',
                recipientName: null,
                message: summary,
                status: 'draft',
                confidence: Math.round(plan.confidence * 100),
                riskLevel: 'low',
                boundaryResult: {
                  status: 'needs_owner_input',
                  reason: plan.reason,
                  directiveId: directive.id,
                  plannerAction: plan.action,
                },
              });
            }
            await appendWorkshopEvent({
              workshopId: input.workshop.id,
              runId: input.run.id,
              type:
                plan.action === 'ask_clarification'
                  ? 'directive_needs_clarification'
                  : 'directive_duplicate_ignored',
              title:
                plan.action === 'ask_clarification'
                  ? 'Directive needs clarification'
                  : 'Directive ignored as duplicate',
              body: summary,
              metadata: {
                directiveId: directive.id,
                duplicateOf: plan.duplicateOf ?? null,
              },
            });
            await completeWorkshopRun({
              runId: input.run.id,
              status: 'completed',
              outputSummary: summary,
              error: null,
            });
            return;
          }

          if (plan.action === 'spawn_subtask') {
            const subtaskEvent = await appendWorkshopEvent({
              workshopId: input.workshop.id,
              runId: input.run.id,
              type: 'directive_subtasks_planned',
              title: 'Directive subtasks planned',
              body:
                plan.subtasks
                  ?.map((subtask) => subtask.title)
                  .filter(Boolean)
                  .join('\n') || plan.reason,
              metadata: {
                directiveId: directive.id,
                plannerAction: plan.action,
                subtasks: plan.subtasks ?? [],
              },
            });
            eventsForAgent = [...eventsForAgent, subtaskEvent];
          }
        } catch (error) {
          await appendWorkshopEvent({
            workshopId: input.workshop.id,
            runId: input.run.id,
            type: 'directive_plan_failed',
            title: 'Directive planning failed',
            body:
              error instanceof Error
                ? error.message
                : 'Failed to plan directive',
            metadata: {
              directiveId: directive.id,
            },
          });
        }
      }
    }

    const result = await executeWorkshopAgent({
      userId: input.userId,
      workshop: input.workshop,
      runId: input.run.id,
      sources,
      memories,
      directives,
      events: eventsForAgent,
      outbox,
    });

    const structured = result.structured;
    const writtenMemoryIds: string[] = [];

    for (const event of asRecordArray(structured?.logEvents)) {
      await appendWorkshopEvent({
        workshopId: input.workshop.id,
        runId: input.run.id,
        type: stringValue(event.type, 'observation'),
        title: stringValue(event.title, '车间观察'),
        body: stringValue(event.body, ''),
        metadata:
          event.metadata && typeof event.metadata === 'object'
            ? (event.metadata as Record<string, unknown>)
            : {},
      });
    }

    for (const memory of asRecordArray(structured?.memoryCandidates)) {
      const content = stringValue(memory.content).trim();
      if (!content) continue;
      const kind = stringValue(memory.kind, 'finding');
      const sourceEventIds = await sourceEventIdsOrRecent({
        workshopId: input.workshop.id,
        runId: input.run.id,
        explicit: stringArray(memory.sourceEventIds),
      });
      const common = {
        requester: {
          type: 'work' as const,
          userId: input.userId,
          id: input.workshop.id,
          workId: input.workshop.id,
          workshopId: input.workshop.id,
        },
        scope: { type: 'work' as const, workId: input.workshop.id },
        ownerType: 'work' as const,
        ownerId: input.workshop.id,
        memoryType: brainMemoryTypeFromWorkshopKind(kind),
        subject: input.workshop.name,
        content,
        confidence: numberValue(memory.confidence, 50),
        tags: stringArray(memory.tags),
        evidenceRefs: sourceEventIds,
        facets: {
          sourceKind: 'workshop_run_output',
          domain: 'workshop',
          workshopId: input.workshop.id,
          workshopKind: kind,
          runId: input.run.id,
        },
      };
      const writtenMemory =
        sourceEventIds.length > 0
          ? await writeBrainMemory({
              ...common,
              status: 'active',
            })
          : await createBrainMemoryCandidate(common);
      writtenMemoryIds.push(writtenMemory.id);
      await appendWorkshopEvent({
        workshopId: input.workshop.id,
        runId: input.run.id,
        type: 'memory_written',
        title: 'Brain memory written',
        body: content,
        metadata: {
          backend: 'brain',
          memoryId: writtenMemory.id,
          kind,
          status: writtenMemory.status,
          sourceEventIds,
        },
      });
    }

    for (const draft of asRecordArray(structured?.outboxDrafts)) {
      const message = stringValue(draft.message).trim();
      if (!message) continue;
      const outboxNeed = evaluateOutboxDraftNeed(draft);
      if (!outboxNeed.ok) {
        await appendWorkshopEvent({
          workshopId: input.workshop.id,
          runId: input.run.id,
          type: 'outbox_suppressed',
          title: '发信草稿已跳过',
          body: outboxNeed.reason,
          metadata: {
            notifyReason: outboxNeed.notifyReason,
            whyNow: outboxNeed.whyNow,
            messagePreview: message.slice(0, 500),
          },
        });
        continue;
      }
      const sourceEventIds = await sourceEventIdsOrRecent({
        workshopId: input.workshop.id,
        runId: input.run.id,
        explicit: stringArray(draft.sourceEventIds),
      });
      const outboxDraft = await createOutboxDraft({
        workshopId: input.workshop.id,
        runId: input.run.id,
        channel: 'wechat_desktop',
        recipientName: stringValue(draft.recipientName, '') || null,
        message,
        confidence: numberValue(draft.confidence, 50),
        riskLevel: stringValue(draft.riskLevel, 'medium') as any,
        sourceEventIds,
        boundaryResult: {
          status: 'draft_created',
          reason:
            'Workshop runtime created an outbox draft; whitelisted recipients may be auto-sent after boundary review.',
          notifyReason: outboxNeed.notifyReason,
          whyNow: outboxNeed.whyNow,
          sourceEventIdsAutoAttached:
            stringArray(draft.sourceEventIds).length === 0 &&
            sourceEventIds.length > 0,
        },
      });
      await autoSendWorkshopOutboxIfWhitelisted({
        workshop: input.workshop,
        outbox: outboxDraft,
      });
    }

    if (structured?.nextWakeupSuggestion) {
      await appendWorkshopEvent({
        workshopId: input.workshop.id,
        runId: input.run.id,
        type: 'next_wakeup_suggested',
        title: '智能体建议下次唤醒',
        body: stringValue(structured.nextWakeupSuggestion.reason),
        metadata: structured.nextWakeupSuggestion,
      });
      await scheduleWorkshopWakeupFromSuggestion({
        workshop: input.workshop,
        runId: input.run.id,
        suggestion: structured.nextWakeupSuggestion,
      });
    }

    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.run.id,
      type: result.status === 'success' ? 'run_completed' : 'run_failed',
      title:
        result.status === 'success' ? '本轮车间工作完成' : '本轮车间工作失败',
      body: result.output,
      metadata: {
        toolCallCount: result.toolCallCount,
        durationMs: result.durationMs,
      },
    });

    await completeWorkshopRun({
      runId: input.run.id,
      status: result.status === 'success' ? 'completed' : 'failed',
      outputSummary: result.output,
      error: result.error ?? null,
    });
    try {
      await createBrainStateSnapshot({
        userId: input.userId,
        scope: { type: 'workshop', workshopId: input.workshop.id },
        snapshotType: 'work_state',
        content: {
          workshopId: input.workshop.id,
          runId: input.run.id,
          status: result.status === 'success' ? 'completed' : 'failed',
          outputSummary: result.output,
          error: result.error ?? null,
          toolCallCount: result.toolCallCount,
          durationMs: result.durationMs,
          writtenMemoryIds,
        },
        sourceMemoryIds: writtenMemoryIds,
        metadata: {
          triggerReason: input.triggerReason,
        },
      });
    } catch (error) {
      console.warn('[WorkshopRuntime] Brain work_state snapshot failed', error);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.run.id,
      type: 'run_failed',
      title: '本轮车间工作失败',
      body: message,
    });
    await completeWorkshopRun({
      runId: input.run.id,
      status: 'failed',
      outputSummary: null,
      error: message,
    });
  } finally {
    if (currentRunDirectiveIds.length > 0) {
      try {
        await consumeWorkshopDirectives({
          workshopId: input.workshop.id,
          runId: input.run.id,
          directiveIds: currentRunDirectiveIds,
        });
      } catch (error) {
        console.warn(
          '[WorkshopRuntime] Failed to consume current-run directives:',
          error,
        );
      }
    }
    try {
      await captureCompletedWorkshopRunEvidence(input.run.id);
    } catch (error) {
      console.warn('[WorkshopRuntime] Harness evidence capture failed', error);
    }
  }
}

export async function startWorkshopRun(input: {
  userId: string;
  workshopId: string;
  triggerReason?: Record<string, unknown>;
}) {
  const workshop = await getWorkshop(input.userId, input.workshopId);
  if (!workshop) {
    throw new Error('Workshop not found');
  }

  const triggerReason = input.triggerReason ?? { type: 'manual' };
  let harnessEvolution: RunHarnessCaptureContext | null = null;
  try {
    harnessEvolution = await prepareRunHarnessCaptureContext({
      userId: input.userId,
      workId: workshop.id,
    });
  } catch (error) {
    console.warn('[WorkshopRuntime] Harness snapshot preparation failed', error);
  }
  const run = await createWorkshopRun({
    workshopId: workshop.id,
    triggerReason,
    inputSnapshot: {
      mission: workshop.mission,
      autonomyLevel: workshop.autonomyLevel,
      ...(harnessEvolution ? { harnessEvolution } : {}),
    },
  });

  void executeWorkshopRunLifecycle({
    userId: input.userId,
    workshop,
    run,
    triggerReason,
  }).catch((error) => {
    console.error('[WorkshopRuntime] background run failed', error);
  });

  return run;
}
