import { classifyLoopAction } from "./approval";
import { loopActionPolicySchema } from "./spec";

function normalizedLeaf(name: string) {
  const leaf = name.split("__").at(-1) ?? name;
  return leaf.trim() === "*" ? "*" : leaf.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** Recall risk follows granted actions, not the names of actions the owner denied. */
export function resolveLoopMemoryRecallRiskLevel(actionPolicy: unknown): "normal" | "high" {
  const policy = loopActionPolicySchema.parse(actionPolicy ?? {});
  const denied = new Set(policy.denied.map(normalizedLeaf));
  if (denied.has("*")) return "normal";
  const effectiveAllowed = policy.allowed.filter(name => !denied.has(normalizedLeaf(name)));
  return effectiveAllowed.some(name => {
    const capability = classifyLoopAction(name);
    // Paper order tools are internal writes but still require conservative
    // financial context. Unknown/external tools keep the gate's classification.
    return capability === "write_external" || capability === "dangerous" ||
      /^(?:quantpaperplaceorder|quantpapercancelorder|realbroker|payment|externalwrites)/.test(normalizedLeaf(name));
  }) ? "high" : "normal";
}
