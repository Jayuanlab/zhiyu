import { getWorkshopBoundaryPolicy } from "@/lib/workshops/boundary-policy";
import { listRegisteredAgentTools } from "./registry";
import { resolveWorkshopSdkAllowedTools } from "@/lib/workshops/tool-access";
import type { Workshop } from "@/lib/db/schema";
import type {
  AgentToolAvailability,
  AgentToolDescriptor,
  AgentToolMatrix,
  AgentToolMatrixCounts,
  AgentToolMatrixItem,
  AgentToolRisk,
  AgentToolRuntime,
  AgentToolSource,
} from "./types";

type WorkshopPolicyInput = Parameters<typeof getWorkshopBoundaryPolicy>[0] & Partial<Pick<Workshop, "modelConfig">>;

type BuildAgentToolMatrixInput = {
  runtime: AgentToolRuntime;
  workshopId?: string;
  workshop?: WorkshopPolicyInput | null;
};

const SOURCES: AgentToolSource[] = [
  "claude_builtin",
  "business_tools",
  "workshop_tools",
  "skill",
  "user_mcp",
];

const RISKS: AgentToolRisk[] = ["low", "medium", "high", "critical"];

function unavailableReason(tool: AgentToolDescriptor, runtime: AgentToolRuntime) {
  const scopes = new Set(tool.runtimeScopes);
  if (scopes.size === 1) {
    if (scopes.has("chat")) return "仅普通对话运行时开放";
    if (scopes.has("workshop")) return "仅智能体车间运行时开放";
    if (scopes.has("loop") || scopes.has("cron")) return "仅后台任务运行时开放";
  }
  return `当前 ${runtime} 运行时未开放该工具`;
}

function unavailableAvailability(
  tool: AgentToolDescriptor,
): AgentToolAvailability {
  const scopes = new Set(tool.runtimeScopes);
  if (scopes.size === 1) {
    if (scopes.has("chat")) return "chat_only";
    if (scopes.has("workshop")) return "workshop_only";
    if (scopes.has("loop") || scopes.has("cron")) return "loop_only";
  }
  return "disabled";
}

function evaluateTool(
  tool: AgentToolDescriptor,
  input: BuildAgentToolMatrixInput,
): Pick<
  AgentToolMatrixItem,
  "availability" | "decisionReason" | "confirmation" | "effectivePolicy"
> {
  const { runtime, workshop } = input;
  if (workshop && !resolveWorkshopSdkAllowedTools({ modelConfig: workshop.modelConfig ?? {} }, [tool.name]).length) {
    return { availability: "deny", decisionReason: "当前车间角色或禁止策略拒绝该工具" };
  }
  if (!tool.runtimeScopes.includes(runtime)) {
    return {
      availability: unavailableAvailability(tool),
      decisionReason: unavailableReason(tool, runtime),
    };
  }

  if (tool.source === "user_mcp") {
    return {
      availability: "unknown",
      decisionReason:
        "自定义 MCP 的具体工具名来自本机配置，需在执行前探测并单独纳入白名单",
    };
  }

  if (runtime === "loop") {
    if (tool.name === "createLoopTask") {
      return {
        availability: "deny",
        decisionReason: "后台任务执行器显式排除 createLoopTask，避免任务自我复制",
      };
    }
    if (tool.capabilities.includes("external_send")) {
      return {
        availability: "require_approval",
        decisionReason: "后台外发由 Loop actionPolicy/approvalPolicy 做运行时审批",
        confirmation: {
          surface: "loop_approval",
          label: "任务审批",
          description:
            "后台任务真正调用外发工具时，会生成审批请求；在对应任务详情里批准、拒绝或恢复执行。",
        },
      };
    }
  }

  if (runtime === "chat" && tool.capabilities.includes("external_send")) {
    return {
      availability: "require_approval",
      decisionReason: "普通对话可准备外发动作，但直接发送必须经过用户确认",
      confirmation: {
        surface: "chat_confirm",
        label: "对话内确认",
        description:
          "普通对话里智能体只能提出外发动作，真正发送前需要用户在当前对话中明确确认。",
      },
    };
  }

  if (runtime === "workshop") {
    const policy = workshop ? getWorkshopBoundaryPolicy(workshop) : null;
    const effectivePolicy = policy
      ? {
          mode: policy.mode,
          externalMessages: policy.externalMessages,
          allowWechatPreview: policy.allowWechatPreview,
          requireSourcesForOutbox: policy.requireSourcesForOutbox,
          minConfidenceToDraft: policy.minConfidenceToDraft,
          minConfidenceToSend: policy.minConfidenceToSend,
        }
      : undefined;

    if (tool.capabilities.includes("external_send")) {
      return {
        availability: "deny",
        decisionReason: "车间运行时不直接外发消息，只能进入 outbox 或草稿边界",
        effectivePolicy,
      };
    }

    if (
      tool.name === "douyinPrepareUpload" ||
      tool.name === "douyinPublishApprovedDraft"
    ) {
      return {
        availability: "require_approval",
        decisionReason:
          "Douyin publishing touches an external public platform, so the workshop can only create an approval-ready publish plan.",
        confirmation: {
          surface: "workshop_review_tab",
          label: "审核页确认",
          description:
            "工具会生成抖音上传/发布提案；主人确认后才应执行实际上传或发布命令。",
        },
        effectivePolicy,
      };
    }

    if (tool.capabilities.includes("external_draft")) {
      if (policy?.externalMessages === "blocked") {
        return {
          availability: "deny",
          decisionReason: "当前边界策略禁止外部消息草稿和外发",
          effectivePolicy,
        };
      }
      return {
        availability: "require_approval",
        decisionReason:
          policy?.externalMessages === "auto"
            ? "可创建 outbox/草稿，是否自动发送由白名单、置信度和边界检查决定"
            : "只能创建 outbox/草稿，最终发送需要用户确认",
        confirmation: {
          surface: "workshop_outbox_tab",
          label: "发信页确认",
          description:
            policy?.externalMessages === "auto"
              ? "工具先创建 outbox/草稿；如未满足自动外发条件，就在发信页生成预览并确认发送。"
              : "工具只创建 outbox/草稿；进入发信页生成预览、补充收件人并确认发送。",
        },
        effectivePolicy,
      };
    }

    if (tool.name === "quantPaperProposeWatchlistChange") {
      return {
        availability: "allow",
        decisionReason:
          "自选股调整暂时放开人工审核；工具校验通过后会自动应用，仍会阻止移除持仓/未成交委托和超过上限等无效变更。",
        effectivePolicy,
      };
    }

    if (tool.name === "workshopCreateLoopTask") {
      return {
        availability: "require_approval",
        decisionReason: "车间只能创建暂停的任务提案，需要用户激活后才会运行",
        confirmation: {
          surface: "workshop_task_tab",
          label: "任务页激活",
          description:
            "工具只创建暂停的任务提案；进入任务页查看提案后，点击激活或拒绝。",
        },
        effectivePolicy,
      };
    }
  }

  return {
    availability: "allow",
    decisionReason: "当前运行时 allowlist 开放该工具",
  };
}

function createEmptyCounts(): AgentToolMatrixCounts {
  return {
    total: 0,
    allow: 0,
    requireApproval: 0,
    deny: 0,
    disabled: 0,
    unknown: 0,
    bySource: Object.fromEntries(SOURCES.map((source) => [source, 0])) as Record<
      AgentToolSource,
      number
    >,
    byRisk: Object.fromEntries(RISKS.map((risk) => [risk, 0])) as Record<
      AgentToolRisk,
      number
    >,
  };
}

function countTools(tools: AgentToolMatrixItem[]) {
  const counts = createEmptyCounts();
  counts.total = tools.length;
  for (const tool of tools) {
    counts.bySource[tool.source] += 1;
    counts.byRisk[tool.risk] += 1;
    if (tool.availability === "allow") counts.allow += 1;
    else if (tool.availability === "require_approval") {
      counts.requireApproval += 1;
    } else if (tool.availability === "deny") counts.deny += 1;
    else if (tool.availability === "unknown") counts.unknown += 1;
    else counts.disabled += 1;
  }
  return counts;
}

export function buildAgentToolMatrix(
  input: BuildAgentToolMatrixInput,
): AgentToolMatrix {
  const tools = listRegisteredAgentTools()
    .map((tool) => ({
      ...tool,
      ...evaluateTool(tool, input),
    }))
    .sort((a, b) => {
      const availabilityRank: Record<AgentToolAvailability, number> = {
        allow: 0,
        require_approval: 1,
        unknown: 2,
        deny: 3,
        disabled: 4,
        workshop_only: 5,
        loop_only: 5,
        chat_only: 5,
      };
      return (
        availabilityRank[a.availability] - availabilityRank[b.availability] ||
        a.source.localeCompare(b.source) ||
        a.displayName.localeCompare(b.displayName)
      );
    });

  return {
    runtime: input.runtime,
    workshopId: input.workshopId,
    generatedAt: new Date().toISOString(),
    tools,
    counts: countTools(tools),
  };
}
