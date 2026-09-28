import type { Workshop } from "@/lib/db/schema";
import { classifyLoopAction } from "@/lib/loops/approval";
import {
  loopActionPolicySchema,
  loopApprovalPolicySchema,
} from "@/lib/loops/spec";
import type { LoopJson } from "@/lib/loops/types";

export type WorkshopBoundaryMode = "observe" | "draft" | "auto";
export type WorkshopExternalMessagePolicy = "blocked" | "draft" | "auto";

export type WorkshopBoundaryPolicy = {
  mode: WorkshopBoundaryMode;
  externalMessages: WorkshopExternalMessagePolicy;
  allowWechatPreview: boolean;
  requireSourcesForOutbox: boolean;
  allowedRecipients: string[];
  maxMessageLength: number;
  minConfidenceToDraft: number;
  minConfidenceToSend: number;
  customInstructions: string;
  /** Legacy hard denials remain effective when an owner edits other boundary fields. */
  hardDeniedActions?: string[];
  deniedPrecedence?: boolean;
};

export type WorkshopLoopBoundaryBridge = {
  actionPolicy: LoopJson;
  approvalPolicy: LoopJson;
  metadata: {
    source: "workshop_boundary";
    mode: WorkshopBoundaryMode;
    externalMessages: WorkshopExternalMessagePolicy;
    externalWrites: "allow" | "require_approval" | "deny";
    movedAllowedExternalActions: string[];
    hardDeniedActions: string[];
  };
};

const DEFAULT_MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_MIN_CONFIDENCE_TO_DRAFT = 60;
const DEFAULT_MIN_CONFIDENCE_TO_SEND = 75;
const WORKSHOP_HARD_DENIED_ACTIONS = [
  "bash",
  "shell",
  "exec",
  "delete",
  "remove",
  "drop",
  "truncate",
  "rm",
  "placeOrder",
  "executeOrder",
  "submitOrder",
  "buy",
  "sell",
  "trade",
  "makePayment",
  "payInvoice",
  "transferMoney",
  "wireTransfer",
];
const WORKSHOP_HARD_DENIED_PREFIX_ACTIONS = [
  "bash",
  "shell",
  "exec",
  "delete",
  "remove",
  "drop",
  "truncate",
  "rm",
  "placeOrder",
  "executeOrder",
  "submitOrder",
  "makePayment",
  "payInvoice",
  "transferMoney",
  "wireTransfer",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundaryMode(value: unknown): value is WorkshopBoundaryMode {
  return value === "observe" || value === "draft" || value === "auto";
}

function isExternalMessagePolicy(
  value: unknown,
): value is WorkshopExternalMessagePolicy {
  return value === "blocked" || value === "draft" || value === "auto";
}

function numberInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const next =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, Math.round(next)));
}

export function parseRecipientList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n;]/)
      : [];

  return Array.from(
    new Set(
      items
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function defaultExternalMessages(
  mode: WorkshopBoundaryMode,
): WorkshopExternalMessagePolicy {
  if (mode === "observe") return "blocked";
  if (mode === "auto") return "auto";
  return "draft";
}

function externalMessagesFromLegacy(
  value: unknown,
): WorkshopExternalMessagePolicy | null {
  if (value === "blocked" || value === "none") return "blocked";
  if (value === "auto" || value === "direct") return "auto";
  if (value === "outbox_first" || value === "draft") return "draft";
  return null;
}

export function getWorkshopBoundaryPolicy(
  workshop: Pick<Workshop, "autonomyLevel" | "boundaryPolicy">,
): WorkshopBoundaryPolicy {
  const raw = isRecord(workshop.boundaryPolicy) ? workshop.boundaryPolicy : {};
  const mode = isBoundaryMode(raw.mode)
    ? raw.mode
    : isBoundaryMode(workshop.autonomyLevel)
      ? workshop.autonomyLevel
      : "draft";
  const externalMessages = isExternalMessagePolicy(raw.externalMessages)
    ? raw.externalMessages
    : externalMessagesFromLegacy(raw.externalWrites) ??
      defaultExternalMessages(mode);

  return {
    mode,
    externalMessages,
    allowWechatPreview:
      typeof raw.allowWechatPreview === "boolean"
        ? raw.allowWechatPreview
        : externalMessages !== "blocked",
    requireSourcesForOutbox:
      typeof raw.requireSourcesForOutbox === "boolean"
        ? raw.requireSourcesForOutbox
        : typeof raw.requireSourcesForWechat === "boolean"
          ? raw.requireSourcesForWechat
          : true,
    allowedRecipients: parseRecipientList(raw.allowedRecipients),
    maxMessageLength: numberInRange(
      raw.maxMessageLength,
      DEFAULT_MAX_MESSAGE_LENGTH,
      1,
      10000,
    ),
    minConfidenceToDraft: numberInRange(
      raw.minConfidenceToDraft,
      DEFAULT_MIN_CONFIDENCE_TO_DRAFT,
      0,
      100,
    ),
    minConfidenceToSend: numberInRange(
      raw.minConfidenceToSend,
      DEFAULT_MIN_CONFIDENCE_TO_SEND,
      0,
      100,
    ),
    customInstructions:
      typeof raw.customInstructions === "string"
        ? raw.customInstructions.trim()
        : "",
    ...(Array.isArray(raw.hardDeniedActions)
      ? { hardDeniedActions: uniqueActions(raw.hardDeniedActions.filter(
          (action): action is string => typeof action === "string",
        )) }
      : {}),
    ...(typeof raw.deniedPrecedence === "boolean"
      ? { deniedPrecedence: raw.deniedPrecedence }
      : {}),
  };
}

export function serializeWorkshopBoundaryPolicy(
  policy: Partial<WorkshopBoundaryPolicy>,
): WorkshopBoundaryPolicy {
  const mode = isBoundaryMode(policy.mode) ? policy.mode : "draft";
  const externalMessages = isExternalMessagePolicy(policy.externalMessages)
    ? policy.externalMessages
    : defaultExternalMessages(mode);

  return {
    mode,
    externalMessages,
    allowWechatPreview: policy.allowWechatPreview ?? externalMessages !== "blocked",
    requireSourcesForOutbox: policy.requireSourcesForOutbox ?? true,
    allowedRecipients: parseRecipientList(policy.allowedRecipients),
    maxMessageLength: numberInRange(
      policy.maxMessageLength,
      DEFAULT_MAX_MESSAGE_LENGTH,
      1,
      10000,
    ),
    minConfidenceToDraft: numberInRange(
      policy.minConfidenceToDraft,
      DEFAULT_MIN_CONFIDENCE_TO_DRAFT,
      0,
      100,
    ),
    minConfidenceToSend: numberInRange(
      policy.minConfidenceToSend,
      DEFAULT_MIN_CONFIDENCE_TO_SEND,
      0,
      100,
    ),
    customInstructions: policy.customInstructions?.trim() ?? "",
    ...(Array.isArray(policy.hardDeniedActions)
      ? { hardDeniedActions: uniqueActions(policy.hardDeniedActions.filter(
          (action): action is string => typeof action === "string",
        )) }
      : {}),
    ...(typeof policy.deniedPrecedence === "boolean"
      ? { deniedPrecedence: policy.deniedPrecedence }
      : {}),
  };
}

export function formatWorkshopBoundaryPolicy(policy: WorkshopBoundaryPolicy) {
  const recipients =
    policy.allowedRecipients.length > 0
      ? policy.allowedRecipients.join(", ")
      : "no workshop-specific recipient allowlist";

  return [
    `- Mode: ${policy.mode}`,
    `- External messages: ${policy.externalMessages}`,
    `- WeChat preview allowed: ${policy.allowWechatPreview ? "yes" : "no"}`,
    `- Require sources before outbox preview/send: ${
      policy.requireSourcesForOutbox ? "yes" : "no"
    }`,
    `- Allowed recipients: ${recipients}`,
    `- Max message length: ${policy.maxMessageLength}`,
    `- Minimum confidence for outbox draft: ${policy.minConfidenceToDraft}%`,
    `- Minimum confidence for send: ${policy.minConfidenceToSend}%`,
    "- Financial trading/order instructions are always blocked from sending.",
    policy.customInstructions
      ? `- Custom boundary instructions: ${policy.customInstructions}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeActionName(actionName: string): string {
  const leafName = actionName.includes("__")
    ? (actionName.split("__").pop() ?? actionName)
    : actionName;
  return leafName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function uniqueActions(actions: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const action of actions) {
    const trimmed = action.trim();
    if (!trimmed) continue;
    const key = normalizeActionName(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function actionListed(actionName: string, actions: string[]) {
  const normalized = normalizeActionName(actionName);
  return actions.some((action) => normalizeActionName(action) === normalized);
}

function isWorkshopHardDeniedAction(actionName: string) {
  const normalized = normalizeActionName(actionName);
  if (
    WORKSHOP_HARD_DENIED_PREFIX_ACTIONS.some((action) =>
      normalized.startsWith(normalizeActionName(action)),
    )
  ) {
    return true;
  }
  return WORKSHOP_HARD_DENIED_ACTIONS.some(
    (action) => normalized === normalizeActionName(action),
  );
}

function workshopExternalWriteMode(policy: WorkshopBoundaryPolicy) {
  if (policy.mode === "observe" || policy.externalMessages === "blocked") {
    return "deny" as const;
  }
  if (policy.mode === "auto" && policy.externalMessages === "auto") {
    return "allow" as const;
  }

  return "require_approval" as const;
}

export function workshopBoundaryToLoopPolicies(input: {
  workshop: Pick<Workshop, "autonomyLevel" | "boundaryPolicy">;
  actionPolicy: LoopJson;
  approvalPolicy: LoopJson;
}): WorkshopLoopBoundaryBridge {
  const policy = getWorkshopBoundaryPolicy(input.workshop);
  const actionPolicy = loopActionPolicySchema.parse(input.actionPolicy ?? {});
  const approvalPolicy = loopApprovalPolicySchema.parse(
    input.approvalPolicy ?? {},
  );
  const externalWrites = workshopExternalWriteMode(policy);
  const hardDenied = uniqueActions([
    ...WORKSHOP_HARD_DENIED_ACTIONS,
    ...actionPolicy.denied,
    ...actionPolicy.allowed.filter(isWorkshopHardDeniedAction),
    ...actionPolicy.requiresApproval.filter(isWorkshopHardDeniedAction),
  ]);
  const movedAllowedExternalActions: string[] = [];
  const allowed: string[] = [];
  const requiresApproval = [...actionPolicy.requiresApproval].filter(
    (action) => !isWorkshopHardDeniedAction(action),
  );

  for (const action of actionPolicy.allowed) {
    if (isWorkshopHardDeniedAction(action)) continue;

    if (classifyLoopAction(action) === "write_external") {
      movedAllowedExternalActions.push(action);
      if (externalWrites === "allow") {
        allowed.push(action);
      } else if (externalWrites === "require_approval") {
        requiresApproval.push(action);
      } else {
        hardDenied.push(action);
      }
      continue;
    }

    allowed.push(action);
  }

  if (externalWrites === "deny") {
    for (const action of actionPolicy.requiresApproval) {
      if (classifyLoopAction(action) === "write_external") {
        hardDenied.push(action);
      }
    }
  }

  const denied = uniqueActions(hardDenied);

  return {
    actionPolicy: {
      allowed: uniqueActions(allowed).filter(
        (action) => !actionListed(action, denied),
      ),
      requiresApproval: uniqueActions(requiresApproval).filter(
        (action) => !actionListed(action, denied),
      ),
      denied,
    },
    approvalPolicy: {
      ...approvalPolicy,
      externalWrites,
    },
    metadata: {
      source: "workshop_boundary",
      mode: policy.mode,
      externalMessages: policy.externalMessages,
      externalWrites,
      movedAllowedExternalActions: uniqueActions(movedAllowedExternalActions),
      hardDeniedActions: denied,
    },
  };
}
