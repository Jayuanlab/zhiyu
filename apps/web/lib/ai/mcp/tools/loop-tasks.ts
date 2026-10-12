/**
 * Native Loop task tools.
 *
 * These replace the legacy scheduled_jobs tools for chat and external app
 * agents. All new timed/background tasks should be represented as rows in the
 * loops table and executed by the native loop scheduler.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Session } from "next-auth";
import type { UpdateLoopInput } from "@/lib/loops/types";
import { listLoopTasksForUser } from "@/lib/ai/loop-task-read-tools";
import { setLoopTaskStatusForUser } from "@/lib/ai/loop-task-control-tools";
import { loopUpdateReceiptSemantics } from "@/lib/work-runtime/loop-update-receipt";

type LoopSummaryInput = {
  id?: string;
  name?: string;
  description?: string | null;
  goal?: string;
  status?: string;
  workshopId?: string | null;
  triggerConfig?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
};

type DraftLike = {
  name?: string;
  description?: string | null;
  spec?: {
    goal?: string;
    trigger?: Record<string, unknown>;
    context?: Record<string, unknown>;
    actions?: Record<string, unknown>;
    verification?: Record<string, unknown>;
    approval?: Record<string, unknown>;
    retry?: Record<string, unknown>;
    escalation?: Record<string, unknown>;
  };
};

type WorkshopTargetInput = {
  id: string;
  name: string;
  status?: string | null;
};

type LoopCreationWorkshopTarget =
  | { status: "global" }
  | { status: "workshop"; workshopId: string; workshopName: string }
  | { status: "missing"; reason: string }
  | {
      status: "ambiguous";
      reason: string;
      matches: Array<{ id: string; name: string }>;
    };

function summarizeLoop(loop: LoopSummaryInput) {
  return {
    id: loop.id,
    name: loop.name,
    description: loop.description,
    goal: loop.goal,
    status: loop.status,
    workshopId: loop.workshopId ?? null,
    trigger: loop.triggerConfig,
    updatedAt: loop.updatedAt,
    createdAt: loop.createdAt,
  };
}

export function canDeleteLoopTaskFromChat(loop: {
  workshopId?: string | null;
}): boolean {
  return !loop.workshopId;
}

function shouldRenameLoop(intent: string) {
  return /rename|重命名|改名|名称|名字|叫做|命名为/i.test(intent);
}

function shouldReplaceLoopGoal(intent: string) {
  return /目标|内容|做什么|执行内容|改成做|改为做|goal|purpose/i.test(intent);
}

export function buildLoopTaskUpdateFromDraft(
  existing: {
    workshopId?: string | null;
    name?: string;
    description?: string | null;
    goal?: string;
    triggerConfig?: unknown;
    contextConfig?: unknown;
    actionPolicy?: unknown;
    verificationConfig?: unknown;
    approvalPolicy?: unknown;
    retryPolicy?: unknown;
    escalationPolicy?: unknown;
  },
  draft: DraftLike,
  intent: string,
): UpdateLoopInput {
  const update: UpdateLoopInput = {};
  const trigger = draft.spec?.trigger;
  if (trigger) {
    update.triggerConfig = {
      ...(existing.triggerConfig &&
      typeof existing.triggerConfig === "object" &&
      !Array.isArray(existing.triggerConfig)
        ? (existing.triggerConfig as Record<string, unknown>)
        : {}),
      ...trigger,
    };
  }

  if (shouldRenameLoop(intent) && draft.name) {
    update.name = draft.name;
  }

  if (shouldReplaceLoopGoal(intent)) {
    if (draft.spec?.goal) update.goal = draft.spec.goal;
    if (draft.description) update.description = draft.description;
  }

  if (!existing.workshopId) {
    if (draft.spec?.context) update.contextConfig = draft.spec.context;
    if (draft.spec?.actions) update.actionPolicy = draft.spec.actions;
    if (draft.spec?.verification) {
      update.verificationConfig = draft.spec.verification;
    }
    if (draft.spec?.approval) update.approvalPolicy = draft.spec.approval;
    if (draft.spec?.retry) update.retryPolicy = draft.spec.retry;
    if (draft.spec?.escalation) {
      update.escalationPolicy = draft.spec.escalation;
    }
  }

  return update;
}

function normalizeTargetText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[「」『』"'`]/g, "");
}

function isWorkshopFlavoredIntent(intent: string) {
  return /车间|工作区|workshop|work\b|智能体|agent|猎手|交易员|管家|助理/.test(
    intent.toLowerCase(),
  );
}

function uniqWorkshopTargets(matches: WorkshopTargetInput[]) {
  const seen = new Set<string>();
  return matches.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function resolveByWorkshopName(
  workshopName: string,
  workshops: WorkshopTargetInput[],
) {
  const targetName = normalizeTargetText(workshopName);
  const active = workshops.filter((workshop) => workshop.status !== "archived");
  const exact = active.filter(
    (workshop) => normalizeTargetText(workshop.name) === targetName,
  );
  if (exact.length > 0) return uniqWorkshopTargets(exact);
  return uniqWorkshopTargets(
    active.filter((workshop) => {
      const name = normalizeTargetText(workshop.name);
      return name.includes(targetName) || targetName.includes(name);
    }),
  );
}

export function resolveLoopCreationWorkshopTarget(input: {
  intent: string;
  workshopId?: string | null;
  workshopName?: string | null;
  workshops: WorkshopTargetInput[];
}): LoopCreationWorkshopTarget {
  const activeWorkshops = input.workshops.filter(
    (workshop) => workshop.status !== "archived",
  );

  if (input.workshopId) {
    const matched = activeWorkshops.find(
      (workshop) => workshop.id === input.workshopId,
    );
    if (!matched) {
      return {
        status: "missing",
        reason: `Workshop not found or archived: ${input.workshopId}`,
      };
    }
    return {
      status: "workshop",
      workshopId: matched.id,
      workshopName: matched.name,
    };
  }

  if (input.workshopName) {
    const matches = resolveByWorkshopName(input.workshopName, activeWorkshops);
    if (matches.length === 1) {
      return {
        status: "workshop",
        workshopId: matches[0].id,
        workshopName: matches[0].name,
      };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        reason: `More than one workshop matches: ${input.workshopName}`,
        matches: matches.map((workshop) => ({
          id: workshop.id,
          name: workshop.name,
        })),
      };
    }
    return {
      status: "missing",
      reason: `No workshop matches: ${input.workshopName}`,
    };
  }

  const normalizedIntent = normalizeTargetText(input.intent);
  const matches = uniqWorkshopTargets(
    activeWorkshops.filter((workshop) => {
      const name = normalizeTargetText(workshop.name);
      return Boolean(name) && normalizedIntent.includes(name);
    }),
  );

  if (matches.length === 1) {
    return {
      status: "workshop",
      workshopId: matches[0].id,
      workshopName: matches[0].name,
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: "The loop request mentions more than one workshop.",
      matches: matches.map((workshop) => ({
        id: workshop.id,
        name: workshop.name,
      })),
    };
  }
  if (isWorkshopFlavoredIntent(input.intent)) {
    return {
      status: "missing",
      reason:
        "The loop request appears to target a workshop, but no active workshop could be resolved.",
    };
  }
  return { status: "global" };
}

export function buildLoopTaskStateJsonAfterUpdate(input: {
  stateJson: Record<string, unknown>;
  updates: UpdateLoopInput;
  intent: string;
  updatedAt: Date;
  nextScheduledRunAt?: string | null;
}): Record<string, unknown> {
  const nextStateJson = { ...input.stateJson };
  const loopSpec =
    nextStateJson.loopSpec &&
    typeof nextStateJson.loopSpec === "object" &&
    !Array.isArray(nextStateJson.loopSpec)
      ? (nextStateJson.loopSpec as Record<string, unknown>)
      : null;

  if (input.updates.triggerConfig) {
    if (loopSpec) {
      const metadata =
        loopSpec.metadata &&
        typeof loopSpec.metadata === "object" &&
        !Array.isArray(loopSpec.metadata)
          ? (loopSpec.metadata as Record<string, unknown>)
          : {};

      nextStateJson.loopSpec = {
        ...loopSpec,
        trigger: input.updates.triggerConfig,
        metadata: {
          ...metadata,
          lastUpdatedFromChatIntent: input.intent,
          lastUpdatedAt: input.updatedAt.toISOString(),
        },
      };
    }

    nextStateJson.nextScheduledRunAt = input.nextScheduledRunAt ?? null;
    nextStateJson.schedulerStatus = "idle";
    Reflect.deleteProperty(nextStateJson, "schedulerError");
  }

  return nextStateJson;
}

export function createLoopTaskTools(session: Session) {
  return [
    tool(
      "createLoopTask",
      [
        "Create a native Zhiyu Loop task from the user's natural-language automation request.",
        "",
        "Use this for ALL recurring, scheduled, reminder, monitor, background, or timed tasks.",
        "Do not use legacy scheduled jobs. New tasks must be native loops.",
        "",
        "Examples:",
        "- User: '每天早上 9 点给文件传输助手发北京天气预报'",
        "- intent: '每天早上 9 点给文件传输助手发北京天气预报'",
        "",
        "Parameters:",
        "- intent: the user's original request. Preserve platform, recipient, time, and content.",
        "- workshopId/workshopName: required when the user asks to create the task for a workshop, agent, or Work.",
        "- timezone: user's timezone, default Asia/Shanghai.",
        "- externalWriteMode: loop_approved lets the background loop perform external writes when the task explicitly asks for it; manual_approval requires review.",
        "",
        "If the request mentions a workshop/agent/Work but the target cannot be uniquely resolved, refuse to create a global loop and ask for the target workshop.",
      ].join("\n"),
      {
        intent: z
          .string()
          .min(4)
          .describe(
            "The user's original automation request, preserving all details.",
          ),
        workshopId: z
          .string()
          .optional()
          .describe(
            "Existing workshop id when the loop belongs to a workshop/agent/Work.",
          ),
        workshopName: z
          .string()
          .optional()
          .describe(
            "Existing workshop name when the user names the target workshop in natural language.",
          ),
        timezone: z
          .string()
          .optional()
          .default("Asia/Shanghai")
          .describe("Timezone for the schedule."),
        externalWriteMode: z
          .enum(["manual_approval", "loop_approved"])
          .optional()
          .default("loop_approved")
          .describe(
            "Whether the created loop can execute explicit external writes in the background.",
          ),
      },
      async ({
        intent,
        workshopId,
        workshopName,
        timezone = "Asia/Shanghai",
        externalWriteMode,
      }) => {
        try {
          const { createLoopFromNaturalLanguage } = await import(
            "@/lib/loops/natural-language"
          );
          const { createWorkLoop } = await import("@/lib/work-runtime");
          const { listWorkshops } = await import("@/lib/workshops/service");

          const workshops = await listWorkshops(session.user.id, 100);
          const target = resolveLoopCreationWorkshopTarget({
            intent,
            workshopId,
            workshopName,
            workshops,
          });
          if (target.status === "missing" || target.status === "ambiguous") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      message:
                        "Refused to create a global loop because the request appears to target a workshop but the workshop target was not uniquely resolved.",
                      target,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const result =
            target.status === "workshop"
              ? await createWorkLoop({
                  userId: session.user.id,
                  workId: target.workshopId,
                  type: "natural_language",
                  intent,
                  timezone,
                  externalWriteMode,
                  create: true,
                  source: "chat_agent",
                  reason: intent,
                })
              : await createLoopFromNaturalLanguage({
                  userId: session.user.id,
                  intent,
                  timezone,
                  externalWriteMode,
                });
          if (!("loop" in result)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      message:
                        "Loop draft was created, but no task was persisted. Retry with create=true or ask the owner to confirm creation.",
                      draft: result.draft,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `Created native loop task: ${result.loop.name}`,
                    createdInWorkshop: target.status === "workshop",
                    workshop:
                      target.status === "workshop"
                        ? {
                            id: target.workshopId,
                            name: target.workshopName,
                          }
                        : null,
                    loop: summarizeLoop(result.loop),
                    draft: {
                      planner: result.draft?.planner ?? null,
                      extracted: result.draft?.extracted ?? null,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: false,
                    message: `Failed to create loop task: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "listLoopTasks",
      "List native Zhiyu Loop tasks for the current user.",
      {
        includeArchived: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include archived loop tasks."),
        limit: z.coerce.number().optional().default(50),
      },
      async ({ includeArchived = false, limit = 50 }) => {
        const result = await listLoopTasksForUser({
          userId: session.user.id,
          includeArchived,
          limit,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: result.text,
            },
          ],
          data: result.data,
          isError: result.isError,
        };
      },
    ),

    tool(
      "setLoopTaskStatus",
      "Pause, resume, or archive a native Zhiyu Loop task.",
      {
        loopId: z.string().min(1),
        status: z.enum(["active", "paused", "archived"]),
      },
      async ({ loopId, status }) => {
        const result = await setLoopTaskStatusForUser({
          userId: session.user.id,
          loopId,
          status,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: result.text,
            },
          ],
          data: result.data,
          isError: result.isError,
        };
      },
    ),

    tool(
      "updateLoopTask",
      [
        "Update an existing native Zhiyu Loop task in place from a natural-language change request.",
        "",
        "Use this when the user asks to modify an existing Loop task, such as changing its time, cadence, name, or objective.",
        "Do not delete and recreate a task to modify it. This preserves workshop ownership, Skill bindings, verifier fields, memory, runs, and audit history.",
        "For workshop-owned loops, this tool only patches the requested fields and keeps the workshop control policy intact.",
      ].join("\n"),
      {
        loopId: z
          .string()
          .min(1)
          .describe("The existing loop task id from listLoopTasks."),
        intent: z
          .string()
          .min(4)
          .describe(
            "The user's natural-language change request, preserving schedule and intent details.",
          ),
        timezone: z
          .string()
          .optional()
          .default("Asia/Shanghai")
          .describe("Timezone for schedule parsing."),
        externalWriteMode: z
          .enum(["manual_approval", "loop_approved"])
          .optional()
          .default("manual_approval"),
      },
      async ({
        loopId,
        intent,
        timezone = "Asia/Shanghai",
        externalWriteMode,
      }) => {
        try {
          const {
            computeNextLoopRun,
            getLoop,
            getLoopState,
            updateLoop,
            upsertLoopState,
          } = await import("@/lib/loops");
          const { draftLoopFromNaturalLanguage } = await import(
            "@/lib/loops/natural-language"
          );

          const existing = await getLoop(session.user.id, loopId);
          if (!existing) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { success: false, message: `Loop not found: ${loopId}` },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const draft = await draftLoopFromNaturalLanguage({
            userId: session.user.id,
            workshopId: existing.workshopId ?? undefined,
            intent,
            timezone,
            externalWriteMode,
          });
          if (draft.extracted.missingFields.length > 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      message: `Missing required loop update fields: ${draft.extracted.missingFields.join(", ")}`,
                      draft: {
                        planner: draft.planner,
                        extracted: draft.extracted,
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const updates = buildLoopTaskUpdateFromDraft(
            existing,
            draft,
            intent,
          );
          if (Object.keys(updates).length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      message:
                        "No safe in-place loop update could be derived. Ask the user for the exact field to change.",
                      draft: {
                        planner: draft.planner,
                        extracted: draft.extracted,
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          let updatedLoop = null;
          let nextRunIso: string | null | undefined;
          let receiptSemantics = loopUpdateReceiptSemantics({ status: "not_recomputed" });
          if (existing.workshopId) {
            const { updateWorkLoop } = await import("@/lib/work-runtime");
            const result = await updateWorkLoop({
              userId: session.user.id,
              workId: existing.workshopId,
              loopId,
              patch: updates,
              source: "chat_agent",
              reason: intent,
            });
            updatedLoop = result.loop;
            nextRunIso = result.nextScheduledRunAt;
            receiptSemantics = result.receiptSemantics;
          } else {
            updatedLoop = await updateLoop(session.user.id, loopId, updates);
          }

          if (!updatedLoop) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { success: false, message: `Loop not found: ${loopId}` },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          if (!existing.workshopId && updates.triggerConfig) {
            const state = await getLoopState(loopId);
            const stateJson =
              state?.stateJson &&
              typeof state.stateJson === "object" &&
              !Array.isArray(state.stateJson)
                ? state.stateJson
                : {};
            const updatedAt = new Date();
            const nextRun = computeNextLoopRun({
              triggerConfig: updates.triggerConfig,
              from: updatedAt,
            });
            nextRunIso = nextRun?.toISOString() ?? null;
            receiptSemantics = loopUpdateReceiptSemantics({ status: "recomputed", nextScheduledRunAt: nextRunIso });
            await upsertLoopState(loopId, {
              nextAction: nextRun
                ? `Next scheduled run at ${nextRun.toISOString()}`
                : "Run manually or update the task schedule.",
              blockedReason: null,
              stateJson: buildLoopTaskStateJsonAfterUpdate({
                stateJson,
                updates,
                intent,
                updatedAt,
                nextScheduledRunAt: nextRunIso,
              }),
            });
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `Updated loop task in place: ${updatedLoop.name}`,
                    loop: summarizeLoop(updatedLoop),
                    updatedFields: Object.keys(updates),
                    preservedWorkshopOwnership: Boolean(existing.workshopId),
                    ...(nextRunIso !== undefined ? { nextScheduledRunAt: nextRunIso } : {}),
                    receiptSemantics,
                    draft: {
                      planner: draft.planner,
                      extracted: draft.extracted,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: false,
                    message: `Failed to update loop task: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "deleteLoopTask",
      [
        "Delete a native Zhiyu Loop task permanently.",
        "Only use when the user explicitly asks to delete/remove the task.",
        "Never use this to modify a task. Use updateLoopTask for edits.",
        "Workshop-owned loops cannot be deleted by ordinary chat tools because they belong to a Work control contract.",
      ].join("\n"),
      {
        loopId: z.string().min(1),
      },
      async ({ loopId }) => {
        try {
          const { deleteLoop, getLoop } = await import("@/lib/loops");
          const loop = await getLoop(session.user.id, loopId);
          if (!loop) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { success: false, message: `Loop not found: ${loopId}` },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
          if (!canDeleteLoopTaskFromChat(loop)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      message:
                        "Refused to delete a workshop-owned loop from ordinary chat. Use updateLoopTask for modifications, or manage the loop from its workshop review surface.",
                      loop: summarizeLoop(loop),
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
          const deleted = await deleteLoop(session.user.id, loopId);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: deleted,
                    message: deleted
                      ? `Deleted loop task: ${loopId}`
                      : `Loop not found: ${loopId}`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: !deleted,
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: false,
                    message: `Failed to delete loop task: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    ),
  ];
}
