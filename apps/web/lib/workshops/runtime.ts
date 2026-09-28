import {
  appendWorkshopEvent,
  completeWorkshopRun,
  createOutboxDraft,
  createWorkshopRun,
  listActiveDirectives,
  listRecentSourceEventIds,
  listWorkshopEvents,
  listWorkshopMemories,
  listWorkshopOutbox,
  listWorkshopSources,
} from './service';
import type { Loop, WorkshopEvent } from '@/lib/db/schema';
import type {getWorkshop} from './service';
import {
  createBrainMemoryCandidate,
  writeBrainMemory,
} from '@/lib/brain/service';
import type { BrainMemoryType } from '@/lib/brain/types';
import { listLoopsForWorkshop } from '@/lib/loops/service';
import { planWorkshopDirective } from './directive-planner';
import { executeWorkshopAgent,type WorkshopExecutionResult } from './executor';
import { scheduleWorkshopWakeupFromSuggestion } from './heartbeat';
import { proposeWorkshopLoopFromNaturalLanguage } from './loop-service';
import { autoSendWorkshopOutboxIfWhitelisted } from './outbox-wechat';
import {
  captureCompletedWorkshopRunEvidence,
} from '@/lib/harness-evolution/capture-service';
import {workCommandChildId} from '@/lib/work-runtime/child-id';
import type {CompleteWorkshopRunInput} from './types';
import type {ExecutionLease} from '@/lib/work-runtime/execution-lease';
import {resolveExecutionLease,withExecutionContext} from '@/lib/work-runtime/execution-context';
import {createExecutionGuard} from '@/lib/work-runtime/execution-guard';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {startExecutionHeartbeat} from '@/lib/work-runtime/execution-heartbeat';
import {captureRunOutput,readCapturedRunOutput} from '@/lib/work-runtime/run-output';
import {applyOutputStep} from '@/lib/work-runtime/output-step';
import {captureRunPlan,readCapturedRunPlan,applyRunPlanStep} from '@/lib/work-runtime/run-plan';
import { readConversationTrigger } from './conversation-input';
import { loadPersistentWorkshopEvents, loadWorkshopConversationContext } from './conversation-context';

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

function normalizeWorkshopPresentation(value: unknown) {
  const candidate = asRecord(value);
  const title = stringValue(candidate.title).trim().slice(0, 160);
  const summary = stringValue(candidate.summary).trim().slice(0, 2000);
  const originalReport = stringValue(candidate.reportMarkdown).trim();
  const reportMarkdown = originalReport.slice(0, 64_000);
  const warnings = stringArray(candidate.warnings).map(item => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20);
  if (originalReport.length > reportMarkdown.length) {
    warnings.push('汇报正文超过 64000 字，展示记录仅保留前半部分；完整内容应作为产物附件提交。');
  }
  const nextSteps = stringArray(candidate.nextSteps).map(item => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20);
  const evidenceEventIds = stringArray(candidate.evidenceEventIds)
    .filter(id => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
    .slice(0, 50);
  if (!title && !summary && !reportMarkdown && !warnings.length && !nextSteps.length) return null;
  return { schemaVersion: 1, source: 'agent_report', title, summary, reportMarkdown,
    evidenceEventIds, warnings, nextSteps };
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
  if (trigger.directiveId) return directive.id === trigger.directiveId;
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
    if (directive.runId) return false;
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

type WorkshopRunLifecycleInput = {
  userId: string;
  workshop: NonNullable<Awaited<ReturnType<typeof getWorkshop>>>;
  run: Awaited<ReturnType<typeof createWorkshopRun>>;
  triggerReason?: Record<string, unknown>;
  executionLease?: ExecutionLease;
  abortController?: AbortController;
  executionLeaseMs?: number;
};

export async function executeWorkshopRunLifecycle(input: WorkshopRunLifecycleInput) {
  const executionLease=resolveExecutionLease(input.executionLease);
  if(executionLease && (executionLease.userId!==input.userId || executionLease.workshopId!==input.workshop.id || executionLease.runId!==input.run.id)) throw new ExecutionLeaseError('invalid_lease');
  return withExecutionContext(executionLease,()=>executeWorkshopRunInContext({...input,executionLease}));
}

async function executeWorkshopRunInContext(input: WorkshopRunLifecycleInput) {
  const abortController=input.abortController??new AbortController();
  const guard=input.executionLease?createExecutionGuard(input.executionLease,abortController):undefined;
  await guard?.();
  const heartbeat=input.executionLease?await startExecutionHeartbeat(input.executionLease,abortController,input.executionLeaseMs):undefined;
  let currentRunDirectiveIds: string[] = [];
  let completionPersisted=false;
  let isConversationRun=false;
  const complete=async(outcome:Omit<CompleteWorkshopRunInput,'userId'|'workshopId'|'directiveIds'|'lease'>)=>{
    await heartbeat?.stop();
    await guard?.();
    const result=await completeWorkshopRun({...outcome,userId:input.userId,workshopId:input.workshop.id,directiveIds:currentRunDirectiveIds,lease:input.executionLease});
    completionPersisted=true;
    return result;
  };
  try {
    const trigger = input.run.triggerReason ?? input.triggerReason;
    isConversationRun = asRecord(trigger).type === 'conversation' || asRecord(input.triggerReason).type === 'conversation';
    if (isConversationRun && !readConversationTrigger(trigger)) {
      throw new Error('临时任务参数无效，请重新提交任务。');
    }
    const captured=input.executionLease?await readCapturedRunOutput(input.executionLease):null;
    let result:WorkshopExecutionResult;
    if(captured){
      result=captured.result;
      currentRunDirectiveIds=captured.directiveIds;
    }else{
    let savedPlan=input.executionLease?await readCapturedRunPlan(input.executionLease):null;
    if (isConversationRun && savedPlan) throw new Error('临时对话不能沿用长期指令计划，请发起新任务。');
    const writePlanStep=<T>(step:Parameters<typeof applyRunPlanStep>[1],write:(append:typeof appendWorkshopEvent)=>Promise<T>):Promise<T>=>
      input.executionLease?applyRunPlanStep(input.executionLease,step,ctx=>write(ctx.append)):write(appendWorkshopEvent);
    const isDocumentCleaner = (input.workshop.modelConfig as Record<string, unknown> | null)?.role === 'document_markdown_cleaner';
    const [sources, memories, activeDirectives, events, outbox, loops] = await Promise.all([
      listWorkshopSources(input.workshop.id, isDocumentCleaner ? 1001 : 20),
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
    if (isDocumentCleaner && sources.length > 1000) {
      throw new Error('Document cleaner has more than 1,000 sources; split the batch before running.');
    }

    let eventsForAgent = await loadPersistentWorkshopEvents<WorkshopEvent>(input.workshop.id, events);
    const conversation = isConversationRun ? await loadWorkshopConversationContext(input.run) : undefined;
    const directiveTrigger = isConversationRun ? null : directiveTriggerReason(input.triggerReason);
    const directives = selectDirectivesForWorkshopRun({
      directives: activeDirectives,
      runId: input.run.id,
      trigger: directiveTrigger,
    }).filter(directive=>!savedPlan||directive.scope!=='current_run'||savedPlan.directiveIds.includes(directive.id));
    currentRunDirectiveIds = savedPlan?.directiveIds??directives
      .filter((directive) => directive.scope === 'current_run')
      .map((directive) => directive.id);

    if (!isConversationRun && (directiveTrigger||savedPlan)) {
      const liveDirective =
        directives.find((item) => item.id === directiveTrigger?.directiveId) ??
        directives.find((item) => item.content === directiveTrigger?.content);
      const directive=savedPlan?.directive??liveDirective;

      if (directive) {
        try {
          await guard?.();
          const plan = savedPlan?.plan??await planWorkshopDirective({
            userId: input.userId,
            workshop: input.workshop,
            directive:liveDirective!,
            activeDirectives: directives,
            loops,
            sources,
            memories,
            events: eventsForAgent,
          });
          await guard?.();
          if(input.executionLease&&!savedPlan){
            const duplicate=plan.action==='create_loop_task'?findSimilarWorkshopLoop(loops,plan.taskIntent?.trim()||directive.content):null;
            savedPlan=await captureRunPlan(input.executionLease,{directive:{id:directive.id,content:directive.content,scope:directive.scope,priority:directive.priority},directiveIds:currentRunDirectiveIds,plan,duplicateLoop:duplicate?{id:duplicate.id,name:duplicate.name}:null});
          }

          const plannedEvent = await writePlanStep('planned',append=>append({
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
          }));
          if(!eventsForAgent.some((event:{id:string})=>event.id===plannedEvent.id))eventsForAgent = [...eventsForAgent, plannedEvent];

          if (plan.action === 'create_loop_task') {
            try {
              const intent = plan.taskIntent?.trim() || directive.content;
              const duplicate = savedPlan?savedPlan.duplicateLoop:findSimilarWorkshopLoop(loops, intent);
              if (duplicate) {
                const summary = `Skipped duplicate task proposal: ${duplicate.name}`;
                await writePlanStep('duplicate',append=>append({
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
                }));
                await complete({
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
                commandId: workCommandChildId(input.userId, input.workshop.id, directive.id, 'loop-proposal'),
                runId: input.run.id,
                intent,
                timezone: 'Asia/Shanghai',
                proposedBy: 'workshop_agent',
                proposalReason: plan.reason,
              });
              const summary = `Created paused task proposal: ${proposal.loop.name}`;
              await complete({
                runId: input.run.id,
                status: 'completed',
                outputSummary: summary,
                error: null,
                metadata: {directiveId:directive.id,loopId:proposal.loop.id,plannerAction:plan.action},
              });
              return;
            } catch (error) {
              if(error instanceof ExecutionLeaseError||savedPlan) throw error;
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
            await writePlanStep('clarification',async append=>{
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
            return append({
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
            });
            await complete({
              runId: input.run.id,
              status: 'completed',
              outputSummary: summary,
              error: null,
            });
            return;
          }

          if (plan.action === 'spawn_subtask') {
            const subtaskEvent = await writePlanStep('subtasks',append=>append({
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
            }));
            if(!eventsForAgent.some((event:{id:string})=>event.id===subtaskEvent.id))eventsForAgent = [...eventsForAgent, subtaskEvent];
          }
        } catch (error) {
          if(error instanceof ExecutionLeaseError||savedPlan) throw error;
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

    await guard?.();
    result = await executeWorkshopAgent({
      executionLease: input.executionLease,
      abortController,
      userId: input.userId,
      workshop: input.workshop,
      runId: input.run.id,
      sources,
      memories,
      directives,
      events: eventsForAgent,
      outbox,
      conversation,
    });
    await guard?.();

    if(input.executionLease)await captureRunOutput(input.executionLease,{result,directiveIds:currentRunDirectiveIds});
    }

    if(result.status!=='success') {
      await complete({runId:input.run.id,status:'failed',outputSummary:result.output,error:result.error??null,metadata:{toolCallCount:result.toolCallCount,durationMs:result.durationMs,presentation:normalizeWorkshopPresentation(result.structured?.presentation)}});
      return;
    }

    const structured = result.structured;
    const writtenMemoryIds: string[] = [];

    for (const [index,event] of asRecordArray(structured?.logEvents).entries()) {
      const eventInput={
        workshopId: input.workshop.id,
        runId: input.run.id,
        type: stringValue(event.type, 'observation'),
        title: stringValue(event.title, '车间观察'),
        body: stringValue(event.body, ''),
        metadata: {
          ...(event.metadata && typeof event.metadata === 'object' ? event.metadata as Record<string, unknown> : {}),
          receiptAuthority: 'agent',
        },
      };
      if(input.executionLease){
        const lease=input.executionLease;
        await applyOutputStep(lease,'logEvents',index,event,({append})=>append({...eventInput,metadata:{...eventInput.metadata,actorId:input.userId,execution:{runId:lease.runId,workerId:lease.workerId,token:lease.token},outputStep:{kind:'logEvents',index}}}));
      }else await appendWorkshopEvent(eventInput);
    }

    for (const [index,memory] of (isConversationRun ? [] : asRecordArray(structured?.memoryCandidates)).entries()) {
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
      const writeMemory=async(append:typeof appendWorkshopEvent)=>{
      const writtenMemory =
        sourceEventIds.length > 0
          ? await writeBrainMemory({
              ...common,
              status: 'active',
            })
          : await createBrainMemoryCandidate(common);
      await append({
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
      return writtenMemory;
      };
      const writtenMemory=input.executionLease
        ?await applyOutputStep(input.executionLease,'memoryCandidates',index,memory,({append})=>writeMemory(append))
        :await writeMemory(appendWorkshopEvent);
      writtenMemoryIds.push(writtenMemory.id);
    }

    for (const [index,draft] of (isConversationRun ? [] : asRecordArray(structured?.outboxDrafts)).entries()) {
      const message = stringValue(draft.message).trim();
      if (!message) continue;
      const outboxNeed = evaluateOutboxDraftNeed(draft);
      if (!outboxNeed.ok) {
        const suppressedEvent={
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
        };
        if(input.executionLease)await applyOutputStep(input.executionLease,'outboxDrafts',index,draft,({append})=>append(suppressedEvent));
        else await appendWorkshopEvent(suppressedEvent);
        continue;
      }
      const sourceEventIds = await sourceEventIdsOrRecent({
        workshopId: input.workshop.id,
        runId: input.run.id,
        explicit: stringArray(draft.sourceEventIds),
      });
      const createDraft=()=>createOutboxDraft({
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
      const outboxDraft=input.executionLease
        ?await applyOutputStep(input.executionLease,'outboxDrafts',index,draft,createDraft)
        :await createDraft();
      await autoSendWorkshopOutboxIfWhitelisted({
        workshop: input.workshop,
        outbox: outboxDraft,
      });
    }

    if (!isConversationRun && structured?.nextWakeupSuggestion) {
      const suggestionEvent={
        workshopId: input.workshop.id,
        runId: input.run.id,
        type: 'next_wakeup_suggested',
        title: '智能体建议下次唤醒',
        body: stringValue(structured.nextWakeupSuggestion.reason),
        metadata: structured.nextWakeupSuggestion,
      };
      if(input.executionLease)await applyOutputStep(input.executionLease,'nextWakeupSuggestion',0,structured.nextWakeupSuggestion,({append})=>append(suggestionEvent));
      else await appendWorkshopEvent(suggestionEvent);
      await scheduleWorkshopWakeupFromSuggestion({
        workshop: input.workshop,
        runId: input.run.id,
        suggestion: structured.nextWakeupSuggestion,
      });
    }

    await complete({
      runId: input.run.id,
      status: result.status === 'success' ? 'completed' : 'failed',
      outputSummary: result.output,
      error: result.error ?? null,
      metadata: {toolCallCount:result.toolCallCount,durationMs:result.durationMs,presentation:normalizeWorkshopPresentation(structured?.presentation)},
      sourceMemoryIds: writtenMemoryIds,
    });
  } catch (error) {
    if(error instanceof ExecutionLeaseError) throw error;
    await guard?.();
    const message = error instanceof Error ? error.message : String(error);
    await complete({
      runId: input.run.id,
      status: 'failed',
      outputSummary: null,
      error: message,
    });
  } finally {
    await heartbeat?.stop();
    try {
      if(completionPersisted && !isConversationRun) await captureCompletedWorkshopRunEvidence(input.run.id);
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
  void input;
  throw new Error('legacy_workshop_start_retired_use_work_runtime');
}
