import type { Workshop, WorkshopOutboxItem } from "@/lib/db/schema";
import { getWorkshopBoundaryPolicy } from "./boundary-policy";

export type WorkshopOutboxBoundaryResult = {
  allowed: boolean;
  requiresApproval: boolean;
  status: "passed" | "blocked";
  violations: string[];
  warnings: string[];
  checkedAt: string;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function parseAllowedRecipientsFromEnv() {
  const raw = process.env.WECHAT_DESKTOP_ALLOWED_RECIPIENTS ?? "";
  return raw
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasTradingOrderLanguage(message: string) {
  const directOrder =
    /(\b\u4e0b\u5355\b|\u6302\u5355|\u5e02\u4ef7\u5355|\u9650\u4ef7\u5355|\u771f\u5b9e\u4e0b\u5355|\u5238\u5546\u4e0b\u5355|\u5b9e\u76d8\u4e70\u5165|\u5b9e\u76d8\u5356\u51fa|\u7acb\u5373\u4e70\u5165|\u9a6c\u4e0a\u4e70\u5165|\u7acb\u5373\u5356\u51fa|\u9a6c\u4e0a\u5356\u51fa|\u73b0\u5728\u4e70\u5165|\u73b0\u5728\u5356\u51fa|\u6267\u884c\u4e70\u5165|\u6267\u884c\u5356\u51fa|\u5e2e\u6211\u4e70|\u5e2e\u6211\u5356|\u66ff\u6211\u4e70|\u66ff\u6211\u5356)/i.test(
      message,
    );
  const allInOrder =
    /(\u8bf7|\u5e2e\u6211|\u66ff\u6211|\u7ed9\u6211|\u6267\u884c|\u7acb\u5373|\u9a6c\u4e0a|\u73b0\u5728).{0,12}(\u5168\u4ed3|\u6e05\u4ed3|\u4e70\u5165|\u5356\u51fa|\u505a\u591a|\u505a\u7a7a)/i.test(
      message,
    ) ||
    /(\u5168\u4ed3\u4e70\u5165|\u5168\u4ed3\u5356\u51fa|\u6e05\u4ed3).{0,12}(\u6267\u884c|\u4e0b\u5355)/i.test(
      message,
    );
  return directOrder || allInOrder;
}

function hasFinancialSignalLanguage(message: string) {
  return /(\u80a1\u7968|\u80a1\u4ef7|\u8d22\u62a5|\u4e70\u5165|\u5356\u51fa|\u52a0\u4ed3|\u51cf\u4ed3|\u76ee\u6807\u4ef7|\u6b62\u635f|\u6b62\u76c8|\u505a\u591a|\u505a\u7a7a|NVDA|TSLA|AAPL|MSFT|TSM|AMD)/i.test(
    message,
  );
}

export function evaluateWorkshopOutboxBoundary(input: {
  workshop: Workshop;
  outbox: WorkshopOutboxItem;
  action?: "preview" | "send";
}): WorkshopOutboxBoundaryResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const policy = getWorkshopBoundaryPolicy(input.workshop);
  const recipient = input.outbox.recipientName?.trim();
  const message = input.outbox.message.trim();
  const allowedRecipients = Array.from(
    new Set([...policy.allowedRecipients, ...parseAllowedRecipientsFromEnv()]),
  );

  if (policy.externalMessages === "blocked") {
    violations.push("External messages are blocked for this Workshop.");
  }
  if (input.action === "preview" && !policy.allowWechatPreview) {
    violations.push("WeChat preview is disabled for this Workshop.");
  }
  if (input.outbox.channel !== "wechat_desktop") {
    violations.push("Only the WeChat desktop outbox is supported.");
  }
  if (!recipient) violations.push("A WeChat recipient is required.");
  if (!message) violations.push("The message is empty.");
  if (message.length > policy.maxMessageLength) {
    violations.push(`Message exceeds ${policy.maxMessageLength} characters.`);
  }
  if (
    recipient &&
    allowedRecipients.length > 0 &&
    !allowedRecipients.includes(recipient)
  ) {
    violations.push(
      "Recipient is not in the Workshop or environment allowlist.",
    );
  }
  if (input.outbox.confidence < policy.minConfidenceToDraft) {
    violations.push(
      "Confidence is below the minimum required for an outbox draft.",
    );
  }
  if (
    policy.requireSourcesForOutbox &&
    (!input.outbox.sourceEventIds || input.outbox.sourceEventIds.length === 0)
  ) {
    violations.push("The outbox draft has no source event references.");
  }
  if (hasTradingOrderLanguage(message)) {
    violations.push(
      "Trading order instructions cannot be sent through WeChat.",
    );
  }

  if (hasFinancialSignalLanguage(message)) {
    warnings.push(
      "Financial messages should include sources, confidence, and downside risk.",
    );
  }
  if (input.outbox.confidence < policy.minConfidenceToSend) {
    warnings.push("Confidence is below the automatic-send threshold.");
  }

  const requiresApproval =
    input.outbox.boundaryResult?.requiresOwnerReapproval === true ||
    input.action !== "send" ||
    policy.externalMessages !== "auto" ||
    input.workshop.autonomyLevel !== "auto" ||
    input.outbox.riskLevel === "high" ||
    input.outbox.confidence < policy.minConfidenceToSend;

  return {
    allowed: violations.length === 0,
    requiresApproval,
    status: violations.length === 0 ? "passed" : "blocked",
    violations,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

export function workshopAllowsSuggestedActionOutbox(input: {
  boundaryPolicy: unknown;
  modelConfig: unknown;
  actionPolicy: unknown;
}) {
  const boundaryPolicy = asRecord(input.boundaryPolicy);
  const modelConfig = asRecord(input.modelConfig);
  const actionPolicy = asRecord(input.actionPolicy);
  const denied = [
    ...stringArray(boundaryPolicy.hardDeniedActions),
    ...stringArray(modelConfig.disallowedTools),
    ...stringArray(actionPolicy.denied),
  ].map((item) => item.toLowerCase());

  if (boundaryPolicy.externalMessages === "blocked") return false;
  return !denied.includes("workshopcreateoutboxdraft");
}
