import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "next-auth";
import { z } from "zod";
import { inspectWorkshopAgentForUser } from "@/lib/ai/workshop-agent-inspector";
import { proposeWorkshopAgentChange } from "@/lib/workshops/agent-change-proposals";

const jsonRecordSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "A JSON object. Omit this field unless the user explicitly asks to change it.",
  );

export function createWorkshopAgentConfigTools(session: Session) {
  return [
    tool(
      "inspectWorkshopAgent",
      [
        "Inspect the owner's Workshop Work model before proposing any configuration change.",
        "Use this before changing an agent. It is read-only.",
        "If workshopId is unknown, use workshopName to find the closest match.",
        "The returned work field is the control contract: controlled objects, observations, skills, loops, boundaries, feedback, and missing pieces.",
      ].join("\n"),
      {
        workshopId: z.string().optional(),
        workshopName: z.string().optional(),
      },
      async ({ workshopId, workshopName }) => {
        const result = await inspectWorkshopAgentForUser({
          userId: session.user.id,
          workshopId,
          workshopName,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    ),
    tool(
      "proposeWorkshopAgentChange",
      [
        "Create an owner-reviewable proposal to change a Workshop Work configuration.",
        "This does not directly apply changes. It writes a proposal to the Workshop review queue.",
        "Use small, explicit patches. Do not propose deleting history, bypassing approvals, enabling real-money trading, or silently expanding external-write powers.",
      ].join("\n"),
      {
        workshopId: z.string().min(1),
        reason: z.string().min(6),
        riskLevel: z.enum(["low", "medium", "high"]).optional(),
        patch: z.object({
          name: z.string().optional(),
          mission: z.string().optional(),
          status: z.enum(["active", "paused", "archived"]).optional(),
          autonomyLevel: z.enum(["observe", "draft", "auto"]).optional(),
          boundaryPolicy: jsonRecordSchema,
          modelConfig: jsonRecordSchema,
        }),
      },
      async ({ workshopId, reason, riskLevel, patch }) => {
        try {
          const proposal = await proposeWorkshopAgentChange({
            userId: session.user.id,
            workshopId,
            patch,
            reason,
            riskLevel,
            proposedBy: "chat_agent",
            source: {
              surface: "workbench_chat",
              tool: "proposeWorkshopAgentChange",
            },
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: true,
                    message:
                      "已创建智能体修改提案，等待主人在车间审核中确认。",
                    proposalEventId: proposal.id,
                    workshopId,
                    title: proposal.title,
                    diff: proposal.metadata?.diff ?? [],
                    riskLevel: proposal.metadata?.riskLevel ?? riskLevel ?? null,
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
                    ok: false,
                    message:
                      error instanceof Error
                        ? error.message
                        : "创建智能体修改提案失败。",
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
