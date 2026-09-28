export type AgentToolRuntime = "chat" | "workshop" | "loop" | "cron";

export type AgentToolSource =
  | "claude_builtin"
  | "pi_builtin"
  | "business_tools"
  | "workshop_tools"
  | "skill"
  | "user_mcp";

export type AgentToolCapability =
  | "file_read"
  | "file_write"
  | "code_exec"
  | "web_read"
  | "memory_read"
  | "memory_write"
  | "knowledge_read"
  | "message_read"
  | "external_draft"
  | "external_send"
  | "task_create"
  | "task_manage"
  | "market_data"
  | "browser"
  | "desktop"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "time"
  | "unknown";

export type AgentToolRisk = "low" | "medium" | "high" | "critical";

export type AgentToolAvailability =
  | "allow"
  | "require_approval"
  | "deny"
  | "chat_only"
  | "workshop_only"
  | "loop_only"
  | "disabled"
  | "unknown";

export type AgentToolConfirmationSurface =
  | "chat_confirm"
  | "workshop_task_tab"
  | "workshop_outbox_tab"
  | "workshop_review_tab"
  | "loop_approval"
  | "boundary_policy";

export type AgentToolConfirmation = {
  surface: AgentToolConfirmationSurface;
  label: string;
  description: string;
};

export type AgentToolDescriptor = {
  id: string;
  name: string;
  displayName: string;
  source: AgentToolSource;
  serverName?: string;
  description: string;
  capabilities: AgentToolCapability[];
  risk: AgentToolRisk;
  runtimeScopes: AgentToolRuntime[];
  deniedWorkRoles?: string[];
};

export type AgentToolMatrixItem = AgentToolDescriptor & {
  availability: AgentToolAvailability;
  decisionReason: string;
  confirmation?: AgentToolConfirmation;
  effectivePolicy?: Record<string, unknown>;
};

export type AgentToolMatrixCounts = {
  total: number;
  allow: number;
  requireApproval: number;
  deny: number;
  disabled: number;
  unknown: number;
  bySource: Record<AgentToolSource, number>;
  byRisk: Record<AgentToolRisk, number>;
};

export type AgentToolMatrix = {
  runtime: AgentToolRuntime;
  workshopId?: string;
  generatedAt: string;
  tools: AgentToolMatrixItem[];
  counts: AgentToolMatrixCounts;
};
