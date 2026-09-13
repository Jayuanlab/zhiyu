import { z } from "zod";
import type { Loop } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { createLoop } from "./service";
import {
  loopSpecToCreateLoopInput,
  parseLoopSpec,
  type LoopSpec,
} from "./spec";

export const PROJECT_RISK_REVIEW_TEMPLATE_ID = "project-risk-review";
export const DAILY_BRIEF_TEMPLATE_ID = "daily-brief";
export const MEETING_PREP_TEMPLATE_ID = "meeting-prep";
export const WEEKLY_UPDATE_TEMPLATE_ID = "weekly-update";
export const PERSONAL_CRM_FOLLOW_UP_TEMPLATE_ID = "personal-crm-follow-up";
export const WORK_SELF_AUDIT_TEMPLATE_ID = "work-self-audit";

export type LoopTemplateId =
  | typeof PROJECT_RISK_REVIEW_TEMPLATE_ID
  | typeof DAILY_BRIEF_TEMPLATE_ID
  | typeof MEETING_PREP_TEMPLATE_ID
  | typeof WEEKLY_UPDATE_TEMPLATE_ID
  | typeof PERSONAL_CRM_FOLLOW_UP_TEMPLATE_ID
  | typeof WORK_SELF_AUDIT_TEMPLATE_ID;

export interface LoopTemplateDefinition {
  id: LoopTemplateId;
  name: string;
  description: string;
  defaultCronExpression: string;
  requiredInputFields: string[];
  buildSpec: (input: LoopTemplateInput) => LoopSpec;
  buildLoopName: (input: LoopTemplateInput) => string;
  buildLoopDescription: (input: LoopTemplateInput) => string;
}

export interface LoopTemplateInput {
  userId: string;
  workshopId?: string | null;
  templateId: LoopTemplateId;
  timezone?: string;
  cronExpression?: string;
  description?: string;
  projectName?: string;
  meetingTopic?: string;
  contactGroup?: string;
  connectorSources?: Array<{
    platform: string;
    project?: string;
    name?: string;
  }>;
  modelChecker?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    maxInputChars?: number;
  };
}

export interface ProjectRiskReviewTemplateInput {
  userId: string;
  projectName: string;
  timezone?: string;
  cronExpression?: string;
  description?: string;
  connectorSources?: Array<{
    platform: string;
    project?: string;
    name?: string;
  }>;
  modelChecker?: LoopTemplateInput["modelChecker"];
}

const templateInputSchema = z.object({
  userId: z.string().min(1),
  workshopId: z.string().min(1).nullable().optional(),
  templateId: z.enum([
    PROJECT_RISK_REVIEW_TEMPLATE_ID,
    DAILY_BRIEF_TEMPLATE_ID,
    MEETING_PREP_TEMPLATE_ID,
    WEEKLY_UPDATE_TEMPLATE_ID,
    PERSONAL_CRM_FOLLOW_UP_TEMPLATE_ID,
    WORK_SELF_AUDIT_TEMPLATE_ID,
  ]),
  timezone: z.string().optional(),
  cronExpression: z.string().optional(),
  description: z.string().optional(),
  projectName: z.string().optional(),
  meetingTopic: z.string().optional(),
  contactGroup: z.string().optional(),
  connectorSources: z
    .array(
      z.object({
        platform: z.string().min(1),
        project: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .optional(),
  modelChecker: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      maxInputChars: z.number().int().min(2_000).max(50_000).optional(),
    })
    .strict()
    .optional(),
});

function requireText(value: string | undefined, fieldName: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function cron(input: LoopTemplateInput, fallback: string) {
  return {
    type: "cron" as const,
    expression: input.cronExpression ?? fallback,
    timezone: input.timezone ?? "UTC",
  };
}

function connectorSources(input: LoopTemplateInput, fallbackProject?: string) {
  return (input.connectorSources ?? []).map((source) => ({
    type: "connector" as const,
    platform: source.platform,
    project: source.project ?? fallbackProject,
    name:
      source.name ??
      [source.platform, source.project ?? fallbackProject]
        .filter(Boolean)
        .join(" "),
  }));
}

function applyTemplateOverrides(
  spec: LoopSpec,
  input: LoopTemplateInput,
): LoopSpec {
  if (!input.modelChecker) {
    return spec;
  }

  return parseLoopSpec({
    ...spec,
    verification: {
      ...spec.verification,
      modelChecker: input.modelChecker,
    },
  });
}

function commonActions() {
  return {
    allowed: [
      "searchUnifiedMemory",
      "searchMemoryPath",
      "chatInsight",
      "modifyInsight",
      "createInsight",
    ],
    requiresApproval: [
      "sendMessage",
      "sendEmail",
      "modifyExternalTicket",
      "createCalendarEvent",
    ],
    denied: [],
  };
}

function commonApproval() {
  return {
    defaultMode: "allow" as const,
    externalWrites: "require_approval" as const,
  };
}

function commonEscalation() {
  return {
    onBlocked: "notify_user" as const,
    onNeedsApproval: "notify_user" as const,
  };
}

function buildProjectRiskReviewTemplateSpec(
  input: LoopTemplateInput,
): LoopSpec {
  const projectName = requireText(input.projectName, "projectName");

  return parseLoopSpec({
    version: 1,
    templateId: PROJECT_RISK_REVIEW_TEMPLATE_ID,
    goal: `Review ${projectName} project risk and identify blockers, owners, and next actions.`,
    trigger: cron(input, "0 9 * * 1-5"),
    context: {
      sources: [
        {
          type: "insight",
          filter: `project:${projectName}`,
          name: `${projectName} insights`,
        },
        {
          type: "memory",
          query: `${projectName} project risks blockers owners decisions`,
          name: `${projectName} memory`,
        },
        ...connectorSources(input, projectName),
      ],
      instructions:
        "Focus on delivery risk, blocked work, missing owners, overdue follow-ups, and decisions that need user attention.",
    },
    actions: commonActions(),
    verification: {
      type: "structured_check",
      successCriteria: [
        "At least one project insight or memory source was checked",
        "A risk level is present",
        "Blockers include owner and next action when available",
        "External writes are not performed without approval",
      ],
      requiredFields: ["riskLevel", "summary", "nextActions"],
      requiredSources: ["insight", "memory"],
    },
    retry: {
      maxAttempts: 2,
      onFailure: "summarize_and_block",
    },
    approval: commonApproval(),
    escalation: commonEscalation(),
    metadata: {
      projectName,
      templateId: PROJECT_RISK_REVIEW_TEMPLATE_ID,
    },
  });
}

function buildDailyBriefLoopSpec(input: LoopTemplateInput): LoopSpec {
  return parseLoopSpec({
    version: 1,
    templateId: DAILY_BRIEF_TEMPLATE_ID,
    goal: "Prepare a daily brief of important updates, risks, commitments, and decisions that need attention.",
    trigger: cron(input, "0 8 * * 1-5"),
    context: {
      sources: [
        {
          type: "insight",
          filter: "focus:important",
          name: "Important insights",
        },
        {
          type: "memory",
          query: "recent commitments follow ups decisions risks",
          name: "Recent memory",
        },
        ...connectorSources(input),
      ],
      instructions:
        "Prioritize items that changed since the previous brief and call out decisions, deadlines, blockers, and unanswered messages.",
    },
    actions: commonActions(),
    verification: {
      type: "structured_check",
      successCriteria: [
        "Important updates were summarized",
        "Risks or blockers were identified when present",
        "Next actions are explicit",
      ],
      requiredFields: ["summary", "nextActions"],
      requiredSources: ["insight", "memory"],
    },
    retry: { maxAttempts: 2, onFailure: "summarize_and_block" },
    approval: commonApproval(),
    escalation: commonEscalation(),
    metadata: { templateId: DAILY_BRIEF_TEMPLATE_ID },
  });
}

function buildMeetingPrepLoopSpec(input: LoopTemplateInput): LoopSpec {
  const meetingTopic = requireText(input.meetingTopic, "meetingTopic");

  return parseLoopSpec({
    version: 1,
    templateId: MEETING_PREP_TEMPLATE_ID,
    goal: `Prepare context, open questions, risks, and suggested agenda for ${meetingTopic}.`,
    trigger: cron(input, "0 7 * * 1-5"),
    context: {
      sources: [
        {
          type: "insight",
          filter: `meeting:${meetingTopic}`,
          name: `${meetingTopic} insights`,
        },
        {
          type: "memory",
          query: `${meetingTopic} agenda decisions open questions risks`,
          name: `${meetingTopic} memory`,
        },
        { type: "connector", platform: "calendar", name: "Calendar events" },
        ...connectorSources(input),
      ],
      instructions:
        "Prepare only actionable meeting context: recent decisions, unresolved questions, risks, owners, and suggested agenda.",
    },
    actions: commonActions(),
    verification: {
      type: "structured_check",
      successCriteria: [
        "Meeting context was checked",
        "Agenda or talking points are present",
        "Open questions are present when available",
      ],
      requiredFields: ["summary", "nextActions"],
      requiredSources: ["memory"],
    },
    retry: { maxAttempts: 2, onFailure: "summarize_and_block" },
    approval: commonApproval(),
    escalation: commonEscalation(),
    metadata: { meetingTopic, templateId: MEETING_PREP_TEMPLATE_ID },
  });
}

function buildWeeklyUpdateLoopSpec(input: LoopTemplateInput): LoopSpec {
  const projectName = input.projectName?.trim();
  const scope = projectName || "all active work";

  return parseLoopSpec({
    version: 1,
    templateId: WEEKLY_UPDATE_TEMPLATE_ID,
    goal: `Prepare a weekly update for ${scope}: progress, decisions, risks, and next actions.`,
    trigger: cron(input, "0 16 * * 5"),
    context: {
      sources: [
        {
          type: "insight",
          filter: projectName ? `project:${projectName}` : "time:week",
          name: projectName ? `${projectName} insights` : "Weekly insights",
        },
        {
          type: "memory",
          query: `${scope} weekly progress decisions risks next actions`,
          name: "Weekly memory",
        },
        ...connectorSources(input, projectName),
      ],
      instructions:
        "Produce a concise weekly status update with progress, risks, decisions made, and next-week priorities.",
    },
    actions: commonActions(),
    verification: {
      type: "structured_check",
      successCriteria: [
        "Progress is summarized",
        "Risks are included when present",
        "Next-week actions are included",
      ],
      requiredFields: ["summary", "nextActions"],
      requiredSources: ["insight", "memory"],
    },
    retry: { maxAttempts: 2, onFailure: "summarize_and_block" },
    approval: commonApproval(),
    escalation: commonEscalation(),
    metadata: { projectName, templateId: WEEKLY_UPDATE_TEMPLATE_ID },
  });
}

function buildPersonalCrmFollowUpLoopSpec(input: LoopTemplateInput): LoopSpec {
  const contactGroup = input.contactGroup?.trim() || "important contacts";

  return parseLoopSpec({
    version: 1,
    templateId: PERSONAL_CRM_FOLLOW_UP_TEMPLATE_ID,
    goal: `Review ${contactGroup} and identify relationships that need follow-up.`,
    trigger: cron(input, "0 10 * * 1"),
    context: {
      sources: [
        {
          type: "insight",
          filter: `people:${contactGroup}`,
          name: `${contactGroup} insights`,
        },
        {
          type: "memory",
          query: `${contactGroup} relationships follow ups unanswered messages commitments`,
          name: `${contactGroup} memory`,
        },
        ...connectorSources(input),
      ],
      instructions:
        "Find people who need a response, follow-up, thank-you, decision, or relationship touchpoint. Draft external messages only as suggestions.",
    },
    actions: commonActions(),
    verification: {
      type: "structured_check",
      successCriteria: [
        "Relevant relationship context was checked",
        "Follow-up candidates are identified",
        "External messages are suggestions unless approved",
      ],
      requiredFields: ["summary", "suggestedActions"],
      requiredSources: ["memory"],
    },
    retry: { maxAttempts: 2, onFailure: "summarize_and_block" },
    approval: commonApproval(),
    escalation: commonEscalation(),
    metadata: {
      contactGroup,
      templateId: PERSONAL_CRM_FOLLOW_UP_TEMPLATE_ID,
    },
  });
}

function buildWorkSelfAuditLoopSpec(input: LoopTemplateInput): LoopSpec {
  return parseLoopSpec({
    version: 1,
    templateId: WORK_SELF_AUDIT_TEMPLATE_ID,
    goal:
      "Run a closed-loop Work self-audit: inspect the workshop Work model, identify missing control surfaces, and create owner-reviewable configuration proposals when a small patch can improve stability.",
    trigger: cron(input, "0 3 * * *"),
    context: {
      sources: [
        {
          type: "memory",
          query:
            "workshop work architecture control contract skill binding loop health tool boundary version history",
          name: "Work control memory",
        },
      ],
      instructions: [
        "Follow the engineering cybernetics rule: observe first, model second, close the loop before automating, define boundaries before acting, prefer stability over cleverness.",
        "Always call workshopInspectWork before deciding. Review manifest, controlContract, skillBindings, loopBindings, feedback, observability, changeControl, recent events, and recent Work versions.",
        "If the Work is healthy, log a concise workshopLogEvent with workHealthSummary and nextControlAction.",
        "If a narrow configuration improvement is justified, call workshopProposeAgentChange. Do not apply changes directly.",
        "Configuration proposals must be small patches. Do not weaken denied actions, enable real-money trading, bypass review, delete history, or silently expand external-write powers.",
        "Only propose a new durable Loop through workshopCreateLoopTask when a missing feedback loop materially affects the Work mission.",
      ].join("\n"),
    },
    actions: {
      allowed: [
        "workshopInspectWork",
        "workshopLogEvent",
        "workshopProposeAgentChange",
        "workshopCreateLoopTask",
        "workshopSearchMemory",
        "workshopRecordMemoryRecallFeedback",
        "workshopWriteMemory",
        "workshopReadLinkedWorkshopEvents",
      ],
      requiresApproval: [],
      denied: [
        "wechatDesktopSendMessage",
        "douyinPublishApprovedDraft",
        "quantPaperPlaceOrder",
        "quantPaperCancelOrder",
        "deleteLoopTask",
      ],
    },
    verification: {
      type: "structured_check",
      successCriteria: [
        "The current Work model was inspected before any proposal",
        "Observed gaps are explicit and tied to evidence",
        "Any configuration change is represented as an owner-reviewable proposal",
        "No external write, real trade, deletion, or direct configuration apply was executed",
      ],
      requiredFields: [
        "workHealthSummary",
        "observedGaps",
        "proposalsCreated",
        "nextControlAction",
      ],
      requiredSources: ["work"],
    },
    retry: { maxAttempts: 2, onFailure: "summarize_and_block" },
    approval: {
      defaultMode: "allow",
      externalWrites: "deny",
    },
    escalation: commonEscalation(),
    metadata: {
      templateId: WORK_SELF_AUDIT_TEMPLATE_ID,
      controlLoop: "work_self_audit",
    },
  });
}

export const LOOP_TEMPLATE_REGISTRY: Record<
  LoopTemplateId,
  LoopTemplateDefinition
> = {
  [PROJECT_RISK_REVIEW_TEMPLATE_ID]: {
    id: PROJECT_RISK_REVIEW_TEMPLATE_ID,
    name: "项目风险审查",
    description: "审查项目风险、阻塞项、负责人和后续行动。",
    defaultCronExpression: "0 9 * * 1-5",
    requiredInputFields: ["projectName"],
    buildSpec: buildProjectRiskReviewTemplateSpec,
    buildLoopName: (input) =>
      `${requireText(input.projectName, "projectName")} Risk Review`,
    buildLoopDescription: (input) =>
      input.description ??
      `Recurring risk review loop for ${requireText(input.projectName, "projectName")}.`,
  },
  [DAILY_BRIEF_TEMPLATE_ID]: {
    id: DAILY_BRIEF_TEMPLATE_ID,
    name: "每日简报",
    description: "汇总重要更新、风险和后续行动。",
    defaultCronExpression: "0 8 * * 1-5",
    requiredInputFields: [],
    buildSpec: buildDailyBriefLoopSpec,
    buildLoopName: () => "Daily Brief",
    buildLoopDescription: (input) =>
      input.description ?? "Daily brief loop for important work updates.",
  },
  [MEETING_PREP_TEMPLATE_ID]: {
    id: MEETING_PREP_TEMPLATE_ID,
    name: "会议准备",
    description: "为会议准备上下文、议程、问题和风险。",
    defaultCronExpression: "0 7 * * 1-5",
    requiredInputFields: ["meetingTopic"],
    buildSpec: buildMeetingPrepLoopSpec,
    buildLoopName: (input) =>
      `${requireText(input.meetingTopic, "meetingTopic")} Meeting Prep`,
    buildLoopDescription: (input) =>
      input.description ??
      `Meeting preparation loop for ${requireText(input.meetingTopic, "meetingTopic")}.`,
  },
  [WEEKLY_UPDATE_TEMPLATE_ID]: {
    id: WEEKLY_UPDATE_TEMPLATE_ID,
    name: "周报",
    description: "准备每周进展、风险、决策和优先级。",
    defaultCronExpression: "0 16 * * 5",
    requiredInputFields: [],
    buildSpec: buildWeeklyUpdateLoopSpec,
    buildLoopName: (input) =>
      input.projectName?.trim()
        ? `${input.projectName.trim()} Weekly Update`
        : "Weekly Update",
    buildLoopDescription: (input) =>
      input.description ??
      (input.projectName?.trim()
        ? `Weekly update loop for ${input.projectName.trim()}.`
        : "Weekly update loop for active work."),
  },
  [PERSONAL_CRM_FOLLOW_UP_TEMPLATE_ID]: {
    id: PERSONAL_CRM_FOLLOW_UP_TEMPLATE_ID,
    name: "个人 CRM 跟进",
    description: "找出需要跟进的关系和对话。",
    defaultCronExpression: "0 10 * * 1",
    requiredInputFields: [],
    buildSpec: buildPersonalCrmFollowUpLoopSpec,
    buildLoopName: (input) =>
      input.contactGroup?.trim()
        ? `${input.contactGroup.trim()} Follow-up`
        : "Personal CRM Follow-up",
    buildLoopDescription: (input) =>
      input.description ??
      `Follow-up loop for ${input.contactGroup?.trim() || "important contacts"}.`,
  },
  [WORK_SELF_AUDIT_TEMPLATE_ID]: {
    id: WORK_SELF_AUDIT_TEMPLATE_ID,
    name: "Work 自检升级",
    description:
      "定期检查车间 Work 模型、工具边界、Skill、Loop 和版本状态，并生成可审核改造提案。",
    defaultCronExpression: "0 3 * * *",
    requiredInputFields: [],
    buildSpec: buildWorkSelfAuditLoopSpec,
    buildLoopName: () => "Work 自检升级",
    buildLoopDescription: (input) =>
      input.description ??
      "每天自检车间 Work 模型，发现缺口时生成可审核的智能体改造提案。",
  },
};

export function listLoopTemplates(): LoopTemplateDefinition[] {
  return Object.values(LOOP_TEMPLATE_REGISTRY);
}

export function getLoopTemplate(
  templateId: string,
): LoopTemplateDefinition | null {
  return (
    (LOOP_TEMPLATE_REGISTRY as Record<string, LoopTemplateDefinition>)[
      templateId
    ] ?? null
  );
}

export function buildLoopSpecFromTemplate(input: LoopTemplateInput): LoopSpec {
  const parsed = templateInputSchema.parse(input);
  const template = getLoopTemplate(parsed.templateId);
  if (!template) {
    throw new Error(`Unknown loop template: ${parsed.templateId}`);
  }
  return applyTemplateOverrides(template.buildSpec(parsed), parsed);
}

export async function createLoopFromTemplate(
  input: LoopTemplateInput,
  store?: DrizzleDB,
): Promise<Loop> {
  const parsed = templateInputSchema.parse(input);
  const template = getLoopTemplate(parsed.templateId);
  if (!template) {
    throw new Error(`Unknown loop template: ${parsed.templateId}`);
  }

  const spec = applyTemplateOverrides(template.buildSpec(parsed), parsed);
  return createLoop(
    loopSpecToCreateLoopInput({
      userId: parsed.userId,
      workshopId: parsed.workshopId ?? null,
      name: template.buildLoopName(parsed),
      description: template.buildLoopDescription(parsed),
      spec,
    }),
    store,
  );
}

export function buildProjectRiskReviewLoopSpec(
  input: Omit<ProjectRiskReviewTemplateInput, "userId">,
): LoopSpec {
  return LOOP_TEMPLATE_REGISTRY[PROJECT_RISK_REVIEW_TEMPLATE_ID].buildSpec({
    ...input,
    userId: "__template__",
    templateId: PROJECT_RISK_REVIEW_TEMPLATE_ID,
  });
}

export async function createProjectRiskReviewLoop(
  input: ProjectRiskReviewTemplateInput,
): Promise<Loop> {
  return createLoopFromTemplate({
    ...input,
    templateId: PROJECT_RISK_REVIEW_TEMPLATE_ID,
  });
}
